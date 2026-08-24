import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { eligibleCrossVenueRoutes, evaluateCrossVenueRoutes } from "../../../packages/domain/src/short-window.ts";
import type { BinaryOrderBook, BookLevel } from "../../../packages/domain/src/types.ts";
import type {
  JupiterPredictionOrderBuild,
  JupiterPredictionOrderStatus,
  JupiterPredictionPosition,
} from "../../../packages/venue-jupiter/src/client.ts";
import { JupiterSwapExecutionError } from "../../../packages/venue-jupiter/src/forecast-swap.ts";
import type {
  PreparedJupiterSubmission,
  SubmittedJupiterOrder,
} from "../../../packages/venue-jupiter/src/trading.ts";
import {
  PolymarketFokSubmissionError,
  type PolymarketLiveFill,
  type PreparedPolymarketFokOrder,
} from "../../../packages/venue-polymarket/src/trading.ts";
import {
  loadLiveState,
  saveLiveState,
  ShortWindowLiveTrader,
  type LiveExitMode,
  type LiveJupiterGateway,
  type LivePairIdentity,
  type LivePolymarketGateway,
  type LiveTraderState,
} from "../src/short-window-live-trader.ts";

test("live state saves serialize concurrent atomic replacements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-concurrent-save-"));
  const statePath = join(directory, "state.json");
  const state = (sequence: number): LiveTraderState => ({
    schemaVersion: 1,
    accountingVersion: 2,
    sequence,
    halted: false,
    haltReason: null,
    realizedProfitMicroUsd: BigInt(sequence),
    polymarketCashMicroUsd: 100_000_000n,
    jupiterCashMicroUsd: 100_000_000n,
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [],
  });

  await Promise.all(Array.from({ length: 32 }, (_, sequence) =>
    saveLiveState(statePath, state(sequence))
  ));

  const persisted = await loadLiveState(statePath);
  assert.equal(persisted.sequence, 31);
  assert.equal(persisted.realizedProfitMicroUsd, 31n);
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

test("live trader replaces persisted cash with real wallet balances and accepts refreshes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-wallet-balances-"));
  const statePath = join(directory, "state.json");
  const persisted = {
    schemaVersion: 1,
    accountingVersion: 2,
    sequence: 0,
    halted: false,
    haltReason: null,
    realizedProfitMicroUsd: "0n",
    polymarketCashMicroUsd: "999000000n",
    jupiterCashMicroUsd: "999000000n",
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [],
  };
  await writeFile(statePath, JSON.stringify(persisted));
  const trader = createTrader(new MockJupiter([]), new MockPolymarket([]), statePath);

  await trader.initialize();
  assert.equal(trader.snapshot().polymarketCashUsd, "100");
  assert.equal(trader.snapshot().jupiterCashUsd, "100");

  trader.updateWalletBalances(59_984_632n, 51_825_334n);
  assert.equal(trader.snapshot().polymarketCashUsd, "59.984632");
  assert.equal(trader.snapshot().jupiterCashUsd, "51.825334");
});

test("startup archives legacy quote-derived P&L and starts verified accounting at zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-accounting-migration-"));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    sequence: 22,
    halted: false,
    haltReason: null,
    realizedProfitMicroUsd: "11502350n",
    polymarketCashMicroUsd: "74840000n",
    jupiterCashMicroUsd: "100030391n",
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [],
  }));
  const trader = createTrader(new MockJupiter([]), new MockPolymarket([]), statePath);

  await trader.initialize();

  assert.equal(trader.snapshot().realizedProfitUsd, "0");
  assert.equal(trader.snapshot().legacyUnverifiedRealizedProfitUsd, "11.50235");
  const migrated = await loadLiveState(statePath);
  assert.equal(migrated.accountingVersion, 2);
  assert.equal(migrated.realizedProfitMicroUsd, 0n);
  assert.equal(migrated.legacyUnverifiedRealizedProfitMicroUsd, 11_502_350n);
});

test("live trader uses a 30-second entry cutoff for both durations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-entry-cutoff-"));
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  for (const duration of ["5m", "15m"] as const) {
    const allowed = createTrader(
      new MockJupiter([]),
      new MockPolymarket([]),
      join(directory, `${duration}-allowed.json`),
    );
    await allowed.initialize();
    const identity: LivePairIdentity = {
      ...pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
      duration,
    };
    assert.equal((await allowed.consider({
      pair: identity,
      bestRoute: route,
      polymarketBook,
      jupiterBook,
      atMs: identity.endMs - 30_001,
    })).type, "entry");

    const cutoff = createTrader(
      new MockJupiter([]),
      new MockPolymarket([]),
      join(directory, `${duration}-cutoff.json`),
    );
    await cutoff.initialize();
    assert.deepEqual(await cutoff.consider({
      pair: identity,
      bestRoute: route,
      polymarketBook,
      jupiterBook,
      atMs: identity.endMs - 30_000,
    }), { type: "skip", reason: "ENTRY_CUTOFF_REACHED" });
  }
});

test("daily binary pairs request the selected Jupiter NO side", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-daily-no-"));
  const jupiter = new MockJupiter([]);
  const trader = createTrader(jupiter, new MockPolymarket([]), join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(1n, 1n),
  ).find((candidate) => candidate.route.jupiterOutcome === "DOWN") ?? null;
  assert.ok(route);
  const forecastIdentity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  const { jupiterOutcomeMint: _forecastMint, ...binaryIdentity } = forecastIdentity;
  const identity: LivePairIdentity = {
    ...binaryIdentity,
    key: "daily:3635565",
    duration: "daily",
    endMs: 86_400_000,
    jupiterMarketId: "POLY-3635565",
  };
  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });
  assert.equal(decision.type, "entry");
  assert.equal(jupiter.lastBuyIsYes, false);
});

test("live trader signs a fresh exact Jupiter build before Polymarket and executes it immediately after fill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-test-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();

  const entryBooks = {
    polymarket: book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n),
    jupiter: book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n),
  };
  const route = evaluateCrossVenueRoutes(
    entryBooks.polymarket,
    entryBooks.jupiter,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  const entry = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook: entryBooks.polymarket,
    jupiterBook: entryBooks.jupiter,
    atMs: 1_000,
  });
  assert.equal(entry.type, "entry");
  assert.equal(entry.position.entrySubmissionSkewMs, 1);
  assert.equal(
    entry.position.jupiterPositionPubkey,
    `swap-v2:${identity.jupiterMarketId}:${identity.jupiterOutcomeMint}`,
  );
  assert.equal(entry.position.jupiterEntryPositionPubkey, "jup-position");
  assert.deepEqual(events.slice(0, 6), [
    "jupiter:prepare-buy",
    "polymarket:balance",
    "polymarket:prepare-buy",
    "jupiter:prepare-submission",
    "polymarket:submit-buy",
    "jupiter:submit",
  ]);
  assert.equal(entry.preflight?.stage, "complete");
  assert.equal(entry.preflight?.code, "OK");
  assert.equal(entry.execution?.jupiter.result, "fulfilled");
  assert.equal(entry.execution?.jupiter.submissionAttempted, true);
  assert.equal(entry.execution?.jupiter.signed, true);
  assert.equal(entry.execution?.jupiter.usedPreflightBuild, true);
  assert.equal(entry.execution?.jupiter.endpoint, "/execute");
  assert.equal(entry.execution?.jupiter.requestId, "external");
  assert.equal(entry.execution?.polymarket.result, "fulfilled");
  assert.equal(trader.snapshot().openPositions, 1);
  assert.ok(Number(trader.snapshot().polymarketCashUsd) < 100);
  assert.ok(Number(trader.snapshot().jupiterCashUsd) < 100);

  const persisted = await readFile(join(directory, "state.json"), "utf8");
  assert.match(persisted, /"phase": "open"/);
  assert.doesNotMatch(persisted, /private/i);

  const exit = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook: book("polymarket", 510_000n, 500_000n, 500_000n, 490_000n),
    jupiterBook: book("jupiter", 460_000n, 560_000n, 450_000n, 550_000n),
    atMs: 2_000,
  });
  assert.equal(exit.type, "exit");
  assert.equal(exit.submissionSkewMs, 1);
  assert.equal(polymarket.preparedSell?.minimumPriceMicroUsd, 500_000n);
  assert.equal((polymarket.preparedSell?.minimumPriceMicroUsd ?? 1n) % 10_000n, 0n);
  assert.deepEqual(events.slice(-6), [
    "jupiter:prepare-close",
    "jupiter:prepare-submission",
    "polymarket:prepare-sell",
    "polymarket:balance",
    "jupiter:submit",
    "polymarket:submit-sell",
  ]);
  assert.equal(trader.snapshot().openPositions, 0);
  assert.ok(Number(trader.snapshot().realizedProfitUsd) >= 0.10);
  assert.equal(events.filter((event) => event === "polymarket:submit-buy").length, 1);
  assert.equal(events.filter((event) => event === "polymarket:submit-sell").length, 1);
});

test("resolution-only mode does not prepare or submit an automatic profit-taking exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-resolution-only-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(
    jupiter,
    polymarket,
    join(directory, "state.json"),
    false,
    5_000_000n,
    "hold_until_resolution",
  );
  await trader.initialize();

  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  assert.equal((await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  })).type, "entry");

  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook: book("polymarket", 510_000n, 500_000n, 500_000n, 490_000n),
    jupiterBook: book("jupiter", 460_000n, 560_000n, 450_000n, 550_000n),
    atMs: 2_000,
  });

  assert.equal(decision.type, "hold");
  assert.equal(decision.reason, "HOLDING_UNTIL_RESOLUTION");
  assert.equal(trader.needsExitBook(identity.key), false);
  assert.equal(trader.snapshot().openPositions, 1);
  assert.equal(events.includes("jupiter:prepare-close"), false);
  assert.equal(events.includes("polymarket:submit-sell"), false);
});

test("startup migrates legacy Forecast position IDs and persists settlement retry errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-forecast-migration-"));
  const statePath = join(directory, "state.json");
  const jupiter = new MockJupiter([]);
  const trader = createTrader(jupiter, new MockPolymarket([]), statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  assert.equal((await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  })).type, "entry");

  const legacy = await loadLiveState(statePath);
  const legacyPosition = legacy.positions[0];
  assert.ok(legacyPosition);
  legacyPosition.jupiterPositionPubkey = "legacy-forecast-position";
  delete legacyPosition.jupiterEntryPositionPubkey;
  delete legacyPosition.settlementError;
  await saveLiveState(statePath, legacy);

  const restarted = createTrader(jupiter, new MockPolymarket([]), statePath);
  await restarted.initialize();
  const migrated = (await loadLiveState(statePath)).positions[0];
  assert.ok(migrated);
  assert.equal(
    migrated.jupiterPositionPubkey,
    `swap-v2:${identity.jupiterMarketId}:${identity.jupiterOutcomeMint}`,
  );
  assert.equal(migrated.jupiterEntryPositionPubkey, "legacy-forecast-position");
  assert.equal(migrated.settlementError, null);

  assert.equal(await restarted.recordSettlementError(identity.key, new Error("outcome token not settled")), true);
  assert.equal(await restarted.recordSettlementError(identity.key, new Error("outcome token not settled")), false);
  assert.equal(restarted.snapshot().positions[0]?.settlementError, "outcome token not settled");
  assert.equal((await loadLiveState(statePath)).positions[0]?.settlementError, "outcome token not settled");
});

test("live trader accepts a favorable size quote above the old five-percent tolerance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-favorable-size-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.contractMultiplierBps = 10_600n;
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
});

test("live trader sizes against the configured Polymarket depth haircut", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-depth-haircut-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(
    jupiter,
    polymarket,
    join(directory, "state.json"),
    false,
    5_000_000n,
    "take_profit",
    2_000,
  );
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.ok(polymarket.preparedBuy);
  assert.ok(polymarket.preparedBuy.contractsMicro <= 40_000_000n);
});

test("live trader reprices the exact Jupiter quote against Polymarket multi-level depth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-vwap-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  polymarket.buyPriceMicroUsd = 350_000n;
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 350_000n, 660_000n, 340_000n, 650_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  jupiterBook.no.asks = [
    { priceMicroUsd: 550_000n, contractsMicro: 5_000_000n },
    { priceMicroUsd: 560_000n, contractsMicro: 50_000_000n },
  ];
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(polymarket.preparedBuy?.maximumPriceMicroUsd, 350_000n);
  assert.equal((polymarket.preparedBuy?.maximumPriceMicroUsd ?? 1n) % 10_000n, 0n);
  assert.ok((polymarket.preparedBuy?.contractsMicro ?? 0n) > 0n);
  assert.equal((polymarket.preparedBuy?.contractsMicro ?? 1n) % 10_000n, 0n);
  assert.equal(
    (polymarket.preparedBuy?.maximumPriceMicroUsd ?? 1n) *
        ((polymarket.preparedBuy?.contractsMicro ?? 1n) / 10_000n) %
      1_000_000n,
    0n,
  );
  assert.equal(
    polymarket.preparedBuy?.contractsMicro,
    decision.type === "entry" ? decision.position.originalContractsMicro : null,
  );
});

test("live trader accepts a Jupiter executable price beyond the indicative-book slippage when final edge is green", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-executable-price-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.buyPriceMicroUsd = 600_000n;
  const polymarket = new MockPolymarket(events);
  polymarket.buyPriceMicroUsd = 350_000n;
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 350_000n, 660_000n, 340_000n, 650_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(events.includes("jupiter:submit"), true);
  assert.equal(events.includes("polymarket:submit-buy"), true);
});

test("one-shot live test submits one unprofitable pair and persists the attempt guard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-one-shot-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.buyPriceMicroUsd = 700_000n;
  const polymarket = new MockPolymarket(events);
  polymarket.buyPriceMicroUsd = 700_000n;
  const trader = createTrader(jupiter, polymarket, statePath, true);
  await trader.initialize();
  const polymarketBook = book("polymarket", 700_000n, 700_000n, 690_000n, 690_000n);
  const jupiterBook = book("jupiter", 700_000n, 700_000n, 690_000n, 690_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  assert.equal(route.isFeeAdjustedCandidate, false);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);

  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(decision.position.diagnosticTestEntry, true);
  assert.equal(events.includes("jupiter:submit"), true);
  assert.equal(events.includes("polymarket:submit-buy"), true);
  assert.equal((await loadLiveState(statePath)).forcedEntrySubmissionAttempted, true);

  assert.ok(await trader.markPairEnded(identity.key));
  assert.ok(await trader.settleAwaiting(identity.key, false, false));
  const second = await trader.consider({
    pair: { ...identity, key: "5m:1", startMs: 300_000, endMs: 600_000 },
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 301_000,
  });
  assert.deepEqual(second, { type: "skip", reason: "ONE_SHOT_TEST_ENTRY_ALREADY_ATTEMPTED" });
});

test("live trader executes a fresh screening build without a redundant post-fill order request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-reused-quote-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  const quote = await jupiter.prepareBuy({
    marketId: identity.jupiterMarketId,
    depositAmountMicroUsd: 5_000_000n,
  });

  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    jupiterEntryBuild: quote,
    jupiterEntryBuildAtMs: Date.now(),
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(events.filter((event) => event === "jupiter:prepare-buy").length, 1);
  assert.equal(decision.execution?.jupiter.usedPreflightBuild, true);
  const position = trader.snapshot().positions[0];
  assert.equal(position?.hedgeStatus, "bounded_residual");
  assert.equal(position?.isHedged, false);
  assert.ok(Number(position?.contractSkewBps) <= 500);
  assert.ok(Number(position?.minimumAlignedPnlUsd) > 0);
});

test("live trader reuses a screening quote through the configured poll-jitter window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-reused-jitter-quote-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const trader = createTrader(jupiter, new MockPolymarket(events), join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  const quote = await jupiter.prepareBuy({
    marketId: identity.jupiterMarketId,
    depositAmountMicroUsd: 5_000_000n,
  });

  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    jupiterEntryBuild: quote,
    jupiterEntryBuildAtMs: Date.now() - 2_500,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(decision.preflight?.reusedJupiterQuote, true);
  assert.ok((decision.preflight?.jupiterQuoteAgeMs ?? 0) >= 2_500);
  assert.equal(events.filter((event) => event === "jupiter:prepare-buy").length, 2);
});

test("live trader expands from a profitable screening build then requotes the observed fill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-reused-full-screen-quote-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(
    jupiter,
    polymarket,
    join(directory, "state.json"),
    false,
    10_000n,
  );
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  const quote = await jupiter.prepareBuy({
    marketId: identity.jupiterMarketId,
    depositAmountMicroUsd: 5_000_000n,
  });

  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    jupiterEntryBuild: quote,
    jupiterEntryBuildAtMs: Date.now() - 1_500,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(decision.preflight?.reusedJupiterQuote, true);
  assert.equal(decision.preflight?.jupiter.requestedGrossMicroUsd, 5_000_000n);
  assert.equal(decision.preflight?.jupiter.quotedContractsMicro, quote.order.newContractsMicro);
  assert.equal(events.filter((event) => event === "jupiter:prepare-buy").length, 2);
});

test("market-change preflight rejections use a short cooldown and structured diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-market-change-preflight-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.buyPriceMicroUsd = 700_000n;
  const trader = createTrader(jupiter, new MockPolymarket(events), join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "skip");
  assert.equal(decision.preflight?.stage, "cross_venue_validation");
  assert.equal(decision.preflight?.code, "FINAL_QUOTE_NOT_PROFITABLE");
  assert.equal(decision.preflight?.retryClass, "market_changed");
  assert.equal(decision.preflight?.cooldownMs, 250);
  assert.equal(
    decision.preflight?.jupiter.quotedGrossMicroUsd,
    decision.preflight?.jupiter.requestedGrossMicroUsd,
  );
  assert.ok((decision.preflight?.jupiter.quotedContractsMicro ?? 0n) > 0n);
  assert.match(decision.preflight?.error?.stack ?? "", /validateJupiterEntryBuild/);
});

test("exact quote shrink cannot submit a Polymarket market BUY below one dollar", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-poly-minimum-preflight-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.contractMultiplierBps = 6_000n;
  const polymarket = new MockPolymarket(events);
  polymarket.buyPriceMicroUsd = 100_000n;
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 900_000n, 100_000n, 890_000n, 90_000n);
  const jupiterBook = book("jupiter", 140_000n, 870_000n, 130_000n, 860_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_010_000_000n, 72_000_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "skip");
  assert.equal(decision.preflight?.stage, "cross_venue_validation");
  assert.equal(decision.preflight?.code, "POLYMARKET_BELOW_MARKETABLE_BUY_MINIMUM");
  assert.equal(decision.preflight?.retryClass, "market_changed");
  assert.equal(decision.preflight?.cooldownMs, 250);
  assert.ok((decision.preflight?.polymarket.quotedGrossMicroUsd ?? 1_000_000n) < 1_000_000n);
  assert.equal(events.includes("polymarket:prepare-buy"), false);
  assert.equal(events.includes("jupiter:submit"), false);
  assert.equal(events.includes("polymarket:submit-buy"), false);
});

test("live trader cools down after a rejected concurrent preflight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-cooldown-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.prepareBuyError = new Error("quote unavailable");
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const input = {
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  };

  const first = await trader.consider(input);
  const second = await trader.consider(input);

  assert.equal(first.type, "skip");
  assert.match(first.reason, /CONCURRENT_ENTRY_PREFLIGHT/);
  assert.equal(first.preflight?.stage, "jupiter_quote");
  assert.equal(first.preflight?.code, "JUPITER_QUOTE_REQUEST_FAILED");
  assert.equal(first.preflight?.cooldownMs, 750);
  assert.equal(first.preflight?.error?.message, "quote unavailable");
  assert.equal(second.type, "skip");
  assert.match(second.reason, /ENTRY_PREFLIGHT_COOLDOWN: pair=.*remainingMs=.*JUPITER_QUOTE_REQUEST_FAILED/);
  assert.equal(events.filter((event) => event === "jupiter:prepare-buy").length, 1);

  jupiter.prepareBuyError = null;
  const otherPair = {
    ...input,
    pair: { ...input.pair, key: "15m:other", duration: "15m" as const },
  };
  assert.equal((await trader.consider(otherPair)).type, "entry");
});

test("terminal zero-fill entry failures recover and can retry the still-open pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-zero-entry-recovery-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.submitError = new JupiterSwapExecutionError(
    6001,
    "metis",
    "failed-signature",
    "Jupiter Forecast Swap execution failed (6001): Slippage tolerance exceeded",
  );
  jupiter.positionContractsMicro = 0n;
  const polymarket = new MockPolymarket(events);
  polymarket.buyRejectionError = new PolymarketFokSubmissionError(
    "FOK_NOT_FILLED",
    "rejected",
    "Polymarket FOK buy rejected: no fill",
  );
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const nowMs = Date.now();
  const identity = {
    ...pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    key: "5m:retry-after-zero-fill",
    startMs: nowMs - 60_000,
    endMs: nowMs + 60_000,
  };

  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: nowMs,
  });

  assert.equal(decision.type, "recovery");
  assert.equal(decision.recovery?.code, "ZERO_EXPOSURE_CONFIRMED_AFTER_TERMINAL_ENTRY_FAILURE");
  assert.equal(decision.recovery?.source, "entry_execution");
  assert.equal(decision.recovery?.observedPolymarketContractsMicro, 0n);
  assert.equal(decision.recovery?.observedJupiterContractsMicro, 0n);
  assert.equal(decision.execution?.jupiter.result, "skipped");
  assert.equal(decision.execution?.jupiter.submissionAttempted, false);
  assert.equal(decision.execution?.jupiter.signed, true);
  assert.equal(decision.execution?.jupiter.transactionSignature, null);
  assert.equal(trader.snapshot().halted, false);
  assert.equal(trader.snapshot().openPositions, 0);
  const persisted = await loadLiveState(statePath);
  assert.deepEqual(persisted.positions, []);
  assert.equal(persisted.completedPairs.includes(identity.key), false);
  assert.equal(events.filter((event) => event === "jupiter:submit").length, 0);
  assert.equal(events.filter((event) => event === "polymarket:submit-buy").length, 1);

  jupiter.submitError = null;
  jupiter.positionContractsMicro = null;
  polymarket.buyRejectionError = null;
  const cooldown = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: Date.now(),
  });
  assert.equal(cooldown.type, "skip");
  assert.match(cooldown.reason, /ZERO_EXPOSURE_TERMINAL_ENTRY_RETRY/);
  await new Promise<void>((resolve) => setTimeout(resolve, 260));
  const retry = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: Date.now(),
  });
  assert.equal(retry.type, "entry");
  assert.equal(events.filter((event) => event === "jupiter:submit").length, 1);
});

test("one definitive Jupiter 6001 builds one fresh transaction and succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-jupiter-6001-retry-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.submitError = new JupiterSwapExecutionError(
    6001,
    "metis",
    "failed-signature",
    "Jupiter Forecast Swap execution failed (6001): Slippage tolerance exceeded",
  );
  jupiter.submitFailuresRemaining = 1;
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(decision.execution?.jupiter.retryCount, 1);
  assert.equal(decision.execution?.jupiter.initialError?.code, 6001);
  assert.equal(events.filter((event) => event === "jupiter:submit").length, 2);
  assert.equal(events.includes("polymarket:submit-sell"), false);
});

test("terminal Jupiter slippage failure reconciles an ambiguous successful Polymarket unwind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-poly-unwind-recovery-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.submitError = new JupiterSwapExecutionError(
    6001,
    "metis",
    "failed-signature",
    "Jupiter Forecast Swap execution failed (6001): Slippage tolerance exceeded",
  );
  const polymarket = new MockPolymarket(events);
  polymarket.ambiguousSell = true;
  polymarket.postBuyBalanceVisibilityReads = 2;
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "recovery");
  assert.equal(decision.recovery?.code, "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND");
  assert.equal(events.includes("polymarket:submit-buy"), true);
  assert.equal(events.includes("jupiter:submit"), true);
  assert.equal(events.includes("polymarket:submit-sell"), true);
  assert.ok(events.filter((event) => event === "polymarket:refresh-balance").length >= 3);
  assert.equal(trader.snapshot().openPositions, 0);
  assert.equal(trader.snapshot().halted, false);
  assert.deepEqual((await loadLiveState(statePath)).positions, []);
});

test("startup reconciliation clears a completed pre-submission Polymarket-only unwind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-startup-poly-unwind-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.prepareBuyFailuresAfterFirst = 3;
  const polymarket = new MockPolymarket(events);
  polymarket.fillContractMultiplierBps = 10_600n;
  polymarket.sellFailureBeforeFill = new Error("simulated unavailable recovery book");
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const halted = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });
  assert.equal(halted.type, "halt");
  assert.match(halted.reason, /automatic Polymarket unwind failed/);

  const restarted = createTrader(new MockJupiter([]), new MockPolymarket([]), statePath);
  await restarted.initialize();
  const recoveries = restarted.drainRecoveryDiagnostics();
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0]?.source, "startup");
  assert.equal(recoveries[0]?.code, "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND");
  assert.equal(restarted.snapshot().halted, false);
  assert.equal(restarted.snapshot().openPositions, 0);
  assert.deepEqual((await loadLiveState(statePath)).positions, []);
});

test("a transient post-fill Jupiter 429 is retried before unwinding Polymarket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-jupiter-429-retry-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.prepareBuyFailuresAfterFirst = 1;
  const polymarket = new MockPolymarket(events);
  polymarket.fillContractMultiplierBps = 10_600n;
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(events.filter((event) => event === "jupiter:prepare-buy").length, 3);
  assert.equal(events.includes("polymarket:submit-sell"), false);
  assert.equal(trader.snapshot().halted, false);
});

test("a filled Polymarket leg is hedged but quarantined when actual payoff misses entry minimums", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-emergency-positive-hedge-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.postScreeningBuyPriceMicroUsd = 570_000n;
  const polymarket = new MockPolymarket(events);
  polymarket.fillContractMultiplierBps = 10_600n;
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "halt");
  assert.equal(decision.execution?.jupiter.submissionAttempted, true);
  assert.equal(decision.execution?.jupiter.result, "fulfilled");
  assert.equal(decision.execution?.jupiter.usedPreflightBuild, false);
  assert.equal(events.includes("jupiter:submit"), true);
  assert.equal(trader.snapshot().halted, true);
  assert.match(trader.snapshot().haltReason ?? "", /actual Poly-win P&L/);
});

test("an emergency Jupiter hedge is submitted but never reported as a profitable arb", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-emergency-loss-cap-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.postScreeningBuyPriceMicroUsd = 800_000n;
  const polymarket = new MockPolymarket(events);
  polymarket.fillContractMultiplierBps = 10_600n;
  const trader = createTrader(
    jupiter,
    polymarket,
    join(directory, "state.json"),
    false,
    5_000_000n,
    "take_profit",
    0,
    50_000_000n,
  );
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "halt");
  assert.equal(decision.execution?.jupiter.submissionAttempted, true);
  assert.equal(decision.execution?.jupiter.result, "fulfilled");
  assert.equal(events.includes("jupiter:submit"), true);
  assert.equal(events.includes("polymarket:submit-sell"), false);
  assert.equal(trader.snapshot().halted, true);
});

test("terminal entry failure remains halted when balance reconciliation finds exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-nonzero-entry-recovery-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.submitError = new JupiterSwapExecutionError(
    6001,
    "metis",
    "failed-signature",
    "Jupiter Forecast Swap execution failed (6001): Slippage tolerance exceeded",
  );
  jupiter.positionContractsMicro = 1_000_000n;
  const polymarket = new MockPolymarket(events);
  polymarket.buyRejectionError = new PolymarketFokSubmissionError(
    "FOK_NOT_FILLED",
    "rejected",
    "Polymarket FOK buy rejected: no fill",
  );
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "halt");
  assert.equal(trader.snapshot().halted, true);
  assert.equal(trader.snapshot().openPositions, 1);
});

test("persisted terminal Jupiter failure auto-recovers after close when both token balances are zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-startup-zero-recovery-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.submitError = new JupiterSwapExecutionError(
    6001,
    "metis",
    null,
    "Jupiter Forecast Swap execution failed (6001): Slippage tolerance exceeded",
  );
  const polymarket = new MockPolymarket(events);
  polymarket.buyRejection = "simulated ambiguous Polymarket transport failure";
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const halted = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });
  assert.equal(halted.type, "halt");

  const restarted = createTrader(new MockJupiter([]), new MockPolymarket([]), statePath);
  await restarted.initialize();
  const recoveries = restarted.drainRecoveryDiagnostics();
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0]?.source, "startup");
  assert.equal(recoveries[0]?.code, "ZERO_EXPOSURE_CONFIRMED_AFTER_TERMINAL_ENTRY_FAILURE");
  assert.equal(restarted.snapshot().halted, false);
  assert.equal(restarted.snapshot().openPositions, 0);
  assert.deepEqual((await loadLiveState(statePath)).positions, []);
});

test("live trader submits both legs concurrently and halts when Jupiter remains pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-pending-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.pending = true;
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });
  assert.equal(decision.type, "halt");
  assert.equal(decision.execution?.jupiter.orderStatus, "pending");
  assert.equal(decision.execution?.polymarket.result, "fulfilled");
  assert.equal(trader.snapshot().halted, true);
  assert.equal(events.includes("polymarket:submit-buy"), true);

  const repeated = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_001,
  });
  assert.equal(repeated.type, "hold");
});

test("a price-improved Polymarket fill is requoted into a size-matched Jupiter hedge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-mismatch-resolution-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  polymarket.fillContractMultiplierBps = 10_600n;
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });
  assert.equal(decision.type, "entry");
  assert.equal(
    absoluteForTest(decision.position.polymarketContractsMicro - decision.position.jupiterContractsMicro) <= 10_000n,
    true,
  );
  assert.equal(events.filter((event) => event === "jupiter:prepare-buy").length, 2);
  assert.equal(trader.snapshot().halted, false);
});

test("a bounded non-exact Jupiter ExactIn quote is retained without an excess sell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-bounded-exact-in-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.postScreeningQuoteOffsetMicro = 400_000n;
  const polymarket = new MockPolymarket(events);
  polymarket.fillContractMultiplierBps = 10_600n;
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(events.filter((event) => event === "jupiter:prepare-buy").length, 2);
  assert.equal(events.includes("jupiter:prepare-sell"), false);
  assert.equal(
    absoluteForTest(decision.position.polymarketContractsMicro - decision.position.jupiterContractsMicro) > 10_000n,
    true,
  );
  assert.equal(
    decision.position.originalContractsMicro,
    minimumForTest(decision.position.polymarketContractsMicro, decision.position.jupiterContractsMicro),
  );
  assert.equal(trader.snapshot().halted, false);
});

test("startup retries a failed Polymarket-only unwind after the bought balance becomes visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-retry-poly-unwind-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const identity = {
    ...pair("UP", "DOWN"),
    key: "15m:retry-poly-unwind",
    duration: "15m" as const,
    startMs: Date.now() - 60_000,
    endMs: Date.now() + 600_000,
  };
  const reason = "Sequential entry left Jupiter execution unresolved; Polymarket observed 8.314283 " +
    "contracts: Jupiter Forecast Swap execution failed (6001): Slippage tolerance exceeded; " +
    "automatic Polymarket unwind failed: Polymarket FOK sell rejected (400): not enough balance / " +
    "allowance: the balance is not enough → balance: 0, order amount: 8310000";
  await writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    accountingVersion: 2,
    sequence: 19,
    halted: true,
    haltReason: reason,
    realizedProfitMicroUsd: "0n",
    polymarketCashMicroUsd: "94057782n",
    jupiterCashMicroUsd: "70160000n",
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [{
      id: "live-19",
      pair: identity,
      phase: "exposure_error",
      enteredAtMs: Date.now() - 30_000,
      jupiterOrderPubkey: null,
      jupiterPositionPubkey: "swap-v2:jup-down:down-mint",
      jupiterContractsMicro: "0n",
      polymarketContractsMicro: "8314283n",
      jupiterEntryCostMicroUsd: "0n",
      polymarketEntryCostMicroUsd: "5942218n",
      remainingEntryCostMicroUsd: "5942218n",
      originalContractsMicro: "0n",
      realizedProfitMicroUsd: "0n",
      polymarketSettled: false,
      jupiterSettled: false,
      polymarketSettlementPayoutMicroUsd: "0n",
      jupiterSettlementPayoutMicroUsd: "0n",
      entrySubmissionSkewMs: null,
      exitSubmissionSkewMs: null,
      diagnosticTestEntry: false,
      lastError: reason,
    }],
  }));
  const polymarket = new MockPolymarket(events);
  polymarket.seedTokenBalance(8_314_283n);
  const trader = createTrader(new MockJupiter(events), polymarket, statePath);

  await trader.initialize();

  const recoveries = trader.drainRecoveryDiagnostics();
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0]?.source, "startup");
  assert.equal(recoveries[0]?.code, "POLYMARKET_ONLY_ENTRY_AUTOMATICALLY_UNWOUND");
  assert.equal(events.includes("polymarket:submit-sell"), true);
  assert.equal(trader.snapshot().openPositions, 0);
  assert.equal(trader.snapshot().halted, false);
});

test("a larger-than-quoted Jupiter execution retains the excess outcome tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-jupiter-excess-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.executionContractMultiplierBps = 10_500n;
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "entry");
  assert.equal(events.includes("jupiter:prepare-sell"), false);
  assert.equal(
    absoluteForTest(decision.position.polymarketContractsMicro - decision.position.jupiterContractsMicro) > 10_000n,
    true,
  );
  assert.equal(trader.snapshot().halted, false);

  const hold = await trader.consider({
    pair: decision.position.pair,
    bestRoute: route,
    polymarketBook: book("polymarket", 510_000n, 500_000n, 500_000n, 490_000n),
    jupiterBook: book("jupiter", 460_000n, 560_000n, 450_000n, 550_000n),
    atMs: 2_000,
  });
  assert.equal(hold.type, "hold");
  assert.equal(hold.reason, "VENUE_SIZE_MISMATCH_HELD_TO_RESOLUTION");
  assert.equal(events.includes("jupiter:prepare-close"), false);
  assert.equal(events.includes("polymarket:submit-sell"), false);
});

test("a smaller-than-quoted Jupiter execution is quarantined from successful arbs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-polymarket-excess-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.executionContractMultiplierBps = 9_500n;
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);

  const decision = await trader.consider({
    pair: pair(route.route.polymarketOutcome, route.route.jupiterOutcome),
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });

  assert.equal(decision.type, "halt");
  assert.ok(decision.position);
  assert.equal(events.filter((event) => event === "polymarket:submit-sell").length, 0);
  assert.equal(
    absoluteForTest(decision.position.polymarketContractsMicro - decision.position.jupiterContractsMicro) > 10_000n,
    true,
  );
  assert.equal(decision.position?.jupiterQuotedContractsMicro !== undefined, true);
  assert.equal(trader.snapshot().halted, true);
  assert.ok(Number(trader.snapshot().positions[0]?.jupiterWinPnlUsd) < 0);
});

test("a Polymarket precision rejection never submits the Jupiter leg", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-poly-precision-recovery-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  polymarket.buyRejectionError = new PolymarketFokSubmissionError(
    "INVALID_AMOUNTS",
    "rejected",
    "invalid amounts, the market buy orders maker amount supports a max accuracy of 2 decimals, " +
      "taker amount a max of 4 decimals (https://clob.polymarket.com/order)",
  );
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });
  assert.equal(decision.type, "recovery");
  assert.equal(events.includes("jupiter:submit"), false);
  assert.equal(trader.snapshot().openPositions, 0);
  assert.equal(trader.snapshot().halted, false);
});

test("a Polymarket market-BUY minimum rejection never submits the Jupiter leg", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-poly-minimum-recovery-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  polymarket.buyRejectionError = new PolymarketFokSubmissionError(
    "INVALID_MINIMUM",
    "rejected",
    "invalid amount for a marketable BUY order ($0.5), min size: 1 (https://clob.polymarket.com/order)",
  );
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  const decision = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  });
  assert.equal(decision.type, "recovery");
  assert.equal(events.includes("jupiter:submit"), false);
  assert.equal(trader.snapshot().openPositions, 0);
  assert.equal(trader.snapshot().halted, false);
});

test("persisted killed Polymarket FOK safely moves the observed Jupiter-only leg to resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-poly-fok-resolution-"));
  const statePath = join(directory, "state.json");
  const identity = {
    ...pair("UP", "DOWN"),
    key: "5m:killed-fok",
    endMs: Date.now() - 1_000,
  };
  const persisted = {
    schemaVersion: 1,
    accountingVersion: 2,
    sequence: 1,
    halted: true,
    haltReason: "Polymarket concurrent-entry response was ambiguous: Polymarket FOK buy rejected (400): order couldn't be fully filled. FOK orders are fully filled or killed.",
    realizedProfitMicroUsd: "0n",
    polymarketCashMicroUsd: "100000000n",
    jupiterCashMicroUsd: "95000000n",
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [{
      id: "live-1",
      pair: identity,
      phase: "exposure_error",
      enteredAtMs: Date.now() - 60_000,
      jupiterOrderPubkey: null,
      jupiterPositionPubkey: "swap-v2:jup-down:down-mint",
      jupiterContractsMicro: "14000000n",
      polymarketContractsMicro: "0n",
      jupiterEntryCostMicroUsd: "5000000n",
      polymarketEntryCostMicroUsd: "0n",
      remainingEntryCostMicroUsd: "5000000n",
      originalContractsMicro: "0n",
      realizedProfitMicroUsd: "0n",
      polymarketSettled: false,
      jupiterSettled: false,
      polymarketSettlementPayoutMicroUsd: "0n",
      jupiterSettlementPayoutMicroUsd: "0n",
      entrySubmissionSkewMs: null,
      exitSubmissionSkewMs: null,
      diagnosticTestEntry: false,
      lastError: "Polymarket concurrent-entry response was ambiguous: Polymarket FOK buy rejected (400): order couldn't be fully filled. FOK orders are fully filled or killed.",
    }],
  };
  await writeFile(statePath, JSON.stringify(persisted));
  const trader = createTrader(new MockJupiter([]), new MockPolymarket([]), statePath);

  await trader.initialize();

  assert.equal(trader.awaitingResolution().length, 1);
  assert.equal(trader.awaitingResolution()[0]?.phase, "awaiting_resolution");
  assert.equal(trader.snapshot().halted, false);
});

test("persisted Jupiter 6001 safely settles the observed Polymarket-only leg and clears the halt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-jupiter-6001-resolution-"));
  const statePath = join(directory, "state.json");
  const identity = {
    ...pair("DOWN", "UP"),
    key: "5m:jupiter-6001",
    endMs: Date.now() - 1_000,
  };
  const reason = "Concurrent entry left Jupiter execution unresolved; Polymarket observed 7.4 contracts: " +
    "Jupiter Forecast Swap execution failed (6001): Slippage tolerance exceeded";
  await writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    accountingVersion: 2,
    sequence: 1,
    halted: true,
    haltReason: reason,
    realizedProfitMicroUsd: "0n",
    polymarketCashMicroUsd: "98437120n",
    jupiterCashMicroUsd: "100000000n",
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [{
      id: "live-1",
      pair: identity,
      phase: "exposure_error",
      enteredAtMs: Date.now() - 60_000,
      jupiterOrderPubkey: null,
      jupiterPositionPubkey: "swap-v2:jup-up:up-mint",
      jupiterContractsMicro: "0n",
      polymarketContractsMicro: "7400000n",
      jupiterEntryCostMicroUsd: "0n",
      polymarketEntryCostMicroUsd: "1562880n",
      remainingEntryCostMicroUsd: "1562880n",
      originalContractsMicro: "0n",
      realizedProfitMicroUsd: "0n",
      polymarketSettled: false,
      jupiterSettled: false,
      polymarketSettlementPayoutMicroUsd: "0n",
      jupiterSettlementPayoutMicroUsd: "0n",
      entrySubmissionSkewMs: null,
      exitSubmissionSkewMs: null,
      diagnosticTestEntry: false,
      lastError: reason,
    }],
  }));
  const trader = createTrader(new MockJupiter([]), new MockPolymarket([]), statePath);

  await trader.initialize();

  assert.equal(trader.awaitingResolution().length, 1);
  assert.equal(trader.snapshot().halted, false);
  const settlement = await trader.settleAwaiting(identity.key, false, false);
  assert.equal(settlement?.realizedProfitMicroUsd, -1_562_880n);
  assert.equal(trader.snapshot().openPositions, 0);
  assert.equal(trader.snapshot().halted, false);
  assert.equal(trader.snapshot().haltReason, null);
});

test("a fully observed size mismatch releases the global halt while settlement remains quarantined", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-size-mismatch-release-"));
  const statePath = join(directory, "state.json");
  const identity = {
    ...pair("UP", "DOWN"),
    key: "15m:known-size-mismatch",
    endMs: Date.now() - 1_000,
  };
  const reason = "Venue fills are size-mismatched; no one-sided buy top-up was attempted: " +
    "Polymarket FOK sell rejected (400): order couldn't be fully filled";
  await writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    accountingVersion: 2,
    sequence: 1,
    halted: true,
    haltReason: reason,
    realizedProfitMicroUsd: "0n",
    polymarketCashMicroUsd: "96500000n",
    jupiterCashMicroUsd: "96500000n",
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [{
      id: "live-1",
      pair: identity,
      phase: "exposure_error",
      enteredAtMs: Date.now() - 60_000,
      jupiterOrderPubkey: null,
      jupiterPositionPubkey: "swap-v2:jup-down:down-mint",
      jupiterContractsMicro: "6923824n",
      polymarketContractsMicro: "7062500n",
      jupiterEntryCostMicroUsd: "3534782n",
      polymarketEntryCostMicroUsd: "3513382n",
      remainingEntryCostMicroUsd: "7048164n",
      originalContractsMicro: "0n",
      realizedProfitMicroUsd: "0n",
      polymarketSettled: false,
      jupiterSettled: false,
      polymarketSettlementPayoutMicroUsd: "0n",
      jupiterSettlementPayoutMicroUsd: "0n",
      entrySubmissionSkewMs: 919,
      exitSubmissionSkewMs: null,
      diagnosticTestEntry: false,
      lastError: reason,
    }],
  }));
  const trader = createTrader(new MockJupiter([]), new MockPolymarket([]), statePath);

  await trader.initialize();

  assert.equal(trader.awaitingResolution().length, 1);
  assert.equal(trader.snapshot().halted, false);
  assert.equal(trader.snapshot().openPositions, 1);
  const settlement = await trader.settleAwaiting(identity.key, false, false);
  assert.ok(settlement);
  assert.equal(trader.snapshot().openPositions, 0);
  assert.equal(trader.snapshot().halted, false);
});

test("startup keeps a negative-payoff legacy size mismatch quarantined", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-size-mismatch-retain-"));
  const statePath = join(directory, "state.json");
  const identity = {
    ...pair("UP", "DOWN"),
    key: "5m:retained-size-mismatch",
    endMs: Date.now() + 60_000,
  };
  const reason = "Venue fills are size-mismatched; no one-sided buy top-up was attempted: " +
    "Jupiter Prediction API does not support partial position closes";
  await writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    accountingVersion: 2,
    sequence: 4,
    halted: true,
    haltReason: reason,
    realizedProfitMicroUsd: "0n",
    polymarketCashMicroUsd: "96500000n",
    jupiterCashMicroUsd: "96500000n",
    forcedEntrySubmissionAttempted: false,
    completedPairs: [],
    positions: [{
      id: "live-4",
      pair: identity,
      phase: "exposure_error",
      enteredAtMs: Date.now() - 5_000,
      jupiterOrderPubkey: null,
      jupiterPositionPubkey: "swap-v2:jup-down:down-mint",
      jupiterContractsMicro: "8160766n",
      polymarketContractsMicro: "7964284n",
      jupiterEntryCostMicroUsd: "6616976n",
      polymarketEntryCostMicroUsd: "2342375n",
      remainingEntryCostMicroUsd: "8959351n",
      originalContractsMicro: "0n",
      realizedProfitMicroUsd: "0n",
      polymarketSettled: false,
      jupiterSettled: false,
      polymarketSettlementPayoutMicroUsd: "0n",
      jupiterSettlementPayoutMicroUsd: "0n",
      entrySubmissionSkewMs: 100,
      exitSubmissionSkewMs: null,
      diagnosticTestEntry: false,
      lastError: reason,
    }],
  }));
  const events: string[] = [];
  const trader = createTrader(new MockJupiter(events), new MockPolymarket(events), statePath);

  await trader.initialize();

  const retained = (await loadLiveState(statePath)).positions[0];
  assert.equal(retained?.phase, "exposure_error");
  assert.equal(retained?.lastError, reason);
  assert.equal(trader.snapshot().halted, true);
  const hold = await trader.consider({
    pair: identity,
    bestRoute: null,
    polymarketBook: book("polymarket", 510_000n, 500_000n, 500_000n, 490_000n),
    jupiterBook: book("jupiter", 460_000n, 560_000n, 450_000n, 550_000n),
    atMs: Date.now(),
  });
  assert.equal(hold.type, "hold");
  assert.equal(hold.reason, reason);
  assert.deepEqual(events, []);
});

test("ambiguous halted exposure does not enter automatic redemption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-ambiguous-recovery-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.pending = true;
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  assert.equal((await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  })).type, "halt");

  const persisted = await loadLiveState(statePath);
  assert.ok(persisted.positions[0]);
  persisted.positions[0].lastError = "Concurrent exit left Jupiter execution unresolved";
  await saveLiveState(statePath, persisted);

  const restarted = createTrader(jupiter, polymarket, statePath);
  await restarted.initialize();
  assert.equal(restarted.awaitingResolution().length, 0);
  assert.equal(restarted.snapshot().halted, true);
  assert.equal(events.includes("polymarket:redeem"), false);
});

test("live trader persists and claims both winning legs after resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-settlement-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  assert.equal((await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  })).type, "entry");
  assert.ok(await trader.markPairEnded(identity.key));

  const settlement = await trader.settleAwaiting(identity.key, true, true);
  assert.ok(settlement);
  assert.equal(events.includes("polymarket:redeem"), true);
  assert.equal(events.includes("jupiter:claim"), true);
  assert.equal(events.includes("jupiter:reclaim-rent"), true);
  assert.equal(trader.snapshot().openPositions, 0);
  assert.ok(settlement.realizedProfitMicroUsd > 0n);
});

test("Forecast settlement books the verified USDC credit and reclaims token-account rent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-verified-settlement-"));
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  jupiter.claimPayoutMicroUsd = 7_123_456n;
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, join(directory, "state.json"));
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  assert.equal((await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  })).type, "entry");
  assert.ok(await trader.markPairEnded(identity.key));

  const settlement = await trader.settleAwaiting(identity.key, false, true);

  assert.equal(settlement?.jupiterPayoutMicroUsd, 7_123_456n);
  assert.equal(settlement?.jupiterSettlementTransactionSignature, "claim-signature");
  assert.deepEqual(settlement?.jupiterRentReclaimTransactionSignatures, ["rent-signature"]);
  assert.equal(settlement?.jupiterRentReclaimedLamports, 2_074_080n);
  assert.equal(events.includes("jupiter:claim"), true);
  assert.equal(events.includes("jupiter:reclaim-rent"), true);
  assert.equal(trader.snapshot().openPositions, 0);
});

test("live trader persists observed exposure when a Polymarket exit response is ambiguous", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jupol-live-ambiguous-exit-"));
  const statePath = join(directory, "state.json");
  const events: string[] = [];
  const jupiter = new MockJupiter(events);
  const polymarket = new MockPolymarket(events);
  const trader = createTrader(jupiter, polymarket, statePath);
  await trader.initialize();
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  assert.ok(route);
  const identity = pair(route.route.polymarketOutcome, route.route.jupiterOutcome);
  assert.equal((await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook,
    jupiterBook,
    atMs: 1_000,
  })).type, "entry");

  polymarket.ambiguousSell = true;
  const exit = await trader.consider({
    pair: identity,
    bestRoute: route,
    polymarketBook: book("polymarket", 510_000n, 500_000n, 500_000n, 490_000n),
    jupiterBook: book("jupiter", 460_000n, 560_000n, 450_000n, 550_000n),
    atMs: 2_000,
  });
  assert.equal(exit.type, "halt");
  const persisted = await loadLiveState(statePath);
  assert.equal(persisted.halted, true);
  assert.equal(persisted.positions[0]?.phase, "exposure_error");
  assert.equal(persisted.positions[0]?.jupiterContractsMicro, 0n);
  assert.equal(persisted.positions[0]?.polymarketContractsMicro, 0n);
});

function createTrader(
  jupiter: LiveJupiterGateway,
  polymarket: LivePolymarketGateway,
  statePath: string,
  forceOneEntry = false,
  jupiterMinimumGrossOrderMicroUsd = 5_000_000n,
  exitMode: LiveExitMode = "take_profit",
  polymarketDepthHaircutBps = 0,
  maximumAllocationMicroUsd = 25_000_000n,
): ShortWindowLiveTrader {
  return new ShortWindowLiveTrader({
    jupiter,
    polymarket,
    config: {
      strategy: {
        polymarketMaximumAllocationMicroUsd: maximumAllocationMicroUsd,
        jupiterMaximumAllocationMicroUsd: maximumAllocationMicroUsd,
        jupiterMinimumGrossOrderMicroUsd,
        polymarketMinimumGrossOrderMicroUsd: 1_000_000n,
        polymarketMinimumContractsMicro: 5_000_000n,
        minimumEntryEdgeMicroUsdPerContract: 10_000n,
        minimumEntryEdgeTotalMicroUsd: 100_000n,
        minimumExitProfitMicroUsd: 100_000n,
      },
      initialPolymarketCashMicroUsd: 100_000_000n,
      initialJupiterCashMicroUsd: 100_000_000n,
      maximumOpenPositions: 2,
      exitMode,
      maximumSlippageBps: 100,
      polymarketDepthHaircutBps,
      maximumReusableJupiterQuoteAgeMs: 3_000,
      maximumJupiterSubmissionQuoteAgeMs: 1_000,
      maximumEmergencyHedgeLossMicroUsd: 1_000_000n,
      jupiterFillTimeoutMs: 5_000,
      forceOneEntry,
      statePath,
    },
  });
}

class MockJupiter implements LiveJupiterGateway {
  readonly ownerPubkey = "owner";
  readonly #events: string[];
  pending = false;
  contractMultiplierBps = 10_000n;
  executionContractMultiplierBps = 10_000n;
  postScreeningQuoteOffsetMicro = 0n;
  buyPriceMicroUsd = 550_000n;
  postScreeningBuyPriceMicroUsd: bigint | null = null;
  prepareBuyError: Error | null = null;
  prepareBuyFailuresAfterFirst = 0;
  submitError: Error | null = null;
  submitFailuresRemaining: number | null = null;
  positionContractsMicro: bigint | null = null;
  claimPayoutMicroUsd: bigint | null = null;
  reclaimedLamports = 2_074_080n;
  lastBuyIsYes: boolean | null = null;
  #lastBuild: JupiterPredictionOrderBuild | null = null;
  #submittedContractsMicro = 0n;
  #prepareBuyCalls = 0;

  constructor(events: string[]) {
    this.#events = events;
  }

  async prepareBuy(input: {
    marketId: string;
    depositAmountMicroUsd: bigint;
    outcomeMint?: string;
    isYes?: boolean;
  }): Promise<JupiterPredictionOrderBuild> {
    this.#events.push("jupiter:prepare-buy");
    this.#prepareBuyCalls += 1;
    if (this.prepareBuyError) throw this.prepareBuyError;
    if (this.#prepareBuyCalls > 1 && this.prepareBuyFailuresAfterFirst > 0) {
      this.prepareBuyFailuresAfterFirst -= 1;
      throw new Error("HTTP 429: Too many requests");
    }
    this.lastBuyIsYes = input.isYes ?? true;
    const buyPriceMicroUsd = this.#prepareBuyCalls > 1 && this.postScreeningBuyPriceMicroUsd !== null
      ? this.postScreeningBuyPriceMicroUsd
      : this.buyPriceMicroUsd;
    const contracts = input.depositAmountMicroUsd * 1_000_000n / buyPriceMicroUsd *
      this.contractMultiplierBps / 10_000n +
      (this.#prepareBuyCalls > 1 ? this.postScreeningQuoteOffsetMicro : 0n);
    this.#lastBuild = build({
      marketId: input.marketId,
      isBuy: true,
      isYes: this.lastBuyIsYes,
      contracts,
      gross: input.depositAmountMicroUsd,
    });
    return this.#lastBuild;
  }

  async prepareClose(positionPubkey: string): Promise<JupiterPredictionOrderBuild> {
    this.#events.push("jupiter:prepare-close");
    const contracts = this.#lastBuild?.order.contractsMicro ?? 10_000_000n;
    this.#lastBuild = build({
      marketId: "jup-down",
      isBuy: false,
      contracts,
      gross: contracts * 550_000n / 1_000_000n,
      positionPubkey,
      isYes: this.#lastBuild?.order.isYes ?? true,
    });
    return this.#lastBuild;
  }

  async prepareSell(positionPubkey: string, contractsMicro: bigint): Promise<JupiterPredictionOrderBuild> {
    this.#events.push("jupiter:prepare-sell");
    this.#lastBuild = build({
      marketId: "jup-down",
      isBuy: false,
      contracts: contractsMicro,
      gross: contractsMicro * 550_000n / 1_000_000n,
      positionPubkey,
      isYes: this.#lastBuild?.order.isYes ?? true,
    });
    return this.#lastBuild;
  }

  async prepareSubmission(value: JupiterPredictionOrderBuild): Promise<PreparedJupiterSubmission> {
    this.#events.push("jupiter:prepare-submission");
    return { build: value, signedTransaction: "signed-transaction" };
  }

  async submitPreparedAndWait(value: PreparedJupiterSubmission): Promise<SubmittedJupiterOrder> {
    this.#events.push("jupiter:submit");
    if (this.submitError && (this.submitFailuresRemaining === null || this.submitFailuresRemaining > 0)) {
      if (this.submitFailuresRemaining !== null) this.submitFailuresRemaining -= 1;
      throw this.submitError;
    }
    const executionContracts = value.build.order.isBuy
      ? value.build.order.contractsMicro * this.executionContractMultiplierBps / 10_000n
      : value.build.order.contractsMicro;
    if (!this.pending && value.build.order.isBuy) {
      this.#submittedContractsMicro = executionContracts;
    } else if (!this.pending) {
      this.#submittedContractsMicro = this.#submittedContractsMicro > value.build.order.contractsMicro
        ? this.#submittedContractsMicro - value.build.order.contractsMicro
        : 0n;
    }
    const executionStatus = status(value.build, this.pending ? "pending" : "filled");
    if (!this.pending && value.build.order.isBuy) {
      executionStatus.contractsMicro = executionContracts;
      executionStatus.filledContractsMicro = executionContracts;
    }
    return {
      transactionSignature: "signature",
      submissionStartedAtMs: 1_000,
      status: executionStatus,
    };
  }

  async waitForOrder(): Promise<JupiterPredictionOrderStatus> {
    if (this.submitError) throw new Error("terminal Swap V2 execution has no keeper order");
    if (!this.#lastBuild) throw new Error("missing build");
    return status(this.#lastBuild, this.pending ? "pending" : "filled");
  }

  async getPosition(positionPubkey: string): Promise<JupiterPredictionPosition> {
    return {
      positionPubkey,
      marketId: this.#lastBuild?.order.marketId ?? "jup-down",
      isYes: this.#lastBuild?.order.isYes ?? true,
      contractsMicro: this.positionContractsMicro ?? this.#submittedContractsMicro,
      totalCostMicroUsd: this.#lastBuild?.order.orderCostMicroUsd ?? 0n,
      feesPaidMicroUsd: 0n,
      sellPriceMicroUsd: 550_000n,
      claimable: false,
      claimed: false,
      claimedMicroUsd: 0n,
      result: null,
    };
  }

  async claimPosition(): Promise<{ transactionSignature: string; payoutMicroUsd: bigint }> {
    this.#events.push("jupiter:claim");
    return {
      transactionSignature: "claim-signature",
      payoutMicroUsd: this.claimPayoutMicroUsd ?? this.#submittedContractsMicro,
    };
  }

  async reclaimPositionRent(): Promise<{
    transactionSignatures: string[];
    reclaimedLamports: bigint;
  }> {
    this.#events.push("jupiter:reclaim-rent");
    return {
      transactionSignatures: ["rent-signature"],
      reclaimedLamports: this.reclaimedLamports,
    };
  }
}

class MockPolymarket implements LivePolymarketGateway {
  readonly #events: string[];
  #balance = 0n;
  #preparedBuy: { contractsMicro: bigint; maximumPriceMicroUsd: bigint } | null = null;
  #preparedSell: { contractsMicro: bigint; minimumPriceMicroUsd: bigint } | null = null;
  ambiguousSell = false;
  sellFailureBeforeFill: Error | null = null;
  buyRejection: string | null = null;
  buyRejectionError: Error | null = null;
  buyPriceMicroUsd = 400_000n;
  fillContractMultiplierBps = 10_000n;
  postBuyBalanceVisibilityReads = 0;

  get preparedBuy(): { contractsMicro: bigint; maximumPriceMicroUsd: bigint } | null {
    return this.#preparedBuy;
  }

  get preparedSell(): { contractsMicro: bigint; minimumPriceMicroUsd: bigint } | null {
    return this.#preparedSell;
  }

  constructor(events: string[]) {
    this.#events = events;
  }

  seedTokenBalance(contractsMicro: bigint): void {
    this.#balance = contractsMicro;
  }

  async assertTokenReady(): Promise<bigint> {
    this.#events.push("polymarket:preflight");
    return this.#balance;
  }

  async primeBuyToken(): Promise<void> {}

  async fetchBuyAsks(): Promise<{
    asks: BookLevel[];
    receivedAtMs: number;
    sourceTimestampMs: number | null;
  }> {
    return {
      asks: [{ priceMicroUsd: this.buyPriceMicroUsd, contractsMicro: 1_000_000_000n }],
      receivedAtMs: Date.now(),
      sourceTimestampMs: Date.now(),
    };
  }

  async redeemMarket(): Promise<string> {
    this.#events.push("polymarket:redeem");
    this.#balance = 0n;
    return "redeem-hash";
  }

  async prepareBuyFok(
    input: { contractsMicro: bigint; grossAmountMicroUsd: bigint; maximumPriceMicroUsd: bigint },
  ): Promise<PreparedPolymarketFokOrder> {
    this.#events.push("polymarket:prepare-buy");
    this.#preparedBuy = input;
    return { kind: "buy", signedOrder: {} as never };
  }

  async prepareSellFok(
    input: { contractsMicro: bigint; minimumPriceMicroUsd: bigint },
  ): Promise<PreparedPolymarketFokOrder> {
    this.#events.push("polymarket:prepare-sell");
    this.#preparedSell = input;
    return { kind: "sell", signedOrder: {} as never };
  }

  async submitPreparedFok(prepared: PreparedPolymarketFokOrder): Promise<PolymarketLiveFill> {
    this.#events.push(`polymarket:submit-${prepared.kind}`);
    if (prepared.kind === "buy") {
      if (this.buyRejectionError) throw this.buyRejectionError;
      if (this.buyRejection) throw new Error(this.buyRejection);
      return this.#submitBuy();
    }
    return this.#submitSell();
  }

  #submitBuy(): PolymarketLiveFill {
    const input = this.#preparedBuy;
    if (!input) throw new Error("missing prepared buy");
    const contractsMicro = input.contractsMicro * this.fillContractMultiplierBps / 10_000n;
    const grossMicroUsd = contractsMicro * this.buyPriceMicroUsd / 1_000_000n;
    this.#balance += contractsMicro;
    return {
      orderId: "poly-buy",
      contractsMicro,
      grossMicroUsd,
      submissionStartedAtMs: 1_001,
      transactionHashes: [],
    };
  }

  #submitSell(): PolymarketLiveFill {
    const input = this.#preparedSell;
    if (!input) throw new Error("missing prepared sell");
    if (this.sellFailureBeforeFill) throw this.sellFailureBeforeFill;
    this.#balance -= input.contractsMicro;
    if (this.ambiguousSell) throw new Error("simulated response timeout after fill");
    return {
      orderId: "poly-sell",
      contractsMicro: input.contractsMicro,
      grossMicroUsd: input.contractsMicro * 500_000n / 1_000_000n,
      submissionStartedAtMs: 1_001,
      transactionHashes: [],
    };
  }

  async getTokenBalance(): Promise<bigint> {
    this.#events.push("polymarket:balance");
    return this.#balance;
  }

  async refreshTokenBalance(): Promise<bigint> {
    this.#events.push("polymarket:refresh-balance");
    if (this.#balance > 0n && this.postBuyBalanceVisibilityReads > 0) {
      this.postBuyBalanceVisibilityReads -= 1;
      return 0n;
    }
    return this.#balance;
  }
}

function build(input: {
  marketId: string;
  isBuy: boolean;
  contracts: bigint;
  gross: bigint;
  positionPubkey?: string;
  isYes?: boolean;
}): JupiterPredictionOrderBuild {
  return {
    transaction: "transaction",
    txMeta: { blockhash: "blockhash", lastValidBlockHeight: 1 },
    externalOrderId: "external",
    jupiterSwapRequestId: "swap-request",
    requiredSigners: ["owner"],
    execution: { endpoint: "/execute", context: {} },
    executionModel: "atomic_swap",
    settlement: "auto",
    order: {
      orderPubkey: input.isBuy ? "jup-buy" : "jup-sell",
      positionPubkey: input.positionPubkey ?? "jup-position",
      marketId: input.marketId,
      isBuy: input.isBuy,
      isYes: input.isYes ?? true,
      contractsMicro: input.contracts,
      newContractsMicro: input.isBuy ? input.contracts : 0n,
      maxBuyPriceMicroUsd: input.isBuy ? 555_000n : null,
      minSellPriceMicroUsd: input.isBuy ? null : 550_000n,
      orderCostMicroUsd: input.isBuy ? input.gross : 0n,
      newAveragePriceMicroUsd: input.isBuy && input.contracts > 0n
        ? input.gross * 1_000_000n / input.contracts
        : null,
      newSizeMicroUsd: input.isBuy ? input.gross : 0n,
      payoutMicroUsd: input.isBuy ? input.contracts : input.gross,
      estimatedTotalFeeMicroUsd: 50_000n,
    },
  };
}

function status(buildValue: JupiterPredictionOrderBuild, state: "pending" | "filled"): JupiterPredictionOrderStatus {
  return {
    orderPubkey: buildValue.order.orderPubkey,
    positionPubkey: buildValue.order.positionPubkey,
    marketId: buildValue.order.marketId,
    status: state,
    isBuy: buildValue.order.isBuy,
    isYes: buildValue.order.isYes,
    contractsMicro: buildValue.order.contractsMicro,
    filledContractsMicro: state === "filled" ? buildValue.order.contractsMicro : 0n,
    averageFillPriceMicroUsd: buildValue.order.isBuy ? 550_000n : 550_000n,
    sizeMicroUsd: buildValue.order.isBuy ? buildValue.order.orderCostMicroUsd : buildValue.order.payoutMicroUsd,
    settled: state === "filled",
  };
}

function absoluteForTest(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function minimumForTest(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function pair(polymarketOutcome: "UP" | "DOWN", jupiterOutcome: "UP" | "DOWN"): LivePairIdentity {
  return {
    key: "5m:0",
    duration: "5m",
    startMs: 0,
    endMs: 300_000,
    polymarketMarketId: "poly-market",
    polymarketSlug: "poly-slug",
    polymarketTokenId: "poly-token",
    polymarketOutcome,
    jupiterMarketId: jupiterOutcome === "UP" ? "jup-up" : "jup-down",
    jupiterOutcomeMint: jupiterOutcome === "UP" ? "up-mint" : "down-mint",
    jupiterOutcome,
  };
}

function book(
  venue: "polymarket" | "jupiter",
  upAsk: bigint,
  downAsk: bigint,
  upBid: bigint,
  downBid: bigint,
): BinaryOrderBook {
  const size = 50_000_000n;
  return {
    venue,
    provider: venue === "jupiter" ? "bisonfi" : "polymarket",
    marketId: `${venue}-market`,
    receivedAtMs: 1,
    sourceTimestampMs: null,
    yes: { bids: [{ priceMicroUsd: upBid, contractsMicro: size }], asks: [{ priceMicroUsd: upAsk, contractsMicro: size }] },
    no: { bids: [{ priceMicroUsd: downBid, contractsMicro: size }], asks: [{ priceMicroUsd: downAsk, contractsMicro: size }] },
  };
}
