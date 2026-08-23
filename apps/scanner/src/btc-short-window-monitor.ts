import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { formatContracts, formatUsd, parseFixed, parseUsd } from "../../../packages/domain/src/fixed.ts";
import { HttpClient } from "../../../packages/domain/src/http.ts";
import { asNumber, asString, isRecord, stringifyJson } from "../../../packages/domain/src/json.ts";
import {
  allComplementaryCrossVenueRoutes,
  eligibleCrossVenueRoutes,
  evaluateCrossVenueRoutes,
  referenceDifferenceMicroUsd,
  referencePricesWithin,
  type CrossVenueShortWindowRoute,
  type EvaluatedCrossVenueRoute,
  type ShortWindowOutcome,
} from "../../../packages/domain/src/short-window.ts";
import type { ShortWindowStrategyConfig } from "../../../packages/domain/src/short-window-strategy.ts";
import type { BinaryOrderBook, VenueMarket } from "../../../packages/domain/src/types.ts";
import { JupiterClient } from "../../../packages/venue-jupiter/src/client.ts";
import {
  streamJupiterPredictionPrices,
  type JupiterPredictionPriceStreamStatus,
} from "../../../packages/venue-jupiter/src/price-stream.ts";
import {
  JupiterForecastSwapExecutor,
  JupiterSwapClient,
} from "../../../packages/venue-jupiter/src/forecast-swap.ts";
import { JupiterHybridLiveExecutor } from "../../../packages/venue-jupiter/src/hybrid-trading.ts";
import { JupiterRequestScheduler } from "../../../packages/venue-jupiter/src/request-scheduler.ts";
import { JupiterLiveExecutor } from "../../../packages/venue-jupiter/src/trading.ts";
import {
  ExactChainlinkSpotStore,
  ExactTwapAnchorStore,
  streamChainlinkSpot,
  streamChainlinkTwap60,
  type ChainlinkSpotObservation,
  type ChainlinkTwapObservation,
} from "../../../packages/venue-polymarket/src/chainlink-twap-stream.ts";
import { PolymarketClient } from "../../../packages/venue-polymarket/src/client.ts";
import { PolymarketLiveExecutor } from "../../../packages/venue-polymarket/src/trading.ts";
import {
  streamPolymarketOrderBookSet,
  streamPolymarketOrderBooks,
  type PolymarketStreamBookUpdate,
  type PolymarketStreamStatus,
} from "../../../packages/venue-polymarket/src/market-stream.ts";
import { CliArgs } from "./args.ts";
import {
  DAILY_THRESHOLD_ROUTES,
  dailyLivePairIdentity,
  dailyPricingBook,
  discoverDailyThresholdPairs,
  validateDailyThresholdPair,
  type DailyThresholdPair,
} from "./btc-daily-threshold.ts";
import {
  buildJupiterForecastOrderBook,
  JupiterPredictionPriceBookState,
} from "./jupiter-quote-fallback.ts";
import {
  ShortWindowLiveTrader,
  type LiveDecision,
  type LivePairIdentity,
  type LiveRecoveryDiagnostics,
} from "./short-window-live-trader.ts";
import {
  ShortWindowPaperTrader,
  type PaperDecision,
  type PaperPairIdentity,
  type PaperPosition,
} from "./short-window-paper-trader.ts";
import {
  fetchJupiterForecastOpeningReference,
  fetchPolymarketOpeningReference,
} from "./short-window-reference-api.ts";
import {
  ShortWindowStatusStore,
  startShortWindowStatusServer,
  type BestAskStatus,
  type BookStatus,
  type ReferenceStatus,
  type RouteStatus,
} from "./short-window-status-server.ts";

type Duration = "5m" | "15m";

const DURATION_MS: Readonly<Record<Duration, number>> = {
  "5m": 5 * 60 * 1_000,
  "15m": 15 * 60 * 1_000,
};
const DEFAULT_MAX_REFERENCE_DIFFERENCE_USD = "30";
const DEFAULT_OUTPUT = "logs/btc-poly-jup-short-window-arb.jsonl";
const DEFAULT_LIVE_STATE = "logs/btc-poly-jup-short-window-live-state.json";
const LIVE_BALANCE_REFRESH_MS = 5_000;
const LIVE_BALANCE_LOG_HEARTBEAT_MS = 60_000;
const LIVE_CONTRACT_TOLERANCE_MICRO = 10_000n;
const DEFAULT_MARKET_LOG_INTERVAL_MS = 30_000;
const LIVE_CONFIRMATION = "I_ACCEPT_REAL_MONEY_RISK";
const LIVE_TEST_ENTRY_CONFIRMATION = "I_ACCEPT_ONE_UNPROFITABLE_TEST_TRADE";
const CORE_BASIS_WARNINGS = [
  "NOT_GUARANTEED_ORACLE_BASIS",
  "POLYMARKET_TWAP_60S_VS_JUPITER_CHAINLINK_SPOT",
  "NON_ATOMIC_CROSS_CHAIN_EXECUTION",
] as const;
const BASIS_WARNINGS = [
  ...CORE_BASIS_WARNINGS,
  "JUPITER_FEE_ESTIMATED_FROM_DOCUMENTED_FORMULA",
] as const;
const ANY_ROUTE_WARNING = "REFERENCE_DIRECTION_IGNORED_BOTH_LEGS_CAN_LOSE" as const;

type ReferenceSource =
  | "polymarket_crypto_price_api"
  | "polymarket_rtds_exact_twap_60s"
  | "jupiter_forecast_price_service"
  | "jupiter_chainlink_rtds_exact_spot";

interface ReferencePrice {
  priceMicroUsd: bigint;
  source: ReferenceSource;
  boundaryMs: number;
  observedAtMs: number;
  receivedAtMs: number;
}

interface CrossVenuePair {
  duration: Duration;
  startMs: number;
  endMs: number;
  polymarketSlug: string;
  polymarket: VenueMarket;
  jupiterEventId: string;
  jupiterUp: VenueMarket;
  jupiterDown: VenueMarket;
}

type PairEvent =
  | { type: "polymarket_book"; update: PolymarketStreamBookUpdate }
  | { type: "polymarket_status"; status: PolymarketStreamStatus }
  | {
      type: "jupiter_book";
      book: BinaryOrderBook;
      source: "orderbook" | "price_websocket";
      notice: string | null;
    }
  | { type: "jupiter_error"; message: string; consecutiveErrors: number; retryInMs: number }
  | { type: "end"; reason: string };

type JupiterBookSource = Extract<PairEvent, { type: "jupiter_book" }>["source"];

interface MonitorConfiguration {
  routeSelectionMode: "reference_directed" | "any_complementary";
  maximumReferenceDifferenceMicroUsd: bigint;
  referenceRetryMs: number;
  referenceApiTimeoutMs: number;
  sampleIntervalMs: number;
  marketLogIntervalMs: number;
  jupiterPollMs: number;
  maximumJupiterAgeMs: number;
  maximumReusableJupiterQuoteAgeMs: number;
  maximumConsecutiveJupiterErrors: number;
  jupiterFallbackGrossMicroUsd: bigint;
  dailyThresholdPollMs: number;
  dailyThresholdDiscoveryRefreshMs: number;
  minimumEntryEdgeMicroUsdPerContract: bigint;
  minimumEntryEdgeTotalMicroUsd: bigint;
}

async function main(): Promise<void> {
  const args = new CliArgs(process.argv.slice(2));
  if (args.has("help")) {
    printHelp();
    return;
  }

  const outputPath = resolve(process.cwd(), args.string("output", DEFAULT_OUTPUT));
  const maximumReferenceDifferenceMicroUsd = parseUsd(
    args.string("max-reference-difference-usd", DEFAULT_MAX_REFERENCE_DIFFERENCE_USD),
  );
  const referenceRetryMs = args.integer("reference-retry-ms", 2_000);
  const referenceApiTimeoutMs = args.integer("reference-api-timeout-ms", 2_000);
  const sampleIntervalMs = args.integer("sample-interval-ms", 100);
  const marketLogIntervalMs = args.integer("market-log-interval-ms", DEFAULT_MARKET_LOG_INTERVAL_MS);
  const jupiterPollMs = args.integer("jupiter-poll-ms", 1_000);
  const maximumJupiterAgeMs = args.integer("max-jupiter-age-ms", 5_000);
  const maximumConsecutiveJupiterErrors = args.integer("max-consecutive-jupiter-errors", 5);
  const dailyThresholdEnabled = !args.has("no-daily-threshold");
  const anyComplementaryRoute = args.has("any-complementary-route");
  const dailyThresholdPollMs = args.integer("daily-threshold-poll-ms", 10_000);
  const dailyThresholdDiscoveryRefreshMs = args.integer("daily-threshold-discovery-refresh-ms", 300_000);
  const maxSamples = args.has("once") ? 1 : args.integer("max-samples", 0);
  const maxOpportunities = args.integer("max-opportunities", 0);
  const paperTrade = args.has("paper-trade");
  const liveTrade = args.has("live-trade");
  const liveTestEntry = args.has("live-test-entry");
  const checkPolymarketReadiness = args.has("check-polymarket-readiness");
  const checkLiveReadiness = args.has("check-live-readiness");
  const liveStatePath = resolve(process.cwd(), args.string("live-state", DEFAULT_LIVE_STATE));
  const maximumSlippageBps = args.integer("maximum-slippage-bps", 100);
  const maximumJupiterSubmissionQuoteAgeMs = args.integer("maximum-jupiter-submit-quote-age-ms", 1_000);
  const maximumEmergencyHedgeLossMicroUsd = parseUsd(args.string("maximum-emergency-hedge-loss-usd", "1"));
  const jupiterFillTimeoutMs = args.integer("jupiter-fill-timeout-ms", 20_000);
  const minimumVenueBalanceMicroUsd = parseUsd(args.string("minimum-venue-balance-usd", "50"));
  const maximumVenueAllocationMicroUsd = parseUsd(args.string("max-venue-allocation-usd", "50"));
  const jupiterMinimumOrderMicroUsd = parseUsd(args.string("jupiter-minimum-order-usd", "0.01"));
  const polymarketMinimumOrderMicroUsd = parseUsd(args.string("polymarket-minimum-order-usd", "1"));
  const jupiterQuoteGrossMicroUsd = parseUsd(args.string("jupiter-quote-usd", "5"));
  const minimumEntryEdgePerContractMicroUsd = parseUsd(args.string("minimum-entry-edge-usd", "0.01"));
  const minimumEntryEdgeTotalMicroUsd = parseUsd(args.string("minimum-entry-profit-usd", "0.10"));
  const minimumExitProfitMicroUsd = parseUsd(args.string("minimum-exit-profit-usd", "0.10"));
  const maximumOpenPositions = args.integer("maximum-open-positions", 2);
  const webPort = args.integer("web-port", 3_210);
  const webEnabled = !args.has("no-web");
  const minimumJupiterPollMs = 1_000;
  const exactJupiterBuildMinimumIntervalMs = 1_000;

  if (paperTrade) throw new Error("--paper-trade was removed; use the read-only monitor or real --live-trade mode");
  if (liveTestEntry && !liveTrade) throw new Error("--live-test-entry requires --live-trade");
  if (liveTrade && args.string("confirm-live-trading", process.env.LIVE_TRADING_CONFIRMATION ?? "") !== LIVE_CONFIRMATION) {
    throw new Error(`Live trading refused. Set LIVE_TRADING_CONFIRMATION=${LIVE_CONFIRMATION} or pass the exact --confirm-live-trading phrase.`);
  }
  if (liveTestEntry &&
    args.string("confirm-live-test-entry", process.env.LIVE_TEST_ENTRY_CONFIRMATION ?? "") !== LIVE_TEST_ENTRY_CONFIRMATION) {
    throw new Error(
      `One-shot unprofitable test refused. Set LIVE_TEST_ENTRY_CONFIRMATION=${LIVE_TEST_ENTRY_CONFIRMATION} ` +
      `or pass the exact --confirm-live-test-entry phrase.`,
    );
  }
  if (liveTestEntry && (checkPolymarketReadiness || checkLiveReadiness || args.has("setup-trading-approvals"))) {
    throw new Error("--live-test-entry cannot be combined with setup or readiness-only modes");
  }
  if (maximumReferenceDifferenceMicroUsd <= 0n) throw new Error("--max-reference-difference-usd must be greater than zero");
  if (referenceRetryMs < 250) throw new Error("--reference-retry-ms must be at least 250");
  if (referenceApiTimeoutMs < 250) throw new Error("--reference-api-timeout-ms must be at least 250");
  if (sampleIntervalMs < 25 || sampleIntervalMs > 2_500) {
    throw new Error("--sample-interval-ms must be between 25 and 2500");
  }
  if (marketLogIntervalMs < 1_000 || marketLogIntervalMs > 60_000) {
    throw new Error("--market-log-interval-ms must be between 1000 and 60000");
  }
  if (jupiterPollMs < minimumJupiterPollMs) {
    throw new Error(`--jupiter-poll-ms must be at least ${minimumJupiterPollMs}`);
  }
  if (maximumJupiterAgeMs < jupiterPollMs) throw new Error("--max-jupiter-age-ms must be at least --jupiter-poll-ms");
  if (maximumConsecutiveJupiterErrors < 1) throw new Error("--max-consecutive-jupiter-errors must be at least 1");
  if (dailyThresholdPollMs < 2_500) throw new Error("--daily-threshold-poll-ms must be at least 2500");
  if (dailyThresholdDiscoveryRefreshMs < 30_000) {
    throw new Error("--daily-threshold-discovery-refresh-ms must be at least 30000");
  }
  if (webPort > 65_535) throw new Error("--web-port must be no greater than 65535");
  if (liveTrade && !webEnabled) {
    throw new Error(
      "--live-trade requires the status server; it is also the single-instance lock, so --no-web is unsafe",
    );
  }
  if (minimumVenueBalanceMicroUsd <= 0n) throw new Error("--minimum-venue-balance-usd must be greater than zero");
  if (maximumVenueAllocationMicroUsd <= 0n || maximumVenueAllocationMicroUsd > minimumVenueBalanceMicroUsd) {
    throw new Error("--max-venue-allocation-usd must be greater than zero and no larger than the required live balance");
  }
  if (jupiterMinimumOrderMicroUsd <= 0n) throw new Error("--jupiter-minimum-order-usd must be greater than zero");
  if (polymarketMinimumOrderMicroUsd < 1_000_000n) {
    throw new Error("--polymarket-minimum-order-usd must be at least 1");
  }
  if (jupiterQuoteGrossMicroUsd <= 0n) throw new Error("--jupiter-quote-usd must be greater than zero");
  if (minimumEntryEdgePerContractMicroUsd <= 0n || minimumEntryEdgeTotalMicroUsd <= 0n || minimumExitProfitMicroUsd <= 0n) {
    throw new Error("Live strategy edge and profit thresholds must be greater than zero");
  }
  if (maximumOpenPositions < 1) throw new Error("--maximum-open-positions must be at least 1");
  if (maximumSlippageBps < 1 || maximumSlippageBps > 500) {
    throw new Error("--maximum-slippage-bps must be between 1 and 500");
  }
  if (maximumJupiterSubmissionQuoteAgeMs < 100 || maximumJupiterSubmissionQuoteAgeMs > 5_000) {
    throw new Error("--maximum-jupiter-submit-quote-age-ms must be between 100 and 5000");
  }
  if (maximumEmergencyHedgeLossMicroUsd < 0n ||
    maximumEmergencyHedgeLossMicroUsd > maximumVenueAllocationMicroUsd) {
    throw new Error(
      "--maximum-emergency-hedge-loss-usd must be non-negative and no larger than --max-venue-allocation-usd",
    );
  }
  if (jupiterFillTimeoutMs < 5_000 || jupiterFillTimeoutMs > 60_000) {
    throw new Error("--jupiter-fill-timeout-ms must be between 5000 and 60000");
  }
  const maximumReusableJupiterQuoteAgeMs = Math.min(
    maximumJupiterAgeMs,
    Math.min(5_000, jupiterPollMs + 500),
  );

  await mkdir(dirname(outputPath), { recursive: true });
  const writer = new JsonlWriter(outputPath);
  const sessionId = randomUUID();
  const startedAtMs = Date.now();
  const statusStore = new ShortWindowStatusStore({
    sessionId,
    startedAtMs,
    outputPath,
    limitUsd: formatUsd(maximumReferenceDifferenceMicroUsd),
    paperStrategyEnabled: paperTrade,
    liveStrategyEnabled: liveTrade,
  });
  let statusServer: { url: string; close: () => Promise<void> } | null = null;
  const controller = new AbortController();
  const twapAnchors = new ExactTwapAnchorStore();
  const spotAnchors = new ExactChainlinkSpotStore();
  const polymarketClient = new PolymarketClient();
  const jupiterClient = new JupiterClient();
  const forecastCache = new ForecastMarketCache(jupiterClient);
  const dailyThresholdCache = new DailyThresholdMarketCache(jupiterClient, dailyThresholdPollMs);
  const referenceHttp = new HttpClient({
    timeoutMs: referenceApiTimeoutMs,
    retries: 0,
    defaultHeaders: {
      "user-agent": "Mozilla/5.0",
      accept: "application/json",
      referer: "https://polymarket.com/",
    },
  });
  const configuration: MonitorConfiguration = {
    routeSelectionMode: anyComplementaryRoute ? "any_complementary" : "reference_directed",
    maximumReferenceDifferenceMicroUsd,
    referenceRetryMs,
    referenceApiTimeoutMs,
    sampleIntervalMs,
    marketLogIntervalMs,
    jupiterPollMs,
    maximumJupiterAgeMs,
    maximumReusableJupiterQuoteAgeMs,
    maximumConsecutiveJupiterErrors,
    jupiterFallbackGrossMicroUsd: jupiterQuoteGrossMicroUsd,
    dailyThresholdPollMs,
    dailyThresholdDiscoveryRefreshMs,
    minimumEntryEdgeMicroUsdPerContract: minimumEntryEdgePerContractMicroUsd,
    minimumEntryEdgeTotalMicroUsd,
  };
  const strategyConfiguration: ShortWindowStrategyConfig = {
    polymarketMaximumAllocationMicroUsd: maximumVenueAllocationMicroUsd,
    jupiterMaximumAllocationMicroUsd: maximumVenueAllocationMicroUsd,
    jupiterMinimumGrossOrderMicroUsd: jupiterMinimumOrderMicroUsd,
    polymarketMinimumGrossOrderMicroUsd: polymarketMinimumOrderMicroUsd,
    polymarketMinimumContractsMicro: 5_000_000n,
    minimumEntryEdgeMicroUsdPerContract: minimumEntryEdgePerContractMicroUsd,
    minimumEntryEdgeTotalMicroUsd,
    minimumExitProfitMicroUsd,
  };
  const paperTrader = paperTrade ? new ShortWindowPaperTrader({
    polymarketStartingCashMicroUsd: minimumVenueBalanceMicroUsd,
    jupiterStartingCashMicroUsd: minimumVenueBalanceMicroUsd,
    strategy: strategyConfiguration,
    maximumOpenPositions,
  }) : null;
  let liveTrader: ShortWindowLiveTrader | null = null;
  let polymarketLiveExecutor: PolymarketLiveExecutor | null = null;
  let jupiterLiveExecutor: JupiterForecastSwapExecutor | null = null;
  let jupiterPredictionLiveExecutor: JupiterLiveExecutor | null = null;
  if (liveTrade) {
    const relayerRequired = !checkPolymarketReadiness;
    polymarketLiveExecutor = await PolymarketLiveExecutor.create({
      privateKey: requiredEnvironment("POLYMARKET_PRIVATE_KEY"),
      walletAddress: requiredEnvironment("POLYMARKET_WALLET_ADDRESS"),
      relayerApiKey: relayerRequired
        ? requiredEnvironment("POLYMARKET_RELAYER_API_KEY")
        : optionalEnvironment("POLYMARKET_RELAYER_API_KEY"),
      relayerApiKeyAddress: relayerRequired
        ? requiredEnvironment("POLYMARKET_RELAYER_API_KEY_ADDRESS")
        : optionalEnvironment("POLYMARKET_RELAYER_API_KEY_ADDRESS"),
    });
    if (checkPolymarketReadiness) {
      const readiness = await polymarketLiveExecutor.assertReady(minimumVenueBalanceMicroUsd);
      const allowance = readiness.minimumAllowanceMicroUsd >= 2n ** 128n
        ? "unlimited"
        : `$${formatUsd(readiness.minimumAllowanceMicroUsd)}`;
      console.log(
        `Polymarket read-only readiness passed: collateral $${formatUsd(readiness.collateralBalanceMicroUsd)}, ` +
        `minimum allowance ${allowance}. No transaction or order was submitted.`,
      );
      return;
    }
    if (args.has("setup-trading-approvals")) {
      await polymarketLiveExecutor.setupTradingApprovals();
      console.log("Polymarket trading approvals confirmed. Setup-only mode is complete; no market orders were submitted.");
      return;
    }
    const jupiterApiKey = requiredEnvironment("JUPITER_API_KEY");
    const solanaRpcUrl = requiredEnvironment("SOLANA_RPC_URL");
    const jupiterPrivateKey = requiredEnvironment("JUPITER_SOLANA_PRIVATE_KEY");
    const jupiterRequestScheduler = new JupiterRequestScheduler(exactJupiterBuildMinimumIntervalMs);
    const jupiterExecutionClient = new JupiterClient({
      apiKey: jupiterApiKey,
      minRequestIntervalMs: 0,
      requestScheduler: jupiterRequestScheduler,
    });
    jupiterLiveExecutor = new JupiterForecastSwapExecutor({
      predictionClient: jupiterExecutionClient,
      swapClient: new JupiterSwapClient({
        apiKey: jupiterApiKey,
        minimumRequestIntervalMs: 0,
        requestScheduler: jupiterRequestScheduler,
      }),
      rpcUrl: solanaRpcUrl,
      privateKey: jupiterPrivateKey,
      slippageBps: maximumSlippageBps,
    });
    jupiterPredictionLiveExecutor = new JupiterLiveExecutor({
      client: jupiterExecutionClient,
      rpcUrl: solanaRpcUrl,
      privateKey: jupiterPrivateKey,
    });
    const [polymarketReadiness, jupiterReadiness] = await Promise.all([
      polymarketLiveExecutor.assertReady(minimumVenueBalanceMicroUsd),
      jupiterLiveExecutor.assertReady(minimumVenueBalanceMicroUsd),
    ]);
    if (checkLiveReadiness) {
      console.log(
        `Live read-only readiness passed: Polymarket collateral ` +
        `$${formatUsd(polymarketReadiness.collateralBalanceMicroUsd)}, Jupiter USDC ` +
        `$${formatUsd(jupiterReadiness.usdcMicro)}, Jupiter SOL ${jupiterReadiness.solLamports} lamports. ` +
        `No transaction or order was submitted.`,
      );
      return;
    }
    statusStore.updateWalletBalances({
      polymarketCollateralUsd: formatUsd(polymarketReadiness.collateralBalanceMicroUsd),
      jupiterUsdcUsd: formatUsd(jupiterReadiness.usdcMicro),
      jupiterSol: formatSolLamports(jupiterReadiness.solLamports),
      observedAt: iso(Date.now()),
      error: null,
    });
    liveTrader = new ShortWindowLiveTrader({
      jupiter: new JupiterHybridLiveExecutor({
        forecast: jupiterLiveExecutor,
        prediction: jupiterPredictionLiveExecutor,
      }),
      polymarket: polymarketLiveExecutor,
      config: {
        strategy: strategyConfiguration,
        initialPolymarketCashMicroUsd: polymarketReadiness.collateralBalanceMicroUsd,
        initialJupiterCashMicroUsd: jupiterReadiness.usdcMicro,
        maximumOpenPositions,
        maximumSlippageBps,
        maximumReusableJupiterQuoteAgeMs,
        maximumJupiterSubmissionQuoteAgeMs,
        maximumEmergencyHedgeLossMicroUsd,
        jupiterFillTimeoutMs,
        forceOneEntry: liveTestEntry,
        statePath: liveStatePath,
      },
    });
    await liveTrader.initialize();
  }
  let samplesWritten = 0;
  let opportunitiesWritten = 0;
  let pairsExamined = 0;
  let stopReason = "completed";

  const requestStop = (reason: string): void => {
    if (controller.signal.aborted) return;
    stopReason = reason;
    controller.abort();
  };
  const recordSample = (): number => {
    samplesWritten += 1;
    if (maxSamples > 0 && samplesWritten >= maxSamples) requestStop("MAX_SAMPLES");
    return samplesWritten;
  };
  const recordOpportunity = (): number => {
    opportunitiesWritten += 1;
    if (maxOpportunities > 0 && opportunitiesWritten >= maxOpportunities) requestStop("MAX_OPPORTUNITIES");
    return opportunitiesWritten;
  };
  const onSigint = (): void => requestStop("SIGINT");
  const onSigterm = (): void => requestStop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  await writer.append({
    schemaVersion: 2,
    type: "session_start",
    sessionId,
    startedAt: iso(startedAtMs),
    configuration: {
      asset: "BTC",
      durations: ["5m", "15m"],
      marketTypes: dailyThresholdEnabled
        ? ["same_duration_up_down", "daily_btc_above_strike"]
        : ["same_duration_up_down"],
      pairing: "POLYMARKET_VS_JUPITER_PREDICTION",
      routeSelectionMode: configuration.routeSelectionMode,
      jupiterProviders: dailyThresholdEnabled ? ["bisonfi", "polymarket"] : ["bisonfi"],
      maximumReferenceDifferenceMicroUsd,
      maximumReferenceDifferenceUsd: formatUsd(maximumReferenceDifferenceMicroUsd),
      referenceRetryMs,
      referenceApiTimeoutMs,
      sampleIntervalMs,
      marketLogIntervalMs,
      jupiterPollMs,
      maximumJupiterAgeMs,
      maximumReusableJupiterQuoteAgeMs,
      maximumConsecutiveJupiterErrors,
      dailyThresholdEnabled,
      dailyThresholdPollMs,
      dailyThresholdDiscoveryRefreshMs,
      maxSamples: maxSamples || null,
      maxOpportunities: maxOpportunities || null,
      outputPath,
      executionStrategy: paperTrade || liveTrade ? {
        mode: liveTrade ? "live" : "paper",
        minimumRequiredBalancePerVenueUsd: formatUsd(minimumVenueBalanceMicroUsd),
        maximumAllocationPerVenueUsd: formatUsd(maximumVenueAllocationMicroUsd),
        jupiterMinimumOrderUsd: formatUsd(jupiterMinimumOrderMicroUsd),
        polymarketMinimumOrderUsd: formatUsd(polymarketMinimumOrderMicroUsd),
        jupiterScreeningQuoteUsd: formatUsd(jupiterQuoteGrossMicroUsd),
        jupiterExecutionPath: liveTrade
          ? "hybrid_prediction_api_at_or_above_5_usd_else_swap_v2"
          : null,
        maximumJupiterSubmissionQuoteAgeMs: liveTrade ? maximumJupiterSubmissionQuoteAgeMs : null,
        exactJupiterBuildMinimumIntervalMs: liveTrade ? exactJupiterBuildMinimumIntervalMs : null,
        maximumEmergencyHedgeLossUsd: liveTrade ? formatUsd(maximumEmergencyHedgeLossMicroUsd) : null,
        minimumEntryEdgeUsdPerContract: formatUsd(minimumEntryEdgePerContractMicroUsd),
        minimumEntryProfitUsd: formatUsd(minimumEntryEdgeTotalMicroUsd),
        minimumExitProfitUsd: formatUsd(minimumExitProfitMicroUsd),
        maximumOpenPositions,
        maximumSlippageBps: liveTrade ? maximumSlippageBps : null,
        jupiterFillTimeoutMs: liveTrade ? jupiterFillTimeoutMs : null,
        forceOneEntry: liveTrade ? liveTestEntry : null,
        liveStatePath: liveTrade ? liveStatePath : null,
      } : null,
    },
    feeModel: {
      polymarket: "0.07 * price * (1-price), per-contract fee rounded to 0.00001 USDC",
      jupiter: liveTrade
        ? "Public Degen websocket discovery uses the documented fee estimate; live preflight uses Prediction API at $5+ and direct Swap V2 below $5"
        : "0.07 * price * (1-price) * contracts, order fee rounded up to 0.01 USDC",
    },
    warnings: [
      ...BASIS_WARNINGS,
      "JUPITER_PUBLIC_DEGEN_PRICE_WEBSOCKET_REQUIRES_ATOMIC_ORDER_PREFLIGHT",
      ...(anyComplementaryRoute ? [ANY_ROUTE_WARNING] : []),
    ],
    readOnly: !liveTrade,
  });

  for (const recovery of liveTrader?.drainRecoveryDiagnostics() ?? []) {
    await appendLiveRecovery(writer, sessionId, recovery);
  }

  console.log("BTC Polymarket vs Jupiter Prediction arbitrage monitor");
  console.log("Pairing 5m↔5m and 15m↔15m with identical start and end times.");
  if (anyComplementaryRoute) {
    console.warn(
      "ANY-ROUTE VERSION: evaluating both Poly UP + Jup DOWN and Poly DOWN + Jup UP, then selecting the best qualified net edge.",
    );
    console.warn(
      "Reference direction is ignored for route selection; when opening references differ, both legs can lose inside the reference gap.",
    );
  }
  if (dailyThresholdEnabled) {
    console.log("Also discovering exact Bitcoin-above-strike daily POLY-* pairs and selecting the best executable route.");
  }
  console.log(`Reference difference must be strictly below $${formatUsd(maximumReferenceDifferenceMicroUsd)}.`);
  console.log("Candidates are not guaranteed: Polymarket settles on TWAP 60s; Jupiter Forecast settles on Chainlink spot.");
  console.log(
    `Jupiter entries use its public Degen price WebSocket; an authenticated exact order build is called only after a ` +
    `qualified candidate, using Prediction API at $5+ and Swap V2 below $5. Open-position REST exits refresh at ${jupiterPollMs}ms. Repetitive logs are capped at ` +
    `${marketLogIntervalMs}ms to ${outputPath}.`,
  );
  if (paperTrader) {
    statusStore.updateStrategy(paperTrader.snapshot());
    console.log(
      `PAPER STRATEGY enabled: $${formatUsd(minimumVenueBalanceMicroUsd)} per venue, ` +
      `$${formatUsd(maximumVenueAllocationMicroUsd)} max per venue/entry, Jupiter strategy floor $${formatUsd(jupiterMinimumOrderMicroUsd)}.`,
    );
    console.log("No real orders, signatures, or wallet transactions will be submitted.");
  }
  if (liveTrader && jupiterLiveExecutor) {
    updateLiveStrategyStatus(statusStore, liveTrader);
    console.warn("LIVE TRADING ENABLED: this process can submit irreversible real-money orders.");
    console.warn(`Jupiter owner ${jupiterLiveExecutor.ownerPubkey}; live state ${liveStatePath}`);
    console.warn(
      `Real wallet balances are the available-cash source; ` +
      `$${formatUsd(minimumVenueBalanceMicroUsd)} minimum required per venue, ` +
      `$${formatUsd(maximumVenueAllocationMicroUsd)} maximum per venue/position, ` +
      `${maximumOpenPositions} concurrent positions maximum.`,
    );
    if (liveTestEntry) {
      console.warn(
        `ONE-SHOT TEST ENTRY ENABLED: profitability checks are bypassed for one submission attempt only. ` +
        `Jupiter gross uses the current $${formatUsd(jupiterQuoteGrossMicroUsd)} screening build; all identity, freshness, depth, ` +
        `balance, allocation, slippage, exact-build freshness, and reconciliation protections remain active.`,
      );
    }
  }
  if (webEnabled) {
    try {
      statusServer = await startShortWindowStatusServer(statusStore, webPort);
      console.log(`Dashboard data available at ${statusServer.url}`);
      console.log("Run `pnpm dashboard:dev` in another terminal, then open http://localhost:3000.");
    } catch (error) {
      if (liveTrade) {
        throw new Error(
          `LIVE_SINGLE_INSTANCE_LOCK_FAILED: status port ${webPort} is already occupied or unavailable; ` +
          `refusing to run a second live executor (${errorMessage(error)})`,
          { cause: error },
        );
      }
      console.warn(`Dashboard status server could not start on port ${webPort}: ${errorMessage(error)}`);
      console.warn("The scanner will continue. Choose another port with --web-port=3211 or use --no-web.");
    }
  }
  console.log("Press Ctrl-C to stop.");

  const twapTask = streamChainlinkTwap60({
    signal: controller.signal,
    symbol: "btc/usd",
    onObservation: (observation) => {
      twapAnchors.add(observation);
      statusStore.recordFeedObservation("polymarketTwap", observation.observedAtMs, observation.receivedAtMs);
    },
    onStatus: (status) => {
      statusStore.updateFeed("polymarketTwap", {
        status: status.status,
        message: status.message ?? null,
      });
      printReferenceStatus("Polymarket TWAP 60s", status);
    },
  });
  const spotTask = streamChainlinkSpot({
    signal: controller.signal,
    symbol: "btc/usd",
    onObservation: (observation) => {
      spotAnchors.add(observation);
      statusStore.recordFeedObservation("jupiterSpot", observation.observedAtMs, observation.receivedAtMs);
    },
    onStatus: (status) => {
      statusStore.updateFeed("jupiterSpot", {
        status: status.status,
        message: status.message ?? null,
      });
      printReferenceStatus("Jupiter Chainlink spot", status);
    },
  });
  const paperSettlementTask = paperTrader ? runPaperSettlementLoop({
    trader: paperTrader,
    polymarketClient,
    jupiterClient,
    writer,
    sessionId,
    statusStore,
    signal: controller.signal,
  }) : Promise.resolve();
  const liveSettlementTask = liveTrader ? runLiveSettlementLoop({
    trader: liveTrader,
    polymarketClient,
    jupiterClient,
    writer,
    sessionId,
    statusStore,
    signal: controller.signal,
  }) : Promise.resolve();
  const liveBalanceTask = liveTrader && polymarketLiveExecutor && jupiterLiveExecutor
    ? runLiveWalletBalanceLoop({
      polymarket: polymarketLiveExecutor,
      jupiter: jupiterLiveExecutor,
      trader: liveTrader,
      writer,
      sessionId,
      statusStore,
      signal: controller.signal,
    })
    : Promise.resolve();

  try {
    await Promise.all([
      ...(["5m", "15m"] as const).map((duration) => runDurationLoop({
        duration,
        sessionId,
        writer,
        polymarketClient,
        jupiterClient,
        forecastCache,
        referenceHttp,
        twapAnchors,
        spotAnchors,
        configuration,
        statusStore,
        paperTrader,
        liveTrader,
        signal: controller.signal,
        recordSample,
        recordOpportunity,
        onPairExamined: () => { pairsExamined += 1; },
      })),
      dailyThresholdEnabled ? runDailyThresholdLoop({
        sessionId,
        writer,
        polymarketClient,
        jupiterClient,
        cache: dailyThresholdCache,
        configuration,
        statusStore,
        liveTrader,
        signal: controller.signal,
        recordSample,
        recordOpportunity,
        onPairsExamined: (count) => { pairsExamined += count; },
      }) : Promise.resolve(),
    ]);
  } finally {
    controller.abort();
    await Promise.allSettled([twapTask, spotTask, paperSettlementTask, liveSettlementTask, liveBalanceTask]);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await writer.append({
      schemaVersion: 2,
      type: "session_end",
      sessionId,
      startedAt: iso(startedAtMs),
      endedAt: iso(Date.now()),
      pairsExamined,
      samplesWritten,
      opportunitiesWritten,
      stopReason,
      paperPortfolio: paperTrader?.snapshot() ?? null,
      livePortfolio: liveTrader?.snapshot() ?? null,
    });
    await writer.flush();
    statusStore.stop();
    if (statusServer) await statusServer.close().catch(() => undefined);
    console.log(`Stopped. Wrote ${samplesWritten} sample(s) and ${opportunitiesWritten} candidate record(s).`);
  }
}

async function runDurationLoop(input: {
  duration: Duration;
  sessionId: string;
  writer: JsonlWriter;
  polymarketClient: PolymarketClient;
  jupiterClient: JupiterClient;
  forecastCache: ForecastMarketCache;
  referenceHttp: HttpClient;
  twapAnchors: ExactTwapAnchorStore;
  spotAnchors: ExactChainlinkSpotStore;
  configuration: MonitorConfiguration;
  statusStore: ShortWindowStatusStore;
  paperTrader: ShortWindowPaperTrader | null;
  liveTrader: ShortWindowLiveTrader | null;
  signal: AbortSignal;
  recordSample: () => number;
  recordOpportunity: () => number;
  onPairExamined: () => void;
}): Promise<void> {
  const durationMs = DURATION_MS[input.duration];
  while (!input.signal.aborted) {
    const startMs = Math.floor(Date.now() / durationMs) * durationMs;
    const endMs = startMs + durationMs;
    const startedMidRound = Date.now() > startMs + 2_500;
    input.statusStore.updateDuration(input.duration, {
      phase: "discovering",
      message: "Looking for the current same-duration market pair.",
      start: iso(startMs),
      end: iso(endMs),
      nextBoundary: iso(endMs),
      startedMidRound,
      pair: null,
      references: {
        polymarket: emptyReferenceStatus(),
        jupiter: emptyReferenceStatus(),
        differenceUsd: null,
        limitUsd: formatUsd(input.configuration.maximumReferenceDifferenceMicroUsd),
      },
      books: { polymarket: null, jupiter: null },
      bestRoute: null,
      samples: 0,
      opportunities: 0,
    });
    input.onPairExamined();

    let pair: CrossVenuePair;
    try {
      pair = await loadCrossVenuePair({
        duration: input.duration,
        startMs,
        endMs,
        polymarketClient: input.polymarketClient,
        forecastCache: input.forecastCache,
      });
    } catch (error) {
      await input.writer.append(pairErrorRecord(input.sessionId, input.duration, startMs, endMs, "market_discovery", error));
      input.statusStore.updateDuration(input.duration, {
        phase: "error",
        message: `Market discovery failed; retrying: ${errorMessage(error)}`,
      });
      console.warn(`[${input.duration}] discovery retry: ${errorMessage(error)}`);
      await waitUntil(Math.min(endMs + 50, Date.now() + 2_000), input.signal);
      continue;
    }

    await input.writer.append({
      schemaVersion: 2,
      type: "pair_discovered",
      sessionId: input.sessionId,
      at: iso(Date.now()),
      pair: pairLog(pair),
      rulesComparison: {
        sameAsset: true,
        sameStart: true,
        sameEnd: true,
        sameClosingOracleSampling: false,
        polymarket: "Chainlink BTC/USD TWAP 60s",
        jupiter: "Chainlink BTC/USD spot",
      },
      warnings: BASIS_WARNINGS,
    });
    input.statusStore.updateDuration(input.duration, {
      phase: "waiting_references",
      message: startedMidRound
        ? `Started after the ${formatUtcTime(startMs)} opening boundary. Querying both venues' exact ` +
          "price-to-beat services before monitoring or trading."
        : `Pair found. Waiting for exact opening observations at ${formatUtcTime(startMs)}.`,
      pair: {
        polymarketSlug: pair.polymarketSlug,
        polymarketMarketId: pair.polymarket.marketId,
        jupiterEventId: pair.jupiterEventId,
        jupiterUpMarketId: pair.jupiterUp.marketId,
        jupiterDownMarketId: pair.jupiterDown.marketId,
      },
    });

    const references = await waitForReferences({
      pair,
      twapAnchors: input.twapAnchors,
      spotAnchors: input.spotAnchors,
      http: input.referenceHttp,
      signal: input.signal,
      retryMs: input.configuration.referenceRetryMs,
      onProgress: ({ polymarket, jupiter, message }) => {
        input.statusStore.updateReference(input.duration, "polymarket", referenceStatus(polymarket));
        input.statusStore.updateReference(input.duration, "jupiter", referenceStatus(jupiter));
        input.statusStore.updateDuration(input.duration, { message });
      },
    });
    if (!references) {
      await input.writer.append(pairErrorRecord(
        input.sessionId,
        input.duration,
        startMs,
        endMs,
        "reference_unavailable",
        "Exact Polymarket and Jupiter opening references were not both available before close",
      ));
      input.statusStore.updateDuration(input.duration, {
        phase: "ended",
        message: `Round skipped safely: exact opening references were unavailable. The next ${input.duration} boundary is ${formatUtcTime(endMs)}.`,
      });
      console.warn(`[${input.duration}] skipped: exact opening references unavailable.`);
      await waitUntil(endMs + 50, input.signal);
      continue;
    }

    const [polymarketReference, jupiterReference] = references;
    const differenceMicroUsd = referenceDifferenceMicroUsd(
      polymarketReference.priceMicroUsd,
      jupiterReference.priceMicroUsd,
    );
    input.statusStore.updateDuration(input.duration, {
      references: {
        polymarket: referenceStatus(polymarketReference),
        jupiter: referenceStatus(jupiterReference),
        differenceUsd: formatUsd(differenceMicroUsd),
        limitUsd: formatUsd(input.configuration.maximumReferenceDifferenceMicroUsd),
      },
    });
    if (!referencePricesWithin(
      polymarketReference.priceMicroUsd,
      jupiterReference.priceMicroUsd,
      input.configuration.maximumReferenceDifferenceMicroUsd,
    )) {
      await input.writer.append({
        schemaVersion: 2,
        type: "pair_rejected",
        sessionId: input.sessionId,
        at: iso(Date.now()),
        reason: "REFERENCE_DIFFERENCE_NOT_STRICTLY_BELOW_LIMIT",
        pair: pairLog(pair),
        references: referencesLog(polymarketReference, jupiterReference, differenceMicroUsd),
      });
      input.statusStore.updateDuration(input.duration, {
        phase: "rejected",
        message: `Pair rejected: opening references differ by $${formatUsd(differenceMicroUsd)}; the strict limit is below $${formatUsd(input.configuration.maximumReferenceDifferenceMicroUsd)}.`,
      });
      console.log(
        `[${input.duration}] REJECTED references differ by $${formatUsd(differenceMicroUsd)} ` +
        `(limit < $${formatUsd(input.configuration.maximumReferenceDifferenceMicroUsd)}).`,
      );
      await waitUntil(endMs + 50, input.signal);
      continue;
    }

    const routes = input.configuration.routeSelectionMode === "any_complementary"
      ? allComplementaryCrossVenueRoutes()
      : eligibleCrossVenueRoutes(
          polymarketReference.priceMicroUsd,
          jupiterReference.priceMicroUsd,
        );
    const routeWarnings = input.configuration.routeSelectionMode === "any_complementary"
      ? [...BASIS_WARNINGS, ANY_ROUTE_WARNING]
      : BASIS_WARNINGS;
    await input.writer.append({
      schemaVersion: 2,
      type: "pair_qualified",
      sessionId: input.sessionId,
      at: iso(Date.now()),
      pair: pairLog(pair),
      references: referencesLog(polymarketReference, jupiterReference, differenceMicroUsd),
      eligibleRoutes: routes,
      guaranteed: false,
      warnings: routeWarnings,
    });
    input.statusStore.updateDuration(input.duration, {
      phase: "qualified",
      message: input.configuration.routeSelectionMode === "any_complementary"
        ? "Opening references qualify. Evaluating both complementary routes and taking the best qualified net edge."
        : `Opening references qualify. Starting both order-book feeds for ${routes.map(formatRoute).join(" or ")}.`,
    });
    console.log(
      `[${input.duration}] QUALIFIED Poly=$${formatUsd(polymarketReference.priceMicroUsd)} ` +
      `Jup=$${formatUsd(jupiterReference.priceMicroUsd)} difference=$${formatUsd(differenceMicroUsd)} ` +
      `route=${routes.map(formatRoute).join(" or ")}`,
    );

    if (input.liveTrader) {
      // Tick size is static for the normal life of these short rounds. Warm it
      // before an opportunity appears so signing the Polymarket FOK does not
      // spend an extra REST round-trip while the book is moving.
      await Promise.allSettled(routes.map((route) =>
        input.liveTrader!.primeEntryToken(livePairIdentity(pair, route).polymarketTokenId)
      ));
    }

    const result = await monitorQualifiedPair({
      sessionId: input.sessionId,
      pair,
      references,
      routes,
      writer: input.writer,
      jupiterClient: input.jupiterClient,
      configuration: input.configuration,
      statusStore: input.statusStore,
      paperTrader: input.paperTrader,
      liveTrader: input.liveTrader,
      signal: input.signal,
      recordSample: input.recordSample,
      recordOpportunity: input.recordOpportunity,
    });
    input.statusStore.updateDuration(input.duration, {
      phase: "ended",
      message: `Round ended: ${result.reason}. Waiting for the next ${input.duration} pair.`,
    });
    await input.writer.append({
      schemaVersion: 2,
      type: "pair_end",
      sessionId: input.sessionId,
      at: iso(Date.now()),
      pair: pairLog(pair),
      samplesWritten: result.samples,
      opportunitiesWritten: result.opportunities,
      reason: result.reason,
    });
    if (input.paperTrader) {
      const awaiting = input.paperTrader.markPairEnded(pairKey(pair));
      updatePaperStrategyStatus(input.statusStore, input.paperTrader);
      if (awaiting) {
        await input.writer.append({
          schemaVersion: 2,
          type: "paper_position_awaiting_resolution",
          sessionId: input.sessionId,
          at: iso(Date.now()),
          position: paperPositionLog(awaiting),
          reason: "NO_GREEN_FULL_SIZE_EXIT_BEFORE_PAIR_END",
        });
        console.log(`[${input.duration}] PAPER HOLD awaiting resolution: ${awaiting.id}`);
      }
    }
    if (input.liveTrader) {
      const awaiting = await input.liveTrader.markPairEnded(pairKey(pair));
      updateLiveStrategyStatus(input.statusStore, input.liveTrader);
      if (awaiting) {
        await input.writer.append({
          schemaVersion: 2,
          type: "live_position_awaiting_resolution",
          sessionId: input.sessionId,
          at: iso(Date.now()),
          positionId: awaiting.id,
          pair: pairLog(pair),
          reason: "NO_GREEN_FULL_SIZE_EXIT_BEFORE_PAIR_END",
        });
        console.warn(`[${input.duration}] LIVE HOLD awaiting resolution: ${awaiting.id}`);
      }
    }
    await waitUntil(endMs + 50, input.signal);
  }
}

async function runDailyThresholdLoop(input: {
  sessionId: string;
  writer: JsonlWriter;
  polymarketClient: PolymarketClient;
  jupiterClient: JupiterClient;
  cache: DailyThresholdMarketCache;
  configuration: MonitorConfiguration;
  statusStore: ShortWindowStatusStore;
  liveTrader: ShortWindowLiveTrader | null;
  signal: AbortSignal;
  recordSample: () => number;
  recordOpportunity: () => number;
  onPairsExamined: (count: number) => void;
}): Promise<void> {
  let lastDiscoverySignature = "";
  while (!input.signal.aborted) {
    try {
      const discovered = discoverDailyThresholdPairs(await input.cache.getActive(true));
      input.onPairsExamined(discovered.length);
      const discoverySignature = discovered.map((pair) => `${pair.key}:${pair.jupiter.eventId}`).join("|");
      if (discoverySignature !== lastDiscoverySignature) {
        await input.writer.append({
          schemaVersion: 2,
          type: "daily_threshold_discovery",
          sessionId: input.sessionId,
          at: iso(Date.now()),
          count: discovered.length,
          pairs: discovered.map(dailyThresholdPairIdentityLog),
          sharedLiquidity: true,
          warning: "Jupiter POLY-* orders are keeper-routed to the underlying prediction market; displayed prices are screening data only.",
        });
        console.log(`[daily] discovered ${discovered.length} exact BTC-above-strike POLY-* pairs`);
        lastDiscoverySignature = discoverySignature;
      }
      if (discovered.length === 0) {
        await waitForAbort(Math.min(30_000, input.configuration.dailyThresholdDiscoveryRefreshMs), input.signal);
        continue;
      }
      await monitorDailyThresholdSet({ ...input, pairs: discovered });
    } catch (error) {
      if (input.signal.aborted) break;
      const message = errorMessage(error);
      console.warn(`[daily] discovery/monitor retry: ${message}`);
      await input.writer.append({
        schemaVersion: 2,
        type: "daily_threshold_error",
        sessionId: input.sessionId,
        at: iso(Date.now()),
        stage: "discovery_or_monitor",
        message,
      });
      await waitForAbort(5_000, input.signal);
    }
  }
}

async function monitorDailyThresholdSet(input: {
  sessionId: string;
  writer: JsonlWriter;
  polymarketClient: PolymarketClient;
  jupiterClient: JupiterClient;
  cache: DailyThresholdMarketCache;
  configuration: MonitorConfiguration;
  statusStore: ShortWindowStatusStore;
  liveTrader: ShortWindowLiveTrader | null;
  signal: AbortSignal;
  recordSample: () => number;
  recordOpportunity: () => number;
  pairs: readonly DailyThresholdPair[];
}): Promise<void> {
  const controller = new AbortController();
  const latestPolymarket = new Map<string, BinaryOrderBook>();
  const verified = new Map<string, DailyThresholdPair>();
  let lastStatus = "";
  const stop = (): void => controller.abort();
  input.signal.addEventListener("abort", stop, { once: true });
  const refreshTimer = setTimeout(stop, input.configuration.dailyThresholdDiscoveryRefreshMs);
  const stream = streamPolymarketOrderBookSet(input.pairs.map((pair) => pair.polymarket), {
    signal: controller.signal,
    onBook: (market, update) => {
      latestPolymarket.set(market.marketId, update.book);
    },
    onStatus: (status) => {
      const signature = `${status.status}:${status.message ?? ""}`;
      if (signature === lastStatus || status.status === "connecting") return;
      lastStatus = signature;
      if (status.status === "connected") console.log(`[daily] Polymarket market-set WebSocket connected`);
      if (status.status === "disconnected") {
        console.warn(`[daily] Polymarket market-set WebSocket disconnected: ${status.message ?? "unknown error"}`);
      }
    },
  });

  try {
    while (!controller.signal.aborted) {
      await waitForAbort(input.configuration.dailyThresholdPollMs, controller.signal);
      if (controller.signal.aborted) break;
      const refreshed = new Map(
        discoverDailyThresholdPairs(await input.cache.getActive(true)).map((pair) => [pair.key, pair]),
      );
      const screened: Array<{
        pair: DailyThresholdPair;
        polymarketBook: BinaryOrderBook;
        route: EvaluatedCrossVenueRoute | null;
        openPosition: boolean;
      }> = [];
      for (const original of input.pairs) {
        const pair = refreshed.get(original.key) ?? original;
        const polymarketBook = latestPolymarket.get(pair.polymarket.marketId);
        if (!polymarketBook || pair.closeMs <= Date.now()) continue;
        const pricingBook = dailyPricingBook(pair.jupiter, polymarketBook);
        const route = evaluateCrossVenueRoutes(polymarketBook, pricingBook, DAILY_THRESHOLD_ROUTES)[0] ?? null;
        const openPosition = input.liveTrader?.hasOpenPosition(pair.key) ?? false;
        if (route?.isFeeAdjustedCandidate || openPosition) {
          screened.push({
            pair,
            polymarketBook,
            route,
            openPosition,
          });
        }
      }
      screened.sort((left, right) => {
        if (left.openPosition !== right.openPosition) return left.openPosition ? -1 : 1;
        return compareBigints(
          right.route?.nominalEdgeTotalMicroUsd ?? -1n,
          left.route?.nominalEdgeTotalMicroUsd ?? -1n,
        );
      });
      const first = screened[0];
      if (!first) continue;
      const targets = first.openPosition ? [first] : screened.slice(0, 3);
      let selected: {
        target: (typeof screened)[number];
        pair: DailyThresholdPair;
        jupiterBook: BinaryOrderBook;
        best: EvaluatedCrossVenueRoute | null;
      } | null = null;
      for (const target of targets) {
        let pair = verified.get(target.pair.key);
        if (!pair) {
          pair = validateDailyThresholdPair(
            target.pair,
            await input.polymarketClient.getMarket(target.pair.polymarket.marketId),
          );
          verified.set(pair.key, pair);
        }
        const jupiterBook = await input.jupiterClient.getOrderBook(pair.jupiter);
        const best = evaluateCrossVenueRoutes(target.polymarketBook, jupiterBook, DAILY_THRESHOLD_ROUTES)[0] ?? null;
        const sequence = input.recordSample();
        await input.writer.append({
          schemaVersion: 2,
          type: "daily_threshold_sample",
          sessionId: input.sessionId,
          sequence,
          at: iso(Date.now()),
          pair: dailyThresholdPairLog(pair),
          books: {
            polymarket: bookLog(target.polymarketBook),
            jupiter: bookLog(jupiterBook),
          },
          bestRoute: best ? evaluatedRouteLog(best) : null,
          sharedLiquidity: true,
        });
        if (target.openPosition || best?.isFeeAdjustedCandidate) {
          if (!selected || compareBigints(
            best?.nominalEdgeTotalMicroUsd ?? -1n,
            selected.best?.nominalEdgeTotalMicroUsd ?? -1n,
          ) > 0) {
            selected = { target, pair, jupiterBook, best };
          }
        }
      }
      if (!selected) continue;
      const { target, pair, jupiterBook, best } = selected;

      if (target.openPosition) {
        const route = best?.route ?? DAILY_THRESHOLD_ROUTES[0]!;
        const decision = input.liveTrader
          ? await input.liveTrader.consider({
            pair: dailyLivePairIdentity(pair, route),
            bestRoute: best,
            polymarketBook: target.polymarketBook,
            jupiterBook,
            atMs: Date.now(),
          })
          : null;
        if (decision && decision.type !== "hold" && decision.type !== "skip") {
          await appendDailyLiveDecision(input, pair, best, decision);
        }
        continue;
      }
      if (!best?.isFeeAdjustedCandidate) continue;

      const opportunity = input.recordOpportunity();
      let decision: LiveDecision | null = null;
      if (input.liveTrader) {
        decision = await input.liveTrader.consider({
          pair: dailyLivePairIdentity(pair, best.route),
          bestRoute: best,
          polymarketBook: target.polymarketBook,
          jupiterBook,
          atMs: Date.now(),
        });
        updateLiveStrategyStatus(input.statusStore, input.liveTrader);
      }
      await input.writer.append({
        schemaVersion: 2,
        type: "daily_threshold_candidate",
        sessionId: input.sessionId,
        opportunity,
        at: iso(Date.now()),
        pair: dailyThresholdPairLog(pair),
        route: evaluatedRouteLog(best),
        liveDecision: decision ? liveDecisionLog(decision) : null,
        contractuallyComplementaryAfterBothFills: true,
        guaranteed: false,
        warnings: ["SHARED_UNDERLYING_POLYMARKET_LIQUIDITY", "NON_ATOMIC_CROSS_CHAIN_EXECUTION"],
      });
      console.log(
        `[daily] candidate ${pair.jupiter.eventTitle} $${formatUsd(pair.thresholdMicroUsd)} ` +
        `${formatRoute(best.route)} edge=${formatUsd(best.effectiveEdgeMicroUsdPerContract)}/contract` +
        (decision ? ` decision=${decision.type}` : " read-only"),
      );
      if (decision?.type === "halt") console.error(`[daily] LIVE TRADER HALTED: ${decision.reason}`);
      if (decision?.type === "recovery" && decision.recovery) {
        await appendLiveRecovery(input.writer, input.sessionId, decision.recovery);
      }
    }
  } finally {
    clearTimeout(refreshTimer);
    controller.abort();
    input.signal.removeEventListener("abort", stop);
    await Promise.allSettled([stream]);
  }
}

async function appendDailyLiveDecision(
  input: { writer: JsonlWriter; sessionId: string; statusStore: ShortWindowStatusStore; liveTrader: ShortWindowLiveTrader | null },
  pair: DailyThresholdPair,
  best: EvaluatedCrossVenueRoute | null,
  decision: LiveDecision,
): Promise<void> {
  if (input.liveTrader) updateLiveStrategyStatus(input.statusStore, input.liveTrader);
  await input.writer.append({
    schemaVersion: 2,
    type: "daily_threshold_live_decision",
    sessionId: input.sessionId,
    at: iso(Date.now()),
    pair: dailyThresholdPairLog(pair),
    route: best ? evaluatedRouteLog(best) : null,
    decision: liveDecisionLog(decision),
  });
}

async function monitorQualifiedPair(input: {
  sessionId: string;
  pair: CrossVenuePair;
  references: readonly [ReferencePrice, ReferencePrice];
  routes: readonly CrossVenueShortWindowRoute[];
  writer: JsonlWriter;
  jupiterClient: JupiterClient;
  configuration: MonitorConfiguration;
  statusStore: ShortWindowStatusStore;
  paperTrader: ShortWindowPaperTrader | null;
  liveTrader: ShortWindowLiveTrader | null;
  signal: AbortSignal;
  recordSample: () => number;
  recordOpportunity: () => number;
}): Promise<{ samples: number; opportunities: number; reason: string }> {
  const controller = new AbortController();
  const queue = new AsyncEventQueue<PairEvent>();
  let latestPolymarket: BinaryOrderBook | null = null;
  let latestJupiter: BinaryOrderBook | null = null;
  let samples = 0;
  let opportunities = 0;
  let lastEvaluationAtMs = 0;
  let lastMarketLogAtMs = 0;
  let lastOpportunityLogAtMs = 0;
  let lastOpportunitySignature = "";
  let endReason = "MARKET_CLOSE_REACHED";
  const onParentAbort = (): void => {
    endReason = "SESSION_STOPPED";
    controller.abort();
    queue.push({ type: "end", reason: endReason });
  };
  input.signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    queue.push({ type: "end", reason: endReason });
  }, Math.max(0, input.pair.endMs - Date.now()));

  const polymarketTask = streamPolymarketOrderBooks(input.pair.polymarket, {
    signal: controller.signal,
    onBook: (update) => queue.push({ type: "polymarket_book", update }),
    onStatus: (status) => queue.push({ type: "polymarket_status", status }),
  });
  const jupiterTask = pollJupiterOrderBook({
    client: input.jupiterClient,
    pair: input.pair,
    outcomes: input.routes.map((route) => route.jupiterOutcome),
    needsExitBook: () => input.liveTrader?.hasOpenPosition(pairKey(input.pair)) ?? false,
    fallbackGrossMicroUsd: input.configuration.jupiterFallbackGrossMicroUsd,
    intervalMs: input.configuration.jupiterPollMs,
    signal: controller.signal,
    queue,
  });
  input.statusStore.updateDuration(input.pair.duration, {
    phase: "monitoring",
    message: "Qualified pair is live. Waiting for both top-of-book snapshots.",
  });

  try {
    while (!controller.signal.aborted) {
      const event = await queue.next();
      if (event.type === "end") {
        endReason = event.reason;
        break;
      }
      if (event.type === "polymarket_status") {
        if (event.status.status === "connected") console.log(`[${input.pair.duration}] Polymarket orderbook WebSocket connected`);
        if (event.status.status === "disconnected") {
          console.warn(`[${input.pair.duration}] Polymarket WebSocket disconnected: ${event.status.message ?? "unknown error"}`);
        }
        continue;
      }
      if (event.type === "jupiter_error") {
        await input.writer.append({
          schemaVersion: 2,
          type: "jupiter_poll_error",
          sessionId: input.sessionId,
          at: iso(Date.now()),
          duration: input.pair.duration,
          consecutiveErrors: event.consecutiveErrors,
          retryInMs: event.retryInMs,
          message: event.message,
        });
        const persistent = event.consecutiveErrors >= input.configuration.maximumConsecutiveJupiterErrors;
        input.statusStore.updateDuration(input.pair.duration, {
          phase: "monitoring",
          message: `${persistent ? "Persistent" : "Temporary"} Jupiter API error ` +
            `(${event.consecutiveErrors} consecutive). Retrying in ${event.retryInMs}ms; this qualified round remains active.`,
        });
        console.warn(
          `[${input.pair.duration}] Jupiter poll error ${event.consecutiveErrors}; ` +
          `retrying in ${event.retryInMs}ms: ${event.message}`,
        );
        continue;
      }

      if (event.type === "jupiter_book" && event.notice) {
        await input.writer.append({
          schemaVersion: 2,
          type: "jupiter_price_source_change",
          sessionId: input.sessionId,
          at: iso(Date.now()),
          duration: input.pair.duration,
          source: event.source,
          message: event.notice,
        });
        console.warn(`[${input.pair.duration}] ${event.notice}`);
      }

      const trigger = event.type === "polymarket_book"
        ? `polymarket_websocket_${event.update.eventType}`
        : event.source === "orderbook" ? "jupiter_rest_poll" : `jupiter_${event.source}`;
      if (event.type === "polymarket_book") {
        latestPolymarket = event.update.book;
        input.statusStore.updateBook(input.pair.duration, "polymarket", bookStatus(latestPolymarket, Date.now(), false));
      } else {
        latestJupiter = event.book;
        const ageMs = Math.max(0, Date.now() - latestJupiter.receivedAtMs);
        input.statusStore.updateBook(
          input.pair.duration,
          "jupiter",
          bookStatus(latestJupiter, Date.now(), ageMs > input.configuration.maximumJupiterAgeMs),
        );
      }
      if (!latestPolymarket || !latestJupiter) continue;

      const atMs = Date.now();
      if (event.type === "polymarket_book" &&
        atMs - lastEvaluationAtMs < input.configuration.sampleIntervalMs) {
        continue;
      }
      lastEvaluationAtMs = atMs;
      const jupiterSnapshotAgeMs = atMs - latestJupiter.receivedAtMs;
      const jupiterSnapshotStale = jupiterSnapshotAgeMs > input.configuration.maximumJupiterAgeMs;
      const jupiterPriceWebsocket = latestJupiter.provider === "bisonfi_price_websocket";
      const evaluated = evaluateCrossVenueRoutes(latestPolymarket, latestJupiter, input.routes);
      const best = evaluated[0] ?? null;
      const routeForIdentity = best?.route ?? input.routes[0];
      const paperDecision = input.paperTrader && !jupiterSnapshotStale
        ? input.paperTrader.consider({
          pair: paperPairIdentity(input.pair, best?.route.jupiterOutcome ?? "UP"),
          bestRoute: best,
          polymarketBook: latestPolymarket,
          jupiterBook: latestJupiter,
          atMs,
        })
        : null;
      const liveDecision = input.liveTrader && !jupiterSnapshotStale && routeForIdentity
        ? await input.liveTrader.consider({
          pair: livePairIdentity(input.pair, routeForIdentity),
          bestRoute: best,
          polymarketBook: latestPolymarket,
          jupiterBook: latestJupiter,
          jupiterEntryBuild: null,
          jupiterEntryBuildAtMs: null,
          atMs,
        })
        : null;
      if (input.paperTrader) updatePaperStrategyStatus(input.statusStore, input.paperTrader);
      if (input.liveTrader) updateLiveStrategyStatus(input.statusStore, input.liveTrader);
      input.statusStore.updateDuration(input.pair.duration, {
        phase: "monitoring",
        message: jupiterSnapshotStale
          ? `Books received, but the Jupiter snapshot is stale (${jupiterSnapshotAgeMs}ms). No candidate will be recorded.`
          : input.liveTrader && best?.isFeeAdjustedCandidate
            ? liveCandidateStatusMessage(best, liveDecision)
          : input.liveTrader
            ? "LIVE execution armed. Monitoring fee-adjusted complementary routes and real position exits."
            : "Monitoring fee-adjusted complementary routes. No orders are submitted.",
        books: {
          polymarket: bookStatus(latestPolymarket, atMs, false),
          jupiter: bookStatus(latestJupiter, atMs, jupiterSnapshotStale),
        },
        bestRoute: best ? routeStatus(best, jupiterSnapshotStale) : null,
        samples,
        opportunities,
      });
      const materialDecision = paperDecision?.type === "entry" || paperDecision?.type === "exit" ||
        liveDecision?.type === "entry" || liveDecision?.type === "exit" || liveDecision?.type === "halt" ||
        liveDecision?.type === "recovery";
      if (materialDecision || atMs - lastMarketLogAtMs >= input.configuration.marketLogIntervalMs) {
        lastMarketLogAtMs = atMs;
        const sequence = input.recordSample();
        samples += 1;
        await input.writer.append({
          schemaVersion: 2,
          type: "book_sample",
          sessionId: input.sessionId,
          sequence,
          at: iso(atMs),
          duration: input.pair.duration,
          trigger,
          pair: pairIdentityLog(input.pair),
          references: referencesLog(
            input.references[0],
            input.references[1],
            referenceDifferenceMicroUsd(input.references[0].priceMicroUsd, input.references[1].priceMicroUsd),
          ),
          books: {
            polymarket: bookLog(latestPolymarket),
            jupiter: bookLog(latestJupiter),
            jupiterPriceSource: jupiterPriceWebsocket ? "degen_price_websocket" : "orderbook",
            jupiterSnapshotAgeMs,
            jupiterSnapshotStale,
          },
          evaluatedRoutes: evaluated.map(evaluatedRouteLog),
          bestRoute: best ? evaluatedRouteLog(best) : null,
          paperDecision: paperDecision ? paperDecisionLog(paperDecision) : null,
          liveDecision: liveDecision ? liveDecisionSummaryLog(liveDecision) : null,
          guaranteed: false,
          warnings: [
            ...BASIS_WARNINGS,
            "TOP_LEVEL_SIGNAL_MULTI_LEVEL_VWAP_EXECUTION",
            ...(jupiterPriceWebsocket
              ? ["JUPITER_PUBLIC_DEGEN_PRICE_WEBSOCKET_REQUIRES_ATOMIC_ORDER_PREFLIGHT"]
              : []),
            ...(jupiterSnapshotStale ? ["STALE_JUPITER_SNAPSHOT"] : []),
          ],
        });
        printSample(sequence, atMs, input.pair.duration, latestPolymarket, latestJupiter, best, jupiterSnapshotAgeMs);
      }
      if (liveDecision?.preflight?.error) {
        await input.writer.append({
          schemaVersion: 2,
          type: "live_entry_preflight_failed",
          sessionId: input.sessionId,
          at: iso(atMs),
          duration: input.pair.duration,
          pair: pairLog(input.pair),
          route: best ? evaluatedRouteLog(best) : null,
          preflight: liveDecision.preflight,
        });
        console.warn(
          `[${input.pair.duration}] LIVE ENTRY PREFLIGHT FAILED ` +
          `stage=${liveDecision.preflight.stage} code=${liveDecision.preflight.code} ` +
          `elapsed=${liveDecision.preflight.elapsedMs}ms cooldown=${liveDecision.preflight.cooldownMs}ms: ` +
          `${liveDecision.preflight.error.message}`,
        );
      }
      if (paperDecision?.type === "entry" || paperDecision?.type === "exit") {
        await input.writer.append({
          schemaVersion: 2,
          type: paperDecision.type === "entry" ? "paper_entry" : "paper_exit",
          sessionId: input.sessionId,
          at: iso(atMs),
          duration: input.pair.duration,
          pair: pairLog(input.pair),
          decision: paperDecisionLog(paperDecision),
          portfolio: input.paperTrader?.snapshot() ?? null,
          warnings: BASIS_WARNINGS,
        });
        if (paperDecision.type === "entry") {
          console.log(
            `[${input.pair.duration}] PAPER ENTRY ${formatRoute(paperDecision.proposal.route)} ` +
            `size=${formatContracts(paperDecision.position.quantityMicro)} ` +
            `allIn=$${formatUsd(paperDecision.position.entryAllInCostMicroUsd)} ` +
            `nominalEdge=$${formatUsd(paperDecision.position.nominalEntryEdgeMicroUsd)}`,
          );
        } else {
          console.log(
            `[${input.pair.duration}] PAPER EXIT GREEN ${paperDecision.position.id} ` +
            `profit=$${formatUsd(paperDecision.proposal.realizedProfitMicroUsd)}`,
          );
        }
      }
      if (liveDecision?.type === "entry" || liveDecision?.type === "exit" || liveDecision?.type === "halt" ||
        liveDecision?.type === "recovery") {
        await input.writer.append({
          schemaVersion: 2,
          type: liveDecision.type === "entry"
            ? "live_entry"
            : liveDecision.type === "exit"
              ? "live_exit"
              : liveDecision.type === "recovery" ? "live_recovery" : "live_halt",
          sessionId: input.sessionId,
          at: iso(atMs),
          duration: input.pair.duration,
          pair: pairLog(input.pair),
          decision: liveDecisionLog(liveDecision),
          recovery: liveDecision.recovery ?? null,
          portfolio: input.liveTrader?.snapshot() ?? null,
          warnings: BASIS_WARNINGS,
        });
        if (liveDecision.type === "entry") {
          console.warn(
            `[${input.pair.duration}] LIVE ENTRY ${liveDecision.position.id} ` +
            `size=${formatContracts(liveDecision.position.originalContractsMicro)} ` +
            `allIn=$${formatUsd(liveDecision.position.remainingEntryCostMicroUsd)} ` +
            `submitSkew=${liveDecision.position.entrySubmissionSkewMs ?? "unknown"}ms`,
          );
        } else if (liveDecision.type === "exit") {
          console.warn(
            `[${input.pair.duration}] LIVE EXIT ${liveDecision.positionId} ` +
            `profit=$${formatUsd(liveDecision.realizedProfitMicroUsd)} ` +
            `submitSkew=${liveDecision.submissionSkewMs ?? "unknown"}ms`,
          );
        } else if (liveDecision.type === "recovery") {
          const unwound = liveDecision.recovery?.code === "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND";
          console.warn(
            `[${input.pair.duration}] LIVE AUTO RECOVERY ${liveDecision.recovery?.code ?? "ZERO_EXPOSURE"}: ` +
            (unwound
              ? `${liveDecision.positionId} automatically sold the Polymarket-only fill.`
              : `${liveDecision.positionId} confirmed zero exposure on both venues; no recovery order was submitted.`),
          );
        } else {
          console.error(`[${input.pair.duration}] LIVE TRADER HALTED: ${liveDecision.reason}`);
        }
      }
      if (best?.isFeeAdjustedCandidate && !jupiterSnapshotStale) {
        const signature = opportunitySignature(best);
        if (signature !== lastOpportunitySignature &&
          atMs - lastOpportunityLogAtMs >= input.configuration.marketLogIntervalMs) {
          lastOpportunitySignature = signature;
          lastOpportunityLogAtMs = atMs;
          const opportunitySequence = input.recordOpportunity();
          opportunities += 1;
          input.statusStore.updateDuration(input.pair.duration, {
            message: input.liveTrader
              ? liveCandidateStatusMessage(best, liveDecision)
              : `Fee-adjusted candidate detected: ${formatRoute(best.route)}. ` +
                "This is not guaranteed because the closing oracle sampling differs.",
            bestRoute: routeStatus(best, false),
            samples,
            opportunities,
          });
          await input.writer.append({
            schemaVersion: 2,
            type: "arb_opportunity",
            sessionId: input.sessionId,
            opportunitySequence,
            detectedAt: iso(atMs),
            duration: input.pair.duration,
            classification: "CROSS_VENUE_THRESHOLD_DOMINANCE_WITH_ORACLE_BASIS",
            guaranteed: false,
            pair: pairIdentityLog(input.pair),
            references: referencesLog(
              input.references[0],
              input.references[1],
              referenceDifferenceMicroUsd(input.references[0].priceMicroUsd, input.references[1].priceMicroUsd),
            ),
            route: evaluatedRouteLog(best),
            strategyDecision: liveDecision ? liveDecisionSummaryLog(liveDecision) : null,
            strategyEntryEligible: liveDecision?.type === "entry",
            strategyMinimums: input.liveTrader ? {
              edgeUsdPerContract: formatUsd(input.configuration.minimumEntryEdgeMicroUsdPerContract),
              profitUsd: formatUsd(input.configuration.minimumEntryEdgeTotalMicroUsd),
            } : null,
            jupiterSnapshotAgeMs,
            warnings: [
              ...BASIS_WARNINGS,
              "REQUOTE_BOTH_LEGS_BEFORE_ANY_EXECUTION",
              ...(jupiterPriceWebsocket
                ? ["JUPITER_PUBLIC_DEGEN_PRICE_WEBSOCKET_REQUIRES_ATOMIC_ORDER_PREFLIGHT"]
                : []),
            ],
          });
          const belowStrategyMinimum = liveDecision?.type === "skip" &&
            liveDecision.reason === "ENTRY_EDGE_BELOW_MINIMUM";
          console.log(
            `[${input.pair.duration}] ${belowStrategyMinimum ? "FEE_POSITIVE_SIGNAL" : "ARB_CANDIDATE"} ` +
            `${formatRoute(best.route)} ` +
            `effectiveAllIn=$${formatUsd(best.effectiveAllInMicroUsdPerContract)}/contract ` +
            `nominalEdgeTotal=$${formatUsd(best.nominalEdgeTotalMicroUsd)} ` +
            `topSize=${formatContracts(best.commonTopContractsMicro)} ` +
            `fullCommonDepth=${formatContracts(best.commonDepthContractsMicro)} ` +
            (belowStrategyMinimum
              ? `not traded: below $${formatUsd(input.configuration.minimumEntryEdgeTotalMicroUsd)} total / ` +
                `$${formatUsd(input.configuration.minimumEntryEdgeMicroUsdPerContract)} per-contract minimum`
              : `decision=${liveDecision?.type ?? "monitor_only"}`) +
            ` (oracle basis risk)`,
          );
        }
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    input.signal.removeEventListener("abort", onParentAbort);
    await Promise.allSettled([polymarketTask, jupiterTask]);
  }
  return { samples, opportunities, reason: endReason };
}

async function pollJupiterOrderBook(input: {
  client: JupiterClient;
  pair: CrossVenuePair;
  outcomes: readonly ("UP" | "DOWN")[];
  needsExitBook: () => boolean;
  fallbackGrossMicroUsd: bigint;
  intervalMs: number;
  signal: AbortSignal;
  queue: AsyncEventQueue<PairEvent>;
}): Promise<void> {
  const priceState = new JupiterPredictionPriceBookState({
    upMarketId: input.pair.jupiterUp.marketId,
    downMarketId: input.pair.jupiterDown.marketId,
    outcomes: input.outcomes,
    grossAmountMicroUsd: input.fallbackGrossMicroUsd,
  });
  const sourceState: { value: JupiterBookSource | null } = { value: null };
  let consecutiveStreamErrors = 0;
  let consecutiveExitErrors = 0;
  const streamTask = streamJupiterPredictionPrices(priceState.marketIds(), {
    signal: input.signal,
    onPrice: (update) => {
      if (input.needsExitBook()) return;
      const book = priceState.apply(update);
      if (!book) return;
      consecutiveStreamErrors = 0;
      input.queue.push({
        type: "jupiter_book",
        book,
        source: "price_websocket",
        notice: sourceState.value === "price_websocket"
          ? null
          : `Jupiter entry discovery is using its public Degen price WebSocket. ` +
            `Authenticated exact order builds are reserved for qualified entry preflight and execution.`,
      });
      sourceState.value = "price_websocket";
    },
    onStatus: (status) => reportJupiterPriceStreamStatus(status),
  });
  const exitPollTask = (async (): Promise<void> => {
    while (!input.signal.aborted) {
      if (!input.needsExitBook()) {
        await waitForAbort(Math.min(250, input.intervalMs), input.signal);
        continue;
      }
      let nextPollDelayMs = input.intervalMs;
      try {
        const orderBook = await buildJupiterForecastOrderBook({
          gateway: input.client,
          upMarketId: input.pair.jupiterUp.marketId,
          downMarketId: input.pair.jupiterDown.marketId,
          outcomes: input.outcomes,
        });
        consecutiveExitErrors = 0;
        input.queue.push({
          type: "jupiter_book",
          book: orderBook,
          source: "orderbook",
          notice: sourceState.value === "price_websocket"
            ? "Open position detected; Jupiter REST bids are now used for exit screening. Any exit still requires a fresh atomic close build."
            : null,
        });
        sourceState.value = "orderbook";
      } catch (error) {
        consecutiveExitErrors += 1;
        nextPollDelayMs = jupiterRetryDelayMs(input.intervalMs, consecutiveExitErrors);
        input.queue.push({
          type: "jupiter_error",
          message: `Jupiter exit orderbook failed: ${errorMessage(error)}`,
          consecutiveErrors: consecutiveExitErrors,
          retryInMs: nextPollDelayMs,
        });
      }
      await waitForAbort(nextPollDelayMs, input.signal);
    }
  })();

  await Promise.all([streamTask, exitPollTask]);

  function reportJupiterPriceStreamStatus(status: JupiterPredictionPriceStreamStatus): void {
    if (status.status === "connected") {
      consecutiveStreamErrors = 0;
      return;
    }
    if (status.status !== "disconnected") return;
    consecutiveStreamErrors += 1;
    input.queue.push({
      type: "jupiter_error",
      message: `Jupiter Degen price WebSocket disconnected: ${status.message ?? "unknown error"}`,
      consecutiveErrors: consecutiveStreamErrors,
      retryInMs: status.retryInMs ?? jupiterRetryDelayMs(input.intervalMs, consecutiveStreamErrors),
    });
  }
}

function jupiterRetryDelayMs(baseIntervalMs: number, consecutiveErrors: number): number {
  const exponent = Math.min(Math.max(1, consecutiveErrors), 4);
  return Math.min(30_000, baseIntervalMs * (2 ** exponent));
}

async function runPaperSettlementLoop(input: {
  trader: ShortWindowPaperTrader;
  polymarketClient: PolymarketClient;
  jupiterClient: JupiterClient;
  writer: JsonlWriter;
  sessionId: string;
  statusStore: ShortWindowStatusStore;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    for (const position of input.trader.awaitingResolution()) {
      if (input.signal.aborted) break;
      try {
        const [polymarketResult, jupiterWon] = await Promise.all([
          input.polymarketClient.getResolvedOutcomeBySlug(position.pair.polymarketSlug),
          input.jupiterClient.didSelectedMarketWin(position.pair.jupiterSelectedMarketId),
        ]);
        if (polymarketResult === null || jupiterWon === null) continue;
        const settlement = input.trader.settle(
          position.pair.key,
          polymarketResult === position.polymarketOutcome,
          jupiterWon,
        );
        if (!settlement) continue;
        updatePaperStrategyStatus(input.statusStore, input.trader);
        await input.writer.append({
          schemaVersion: 2,
          type: "paper_settlement",
          sessionId: input.sessionId,
          at: iso(Date.now()),
          position: paperPositionLog(settlement.position),
          polymarketWon: settlement.polymarketWon,
          jupiterWon: settlement.jupiterWon,
          polymarketPayoutUsd: formatUsd(settlement.polymarketPayoutMicroUsd),
          jupiterPayoutUsd: formatUsd(settlement.jupiterPayoutMicroUsd),
          totalPayoutUsd: formatUsd(settlement.totalPayoutMicroUsd),
          realizedProfitUsd: formatUsd(settlement.realizedProfitMicroUsd),
          portfolio: input.trader.snapshot(),
          guaranteed: false,
          warnings: BASIS_WARNINGS,
        });
        console.log(
          `[${position.pair.duration}] PAPER SETTLEMENT ${position.id} ` +
          `profit=$${formatUsd(settlement.realizedProfitMicroUsd)} ` +
          `Poly=${settlement.polymarketWon ? "WIN" : "LOSE"} Jup=${settlement.jupiterWon ? "WIN" : "LOSE"}`,
        );
      } catch {
        // Resolution APIs can lag the scheduled close; retry without changing balances.
      }
    }
    updatePaperStrategyStatus(input.statusStore, input.trader);
    await waitForAbort(10_000, input.signal);
  }
}

async function runLiveSettlementLoop(input: {
  trader: ShortWindowLiveTrader;
  polymarketClient: PolymarketClient;
  jupiterClient: JupiterClient;
  writer: JsonlWriter;
  sessionId: string;
  statusStore: ShortWindowStatusStore;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    for (const pairKey of input.trader.expiredPairKeys()) {
      await input.trader.markPairEnded(pairKey);
    }
    for (const position of input.trader.awaitingResolution()) {
      if (input.signal.aborted) break;
      try {
        const needsPolymarketResolution = position.polymarketContractsMicro > LIVE_CONTRACT_TOLERANCE_MICRO;
        const needsJupiterResolution = position.jupiterContractsMicro > LIVE_CONTRACT_TOLERANCE_MICRO;
        const [polymarketResult, jupiterWon] = await Promise.all([
          needsPolymarketResolution
            ? input.polymarketClient.getResolvedOutcomeByMarketId(position.pair.polymarketMarketId)
            : Promise.resolve(null),
          needsJupiterResolution
            ? input.jupiterClient.didSelectedMarketWin(position.pair.jupiterMarketId)
            : Promise.resolve(null),
        ]);
        if ((needsPolymarketResolution && polymarketResult === null) ||
          (needsJupiterResolution && jupiterWon === null)) continue;
        const selectedJupiterWon = !needsJupiterResolution
          ? false
          : position.pair.jupiterOutcomeMint
            ? jupiterWon === true
            : jupiterWon === (position.pair.jupiterOutcome === "UP");
        const settlement = await input.trader.settleAwaiting(
          position.pair.key,
          needsPolymarketResolution && polymarketResult === position.pair.polymarketOutcome,
          selectedJupiterWon,
        );
        if (!settlement) continue;
        updateLiveStrategyStatus(input.statusStore, input.trader);
        await input.writer.append({
          schemaVersion: 2,
          type: "live_settlement",
          sessionId: input.sessionId,
          at: iso(Date.now()),
          positionId: settlement.positionId,
          polymarketWon: settlement.polymarketWon,
          jupiterWon: settlement.jupiterWon,
          polymarketPayoutUsd: formatUsd(settlement.polymarketPayoutMicroUsd),
          jupiterPayoutUsd: formatUsd(settlement.jupiterPayoutMicroUsd),
          realizedProfitUsd: formatUsd(settlement.realizedProfitMicroUsd),
          portfolio: input.trader.snapshot(),
          guaranteed: false,
          warnings: BASIS_WARNINGS,
        });
        console.warn(
          `[${position.pair.duration}] LIVE SETTLEMENT ${settlement.positionId} ` +
          `profit=$${formatUsd(settlement.realizedProfitMicroUsd)} ` +
          `Poly=${settlement.polymarketWon ? "WIN" : "LOSE"} Jup=${settlement.jupiterWon ? "WIN" : "LOSE"}`,
        );
      } catch {
        // Venue resolution and claim APIs can lag. Persisted per-leg flags make retries idempotent.
      }
    }
    updateLiveStrategyStatus(input.statusStore, input.trader);
    await waitForAbort(10_000, input.signal);
  }
}

async function runLiveWalletBalanceLoop(input: {
  polymarket: PolymarketLiveExecutor;
  jupiter: JupiterForecastSwapExecutor;
  trader: ShortWindowLiveTrader;
  writer: JsonlWriter;
  sessionId: string;
  statusStore: ShortWindowStatusStore;
  signal: AbortSignal;
}): Promise<void> {
  let lastPrintedBalances: string | null = null;
  let lastPrintedError: string | null = null;
  let lastLoggedBalances: string | null = null;
  let lastBalanceLogAtMs = 0;
  while (!input.signal.aborted) {
    const observedAtMs = Date.now();
    try {
      const [polymarketCollateralMicroUsd, jupiterBalances] = await Promise.all([
        input.polymarket.fetchCollateralBalance(),
        input.jupiter.fetchWalletBalances(),
      ]);
      const polymarketCollateralUsd = formatUsd(polymarketCollateralMicroUsd);
      const jupiterUsdcUsd = formatUsd(jupiterBalances.usdcMicro);
      const jupiterSol = formatSolLamports(jupiterBalances.solLamports);
      input.statusStore.updateWalletBalances({
        polymarketCollateralUsd,
        jupiterUsdcUsd,
        jupiterSol,
        observedAt: iso(observedAtMs),
        error: null,
      });
      input.trader.updateWalletBalances(polymarketCollateralMicroUsd, jupiterBalances.usdcMicro);
      updateLiveStrategyStatus(input.statusStore, input.trader);
      const recoveries = await input.trader.attemptAutomaticRecovery();
      for (const recovery of recoveries) {
        await appendLiveRecovery(input.writer, input.sessionId, recovery);
      }
      if (recoveries.length > 0) updateLiveStrategyStatus(input.statusStore, input.trader);
      const signature = `${polymarketCollateralUsd}|${jupiterUsdcUsd}|${jupiterSol}`;
      if (signature !== lastLoggedBalances || observedAtMs - lastBalanceLogAtMs >= LIVE_BALANCE_LOG_HEARTBEAT_MS) {
        await input.writer.append({
          schemaVersion: 2,
          type: "live_wallet_balance",
          sessionId: input.sessionId,
          at: iso(observedAtMs),
          polymarketCollateralUsd,
          jupiterUsdcUsd,
          jupiterSol,
        });
        lastLoggedBalances = signature;
        lastBalanceLogAtMs = observedAtMs;
      }
      if (signature !== lastPrintedBalances) {
        console.log(
          `[balances] Polymarket collateral $${polymarketCollateralUsd} | ` +
          `Jupiter USDC $${jupiterUsdcUsd} | SOL ${jupiterSol}`,
        );
        lastPrintedBalances = signature;
      }
      lastPrintedError = null;
    } catch (error) {
      const message = errorMessage(error);
      input.statusStore.updateWalletBalances({ error: message });
      if (message !== lastPrintedError) {
        console.warn(`[balances] refresh failed: ${message}`);
        await input.writer.append({
          schemaVersion: 2,
          type: "live_wallet_balance_error",
          sessionId: input.sessionId,
          at: iso(observedAtMs),
          message,
        });
        lastPrintedError = message;
      }
    }
    await waitForAbort(LIVE_BALANCE_REFRESH_MS, input.signal);
  }
}

async function loadCrossVenuePair(input: {
  duration: Duration;
  startMs: number;
  endMs: number;
  polymarketClient: PolymarketClient;
  forecastCache: ForecastMarketCache;
}): Promise<CrossVenuePair> {
  const polymarketSlug = `btc-updown-${input.duration}-${Math.floor(input.startMs / 1_000)}`;
  const [polymarketMarkets, forecastMarkets] = await Promise.all([
    input.polymarketClient.getEventMarketsBySlug(polymarketSlug),
    input.forecastCache.getActive(),
  ]);
  const polymarket = requirePolymarketMarket(polymarketMarkets, input.duration, input.endMs);
  const jupiterCandidates = forecastMarkets.filter((market) =>
    market.provider === "bisonfi" &&
    market.openTimeMs === input.startMs &&
    market.closeTimeMs === input.endMs &&
    market.eventTitle.toLowerCase().includes(`(${input.duration})`)
  );
  const jupiterUp = requireJupiterSide(jupiterCandidates, "up", input.duration);
  const jupiterDown = requireJupiterSide(jupiterCandidates, "down", input.duration);
  if (!jupiterUp.eventId || jupiterUp.eventId !== jupiterDown.eventId) {
    throw new Error(`${input.duration} Jupiter Forecast sides do not share one event ID`);
  }
  if (jupiterUp.rulesPrimary !== jupiterDown.rulesPrimary || jupiterUp.rulesSecondary !== jupiterDown.rulesSecondary) {
    throw new Error(`${input.duration} Jupiter Forecast Up and Down rules differ`);
  }
  return {
    duration: input.duration,
    startMs: input.startMs,
    endMs: input.endMs,
    polymarketSlug,
    polymarket,
    jupiterEventId: jupiterUp.eventId,
    jupiterUp,
    jupiterDown,
  };
}

function requirePolymarketMarket(markets: readonly VenueMarket[], duration: Duration, endMs: number): VenueMarket {
  if (markets.length !== 1 || !markets[0]) throw new Error(`${duration} Polymarket event did not resolve exactly one market`);
  const market = markets[0];
  const outcomes = market.outcomes.map((outcome) => outcome.toLowerCase());
  if (market.status !== "open") throw new Error(`${duration} Polymarket status is ${market.status}`);
  if (market.closeTimeMs !== endMs) throw new Error(`${duration} Polymarket close time differs from ${iso(endMs)}`);
  if (outcomes[0] !== "up" || outcomes[1] !== "down") throw new Error(`${duration} Polymarket outcomes are not Up/Down`);
  if (market.clobTokenIds.length !== 2) throw new Error(`${duration} Polymarket market has no two-token CLOB book`);
  const rules = `${market.rulesPrimary}\n${market.rulesSecondary}`;
  if (!/chainlink/i.test(rules) || !/twap/i.test(rules) || !/btc\/usd/i.test(rules) || !/60s/i.test(rules)) {
    throw new Error(`${duration} Polymarket market does not use BTC/USD Chainlink TWAP 60s`);
  }
  if (!market.feeSchedule || parseFixed(market.feeSchedule.rate, 6, "reject") !== 70_000n ||
    market.feeSchedule.exponent !== 1 || market.feeSchedule.takerOnly !== true) {
    throw new Error(`${duration} Polymarket market does not expose the expected 0.07 taker-only fee schedule`);
  }
  return market;
}

function requireJupiterSide(markets: readonly VenueMarket[], side: "up" | "down", duration: Duration): VenueMarket {
  const matches = markets.filter((market) => market.title.trim().toLowerCase() === side);
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`${duration} Jupiter Forecast resolved ${matches.length} ${side.toUpperCase()} sides; expected one`);
  }
  const market = matches[0];
  if (market.status !== "open") throw new Error(`${duration} Jupiter ${side.toUpperCase()} status is ${market.status}`);
  if (!/^BISON-/.test(market.marketId)) throw new Error(`${duration} Jupiter ${side.toUpperCase()} is not a native Forecast market`);
  if (!/chainlink/i.test(market.rulesPrimary) || !/btc\/usd/i.test(market.rulesPrimary)) {
    throw new Error(`${duration} Jupiter ${side.toUpperCase()} does not use BTC/USD Chainlink`);
  }
  return market;
}

async function waitForReferences(input: {
  pair: CrossVenuePair;
  twapAnchors: ExactTwapAnchorStore;
  spotAnchors: ExactChainlinkSpotStore;
  http: HttpClient;
  signal: AbortSignal;
  retryMs: number;
  onProgress: (progress: {
    polymarket: ReferencePrice | null;
    jupiter: ReferencePrice | null;
    message: string;
  }) => void;
}): Promise<readonly [ReferencePrice, ReferencePrice] | null> {
  let polymarketApiReference: ReferencePrice | null = null;
  let jupiterApiReference: ReferencePrice | null = null;
  let nextApiAttemptMs = 0;
  let lastMessageAtMs = 0;
  while (!input.signal.aborted && Date.now() < input.pair.endMs) {
    if ((!polymarketApiReference || !jupiterApiReference) && Date.now() >= nextApiAttemptMs) {
      const attempts: [Promise<ReferencePrice | null>, Promise<ReferencePrice | null>] = [
        polymarketApiReference
          ? Promise.resolve(polymarketApiReference)
          : fetchPolymarketOpeningReference({
            http: input.http,
            duration: input.pair.duration,
            startMs: input.pair.startMs,
            endMs: input.pair.endMs,
          }).catch(() => null),
        jupiterApiReference
          ? Promise.resolve(jupiterApiReference)
          : fetchJupiterForecastOpeningReference({
            http: input.http,
            eventId: input.pair.jupiterEventId,
            startMs: input.pair.startMs,
          }).catch(() => null),
      ];
      const [polymarketAttempt, jupiterAttempt] = await Promise.all(attempts);
      polymarketApiReference = polymarketAttempt;
      jupiterApiReference = jupiterAttempt;
      nextApiAttemptMs = Date.now() + 10_000;
    }
    const polymarketReference = polymarketApiReference ?? twapReference(input.twapAnchors.getExact(input.pair.startMs));
    const jupiterReference = spotReference(input.spotAnchors.getExact(input.pair.startMs)) ?? jupiterApiReference;
    if (polymarketReference && jupiterReference) return [polymarketReference, jupiterReference];
    const startedMidRound = Date.now() > input.pair.startMs + 2_500;
    const message = startedMidRound
      ? `Started after the ${formatUtcTime(input.pair.startMs)} opening boundary; querying exact website references. ` +
      `Current references: Polymarket=${polymarketReference ? "ready" : "missing"}, ` +
      `Jupiter=${jupiterReference ? "ready" : "missing"}.`
      : `Waiting for exact ${formatUtcTime(input.pair.startMs)} opening observations: ` +
      `Polymarket=${polymarketReference ? "ready" : "missing"}, Jupiter=${jupiterReference ? "ready" : "missing"}.`;
    input.onProgress({ polymarket: polymarketReference, jupiter: jupiterReference, message });
    if (Date.now() - lastMessageAtMs >= 15_000) {
      console.log(`[${input.pair.duration}] ${message}`);
      lastMessageAtMs = Date.now();
    }
    await waitUntil(Math.min(input.pair.endMs, Date.now() + input.retryMs), input.signal);
  }
  return null;
}

function twapReference(observation: ChainlinkTwapObservation | null): ReferencePrice | null {
  if (!observation) return null;
  return {
    priceMicroUsd: observation.priceMicroUsd,
    source: "polymarket_rtds_exact_twap_60s",
    boundaryMs: observation.observedAtMs,
    observedAtMs: observation.observedAtMs,
    receivedAtMs: observation.receivedAtMs,
  };
}

function spotReference(observation: ChainlinkSpotObservation | null): ReferencePrice | null {
  if (!observation) return null;
  return {
    priceMicroUsd: observation.priceMicroUsd,
    source: "jupiter_chainlink_rtds_exact_spot",
    boundaryMs: observation.observedAtMs,
    observedAtMs: observation.observedAtMs,
    receivedAtMs: observation.receivedAtMs,
  };
}

class ForecastMarketCache {
  readonly #client: JupiterClient;
  #cachedAtMs = 0;
  #markets: VenueMarket[] = [];
  #inflight: Promise<VenueMarket[]> | null = null;

  constructor(client: JupiterClient) {
    this.#client = client;
  }

  async getActive(): Promise<VenueMarket[]> {
    if (Date.now() - this.#cachedAtMs < 1_000 && this.#markets.length > 0) return this.#markets;
    if (this.#inflight) return await this.#inflight;
    this.#inflight = this.#client.getMarkets({
      provider: "bisonfi",
      category: "crypto",
      subcategory: "btc",
      filter: "live",
      sortBy: "beginAt",
      sortDirection: "desc",
      maxEvents: 20,
      pageSize: 20,
    });
    try {
      this.#markets = await this.#inflight;
      this.#cachedAtMs = Date.now();
      return this.#markets;
    } catch (error) {
      if (this.#markets.length > 0) return this.#markets;
      throw error;
    } finally {
      this.#inflight = null;
    }
  }
}

class DailyThresholdMarketCache {
  readonly #client: JupiterClient;
  readonly #ttlMs: number;
  #cachedAtMs = 0;
  #markets: VenueMarket[] = [];
  #inflight: Promise<VenueMarket[]> | null = null;

  constructor(client: JupiterClient, ttlMs: number) {
    this.#client = client;
    this.#ttlMs = ttlMs;
  }

  async getActive(force = false): Promise<VenueMarket[]> {
    if (!force && Date.now() - this.#cachedAtMs < this.#ttlMs && this.#markets.length > 0) return this.#markets;
    if (this.#inflight) return await this.#inflight;
    this.#inflight = this.#client.getMarkets({
      provider: "polymarket",
      category: "crypto",
      subcategory: "btc",
      sortBy: "beginAt",
      sortDirection: "desc",
      maxEvents: 100,
      pageSize: 100,
    });
    try {
      this.#markets = await this.#inflight;
      this.#cachedAtMs = Date.now();
      return this.#markets;
    } catch (error) {
      if (this.#markets.length > 0) return this.#markets;
      throw error;
    } finally {
      this.#inflight = null;
    }
  }
}

function dailyThresholdPairLog(pair: DailyThresholdPair): object {
  return {
    asset: "BTC",
    type: "daily_above_strike",
    key: pair.key,
    closesAt: iso(pair.closeMs),
    thresholdMicroUsd: pair.thresholdMicroUsd,
    thresholdUsd: formatUsd(pair.thresholdMicroUsd),
    polymarket: {
      slug: pair.polymarketSlug,
      eventId: pair.polymarket.eventId,
      marketId: pair.polymarket.marketId,
      clobTokenIds: pair.polymarket.clobTokenIds,
      feeSchedule: pair.polymarket.feeSchedule ?? null,
    },
    jupiter: {
      provider: pair.jupiter.provider,
      eventId: pair.jupiter.eventId,
      marketId: pair.jupiter.marketId,
    },
    sharedLiquidity: true,
  };
}

function dailyThresholdPairIdentityLog(pair: DailyThresholdPair): object {
  return {
    key: pair.key,
    closesAt: iso(pair.closeMs),
    thresholdUsd: formatUsd(pair.thresholdMicroUsd),
    polymarketMarketId: pair.polymarket.marketId,
    jupiterMarketId: pair.jupiter.marketId,
  };
}

function pairLog(pair: CrossVenuePair): object {
  return {
    asset: "BTC",
    duration: pair.duration,
    start: iso(pair.startMs),
    end: iso(pair.endMs),
    polymarket: {
      slug: pair.polymarketSlug,
      eventId: pair.polymarket.eventId,
      marketId: pair.polymarket.marketId,
      outcomes: pair.polymarket.outcomes,
      clobTokenIds: pair.polymarket.clobTokenIds,
      resolutionSource: pair.polymarket.rulesSecondary,
      feeSchedule: pair.polymarket.feeSchedule ?? null,
    },
    jupiter: {
      provider: "bisonfi",
      eventId: pair.jupiterEventId,
      upMarketId: pair.jupiterUp.marketId,
      downMarketId: pair.jupiterDown.marketId,
      rulesPrimary: pair.jupiterUp.rulesPrimary,
    },
  };
}

function pairIdentityLog(pair: CrossVenuePair): object {
  return {
    asset: "BTC",
    duration: pair.duration,
    start: iso(pair.startMs),
    end: iso(pair.endMs),
    polymarketSlug: pair.polymarketSlug,
    polymarketMarketId: pair.polymarket.marketId,
    jupiterEventId: pair.jupiterEventId,
    jupiterUpMarketId: pair.jupiterUp.marketId,
    jupiterDownMarketId: pair.jupiterDown.marketId,
  };
}

function pairKey(pair: CrossVenuePair): string {
  return `${pair.duration}:${pair.startMs}`;
}

function paperPairIdentity(pair: CrossVenuePair, jupiterOutcome: "UP" | "DOWN"): PaperPairIdentity {
  return {
    key: pairKey(pair),
    duration: pair.duration,
    startMs: pair.startMs,
    endMs: pair.endMs,
    polymarketSlug: pair.polymarketSlug,
    polymarketMarketId: pair.polymarket.marketId,
    jupiterSelectedMarketId: jupiterOutcome === "UP" ? pair.jupiterUp.marketId : pair.jupiterDown.marketId,
  };
}

function livePairIdentity(pair: CrossVenuePair, route: CrossVenueShortWindowRoute): LivePairIdentity {
  const polymarketIndex = pair.polymarket.outcomes.findIndex(
    (outcome) => outcome.trim().toUpperCase() === route.polymarketOutcome,
  );
  const polymarketTokenId = pair.polymarket.clobTokenIds[polymarketIndex];
  if (polymarketIndex < 0 || !polymarketTokenId) {
    throw new Error(`No Polymarket token ID for ${route.polymarketOutcome}`);
  }
  const jupiterMarket = route.jupiterOutcome === "UP" ? pair.jupiterUp : pair.jupiterDown;
  if (!jupiterMarket.outcomeMint) throw new Error(`No Jupiter outcome mint for ${route.jupiterOutcome}`);
  return {
    key: pairKey(pair),
    duration: pair.duration,
    startMs: pair.startMs,
    endMs: pair.endMs,
    polymarketMarketId: pair.polymarket.marketId,
    polymarketSlug: pair.polymarketSlug,
    polymarketTokenId,
    polymarketOutcome: route.polymarketOutcome,
    jupiterMarketId: jupiterMarket.marketId,
    jupiterOutcomeMint: jupiterMarket.outcomeMint,
    jupiterOutcome: route.jupiterOutcome,
  };
}

function updatePaperStrategyStatus(store: ShortWindowStatusStore, trader: ShortWindowPaperTrader): void {
  store.updateStrategy(trader.snapshot());
}

function updateLiveStrategyStatus(store: ShortWindowStatusStore, trader: ShortWindowLiveTrader): void {
  const snapshot = trader.snapshot();
  store.updateStrategy({
    mode: "live",
    halted: snapshot.halted,
    haltReason: snapshot.haltReason,
    polymarketCashUsd: snapshot.polymarketCashUsd,
    jupiterCashUsd: snapshot.jupiterCashUsd,
    realizedProfitUsd: snapshot.realizedProfitUsd,
    openPositions: snapshot.openPositions,
    awaitingResolution: snapshot.awaitingResolution,
    lastAction: snapshot.lastAction,
  });
}

async function appendLiveRecovery(
  writer: JsonlWriter,
  sessionId: string,
  recovery: LiveRecoveryDiagnostics,
): Promise<void> {
  await writer.append({
    schemaVersion: 2,
    type: "live_recovery",
    sessionId,
    at: iso(recovery.recoveredAtMs),
    duration: recovery.duration,
    recovery,
  });
  const unwound = recovery.code === "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND";
  console.warn(
    `[${recovery.duration}] LIVE AUTO RECOVERY ${recovery.code}: ` +
    (unwound
      ? `${recovery.positionId} automatically sold the Polymarket-only fill.`
      : `${recovery.positionId} confirmed zero exposure on both venues; no recovery order was submitted.`),
  );
}

function liveDecisionLog(decision: LiveDecision): object {
  if (decision.type === "skip") {
    return {
      type: decision.type,
      reason: decision.reason,
      preflight: decision.preflight ?? null,
    };
  }
  if (decision.type === "hold" || decision.type === "halt") {
    return {
      type: decision.type,
      reason: decision.reason,
      positionId: decision.position?.id ?? null,
      phase: decision.position?.phase ?? null,
      entrySubmissionSkewMs: decision.position?.entrySubmissionSkewMs ?? null,
      exitSubmissionSkewMs: decision.position?.exitSubmissionSkewMs ?? null,
      preflight: decision.preflight ?? null,
      execution: decision.execution ?? null,
    };
  }
  if (decision.type === "recovery") {
    return {
      type: decision.type,
      reason: decision.reason,
      positionId: decision.positionId,
      preflight: decision.preflight ?? null,
      execution: decision.execution ?? null,
      recovery: decision.recovery ?? null,
    };
  }
  if (decision.type === "exit") {
    return {
      type: decision.type,
      positionId: decision.positionId,
      realizedProfitMicroUsd: decision.realizedProfitMicroUsd,
      realizedProfitUsd: formatUsd(decision.realizedProfitMicroUsd),
      submissionSkewMs: decision.submissionSkewMs,
    };
  }
  return {
    type: decision.type,
    positionId: decision.position.id,
    phase: decision.position.phase,
    polymarketOutcome: decision.position.pair.polymarketOutcome,
    jupiterOutcome: decision.position.pair.jupiterOutcome,
    contractsMicro: decision.position.originalContractsMicro,
    contracts: formatContracts(decision.position.originalContractsMicro),
    entryAllInMicroUsd: decision.position.remainingEntryCostMicroUsd,
    entryAllInUsd: formatUsd(decision.position.remainingEntryCostMicroUsd),
    submissionSkewMs: decision.position.entrySubmissionSkewMs,
    diagnosticTestEntry: decision.position.diagnosticTestEntry,
    jupiterOrderPubkey: decision.position.jupiterOrderPubkey,
    jupiterPositionPubkey: decision.position.jupiterPositionPubkey,
    preflight: decision.preflight ?? null,
    execution: decision.execution ?? null,
  };
}

function liveDecisionSummaryLog(decision: LiveDecision): object {
  if (decision.type === "entry") {
    return {
      type: decision.type,
      positionId: decision.position.id,
      contracts: formatContracts(decision.position.originalContractsMicro),
      entryAllInUsd: formatUsd(decision.position.remainingEntryCostMicroUsd),
    };
  }
  if (decision.type === "exit") {
    return {
      type: decision.type,
      positionId: decision.positionId,
      realizedProfitUsd: formatUsd(decision.realizedProfitMicroUsd),
    };
  }
  return {
    type: decision.type,
    reason: decision.reason,
    positionId: "position" in decision ? decision.position?.id ?? null :
      "positionId" in decision ? decision.positionId : null,
    preflightCode: decision.preflight?.code ?? null,
    recoveryCode: decision.recovery?.code ?? null,
  };
}

function paperPositionLog(position: PaperPosition): object {
  return {
    id: position.id,
    pair: {
      ...position.pair,
      start: iso(position.pair.startMs),
      end: iso(position.pair.endMs),
    },
    status: position.status,
    enteredAt: iso(position.enteredAtMs),
    polymarketOutcome: position.polymarketOutcome,
    jupiterOutcome: position.jupiterOutcome,
    quantityMicro: position.quantityMicro,
    quantity: formatContracts(position.quantityMicro),
    polymarketEntryCostUsd: formatUsd(position.polymarketEntryCostMicroUsd),
    jupiterEntryCostUsd: formatUsd(position.jupiterEntryCostMicroUsd),
    entryAllInCostUsd: formatUsd(position.entryAllInCostMicroUsd),
    nominalEntryEdgeUsd: formatUsd(position.nominalEntryEdgeMicroUsd),
  };
}

function paperDecisionLog(decision: PaperDecision): object {
  if (decision.type === "skip") return { type: decision.type, reason: decision.reason };
  if (decision.type === "hold") {
    return {
      type: decision.type,
      reason: decision.reason,
      positionId: decision.position.id,
      projectedProfitUsd: decision.projectedProfitMicroUsd === null
        ? null
        : formatUsd(decision.projectedProfitMicroUsd),
    };
  }
  if (decision.type === "entry") {
    return {
      type: decision.type,
      position: paperPositionLog(decision.position),
      polymarketAskUsd: formatUsd(decision.proposal.polymarket.priceMicroUsd),
      jupiterAskUsd: formatUsd(decision.proposal.jupiter.priceMicroUsd),
      polymarketVwapUsd: formatUsd(decision.proposal.polymarket.priceMicroUsd),
      jupiterVwapUsd: formatUsd(decision.proposal.jupiter.priceMicroUsd),
      polymarketLimitPriceUsd: formatUsd(decision.proposal.polymarket.limitPriceMicroUsd),
      jupiterLimitPriceUsd: formatUsd(decision.proposal.jupiter.limitPriceMicroUsd),
      polymarketLevelsConsumed: decision.proposal.polymarket.levelsConsumed,
      jupiterLevelsConsumed: decision.proposal.jupiter.levelsConsumed,
      polymarketTakerFeeUsd: formatUsd(decision.proposal.polymarket.takerFeeMicroUsd),
      jupiterTakerFeeUsd: formatUsd(decision.proposal.jupiter.takerFeeMicroUsd),
      nominalEdgeUsdPerContract: formatUsd(decision.proposal.edgeMicroUsdPerContract),
    };
  }
  return {
    type: decision.type,
    position: paperPositionLog(decision.position),
    polymarketBidUsd: formatUsd(decision.proposal.polymarketBid.priceMicroUsd),
    jupiterBidUsd: formatUsd(decision.proposal.jupiterBid.priceMicroUsd),
    polymarketExitTakerFeeUsd: formatUsd(decision.proposal.polymarketTakerFeeMicroUsd),
    jupiterExitTakerFeeUsd: formatUsd(decision.proposal.jupiterTakerFeeMicroUsd),
    netProceedsUsd: formatUsd(decision.proposal.netProceedsMicroUsd),
    realizedProfitUsd: formatUsd(decision.proposal.realizedProfitMicroUsd),
  };
}

function referencesLog(polymarket: ReferencePrice, jupiter: ReferencePrice, differenceMicroUsd: bigint): object {
  return {
    polymarket: referenceLog(polymarket),
    jupiter: referenceLog(jupiter),
    differenceMicroUsd,
    differenceUsd: formatUsd(differenceMicroUsd),
  };
}

function referenceLog(reference: ReferencePrice): object {
  return {
    priceMicroUsd: reference.priceMicroUsd,
    priceUsd: formatUsd(reference.priceMicroUsd),
    source: reference.source,
    boundary: iso(reference.boundaryMs),
    observedAt: iso(reference.observedAtMs),
    receivedAt: iso(reference.receivedAtMs),
  };
}

function emptyReferenceStatus(): ReferenceStatus {
  return { ready: false, priceUsd: null, source: null };
}

function referenceStatus(reference: ReferencePrice | null): ReferenceStatus {
  if (!reference) return emptyReferenceStatus();
  return {
    ready: true,
    priceUsd: formatUsd(reference.priceMicroUsd),
    source: reference.source,
  };
}

function bookLog(book: BinaryOrderBook): object {
  return {
    venue: book.venue,
    provider: book.provider,
    marketId: book.marketId,
    receivedAt: iso(book.receivedAtMs),
    sourceTimestamp: book.sourceTimestampMs === null ? null : iso(book.sourceTimestampMs),
    upBestAsk: levelLog(book.yes.asks[0] ?? null),
    downBestAsk: levelLog(book.no.asks[0] ?? null),
  };
}

function bookStatus(book: BinaryOrderBook, atMs: number, stale: boolean): BookStatus {
  return {
    up: bestAskStatus(book.yes.asks[0], book.receivedAtMs),
    down: bestAskStatus(book.no.asks[0], book.receivedAtMs),
    receivedAt: iso(book.receivedAtMs),
    ageMs: Math.max(0, atMs - book.receivedAtMs),
    stale,
  };
}

function bestAskStatus(
  level: BinaryOrderBook["yes"]["asks"][number] | undefined,
  receivedAtMs: number,
): BestAskStatus | null {
  if (!level) return null;
  return {
    priceUsd: formatUsd(level.priceMicroUsd),
    contracts: formatContracts(level.contractsMicro),
    receivedAt: iso(receivedAtMs),
  };
}

function levelLog(level: BinaryOrderBook["yes"]["asks"][number] | null): object | null {
  if (!level) return null;
  return {
    priceMicroUsd: level.priceMicroUsd,
    priceUsd: formatUsd(level.priceMicroUsd),
    contractsMicro: level.contractsMicro,
    contracts: formatContracts(level.contractsMicro),
    takerFeeIncluded: level.takerFeeIncluded === true,
  };
}

function evaluatedRouteLog(value: EvaluatedCrossVenueRoute): object {
  return {
    polymarketOutcome: value.route.polymarketOutcome,
    jupiterOutcome: value.route.jupiterOutcome,
    selectionReason: value.route.reason,
    polymarketAsk: levelLog(value.polymarketAsk),
    jupiterAsk: levelLog(value.jupiterAsk),
    commonTopContractsMicro: value.commonTopContractsMicro,
    commonTopContracts: formatContracts(value.commonTopContractsMicro),
    commonDepthContractsMicro: value.commonDepthContractsMicro,
    commonDepthContracts: formatContracts(value.commonDepthContractsMicro),
    grossCostTotalMicroUsd: value.grossCostTotalMicroUsd,
    grossCostTotalUsd: formatUsd(value.grossCostTotalMicroUsd),
    polymarketTakerFeeTotalMicroUsd: value.polymarketTakerFeeTotalMicroUsd,
    polymarketTakerFeeTotalUsd: formatUsd(value.polymarketTakerFeeTotalMicroUsd),
    jupiterTakerFeeTotalMicroUsd: value.jupiterTakerFeeTotalMicroUsd,
    jupiterTakerFeeTotalUsd: formatUsd(value.jupiterTakerFeeTotalMicroUsd),
    takerFeeTotalMicroUsd: value.takerFeeTotalMicroUsd,
    takerFeeTotalUsd: formatUsd(value.takerFeeTotalMicroUsd),
    allInCostTotalMicroUsd: value.allInCostTotalMicroUsd,
    allInCostTotalUsd: formatUsd(value.allInCostTotalMicroUsd),
    nominalComplementaryPayoutTotalMicroUsd: value.nominalComplementaryPayoutTotalMicroUsd,
    nominalComplementaryPayoutTotalUsd: formatUsd(value.nominalComplementaryPayoutTotalMicroUsd),
    nominalEdgeTotalMicroUsd: value.nominalEdgeTotalMicroUsd,
    nominalEdgeTotalUsd: formatUsd(value.nominalEdgeTotalMicroUsd),
    effectiveAllInMicroUsdPerContract: value.effectiveAllInMicroUsdPerContract,
    effectiveAllInUsdPerContract: formatUsd(value.effectiveAllInMicroUsdPerContract),
    effectiveEdgeMicroUsdPerContract: value.effectiveEdgeMicroUsdPerContract,
    effectiveEdgeUsdPerContract: formatUsd(value.effectiveEdgeMicroUsdPerContract),
    feeAdjustedCandidate: value.isFeeAdjustedCandidate,
    guaranteed: false,
  };
}

function routeStatus(value: EvaluatedCrossVenueRoute, stale: boolean): RouteStatus {
  return {
    label: formatRoute(value.route),
    allInUsdPerContract: formatUsd(value.effectiveAllInMicroUsdPerContract),
    edgeUsdPerContract: formatUsd(value.effectiveEdgeMicroUsdPerContract),
    commonContracts: formatContracts(value.commonTopContractsMicro),
    feeAdjustedCandidate: value.isFeeAdjustedCandidate,
    stale,
  };
}

function liveCandidateStatusMessage(
  route: EvaluatedCrossVenueRoute,
  decision: LiveDecision | null,
): string {
  const label = formatRoute(route.route);
  if (!decision) return `Fresh fee-adjusted candidate detected: ${label}. Awaiting a live-trader decision.`;
  if (decision.type === "entry") {
    return `LIVE ENTRY completed for ${label}: ${formatContracts(decision.position.originalContractsMicro)} contracts.`;
  }
  if (decision.type === "exit") {
    return `LIVE EXIT completed while ${label} was visible: realized $${formatUsd(decision.realizedProfitMicroUsd)}.`;
  }
  if (decision.type === "recovery") {
    return `LIVE AUTO RECOVERY completed for ${label}: zero exposure confirmed; no recovery trade was submitted.`;
  }
  if (decision.type === "halt") return `Candidate halted live trading: ${decision.reason}.`;
  return `Fresh candidate not executed: ${decision.reason}.`;
}

function printSample(
  sequence: number,
  atMs: number,
  duration: Duration,
  polymarket: BinaryOrderBook,
  jupiter: BinaryOrderBook,
  best: EvaluatedCrossVenueRoute | null,
  jupiterAgeMs: number,
): void {
  console.log(
    `[${duration}] #${sequence} ${iso(atMs)} ` +
    `Poly[U ${displayLevel(polymarket.yes.asks[0])} | D ${displayLevel(polymarket.no.asks[0])}] ` +
    `Jup[U ${displayLevel(jupiter.yes.asks[0])} | D ${displayLevel(jupiter.no.asks[0])}] ` +
    (best
      ? `ROUTE[${formatRoute(best.route)}] allIn=${formatUsd(best.effectiveAllInMicroUsdPerContract)} ` +
      `edge=${formatUsd(best.effectiveEdgeMicroUsdPerContract)}/contract`
      : "ROUTE[missing ask depth]") +
    ` jupAge=${jupiterAgeMs}ms`,
  );
}

function displayLevel(level: BinaryOrderBook["yes"]["asks"][number] | undefined): string {
  return level ? `${formatUsd(level.priceMicroUsd)} x ${formatContracts(level.contractsMicro)}` : "missing";
}

function formatRoute(route: { polymarketOutcome: string; jupiterOutcome: string }): string {
  return `BUY Poly ${route.polymarketOutcome} + Jup ${route.jupiterOutcome}`;
}

function opportunitySignature(value: EvaluatedCrossVenueRoute): string {
  return [
    value.route.polymarketOutcome,
    value.route.jupiterOutcome,
    value.polymarketAsk.priceMicroUsd,
    value.polymarketAsk.contractsMicro,
    value.jupiterAsk.priceMicroUsd,
    value.jupiterAsk.contractsMicro,
  ].join("|");
}

function pairErrorRecord(
  sessionId: string,
  duration: Duration,
  startMs: number,
  endMs: number,
  stage: string,
  error: unknown,
): object {
  return {
    schemaVersion: 2,
    type: "pair_error",
    sessionId,
    at: iso(Date.now()),
    duration,
    start: iso(startMs),
    end: iso(endMs),
    stage,
    message: errorMessage(error),
  };
}

function parseOptionalTimestamp(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric !== null && Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const text = asString(value);
  const parsed = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function printReferenceStatus(
  label: string,
  status: { status: "connecting" | "connected" | "disconnected" | "reconnecting"; message?: string },
): void {
  if (status.status === "connected") console.log(`${label} RTDS connected`);
  if (status.status === "disconnected") console.warn(`${label} RTDS disconnected: ${status.message ?? "unknown error"}`);
}

class AsyncEventQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }

  async next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return item;
    return await new Promise<T>((resolveNext) => this.#waiters.push(resolveNext));
  }
}

class JsonlWriter {
  readonly #path: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async append(value: unknown): Promise<void> {
    const line = `${stringifyJson(value, false)}\n`;
    const write = this.#pending.then(async () => {
      await appendFile(this.#path, line, "utf8");
    });
    this.#pending = write.catch(() => undefined);
    await write;
  }

  async flush(): Promise<void> {
    await this.#pending;
  }
}

async function waitUntil(timestampMs: number, signal: AbortSignal): Promise<void> {
  await waitForAbort(Math.max(0, timestampMs - Date.now()), signal);
}

async function waitForAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0 || signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveWait();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function formatSolLamports(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatUtcTime(timestampMs: number): string {
  return `${iso(timestampMs).slice(11, 19)} UTC`;
}

function isoSeconds(timestampMs: number): string {
  return iso(timestampMs).replace(".000Z", "Z");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareBigints(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Live trading requires environment variable ${name}`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm monitor:short-window
  pnpm monitor:short-window -- --once
  pnpm monitor:short-window -- --max-opportunities=1
  pnpm bot:short-window
  pnpm bot:short-window:live
  pnpm bot:short-window:any-route

Behavior:
  - Pairs Polymarket 5m with native Jupiter Forecast 5m.
  - Separately pairs Polymarket 15m with native Jupiter Forecast 15m.
  - Discovers upcoming “Bitcoin above ___ on <date>?” POLY-* ladders, verifies exact rules/tokens,
    and evaluates the best complementary YES/NO route across all qualifying dates and strikes.
  - Requires identical start/end times and a strict opening-reference difference below $30 by default.
  - --any-complementary-route evaluates both complementary directions and selects the best qualifying net edge.
  - Streams Polymarket books and Jupiter's public Degen top-of-book prices.
  - Reserves authenticated exact Jupiter builds for qualified live-entry preflight/execution.
  - Uses Prediction API at $5+ and direct Forecast outcome-token Swap V2 below $5.
  - Includes Polymarket and Jupiter taker-fee estimates before logging arb_opportunity records.
  - Marks every record as non-guaranteed because the closing oracle sampling differs.
  - Monitor mode is read-only. The bot command uses --live-trade and can submit irreversible real-money orders.
  - Live mode requires wallet credentials plus the exact ${LIVE_CONFIRMATION} confirmation phrase.
  - --live-test-entry deliberately permits one unprofitable real entry and requires a second confirmation phrase.

Options:
  --max-reference-difference-usd=30 Strict reference-price difference limit
  --any-complementary-route          Ignore reference direction and rank both complementary routes
  --reference-retry-ms=2000         Exact-reference retry interval
  --reference-api-timeout-ms=2000   Polymarket price-to-beat API timeout
  --sample-interval-ms=100           Minimum interval between WebSocket-triggered strategy evaluations
  --market-log-interval-ms=30000     Minimum interval between repetitive snapshots/candidate records
  --jupiter-poll-ms=1000            Jupiter REST exit refresh target while a position is open
  --max-jupiter-age-ms=5000         Reject candidates using an older Jupiter snapshot
  --max-consecutive-jupiter-errors=5 Persistent-error warning threshold; never ends a round
  --daily-threshold-poll-ms=10000    Refresh/rank daily POLY-* ladder pricing
  --daily-threshold-discovery-refresh-ms=300000 Rebuild the subscribed daily market set
  --no-daily-threshold               Disable daily BTC-above-strike discovery
  --max-samples=0                    Stop after N synchronized samples; 0 is unlimited
  --max-opportunities=0              Stop after N candidate records; 0 is unlimited
  --once                             Alias for --max-samples=1
  --live-trade                       Enable gated real-money execution
  --confirm-live-trading=PHRASE      Must exactly equal ${LIVE_CONFIRMATION}
  --live-test-entry                  Bypass entry profit minimums for one real submission attempt
  --confirm-live-test-entry=PHRASE   Must exactly equal ${LIVE_TEST_ENTRY_CONFIRMATION}
  --live-state=${DEFAULT_LIVE_STATE}
                                      Durable real-order/exposure state (mode 0600)
  --setup-trading-approvals          Submit Polymarket approvals, then exit without market orders
  --check-polymarket-readiness       Read Polymarket balance/allowances, then exit without transactions
  --check-live-readiness             Read both venue balances/readiness, then exit without transactions
  --maximum-slippage-bps=100         Live per-leg price protection; maximum allowed is 500
  --maximum-jupiter-submit-quote-age-ms=1000 Maximum signed quote age before a post-fill requote
  --maximum-emergency-hedge-loss-usd=1 Maximum accepted loss when hedging an already-filled first leg
  --jupiter-fill-timeout-ms=20000    Reconcile Jupiter after signed execution submission
  --minimum-venue-balance-usd=50     Minimum real wallet balance required at each venue on startup
  --max-venue-allocation-usd=50      Entry cap at each venue per position
  --jupiter-minimum-order-usd=0.01   Strategy floor for direct Forecast token swaps
  --polymarket-minimum-order-usd=1   Minimum Polymarket marketable BUY collateral
  --jupiter-quote-usd=5              Gross cap used to size websocket entry screening
  --minimum-entry-edge-usd=0.01      Nominal edge required per contract after entry fees
  --minimum-entry-profit-usd=0.10    Nominal total edge required for entry
  --minimum-exit-profit-usd=0.10     Net green profit required to sell both legs
  --maximum-open-positions=2         Portfolio-wide concurrent position cap
  --web-port=3210                    Local dashboard status API port
  --no-web                           Disable the local dashboard status API
  --output=${DEFAULT_OUTPUT}
  --help`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
