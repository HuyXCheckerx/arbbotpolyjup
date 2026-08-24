import assert from "node:assert/strict";
import test from "node:test";

import type { JupiterPredictionOrderBuild } from "../src/client.ts";
import { USDC_MINT, reconcileAtomicExecutionStatus } from "../src/trading.ts";

const OWNER = "G3yfNkUaTvr1QvAPThRuNL9H5oogVDrzSVopCsY1f1he";
const OUTCOME_MINT = "ForecastOutcomeMint1111111111111111111111111";

test("atomic Prediction fills use confirmed token deltas instead of quoted contracts", () => {
  const build = atomicBuild();
  const status = reconcileAtomicExecutionStatus({
    build,
    ownerPubkey: OWNER,
    outcomeMint: OUTCOME_MINT,
    preTokenBalances: [
      tokenBalance(1, USDC_MINT, OWNER, 100_000_000n),
      tokenBalance(2, OUTCOME_MINT, OWNER, 0n),
      tokenBalance(3, OUTCOME_MINT, "another-owner", 9_000_000n),
    ],
    postTokenBalances: [
      tokenBalance(1, USDC_MINT, OWNER, 86_741_123n),
      tokenBalance(2, OUTCOME_MINT, OWNER, 37_658_580n),
      tokenBalance(3, OUTCOME_MINT, "another-owner", 99_000_000n),
    ],
  });

  assert.equal(build.order.newContractsMicro, 46_107_033n);
  assert.equal(status.quotedContractsMicro, 46_107_033n);
  assert.equal(status.filledContractsMicro, 37_658_580n);
  assert.equal(status.sizeMicroUsd, 13_258_877n);
  assert.equal(status.reconciliationSource, "onchain_token_deltas");
  assert.equal(status.averageFillPriceMicroUsd, 352_082n);
});

test("atomic Prediction reconciliation fails closed when no wallet fill exists", () => {
  const build = atomicBuild();
  assert.throws(() => reconcileAtomicExecutionStatus({
    build,
    ownerPubkey: OWNER,
    outcomeMint: OUTCOME_MINT,
    preTokenBalances: [tokenBalance(1, USDC_MINT, OWNER, 100_000_000n)],
    postTokenBalances: [tokenBalance(1, USDC_MINT, OWNER, 100_000_000n)],
  }), /invalid on-chain deltas/);
});

function tokenBalance(
  accountIndex: number,
  mint: string,
  owner: string,
  amount: bigint,
) {
  return {
    accountIndex,
    mint,
    owner,
    uiTokenAmount: { amount: amount.toString() },
  };
}

function atomicBuild(): JupiterPredictionOrderBuild {
  return {
    outcomeMint: OUTCOME_MINT,
    transaction: "transaction",
    txMeta: { blockhash: "blockhash", lastValidBlockHeight: 1 },
    externalOrderId: "external",
    jupiterSwapRequestId: "swap-request",
    requiredSigners: [OWNER],
    execution: { endpoint: "/execute", context: {} },
    executionModel: "atomic_swap",
    settlement: "auto",
    order: {
      orderPubkey: null,
      positionPubkey: "position",
      marketId: "BISON-market-UP",
      isBuy: true,
      isYes: true,
      contractsMicro: 46_107_033n,
      newContractsMicro: 46_107_033n,
      maxBuyPriceMicroUsd: 300_000n,
      minSellPriceMicroUsd: null,
      orderCostMicroUsd: 13_258_877n,
      newAveragePriceMicroUsd: 287_565n,
      newSizeMicroUsd: 13_258_877n,
      payoutMicroUsd: 46_107_033n,
      estimatedTotalFeeMicroUsd: 0n,
    },
  };
}
