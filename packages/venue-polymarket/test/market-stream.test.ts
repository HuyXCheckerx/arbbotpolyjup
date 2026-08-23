import assert from "node:assert/strict";
import test from "node:test";

import type { VenueMarket } from "../../domain/src/types.ts";
import { PolymarketOrderBookState } from "../src/market-stream.ts";

test("builds a two-token book and emits only top-of-book changes", () => {
  const state = new PolymarketOrderBookState(market());
  const first = state.applyPayload([
    {
      event_type: "book",
      asset_id: "yes-token",
      timestamp: "1000",
      bids: [{ price: "0.60", size: "20" }, { price: "0.61", size: "10" }],
      asks: [{ price: "0.66", size: "15" }, { price: "0.65", size: "5" }],
    },
    {
      event_type: "book",
      asset_id: "no-token",
      timestamp: "1001",
      bids: [{ price: "0.34", size: "5" }],
      asks: [{ price: "0.40", size: "20" }, { price: "0.36", size: "8" }],
    },
  ], 1_100);

  assert.equal(first?.eventType, "book");
  assert.equal(first?.book.yes.bids[0]?.priceMicroUsd, 610_000n);
  assert.equal(first?.book.yes.asks[0]?.priceMicroUsd, 650_000n);
  assert.equal(first?.book.no.asks[0]?.priceMicroUsd, 360_000n);
  assert.equal(first?.book.sourceTimestampMs, 1001);

  const nonTop = state.applyPayload({
    event_type: "price_change",
    timestamp: "1002",
    price_changes: [{ asset_id: "yes-token", price: "0.67", size: "30", side: "SELL" }],
  }, 1_101);
  assert.equal(nonTop, null);

  const changed = state.applyPayload({
    event_type: "price_change",
    timestamp: "1003",
    price_changes: [{ asset_id: "yes-token", price: "0.64", size: "12", side: "SELL" }],
  }, 1_102);
  assert.equal(changed?.eventType, "price_change");
  assert.equal(changed?.book.yes.asks[0]?.priceMicroUsd, 640_000n);
  assert.equal(changed?.book.yes.asks[0]?.contractsMicro, 12_000_000n);

  const removed = state.applyPayload({
    event_type: "price_change",
    timestamp: "1004",
    price_changes: [{ asset_id: "yes-token", price: "0.64", size: "0", side: "SELL" }],
  }, 1_103);
  assert.equal(removed?.book.yes.asks[0]?.priceMicroUsd, 650_000n);
});

function market(): VenueMarket {
  return {
    venue: "polymarket",
    provider: "polymarket",
    eventId: "862400",
    marketId: "3651166",
    title: "Will Bitcoin be above $72,000?",
    eventTitle: "Bitcoin above ___ on August 21?",
    rulesPrimary: "",
    rulesSecondary: "",
    status: "open",
    openTimeMs: null,
    closeTimeMs: null,
    clobTokenIds: ["yes-token", "no-token"],
    outcomes: ["Yes", "No"],
    pricing: {
      buyYesMicroUsd: null,
      sellYesMicroUsd: null,
      buyNoMicroUsd: null,
      sellNoMicroUsd: null,
    },
    sourceUrl: "https://example.test",
  };
}
