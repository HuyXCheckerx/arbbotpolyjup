import assert from "node:assert/strict";
import test from "node:test";

import type { JupiterPredictionOrderBuild } from "../../../packages/venue-jupiter/src/client.ts";
import {
  buildJupiterAtomicQuoteBook,
  buildJupiterForecastOrderBook,
  buildJupiterMarketPricingBook,
  initialJupiterRollingQuoteGross,
  jupiterRollingQuoteRetryDelayMs,
  JupiterPredictionPriceBookState,
  JupiterRollingAtomicQuoteBookState,
  type JupiterBuyQuoteGateway,
} from "../src/jupiter-quote-fallback.ts";

test("seeds executable discovery at the Jupiter minimum instead of the screening maximum", () => {
  assert.equal(initialJupiterRollingQuoteGross(5_000_000n, 50_000_000n), 5_000_000n);
  assert.equal(initialJupiterRollingQuoteGross(5_000_000n, 4_000_000n), 4_000_000n);
});

test("persistent rolling quote build failures back off to ten seconds", () => {
  assert.equal(jupiterRollingQuoteRetryDelayMs(200, 1), 400);
  assert.equal(jupiterRollingQuoteRetryDelayMs(200, 5), 6_400);
  assert.equal(jupiterRollingQuoteRetryDelayMs(200, 6), 10_000);
  assert.equal(jupiterRollingQuoteRetryDelayMs(200, 20), 10_000);
});

test("queries and maps the selected Forecast outcome market instead of always using UP", async () => {
  const calls: string[] = [];
  const result = await buildJupiterForecastOrderBook({
    gateway: {
      async getOrderBook(marketId) {
        calls.push(marketId);
        return {
          venue: "jupiter",
          provider: "bisonfi",
          marketId,
          receivedAtMs: 123,
          sourceTimestampMs: null,
          yes: {
            bids: [{ priceMicroUsd: 390_000n, contractsMicro: 8_000_000n }],
            asks: [{ priceMicroUsd: 410_000n, contractsMicro: 7_000_000n }],
          },
          no: {
            bids: [{ priceMicroUsd: 580_000n, contractsMicro: 6_000_000n }],
            asks: [{ priceMicroUsd: 620_000n, contractsMicro: 5_000_000n }],
          },
        };
      },
    },
    upMarketId: "event-UP",
    downMarketId: "event-DOWN",
    outcomes: ["DOWN"],
  });

  assert.deepEqual(calls, ["event-DOWN"]);
  assert.deepEqual(result.yes, { bids: [], asks: [] });
  assert.deepEqual(result.no, {
    bids: [{ priceMicroUsd: 390_000n, contractsMicro: 8_000_000n }],
    asks: [{ priceMicroUsd: 410_000n, contractsMicro: 7_000_000n }],
  });
});

test("creates an entry-only Jupiter book from unsigned size-specific atomic quotes", async () => {
  const calls: string[] = [];
  const gateway: JupiterBuyQuoteGateway = {
    async prepareBuy(input): Promise<JupiterPredictionOrderBuild> {
      calls.push(`${input.marketId}:${input.depositAmountMicroUsd}`);
      const contracts = input.marketId.endsWith("-UP") ? 10_000_000n : 20_000_000n;
      return build(input.marketId, input.depositAmountMicroUsd, contracts);
    },
  };

  const result = await buildJupiterAtomicQuoteBook({
    gateway,
    upMarketId: "event-UP",
    downMarketId: "event-DOWN",
    outcomes: ["UP", "DOWN", "UP"],
    grossAmountMicroUsd: 5_000_000n,
  });

  assert.deepEqual(calls.sort(), ["event-DOWN:5000000", "event-UP:5000000"]);
  assert.equal(result.book.provider, "bisonfi_atomic_quote");
  assert.deepEqual(result.book.yes.bids, []);
  assert.deepEqual(result.book.no.bids, []);
  assert.deepEqual(result.book.yes.asks, [{
    priceMicroUsd: 500_000n,
    contractsMicro: 10_000_000n,
    takerFeeIncluded: true,
  }]);
  assert.deepEqual(result.book.no.asks, [{
    priceMicroUsd: 250_000n,
    contractsMicro: 20_000_000n,
    takerFeeIncluded: true,
  }]);
  assert.equal(result.builds.get("UP")?.order.marketId, "event-UP");
  assert.equal(result.builds.get("DOWN")?.order.marketId, "event-DOWN");
});

test("rolling executable quote state rejects out-of-order responses and expires each outcome independently", () => {
  const state = new JupiterRollingAtomicQuoteBookState({
    upMarketId: "event-UP",
    downMarketId: "event-DOWN",
    outcomes: ["UP", "DOWN"],
  });
  const newestUp = build("event-UP", 5_000_000n, 10_000_000n);
  const staleUp = build("event-UP", 5_000_000n, 9_000_000n);
  const down = build("event-DOWN", 5_000_000n, 20_000_000n);

  const upSnapshot = state.apply({
    outcome: "UP",
    sequence: 2,
    build: newestUp,
    builtAtMs: 1_000,
    maximumAgeMs: 500,
  });
  assert.equal(upSnapshot?.builds.get("UP"), newestUp);
  assert.equal(state.apply({
    outcome: "UP",
    sequence: 1,
    build: staleUp,
    builtAtMs: 1_100,
    maximumAgeMs: 500,
  }), null);

  const both = state.apply({
    outcome: "DOWN",
    sequence: 1,
    build: down,
    builtAtMs: 1_200,
    maximumAgeMs: 500,
  });
  assert.equal(both?.book.receivedAtMs, 1_000);
  assert.equal(both?.builds.get("UP"), newestUp);
  assert.equal(both?.builds.get("DOWN"), down);

  const downOnly = state.snapshot(1_501, 500);
  assert.equal(downOnly?.builds.has("UP"), false);
  assert.equal(downOnly?.builds.get("DOWN"), down);
  assert.equal(state.snapshot(1_701, 500), null);
});

test("uses Jupiter's indicative market price before spending an atomic quote request", async () => {
  const result = await buildJupiterMarketPricingBook({
    gateway: {
      async getMarket(marketId) {
        return {
          venue: "jupiter",
          provider: "bisonfi",
          eventId: "event",
          marketId,
          title: marketId.endsWith("-UP") ? "Up" : "Down",
          eventTitle: "BTC",
          rulesPrimary: "",
          rulesSecondary: "",
          status: "open",
          openTimeMs: 0,
          closeTimeMs: 1,
          clobTokenIds: [],
          outcomes: [],
          pricing: {
            buyYesMicroUsd: marketId.endsWith("-UP") ? 400_000n : 600_000n,
            sellYesMicroUsd: null,
            buyNoMicroUsd: null,
            sellNoMicroUsd: null,
          },
          sourceUrl: "https://api.jup.ag",
        };
      },
    },
    upMarketId: "event-UP",
    downMarketId: "event-DOWN",
    outcomes: ["UP"],
    grossAmountMicroUsd: 5_000_000n,
  });

  assert.equal(result.provider, "bisonfi_market_pricing");
  assert.deepEqual(result.yes.asks, [{ priceMicroUsd: 400_000n, contractsMicro: 12_500_000n }]);
  assert.deepEqual(result.no.asks, []);
});

test("maps both Degen price websocket tickers into an ask-only entry book", () => {
  const state = new JupiterPredictionPriceBookState({
    upMarketId: "event-UP",
    downMarketId: "event-DOWN",
    outcomes: ["UP", "DOWN", "UP"],
    grossAmountMicroUsd: 5_000_000n,
  });
  const upOnly = state.apply({
    marketId: "event-UP",
    sourceTimestampMs: 1_000,
    receivedAtMs: 1_010,
    yesBidMicroUsd: 390_000n,
    yesAskMicroUsd: 400_000n,
    noBidMicroUsd: 0n,
    noAskMicroUsd: 0n,
  });
  assert.ok(upOnly);
  assert.deepEqual(upOnly.yes.asks, [{ priceMicroUsd: 400_000n, contractsMicro: 12_500_000n }]);
  assert.deepEqual(upOnly.no.asks, []);

  const book = state.apply({
    marketId: "event-DOWN",
    sourceTimestampMs: 1_005,
    receivedAtMs: 1_015,
    yesBidMicroUsd: 580_000n,
    yesAskMicroUsd: 600_000n,
    noBidMicroUsd: 0n,
    noAskMicroUsd: 0n,
  });
  assert.ok(book);
  assert.equal(book.provider, "bisonfi_price_websocket");
  assert.equal(book.sourceTimestampMs, 1_005);
  assert.deepEqual(book.yes, {
    bids: [],
    asks: [{ priceMicroUsd: 400_000n, contractsMicro: 12_500_000n }],
  });
  assert.deepEqual(book.no, {
    bids: [],
    asks: [{ priceMicroUsd: 600_000n, contractsMicro: 8_340_000n }],
  });
});

function build(marketId: string, gross: bigint, contracts: bigint): JupiterPredictionOrderBuild {
  return {
    transaction: "unsigned-transaction",
    txMeta: { blockhash: "blockhash", lastValidBlockHeight: 1 },
    externalOrderId: null,
    jupiterSwapRequestId: "swap-request",
    requiredSigners: ["owner"],
    execution: { endpoint: "/execute", context: {} },
    executionModel: "atomic_swap",
    settlement: "auto",
    order: {
      orderPubkey: null,
      positionPubkey: `position-${marketId}`,
      marketId,
      isBuy: true,
      isYes: true,
      contractsMicro: contracts,
      newContractsMicro: contracts,
      maxBuyPriceMicroUsd: null,
      minSellPriceMicroUsd: null,
      orderCostMicroUsd: gross,
      newAveragePriceMicroUsd: gross * 1_000_000n / contracts,
      newSizeMicroUsd: gross,
      payoutMicroUsd: contracts,
      estimatedTotalFeeMicroUsd: 0n,
    },
  };
}
