import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";

import { sleep } from "../../domain/src/http.ts";
import {
  JupiterClient,
  type JupiterPredictionClaimBuild,
  type JupiterPredictionOrderBuild,
  type JupiterPredictionOrderStatus,
  type JupiterPredictionPosition,
} from "./client.ts";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface SubmittedJupiterOrder {
  transactionSignature: string;
  submissionStartedAtMs: number;
  status: JupiterPredictionOrderStatus;
}

export interface PreparedJupiterSubmission {
  build: JupiterPredictionOrderBuild;
  signedTransaction: string;
}

export class JupiterPredictionExecutionError extends Error {
  readonly code = "PREDICTION_EXECUTION_FAILED";
  readonly status: string;
  readonly requestId: string;
  readonly transactionSignature: string | null;
  readonly url: string;

  constructor(input: {
    status: string;
    requestId: string;
    transactionSignature: string | null;
    url: string;
    message: string;
  }) {
    super(input.message);
    this.name = "JupiterPredictionExecutionError";
    this.status = input.status;
    this.requestId = input.requestId;
    this.transactionSignature = input.transactionSignature;
    this.url = input.url;
  }
}

export class JupiterLiveExecutor {
  readonly #client: JupiterClient;
  readonly #connection: Connection;
  readonly #keypair: Keypair;
  readonly #commitment: Commitment;

  constructor(input: {
    client: JupiterClient;
    rpcUrl: string;
    privateKey: string;
    commitment?: Commitment;
  }) {
    this.#client = input.client;
    this.#commitment = input.commitment ?? "confirmed";
    this.#connection = new Connection(input.rpcUrl, this.#commitment);
    this.#keypair = parseSolanaKeypair(input.privateKey);
  }

  get ownerPubkey(): string {
    return this.#keypair.publicKey.toBase58();
  }

  async assertReady(minimumUsdcMicro: bigint): Promise<{ solLamports: bigint; usdcMicro: bigint }> {
    if (!await this.#client.getTradingStatus()) throw new Error("Jupiter prediction trading is not active");
    const balances = await this.fetchWalletBalances();
    if (balances.solLamports < 1_000_000n) {
      throw new Error("Jupiter wallet needs at least 0.001 SOL for transaction fees and account rent");
    }
    if (balances.usdcMicro < minimumUsdcMicro) {
      throw new Error(`Jupiter wallet USDC balance ${balances.usdcMicro} is below required ${minimumUsdcMicro} micro-USDC`);
    }
    return balances;
  }

  async fetchWalletBalances(): Promise<{ solLamports: bigint; usdcMicro: bigint }> {
    const solLamports = BigInt(await this.#connection.getBalance(this.#keypair.publicKey, this.#commitment));
    const tokenAccounts = await this.#connection.getParsedTokenAccountsByOwner(
      this.#keypair.publicKey,
      { mint: new PublicKey(USDC_MINT) },
      this.#commitment,
    );
    const usdcMicro = tokenAccounts.value.reduce((total, account) => {
      const parsed = account.account.data.parsed as { info?: { tokenAmount?: { amount?: string } } };
      const amount = parsed.info?.tokenAmount?.amount;
      return total + (amount && /^\d+$/.test(amount) ? BigInt(amount) : 0n);
    }, 0n);
    return { solLamports, usdcMicro };
  }

  async prepareBuy(input: {
    marketId: string;
    depositAmountMicroUsd: bigint;
    outcomeMint?: string;
    isYes?: boolean;
  }): Promise<JupiterPredictionOrderBuild> {
    const build = await this.#client.createPredictionBuyOrder({
      ownerPubkey: this.ownerPubkey,
      marketId: input.marketId,
      isYes: input.isYes ?? true,
      depositAmountMicroUsd: input.depositAmountMicroUsd,
      depositMint: USDC_MINT,
    });
    if (!build.order.isBuy || build.order.isYes !== (input.isYes ?? true) || build.order.marketId !== input.marketId) {
      throw new Error("Jupiter returned a buy order for an unexpected market or side");
    }
    return build;
  }

  async prepareClose(positionPubkey: string): Promise<JupiterPredictionOrderBuild> {
    const build = await this.#client.createPredictionCloseOrder({
      ownerPubkey: this.ownerPubkey,
      positionPubkey,
    });
    if (build.order.isBuy || build.order.positionPubkey !== positionPubkey) {
      throw new Error("Jupiter returned an unexpected close-position order");
    }
    return build;
  }

  async prepareSell(positionPubkey: string, contractsMicro: bigint): Promise<JupiterPredictionOrderBuild> {
    const position = await this.getPosition(positionPubkey);
    if (position.contractsMicro !== contractsMicro) {
      throw new Error("Jupiter Prediction API does not support partial position closes");
    }
    return await this.prepareClose(positionPubkey);
  }

  async prepareSubmission(build: JupiterPredictionOrderBuild): Promise<PreparedJupiterSubmission> {
    validateRequiredSigners(build, this.ownerPubkey);
    const transaction = VersionedTransaction.deserialize(Buffer.from(build.transaction, "base64"));
    transaction.sign([this.#keypair]);
    // Forecast Prediction orders are already complete atomic swaps assembled
    // by Jupiter and landed through /execute. The website does not add a
    // separate client RPC simulation, and doing so adds latency between the
    // cross-venue legs. Retain simulation for keeper-style prediction orders.
    if (build.executionModel !== "atomic_swap") {
      const simulation = await this.#connection.simulateTransaction(transaction, {
        commitment: this.#commitment,
        sigVerify: true,
      });
      if (simulation.value.err) {
        throw new Error(`Jupiter transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }
    }
    if (build.execution.endpoint && !build.execution.endpoint.endsWith("/execute")) {
      throw new Error(`Jupiter returned unsupported execution endpoint ${build.execution.endpoint}`);
    }
    return {
      build,
      signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    };
  }

  async submitPreparedAndWait(
    prepared: PreparedJupiterSubmission,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<SubmittedJupiterOrder> {
    const { build } = prepared;
    const submissionStartedAtMs = Date.now();
    const requestId = predictionExecutionRequestId(build);
    const execution = await this.#client.executePredictionOrder({
      signedTransaction: prepared.signedTransaction,
      context: build.execution.context,
      requestId,
    });
    if (execution.status !== "Success" || !execution.signature) {
      throw new JupiterPredictionExecutionError({
        status: execution.status,
        requestId,
        transactionSignature: execution.signature,
        url: build.execution.endpoint,
        message: `Jupiter Prediction execution failed for request ${requestId}: ` +
          `${execution.error ?? "missing transaction signature"}`,
      });
    }
    const transactionSignature = execution.signature;
    let status: JupiterPredictionOrderStatus;
    if (build.executionModel === "atomic_swap") {
      // /execute is the managed landing path and Forecast positions are
      // available as soon as it returns. Avoid a redundant RPC confirmation
      // on the latency-sensitive hedge path.
      status = atomicExecutionStatus(build);
    } else {
      const confirmation = await this.#connection.confirmTransaction({
        signature: transactionSignature,
        blockhash: build.txMeta.blockhash,
        lastValidBlockHeight: build.txMeta.lastValidBlockHeight,
      }, this.#commitment);
      if (confirmation.value.err) {
        throw new Error(`Jupiter transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      if (!build.order.orderPubkey) throw new Error("Jupiter keeper order has no orderPubkey to poll");
      status = await this.waitForOrder(build.order.orderPubkey, options);
    }
    return { transactionSignature, submissionStartedAtMs, status };
  }

  async submitAndWait(
    build: JupiterPredictionOrderBuild,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<SubmittedJupiterOrder> {
    return await this.submitPreparedAndWait(await this.prepareSubmission(build), options);
  }

  async waitForOrder(
    orderPubkey: string,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<JupiterPredictionOrderStatus> {
    const deadline = Date.now() + options.timeoutMs;
    let latest = await this.#client.getPredictionOrder(orderPubkey);
    while (latest.status === "pending" && Date.now() < deadline) {
      await sleep(options.pollMs ?? 750);
      latest = await this.#client.getPredictionOrder(orderPubkey);
    }
    return latest;
  }

  async getPosition(positionPubkey: string): Promise<JupiterPredictionPosition> {
    return await this.#client.getPredictionPosition(positionPubkey);
  }

  async claimPosition(
    positionPubkey: string,
    _expectedPayoutMicroUsd?: bigint,
  ): Promise<{ transactionSignature: string; payoutMicroUsd: bigint }> {
    const position = await this.#client.getPredictionPosition(positionPubkey);
    if (position.claimed) {
      return { transactionSignature: "already-claimed", payoutMicroUsd: position.claimedMicroUsd };
    }
    if (!position.claimable) throw new Error(`Jupiter position ${positionPubkey} is not claimable yet`);
    const build = await this.#client.createPredictionClaim({
      ownerPubkey: this.ownerPubkey,
      positionPubkey,
    });
    if (build.positionPubkey !== positionPubkey) throw new Error("Jupiter claim build targets an unexpected position");
    const transactionSignature = await this.#submitClaim(build);
    return { transactionSignature, payoutMicroUsd: build.payoutMicroUsd };
  }

  async #submitClaim(build: JupiterPredictionClaimBuild): Promise<string> {
    const transaction = VersionedTransaction.deserialize(Buffer.from(build.transaction, "base64"));
    transaction.sign([this.#keypair]);
    const simulation = await this.#connection.simulateTransaction(transaction, {
      commitment: this.#commitment,
      sigVerify: true,
    });
    if (simulation.value.err) {
      throw new Error(`Jupiter claim simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    const signature = await this.#connection.sendRawTransaction(transaction.serialize(), {
      maxRetries: 3,
      preflightCommitment: this.#commitment,
      skipPreflight: false,
    });
    const confirmation = await this.#connection.confirmTransaction({
      signature,
      blockhash: build.blockhash,
      lastValidBlockHeight: build.lastValidBlockHeight,
    }, this.#commitment);
    if (confirmation.value.err) {
      throw new Error(`Jupiter claim transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return signature;
  }
}

function atomicExecutionStatus(build: JupiterPredictionOrderBuild): JupiterPredictionOrderStatus {
  const filledContractsMicro = build.order.contractsMicro > 0n
    ? build.order.contractsMicro
    : build.order.newContractsMicro;
  const grossMicroUsd = build.order.isBuy ? build.order.orderCostMicroUsd : build.order.payoutMicroUsd;
  const averageFillPriceMicroUsd = build.order.isBuy && build.order.newAveragePriceMicroUsd !== null
    ? build.order.newAveragePriceMicroUsd
    : filledContractsMicro > 0n ? grossMicroUsd * 1_000_000n / filledContractsMicro : 0n;
  return {
    orderPubkey: build.order.orderPubkey,
    positionPubkey: build.order.positionPubkey,
    marketId: build.order.marketId,
    status: filledContractsMicro > 0n ? "filled" : "failed",
    isBuy: build.order.isBuy,
    isYes: build.order.isYes,
    contractsMicro: filledContractsMicro,
    filledContractsMicro,
    averageFillPriceMicroUsd,
    sizeMicroUsd: grossMicroUsd,
    settled: true,
  };
}

export function predictionExecutionRequestId(build: JupiterPredictionOrderBuild): string {
  const requestId = build.externalOrderId || build.jupiterSwapRequestId || build.order.orderPubkey;
  if (!requestId) throw new Error("Jupiter order build has no execution request ID");
  return requestId;
}

export function parseSolanaKeypair(value: string): Keypair {
  const trimmed = value.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      throw new Error("JUPITER_SOLANA_PRIVATE_KEY JSON must be a byte array");
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    bytes = bs58.decode(trimmed);
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`JUPITER_SOLANA_PRIVATE_KEY must decode to 32 or 64 bytes, received ${bytes.length}`);
}

function validateRequiredSigners(build: JupiterPredictionOrderBuild, ownerPubkey: string): void {
  if (!build.requiredSigners.includes(ownerPubkey)) {
    throw new Error("Jupiter transaction does not require the configured owner signature");
  }
  const unsupported = build.requiredSigners.filter((signer) => signer !== ownerPubkey);
  if (unsupported.length > 0) {
    throw new Error(`Jupiter transaction requires unsupported additional signers: ${unsupported.join(", ")}`);
  }
  if (!build.txMeta.blockhash || build.txMeta.lastValidBlockHeight <= 0) {
    throw new Error("Jupiter transaction has invalid blockhash metadata");
  }
}
