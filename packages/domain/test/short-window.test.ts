import assert from "node:assert/strict";
import test from "node:test";

import {
  allComplementaryCrossVenueRoutes,
  eligibleCrossVenueRoutes,
  evaluateCrossVenueRoutes,
  jupiterPredictionTakerFeeTotalMicroUsd,
  polymarketCryptoTakerFeePerContractMicroUsd,
} from "../src/short-window.ts";
import type { BinaryOrderBook } from "../src/types.ts";

test("selects the threshold-dominance route from cross-venue reference ordering", () => {
  assert.deepEqual(eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n), [{
    polymarketOutcome: "UP",
    jupiterOutcome: "DOWN",
    reason: "POLYMARKET_REFERENCE_LOWER",
  }]);
  assert.deepEqual(eligibleCrossVenueRoutes(72_004_000_000n, 72_000_000_000n), [{
    polymarketOutcome: "DOWN",
    jupiterOutcome: "UP",
    reason: "POLYMARKET_REFERENCE_HIGHER",
  }]);
});

test("any-route mode ranks both complementary directions by fee-adjusted edge", () => {
  const result = evaluateCrossVenueRoutes(
    book("polymarket", 700_000n, 200_000n, 10_000_000n),
    book("jupiter", 300_000n, 600_000n, 10_000_000n),
    allComplementaryCrossVenueRoutes(),
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result[0]?.route, {
    polymarketOutcome: "DOWN",
    jupiterOutcome: "UP",
    reason: "ANY_COMPLEMENTARY_ROUTE",
  });
  assert.equal(result[0]?.isFeeAdjustedCandidate, true);
  assert.equal(result[1]?.isFeeAdjustedCandidate, false);
});

test("calculates venue-specific taker fee rounding", () => {
  assert.equal(polymarketCryptoTakerFeePerContractMicroUsd(500_000n), 17_500n);
  assert.equal(polymarketCryptoTakerFeePerContractMicroUsd(10_000n), 690n);
  assert.equal(jupiterPredictionTakerFeeTotalMicroUsd(250_000n, 100_000_000n), 1_320_000n);
  assert.equal(jupiterPredictionTakerFeeTotalMicroUsd(250_000n, 1_000_000n), 20_000n);
});

test("evaluates the selected Polymarket/Jupiter route with both taker fees", () => {
  const routes = eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n);
  const result = evaluateCrossVenueRoutes(
    book("polymarket", 400_000n, 610_000n, 10_000_000n),
    book("jupiter", 460_000n, 550_000n, 8_000_000n),
    routes,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.route.polymarketOutcome, "UP");
  assert.equal(result[0]?.route.jupiterOutcome, "DOWN");
  assert.equal(result[0]?.commonTopContractsMicro, 8_000_000n);
  assert.equal(result[0]?.grossCostTotalMicroUsd, 7_600_000n);
  assert.equal(result[0]?.polymarketTakerFeeTotalMicroUsd, 134_400n);
  assert.equal(result[0]?.jupiterTakerFeeTotalMicroUsd, 140_000n);
  assert.equal(result[0]?.isFeeAdjustedCandidate, true);
});

test("does not add a second Jupiter fee to an all-in atomic quote", () => {
  const polymarketBook = book("polymarket", 400_000n, 610_000n, 10_000_000n);
  const jupiterBook = book("jupiter", 460_000n, 550_000n, 10_000_000n);
  const downAsk = jupiterBook.no.asks[0];
  assert.ok(downAsk);
  downAsk.takerFeeIncluded = true;

  const result = evaluateCrossVenueRoutes(
    polymarketBook,
    jupiterBook,
    eligibleCrossVenueRoutes(72_000_000_000n, 72_004_000_000n),
  );

  assert.equal(result[0]?.jupiterTakerFeeTotalMicroUsd, 0n);
  assert.equal(result[0]?.takerFeeTotalMicroUsd, result[0]?.polymarketTakerFeeTotalMicroUsd);
});

function book(
  venue: "polymarket" | "jupiter",
  upAskMicroUsd: bigint,
  downAskMicroUsd: bigint,
  contractsMicro: bigint,
): BinaryOrderBook {
  return {
    venue,
    provider: venue === "jupiter" ? "bisonfi" : "polymarket",
    marketId: `${venue}-market`,
    receivedAtMs: 1,
    sourceTimestampMs: null,
    yes: { bids: [], asks: [{ priceMicroUsd: upAskMicroUsd, contractsMicro }] },
    no: { bids: [], asks: [{ priceMicroUsd: downAskMicroUsd, contractsMicro }] },
  };
}
