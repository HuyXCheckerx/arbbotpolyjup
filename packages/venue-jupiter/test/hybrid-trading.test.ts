import assert from "node:assert/strict";
import test from "node:test";

import type {
  JupiterPredictionOrderBuild,
  JupiterPredictionOrderStatus,
  JupiterPredictionPosition,
} from "../src/client.ts";
import {
  JUPITER_PREDICTION_MINIMUM_BUY_MICRO_USD,
  JupiterHybridLiveExecutor,
  jupiterExecutionPath,
} from "../src/hybrid-trading.ts";
import type { PreparedJupiterSubmission, SubmittedJupiterOrder } from "../src/trading.ts";

test("hybrid executor uses Prediction at $5+ and Swap V2 only for smaller Forecast buys", async () => {
  const calls: string[] = [];
  const forecast = gateway("forecast", "/swap/v2/execute", "swap-v2:BISON-UP:mint", calls);
  const prediction = gateway("prediction", "/prediction/v1/execute", "prediction-position", calls);
  const hybrid = new JupiterHybridLiveExecutor({ forecast, prediction });

  const small = await hybrid.prepareBuy({
    marketId: "BISON-UP",
    outcomeMint: "mint",
    isYes: true,
    depositAmountMicroUsd: JUPITER_PREDICTION_MINIMUM_BUY_MICRO_USD - 1n,
  });
  const minimum = await hybrid.prepareBuy({
    marketId: "BISON-UP",
    outcomeMint: "mint",
    isYes: true,
    depositAmountMicroUsd: JUPITER_PREDICTION_MINIMUM_BUY_MICRO_USD,
  });
  const standard = await hybrid.prepareBuy({
    marketId: "POLY-market",
    isYes: false,
    depositAmountMicroUsd: 1_000_000n,
  });

  assert.deepEqual(calls, ["forecast:prepare-buy", "prediction:prepare-buy", "prediction:prepare-buy"]);
  assert.equal(jupiterExecutionPath(small), "swap_v2");
  assert.equal(jupiterExecutionPath(minimum), "prediction_api");
  assert.equal(jupiterExecutionPath(standard), "prediction_api");
});

test("hybrid executor dispatches signing and submission from the build endpoint", async () => {
  const calls: string[] = [];
  const forecast = gateway("forecast", "/swap/v2/execute", "swap-v2:BISON-UP:mint", calls);
  const prediction = gateway("prediction", "/prediction/v1/execute", "prediction-position", calls);
  const hybrid = new JupiterHybridLiveExecutor({ forecast, prediction });
  const swapBuild = build("/swap/v2/execute", "swap-v2:BISON-UP:mint");
  const predictionBuild = build("/prediction/v1/execute", "prediction-position");

  const preparedSwap = await hybrid.prepareSubmission(swapBuild);
  await hybrid.submitPreparedAndWait(preparedSwap, { timeoutMs: 5_000 });
  const preparedPrediction = await hybrid.prepareSubmission(predictionBuild);
  await hybrid.submitPreparedAndWait(preparedPrediction, { timeoutMs: 5_000 });

  assert.deepEqual(calls, [
    "forecast:prepare-submission",
    "forecast:submit",
    "prediction:prepare-submission",
    "prediction:submit",
  ]);
});

interface MockGateway {
  ownerPubkey: string;
  prepareBuy(input: {
    marketId: string;
    depositAmountMicroUsd: bigint;
    outcomeMint?: string;
    isYes?: boolean;
  }): Promise<JupiterPredictionOrderBuild>;
  prepareSell(positionPubkey: string, contractsMicro: bigint): Promise<JupiterPredictionOrderBuild>;
  prepareClose(positionPubkey: string): Promise<JupiterPredictionOrderBuild>;
  prepareSubmission(value: JupiterPredictionOrderBuild): Promise<PreparedJupiterSubmission>;
  submitPreparedAndWait(
    value: PreparedJupiterSubmission,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<SubmittedJupiterOrder>;
  waitForOrder(
    orderPubkey: string,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<JupiterPredictionOrderStatus>;
  getPosition(positionPubkey: string): Promise<JupiterPredictionPosition>;
  claimPosition(
    positionPubkey: string,
    expectedPayoutMicroUsd?: bigint,
  ): Promise<{ transactionSignature: string; payoutMicroUsd: bigint }>;
}

function gateway(
  label: string,
  endpoint: string,
  positionPubkey: string,
  calls: string[],
): MockGateway {
  return {
    ownerPubkey: "owner",
    prepareBuy: async () => {
      calls.push(`${label}:prepare-buy`);
      return build(endpoint, positionPubkey);
    },
    prepareSell: async () => build(endpoint, positionPubkey),
    prepareClose: async () => build(endpoint, positionPubkey),
    prepareSubmission: async (value) => {
      calls.push(`${label}:prepare-submission`);
      return { build: value, signedTransaction: "signed" };
    },
    submitPreparedAndWait: async (value) => {
      calls.push(`${label}:submit`);
      return {
        transactionSignature: `${label}-signature`,
        submissionStartedAtMs: 1,
        status: status(value.build),
      };
    },
    waitForOrder: async () => status(build(endpoint, positionPubkey)),
    getPosition: async (value) => ({
      positionPubkey: value,
      marketId: "BISON-UP",
      isYes: true,
      contractsMicro: 1_000_000n,
      totalCostMicroUsd: 500_000n,
      feesPaidMicroUsd: 0n,
      sellPriceMicroUsd: 500_000n,
      claimable: false,
      claimed: false,
      claimedMicroUsd: 0n,
      result: null,
    }),
    claimPosition: async (_value, expected = 0n) => ({
      transactionSignature: `${label}-claim`,
      payoutMicroUsd: expected,
    }),
  };
}

function build(endpoint: string, positionPubkey: string): JupiterPredictionOrderBuild {
  return {
    transaction: "transaction",
    txMeta: { blockhash: "blockhash", lastValidBlockHeight: 1 },
    externalOrderId: "request",
    jupiterSwapRequestId: "request",
    requiredSigners: ["owner"],
    execution: { endpoint, context: { requestId: "request" } },
    executionModel: "atomic_swap",
    settlement: "auto",
    order: {
      orderPubkey: null,
      positionPubkey,
      marketId: "BISON-UP",
      isBuy: true,
      isYes: true,
      contractsMicro: 10_000_000n,
      newContractsMicro: 10_000_000n,
      maxBuyPriceMicroUsd: 500_000n,
      minSellPriceMicroUsd: null,
      orderCostMicroUsd: 5_000_000n,
      newAveragePriceMicroUsd: 500_000n,
      newSizeMicroUsd: 5_000_000n,
      payoutMicroUsd: 10_000_000n,
      estimatedTotalFeeMicroUsd: 0n,
    },
  };
}

function status(value: JupiterPredictionOrderBuild): JupiterPredictionOrderStatus {
  return {
    orderPubkey: value.order.orderPubkey,
    positionPubkey: value.order.positionPubkey,
    marketId: value.order.marketId,
    status: "filled",
    isBuy: true,
    isYes: true,
    contractsMicro: value.order.contractsMicro,
    filledContractsMicro: value.order.contractsMicro,
    averageFillPriceMicroUsd: 500_000n,
    sizeMicroUsd: value.order.orderCostMicroUsd,
    settled: true,
  };
}
