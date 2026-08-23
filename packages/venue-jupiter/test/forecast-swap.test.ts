import assert from "node:assert/strict";
import test from "node:test";

import { HttpClient } from "../../domain/src/http.ts";
import {
  JupiterSwapClient,
  JupiterSwapOrderBuildError,
  forecastSwapBuild,
  type JupiterSwapOrder,
} from "../src/forecast-swap.ts";

test("builds and executes a Forecast outcome-token order through Swap V2", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (request, init) => {
      const url = String(request);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.endsWith("/execute")) {
        return jsonResponse({
          status: "Success",
          signature: "signature-1",
          code: 0,
          totalInputAmount: "750000",
          totalOutputAmount: "12000000",
        });
      }
      return jsonResponse({
        transaction: "unsigned-base64",
        requestId: "swap-request-1",
        inputMint: "usdc",
        outputMint: "forecast-mint",
        inAmount: "750000",
        outAmount: "12000000",
        lastValidBlockHeight: 123,
        router: "metis",
        mode: "manual",
      });
    },
  });
  const client = new JupiterSwapClient({
    baseUrl: "https://example.test/swap/v2",
    apiKey: "test-key",
    http,
    minimumRequestIntervalMs: 0,
  });

  const order = await client.createOrder({
    inputMint: "usdc",
    outputMint: "forecast-mint",
    amount: 750_000n,
    taker: "owner-1",
    slippageBps: 100,
  });
  const execution = await client.execute({ signedTransaction: "signed-base64", requestId: order.requestId });

  const orderUrl = new URL(requests[0]?.url ?? "");
  assert.equal(orderUrl.pathname, "/swap/v2/order");
  assert.equal(orderUrl.searchParams.get("amount"), "750000");
  assert.equal(orderUrl.searchParams.get("slippageBps"), "100");
  assert.deepEqual(requests[1]?.body, {
    signedTransaction: "signed-base64",
    requestId: "swap-request-1",
  });
  assert.equal(execution.totalInputAmount, 750_000n);
  assert.equal(execution.totalOutputAmount, 12_000_000n);
});

test("adapts an all-in Swap V2 quote to the live trader build contract", () => {
  const order: JupiterSwapOrder = {
    transaction: "unsigned-base64",
    requestId: "request-1",
    inputMint: "usdc",
    outputMint: "forecast-mint",
    inAmount: 750_000n,
    outAmount: 12_000_000n,
    lastValidBlockHeight: 123,
    router: "metis",
    mode: "manual",
  };
  const build = forecastSwapBuild({
    order,
    marketId: "BISON-round-UP",
    outcomeMint: "forecast-mint",
    isBuy: true,
    ownerPubkey: "owner-1",
  });

  assert.equal(build.execution.endpoint, "/swap/v2/execute");
  assert.equal(build.order.orderCostMicroUsd, 750_000n);
  assert.equal(build.order.newContractsMicro, 12_000_000n);
  assert.equal(build.order.estimatedTotalFeeMicroUsd, 0n);
  assert.equal(build.order.positionPubkey, "swap-v2:BISON-round-UP:forecast-mint");
});

test("preserves Jupiter router and error code when an order cannot be built", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({
      transaction: "",
      requestId: "request-1",
      inAmount: "5000000",
      outAmount: "9000000",
      router: "jupiterz",
      errorCode: 3,
      errorMessage: "Quote could not be built into a transaction",
    }),
  });
  const client = new JupiterSwapClient({
    baseUrl: "https://example.test/swap/v2",
    http,
    minimumRequestIntervalMs: 0,
  });

  await assert.rejects(
    client.createOrder({
      inputMint: "usdc",
      outputMint: "forecast-mint",
      amount: 5_000_000n,
      taker: "owner-1",
      slippageBps: 100,
    }),
    (error: unknown) => error instanceof JupiterSwapOrderBuildError &&
      error.router === "jupiterz" && error.errorCode === 3,
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
