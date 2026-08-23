import assert from "node:assert/strict";
import test from "node:test";

import { eligibleCrossVenueRoutes, evaluateCrossVenueRoutes } from "../../../packages/domain/src/short-window.ts";
import type { BinaryOrderBook } from "../../../packages/domain/src/types.ts";
import { ShortWindowPaperTrader, type PaperPairIdentity } from "../src/short-window-paper-trader.ts";

test("paper trader reserves venue cash and releases it only on a full green exit", () => {
  const trader = createTrader();
  const entryBooks = {
    polymarket: book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n),
    jupiter: book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n),
  };
  const route = evaluateCrossVenueRoutes(
    entryBooks.polymarket,
    entryBooks.jupiter,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  const entry = trader.consider({
    pair: pair(),
    bestRoute: route,
    polymarketBook: entryBooks.polymarket,
    jupiterBook: entryBooks.jupiter,
    atMs: 1_000,
  });
  assert.equal(entry.type, "entry");
  assert.ok(Number(trader.snapshot().polymarketCashUsd) < 100);
  assert.ok(Number(trader.snapshot().jupiterCashUsd) < 100);

  const exit = trader.consider({
    pair: pair(),
    bestRoute: route,
    polymarketBook: book("polymarket", 510_000n, 500_000n, 500_000n, 490_000n),
    jupiterBook: book("jupiter", 460_000n, 560_000n, 450_000n, 550_000n),
    atMs: 2_000,
  });
  assert.equal(exit.type, "exit");
  assert.ok(Number(trader.snapshot().realizedProfitUsd) >= 0.10);
  assert.equal(trader.snapshot().openPositions, 0);
});

test("paper trader holds through close and credits venue-specific resolution payouts", () => {
  const trader = createTrader();
  const polymarket = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiter = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarket,
    jupiter,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  const entry = trader.consider({ pair: pair(), bestRoute: route, polymarketBook: polymarket, jupiterBook: jupiter, atMs: 1_000 });
  assert.equal(entry.type, "entry");
  assert.ok(trader.markPairEnded(pair().key));
  const settlement = trader.settle(pair().key, true, false);
  assert.ok(settlement);
  assert.equal(settlement.polymarketWon, true);
  assert.equal(settlement.jupiterWon, false);
  assert.equal(trader.snapshot().openPositions, 0);
});

test("paper trader can hold two different pairs while enforcing venue cash", () => {
  const trader = createTrader(2, 50_000_000n);
  const polymarket = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n);
  const jupiter = book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n);
  const route = evaluateCrossVenueRoutes(
    polymarket,
    jupiter,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;

  const first = trader.consider({
    pair: pair("5m:0", "5m"),
    bestRoute: route,
    polymarketBook: polymarket,
    jupiterBook: jupiter,
    atMs: 1_000,
  });
  const second = trader.consider({
    pair: pair("15m:0", "15m"),
    bestRoute: route,
    polymarketBook: polymarket,
    jupiterBook: jupiter,
    atMs: 1_000,
  });
  const third = trader.consider({
    pair: pair("5m:1", "5m"),
    bestRoute: route,
    polymarketBook: polymarket,
    jupiterBook: jupiter,
    atMs: 1_000,
  });

  assert.equal(first.type, "entry");
  assert.equal(second.type, "entry");
  assert.equal(third.type, "skip");
  assert.equal(third.reason, "MAXIMUM_OPEN_POSITIONS");
  assert.equal(trader.snapshot().openPositions, 2);
  assert.ok(Number(trader.snapshot().polymarketCashUsd) >= 0);
  assert.ok(Number(trader.snapshot().jupiterCashUsd) >= 0);
});

function createTrader(maximumOpenPositions = 1, maximumAllocationMicroUsd = 25_000_000n): ShortWindowPaperTrader {
  return new ShortWindowPaperTrader({
    polymarketStartingCashMicroUsd: 100_000_000n,
    jupiterStartingCashMicroUsd: 100_000_000n,
    maximumOpenPositions,
    strategy: {
      polymarketMaximumAllocationMicroUsd: maximumAllocationMicroUsd,
      jupiterMaximumAllocationMicroUsd: maximumAllocationMicroUsd,
      jupiterMinimumGrossOrderMicroUsd: 5_000_000n,
      polymarketMinimumGrossOrderMicroUsd: 1_000_000n,
      polymarketMinimumContractsMicro: 5_000_000n,
      minimumEntryEdgeMicroUsdPerContract: 10_000n,
      minimumEntryEdgeTotalMicroUsd: 100_000n,
      minimumExitProfitMicroUsd: 100_000n,
    },
  });
}

function pair(key = "5m:0", duration: "5m" | "15m" = "5m"): PaperPairIdentity {
  return {
    key,
    duration,
    startMs: 0,
    endMs: 300_000,
    polymarketSlug: "poly-slug",
    polymarketMarketId: "poly-market",
    jupiterSelectedMarketId: "jup-down",
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
