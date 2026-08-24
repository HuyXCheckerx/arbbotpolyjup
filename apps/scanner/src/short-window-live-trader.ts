import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ONE_CONTRACT_MICRO,
  ONE_USD_MICRO,
  formatContracts,
  formatUsd,
} from "../../../packages/domain/src/fixed.ts";
import { HttpError } from "../../../packages/domain/src/http.ts";
import {
  evaluateShortWindowEntry,
  evaluateShortWindowExit,
  quoteBuyAcrossLevels,
  type ShortWindowStrategyConfig,
  type VenueTradeCost,
} from "../../../packages/domain/src/short-window-strategy.ts";
import {
  polymarketCryptoTakerFeePerContractMicroUsd,
  type EvaluatedCrossVenueRoute,
  type ShortWindowOutcome,
} from "../../../packages/domain/src/short-window.ts";
import type { BinaryOrderBook, BookLevel } from "../../../packages/domain/src/types.ts";
import type {
  JupiterPredictionOrderBuild,
  JupiterPredictionOrderStatus,
  JupiterPredictionPosition,
} from "../../../packages/venue-jupiter/src/client.ts";
import { forecastSwapPositionId } from "../../../packages/venue-jupiter/src/forecast-swap.ts";
import { jupiterExecutionPath } from "../../../packages/venue-jupiter/src/hybrid-trading.ts";
import type {
  PreparedJupiterSubmission,
  SubmittedJupiterOrder,
} from "../../../packages/venue-jupiter/src/trading.ts";
import {
  floorPolymarketFokBuyContractsToAmountPrecision,
  type PolymarketLiveFill,
  type PreparedPolymarketFokOrder,
} from "../../../packages/venue-polymarket/src/trading.ts";

const CONTRACT_TOLERANCE_MICRO = 10_000n;
const MARKET_CHANGE_COOLDOWN_MS = 250;
const TRANSIENT_PREFLIGHT_COOLDOWN_MS = 750;
const CONFIGURATION_PREFLIGHT_COOLDOWN_MS = 2_500;
const ENTRY_CUTOFF_MS = 30_000;
const MAXIMUM_POST_FILL_HEDGE_MISMATCH_BPS = 500n;
const POLYMARKET_RECOVERY_BALANCE_POLL_MS = 500;
const POST_FILL_JUPITER_RATE_LIMIT_RETRY_DELAYS_MS = [500, 1_000] as const;
const OBSERVED_ENTRY_SIZE_MISMATCH =
  "Venue fills are size-mismatched; no one-sided buy top-up was attempted";
const POLYMARKET_MARKET_AMOUNT_PRECISION_REJECTION =
  "invalid amounts, the market buy orders maker amount supports a max accuracy of 2 decimals, " +
  "taker amount a max of 4 decimals";
const POLYMARKET_MARKETABLE_BUY_MINIMUM_REJECTION =
  "invalid amount for a marketable buy order";
const POLYMARKET_PRICE_TICK_MICRO_USD = 10_000n;
const VERIFIED_ACCOUNTING_VERSION = 2;
const LEGACY_UNVERIFIED_FILL_REASON =
  "LEGACY_UNVERIFIED_JUPITER_FILL: position predates on-chain Forecast fill reconciliation";
const liveStateSaveQueues = new Map<string, Promise<void>>();

export interface LivePairIdentity {
  key: string;
  duration: "5m" | "15m" | "daily";
  startMs: number;
  endMs: number;
  polymarketMarketId: string;
  polymarketSlug: string;
  polymarketTokenId: string;
  polymarketOutcome: ShortWindowOutcome;
  jupiterMarketId: string;
  jupiterOutcomeMint?: string;
  jupiterOutcome: ShortWindowOutcome;
}

export interface LiveJupiterGateway {
  readonly ownerPubkey: string;
  prepareBuy(input: {
    marketId: string;
    depositAmountMicroUsd: bigint;
    outcomeMint?: string;
    isYes?: boolean;
  }): Promise<JupiterPredictionOrderBuild>;
  prepareSell(positionPubkey: string, contractsMicro: bigint): Promise<JupiterPredictionOrderBuild>;
  prepareClose(positionPubkey: string): Promise<JupiterPredictionOrderBuild>;
  prepareSubmission(build: JupiterPredictionOrderBuild): Promise<PreparedJupiterSubmission>;
  submitPreparedAndWait(
    prepared: PreparedJupiterSubmission,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<SubmittedJupiterOrder>;
  waitForOrder(orderPubkey: string, options: { timeoutMs: number; pollMs?: number }): Promise<JupiterPredictionOrderStatus>;
  getPosition(positionPubkey: string): Promise<JupiterPredictionPosition>;
  claimPosition(
    positionPubkey: string,
    expectedPayoutMicroUsd?: bigint,
  ): Promise<{ transactionSignature: string; payoutMicroUsd: bigint }>;
  reclaimPositionRent?(
    positionPubkey: string,
  ): Promise<{ transactionSignatures: string[]; reclaimedLamports: bigint }>;
}

export interface LivePolymarketGateway {
  primeBuyToken(tokenId: string): Promise<void>;
  fetchBuyAsks(tokenId: string): Promise<{
    asks: BookLevel[];
    receivedAtMs: number;
    sourceTimestampMs: number | null;
  }>;
  redeemMarket(marketId: string): Promise<string>;
  prepareBuyFok(input: {
    tokenId: string;
    contractsMicro: bigint;
    grossAmountMicroUsd: bigint;
    maximumPriceMicroUsd: bigint;
  }): Promise<PreparedPolymarketFokOrder>;
  prepareSellFok(input: {
    tokenId: string;
    contractsMicro: bigint;
    minimumPriceMicroUsd: bigint;
  }): Promise<PreparedPolymarketFokOrder>;
  submitPreparedFok(prepared: PreparedPolymarketFokOrder): Promise<PolymarketLiveFill>;
  getTokenBalance(tokenId: string): Promise<bigint>;
  refreshTokenBalance(tokenId: string): Promise<bigint>;
}

export type LivePositionPhase =
  | "jupiter_prepared"
  | "jupiter_pending"
  | "polymarket_hedging"
  | "legs_submitting"
  | "open"
  | "exiting_jupiter"
  | "exiting_polymarket"
  | "recovery_planning"
  | "awaiting_resolution"
  | "exposure_error";

export type LiveResolutionScenarioCode =
  | "polymarket_only_win"
  | "jupiter_only_win"
  | "both_win"
  | "both_lose";

export interface LiveResolutionScenario {
  code: LiveResolutionScenarioCode;
  polymarketWon: boolean;
  jupiterWon: boolean;
  payoutMicroUsd: bigint;
  pnlMicroUsd: bigint;
  rationale: string;
}

export type LivePostFillAction =
  | "hold_or_exit_normally"
  | "quote_repair"
  | "manual_reconciliation";

export interface LivePostFillRiskPlan {
  action: LivePostFillAction;
  reason: string;
  scenarios: LiveResolutionScenario[];
  intendedSingleWinnerFloorMicroUsd: bigint;
  maximumModeledLossMicroUsd: bigint;
  venueSizeMismatchMicro: bigint;
  venueSizeMismatchBps: bigint | null;
}

export interface LivePosition {
  id: string;
  pair: LivePairIdentity;
  phase: LivePositionPhase;
  enteredAtMs: number;
  jupiterOrderPubkey: string | null;
  jupiterPositionPubkey: string;
  jupiterEntryPositionPubkey?: string | null;
  jupiterQuotedContractsMicro?: bigint;
  jupiterExecutionReconciliationSource?: JupiterPredictionOrderStatus["reconciliationSource"] | null;
  jupiterContractsMicro: bigint;
  polymarketContractsMicro: bigint;
  jupiterEntryCostMicroUsd: bigint;
  polymarketEntryCostMicroUsd: bigint;
  remainingEntryCostMicroUsd: bigint;
  originalContractsMicro: bigint;
  realizedProfitMicroUsd: bigint;
  polymarketSettled: boolean;
  jupiterSettled: boolean;
  polymarketSettlementPayoutMicroUsd: bigint;
  jupiterSettlementPayoutMicroUsd: bigint;
  polymarketSettlementTransactionSignature?: string | null;
  jupiterSettlementTransactionSignature?: string | null;
  jupiterRentReclaimed?: boolean;
  jupiterRentReclaimedLamports?: bigint;
  jupiterRentReclaimTransactionSignatures?: string[];
  entrySubmissionSkewMs: number | null;
  exitSubmissionSkewMs: number | null;
  diagnosticTestEntry: boolean;
  postFillRiskPlan?: LivePostFillRiskPlan | null;
  lastError: string | null;
  settlementError?: string | null;
}

export interface LiveSettlement {
  positionId: string;
  polymarketWon: boolean;
  jupiterWon: boolean;
  polymarketPayoutMicroUsd: bigint;
  jupiterPayoutMicroUsd: bigint;
  realizedProfitMicroUsd: bigint;
  polymarketSettlementTransactionSignature: string | null;
  jupiterSettlementTransactionSignature: string | null;
  jupiterRentReclaimTransactionSignatures: string[];
  jupiterRentReclaimedLamports: bigint;
}

export interface LiveTraderState {
  schemaVersion: 1;
  accountingVersion?: 2;
  legacyUnverifiedRealizedProfitMicroUsd?: bigint;
  sequence: number;
  halted: boolean;
  haltReason: string | null;
  realizedProfitMicroUsd: bigint;
  polymarketCashMicroUsd: bigint | null;
  jupiterCashMicroUsd: bigint | null;
  forcedEntrySubmissionAttempted: boolean;
  completedPairs: string[];
  positions: LivePosition[];
}

export type LiveExitMode = "hold_until_resolution" | "take_profit";

export interface LiveTraderConfig {
  strategy: ShortWindowStrategyConfig;
  initialPolymarketCashMicroUsd: bigint;
  initialJupiterCashMicroUsd: bigint;
  maximumOpenPositions: number;
  exitMode: LiveExitMode;
  maximumSlippageBps: number;
  polymarketDepthHaircutBps: number;
  maximumReusableJupiterQuoteAgeMs: number;
  maximumJupiterSubmissionQuoteAgeMs: number;
  maximumEmergencyHedgeLossMicroUsd: bigint;
  jupiterFillTimeoutMs: number;
  forceOneEntry: boolean;
  statePath: string;
}

export type LiveEntryPreflightStage =
  | "jupiter_quote"
  | "cross_venue_validation"
  | "venue_preparation"
  | "complete";

export type LiveEntryPreflightRetryClass = "market_changed" | "transient" | "configuration" | "none";

export interface LiveErrorDiagnostic {
  name: string;
  message: string;
  code: string | number | null;
  status: string | number | null;
  router: string | null;
  url: string | null;
  transactionSignature: string | null;
  stack: string | null;
  cause: LiveErrorDiagnostic | null;
}

export interface LiveEntryPreflightDiagnostics {
  pairKey: string;
  attemptedAtMs: number;
  elapsedMs: number;
  stage: LiveEntryPreflightStage;
  code: string;
  retryClass: LiveEntryPreflightRetryClass;
  cooldownMs: number;
  reusedJupiterQuote: boolean;
  jupiterQuoteAgeMs: number | null;
  stageTimingsMs: Partial<Record<Exclude<LiveEntryPreflightStage, "complete">, number>>;
  jupiter: {
    marketId: string;
    requestedGrossMicroUsd: bigint;
    quotedGrossMicroUsd: bigint | null;
    quotedContractsMicro: bigint | null;
    quoteBuiltAtMs: number | null;
    executionPath: "prediction_api" | "swap_v2" | null;
    endpoint: string | null;
    requestId: string | null;
    router: string | null;
    mode: string | null;
  };
  polymarket: {
    tokenId: string;
    proposedContractsMicro: bigint;
    quotedGrossMicroUsd: bigint | null;
    maximumPriceMicroUsd: bigint | null;
  };
  error: LiveErrorDiagnostic | null;
}

export interface LiveEntryExecutionDiagnostics {
  attemptedAtMs: number;
  elapsedMs: number;
  jupiter: {
    result: "fulfilled" | "rejected" | "skipped";
    submissionAttempted: boolean;
    signed: boolean;
    executionPath: "prediction_api" | "swap_v2" | null;
    endpoint: string | null;
    requestId: string | null;
    usedPreflightBuild: boolean;
    quoteAgeAtSubmissionMs: number | null;
    retryCount: number;
    initialError: LiveErrorDiagnostic | null;
    transactionSignature: string | null;
    orderStatus: JupiterPredictionOrderStatus["status"] | null;
    reconciliationSource: JupiterPredictionOrderStatus["reconciliationSource"] | null;
    quotedContractsMicro: bigint;
    filledContractsMicro: bigint;
    contractShortfallMicro: bigint;
    quotedCostMicroUsd: bigint;
    executedCostMicroUsd: bigint;
    error: LiveErrorDiagnostic | null;
  };
  polymarket: {
    result: "fulfilled" | "rejected";
    orderId: string | null;
    reportedContractsMicro: bigint;
    observedContractsMicro: bigint;
    error: LiveErrorDiagnostic | null;
  };
}

export type LiveRecoverySource = "entry_execution" | "startup" | "runtime";

export interface LiveRecoveryDiagnostics {
  code:
    | "ZERO_EXPOSURE_CONFIRMED_AFTER_TERMINAL_ENTRY_FAILURE"
    | "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND";
  source: LiveRecoverySource;
  recoveredAtMs: number;
  positionId: string;
  pairKey: string;
  duration: LivePairIdentity["duration"];
  reason: string;
  observedPolymarketContractsMicro: bigint;
  observedJupiterContractsMicro: bigint;
}

export type LiveDecision = (
  | { type: "entry"; position: LivePosition }
  | { type: "exit"; positionId: string; realizedProfitMicroUsd: bigint; submissionSkewMs: number | null }
  | { type: "recovery"; reason: string; positionId: string }
  | { type: "recovery_plan"; reason: string; position: LivePosition; plan: LivePostFillRiskPlan }
  | { type: "hold"; reason: string; position?: LivePosition }
  | { type: "skip"; reason: string }
  | { type: "halt"; reason: string; position?: LivePosition }
) & {
  preflight?: LiveEntryPreflightDiagnostics;
  execution?: LiveEntryExecutionDiagnostics;
  recovery?: LiveRecoveryDiagnostics;
};

interface EntryPreflightCooldown {
  untilMs: number;
  stage: LiveEntryPreflightStage;
  code: string;
}

export class ShortWindowLiveTrader {
  readonly #jupiter: LiveJupiterGateway;
  readonly #polymarket: LivePolymarketGateway;
  readonly #config: LiveTraderConfig;
  #state: LiveTraderState = emptyState();
  #busy = false;
  readonly #entryPreflightCooldowns = new Map<string, EntryPreflightCooldown>();
  readonly #pendingRecoveryDiagnostics: LiveRecoveryDiagnostics[] = [];
  #lastAction = "Live trader armed; waiting for a qualified route.";

  constructor(input: {
    jupiter: LiveJupiterGateway;
    polymarket: LivePolymarketGateway;
    config: LiveTraderConfig;
  }) {
    this.#jupiter = input.jupiter;
    this.#polymarket = input.polymarket;
    this.#config = input.config;
  }

  async initialize(): Promise<void> {
    this.#state = await loadLiveState(this.#config.statePath);
    let stateMigrated = false;
    if (this.#state.accountingVersion !== VERIFIED_ACCOUNTING_VERSION) {
      this.#state.legacyUnverifiedRealizedProfitMicroUsd =
        (this.#state.legacyUnverifiedRealizedProfitMicroUsd ?? 0n) + this.#state.realizedProfitMicroUsd;
      this.#state.realizedProfitMicroUsd = 0n;
      this.#state.accountingVersion = VERIFIED_ACCOUNTING_VERSION;
      for (const position of this.#state.positions) {
        if (position.jupiterContractsMicro <= CONTRACT_TOLERANCE_MICRO) continue;
        position.phase = "exposure_error";
        position.lastError = LEGACY_UNVERIFIED_FILL_REASON;
      }
      this.#lastAction = "Archived legacy quote-derived P&L; verified realized P&L now starts at $0.";
      stateMigrated = true;
    }
    const persistedPolymarketCashMicroUsd = this.#state.polymarketCashMicroUsd;
    // Wallet collateral is the source of truth. Persisted cash fields are only
    // a crash-recovery snapshot and must never restore a simulated bankroll.
    this.#state.polymarketCashMicroUsd = this.#config.initialPolymarketCashMicroUsd;
    this.#state.jupiterCashMicroUsd = this.#config.initialJupiterCashMicroUsd;
    this.#state.forcedEntrySubmissionAttempted ??= false;
    for (const position of this.#state.positions) {
      position.settlementError ??= null;
      if (position.pair.jupiterOutcomeMint) {
        const managedPositionPubkey = managedJupiterPositionPubkey(
          position.pair,
          position.jupiterPositionPubkey,
        );
        if (managedPositionPubkey !== position.jupiterPositionPubkey) {
          position.jupiterEntryPositionPubkey ??= position.jupiterPositionPubkey;
          position.jupiterPositionPubkey = managedPositionPubkey;
          stateMigrated = true;
        }
      }
      position.polymarketSettled ??= false;
      position.jupiterSettled ??= false;
      position.polymarketSettlementPayoutMicroUsd ??= 0n;
      position.jupiterSettlementPayoutMicroUsd ??= 0n;
      position.polymarketSettlementTransactionSignature ??= null;
      position.jupiterSettlementTransactionSignature ??= null;
      position.jupiterRentReclaimed ??= position.pair.jupiterOutcomeMint === undefined;
      position.jupiterRentReclaimedLamports ??= 0n;
      position.jupiterRentReclaimTransactionSignatures ??= [];
      position.entrySubmissionSkewMs ??= null;
      position.exitSubmissionSkewMs ??= null;
      position.diagnosticTestEntry ??= false;
      position.postFillRiskPlan ??= null;
      if (position.phase === "exposure_error" &&
        isKnownTerminalOneSidedEntry(position) &&
        position.polymarketContractsMicro <= CONTRACT_TOLERANCE_MICRO &&
        position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO &&
        Date.now() < position.pair.endMs) {
        position.postFillRiskPlan = buildPostFillRiskPlan(
          position,
          this.#config.strategy,
          true,
        );
        position.phase = "recovery_planning";
        stateMigrated = true;
      }
      if ((position.phase === "recovery_planning" ||
          (position.phase === "exposure_error" &&
            position.lastError?.startsWith(OBSERVED_ENTRY_SIZE_MISMATCH) === true)) &&
        hasFullyObservedTwoLegExposure(position)) {
        const plan = buildPostFillRiskPlan(position, this.#config.strategy);
        position.postFillRiskPlan = plan;
        position.originalContractsMicro = minimum(
          position.polymarketContractsMicro,
          position.jupiterContractsMicro,
        );
        if (Date.now() >= position.pair.endMs) {
          position.phase = "awaiting_resolution";
        } else if (plan.action === "quote_repair") {
          position.phase = "recovery_planning";
        } else {
          position.phase = "open";
          position.lastError = null;
        }
        stateMigrated = true;
      }
      if (canSafelyAwaitResolution(position, Date.now())) position.phase = "awaiting_resolution";
    }
    this.#pendingRecoveryDiagnostics.push(...await this.#recoverPersistedZeroExposureEntries("startup"));
    this.#pendingRecoveryDiagnostics.push(
      ...await this.#recoverPersistedPolymarketOnlyEntries("startup", persistedPolymarketCashMicroUsd),
    );
    const ambiguous = this.#state.positions.find((position) => !isManagedKnownPosition(position));
    if (ambiguous) {
      this.#state.halted = true;
      this.#state.haltReason = ambiguous.lastError ??
        `Recovery required for ${ambiguous.id} in phase ${ambiguous.phase}`;
      await this.#save();
    } else if (this.#releaseHaltWithoutBlockingExposure()) {
      this.#lastAction = this.#state.positions.length > 0
        ? "Known managed exposure remains open or awaiting settlement; new entries are re-enabled."
        : "No managed exposure remains; live trading is re-enabled.";
      await this.#save();
    } else if (stateMigrated) {
      await this.#save();
    }
  }

  async primeEntryToken(tokenId: string): Promise<void> {
    await this.#polymarket.primeBuyToken(tokenId);
  }

  drainRecoveryDiagnostics(): LiveRecoveryDiagnostics[] {
    return this.#pendingRecoveryDiagnostics.splice(0);
  }

  async attemptAutomaticRecovery(): Promise<LiveRecoveryDiagnostics[]> {
    if (!this.#state.halted || this.#busy) return [];
    this.#busy = true;
    try {
      const recoveries = await this.#recoverPersistedZeroExposureEntries("runtime");
      recoveries.push(...await this.#recoverPersistedPolymarketOnlyEntries("runtime", null));
      return recoveries;
    } finally {
      this.#busy = false;
    }
  }

  async consider(input: {
    pair: LivePairIdentity;
    bestRoute: EvaluatedCrossVenueRoute | null;
    polymarketBook: BinaryOrderBook;
    jupiterBook: BinaryOrderBook;
    jupiterEntryBuild?: JupiterPredictionOrderBuild | null;
    jupiterEntryBuildAtMs?: number | null;
    atMs: number;
  }): Promise<LiveDecision> {
    if (this.#state.halted) {
      const position = this.#state.positions.find((candidate) => candidate.pair.key === input.pair.key);
      return {
        type: "hold",
        reason: this.#state.haltReason ?? "LIVE_TRADER_HALTED",
        ...(position ? { position } : {}),
      };
    }
    const existing = this.#state.positions.find((position) => position.pair.key === input.pair.key);
    if (existing?.phase === "open") {
      if (this.#config.exitMode === "hold_until_resolution") {
        return { type: "hold", reason: "HOLDING_UNTIL_RESOLUTION", position: existing };
      }
      if (this.#busy) return { type: "skip", reason: "LIVE_EXECUTOR_BUSY" };
      return await this.#tryExit(existing, input.polymarketBook, input.jupiterBook);
    }
    if (existing) return { type: "hold", reason: existing.phase, position: existing };
    if (this.#state.completedPairs.includes(input.pair.key)) return { type: "skip", reason: "PAIR_ALREADY_TRADED" };
    if (this.#config.forceOneEntry && this.#state.forcedEntrySubmissionAttempted) {
      return { type: "skip", reason: "ONE_SHOT_TEST_ENTRY_ALREADY_ATTEMPTED" };
    }
    if (this.#state.positions.length >= this.#config.maximumOpenPositions) {
      return { type: "skip", reason: "MAXIMUM_OPEN_POSITIONS" };
    }
    if (input.pair.endMs - input.atMs <= ENTRY_CUTOFF_MS) {
      return { type: "skip", reason: "ENTRY_CUTOFF_REACHED" };
    }

    const availablePolymarket = maximum(0n, this.#polymarketCash());
    const availableJupiter = maximum(0n, this.#jupiterCash());
    const entryPolymarketCapacity = conservativeEntryCapacity(
      minimum(availablePolymarket, this.#config.strategy.polymarketMaximumAllocationMicroUsd),
      this.#config.maximumSlippageBps,
    );
    const entryJupiterCapacity = conservativeEntryCapacity(
      minimum(availableJupiter, this.#config.strategy.jupiterMaximumAllocationMicroUsd),
      this.#config.maximumSlippageBps,
    );
    const forcedTestEntry = this.#config.forceOneEntry;
    const conservativeBestRoute = input.bestRoute
      ? {
          ...input.bestRoute,
          polymarketAsks: haircutBookLevels(
            input.bestRoute.polymarketAsks,
            this.#config.polymarketDepthHaircutBps,
          ),
        }
      : null;
    const entry = forcedTestEntry ? null : evaluateShortWindowEntry({
      route: conservativeBestRoute,
      polymarketAvailableMicroUsd: entryPolymarketCapacity,
      jupiterAvailableMicroUsd: entryJupiterCapacity,
      config: this.#config.strategy,
    });
    if (!forcedTestEntry && entry && !entry.eligible) return { type: "skip", reason: entry.reason };
    if (forcedTestEntry && !input.bestRoute) return { type: "skip", reason: "ONE_SHOT_TEST_WAITING_FOR_BOTH_BOOKS" };
    const nowMs = Date.now();
    for (const [pairKey, candidate] of this.#entryPreflightCooldowns) {
      if (candidate.untilMs <= nowMs) this.#entryPreflightCooldowns.delete(pairKey);
    }
    const cooldown = this.#entryPreflightCooldowns.get(input.pair.key);
    if (cooldown && nowMs < cooldown.untilMs) {
      return {
        type: "skip",
        reason: `ENTRY_PREFLIGHT_COOLDOWN: pair=${input.pair.key} ` +
          `remainingMs=${cooldown.untilMs - nowMs} after=${cooldown.stage}/${cooldown.code}`,
      };
    }
    if (cooldown) this.#entryPreflightCooldowns.delete(input.pair.key);
    if (this.#busy) return { type: "skip", reason: "LIVE_EXECUTOR_BUSY" };
    this.#busy = true;
    try {
      let entryJupiterGrossMicroUsd = forcedTestEntry
        ? input.jupiterEntryBuild?.order.orderCostMicroUsd ?? this.#config.strategy.jupiterMinimumGrossOrderMicroUsd
        : entry && entry.eligible ? entry.proposal.jupiter.grossMicroUsd : 0n;
      let entryContractsMicro = forcedTestEntry
        ? input.jupiterEntryBuild?.order.newContractsMicro ?? this.#config.strategy.polymarketMinimumContractsMicro
        : entry && entry.eligible ? entry.proposal.quantityMicro : 0n;
      if (!forcedTestEntry && input.bestRoute && input.jupiterEntryBuild &&
        input.jupiterEntryBuildAtMs !== null && input.jupiterEntryBuildAtMs !== undefined &&
        canExecuteFreshScreeningBuild({
          build: input.jupiterEntryBuild,
          builtAtMs: input.jupiterEntryBuildAtMs,
          pair: input.pair,
          polymarketAsks: conservativeBestRoute?.polymarketAsks ?? [],
          polymarketAvailableMicroUsd: entryPolymarketCapacity,
          jupiterAvailableMicroUsd: entryJupiterCapacity,
          config: this.#config,
        })) {
        // The rolling screening quote is already an executable Jupiter
        // Prediction or Swap V2 transaction.
        // Matching the hedge to its full output avoids a second quote request,
        // API-rate-limit contention, and hundreds of milliseconds of drift.
        entryJupiterGrossMicroUsd = input.jupiterEntryBuild.order.orderCostMicroUsd;
        entryContractsMicro = floorToPolymarketSharePrecision(
          guaranteedJupiterOutputContracts(input.jupiterEntryBuild),
        );
      }
      const decision = await this.#enter(
        input.pair,
        input.bestRoute?.polymarketAsks ?? [],
        entryJupiterGrossMicroUsd,
        entryContractsMicro,
        input.jupiterEntryBuild ?? null,
        input.jupiterEntryBuildAtMs ?? null,
        forcedTestEntry,
      );
      if (decision.type === "skip" && decision.preflight?.error) {
        this.#entryPreflightCooldowns.set(input.pair.key, {
          untilMs: Date.now() + decision.preflight.cooldownMs,
          stage: decision.preflight.stage,
          code: decision.preflight.code,
        });
      } else if (decision.type !== "recovery") {
        this.#entryPreflightCooldowns.delete(input.pair.key);
      }
      return decision;
    } finally {
      this.#busy = false;
    }
  }

  async markPairEnded(pairKey: string): Promise<LivePosition | null> {
    const position = this.#state.positions.find(
      (candidate) => candidate.pair.key === pairKey && canSafelyAwaitResolution(candidate, Date.now()),
    );
    if (!position) return null;
    position.phase = "awaiting_resolution";
    const released = this.#releaseHaltWithoutBlockingExposure();
    this.#lastAction = (position.lastError
      ? `${position.pair.duration} fully observed isolated exposure is awaiting venue resolution.`
      : `${position.pair.duration} live position is awaiting venue resolution.`) +
      (released ? " New entries are re-enabled while settlement continues." : "");
    await this.#save();
    return position;
  }

  awaitingResolution(): LivePosition[] {
    return this.#state.positions.filter((position) => position.phase === "awaiting_resolution");
  }

  expiredPairKeys(atMs = Date.now()): string[] {
    return this.#state.positions
      .filter((position) => position.pair.endMs <= atMs && canSafelyAwaitResolution(position, atMs))
      .map((position) => position.pair.key);
  }

  hasOpenPosition(pairKey: string): boolean {
    return this.#state.positions.some((position) => position.pair.key === pairKey && position.phase === "open");
  }

  acceptsEntryQuotes(pairKey: string): boolean {
    if (this.#state.halted || this.#state.completedPairs.includes(pairKey)) return false;
    if (this.#state.positions.some((position) => position.pair.key === pairKey)) return false;
    if (this.#state.positions.length >= this.#config.maximumOpenPositions) return false;
    return !this.#config.forceOneEntry || !this.#state.forcedEntrySubmissionAttempted;
  }

  needsExitBook(pairKey: string): boolean {
    return this.#config.exitMode === "take_profit" && this.hasOpenPosition(pairKey);
  }

  updateWalletBalances(polymarketCashMicroUsd: bigint, jupiterCashMicroUsd: bigint): void {
    this.#state.polymarketCashMicroUsd = maximum(0n, polymarketCashMicroUsd);
    this.#state.jupiterCashMicroUsd = maximum(0n, jupiterCashMicroUsd);
  }

  async recordSettlementError(pairKey: string, error: unknown): Promise<boolean> {
    const position = this.#state.positions.find(
      (candidate) => candidate.pair.key === pairKey && candidate.phase === "awaiting_resolution",
    );
    if (!position) return false;
    const message = errorMessage(error);
    if (position.settlementError === message) return false;
    position.settlementError = message;
    this.#lastAction = `SETTLEMENT RETRY ${position.pair.duration} ${position.id}: ${message}`;
    await this.#save();
    return true;
  }

  async settleAwaiting(pairKey: string, polymarketWon: boolean, jupiterWon: boolean): Promise<LiveSettlement | null> {
    const position = this.#state.positions.find(
      (candidate) => candidate.pair.key === pairKey && candidate.phase === "awaiting_resolution",
    );
    if (!position) return null;
    if (!position.polymarketSettled) {
      if (polymarketWon && position.polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO) {
        const balance = await this.#polymarket.getTokenBalance(position.pair.polymarketTokenId);
        if (balance > CONTRACT_TOLERANCE_MICRO) {
          position.polymarketSettlementTransactionSignature =
            await this.#polymarket.redeemMarket(position.pair.polymarketMarketId);
        }
        position.polymarketSettlementPayoutMicroUsd = position.polymarketContractsMicro;
      }
      this.#state.polymarketCashMicroUsd = this.#polymarketCash() + position.polymarketSettlementPayoutMicroUsd;
      position.polymarketSettled = true;
      await this.#save();
    }
    if (!position.jupiterSettled) {
      if (jupiterWon && position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO) {
        const claim = await this.#jupiter.claimPosition(
          position.jupiterPositionPubkey,
          position.jupiterContractsMicro,
        );
        position.jupiterSettlementPayoutMicroUsd = claim.payoutMicroUsd;
        position.jupiterSettlementTransactionSignature = claim.transactionSignature;
      }
      this.#state.jupiterCashMicroUsd = this.#jupiterCash() + position.jupiterSettlementPayoutMicroUsd;
      position.jupiterSettled = true;
      await this.#save();
    }
    if (!position.jupiterRentReclaimed) {
      const reclaimed = this.#jupiter.reclaimPositionRent
        ? await this.#jupiter.reclaimPositionRent(position.jupiterPositionPubkey)
        : { transactionSignatures: [], reclaimedLamports: 0n };
      position.jupiterRentReclaimed = true;
      position.jupiterRentReclaimedLamports = reclaimed.reclaimedLamports;
      position.jupiterRentReclaimTransactionSignatures = reclaimed.transactionSignatures;
      await this.#save();
    }
    if (!position.polymarketSettled || !position.jupiterSettled || !position.jupiterRentReclaimed) return null;
    const recoveredTerminalOneSidedEntry = isKnownTerminalOneSidedEntry(position);
    const realized = position.polymarketSettlementPayoutMicroUsd + position.jupiterSettlementPayoutMicroUsd -
      position.remainingEntryCostMicroUsd;
    const settlement: LiveSettlement = {
      positionId: position.id,
      polymarketWon,
      jupiterWon,
      polymarketPayoutMicroUsd: position.polymarketSettlementPayoutMicroUsd,
      jupiterPayoutMicroUsd: position.jupiterSettlementPayoutMicroUsd,
      realizedProfitMicroUsd: realized,
      polymarketSettlementTransactionSignature:
        position.polymarketSettlementTransactionSignature ?? null,
      jupiterSettlementTransactionSignature: position.jupiterSettlementTransactionSignature ?? null,
      jupiterRentReclaimTransactionSignatures:
        position.jupiterRentReclaimTransactionSignatures ?? [],
      jupiterRentReclaimedLamports: position.jupiterRentReclaimedLamports ?? 0n,
    };
    this.#state.realizedProfitMicroUsd += realized;
    this.#state.positions = this.#state.positions.filter((candidate) => candidate.id !== position.id);
    if (!this.#state.completedPairs.includes(position.pair.key)) this.#state.completedPairs.push(position.pair.key);
    const released = this.#releaseHaltWithoutBlockingExposure();
    this.#lastAction = `LIVE RESOLUTION ${position.pair.duration}: realized $${formatUsd(realized)}.` +
      (recoveredTerminalOneSidedEntry ? " Safely recovered terminal one-sided entry." : "") +
      (released ? " New entries are re-enabled." : "");
    await this.#save();
    return settlement;
  }

  snapshot(): {
    mode: "live";
    halted: boolean;
    haltReason: string | null;
    polymarketCashUsd: string;
    jupiterCashUsd: string;
    realizedProfitUsd: string;
    legacyUnverifiedRealizedProfitUsd: string;
    openPositions: number;
    awaitingResolution: number;
    lastAction: string;
    positions: Array<{
      id: string;
      pairKey: string;
      duration: string;
      start: string;
      end: string;
      polymarketSlug: string;
      polymarketMarketId: string;
      jupiterMarketId: string;
      phase: string;
      polymarketOutcome: string;
      jupiterOutcome: string;
      polymarketContracts: string;
      jupiterContracts: string;
      jupiterQuotedContracts: string | null;
      polymarketCostUsd: string;
      jupiterCostUsd: string;
      totalCostUsd: string;
      minimumAlignedPnlUsd: string;
      polymarketWinPnlUsd: string;
      jupiterWinPnlUsd: string;
      bothWinPnlUsd: string;
      bothLosePnlUsd: string;
      maximumModeledLossUsd: string;
      postFillAction: LivePostFillAction;
      postFillReason: string;
      contractSkew: string;
      contractSkewBps: string | null;
      hedgeStatus: "perfect" | "bounded_residual" | "recovery_planning" | "exposure_error";
      isHedged: boolean;
      polymarketSettled: boolean;
      jupiterSettled: boolean;
      jupiterRentReclaimed: boolean;
      jupiterRentReclaimedSol: string;
      realizedProfitUsd: string;
      enteredAt: string;
      lastError: string | null;
      settlementError: string | null;
    }>;
  } {
    return {
      mode: "live",
      halted: this.#state.halted,
      haltReason: this.#state.haltReason,
      polymarketCashUsd: formatUsd(this.#polymarketCash()),
      jupiterCashUsd: formatUsd(this.#jupiterCash()),
      realizedProfitUsd: formatUsd(this.#state.realizedProfitMicroUsd),
      legacyUnverifiedRealizedProfitUsd: formatUsd(
        this.#state.legacyUnverifiedRealizedProfitMicroUsd ?? 0n,
      ),
      openPositions: this.#state.positions.length,
      awaitingResolution: this.#state.positions.filter((position) => position.phase === "awaiting_resolution").length,
      lastAction: this.#lastAction,
      positions: this.#state.positions.map((pos) => {
        const polyContracts = formatContracts(pos.polymarketContractsMicro);
        const jupContracts = formatContracts(pos.jupiterContractsMicro);
        const polyMicro = pos.polymarketContractsMicro;
        const jupMicro = pos.jupiterContractsMicro;
        const diffMicro = polyMicro > jupMicro ? polyMicro - jupMicro : jupMicro - polyMicro;
        const matchedMicro = minimum(polyMicro, jupMicro);
        const totalCostMicroUsd = pos.polymarketEntryCostMicroUsd + pos.jupiterEntryCostMicroUsd;
        const payoff = actualEntryPayoffs(pos);
        const postFillRiskPlan = buildPostFillRiskPlan(
          pos,
          this.#config.strategy,
          isManagedKnownPosition(pos),
        );
        const contractSkewBps = matchedMicro > 0n ? diffMicro * 10_000n / matchedMicro : null;
        const isHedged = diffMicro <= CONTRACT_TOLERANCE_MICRO &&
          (pos.phase === "open" || pos.phase === "awaiting_resolution") &&
          !pos.lastError;
        const isBoundedResidual = !isHedged &&
          (pos.phase === "open" || pos.phase === "awaiting_resolution") &&
          !pos.lastError &&
          polyMicro > CONTRACT_TOLERANCE_MICRO &&
          jupMicro > CONTRACT_TOLERANCE_MICRO &&
          contractSkewBps !== null &&
          contractSkewBps <= MAXIMUM_POST_FILL_HEDGE_MISMATCH_BPS;
        return {
          id: pos.id,
          pairKey: pos.pair.key,
          duration: pos.pair.duration,
          start: new Date(pos.pair.startMs).toISOString(),
          end: new Date(pos.pair.endMs).toISOString(),
          polymarketSlug: pos.pair.polymarketSlug,
          polymarketMarketId: pos.pair.polymarketMarketId,
          jupiterMarketId: pos.pair.jupiterMarketId,
          phase: pos.phase,
          polymarketOutcome: pos.pair.polymarketOutcome,
          jupiterOutcome: pos.pair.jupiterOutcome,
          polymarketContracts: polyContracts,
          jupiterContracts: jupContracts,
          jupiterQuotedContracts: pos.jupiterQuotedContractsMicro === undefined
            ? null
            : formatContracts(pos.jupiterQuotedContractsMicro),
          polymarketCostUsd: formatUsd(pos.polymarketEntryCostMicroUsd),
          jupiterCostUsd: formatUsd(pos.jupiterEntryCostMicroUsd),
          totalCostUsd: formatUsd(totalCostMicroUsd),
          minimumAlignedPnlUsd: formatUsd(payoff.minimumPnlMicroUsd),
          polymarketWinPnlUsd: formatUsd(payoff.polymarketWinPnlMicroUsd),
          jupiterWinPnlUsd: formatUsd(payoff.jupiterWinPnlMicroUsd),
          bothWinPnlUsd: formatUsd(payoff.bothWinPnlMicroUsd),
          bothLosePnlUsd: formatUsd(payoff.bothLosePnlMicroUsd),
          maximumModeledLossUsd: formatUsd(postFillRiskPlan.maximumModeledLossMicroUsd),
          postFillAction: postFillRiskPlan.action,
          postFillReason: postFillRiskPlan.reason,
          contractSkew: formatContracts(diffMicro),
          contractSkewBps: contractSkewBps === null ? null : contractSkewBps.toString(),
          hedgeStatus: pos.phase === "recovery_planning"
            ? "recovery_planning"
            : isHedged ? "perfect" : isBoundedResidual ? "bounded_residual" : "exposure_error",
          isHedged,
          polymarketSettled: pos.polymarketSettled,
          jupiterSettled: pos.jupiterSettled,
          jupiterRentReclaimed: pos.jupiterRentReclaimed ?? false,
          jupiterRentReclaimedSol: formatSolLamports(pos.jupiterRentReclaimedLamports ?? 0n),
          realizedProfitUsd: formatUsd(pos.realizedProfitMicroUsd),
          enteredAt: new Date(pos.enteredAtMs).toISOString(),
          lastError: pos.lastError,
          settlementError: pos.settlementError ?? null,
        };
      }),
    };
  }

  async #enter(
    pair: LivePairIdentity,
    polymarketAsks: readonly BookLevel[],
    jupiterDepositMicroUsd: bigint,
    proposedContractsMicro: bigint,
    reusableJupiterBuild: JupiterPredictionOrderBuild | null,
    reusableJupiterBuildAtMs: number | null,
    forcedTestEntry: boolean,
  ): Promise<LiveDecision> {
    let executablePolymarketAsks = haircutBookLevels(
      polymarketAsks,
      this.#config.polymarketDepthHaircutBps,
    );
    const proposedPolymarketQuote = quoteBuyAcrossLevels(
      executablePolymarketAsks,
      proposedContractsMicro,
      "polymarket",
    );
    if (!proposedPolymarketQuote) {
      return { type: "skip", reason: "POLYMARKET_MULTI_LEVEL_DEPTH_CHANGED" };
    }
    const polymarketAvailable = maximum(0n, this.#polymarketCash());
    if (proposedPolymarketQuote.allInMicroUsd > minimum(
      polymarketAvailable,
      this.#config.strategy.polymarketMaximumAllocationMicroUsd,
    )) {
      return { type: "skip", reason: "POLYMARKET_SLIPPAGE_BUDGET_PREFLIGHT" };
    }
    const attemptedAtMs = Date.now();
    const stageTimingsMs: LiveEntryPreflightDiagnostics["stageTimingsMs"] = {};
    let stage: Exclude<LiveEntryPreflightStage, "complete"> = "jupiter_quote";
    let stageStartedAtMs = attemptedAtMs;
    let reusedJupiterQuote = false;
    let jupiterQuoteAgeMs: number | null = null;
    let build: JupiterPredictionOrderBuild | null = null;
    let buildAtMs: number | null = null;
    let preparedJupiter: PreparedJupiterSubmission | null = null;
    let preparedPolymarket: PreparedPolymarketFokOrder | null = null;
    let polymarketBalanceBefore = 0n;
    let maximumPolymarketPrice: bigint | null = null;
    let polymarketQuote: VenueTradeCost | null = null;
    let quotedContractsMicro: bigint | null = null;
    let polymarketContractsMicro = 0n;
    const finishStage = (): void => {
      stageTimingsMs[stage] = (stageTimingsMs[stage] ?? 0) + Math.max(0, Date.now() - stageStartedAtMs);
    };
    const moveToStage = (next: typeof stage): void => {
      finishStage();
      stage = next;
      stageStartedAtMs = Date.now();
    };
    const diagnostics = (
      diagnosticStage: LiveEntryPreflightStage,
      code: string,
      retryClass: LiveEntryPreflightRetryClass,
      cooldownMs: number,
      error: unknown | null,
    ): LiveEntryPreflightDiagnostics => ({
      pairKey: pair.key,
      attemptedAtMs,
      elapsedMs: Math.max(0, Date.now() - attemptedAtMs),
      stage: diagnosticStage,
      code,
      retryClass,
      cooldownMs,
      reusedJupiterQuote,
      jupiterQuoteAgeMs,
      stageTimingsMs,
      jupiter: {
        marketId: pair.jupiterMarketId,
        requestedGrossMicroUsd: jupiterDepositMicroUsd,
        quotedGrossMicroUsd: build?.order.orderCostMicroUsd ?? null,
        quotedContractsMicro,
        quoteBuiltAtMs: buildAtMs,
        executionPath: jupiterExecutionPath(build),
        endpoint: optionalString(build?.execution.endpoint),
        requestId: jupiterBuildRequestId(build),
        router: optionalString(build?.execution.context.router),
        mode: optionalString(build?.execution.context.mode),
      },
      polymarket: {
        tokenId: pair.polymarketTokenId,
        proposedContractsMicro: polymarketContractsMicro > 0n
          ? polymarketContractsMicro
          : proposedContractsMicro,
        quotedGrossMicroUsd: polymarketQuote?.grossMicroUsd ?? null,
        maximumPriceMicroUsd: maximumPolymarketPrice,
      },
      error: error === null ? null : errorDiagnostic(error),
    });
    try {
      jupiterQuoteAgeMs = reusableJupiterBuildAtMs === null
        ? null
        : Math.max(0, Date.now() - reusableJupiterBuildAtMs);
      reusedJupiterQuote = reusableJupiterBuild !== null && reusableJupiterBuildAtMs !== null &&
        isReusableJupiterEntryBuild(
          reusableJupiterBuild,
          reusableJupiterBuildAtMs,
          pair,
          jupiterDepositMicroUsd,
          this.#config.maximumReusableJupiterQuoteAgeMs,
        );
      build = reusedJupiterQuote && reusableJupiterBuild
        ? reusableJupiterBuild
        : await this.#jupiter.prepareBuy({
          marketId: pair.jupiterMarketId,
          depositAmountMicroUsd: jupiterDepositMicroUsd,
          isYes: expectedJupiterIsYes(pair),
          ...(pair.jupiterOutcomeMint ? { outcomeMint: pair.jupiterOutcomeMint } : {}),
        });
      buildAtMs = reusedJupiterQuote ? reusableJupiterBuildAtMs : Date.now();
      quotedContractsMicro = build.order.newContractsMicro;
      // Refresh the selected token's executable CLOB immediately before
      // signing. The websocket book is useful for discovery but should not be
      // the final authority for an irreversible FOK.
      const freshPolymarketBook = await this.#polymarket.fetchBuyAsks(pair.polymarketTokenId);
      executablePolymarketAsks = haircutBookLevels(
        freshPolymarketBook.asks,
        this.#config.polymarketDepthHaircutBps,
      );
      // The official SDK signs two-decimal shares, while the CLOB classifies a
      // posted FOK as a marketable BUY and additionally requires a whole-cent
      // collateral maker amount. Select the largest profitable price/size pair
      // that satisfies both constraints before either venue is submitted.
      polymarketContractsMicro = floorToPolymarketSharePrecision(
        guaranteedJupiterOutputContracts(build),
      );
      moveToStage("cross_venue_validation");
      let precisionSelectionStable = false;
      for (let pass = 0; pass < 8; pass += 1) {
        polymarketQuote = quoteBuyAcrossLevels(
          executablePolymarketAsks,
          polymarketContractsMicro,
          "polymarket",
        );
        if (!polymarketQuote) {
          rejectEntryPreflight(
            "POLYMARKET_DEPTH_CHANGED",
            "quoted Jupiter size exceeds visible Polymarket ladder depth",
            "market_changed",
          );
        }
        const profitablePriceCeiling = maximumConservativelyProfitablePolymarketPrice({
          quantityMicro: polymarketContractsMicro,
          jupiterAllInMicroUsd: build.order.orderCostMicroUsd + build.order.estimatedTotalFeeMicroUsd,
          displayedLimitPriceMicroUsd: polymarketQuote.limitPriceMicroUsd,
          maximumSlippageBps: this.#config.maximumSlippageBps,
          minimumEdgeMicroUsdPerContract: this.#config.strategy.minimumEntryEdgeMicroUsdPerContract,
          minimumEdgeTotalMicroUsd: this.#config.strategy.minimumEntryEdgeTotalMicroUsd,
          allowUnprofitable: forcedTestEntry,
        });
        const preciseOrder = largestPolymarketFokBuyAtValidPrecision({
          requestedContractsMicro: polymarketContractsMicro,
          minimumPriceMicroUsd: polymarketQuote.limitPriceMicroUsd,
          maximumPriceMicroUsd: profitablePriceCeiling,
        });
        if (preciseOrder.contractsMicro <= 0n) {
          rejectEntryPreflight(
            "POLYMARKET_FOK_AMOUNT_PRECISION_UNREACHABLE",
            "no marketable Polymarket FOK size satisfies the CLOB amount precision",
            "market_changed",
          );
        }
        maximumPolymarketPrice = preciseOrder.limitPriceMicroUsd;
        if (preciseOrder.contractsMicro === polymarketContractsMicro) {
          precisionSelectionStable = true;
          break;
        }
        polymarketContractsMicro = preciseOrder.contractsMicro;
      }
      if (!precisionSelectionStable || !polymarketQuote || maximumPolymarketPrice === null) {
        rejectEntryPreflight(
          "POLYMARKET_FOK_AMOUNT_PRECISION_UNSTABLE",
          "Polymarket FOK precision normalization did not converge",
          "transient",
        );
      }
      validateJupiterEntryBuild({
        build,
        pair,
        polymarketQuote,
        maximumPolymarketPriceMicroUsd: maximumPolymarketPrice,
        polymarketAvailableMicroUsd: polymarketAvailable,
        jupiterAvailableMicroUsd: maximum(0n, this.#jupiterCash()),
        config: this.#config,
        allowUnprofitable: forcedTestEntry,
      });
      moveToStage("venue_preparation");
      [polymarketBalanceBefore, preparedPolymarket, preparedJupiter] = await Promise.all([
        // BUY orders spend collateral; conditional-token allowances are only
        // needed for sells. Reading the token balance is sufficient to retain
        // exact ambiguous-response reconciliation without an irrelevant
        // allowance check on the entry hot path.
        this.#polymarket.getTokenBalance(pair.polymarketTokenId),
        this.#polymarket.prepareBuyFok({
          tokenId: pair.polymarketTokenId,
          contractsMicro: polymarketContractsMicro,
          grossAmountMicroUsd: polymarketQuote.grossMicroUsd,
          maximumPriceMicroUsd: maximumPolymarketPrice,
        }),
        // Sign the exact Jupiter build while preparing the Polymarket FOK. If
        // the observed fill matches and the quote is still fresh, only the
        // fast /execute call remains after Polymarket acknowledges its fill.
        this.#jupiter.prepareSubmission(build),
      ]);
      finishStage();
    } catch (error) {
      finishStage();
      const failure = classifyEntryPreflightFailure(error, stage);
      const preflight = diagnostics(stage, failure.code, failure.retryClass, failure.cooldownMs, error);
      return {
        type: "skip",
        reason: `CONCURRENT_ENTRY_PREFLIGHT[${stage}/${failure.code}]: ${errorMessage(error)}`,
        preflight,
      };
    }
    if (!build || !preparedJupiter || !preparedPolymarket || maximumPolymarketPrice === null) {
      throw new Error("entry preflight completed without all prepared venue artifacts");
    }
    const preflight = diagnostics("complete", "OK", "none", 0, null);
    const position: LivePosition = {
      id: `live-${++this.#state.sequence}`,
      pair,
      phase: "legs_submitting",
      enteredAtMs: Date.now(),
      jupiterOrderPubkey: build.order.orderPubkey,
      jupiterPositionPubkey: managedJupiterPositionPubkey(pair, build.order.positionPubkey),
      jupiterEntryPositionPubkey: build.order.positionPubkey,
      jupiterQuotedContractsMicro: build.order.newContractsMicro,
      jupiterExecutionReconciliationSource: null,
      jupiterContractsMicro: 0n,
      polymarketContractsMicro: 0n,
      jupiterEntryCostMicroUsd: 0n,
      polymarketEntryCostMicroUsd: 0n,
      remainingEntryCostMicroUsd: 0n,
      originalContractsMicro: 0n,
      realizedProfitMicroUsd: 0n,
      polymarketSettled: false,
      jupiterSettled: false,
      polymarketSettlementPayoutMicroUsd: 0n,
      jupiterSettlementPayoutMicroUsd: 0n,
      polymarketSettlementTransactionSignature: null,
      jupiterSettlementTransactionSignature: null,
      jupiterRentReclaimed: pair.jupiterOutcomeMint === undefined,
      jupiterRentReclaimedLamports: 0n,
      jupiterRentReclaimTransactionSignatures: [],
      entrySubmissionSkewMs: null,
      exitSubmissionSkewMs: null,
      diagnosticTestEntry: forcedTestEntry,
      lastError: null,
      settlementError: null,
    };
    if (forcedTestEntry) this.#state.forcedEntrySubmissionAttempted = true;
    this.#state.positions.push(position);
    await this.#save();

    const executionAttemptedAtMs = Date.now();
    const [polymarketResult] = await Promise.allSettled([
      this.#polymarket.submitPreparedFok(preparedPolymarket),
    ]) as [PromiseSettledResult<PolymarketLiveFill>];
    const observedPolymarket = await this.#recordPolymarketEntryResult(
      position,
      polymarketResult,
      polymarketBalanceBefore,
      maximumPolymarketPrice,
    );
    position.remainingEntryCostMicroUsd = position.polymarketEntryCostMicroUsd;
    await this.#save();

    // The Polymarket FOK targets an exact two-decimal share quantity; price
    // improvement reduces spend instead of increasing exposure. Use the
    // already-signed Jupiter build when it is still fresh and matches the
    // observed fill. Otherwise requote from the observed fill. This normally
    // leaves only /execute on the post-fill critical path without reviving
    // stale-build slippage failures.
    let jupiterResult: PromiseSettledResult<SubmittedJupiterOrder>;
    let jupiterSubmissionAttempted = false;
    let jupiterSigned = preparedJupiter !== null;
    let usedPreflightBuild = false;
    let quoteAgeAtSubmissionMs: number | null = null;
    let jupiterExecutionRetryCount = 0;
    let initialJupiterExecutionError: unknown | null = null;
    if (observedPolymarket <= CONTRACT_TOLERANCE_MICRO) {
      jupiterResult = {
        status: "rejected",
        reason: new JupiterSubmissionSkippedError(
          polymarketResult.status === "rejected" ? polymarketResult.reason : "zero Polymarket fill",
        ),
      };
    } else {
      try {
        const preflightBuildAgeMs = buildAtMs === null ? Number.POSITIVE_INFINITY : Date.now() - buildAtMs;
        if (preflightBuildAgeMs <= this.#config.maximumJupiterSubmissionQuoteAgeMs &&
          this.#validatePostFillJupiterHedge(
            pair,
            observedPolymarket,
            build,
            position.polymarketEntryCostMicroUsd,
            forcedTestEntry,
          )) {
          usedPreflightBuild = true;
        } else {
          build = await this.#prepareFreshJupiterHedge(
            pair,
            observedPolymarket,
            build,
            position.polymarketEntryCostMicroUsd,
            forcedTestEntry,
          );
          buildAtMs = Date.now();
          preparedJupiter = await this.#jupiter.prepareSubmission(build);
          jupiterSigned = true;
        }
        position.jupiterOrderPubkey = build.order.orderPubkey;
        position.jupiterPositionPubkey = managedJupiterPositionPubkey(pair, build.order.positionPubkey);
        position.jupiterEntryPositionPubkey = build.order.positionPubkey;
        position.jupiterQuotedContractsMicro = build.order.newContractsMicro;
        await this.#save();
        quoteAgeAtSubmissionMs = buildAtMs === null ? null : Math.max(0, Date.now() - buildAtMs);
        jupiterSubmissionAttempted = true;
        let submitted: SubmittedJupiterOrder;
        try {
          submitted = await this.#jupiter.submitPreparedAndWait(preparedJupiter, {
            timeoutMs: this.#config.jupiterFillTimeoutMs,
          });
        } catch (error) {
          if (!isExplicitJupiterSlippageFailure(error)) throw error;
          // 6001 is a definitive no-fill, so it is safe to build one new,
          // bounded transaction. Ambiguous transport failures are handled by
          // resubmitting the same requestId inside the Swap executor instead.
          initialJupiterExecutionError = error;
          jupiterExecutionRetryCount = 1;
          build = await this.#prepareFreshJupiterHedge(
            pair,
            observedPolymarket,
            build,
            position.polymarketEntryCostMicroUsd,
            forcedTestEntry,
          );
          buildAtMs = Date.now();
          preparedJupiter = await this.#jupiter.prepareSubmission(build);
          position.jupiterOrderPubkey = build.order.orderPubkey;
          position.jupiterPositionPubkey = managedJupiterPositionPubkey(pair, build.order.positionPubkey);
          position.jupiterEntryPositionPubkey = build.order.positionPubkey;
          position.jupiterQuotedContractsMicro = build.order.newContractsMicro;
          await this.#save();
          quoteAgeAtSubmissionMs = Math.max(0, Date.now() - buildAtMs);
          submitted = await this.#jupiter.submitPreparedAndWait(preparedJupiter, {
            timeoutMs: this.#config.jupiterFillTimeoutMs,
          });
        }
        jupiterResult = { status: "fulfilled", value: submitted };
      } catch (reason) {
        jupiterResult = { status: "rejected", reason };
      }
    }
    let status: JupiterPredictionOrderStatus | null = jupiterResult.status === "fulfilled"
      ? jupiterResult.value.status
      : null;
    if (!status && jupiterSubmissionAttempted && build.order.orderPubkey) {
      try {
        status = await this.#jupiter.waitForOrder(build.order.orderPubkey, {
          timeoutMs: this.#config.jupiterFillTimeoutMs,
        });
      } catch {
        // The durable intent and Polymarket balance reconciliation below preserve the ambiguous exposure.
      }
    }
    if (jupiterResult.status === "fulfilled" && polymarketResult.status === "fulfilled") {
      position.entrySubmissionSkewMs = absoluteNumber(
        jupiterResult.value.submissionStartedAtMs - polymarketResult.value.submissionStartedAtMs,
      );
    }
    // A rejected transport response with a positive reconciled token delta is
    // no longer ambiguous with respect to exposure; the conservative balance
    // reconciliation above is sufficient to hedge it.
    const polymarketAmbiguous = polymarketResult.status === "rejected" &&
      observedPolymarket <= CONTRACT_TOLERANCE_MICRO;
    const execution: LiveEntryExecutionDiagnostics = {
      attemptedAtMs: executionAttemptedAtMs,
      elapsedMs: Math.max(0, Date.now() - executionAttemptedAtMs),
      jupiter: {
        result: jupiterResult.status === "rejected" &&
            jupiterResult.reason instanceof JupiterSubmissionSkippedError
          ? "skipped"
          : jupiterResult.status,
        submissionAttempted: jupiterSubmissionAttempted,
        signed: jupiterSigned,
        executionPath: jupiterExecutionPath(build),
        endpoint: optionalString(build.execution.endpoint),
        requestId: jupiterBuildRequestId(build),
        usedPreflightBuild,
        quoteAgeAtSubmissionMs,
        retryCount: jupiterExecutionRetryCount,
        initialError: initialJupiterExecutionError === null
          ? null
          : errorDiagnostic(initialJupiterExecutionError),
        transactionSignature: jupiterResult.status === "fulfilled"
          ? jupiterResult.value.transactionSignature
          : null,
        orderStatus: status?.status ?? null,
        reconciliationSource: status?.reconciliationSource ?? null,
        quotedContractsMicro: build.order.newContractsMicro,
        filledContractsMicro: status?.filledContractsMicro ?? 0n,
        contractShortfallMicro: maximum(
          0n,
          build.order.newContractsMicro - (status?.filledContractsMicro ?? 0n),
        ),
        quotedCostMicroUsd: build.order.orderCostMicroUsd + build.order.estimatedTotalFeeMicroUsd,
        executedCostMicroUsd: status?.sizeMicroUsd ?? 0n,
        error: jupiterResult.status === "rejected" ? errorDiagnostic(jupiterResult.reason) : null,
      },
      polymarket: {
        result: polymarketResult.status,
        orderId: polymarketResult.status === "fulfilled" ? polymarketResult.value.orderId : null,
        reportedContractsMicro: polymarketResult.status === "fulfilled"
          ? polymarketResult.value.contractsMicro
          : 0n,
        observedContractsMicro: observedPolymarket,
        error: polymarketResult.status === "rejected" ? errorDiagnostic(polymarketResult.reason) : null,
      },
    };
    const haltWithDiagnostics = async (reason: string): Promise<LiveDecision> => ({
      ...await this.#halt(position, reason),
      preflight,
      execution,
    });
    const recoveryPlanWithDiagnostics = async (
      reason: string,
      plan: LivePostFillRiskPlan,
    ): Promise<LiveDecision> => ({
      ...await this.#quarantineForRecovery(position, reason, plan),
      preflight,
      execution,
    });
    if (!status) {
      const reason =
        `Sequential entry left Jupiter execution unresolved; Polymarket observed ` +
        `${formatContracts(observedPolymarket)} contracts: ` +
        settledError(jupiterResult);
      if (observedPolymarket <= CONTRACT_TOLERANCE_MICRO &&
        isTerminalJupiterExecutionRejection(jupiterResult) &&
        isTerminalZeroFillPolymarketResult(polymarketResult)) {
        position.lastError = reason;
        await this.#save();
        const recovery = await this.#recoverZeroExposureEntry(position, "entry_execution", reason);
        if (recovery) {
          return {
            type: "recovery",
            reason,
            positionId: position.id,
            preflight,
            execution,
            recovery,
          };
        }
      }
      if (observedPolymarket > CONTRACT_TOLERANCE_MICRO &&
        (!jupiterSubmissionAttempted || isTerminalJupiterExecutionRejection(jupiterResult))) {
        const recovery = await this.#recoverPolymarketOnlyEntry(
          position,
          polymarketResult,
          maximumPolymarketPrice,
          reason,
        );
        if (recovery) {
          return {
            type: "recovery",
            reason,
            positionId: position.id,
            preflight,
            execution,
            recovery,
          };
        }
      }
      return await haltWithDiagnostics(position.lastError ?? reason);
    }
    if (status.status === "pending") {
      return await haltWithDiagnostics(`Jupiter order ${status.orderPubkey} remains pending after submission`);
    }
    if (status.orderPubkey !== build.order.orderPubkey || status.positionPubkey !== build.order.positionPubkey ||
      status.marketId !== pair.jupiterMarketId || !status.isBuy || status.isYes !== expectedJupiterIsYes(pair)) {
      return await haltWithDiagnostics("Jupiter entry settlement identity does not match the prepared order");
    }
    if (status.filledContractsMicro > 0n) {
      position.jupiterContractsMicro = status.filledContractsMicro;
      position.jupiterExecutionReconciliationSource = status.reconciliationSource ?? null;
      // Atomic chain deltas and Swap /execute totals already contain the real
      // wallet debit. For keeper statuses, retain the conservative quoted fee
      // ceiling without adding that fee twice to a reconciled debit.
      const jupiterCost = isExecutedAmountReconciled(status)
        ? status.sizeMicroUsd
        : maximum(
            status.sizeMicroUsd,
            build.order.orderCostMicroUsd + build.order.estimatedTotalFeeMicroUsd,
          );
      position.jupiterEntryCostMicroUsd = jupiterCost;
      this.#state.jupiterCashMicroUsd = this.#jupiterCash() - jupiterCost;
    }
    position.remainingEntryCostMicroUsd = position.jupiterEntryCostMicroUsd + position.polymarketEntryCostMicroUsd;
    await this.#save();
    if (status.status === "failed" && status.filledContractsMicro <= CONTRACT_TOLERANCE_MICRO &&
      observedPolymarket <= CONTRACT_TOLERANCE_MICRO && isTerminalZeroFillPolymarketResult(polymarketResult)) {
      const reason = "Concurrent entry was terminally rejected by both venues with zero observed contracts";
      position.lastError = reason;
      await this.#save();
      const recovery = await this.#recoverZeroExposureEntry(position, "entry_execution", reason);
      if (recovery) {
        return {
          type: "recovery",
          reason,
          positionId: position.id,
          preflight,
          execution,
          recovery,
        };
      }
      return await haltWithDiagnostics(position.lastError ?? reason);
    }
    if (status.status === "failed" && status.filledContractsMicro <= CONTRACT_TOLERANCE_MICRO &&
      observedPolymarket > CONTRACT_TOLERANCE_MICRO) {
      const reason =
        `Jupiter hedge was terminally rejected with zero fill after Polymarket bought ` +
        `${formatContracts(observedPolymarket)} contracts`;
      const recovery = await this.#recoverPolymarketOnlyEntry(
        position,
        polymarketResult,
        maximumPolymarketPrice,
        reason,
      );
      if (recovery) {
        return {
          type: "recovery",
          reason,
          positionId: position.id,
          preflight,
          execution,
          recovery,
        };
      }
      return await haltWithDiagnostics(position.lastError ?? reason);
    }
    if (polymarketAmbiguous) {
      return await haltWithDiagnostics(
        `Polymarket concurrent-entry response was ambiguous: ${settledError(polymarketResult)}`,
      );
    }
    if (position.jupiterContractsMicro <= 0n || position.polymarketContractsMicro <= 0n) {
      const reason = "Entry produced a fully reconciled one-sided fill; no unpriced buy catch-up was attempted";
      return await recoveryPlanWithDiagnostics(
        reason,
        buildPostFillRiskPlan(position, this.#config.strategy, true),
      );
    }
    const retainedSizeMismatch = absolute(
      position.jupiterContractsMicro - position.polymarketContractsMicro,
    );
    const matchedContractsMicro = minimum(
      position.jupiterContractsMicro,
      position.polymarketContractsMicro,
    );
    const retainedSizeMismatchBps = matchedContractsMicro > 0n
      ? retainedSizeMismatch * 10_000n / matchedContractsMicro
      : 10_000n;
    const actualPayoffs = actualEntryPayoffs(position);
    const postFillRiskPlan = buildPostFillRiskPlan(position, this.#config.strategy);
    position.postFillRiskPlan = postFillRiskPlan;
    const actualEdgePerContract = matchedContractsMicro > 0n
      ? actualPayoffs.minimumPnlMicroUsd * ONE_CONTRACT_MICRO / matchedContractsMicro
      : -ONE_USD_MICRO;
    if (!forcedTestEntry && (
      retainedSizeMismatchBps > MAXIMUM_POST_FILL_HEDGE_MISMATCH_BPS ||
      actualPayoffs.minimumPnlMicroUsd < this.#config.strategy.minimumEntryEdgeTotalMicroUsd ||
      actualEdgePerContract < this.#config.strategy.minimumEntryEdgeMicroUsdPerContract
    )) {
      return await recoveryPlanWithDiagnostics(
        `${OBSERVED_ENTRY_SIZE_MISMATCH}: quoted Jupiter ` +
        `${formatContracts(position.jupiterQuotedContractsMicro ?? 0n)}, executed Jupiter ` +
        `${formatContracts(position.jupiterContractsMicro)}, executed Polymarket ` +
        `${formatContracts(position.polymarketContractsMicro)}, actual Poly-win P&L ` +
        `$${formatUsd(actualPayoffs.polymarketWinPnlMicroUsd)}, actual Jupiter-win P&L ` +
        `$${formatUsd(actualPayoffs.jupiterWinPnlMicroUsd)}, both-win P&L ` +
        `$${formatUsd(actualPayoffs.bothWinPnlMicroUsd)}, both-lose P&L ` +
        `$${formatUsd(actualPayoffs.bothLosePnlMicroUsd)}, skew ` +
        `${Number(retainedSizeMismatchBps) / 100}%`,
        postFillRiskPlan,
      );
    }
    position.originalContractsMicro = minimum(position.jupiterContractsMicro, position.polymarketContractsMicro);
    position.phase = "open";
    this.#lastAction = `LIVE ENTRY ${pair.duration}: ${formatContracts(position.originalContractsMicro)} contracts, ` +
      `$${formatUsd(position.remainingEntryCostMicroUsd)} recorded all-in, submissions ` +
      `${position.entrySubmissionSkewMs ?? "unknown"}ms apart.` +
      (retainedSizeMismatch > CONTRACT_TOLERANCE_MICRO
        ? ` Retaining ${formatContracts(retainedSizeMismatch)} contract venue-size skew through resolution.`
        : "") +
      ` Four-state oracle-divergence floor: $${formatUsd(actualPayoffs.bothLosePnlMicroUsd)}.`;
    await this.#save();
    return { type: "entry", position, preflight, execution };
  }

  async #prepareFreshJupiterHedge(
    pair: LivePairIdentity,
    targetContractsMicro: bigint,
    seedBuild: JupiterPredictionOrderBuild,
    polymarketEntryCostMicroUsd: bigint,
    allowEmergencyLoss: boolean,
  ): Promise<JupiterPredictionOrderBuild> {
    if (targetContractsMicro <= CONTRACT_TOLERANCE_MICRO || seedBuild.order.newContractsMicro <= 0n) {
      throw new Error("Cannot size a Jupiter hedge from a zero contract quote or fill");
    }
    let depositAmountMicroUsd = roundedScale(
      seedBuild.order.orderCostMicroUsd,
      targetContractsMicro,
      guaranteedJupiterOutputContracts(seedBuild),
    );
    let latest: JupiterPredictionOrderBuild | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const maximumJupiterSpend = minimum(
        maximum(0n, this.#jupiterCash()),
        this.#config.strategy.jupiterMaximumAllocationMicroUsd,
      );
      // The entry proposal already passed the configured gross floor. Small
      // post-fill reductions are permitted because Forecast Swap V2 supports
      // them and exact hedge sizing is safer than rounding back up to a stale
      // strategy floor.
      if (depositAmountMicroUsd > maximumJupiterSpend) {
        throw new Error(
          `POST_FILL_HEDGE_EXCEEDS_JUPITER_CASH_OR_ALLOCATION: required ` +
          `$${formatUsd(depositAmountMicroUsd)}, available $${formatUsd(maximumJupiterSpend)}`,
        );
      }
      latest = await this.#preparePostFillJupiterBuy(pair, depositAmountMicroUsd);
      if (this.#validatePostFillJupiterHedge(
        pair,
        targetContractsMicro,
        latest,
        polymarketEntryCostMicroUsd,
        allowEmergencyLoss,
      )) return latest;
      let nextDeposit = roundedScale(
        depositAmountMicroUsd,
        targetContractsMicro,
        guaranteedJupiterOutputContracts(latest),
      );
      if (nextDeposit === depositAmountMicroUsd) {
        nextDeposit += guaranteedJupiterOutputContracts(latest) < targetContractsMicro ? 1n : -1n;
      }
      depositAmountMicroUsd = maximum(1n, nextDeposit);
    }
    throw new Error(
      `POST_FILL_HEDGE_SIZE_MISMATCH: target ${formatContracts(targetContractsMicro)}, latest Jupiter ` +
      `${formatContracts(latest?.order.newContractsMicro ?? 0n)} exceeds the ` +
      `${Number(MAXIMUM_POST_FILL_HEDGE_MISMATCH_BPS) / 100}% normalization limit after 3 fresh quotes`,
    );
  }

  #validatePostFillJupiterHedge(
    pair: LivePairIdentity,
    targetContractsMicro: bigint,
    build: JupiterPredictionOrderBuild,
    polymarketEntryCostMicroUsd: bigint,
    allowEmergencyLoss: boolean,
  ): boolean {
    if (build.order.marketId !== pair.jupiterMarketId || !build.order.isBuy ||
      build.order.isYes !== expectedJupiterIsYes(pair)) {
      throw new Error("POST_FILL_HEDGE_IDENTITY_MISMATCH: Jupiter returned the wrong market or outcome");
    }
    if (pair.jupiterOutcomeMint &&
      (build.executionModel !== "atomic_swap" || build.settlement !== "auto")) {
      throw new Error("POST_FILL_HEDGE_NOT_ATOMIC: Forecast hedge is not an atomic auto-settling swap");
    }
    if (build.order.contractsMicro !== build.order.newContractsMicro ||
      build.order.newContractsMicro <= 0n) {
      throw new Error("POST_FILL_HEDGE_INVALID_POSITION_SIZE: quote includes an existing or zero position");
    }
    const maximumJupiterSpend = minimum(
      maximum(0n, this.#jupiterCash()),
      this.#config.strategy.jupiterMaximumAllocationMicroUsd,
    );
    const jupiterAllIn = build.order.orderCostMicroUsd + build.order.estimatedTotalFeeMicroUsd;
    if (jupiterAllIn > maximumJupiterSpend) {
      throw new Error(
        `POST_FILL_HEDGE_EXCEEDS_JUPITER_CASH_OR_ALLOCATION: quoted ` +
        `$${formatUsd(jupiterAllIn)}, available $${formatUsd(maximumJupiterSpend)}`,
      );
    }
    const quotedContractsMicro = guaranteedJupiterOutputContracts(build);
    const sizeDifference = absolute(quotedContractsMicro - targetContractsMicro);
    const mismatchBps = sizeDifference * 10_000n / targetContractsMicro;

    const matchedContractsMicro = minimum(quotedContractsMicro, targetContractsMicro);
    const matchedPolymarketCost = polymarketEntryCostMicroUsd * matchedContractsMicro /
      targetContractsMicro;
    const matchedJupiterCost = jupiterAllIn * matchedContractsMicro / quotedContractsMicro;
    const unmatchedEntryCost = quotedContractsMicro > targetContractsMicro
      ? jupiterAllIn - matchedJupiterCost
      : polymarketEntryCostMicroUsd - matchedPolymarketCost;
    // Once Polymarket has filled, this is exposure management—not a new entry.
    // Reserve normalization slippage and execute any hedge whose conservative
    // loss stays inside the explicit emergency budget. Reapplying the normal
    // entry-profit floor here caused the observed naked Polymarket position.
    const normalizationRisk = (
      unmatchedEntryCost * BigInt(this.#config.maximumSlippageBps) + 9_999n
    ) / 10_000n;
    const conservativeEdge = matchedContractsMicro - matchedPolymarketCost - matchedJupiterCost -
      normalizationRisk;
    // Once Polymarket has filled, its entry cost is already at risk. Treat the
    // configured emergency-loss value as the normal recovery budget, but do
    // not reject a size-matched Jupiter hedge that limits the modeled loss to
    // no more than the naked Polymarket stake. This avoids leaving a much
    // larger directional exposure because a locked hedge loss missed the soft
    // budget by a few cents. Cash, allocation, identity and size limits above
    // remain hard gates.
    const maximumPostFillHedgeLossMicroUsd = maximum(
      this.#config.maximumEmergencyHedgeLossMicroUsd,
      polymarketEntryCostMicroUsd,
    );
    if (!allowEmergencyLoss && conservativeEdge < -maximumPostFillHedgeLossMicroUsd) {
      throw new Error(
        `POST_FILL_HEDGE_LOSS_LIMIT_EXCEEDED: edge=$${formatUsd(conservativeEdge)}, ` +
        `maximumLoss=$${formatUsd(maximumPostFillHedgeLossMicroUsd)}, ` +
        `configuredBase=$${formatUsd(this.#config.maximumEmergencyHedgeLossMicroUsd)}, ` +
        `nakedPolymarketStake=$${formatUsd(polymarketEntryCostMicroUsd)}`,
      );
    }
    // Reject a clearly loss-making partial quote immediately. Otherwise, a
    // large price move would be reported as an allocation failure only after
    // pointlessly scaling the quote toward the now-unacceptable target size.
    if (sizeDifference > CONTRACT_TOLERANCE_MICRO &&
      mismatchBps > MAXIMUM_POST_FILL_HEDGE_MISMATCH_BPS) return false;
    return true;
  }

  async #preparePostFillJupiterBuy(
    pair: LivePairIdentity,
    depositAmountMicroUsd: bigint,
  ): Promise<JupiterPredictionOrderBuild> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= POST_FILL_JUPITER_RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.#jupiter.prepareBuy({
          marketId: pair.jupiterMarketId,
          depositAmountMicroUsd,
          isYes: expectedJupiterIsYes(pair),
          ...(pair.jupiterOutcomeMint ? { outcomeMint: pair.jupiterOutcomeMint } : {}),
        });
      } catch (error) {
        lastError = error;
        const rateLimitDelayMs = error instanceof HttpError ? error.retryDelayMs : null;
        const retryDelayMs = rateLimitDelayMs !== null && rateLimitDelayMs !== undefined
          ? rateLimitDelayMs + 50
          : POST_FILL_JUPITER_RATE_LIMIT_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined || !isRateLimitError(error)) break;
        await waitMilliseconds(retryDelayMs);
      }
    }
    throw new Error(`POST_FILL_HEDGE_QUOTE_FAILED: ${errorMessage(lastError)}`, {
      cause: lastError,
    });
  }

  async #recordPolymarketEntryResult(
    position: LivePosition,
    result: PromiseSettledResult<PolymarketLiveFill>,
    balanceBefore: bigint,
    maximumPriceMicroUsd: bigint,
  ): Promise<bigint> {
    if (result.status === "rejected") {
      return await this.#recordObservedPolymarketEntry(position, balanceBefore, maximumPriceMicroUsd);
    }
    const fill = result.value;
    const actualPrice = fill.contractsMicro > 0n
      ? fill.grossMicroUsd * ONE_CONTRACT_MICRO / fill.contractsMicro
      : maximumPriceMicroUsd;
    const cost = fill.grossMicroUsd + polymarketFee(actualPrice, fill.contractsMicro);
    position.polymarketContractsMicro = fill.contractsMicro;
    position.polymarketEntryCostMicroUsd = cost;
    this.#state.polymarketCashMicroUsd = this.#polymarketCash() - cost;
    return fill.contractsMicro;
  }

  async #recordObservedPolymarketEntry(
    position: LivePosition,
    balanceBefore: bigint,
    maximumPriceMicroUsd: bigint,
  ): Promise<bigint> {
    const balanceAfter = await this.#polymarket.getTokenBalance(position.pair.polymarketTokenId);
    const observed = maximum(0n, balanceAfter - balanceBefore);
    if (observed > 0n) {
      const conservativeCost = tradeGross(maximumPriceMicroUsd, observed) +
        polymarketFee(maximumPriceMicroUsd, observed);
      position.polymarketContractsMicro = observed;
      position.polymarketEntryCostMicroUsd = conservativeCost;
      this.#state.polymarketCashMicroUsd = this.#polymarketCash() - conservativeCost;
      position.remainingEntryCostMicroUsd = position.jupiterEntryCostMicroUsd + conservativeCost;
      await this.#save();
    }
    return observed;
  }

  async #tryExit(
    position: LivePosition,
    polymarketBook: BinaryOrderBook,
    jupiterBook: BinaryOrderBook,
  ): Promise<LiveDecision> {
    if (absolute(position.polymarketContractsMicro - position.jupiterContractsMicro) >
      CONTRACT_TOLERANCE_MICRO) {
      return {
        type: "hold",
        reason: "VENUE_SIZE_MISMATCH_HELD_TO_RESOLUTION",
        position,
      };
    }
    const quantity = minimum(position.polymarketContractsMicro, position.jupiterContractsMicro);
    const evaluation = evaluateShortWindowExit({
      polymarketBook,
      jupiterBook,
      polymarketOutcome: position.pair.polymarketOutcome,
      jupiterOutcome: position.pair.jupiterOutcome,
      quantityMicro: quantity,
      entryAllInCostMicroUsd: position.remainingEntryCostMicroUsd,
      minimumExitProfitMicroUsd: this.#config.strategy.minimumExitProfitMicroUsd,
    });
    if (!evaluation.eligible) return { type: "hold", reason: evaluation.reason, position };
    this.#busy = true;
    try {
      const build = await this.#jupiter.prepareClose(position.jupiterPositionPubkey);
      if (build.executionModel !== "atomic_swap" && !build.order.orderPubkey) {
        return { type: "hold", reason: "JUPITER_CLOSE_NOT_EXECUTABLE", position };
      }
      if (build.order.positionPubkey !== position.jupiterPositionPubkey ||
        build.order.marketId !== position.pair.jupiterMarketId || build.order.isBuy ||
        build.order.isYes !== expectedJupiterIsYes(position.pair) ||
        absolute(build.order.contractsMicro - position.jupiterContractsMicro) > CONTRACT_TOLERANCE_MICRO) {
        return { type: "hold", reason: "JUPITER_CLOSE_IDENTITY_OR_SIZE_MISMATCH", position };
      }
      const jupiterMinimumPrice = build.order.minSellPriceMicroUsd;
      if (jupiterMinimumPrice === null) return { type: "hold", reason: "JUPITER_CLOSE_HAS_NO_MINIMUM_PRICE", position };
      const expectedJupiterGross = tradeGross(jupiterMinimumPrice, quantity);
      const polymarketMinimumPrice = applyBps(
        evaluation.proposal.polymarketBid.priceMicroUsd,
        this.#config.maximumSlippageBps,
        "down",
      );
      const expectedPolyGross = tradeGross(polymarketMinimumPrice, quantity);
      const conservativePolyFee = polymarketFee(polymarketMinimumPrice, quantity);
      const expectedNet = expectedJupiterGross + expectedPolyGross - build.order.estimatedTotalFeeMicroUsd -
        conservativePolyFee;
      if (expectedNet - position.remainingEntryCostMicroUsd < this.#config.strategy.minimumExitProfitMicroUsd) {
        return { type: "hold", reason: "LIVE_EXIT_QUOTE_NOT_GREEN", position };
      }
      const jupiterContractsBefore = position.jupiterContractsMicro;
      const polymarketContractsBefore = position.polymarketContractsMicro;
      let preparedJupiter: PreparedJupiterSubmission;
      let preparedPolymarket: PreparedPolymarketFokOrder;
      try {
        [preparedJupiter, preparedPolymarket] = await Promise.all([
          this.#jupiter.prepareSubmission(build),
          this.#polymarket.prepareSellFok({
            tokenId: position.pair.polymarketTokenId,
            contractsMicro: quantity,
            minimumPriceMicroUsd: polymarketMinimumPrice,
          }),
        ]);
      } catch (error) {
        return { type: "hold", reason: `CONCURRENT_EXIT_PREFLIGHT: ${errorMessage(error)}`, position };
      }

      const polyBalanceBefore = await this.#polymarket.getTokenBalance(position.pair.polymarketTokenId);
      position.phase = "legs_submitting";
      await this.#save();
      const [jupiterResult, polymarketResult] = await settleTogether(
        () => this.#jupiter.submitPreparedAndWait(preparedJupiter, { timeoutMs: this.#config.jupiterFillTimeoutMs }),
        () => this.#polymarket.submitPreparedFok(preparedPolymarket),
      );
      if (jupiterResult.status === "fulfilled" && polymarketResult.status === "fulfilled") {
        position.exitSubmissionSkewMs = absoluteNumber(
          jupiterResult.value.submissionStartedAtMs - polymarketResult.value.submissionStartedAtMs,
        );
      }
      let status: JupiterPredictionOrderStatus | null = jupiterResult.status === "fulfilled"
        ? jupiterResult.value.status
        : null;
      if (!status && build.order.orderPubkey) {
        try {
          status = await this.#jupiter.waitForOrder(build.order.orderPubkey, {
            timeoutMs: this.#config.jupiterFillTimeoutMs,
          });
        } catch {
          // Polymarket is still reconciled below before the trader halts.
        }
      }
      const polyExit = await this.#recordPolymarketExitResult(
        position,
        polymarketResult,
        polyBalanceBefore,
        polymarketContractsBefore,
        polymarketMinimumPrice,
      );
      if (!status) {
        return await this.#halt(
          position,
          `Concurrent exit left Jupiter execution unresolved; Polymarket observed ` +
          `${formatContracts(polyExit.contractsMicro)} contracts sold: ${settledError(jupiterResult)}`,
        );
      }
      if (status.orderPubkey !== build.order.orderPubkey ||
        status.positionPubkey !== position.jupiterPositionPubkey ||
        status.marketId !== position.pair.jupiterMarketId || status.isBuy ||
        status.isYes !== expectedJupiterIsYes(position.pair)) {
        return await this.#halt(position, "Jupiter close settlement identity does not match the prepared order");
      }
      const sold = status.filledContractsMicro;
      if (sold > jupiterContractsBefore + CONTRACT_TOLERANCE_MICRO) {
        return await this.#halt(position, "Jupiter close fill exceeds the recorded Jupiter position");
      }
      const jupiterEntryPortion = jupiterContractsBefore > 0n
        ? position.jupiterEntryCostMicroUsd * sold / jupiterContractsBefore
        : position.jupiterEntryCostMicroUsd;
      const jupiterExecutionFeeMicroUsd = isExecutedAmountReconciled(status)
        ? 0n
        : build.order.estimatedTotalFeeMicroUsd;
      const jupiterGross = isExecutedAmountReconciled(status)
        ? status.sizeMicroUsd
        : tradeGross(status.averageFillPriceMicroUsd, sold);
      if (sold > 0n) {
        this.#state.jupiterCashMicroUsd = this.#jupiterCash() + jupiterGross - jupiterExecutionFeeMicroUsd;
        position.jupiterContractsMicro = maximum(0n, position.jupiterContractsMicro - sold);
        position.jupiterEntryCostMicroUsd = maximum(0n, position.jupiterEntryCostMicroUsd - jupiterEntryPortion);
        position.remainingEntryCostMicroUsd = maximum(
          0n,
          position.remainingEntryCostMicroUsd - jupiterEntryPortion,
        );
      }
      await this.#save();
      if (polymarketResult.status === "rejected") {
        return await this.#halt(
          position,
          `Polymarket concurrent-exit response was ambiguous: ${settledError(polymarketResult)}`,
        );
      }
      if (status.status === "pending") {
        return await this.#halt(position, "Jupiter close remains pending after concurrent submission");
      }
      if (sold <= 0n || polyExit.contractsMicro <= 0n) {
        if (sold <= 0n && polyExit.contractsMicro <= 0n) {
          position.phase = "open";
          await this.#save();
          return { type: "hold", reason: "CONCURRENT_EXIT_BOTH_UNFILLED", position };
        }
        return await this.#halt(position, "Concurrent exit filled only one venue");
      }
      if (absolute(polyExit.contractsMicro - sold) > CONTRACT_TOLERANCE_MICRO) {
        return await this.#halt(position, "Concurrent exit fills do not have matching sizes");
      }
      const entryPortion = jupiterEntryPortion + polyExit.entryPortionMicroUsd;
      const realized = jupiterGross + polyExit.grossMicroUsd - jupiterExecutionFeeMicroUsd -
        polyExit.feeMicroUsd - entryPortion;
      position.originalContractsMicro = maximum(0n, position.originalContractsMicro - sold);
      position.realizedProfitMicroUsd += realized;
      this.#state.realizedProfitMicroUsd += realized;
      if (position.jupiterContractsMicro <= CONTRACT_TOLERANCE_MICRO &&
        position.polymarketContractsMicro <= CONTRACT_TOLERANCE_MICRO) {
        this.#state.positions = this.#state.positions.filter((candidate) => candidate.id !== position.id);
        this.#state.completedPairs.push(position.pair.key);
      } else {
        position.phase = "open";
      }
      this.#lastAction = `LIVE EXIT ${position.pair.duration}: realized $${formatUsd(realized)}, submissions ` +
        `${position.exitSubmissionSkewMs ?? "unknown"}ms apart.`;
      await this.#save();
      return {
        type: "exit",
        positionId: position.id,
        realizedProfitMicroUsd: realized,
        submissionSkewMs: position.exitSubmissionSkewMs,
      };
    } catch (error) {
      return await this.#halt(position, `Live exit became ambiguous: ${errorMessage(error)}`);
    } finally {
      this.#busy = false;
    }
  }

  async #recordPolymarketExitResult(
    position: LivePosition,
    result: PromiseSettledResult<PolymarketLiveFill>,
    balanceBefore: bigint,
    contractsBefore: bigint,
    minimumPriceMicroUsd: bigint,
  ): Promise<{
    contractsMicro: bigint;
    grossMicroUsd: bigint;
    feeMicroUsd: bigint;
    entryPortionMicroUsd: bigint;
  }> {
    let contractsMicro: bigint;
    let grossMicroUsd: bigint;
    let feeMicroUsd: bigint;
    if (result.status === "fulfilled") {
      contractsMicro = result.value.contractsMicro;
      grossMicroUsd = result.value.grossMicroUsd;
      const actualPrice = contractsMicro > 0n
        ? grossMicroUsd * ONE_CONTRACT_MICRO / contractsMicro
        : minimumPriceMicroUsd;
      feeMicroUsd = polymarketFee(actualPrice, contractsMicro);
    } else {
      const balanceAfter = await this.#polymarket.getTokenBalance(position.pair.polymarketTokenId);
      contractsMicro = maximum(0n, balanceBefore - balanceAfter);
      grossMicroUsd = tradeGross(minimumPriceMicroUsd, contractsMicro);
      feeMicroUsd = polymarketFee(minimumPriceMicroUsd, contractsMicro);
    }
    const entryPortionMicroUsd = contractsBefore > 0n
      ? position.polymarketEntryCostMicroUsd * contractsMicro / contractsBefore
      : position.polymarketEntryCostMicroUsd;
    if (contractsMicro > 0n) {
      this.#state.polymarketCashMicroUsd = this.#polymarketCash() + grossMicroUsd - feeMicroUsd;
      position.polymarketContractsMicro = maximum(0n, position.polymarketContractsMicro - contractsMicro);
      position.polymarketEntryCostMicroUsd = maximum(
        0n,
        position.polymarketEntryCostMicroUsd - entryPortionMicroUsd,
      );
      position.remainingEntryCostMicroUsd = maximum(
        0n,
        position.remainingEntryCostMicroUsd - entryPortionMicroUsd,
      );
      await this.#save();
    }
    return { contractsMicro, grossMicroUsd, feeMicroUsd, entryPortionMicroUsd };
  }

  async #recoverPolymarketOnlyEntry(
    position: LivePosition,
    entryResult: PromiseSettledResult<PolymarketLiveFill>,
    maximumEntryPriceMicroUsd: bigint,
    reason: string,
    source: LiveRecoverySource = "entry_execution",
  ): Promise<LiveRecoveryDiagnostics | null> {
    if (position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO ||
      position.polymarketContractsMicro <= CONTRACT_TOLERANCE_MICRO) {
      return null;
    }
    try {
      const originalPolymarketContractsMicro = position.polymarketContractsMicro;
      const entryGrossMicroUsd = entryResult.status === "fulfilled"
        ? entryResult.value.grossMicroUsd
        : tradeGross(maximumEntryPriceMicroUsd, originalPolymarketContractsMicro);
      const entryAveragePriceMicroUsd = entryGrossMicroUsd > 0n
        ? entryGrossMicroUsd * ONE_CONTRACT_MICRO / originalPolymarketContractsMicro
        : maximumEntryPriceMicroUsd;
      const minimumExitPriceMicroUsd = maximum(
        POLYMARKET_PRICE_TICK_MICRO_USD,
        applyBps(entryAveragePriceMicroUsd, this.#config.maximumSlippageBps, "down"),
      );
      const balanceBefore = await this.#waitForPolymarketUnwindBalance(
        position.pair.polymarketTokenId,
        originalPolymarketContractsMicro,
      );
      const prepared = await this.#polymarket.prepareSellFok({
        tokenId: position.pair.polymarketTokenId,
        contractsMicro: originalPolymarketContractsMicro,
        minimumPriceMicroUsd: minimumExitPriceMicroUsd,
      });
      const [result] = await Promise.allSettled([
        this.#polymarket.submitPreparedFok(prepared),
      ]) as [PromiseSettledResult<PolymarketLiveFill>];
      const exit = await this.#recordPolymarketExitResult(
        position,
        result,
        balanceBefore,
        originalPolymarketContractsMicro,
        minimumExitPriceMicroUsd,
      );
      if (exit.contractsMicro <= CONTRACT_TOLERANCE_MICRO ||
        position.polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO) {
        throw new Error(
          `Polymarket unwind did not remove the observed exposure: ${settledError(result)}`,
        );
      }
      const realized = exit.grossMicroUsd - exit.feeMicroUsd - exit.entryPortionMicroUsd;
      position.realizedProfitMicroUsd += realized;
      this.#state.realizedProfitMicroUsd += realized;
      this.#state.positions = this.#state.positions.filter((candidate) => candidate.id !== position.id);
      this.#entryPreflightCooldowns.set(position.pair.key, {
        untilMs: Date.now() + MARKET_CHANGE_COOLDOWN_MS,
        stage: "venue_preparation",
        code: "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND",
      });
      const remainingAmbiguous = this.#state.positions.find((candidate) =>
        !isManagedKnownPosition(candidate)
      );
      if (!remainingAmbiguous) {
        this.#state.halted = false;
        this.#state.haltReason = null;
      }
      const recovery: LiveRecoveryDiagnostics = {
        code: "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND",
        source,
        recoveredAtMs: Date.now(),
        positionId: position.id,
        pairKey: position.pair.key,
        duration: position.pair.duration,
        reason,
        observedPolymarketContractsMicro: originalPolymarketContractsMicro,
        observedJupiterContractsMicro: 0n,
      };
      this.#lastAction = `AUTO RECOVERY ${position.pair.duration}: sold the Polymarket-only fill after the ` +
        `Jupiter hedge failed; realized $${formatUsd(realized)}.`;
      await this.#save();
      return recovery;
    } catch (error) {
      // If the exact-share unwind cannot fill within the configured slippage,
      // retain the reconciled exposure and halt. Automatic recovery must never
      // turn a known one-sided position into an unknown one.
      position.lastError = `${primaryEntryFailureReason(reason)}; automatic Polymarket unwind failed: ` +
        errorMessage(error);
      await this.#save();
      return null;
    }
  }

  async #waitForPolymarketUnwindBalance(tokenId: string, contractsMicro: bigint): Promise<bigint> {
    // Market SELL maker amounts are cent-precision shares. Waiting for that
    // executable amount avoids blocking on harmless sub-cent share dust.
    const requiredBalanceMicro = contractsMicro / 10_000n * 10_000n;
    const deadlineMs = Date.now() + this.#config.jupiterFillTimeoutMs;
    let latestBalanceMicro = 0n;
    let lastError: unknown = null;
    while (true) {
      try {
        latestBalanceMicro = await this.#polymarket.refreshTokenBalance(tokenId);
        lastError = null;
        if (latestBalanceMicro >= requiredBalanceMicro) return latestBalanceMicro;
      } catch (error) {
        lastError = error;
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `POLYMARKET_UNWIND_BALANCE_NOT_VISIBLE: need ${formatContracts(requiredBalanceMicro)} ` +
          `contracts, refreshed balance ${formatContracts(latestBalanceMicro)}` +
          (lastError ? `; last refresh failed: ${errorMessage(lastError)}` : ""),
          lastError === null ? undefined : { cause: lastError },
        );
      }
      await waitMilliseconds(Math.min(POLYMARKET_RECOVERY_BALANCE_POLL_MS, remainingMs));
    }
  }

  async #recoverPersistedZeroExposureEntries(
    source: Extract<LiveRecoverySource, "startup" | "runtime">,
  ): Promise<LiveRecoveryDiagnostics[]> {
    const recoveries: LiveRecoveryDiagnostics[] = [];
    for (const position of [...this.#state.positions]) {
      if (!isPersistedZeroExposureEntryRecoveryCandidate(position, Date.now())) continue;
      const recovery = await this.#recoverZeroExposureEntry(
        position,
        source,
        position.lastError ?? "terminal concurrent-entry failure",
      );
      if (recovery) recoveries.push(recovery);
    }
    return recoveries;
  }

  async #recoverPersistedPolymarketOnlyEntries(
    source: Extract<LiveRecoverySource, "startup" | "runtime">,
    persistedPolymarketCashMicroUsd: bigint | null,
  ): Promise<LiveRecoveryDiagnostics[]> {
    const candidates = this.#state.positions.filter((position) =>
      isPersistedJupiterUnresolvedReconciliationCandidate(position)
    );
    const recoveries: LiveRecoveryDiagnostics[] = [];
    for (const position of candidates) {
      const [observedBalance, observedJupiter] = await Promise.all([
        this.#polymarket.refreshTokenBalance(position.pair.polymarketTokenId),
        this.#jupiter.getPosition(position.jupiterPositionPubkey),
      ]);
      if (observedJupiter.positionPubkey !== position.jupiterPositionPubkey ||
        observedJupiter.marketId !== position.pair.jupiterMarketId ||
        observedJupiter.isYes !== expectedJupiterIsYes(position.pair)) {
        continue;
      }
      if (observedJupiter.contractsMicro > CONTRACT_TOLERANCE_MICRO) continue;
      const recordedContractsMicro = position.polymarketContractsMicro;
      if (position.phase === "exposure_error" && Date.now() < position.pair.endMs &&
        (observedBalance > CONTRACT_TOLERANCE_MICRO ||
          isPolymarketUnwindBalanceVisibilityFailure(position.lastError))) {
        const conservativeEntryPriceMicroUsd = minimum(
          ONE_USD_MICRO,
          position.polymarketEntryCostMicroUsd * ONE_CONTRACT_MICRO / recordedContractsMicro,
        );
        const recovery = await this.#recoverPolymarketOnlyEntry(
          position,
          { status: "rejected", reason: new Error("retrying persisted Polymarket-only entry") },
          conservativeEntryPriceMicroUsd,
          position.lastError ?? "persisted Polymarket-only entry",
          source,
        );
        if (recovery) recoveries.push(recovery);
        continue;
      }
      if (observedBalance > CONTRACT_TOLERANCE_MICRO ||
        isPolymarketUnwindBalanceVisibilityFailure(position.lastError)) continue;
      const conservativeExitPriceMicroUsd = applyBps(
        position.polymarketEntryCostMicroUsd * ONE_CONTRACT_MICRO / recordedContractsMicro,
        this.#config.maximumSlippageBps,
        "down",
      );
      const conservativeNetProceedsMicroUsd = tradeGross(
        conservativeExitPriceMicroUsd,
        recordedContractsMicro,
      ) - polymarketFee(conservativeExitPriceMicroUsd, recordedContractsMicro);
      // With a single recovered entry, the wallet delta from the persisted
      // post-entry balance is the most accurate net exit result. Clamp it to
      // the contract payout so an unrelated wallet deposit cannot inflate P&L.
      const observedNetProceedsMicroUsd = candidates.length === 1 &&
          persistedPolymarketCashMicroUsd !== null
        ? minimum(
            recordedContractsMicro,
            maximum(0n, this.#polymarketCash() - persistedPolymarketCashMicroUsd),
          )
        : conservativeNetProceedsMicroUsd;
      const realized = observedNetProceedsMicroUsd - position.polymarketEntryCostMicroUsd;
      position.realizedProfitMicroUsd += realized;
      this.#state.realizedProfitMicroUsd += realized;
      this.#state.positions = this.#state.positions.filter((candidate) => candidate.id !== position.id);
      const recovery: LiveRecoveryDiagnostics = {
        code: "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND",
        source,
        recoveredAtMs: Date.now(),
        positionId: position.id,
        pairKey: position.pair.key,
        duration: position.pair.duration,
        reason: `Wallet reconciliation found ${formatContracts(observedBalance)} residual Polymarket ` +
          `contracts after an ambiguous automatic unwind response`,
        observedPolymarketContractsMicro: observedBalance,
        observedJupiterContractsMicro: observedJupiter.contractsMicro,
      };
      recoveries.push(recovery);
      this.#lastAction = `AUTO RECOVERY ${position.pair.duration}: reconciled the completed Polymarket-only ` +
        `unwind; realized $${formatUsd(realized)}.`;
    }
    if (recoveries.length > 0) {
      const remainingAmbiguous = this.#state.positions.find((position) =>
        !isManagedKnownPosition(position)
      );
      if (!remainingAmbiguous) {
        this.#state.halted = false;
        this.#state.haltReason = null;
      }
      await this.#save();
    }
    return recoveries;
  }

  async #recoverZeroExposureEntry(
    position: LivePosition,
    source: LiveRecoverySource,
    reason: string,
  ): Promise<LiveRecoveryDiagnostics | null> {
    if (!hasZeroRecordedEntryExposure(position)) return null;
    try {
      const [polymarketContractsMicro, jupiterPosition] = await Promise.all([
        this.#polymarket.getTokenBalance(position.pair.polymarketTokenId),
        this.#jupiter.getPosition(position.jupiterPositionPubkey),
      ]);
      if (jupiterPosition.positionPubkey !== position.jupiterPositionPubkey ||
        jupiterPosition.marketId !== position.pair.jupiterMarketId ||
        jupiterPosition.isYes !== expectedJupiterIsYes(position.pair)) {
        return null;
      }
      if (polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO ||
        jupiterPosition.contractsMicro > CONTRACT_TOLERANCE_MICRO) {
        return null;
      }
      const recovery: LiveRecoveryDiagnostics = {
        code: "ZERO_EXPOSURE_CONFIRMED_AFTER_TERMINAL_ENTRY_FAILURE",
        source,
        recoveredAtMs: Date.now(),
        positionId: position.id,
        pairKey: position.pair.key,
        duration: position.pair.duration,
        reason,
        observedPolymarketContractsMicro: polymarketContractsMicro,
        observedJupiterContractsMicro: jupiterPosition.contractsMicro,
      };
      this.#state.positions = this.#state.positions.filter((candidate) => candidate.id !== position.id);
      // Zero exposure is not a completed trade. The old behavior permanently
      // suppressed every later opportunity in the same still-open round via
      // PAIR_ALREADY_TRADED. Retain the one-shot diagnostic guard separately,
      // and let normal live trading retry after a short market-change cooldown.
      if (source === "entry_execution" && !this.#config.forceOneEntry &&
        Date.now() < position.pair.endMs - ENTRY_CUTOFF_MS) {
        this.#entryPreflightCooldowns.set(position.pair.key, {
          untilMs: Date.now() + MARKET_CHANGE_COOLDOWN_MS,
          stage: "complete",
          code: "ZERO_EXPOSURE_TERMINAL_ENTRY_RETRY",
        });
      }
      const remainingAmbiguous = this.#state.positions.find((candidate) =>
        !isManagedKnownPosition(candidate)
      );
      if (!remainingAmbiguous) {
        this.#state.halted = false;
        this.#state.haltReason = null;
      }
      this.#lastAction = `AUTO RECOVERY ${position.pair.duration}: terminal entry failure confirmed zero exposure ` +
        `on both venues; ${position.id} was cleared` +
        (Date.now() < position.pair.endMs - ENTRY_CUTOFF_MS && !this.#config.forceOneEntry
          ? " and the still-open pair may retry after cooldown."
          : ".");
      await this.#save();
      return recovery;
    } catch {
      // Recovery is fail-closed. A later runtime pass can retry read-only
      // balance confirmation; no order is ever placed by this path.
      return null;
    }
  }

  async #halt(position: LivePosition, reason: string): Promise<LiveDecision> {
    position.phase = "exposure_error";
    position.lastError = reason;
    this.#state.halted = true;
    this.#state.haltReason = reason;
    this.#lastAction = `HALTED: ${reason}`;
    await this.#save();
    return { type: "halt", reason, position };
  }

  async #quarantineForRecovery(
    position: LivePosition,
    reason: string,
    plan: LivePostFillRiskPlan,
  ): Promise<LiveDecision> {
    position.phase = "recovery_planning";
    position.lastError = reason;
    position.postFillRiskPlan = plan;
    // The exact balances and identities are known, so this position can be
    // isolated without disabling unrelated pairs. Any later repair must first
    // be priced against the complete four-state portfolio.
    this.#lastAction = `RECOVERY PLAN ${position.pair.duration}: ${plan.reason}`;
    await this.#save();
    return { type: "recovery_plan", reason, position, plan };
  }

  #releaseHaltWithoutBlockingExposure(): boolean {
    if (!this.#state.halted) return false;
    const blockingExposure = this.#state.positions.some((position) =>
      !isManagedKnownPosition(position)
    );
    if (blockingExposure) return false;
    this.#state.halted = false;
    this.#state.haltReason = null;
    return true;
  }

  #polymarketCash(): bigint {
    return this.#state.polymarketCashMicroUsd ?? 0n;
  }

  #jupiterCash(): bigint {
    return this.#state.jupiterCashMicroUsd ?? 0n;
  }

  async #save(): Promise<void> {
    await saveLiveState(this.#config.statePath, this.#state);
  }
}

export async function loadLiveState(path: string): Promise<LiveTraderState> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text, bigintReviver) as LiveTraderState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.positions) || !Array.isArray(parsed.completedPairs)) {
      throw new Error("unsupported live state schema");
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveLiveState(path: string, state: LiveTraderState): Promise<void> {
  // Capture the requested version before another asynchronous trader action
  // can mutate the shared state object. Saves for the same file are then
  // committed in call order, so a slower earlier write cannot overwrite a
  // newer state snapshot.
  const payload = `${JSON.stringify(state, bigintReplacer, 2)}\n`;
  const previous = liveStateSaveQueues.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    // The 5m loop, 15m loop, balance recovery, and settlement monitor can all
    // persist state concurrently. A shared `${path}.tmp` lets one Windows
    // rename consume another writer's source file and raises ENOENT. A unique
    // sibling keeps the final rename atomic without that collision.
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  });
  liveStateSaveQueues.set(path, operation);
  try {
    await operation;
  } finally {
    if (liveStateSaveQueues.get(path) === operation) liveStateSaveQueues.delete(path);
  }
}

function emptyState(): LiveTraderState {
  return {
    schemaVersion: 1,
    accountingVersion: VERIFIED_ACCOUNTING_VERSION,
    legacyUnverifiedRealizedProfitMicroUsd: 0n,
    sequence: 0,
    halted: false,
    haltReason: null,
    realizedProfitMicroUsd: 0n,
    polymarketCashMicroUsd: null,
    jupiterCashMicroUsd: null,
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [],
  };
}

function isManagedKnownPosition(position: LivePosition): boolean {
  return position.phase === "open" ||
    position.phase === "recovery_planning" ||
    position.phase === "awaiting_resolution";
}

function hasFullyObservedTwoLegExposure(position: LivePosition): boolean {
  return position.polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO &&
    position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO;
}

function canSafelyAwaitResolution(position: LivePosition, atMs: number): boolean {
  if (atMs < position.pair.endMs) return false;
  if (position.phase === "open") return hasFullyObservedTwoLegExposure(position);
  if (position.phase === "recovery_planning") {
    return position.polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO ||
      position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO;
  }
  if (position.phase !== "exposure_error") return false;
  if (isKnownTerminalOneSidedEntry(position)) return true;
  if (!position.lastError?.startsWith(OBSERVED_ENTRY_SIZE_MISMATCH)) return false;
  // A size mismatch is still fully observable when both settled entry legs are
  // recorded. Resolution can safely redeem/settle those balances without
  // placing a one-sided recovery trade. Unknown or one-sided fills stay halted.
  return hasFullyObservedTwoLegExposure(position);
}

export function projectCrossVenueResolutionScenarios(input: {
  polymarketContractsMicro: bigint;
  jupiterContractsMicro: bigint;
  totalEntryCostMicroUsd: bigint;
}): LiveResolutionScenario[] {
  const scenario = (
    code: LiveResolutionScenarioCode,
    polymarketWon: boolean,
    jupiterWon: boolean,
    rationale: string,
  ): LiveResolutionScenario => {
    const payoutMicroUsd =
      (polymarketWon ? input.polymarketContractsMicro : 0n) +
      (jupiterWon ? input.jupiterContractsMicro : 0n);
    return {
      code,
      polymarketWon,
      jupiterWon,
      payoutMicroUsd,
      pnlMicroUsd: payoutMicroUsd - input.totalEntryCostMicroUsd,
      rationale,
    };
  };
  return [
    scenario(
      "polymarket_only_win",
      true,
      false,
      "Polymarket's resolution observation selects the bought outcome while Jupiter's selects the opposite outcome.",
    ),
    scenario(
      "jupiter_only_win",
      false,
      true,
      "Jupiter's resolution observation selects the bought outcome while Polymarket's selects the opposite outcome.",
    ),
    scenario(
      "both_win",
      true,
      true,
      "The venues use different resolution observations, so both bought outcomes can settle as winners.",
    ),
    scenario(
      "both_lose",
      false,
      false,
      "The venues use different resolution observations, so oracle or timing divergence can make both bought outcomes lose.",
    ),
  ];
}

function actualEntryPayoffs(position: LivePosition): {
  polymarketWinPnlMicroUsd: bigint;
  jupiterWinPnlMicroUsd: bigint;
  bothWinPnlMicroUsd: bigint;
  bothLosePnlMicroUsd: bigint;
  minimumPnlMicroUsd: bigint;
} {
  const totalCostMicroUsd = position.polymarketEntryCostMicroUsd + position.jupiterEntryCostMicroUsd;
  const scenarios = projectCrossVenueResolutionScenarios({
    polymarketContractsMicro: position.polymarketContractsMicro,
    jupiterContractsMicro: position.jupiterContractsMicro,
    totalEntryCostMicroUsd: totalCostMicroUsd,
  });
  const polymarketWinPnlMicroUsd = scenarios[0]?.pnlMicroUsd ?? -totalCostMicroUsd;
  const jupiterWinPnlMicroUsd = scenarios[1]?.pnlMicroUsd ?? -totalCostMicroUsd;
  return {
    polymarketWinPnlMicroUsd,
    jupiterWinPnlMicroUsd,
    bothWinPnlMicroUsd: scenarios[2]?.pnlMicroUsd ?? -totalCostMicroUsd,
    bothLosePnlMicroUsd: scenarios[3]?.pnlMicroUsd ?? -totalCostMicroUsd,
    minimumPnlMicroUsd: minimum(polymarketWinPnlMicroUsd, jupiterWinPnlMicroUsd),
  };
}

function buildPostFillRiskPlan(
  position: LivePosition,
  strategy: ShortWindowStrategyConfig,
  executionFullyReconciled = false,
): LivePostFillRiskPlan {
  const totalEntryCostMicroUsd = position.polymarketEntryCostMicroUsd + position.jupiterEntryCostMicroUsd;
  const scenarios = projectCrossVenueResolutionScenarios({
    polymarketContractsMicro: position.polymarketContractsMicro,
    jupiterContractsMicro: position.jupiterContractsMicro,
    totalEntryCostMicroUsd,
  });
  const matchedContractsMicro = minimum(
    position.polymarketContractsMicro,
    position.jupiterContractsMicro,
  );
  const venueSizeMismatchMicro = absolute(
    position.polymarketContractsMicro - position.jupiterContractsMicro,
  );
  const venueSizeMismatchBps = matchedContractsMicro > 0n
    ? venueSizeMismatchMicro * 10_000n / matchedContractsMicro
    : null;
  const intendedSingleWinnerFloorMicroUsd = minimum(
    scenarios[0]?.pnlMicroUsd ?? -totalEntryCostMicroUsd,
    scenarios[1]?.pnlMicroUsd ?? -totalEntryCostMicroUsd,
  );
  const intendedEdgePerContractMicroUsd = matchedContractsMicro > 0n
    ? intendedSingleWinnerFloorMicroUsd * ONE_CONTRACT_MICRO / matchedContractsMicro
    : -ONE_USD_MICRO;
  const fullyObservedTwoLegPosition =
    position.polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO &&
    position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO;
  if (!fullyObservedTwoLegPosition) {
    return {
      action: executionFullyReconciled ? "quote_repair" : "manual_reconciliation",
      reason: executionFullyReconciled
        ? "The one-sided fill and zero balance on the other venue are known. Fetch fresh opposite-leg and unwind quotes, then accept only an action that improves the complete modeled portfolio."
        : "One or both venue fills are absent or not fully reconciled; do not submit a repair order until balances and order identities are known.",
      scenarios,
      intendedSingleWinnerFloorMicroUsd,
      maximumModeledLossMicroUsd: totalEntryCostMicroUsd,
      venueSizeMismatchMicro,
      venueSizeMismatchBps,
    };
  }
  const repairRequired = venueSizeMismatchBps === null ||
    venueSizeMismatchBps > MAXIMUM_POST_FILL_HEDGE_MISMATCH_BPS ||
    intendedSingleWinnerFloorMicroUsd < strategy.minimumEntryEdgeTotalMicroUsd ||
    intendedEdgePerContractMicroUsd < strategy.minimumEntryEdgeMicroUsdPerContract;
  return {
    action: repairRequired ? "quote_repair" : "hold_or_exit_normally",
    reason: repairRequired
      ? "Both fills are known, but their executed sizes or costs miss the configured single-winner floor. Fetch fresh trim, top-up, and unwind quotes and accept only a repair that improves the modeled portfolio."
      : "Both fills are known and meet the configured single-winner floor. Continue normal hold/exit management while retaining explicit both-win and both-lose oracle-divergence risk.",
    scenarios,
    intendedSingleWinnerFloorMicroUsd,
    maximumModeledLossMicroUsd: totalEntryCostMicroUsd,
    venueSizeMismatchMicro,
    venueSizeMismatchBps,
  };
}

function isExecutedAmountReconciled(status: JupiterPredictionOrderStatus): boolean {
  return status.reconciliationSource === "onchain_token_deltas" ||
    status.reconciliationSource === "swap_execute";
}

function isRejectedPolymarketPrecisionEntry(position: LivePosition): boolean {
  // This CLOB validation error rejects the signed order before execution. The
  // concurrent-entry reconciliation also observed a zero token-balance delta,
  // so the recorded Jupiter leg is exact and can safely await auto-settlement.
  return position.lastError?.includes(POLYMARKET_MARKET_AMOUNT_PRECISION_REJECTION) === true &&
    position.polymarketContractsMicro === 0n &&
    position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO;
}

function isRejectedPolymarketMinimumEntry(position: LivePosition): boolean {
  // A 400 response stating the market-BUY minimum is a deterministic CLOB
  // rejection. With a reconciled zero Polymarket balance delta, only the exact
  // recorded Jupiter fill remains and it can be settled after resolution.
  const error = position.lastError?.toLowerCase() ?? "";
  return error.includes(POLYMARKET_MARKETABLE_BUY_MINIMUM_REJECTION) &&
    /min size:\s*1(?:\D|$)/.test(error) &&
    position.polymarketContractsMicro === 0n &&
    position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO;
}

function isKnownRejectedPolymarketEntry(position: LivePosition): boolean {
  return isRejectedPolymarketPrecisionEntry(position) || isRejectedPolymarketMinimumEntry(position) ||
    isRejectedPolymarketFokEntry(position);
}

function isKnownTerminalOneSidedEntry(position: LivePosition): boolean {
  return isKnownRejectedPolymarketEntry(position) || isRejectedJupiterSlippageEntry(position) ||
    isRejectedPreSubmissionJupiterHedge(position);
}

function isRejectedPreSubmissionJupiterHedge(position: LivePosition): boolean {
  // POST_FILL_HEDGE_* errors are raised before a Jupiter transaction is signed
  // or submitted. The reconciled Polymarket token balance is therefore the
  // complete exposure and can safely be settled if the immediate FOK unwind
  // could not fill before the market closed.
  const error = position.lastError?.toLowerCase() ?? "";
  return error.includes("entry left jupiter execution unresolved") &&
    error.includes("post_fill_hedge_") &&
    position.polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO &&
    position.jupiterContractsMicro <= CONTRACT_TOLERANCE_MICRO;
}

function isPersistedJupiterUnresolvedReconciliationCandidate(position: LivePosition): boolean {
  // The entry path records this message only when Jupiter has no settled
  // status. Reconcile both wallets before clearing it, covering quote-time
  // failures (including HTTP 429) as well as ambiguous submission responses.
  const error = position.lastError?.toLowerCase() ?? "";
  return error.includes("entry left jupiter execution unresolved") &&
    position.polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO &&
    position.jupiterContractsMicro <= CONTRACT_TOLERANCE_MICRO;
}

function isRejectedJupiterSlippageEntry(position: LivePosition): boolean {
  // Jupiter 6001 is a definitive on-chain slippage rejection. The sequential
  // entry gate submits Jupiter only after a matched Polymarket FOK, so this
  // reconciled Poly-only balance can settle automatically at market resolution.
  const error = position.lastError?.toLowerCase() ?? "";
  return error.includes("entry left jupiter execution unresolved") &&
    error.includes("jupiter forecast swap execution failed (6001)") &&
    error.includes("slippage tolerance exceeded") &&
    position.polymarketContractsMicro > CONTRACT_TOLERANCE_MICRO &&
    position.jupiterContractsMicro <= CONTRACT_TOLERANCE_MICRO;
}

function isRejectedPolymarketFokEntry(position: LivePosition): boolean {
  // A rejected FOK is fully killed by definition. The concurrent-entry path
  // also measured a zero token balance delta, so an already-filled Jupiter leg
  // is exact and can safely settle at resolution instead of requiring a manual
  // halt forever.
  const error = position.lastError?.toLowerCase() ?? "";
  return error.includes("polymarket fok buy rejected") &&
    error.includes("couldn't be fully filled") &&
    position.polymarketContractsMicro === 0n &&
    position.jupiterContractsMicro > CONTRACT_TOLERANCE_MICRO;
}

function hasZeroRecordedEntryExposure(position: LivePosition): boolean {
  return position.jupiterContractsMicro <= CONTRACT_TOLERANCE_MICRO &&
    position.polymarketContractsMicro <= CONTRACT_TOLERANCE_MICRO &&
    position.originalContractsMicro <= CONTRACT_TOLERANCE_MICRO &&
    position.jupiterEntryCostMicroUsd === 0n &&
    position.polymarketEntryCostMicroUsd === 0n &&
    position.remainingEntryCostMicroUsd === 0n;
}

function isPersistedZeroExposureEntryRecoveryCandidate(position: LivePosition, atMs: number): boolean {
  // Once the market has closed, an unfilled keeper order can no longer create
  // late exposure. The recovery pass still verifies both real token balances
  // before clearing the halt, so this safely covers standard POLY-* orders as
  // well as terminal Forecast Swap failures.
  return position.phase === "exposure_error" && atMs >= position.pair.endMs &&
    hasZeroRecordedEntryExposure(position);
}

function isTerminalJupiterExecutionRejection(
  result: PromiseSettledResult<SubmittedJupiterOrder>,
): boolean {
  if (result.status !== "rejected" || typeof result.reason !== "object" || result.reason === null) return false;
  const error = result.reason as Record<string, unknown>;
  if (error.name === "JupiterSubmissionSkippedError") return true;
  const code = typeof error.code === "number" ? error.code : Number(error.code);
  return error.name === "JupiterSwapExecutionError" && Number.isInteger(code) &&
    isDefinitelyTerminalJupiterSwapCode(code);
}

function isDefinitelyTerminalJupiterSwapCode(code: number): boolean {
  if (code > 0) return true;
  return [-1, -2, -3, -1002, -1003, -1004, -2002, -2003, -2004].includes(code);
}

function isTerminalZeroFillPolymarketResult(
  result: PromiseSettledResult<PolymarketLiveFill>,
): boolean {
  if (result.status === "fulfilled") return result.value.contractsMicro <= CONTRACT_TOLERANCE_MICRO;
  if (typeof result.reason !== "object" || result.reason === null) return false;
  const error = result.reason as Record<string, unknown>;
  return error.name === "PolymarketFokSubmissionError" && error.status === "rejected";
}

class EntryPreflightFailure extends Error {
  readonly code: string;
  readonly retryClass: Exclude<LiveEntryPreflightRetryClass, "none">;

  constructor(
    code: string,
    message: string,
    retryClass: Exclude<LiveEntryPreflightRetryClass, "none">,
  ) {
    super(message);
    this.name = "EntryPreflightFailure";
    this.code = code;
    this.retryClass = retryClass;
  }
}

function rejectEntryPreflight(
  code: string,
  message: string,
  retryClass: Exclude<LiveEntryPreflightRetryClass, "none">,
): never {
  throw new EntryPreflightFailure(code, message, retryClass);
}

function classifyEntryPreflightFailure(
  error: unknown,
  stage: Exclude<LiveEntryPreflightStage, "complete">,
): {
  code: string;
  retryClass: Exclude<LiveEntryPreflightRetryClass, "none">;
  cooldownMs: number;
} {
  if (error instanceof EntryPreflightFailure) {
    return {
      code: error.code,
      retryClass: error.retryClass,
      cooldownMs: preflightCooldownMs(error.retryClass),
    };
  }
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const message = errorMessage(error);
  const looksLikeConfiguration = /allowance|insufficient|unsupported|does not require|outside the CLOB|private key/i
    .test(message);
  const retryClass = looksLikeConfiguration ? "configuration" : "transient";
  const router = optionalString(record.router);
  const errorCode = primitiveCode(record.errorCode ?? record.code);
  const code = router && errorCode !== null
    ? `JUPITER_SWAP_${router.toUpperCase()}_${String(errorCode)}`
    : stage === "jupiter_quote"
      ? "JUPITER_QUOTE_REQUEST_FAILED"
      : stage === "venue_preparation" ? "VENUE_PREPARATION_FAILED" : "PREFLIGHT_VALIDATION_FAILED";
  return { code, retryClass, cooldownMs: preflightCooldownMs(retryClass) };
}

function preflightCooldownMs(retryClass: Exclude<LiveEntryPreflightRetryClass, "none">): number {
  if (retryClass === "market_changed") return MARKET_CHANGE_COOLDOWN_MS;
  if (retryClass === "configuration") return CONFIGURATION_PREFLIGHT_COOLDOWN_MS;
  return TRANSIENT_PREFLIGHT_COOLDOWN_MS;
}

function validateJupiterEntryBuild(input: {
  build: JupiterPredictionOrderBuild;
  pair: LivePairIdentity;
  polymarketQuote: VenueTradeCost;
  maximumPolymarketPriceMicroUsd: bigint;
  polymarketAvailableMicroUsd: bigint;
  jupiterAvailableMicroUsd: bigint;
  config: LiveTraderConfig;
  allowUnprofitable: boolean;
}): void {
  const { build, pair, config } = input;
  if (build.order.marketId !== pair.jupiterMarketId || !build.order.isBuy ||
    build.order.isYes !== expectedJupiterIsYes(pair)) {
    rejectEntryPreflight(
      "JUPITER_QUOTE_IDENTITY_MISMATCH",
      "quote identity differs from selected Jupiter outcome market",
      "configuration",
    );
  }
  const forecastRoute = pair.jupiterOutcomeMint !== undefined;
  if (forecastRoute && (build.executionModel !== "atomic_swap" || build.settlement !== "auto")) {
    rejectEntryPreflight(
      "JUPITER_ROUTE_NOT_ATOMIC",
      "selected Jupiter Forecast route is not an atomic auto-settling swap",
      "configuration",
    );
  }
  if (!forecastRoute && !build.order.orderPubkey) {
    rejectEntryPreflight(
      "JUPITER_KEEPER_ORDER_ID_MISSING",
      "selected Jupiter provider route has no keeper order identity",
      "configuration",
    );
  }
  const guaranteedContractsMicro = guaranteedJupiterOutputContracts(build);
  const polymarketExecutableContractsMicro = floorToPolymarketSharePrecision(guaranteedContractsMicro);
  if (polymarketExecutableContractsMicro < config.strategy.polymarketMinimumContractsMicro) {
    rejectEntryPreflight(
      "JUPITER_BELOW_POLYMARKET_MINIMUM",
      "quoted Jupiter contracts are below the Polymarket minimum",
      "market_changed",
    );
  }
  if (build.order.contractsMicro !== build.order.newContractsMicro) {
    rejectEntryPreflight(
      "JUPITER_QUOTE_CONTAINS_EXISTING_POSITION",
      "new Jupiter entry quote unexpectedly includes an existing position",
      "configuration",
    );
  }
  const quotedAverageBuyPrice = build.order.newContractsMicro > 0n
    ? build.order.orderCostMicroUsd * ONE_CONTRACT_MICRO / build.order.newContractsMicro
    : ONE_USD_MICRO;
  if (quotedAverageBuyPrice <= 0n || quotedAverageBuyPrice >= ONE_USD_MICRO) {
    rejectEntryPreflight(
      "JUPITER_INVALID_AVERAGE_PRICE",
      `Jupiter returned an invalid binary-contract average price ${quotedAverageBuyPrice}`,
      "transient",
    );
  }
  const allIn = build.order.orderCostMicroUsd + build.order.estimatedTotalFeeMicroUsd;
  if (allIn > config.strategy.jupiterMaximumAllocationMicroUsd) {
    rejectEntryPreflight(
      "JUPITER_ALLOCATION_EXCEEDED",
      "Jupiter size-specific quote exceeds the per-position allocation",
      "market_changed",
    );
  }
  if (allIn > input.jupiterAvailableMicroUsd) {
    rejectEntryPreflight(
      "JUPITER_CASH_EXCEEDED",
      "Jupiter size-specific quote exceeds available strategy cash",
      "configuration",
    );
  }
  if (build.order.orderCostMicroUsd < config.strategy.jupiterMinimumGrossOrderMicroUsd) {
    rejectEntryPreflight(
      "JUPITER_BELOW_GROSS_FLOOR",
      "Jupiter size-specific quote is below the configured strategy gross floor",
      "market_changed",
    );
  }
  const quantityMicro = input.polymarketQuote.quantityMicro;
  if (quantityMicro < config.strategy.polymarketMinimumContractsMicro) {
    rejectEntryPreflight(
      "POLYMARKET_BELOW_CONTRACT_MINIMUM",
      "precision-normalized Polymarket FOK is below the configured contract minimum",
      "market_changed",
    );
  }
  if (quantityMicro <= 0n || quantityMicro > guaranteedContractsMicro) {
    rejectEntryPreflight(
      "CROSS_VENUE_QUANTITY_MISMATCH",
      "Polymarket FOK quantity exceeds the Jupiter executable quote",
      "transient",
    );
  }
  const unmatchedJupiterContractsMicro = guaranteedContractsMicro - quantityMicro;
  const unmatchedJupiterBps = unmatchedJupiterContractsMicro * 10_000n / quantityMicro;
  if (unmatchedJupiterBps > MAXIMUM_POST_FILL_HEDGE_MISMATCH_BPS) {
    rejectEntryPreflight(
      "CROSS_VENUE_QUANTITY_MISMATCH",
      "Polymarket FOK precision would leave too much unmatched Jupiter output",
      "market_changed",
    );
  }
  if (input.polymarketQuote.grossMicroUsd < config.strategy.polymarketMinimumGrossOrderMicroUsd) {
    rejectEntryPreflight(
      "POLYMARKET_BELOW_MARKETABLE_BUY_MINIMUM",
      `Polymarket marketable BUY gross $${formatUsd(input.polymarketQuote.grossMicroUsd)} is below ` +
      `$${formatUsd(config.strategy.polymarketMinimumGrossOrderMicroUsd)}`,
      "market_changed",
    );
  }
  // A marketable limit order may consume its full limit-price maker amount.
  // Use that ceiling, not the indicative VWAP, for the final profit gate.
  const maximumPolymarketGross = ceilTradeGrossToCent(
    input.maximumPolymarketPriceMicroUsd,
    quantityMicro,
  );
  const polymarketAllIn = maximumPolymarketGross +
    polymarketFee(input.maximumPolymarketPriceMicroUsd, quantityMicro);
  if (polymarketAllIn > config.strategy.polymarketMaximumAllocationMicroUsd ||
    polymarketAllIn > input.polymarketAvailableMicroUsd) {
    rejectEntryPreflight(
      "POLYMARKET_CASH_OR_ALLOCATION_EXCEEDED",
      "quoted matching Polymarket leg exceeds its cash or allocation limit",
      "market_changed",
    );
  }
  const conservativeEdge = quantityMicro - allIn - polymarketAllIn;
  const conservativeEdgePerContract = conservativeEdge * ONE_CONTRACT_MICRO / quantityMicro;
  if (!input.allowUnprofitable && (
    conservativeEdge < config.strategy.minimumEntryEdgeTotalMicroUsd ||
    conservativeEdgePerContract < config.strategy.minimumEntryEdgeMicroUsdPerContract
  )) {
    rejectEntryPreflight(
      "FINAL_QUOTE_NOT_PROFITABLE",
      `size-specific concurrent quote no longer meets the entry profit minimums ` +
      `(Jupiter average=${quotedAverageBuyPrice}, Polymarket VWAP=${input.polymarketQuote.priceMicroUsd}, ` +
      `edge=${conservativeEdge}, edge/contract=${conservativeEdgePerContract})`,
      "market_changed",
    );
  }
}

function canExecuteFreshScreeningBuild(input: {
  build: JupiterPredictionOrderBuild;
  builtAtMs: number;
  pair: LivePairIdentity;
  polymarketAsks: readonly BookLevel[];
  polymarketAvailableMicroUsd: bigint;
  jupiterAvailableMicroUsd: bigint;
  config: LiveTraderConfig;
}): boolean {
  if (!isReusableJupiterEntryBuild(
    input.build,
    input.builtAtMs,
    input.pair,
    input.build.order.orderCostMicroUsd,
    input.config.maximumReusableJupiterQuoteAgeMs,
  )) return false;
  const polymarketQuote = quoteBuyAcrossLevels(
    input.polymarketAsks,
    floorToPolymarketSharePrecision(guaranteedJupiterOutputContracts(input.build)),
    "polymarket",
  );
  if (!polymarketQuote) return false;
  const maximumPolymarketPriceMicroUsd = applyBps(
    polymarketQuote.limitPriceMicroUsd,
    input.config.maximumSlippageBps,
    "up",
  );
  try {
    validateJupiterEntryBuild({
      build: input.build,
      pair: input.pair,
      polymarketQuote,
      maximumPolymarketPriceMicroUsd,
      polymarketAvailableMicroUsd: input.polymarketAvailableMicroUsd,
      jupiterAvailableMicroUsd: input.jupiterAvailableMicroUsd,
      config: input.config,
      allowUnprofitable: false,
    });
    return true;
  } catch {
    // A smaller, newly quoted size can still qualify, so fall back to the
    // normal size-specific preflight instead of treating this as a failure.
    return false;
  }
}

function isReusableJupiterEntryBuild(
  build: JupiterPredictionOrderBuild,
  builtAtMs: number,
  pair: LivePairIdentity,
  requestedGrossMicroUsd: bigint,
  maximumAgeMs: number,
): boolean {
  const ageMs = Date.now() - builtAtMs;
  return ageMs >= 0 && ageMs <= maximumAgeMs &&
    optionalString(build.execution.context.router)?.toLowerCase() !== "jupiterz" &&
    build.order.marketId === pair.jupiterMarketId && build.order.isBuy &&
    build.order.isYes === expectedJupiterIsYes(pair) &&
    absolute(build.order.orderCostMicroUsd - requestedGrossMicroUsd) <= 10_000n &&
    build.executionModel === "atomic_swap" && build.settlement === "auto";
}

function expectedJupiterIsYes(pair: LivePairIdentity): boolean {
  // Native Forecast represents UP and DOWN as separate YES-only markets. Other
  // Prediction providers expose both sides on one binary market.
  return pair.jupiterOutcomeMint !== undefined || pair.jupiterOutcome === "UP";
}

function isExplicitJupiterSlippageFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "number" ? record.code : Number(record.code);
  return record.name === "JupiterSwapExecutionError" && code === 6001;
}

function managedJupiterPositionPubkey(pair: LivePairIdentity, venuePositionPubkey: string): string {
  return pair.jupiterOutcomeMint
    ? forecastSwapPositionId(pair.jupiterMarketId, pair.jupiterOutcomeMint)
    : venuePositionPubkey;
}

function polymarketFee(priceMicroUsd: bigint, quantityMicro: bigint): bigint {
  return (polymarketCryptoTakerFeePerContractMicroUsd(priceMicroUsd) * quantityMicro +
    ONE_CONTRACT_MICRO / 2n) / ONE_CONTRACT_MICRO;
}

function tradeGross(priceMicroUsd: bigint, quantityMicro: bigint): bigint {
  return (priceMicroUsd * quantityMicro + ONE_CONTRACT_MICRO / 2n) / ONE_CONTRACT_MICRO;
}

function floorToPolymarketSharePrecision(quantityMicro: bigint): bigint {
  return quantityMicro / 10_000n * 10_000n;
}

function largestPolymarketFokBuyAtValidPrecision(input: {
  requestedContractsMicro: bigint;
  minimumPriceMicroUsd: bigint;
  maximumPriceMicroUsd: bigint;
}): { contractsMicro: bigint; limitPriceMicroUsd: bigint } {
  const minimumTicks = (
    input.minimumPriceMicroUsd + POLYMARKET_PRICE_TICK_MICRO_USD - 1n
  ) / POLYMARKET_PRICE_TICK_MICRO_USD;
  const maximumTicks = input.maximumPriceMicroUsd / POLYMARKET_PRICE_TICK_MICRO_USD;
  if (minimumTicks > maximumTicks) {
    return { contractsMicro: 0n, limitPriceMicroUsd: 0n };
  }
  let bestContractsMicro = 0n;
  let bestPriceMicroUsd = 0n;
  for (let ticks = minimumTicks; ticks <= maximumTicks; ticks += 1n) {
    const priceMicroUsd = ticks * POLYMARKET_PRICE_TICK_MICRO_USD;
    const contractsMicro = floorPolymarketFokBuyContractsToAmountPrecision(
      input.requestedContractsMicro,
      priceMicroUsd,
    );
    if (contractsMicro > bestContractsMicro ||
      (contractsMicro === bestContractsMicro &&
        (bestPriceMicroUsd === 0n || priceMicroUsd < bestPriceMicroUsd))) {
      bestContractsMicro = contractsMicro;
      bestPriceMicroUsd = priceMicroUsd;
    }
  }
  return { contractsMicro: bestContractsMicro, limitPriceMicroUsd: bestPriceMicroUsd };
}

function guaranteedJupiterOutputContracts(build: JupiterPredictionOrderBuild): bigint {
  const threshold = build.execution.context.otherAmountThreshold;
  let parsed: bigint | null = null;
  if (typeof threshold === "bigint") parsed = threshold;
  else if (typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold > 0) {
    parsed = BigInt(threshold);
  } else if (typeof threshold === "string" && /^\d+$/.test(threshold)) {
    parsed = BigInt(threshold);
  }
  return parsed !== null && parsed > 0n && parsed <= build.order.newContractsMicro
    ? parsed
    : build.order.newContractsMicro;
}

function haircutBookLevels(levels: readonly BookLevel[], haircutBps: number): BookLevel[] {
  const retainedBps = BigInt(10_000 - Math.max(0, Math.min(10_000, Math.trunc(haircutBps))));
  return levels.flatMap((level) => {
    const contractsMicro = floorToPolymarketSharePrecision(
      level.contractsMicro * retainedBps / 10_000n,
    );
    return contractsMicro > 0n ? [{ ...level, contractsMicro }] : [];
  });
}

function maximumConservativelyProfitablePolymarketPrice(input: {
  quantityMicro: bigint;
  jupiterAllInMicroUsd: bigint;
  displayedLimitPriceMicroUsd: bigint;
  maximumSlippageBps: number;
  minimumEdgeMicroUsdPerContract: bigint;
  minimumEdgeTotalMicroUsd: bigint;
  allowUnprofitable: boolean;
}): bigint {
  const configuredCeiling = applyBps(
    input.displayedLimitPriceMicroUsd,
    input.maximumSlippageBps,
    "up",
  );
  if (input.allowUnprofitable || input.quantityMicro <= 0n) return configuredCeiling;
  const perContractRequired = (
    input.minimumEdgeMicroUsdPerContract * input.quantityMicro + ONE_CONTRACT_MICRO - 1n
  ) / ONE_CONTRACT_MICRO;
  const requiredEdge = maximum(input.minimumEdgeTotalMicroUsd, perContractRequired);
  const maximumPolymarketAllIn = input.quantityMicro - input.jupiterAllInMicroUsd - requiredEdge;
  let lowTicks = input.displayedLimitPriceMicroUsd / POLYMARKET_PRICE_TICK_MICRO_USD;
  let highTicks = configuredCeiling / POLYMARKET_PRICE_TICK_MICRO_USD;
  const isProfitable = (ticks: bigint): boolean => {
    const price = ticks * POLYMARKET_PRICE_TICK_MICRO_USD;
    return ceilTradeGrossToCent(price, input.quantityMicro) +
      polymarketFee(price, input.quantityMicro) <= maximumPolymarketAllIn;
  };
  if (!isProfitable(lowTicks)) return input.displayedLimitPriceMicroUsd;
  while (lowTicks < highTicks) {
    const middle = (lowTicks + highTicks + 1n) / 2n;
    if (isProfitable(middle)) lowTicks = middle;
    else highTicks = middle - 1n;
  }
  return lowTicks * POLYMARKET_PRICE_TICK_MICRO_USD;
}

function ceilTradeGrossToCent(priceMicroUsd: bigint, quantityMicro: bigint): bigint {
  const grossMicroUsd = (priceMicroUsd * quantityMicro + ONE_CONTRACT_MICRO - 1n) /
    ONE_CONTRACT_MICRO;
  return (grossMicroUsd + 9_999n) / 10_000n * 10_000n;
}

function applyBps(priceMicroUsd: bigint, bps: number, direction: "up" | "down"): bigint {
  const change = priceMicroUsd * BigInt(bps) / 10_000n;
  const maximumTickPrice = ONE_USD_MICRO - POLYMARKET_PRICE_TICK_MICRO_USD;
  if (direction === "up") {
    const rawMaximum = minimum(maximumTickPrice, priceMicroUsd + change);
    return maximum(
      POLYMARKET_PRICE_TICK_MICRO_USD,
      rawMaximum / POLYMARKET_PRICE_TICK_MICRO_USD * POLYMARKET_PRICE_TICK_MICRO_USD,
    );
  }
  const rawMinimum = maximum(POLYMARKET_PRICE_TICK_MICRO_USD, priceMicroUsd - change);
  const roundedUp = (rawMinimum + POLYMARKET_PRICE_TICK_MICRO_USD - 1n) /
    POLYMARKET_PRICE_TICK_MICRO_USD * POLYMARKET_PRICE_TICK_MICRO_USD;
  return minimum(maximumTickPrice, roundedUp);
}

function conservativeEntryCapacity(hardCapacityMicroUsd: bigint, maximumSlippageBps: number): bigint {
  const reserveBps = MAXIMUM_POST_FILL_HEDGE_MISMATCH_BPS +
    BigInt(Math.max(0, Math.trunc(maximumSlippageBps)));
  // Keep the configured allocation as the hard emergency-hedge ceiling. The
  // entry uses the largest base amount whose bounded post-fill growth still
  // fits beneath that ceiling.
  return hardCapacityMicroUsd * 10_000n / (10_000n + reserveBps);
}

function formatSolLamports(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  return typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRateLimitError(error: unknown): boolean {
  const diagnostic = errorDiagnostic(error);
  return diagnostic.status === 429 || diagnostic.code === 429 ||
    /(?:http\s*)?429|too many requests|rate limit/i.test(diagnostic.message);
}

async function waitMilliseconds(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function primaryEntryFailureReason(reason: string): string {
  return reason.split("; automatic Polymarket unwind failed:", 1)[0] ?? reason;
}

function isPolymarketUnwindBalanceVisibilityFailure(reason: string | null): boolean {
  const error = reason?.toLowerCase() ?? "";
  return error.includes("automatic polymarket unwind failed") && (
    error.includes("polymarket_unwind_balance_not_visible") ||
    (error.includes("not enough balance / allowance") && error.includes("balance: 0"))
  );
}

function errorDiagnostic(error: unknown, depth = 0): LiveErrorDiagnostic {
  const object = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: value.name,
    message: value.message,
    code: primitiveCode(object.errorCode ?? object.code),
    status: primitiveCode(object.status),
    router: optionalString(object.router),
    url: optionalString(object.url),
    transactionSignature: optionalString(object.transactionSignature),
    stack: value.stack ?? null,
    cause: depth < 2 && object.cause !== undefined
      ? errorDiagnostic(object.cause, depth + 1)
      : null,
  };
}

function primitiveCode(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jupiterBuildRequestId(
  build: JupiterPredictionOrderBuild | null | undefined,
): string | null {
  if (!build) return null;
  return build.externalOrderId ?? build.jupiterSwapRequestId ?? build.order.orderPubkey ??
    optionalString(build.execution.context.requestId);
}

async function settleTogether<Left, Right>(
  left: () => Promise<Left>,
  right: () => Promise<Right>,
): Promise<[PromiseSettledResult<Left>, PromiseSettledResult<Right>]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const leftPromise = (async () => {
    await gate;
    return await left();
  })();
  const rightPromise = (async () => {
    await gate;
    return await right();
  })();
  release();
  const results = await Promise.allSettled([leftPromise, rightPromise]);
  return [
    results[0] as PromiseSettledResult<Left>,
    results[1] as PromiseSettledResult<Right>,
  ];
}

class JupiterSubmissionSkippedError extends Error {
  readonly code = "POLYMARKET_FOK_REJECTED_BEFORE_JUPITER_SUBMISSION";

  constructor(reason: unknown) {
    super(`Jupiter submission skipped because Polymarket did not fill first: ${errorMessage(reason)}`);
    this.name = "JupiterSubmissionSkippedError";
  }
}

function settledError(result: PromiseSettledResult<unknown>): string {
  return result.status === "rejected" ? errorMessage(result.reason) : "none";
}

function absoluteNumber(value: number): number {
  return value < 0 ? -value : value;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function roundedScale(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (value < 0n || numerator < 0n || denominator <= 0n) {
    throw new Error("roundedScale requires non-negative values and a positive denominator");
  }
  return (value * numerator + denominator / 2n) / denominator;
}
