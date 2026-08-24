import assert from "node:assert/strict";
import test from "node:test";

import { eligibleCrossVenueRoutes, evaluateCrossVenueRoutes } from "../src/short-window.ts";
import {
  evaluateShortWindowEntry,
  evaluateShortWindowExit,
  quoteBuyAcrossLevels,
  type ShortWindowStrategyConfig,
} from "../src/short-window-strategy.ts";
import type { BinaryOrderBook } from "../src/types.ts";

const CONFIG: ShortWindowStrategyConfig = {
  polymarketMaximumAllocationMicroUsd: 25_000_000n,
  jupiterMaximumAllocationMicroUsd: 25_000_000n,
  jupiterMinimumGrossOrderMicroUsd: 5_000_000n,
  polymarketMinimumGrossOrderMicroUsd: 1_000_000n,
  polymarketMinimumContractsMicro: 5_000_000n,
  minimumEntryEdgeMicroUsdPerContract: 10_000n,
  minimumEntryEdgeTotalMicroUsd: 100_000n,
  minimumExitProfitMicroUsd: 100_000n,
};

test("sizes the largest fee-adjusted entry that fits venue budgets", () => {
  const route = evaluateCrossVenueRoutes(
    book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n, 50_000_000n),
    book("jupiter", 460_000n, 550_000n, 450_000n, 540_000n, 50_000_000n),
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  const result = evaluateShortWindowEntry({
    route,
    polymarketAvailableMicroUsd: 100_000_000n,
    jupiterAvailableMicroUsd: 100_000_000n,
    config: CONFIG,
  });

  assert.equal(result.eligible, true);
  if (!result.eligible) return;
  assert.ok(result.proposal.jupiter.grossMicroUsd >= 5_000_000n);
  assert.ok(result.proposal.polymarket.allInMicroUsd <= 25_000_000n);
  assert.ok(result.proposal.jupiter.allInMicroUsd <= 25_000_000n);
  assert.ok(result.proposal.edgeMicroUsdPerContract >= 10_000n);
  assert.ok(result.proposal.nominalEdgeMicroUsd >= 100_000n);
  assert.ok(
    result.proposal.quantityMicro > 40_000_000n,
    "uses the available profitable budget instead of stopping at the first qualifying size",
  );
});

test("stops at the largest size that preserves the conservative per-contract edge", () => {
  const polymarket = book("polymarket", 400_000n, 610_000n, 390_000n, 600_000n, 100_000_000n);
  polymarket.yes.asks = [
    { priceMicroUsd: 400_000n, contractsMicro: 10_000_000n },
    { priceMicroUsd: 600_000n, contractsMicro: 90_000_000n },
  ];
  const jupiter = book("jupiter", 460_000n, 500_000n, 450_000n, 490_000n, 100_000_000n);
  const route = evaluateCrossVenueRoutes(
    polymarket,
    jupiter,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  const config = {
    ...CONFIG,
    polymarketMaximumAllocationMicroUsd: 100_000_000n,
    jupiterMaximumAllocationMicroUsd: 100_000_000n,
    jupiterMinimumGrossOrderMicroUsd: 10_000n,
  };
  const result = evaluateShortWindowEntry({
    route,
    polymarketAvailableMicroUsd: 100_000_000n,
    jupiterAvailableMicroUsd: 100_000_000n,
    config,
  });

  assert.equal(result.eligible, true);
  if (!result.eligible || !route) return;
  assert.ok(result.proposal.quantityMicro > 10_000_000n);
  assert.ok(result.proposal.quantityMicro < 100_000_000n);
  assert.ok(result.proposal.edgeMicroUsdPerContract >= config.minimumEntryEdgeMicroUsdPerContract);

  const nextQuantity = result.proposal.quantityMicro + 10_000n;
  const nextPolymarket = quoteBuyAcrossLevels(route.polymarketAsks, nextQuantity, "polymarket");
  const nextJupiter = quoteBuyAcrossLevels(route.jupiterAsks, nextQuantity, "jupiter");
  assert.ok(nextPolymarket && nextJupiter);
  if (!nextPolymarket || !nextJupiter) return;
  const nextEdgePerContract = (nextQuantity - nextPolymarket.allInMicroUsd - nextJupiter.allInMicroUsd) *
    1_000_000n / nextQuantity;
  assert.ok(nextEdgePerContract < config.minimumEntryEdgeMicroUsdPerContract);
});

test("rejects an otherwise positive route when the $5 Jupiter order cannot fit the budgets", () => {
  const route = evaluateCrossVenueRoutes(
    book("polymarket", 950_000n, 60_000n, 940_000n, 50_000n, 1_000_000_000n),
    book("jupiter", 990_000n, 10_000n, 980_000n, 5_000n, 1_000_000_000n),
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  )[0] ?? null;
  const result = evaluateShortWindowEntry({
    route,
    polymarketAvailableMicroUsd: 100_000_000n,
    jupiterAvailableMicroUsd: 100_000_000n,
    config: CONFIG,
  });

  assert.deepEqual(result, { eligible: false, reason: "JUPITER_MINIMUM_ORDER_UNREACHABLE" });
});

test("sizes a sub-$5 Forecast token swap to the hedgeable quantity", () => {
  const polymarket = book("polymarket", 90_000n, 920_000n, 80_000n, 910_000n, 1_000_000_000n);
  const jupiter = book("jupiter", 61_458n, 950_000n, 50_000n, 940_000n, 81_360_000n);
  jupiter.yes.asks = [{ priceMicroUsd: 61_458n, contractsMicro: 81_360_000n, takerFeeIncluded: true }];
  const route = evaluateCrossVenueRoutes(
    polymarket,
    jupiter,
    eligibleCrossVenueRoutes(77_288_027_537n, 77_280_081_194n),
  )[0] ?? null;
  const result = evaluateShortWindowEntry({
    route,
    polymarketAvailableMicroUsd: 50_000_000n,
    jupiterAvailableMicroUsd: 50_000_000n,
    config: { ...CONFIG, jupiterMinimumGrossOrderMicroUsd: 10_000n },
  });

  assert.equal(result.eligible, true);
  if (!result.eligible) return;
  assert.ok(result.proposal.jupiter.grossMicroUsd < 5_000_000n);
  assert.ok(result.proposal.polymarket.allInMicroUsd <= 50_000_000n);
  assert.ok(result.proposal.nominalEdgeMicroUsd >= 100_000n);
});

test("scales a cheap Polymarket leg to the one-dollar marketable BUY minimum", () => {
  const route = evaluateCrossVenueRoutes(
    book("polymarket", 900_000n, 100_000n, 890_000n, 90_000n, 100_000_000n),
    book("jupiter", 870_000n, 140_000n, 860_000n, 130_000n, 100_000_000n),
    eligibleCrossVenueRoutes(72_010_000_000n, 72_000_000_000n),
  )[0] ?? null;
  const result = evaluateShortWindowEntry({
    route,
    polymarketAvailableMicroUsd: 50_000_000n,
    jupiterAvailableMicroUsd: 50_000_000n,
    config: { ...CONFIG, jupiterMinimumGrossOrderMicroUsd: 10_000n },
  });

  assert.equal(result.eligible, true);
  if (!result.eligible) return;
  assert.ok(result.proposal.polymarket.grossMicroUsd >= 1_000_000n);
  assert.ok(result.proposal.quantityMicro >= 10_000_000n);
});

test("rejects a cheap Polymarket leg when depth cannot reach one dollar", () => {
  const route = evaluateCrossVenueRoutes(
    book("polymarket", 900_000n, 100_000n, 890_000n, 90_000n, 5_000_000n),
    book("jupiter", 870_000n, 140_000n, 860_000n, 130_000n, 5_000_000n),
    eligibleCrossVenueRoutes(72_010_000_000n, 72_000_000_000n),
  )[0] ?? null;
  const result = evaluateShortWindowEntry({
    route,
    polymarketAvailableMicroUsd: 50_000_000n,
    jupiterAvailableMicroUsd: 50_000_000n,
    config: { ...CONFIG, jupiterMinimumGrossOrderMicroUsd: 10_000n },
  });

  assert.deepEqual(result, { eligible: false, reason: "POLYMARKET_MINIMUM_ORDER_UNREACHABLE" });
});

test("walks deeper asks when Jupiter's best level alone is below the $5 minimum", () => {
  const polymarketBook = book(
    "polymarket",
    690_000n,
    320_000n,
    680_000n,
    310_000n,
    100_000_000n,
  );
  const jupiterBook = book(
    "jupiter",
    770_000n,
    238_000n,
    760_000n,
    228_000n,
    100_000_000n,
  );
  jupiterBook.no.asks = [
    { priceMicroUsd: 238_000n, contractsMicro: 16_403_917n },
    { priceMicroUsd: 248_000n, contractsMicro: 100_000_000n },
  ];
  const route = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(77_000_000_000n, 77_010_000_000n),
  )[0] ?? null;

  const result = evaluateShortWindowEntry({
    route,
    polymarketAvailableMicroUsd: 100_000_000n,
    jupiterAvailableMicroUsd: 100_000_000n,
    config: CONFIG,
  });

  assert.equal(result.eligible, true);
  if (!result.eligible) return;
  assert.ok(result.proposal.quantityMicro > 16_403_917n);
  assert.ok(result.proposal.jupiter.grossMicroUsd >= 5_000_000n);
  assert.equal(result.proposal.jupiter.levelsConsumed, 2);
  assert.equal(result.proposal.jupiter.limitPriceMicroUsd, 248_000n);
  assert.ok(result.proposal.jupiter.priceMicroUsd > 238_000n);
  assert.ok(result.proposal.jupiter.priceMicroUsd < 248_000n);
  assert.ok(result.proposal.nominalEdgeMicroUsd >= CONFIG.minimumEntryEdgeTotalMicroUsd);
});

test("exits only when full bid depth covers both legs and proceeds are green after exit fees", () => {
  const polymarketBook = book("polymarket", 510_000n, 500_000n, 500_000n, 490_000n, 20_000_000n);
  const jupiterBook = book("jupiter", 460_000n, 560_000n, 450_000n, 550_000n, 20_000_000n);
  polymarketBook.yes.bids = [
    { priceMicroUsd: 510_000n, contractsMicro: 4_000_000n },
    { priceMicroUsd: 500_000n, contractsMicro: 20_000_000n },
  ];
  jupiterBook.no.bids = [
    { priceMicroUsd: 560_000n, contractsMicro: 4_000_000n },
    { priceMicroUsd: 550_000n, contractsMicro: 20_000_000n },
  ];
  const result = evaluateShortWindowExit({
    polymarketBook,
    jupiterBook,
    polymarketOutcome: "UP",
    jupiterOutcome: "DOWN",
    quantityMicro: 10_000_000n,
    entryAllInCostMicroUsd: 9_500_000n,
    minimumExitProfitMicroUsd: CONFIG.minimumExitProfitMicroUsd,
  });

  assert.equal(result.eligible, true);
  if (!result.eligible) return;
  assert.ok(result.proposal.realizedProfitMicroUsd >= 100_000n);
  assert.ok(result.proposal.polymarketTakerFeeMicroUsd > 0n);
  assert.ok(result.proposal.jupiterTakerFeeMicroUsd > 0n);
  assert.equal(result.proposal.polymarketBid.priceMicroUsd, 500_000n);
  assert.equal(result.proposal.jupiterBid.priceMicroUsd, 550_000n);
});

function book(
  venue: "polymarket" | "jupiter",
  upAskMicroUsd: bigint,
  downAskMicroUsd: bigint,
  upBidMicroUsd: bigint,
  downBidMicroUsd: bigint,
  contractsMicro: bigint,
): BinaryOrderBook {
  return {
    venue,
    provider: venue === "jupiter" ? "bisonfi" : "polymarket",
    marketId: `${venue}-market`,
    receivedAtMs: 1,
    sourceTimestampMs: null,
    yes: {
      bids: [{ priceMicroUsd: upBidMicroUsd, contractsMicro }],
      asks: [{ priceMicroUsd: upAskMicroUsd, contractsMicro }],
    },
    no: {
      bids: [{ priceMicroUsd: downBidMicroUsd, contractsMicro }],
      asks: [{ priceMicroUsd: downAskMicroUsd, contractsMicro }],
    },
  };
}
