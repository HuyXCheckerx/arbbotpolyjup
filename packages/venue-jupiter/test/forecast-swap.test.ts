import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

import { HttpClient } from "../../domain/src/http.ts";
import {
  JupiterSwapClient,
  JupiterForecastSwapExecutor,
  JupiterSwapOrderBuildError,
  forecastSwapBuild,
  type JupiterSwapOrder,
} from "../src/forecast-swap.ts";
import { JupiterClient } from "../src/client.ts";

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
        otherAmountThreshold: "11880000",
        slippageBps: 37,
        priceImpact: "0.0012",
        feeBps: 2,
        signatureFeeLamports: "5000",
        prioritizationFeeLamports: "10000",
        rentFeeLamports: "0",
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
  });
  const execution = await client.execute({ signedTransaction: "signed-base64", requestId: order.requestId });

  const orderUrl = new URL(requests[0]?.url ?? "");
  assert.equal(orderUrl.pathname, "/swap/v2/order");
  assert.equal(orderUrl.searchParams.get("amount"), "750000");
  assert.equal(orderUrl.searchParams.get("slippageBps"), null);
  assert.deepEqual(requests[1]?.body, {
    signedTransaction: "signed-base64",
    requestId: "swap-request-1",
  });
  assert.equal(execution.totalInputAmount, 750_000n);
  assert.equal(execution.totalOutputAmount, 12_000_000n);
  assert.equal(order.otherAmountThreshold, 11_880_000n);
  assert.equal(order.slippageBps, 37);
  assert.equal(order.priceImpact, "0.0012");
});

test("adapts an all-in Swap V2 quote to the live trader build contract", () => {
  const order: JupiterSwapOrder = {
    transaction: "unsigned-base64",
    requestId: "request-1",
    inputMint: "usdc",
    outputMint: "forecast-mint",
    inAmount: 750_000n,
    outAmount: 12_000_000n,
    otherAmountThreshold: 11_880_000n,
    slippageBps: 100,
    priceImpact: "0.001",
    feeBps: 2,
    signatureFeeLamports: 5_000n,
    prioritizationFeeLamports: 10_000n,
    rentFeeLamports: 0n,
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
  assert.equal(build.execution.context.otherAmountThreshold, 11_880_000n);
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

test("ambiguous Swap execute transport failure resubmits the same signed request once", async () => {
  const bodies: unknown[] = [];
  let attempts = 0;
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (_request, init) => {
      attempts += 1;
      bodies.push(JSON.parse(String(init?.body)));
      if (attempts === 1) throw new TypeError("connection reset after submit");
      return jsonResponse({
        status: "Success",
        signature: "signature-after-retry",
        code: 0,
        totalInputAmount: "750000",
        totalOutputAmount: "12000000",
      });
    },
  });
  const swapClient = new JupiterSwapClient({
    baseUrl: "https://example.test/swap/v2",
    http,
    minimumRequestIntervalMs: 0,
  });
  const keypair = Keypair.generate();
  const executor = new JupiterForecastSwapExecutor({
    predictionClient: new JupiterClient({ baseUrl: "https://example.test/prediction/v1" }),
    swapClient,
    rpcUrl: "http://127.0.0.1:8899",
    privateKey: JSON.stringify([...keypair.secretKey]),
  });
  const build = forecastSwapBuild({
    order: {
      transaction: "unused",
      requestId: "request-idempotent",
      inputMint: "usdc",
      outputMint: "forecast-mint",
      inAmount: 750_000n,
      outAmount: 12_000_000n,
      otherAmountThreshold: 11_880_000n,
      slippageBps: 37,
      priceImpact: "0.001",
      feeBps: 2,
      signatureFeeLamports: 5_000n,
      prioritizationFeeLamports: 10_000n,
      rentFeeLamports: 0n,
      lastValidBlockHeight: 123,
      router: "iris",
      mode: "ultra",
    },
    marketId: "BISON-round-UP",
    outcomeMint: "forecast-mint",
    isBuy: true,
    ownerPubkey: keypair.publicKey.toBase58(),
  });
  const submitted = await executor.submitPreparedAndWait(
    { build, signedTransaction: "same-signed-transaction" },
    { timeoutMs: 5_000 },
  );

  assert.equal(submitted.transactionSignature, "signature-after-retry");
  assert.equal(attempts, 2);
  assert.deepEqual(bodies[0], bodies[1]);
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
