import assert from "node:assert/strict";
import test from "node:test";

import { buildAskMonitorSample } from "../src/ask-monitor.ts";
import type { BinaryOrderBook } from "../src/types.ts";

test("records venue ask differences and selects the best route per outcome", () => {
  const sample = buildAskMonitorSample({
    sessionId: "session-1",
    sequence: 1,
    startedAtMs: 10_000,
    completedAtMs: 10_100,
    polymarket: book("polymarket", 10_020, 10_010, 550_000n, 480_000n, 8_000_000n),
    jupiter: book("jupiter", 10_030, null, 560_000n, 440_000n, 5_000_000n),
  });

  assert.equal(sample.askDifferences.yes.jupiterMinusPolymarketMicroUsd, "10000");
  assert.equal(sample.bestAvailable.yes.venue, "polymarket");
  assert.equal(sample.bestAvailable.no.venue, "jupiter");
  assert.ok(sample.warnings.includes("SHARED_LIQUIDITY"));
  assert.ok(sample.warnings.includes("JUPITER_SOURCE_TIMESTAMP_UNAVAILABLE"));
});

test("selects YES and NO venues independently and prefers Polymarket on raw-price ties", () => {
  const sample = buildAskMonitorSample({
    sessionId: "session-2",
    sequence: 1,
    startedAtMs: 20_000,
    completedAtMs: 20_100,
    polymarket: book("polymarket", 20_020, 20_010, 675_000n, 329_000n, 80_000_000n),
    jupiter: book("jupiter", 20_030, null, 670_000n, 331_000n, 40_000_000n),
  });

  assert.equal(sample.bestAvailable.yes.venue, "jupiter");
  assert.equal(sample.bestAvailable.no.venue, "polymarket");

  const tied = buildAskMonitorSample({
    sessionId: "session-3",
    sequence: 1,
    startedAtMs: 30_000,
    completedAtMs: 30_100,
    polymarket: book("polymarket", 30_020, 30_010, 660_000n, 342_000n, 40_000_000n),
    jupiter: book("jupiter", 30_030, null, 660_000n, 342_000n, 40_000_000n),
  });

  assert.equal(tied.bestAvailable.yes.venue, "polymarket");
  assert.equal(tied.bestAvailable.yes.rawPriceTie, true);
  assert.equal(tied.bestAvailable.yes.selectionReason, "RAW_PRICE_TIE_PREFER_POLYMARKET_LOWER_ROUTE_RISK");
  assert.equal(tied.bestAvailable.no.venue, "polymarket");
});

function book(
  venue: "polymarket" | "jupiter",
  receivedAtMs: number,
  sourceTimestampMs: number | null,
  yesAsk: bigint,
  noAsk: bigint,
  contractsMicro: bigint,
): BinaryOrderBook {
  return {
    venue,
    provider: "polymarket",
    marketId: venue === "polymarket" ? "3651166" : "POLY-3651166",
    receivedAtMs,
    sourceTimestampMs,
    yes: {
      bids: [{ priceMicroUsd: yesAsk - 20_000n, contractsMicro }],
      asks: [{ priceMicroUsd: yesAsk, contractsMicro }],
    },
    no: {
      bids: [{ priceMicroUsd: noAsk - 20_000n, contractsMicro }],
      asks: [{ priceMicroUsd: noAsk, contractsMicro }],
    },
  };
}
