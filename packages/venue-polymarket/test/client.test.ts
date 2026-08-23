import assert from "node:assert/strict";
import test from "node:test";

import { HttpClient } from "../../domain/src/http.ts";
import type { VenueMarket } from "../../domain/src/types.ts";
import { PolymarketClient, resolveYesNoTokens } from "../src/client.ts";

test("sorts Polymarket CLOB books into executable order", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (input) => {
      const url = String(input);
      const yes = url.includes("yes-token");
      return jsonResponse({
        market: "condition-1",
        timestamp: yes ? "1000" : "1001",
        bids: yes
          ? [{ price: "0.40", size: "10" }, { price: "0.42", size: "5" }]
          : [{ price: "0.55", size: "12" }],
        asks: yes
          ? [{ price: "0.60", size: "3" }, { price: "0.58", size: "8" }]
          : [{ price: "0.50", size: "4" }],
      });
    },
  });
  const client = new PolymarketClient({ clobUrl: "https://example.test", http });
  const book = await client.getOrderBook(market());
  assert.equal(book.sourceTimestampMs, 1001);
  assert.equal(book.yes.bids[0]?.priceMicroUsd, 420_000n);
  assert.equal(book.yes.asks[0]?.priceMicroUsd, 580_000n);
  assert.equal(book.no.bids[0]?.priceMicroUsd, 550_000n);
});

test("loads all child markets from a Polymarket event slug", async () => {
  let requestedUrl = "";
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        id: "862400",
        title: "Bitcoin above ___ on August 21?",
        markets: [{
          id: "3651166",
          question: "Will the price of Bitcoin be above $72,000 on August 21?",
          active: true,
          closed: false,
          acceptingOrders: true,
          clobTokenIds: '["yes-token", "no-token"]',
          outcomes: '["Yes", "No"]',
        }],
      });
    },
  });
  const client = new PolymarketClient({ gammaUrl: "https://example.test", http });
  const markets = await client.getEventMarketsBySlug("bitcoin-above-on-august-21-2026");

  assert.equal(requestedUrl, "https://example.test/events/slug/bitcoin-above-on-august-21-2026");
  assert.equal(markets.length, 1);
  assert.equal(markets[0]?.eventId, "862400");
  assert.equal(markets[0]?.marketId, "3651166");
  assert.equal(markets[0]?.eventTitle, "Bitcoin above ___ on August 21?");
});

test("maps Up/Down short-window outcomes to the positive and negative token books", () => {
  const shortWindow = market();
  shortWindow.clobTokenIds = ["up-token", "down-token"];
  shortWindow.outcomes = ["Up", "Down"];
  assert.deepEqual(resolveYesNoTokens(shortWindow), ["up-token", "down-token"]);
});

test("reads the finalized Up/Down outcome for paper settlement", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({
      markets: [{ closed: true, outcomes: '["Up", "Down"]', outcomePrices: '["0", "1"]' }],
    }),
  });
  const client = new PolymarketClient({ gammaUrl: "https://example.test", http });
  assert.equal(await client.getResolvedOutcomeBySlug("btc-updown-5m-1"), "DOWN");
});

test("reads the selected Yes/No child outcome by market ID", async () => {
  let requestedUrl = "";
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({ closed: true, outcomes: '["Yes", "No"]', outcomePrices: '["0", "1"]' });
    },
  });
  const client = new PolymarketClient({ gammaUrl: "https://example.test", http });
  assert.equal(await client.getResolvedOutcomeByMarketId("3635565"), "DOWN");
  assert.equal(requestedUrl, "https://example.test/markets/3635565");
});

function market(): VenueMarket {
  return {
    venue: "polymarket",
    provider: "polymarket",
    eventId: "event-1",
    marketId: "market-1",
    title: "test",
    eventTitle: "test",
    rulesPrimary: "test",
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
