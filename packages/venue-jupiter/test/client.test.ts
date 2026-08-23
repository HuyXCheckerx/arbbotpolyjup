import assert from "node:assert/strict";
import test from "node:test";

import { HttpClient } from "../../domain/src/http.ts";
import { JupiterClient } from "../src/client.ts";
import { predictionExecutionRequestId } from "../src/trading.ts";

test("derives executable asks from opposite-outcome bids", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({
      yes_dollars: [["0.4000", 10], ["0.4100", 5]],
      no_dollars: [["0.5500", 12], ["0.5600", 7]],
    }),
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  const book = await client.getOrderBook("market-1");
  assert.equal(book.yes.bids[0]?.priceMicroUsd, 410_000n);
  assert.equal(book.yes.asks[0]?.priceMicroUsd, 440_000n);
  assert.equal(book.no.bids[0]?.priceMicroUsd, 560_000n);
  assert.equal(book.no.asks[0]?.priceMicroUsd, 590_000n);
});

test("supports near-term subcategory discovery", async () => {
  let requestedUrl = "";
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({ data: [], pagination: { hasNext: false } });
    },
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  await client.getMarkets({
    provider: "bisonfi",
    category: "crypto",
    subcategory: "btc",
    filter: "live",
    tag: "5m",
    sortBy: "beginAt",
    sortDirection: "desc",
    maxEvents: 100,
    pageSize: 100,
  });

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("subcategory"), "btc");
  assert.equal(url.searchParams.get("filter"), "live");
  assert.equal(url.searchParams.get("tag"), "5m");
  assert.equal(url.searchParams.get("sortBy"), "beginAt");
  assert.equal(url.searchParams.get("sortDirection"), "desc");
  assert.equal(url.searchParams.get("start"), "0");
  assert.equal(url.searchParams.get("end"), "100");
});

test("selects child markets by Jupiter parent event ID", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({
      data: [
        {
          eventId: "POLY-862399",
          metadata: { title: "another event" },
          markets: [{ marketId: "POLY-other" }],
        },
        {
          eventId: "POLY-862400",
          metadata: { title: "Bitcoin above ___ on August 21?" },
          markets: [{ marketId: "POLY-3651166", title: "72,000", provider: "polymarket" }],
        },
      ],
      pagination: { hasNext: false },
    }),
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  const markets = await client.getEventMarkets("POLY-862400", {
    provider: "polymarket",
    category: "crypto",
    subcategory: "btc",
    maxEvents: 100,
    pageSize: 100,
  });

  assert.equal(markets.length, 1);
  assert.equal(markets[0]?.eventId, "POLY-862400");
  assert.equal(markets[0]?.marketId, "POLY-3651166");
  assert.equal(markets[0]?.eventTitle, "Bitcoin above ___ on August 21?");
});

test("reads whether the selected Jupiter outcome market won for paper settlement", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({ marketId: "BISON-test-UP", result: "yes" }),
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  assert.equal(await client.didSelectedMarketWin("BISON-test-UP"), true);
});

test("builds and executes a Jupiter Forecast order using documented micro-unit fields", async () => {
  const requests: Array<{ url: string; method: string; body: unknown; apiKey: string | null }> = [];
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
        apiKey: new Headers(init?.headers).get("x-api-key"),
      });
      if (url.endsWith("/execute")) {
        return jsonResponse({ status: "Success", signature: "solana-signature", error: null, requestId: "external-1" });
      }
      return jsonResponse({
        transaction: "dHJhbnNhY3Rpb24=",
        txMeta: { blockhash: "blockhash", lastValidBlockHeight: 123 },
        externalOrderId: "external-1",
        order: {
          orderPubkey: "order-1",
          positionPubkey: "position-1",
          marketId: "BISON-market-UP",
          isBuy: true,
          isYes: true,
          contractsMicro: "10000000",
          newContractsMicro: "10000000",
          maxBuyPriceUsd: "510000",
          minSellPriceUsd: null,
          orderCostUsd: "5000000",
          newAvgPriceUsd: "500000",
          newSizeUsd: "5000000",
          payoutUsd: "10000000",
          estimatedTotalFeeUsd: "90000",
        },
        requiredSigners: ["owner-1"],
        execution: { endpoint: "/api/v1/execute", context: { jupiterSwapRequestId: "swap-1" } },
        executionModel: "atomic_swap",
        settlement: "auto",
        jupiterSwapRequestId: "swap-1",
      });
    },
  });
  const client = new JupiterClient({
    baseUrl: "https://example.test/prediction/v1",
    apiKey: "test-key",
    http,
    minRequestIntervalMs: 0,
  });

  const build = await client.createPredictionBuyOrder({
    ownerPubkey: "owner-1",
    marketId: "BISON-market-UP",
    depositAmountMicroUsd: 5_000_000n,
  });
  assert.equal(build.order.contractsMicro, 10_000_000n);
  assert.equal(build.order.newAveragePriceMicroUsd, 500_000n);
  assert.equal(build.order.estimatedTotalFeeMicroUsd, 90_000n);
  assert.equal(build.executionModel, "atomic_swap");
  assert.equal(build.jupiterSwapRequestId, "swap-1");
  assert.deepEqual(build.execution.context, { jupiterSwapRequestId: "swap-1" });
  assert.deepEqual(requests[0]?.body, {
    isBuy: true,
    ownerPubkey: "owner-1",
    marketId: "BISON-market-UP",
    isYes: true,
    depositAmount: "5000000",
    depositMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  });
  assert.equal(requests[0]?.apiKey, "test-key");

  const execution = await client.executePredictionOrder({
    signedTransaction: "signed-base64",
    context: build.execution.context,
    requestId: predictionExecutionRequestId(build),
  });
  assert.equal(execution.status, "Success");
  assert.equal(execution.signature, "solana-signature");
  assert.deepEqual(requests[1]?.body, {
    signedTransaction: "signed-base64",
    context: { jupiterSwapRequestId: "swap-1" },
  });
});

test("accepts Forecast atomic swaps with no keeper order pubkey", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({
      transaction: "dHJhbnNhY3Rpb24=",
      txMeta: { blockhash: "blockhash", lastValidBlockHeight: 123 },
      externalOrderId: null,
      order: {
        orderPubkey: null,
        positionPubkey: "position-forecast-1",
        marketId: "BISON-market-UP",
        isBuy: true,
        isYes: true,
        contractsMicro: "10000000",
        newContractsMicro: "10000000",
        maxBuyPriceUsd: "510000",
        minSellPriceUsd: null,
        orderCostUsd: "5000000",
        newAvgPriceUsd: "500000",
        newSizeUsd: "5000000",
        payoutUsd: "10000000",
        estimatedTotalFeeUsd: "90000",
      },
      requiredSigners: ["owner-1"],
      execution: {
        endpoint: "/api/v1/execute",
        context: { type: "jupiter_swap", jupiterSwapRequestId: "swap-live-1", ownerPubkey: "owner-1" },
      },
      executionModel: "atomic_swap",
      settlement: "auto",
      jupiterSwapRequestId: "swap-live-1",
    }),
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  const build = await client.createPredictionBuyOrder({
    ownerPubkey: "owner-1",
    marketId: "BISON-market-UP",
    depositAmountMicroUsd: 5_000_000n,
  });

  assert.equal(build.order.orderPubkey, null);
  assert.equal(build.order.positionPubkey, "position-forecast-1");
  assert.equal(build.jupiterSwapRequestId, "swap-live-1");
  assert.equal(predictionExecutionRequestId(build), "swap-live-1");
});

test("builds a NO-side order for a standard binary provider market", async () => {
  let requestBody: unknown = null;
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (_input, init) => {
      requestBody = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      return jsonResponse({
        transaction: "dHJhbnNhY3Rpb24=",
        txMeta: { blockhash: "blockhash", lastValidBlockHeight: 123 },
        externalOrderId: "external-no",
        order: {
          orderPubkey: "order-no",
          positionPubkey: "position-no",
          marketId: "POLY-3635565",
          isBuy: true,
          isYes: false,
          contractsMicro: "5000000",
          newContractsMicro: "5000000",
          maxBuyPriceUsd: "410000",
          orderCostUsd: "2000000",
          newAvgPriceUsd: "400000",
          newSizeUsd: "2000000",
          payoutUsd: "5000000",
          estimatedTotalFeeUsd: "30000",
        },
        requiredSigners: ["owner-1"],
        execution: { endpoint: "/prediction/v1/execute", context: {} },
      });
    },
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  const build = await client.createPredictionBuyOrder({
    ownerPubkey: "owner-1",
    marketId: "POLY-3635565",
    isYes: false,
    depositAmountMicroUsd: 2_000_000n,
  });
  assert.equal(build.order.isYes, false);
  assert.deepEqual(requestBody, {
    isBuy: true,
    ownerPubkey: "owner-1",
    marketId: "POLY-3635565",
    isYes: false,
    depositAmount: "2000000",
    depositMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  });
});

test("parses Jupiter order status fields as documented micro units", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({
      pubkey: "order-1",
      position: "position-1",
      marketId: "BISON-market-UP",
      status: "filled",
      isBuy: true,
      isYes: true,
      contracts: "10000000",
      filledContracts: "10000000",
      avgFillPriceUsd: "500000",
      sizeUsd: "5000000",
      settled: true,
    }),
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  const order = await client.getPredictionOrder("order-1");
  assert.equal(order.filledContractsMicro, 10_000_000n);
  assert.equal(order.averageFillPriceMicroUsd, 500_000n);
  assert.equal(order.sizeMicroUsd, 5_000_000n);
});

test("parses decimal contract quantities from Jupiter position responses", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({
      pubkey: "position-1",
      marketId: "BISON-market-UP",
      isYes: true,
      contracts: "10.5",
      totalCostUsd: "5000000",
      feesPaidUsd: "90000",
      sellPriceUsd: "510000",
      claimable: false,
      claimed: false,
      claimedUsd: "0",
      marketMetadata: { result: "pending" },
    }),
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  const position = await client.getPredictionPosition("position-1");
  assert.equal(position.contractsMicro, 10_500_000n);
  assert.equal(position.totalCostMicroUsd, 5_000_000n);
});

test("builds a Jupiter payout claim with exact payout units", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { ownerPubkey: "owner-1" });
      return jsonResponse({
        transaction: "claim-transaction-base64",
        position: {
          pubkey: "position-1",
          contractsMicro: "10000000",
          payoutAmountUsd: "10000000",
        },
        blockhash: "claim-blockhash",
        lastValidBlockHeight: 456,
      });
    },
  });
  const client = new JupiterClient({ baseUrl: "https://example.test", http, minRequestIntervalMs: 0 });
  const claim = await client.createPredictionClaim({ ownerPubkey: "owner-1", positionPubkey: "position-1" });
  assert.equal(claim.contractsMicro, 10_000_000n);
  assert.equal(claim.payoutMicroUsd, 10_000_000n);
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
