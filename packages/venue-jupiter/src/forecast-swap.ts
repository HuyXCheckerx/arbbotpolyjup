import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
  type Finality,
} from "@solana/web3.js";

import { ONE_CONTRACT_MICRO, ONE_USD_MICRO } from "../../domain/src/fixed.ts";
import { HttpClient } from "../../domain/src/http.ts";
import { asNumber, asString, isRecord } from "../../domain/src/json.ts";
import {
  JupiterClient,
  type JupiterPredictionOrderBuild,
  type JupiterPredictionOrderStatus,
  type JupiterPredictionPosition,
} from "./client.ts";
import {
  USDC_MINT,
  parseSolanaKeypair,
  type PreparedJupiterSubmission,
  type SubmittedJupiterOrder,
} from "./trading.ts";
import type { JupiterRequestPriority, JupiterRequestScheduler } from "./request-scheduler.ts";

const DEFAULT_SWAP_URL = "https://api.jup.ag/swap/v2";
const AUTO_SETTLEMENT_TOLERANCE_MICRO = 10_000n;
const SWAP_POSITION_PREFIX = "swap-v2";
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const CLOSE_TOKEN_ACCOUNT_INSTRUCTION = 9;

export interface JupiterSwapOrder {
  transaction: string;
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  otherAmountThreshold: bigint | null;
  slippageBps: number | null;
  priceImpact: string | null;
  feeBps: number | null;
  signatureFeeLamports: bigint | null;
  prioritizationFeeLamports: bigint | null;
  rentFeeLamports: bigint | null;
  lastValidBlockHeight: number;
  router: string;
  mode: string;
}

export interface JupiterSwapExecution {
  status: "Success" | "Failed";
  signature: string | null;
  code: number;
  totalInputAmount: bigint;
  totalOutputAmount: bigint;
  error: string | null;
}

export class JupiterSwapOrderBuildError extends Error {
  readonly router: string;
  readonly errorCode: number | null;

  constructor(router: string, errorCode: number | null, message: string) {
    super(message);
    this.name = "JupiterSwapOrderBuildError";
    this.router = router;
    this.errorCode = errorCode;
  }
}

export class JupiterSwapExecutionError extends Error {
  readonly code: number;
  readonly router: string;
  readonly transactionSignature: string | null;

  constructor(code: number, router: string, transactionSignature: string | null, message: string) {
    super(message);
    this.name = "JupiterSwapExecutionError";
    this.code = code;
    this.router = router;
    this.transactionSignature = transactionSignature;
  }
}

export class JupiterSwapClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #http: HttpClient;
  readonly #minimumRequestIntervalMs: number;
  readonly #requestScheduler: JupiterRequestScheduler | undefined;
  readonly #requestPriority: JupiterRequestPriority;
  #lastRequestAtMs = 0;
  #requestQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    baseUrl?: string;
    apiKey?: string;
    http?: HttpClient;
    minimumRequestIntervalMs?: number;
    requestScheduler?: JupiterRequestScheduler;
    requestPriority?: JupiterRequestPriority;
  } = {}) {
    this.#baseUrl = trimSlash(options.baseUrl ?? process.env.JUPITER_SWAP_URL ?? DEFAULT_SWAP_URL);
    this.#apiKey = options.apiKey ?? process.env.JUPITER_API_KEY;
    this.#http = options.http ?? new HttpClient();
    this.#minimumRequestIntervalMs = options.minimumRequestIntervalMs ?? (this.#apiKey ? 1_000 : 2_100);
    this.#requestScheduler = options.requestScheduler;
    this.#requestPriority = options.requestPriority ?? "critical";
  }

  async createOrder(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    taker?: string;
    slippageBps?: number;
  }): Promise<JupiterSwapOrder> {
    if (input.amount <= 0n) throw new Error("Jupiter Swap amount must be positive");
    const url = new URL(`${this.#baseUrl}/order`);
    url.searchParams.set("inputMint", input.inputMint);
    url.searchParams.set("outputMint", input.outputMint);
    url.searchParams.set("amount", input.amount.toString());
    if (input.taker) url.searchParams.set("taker", input.taker);
    // Omitting slippageBps opts into Jupiter's recommended Ultra/RTSE order
    // construction. Supplying a fixed value forces manual-slippage mode and
    // has produced avoidable 6001 failures on fast Forecast pools.
    if (input.slippageBps !== undefined) {
      url.searchParams.set("slippageBps", String(input.slippageBps));
    }
    const payload = await this.#getJson(url);
    if (!isRecord(payload)) throw new Error("Jupiter Swap order response is not an object");
    const transaction = asString(payload.transaction);
    const requestId = asString(payload.requestId);
    const inAmount = parseUnsignedInteger(payload.inAmount, "inAmount");
    const outAmount = parseUnsignedInteger(payload.outAmount, "outAmount");
    if (!transaction) {
      const router = asString(payload.router, "unknown");
      const errorCode = asNumber(payload.errorCode);
      const errorMessage = asString(payload.errorMessage, "transaction was not built");
      throw new JupiterSwapOrderBuildError(
        router,
        errorCode,
        `Jupiter Swap ${router} order ${errorCode ?? "unknown"}: ${errorMessage}`,
      );
    }
    if (!requestId || inAmount <= 0n || outAmount <= 0n) {
      throw new Error("Jupiter Swap order is missing executable quote fields");
    }
    return {
      transaction,
      requestId,
      inputMint: asString(payload.inputMint, input.inputMint),
      outputMint: asString(payload.outputMint, input.outputMint),
      inAmount,
      outAmount,
      otherAmountThreshold: parseOptionalUnsignedInteger(
        payload.otherAmountThreshold,
        "otherAmountThreshold",
      ),
      slippageBps: asNumber(payload.slippageBps),
      priceImpact: optionalScalarString(payload.priceImpact),
      feeBps: asNumber(payload.feeBps),
      signatureFeeLamports: parseOptionalUnsignedInteger(
        payload.signatureFeeLamports,
        "signatureFeeLamports",
      ),
      prioritizationFeeLamports: parseOptionalUnsignedInteger(
        payload.prioritizationFeeLamports,
        "prioritizationFeeLamports",
      ),
      rentFeeLamports: parseOptionalUnsignedInteger(payload.rentFeeLamports, "rentFeeLamports"),
      lastValidBlockHeight: asNumber(payload.lastValidBlockHeight) ?? 0,
      router: asString(payload.router, "unknown"),
      mode: asString(payload.mode, "unknown"),
    };
  }

  async execute(input: { signedTransaction: string; requestId: string }): Promise<JupiterSwapExecution> {
    const payload = await this.#requestJson("POST", `${this.#baseUrl}/execute`, input);
    if (!isRecord(payload)) throw new Error("Jupiter Swap execution response is not an object");
    const status = asString(payload.status);
    if (status !== "Success" && status !== "Failed") {
      throw new Error(`Jupiter Swap execution returned unsupported status ${status || "missing"}`);
    }
    return {
      status,
      signature: asString(payload.signature) || null,
      code: asNumber(payload.code) ?? (status === "Success" ? 0 : -1),
      totalInputAmount: parseUnsignedInteger(payload.totalInputAmount, "totalInputAmount"),
      totalOutputAmount: parseUnsignedInteger(payload.totalOutputAmount, "totalOutputAmount"),
      error: asString(payload.error) || null,
    };
  }

  #headers(): Readonly<Record<string, string>> {
    return this.#apiKey ? { "x-api-key": this.#apiKey } : {};
  }

  async #getJson(url: URL | string): Promise<unknown> {
    return await this.#requestJson("GET", url);
  }

  async #requestJson(method: "GET" | "POST", url: URL | string, body?: unknown): Promise<unknown> {
    const requestUrl = typeof url === "string" ? new URL(url) : url;
    if (this.#requestScheduler && !requestUrl.pathname.endsWith("/execute")) {
      await this.#requestScheduler.wait(this.#requestPriority);
      if (method === "POST") return await this.#http.postJson(requestUrl, body, this.#headers());
      return await this.#http.getJson(requestUrl, this.#headers());
    }
    let release!: () => void;
    const previous = this.#requestQueue;
    this.#requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.#lastRequestAtMs + this.#minimumRequestIntervalMs - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.#lastRequestAtMs = Date.now();
      if (method === "POST") return await this.#http.postJson(url, body, this.#headers());
      return await this.#http.getJson(url, this.#headers());
    } finally {
      release();
    }
  }
}

/**
 * Executes native Forecast outcome tokens through Swap V2. The Prediction API
 * enforces a $5 build minimum; explicitly enabled sub-minimum execution can
 * trade the same Token-2022 mint through Swap V2 with Jupiter-managed RTSE.
 */
export class JupiterForecastSwapExecutor {
  readonly #predictionClient: JupiterClient;
  readonly #swapClient: JupiterSwapClient;
  readonly #connection: Connection;
  readonly #keypair: Keypair;
  readonly #commitment: Commitment;

  constructor(input: {
    predictionClient: JupiterClient;
    swapClient: JupiterSwapClient;
    rpcUrl: string;
    privateKey: string;
    /** @deprecated Swap V2 now uses Jupiter RTSE; retained for config compatibility. */
    slippageBps?: number;
    commitment?: Commitment;
  }) {
    this.#predictionClient = input.predictionClient;
    this.#swapClient = input.swapClient;
    this.#commitment = input.commitment ?? "confirmed";
    this.#connection = new Connection(input.rpcUrl, this.#commitment);
    this.#keypair = parseSolanaKeypair(input.privateKey);
  }

  get ownerPubkey(): string {
    return this.#keypair.publicKey.toBase58();
  }

  async assertReady(minimumUsdcMicro: bigint): Promise<{ solLamports: bigint; usdcMicro: bigint }> {
    if (!await this.#predictionClient.getTradingStatus()) throw new Error("Jupiter prediction trading is not active");
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
    const [solLamports, usdcMicro] = await Promise.all([
      this.#connection.getBalance(this.#keypair.publicKey, this.#commitment).then(BigInt),
      this.#tokenBalance(USDC_MINT),
    ]);
    return { solLamports, usdcMicro };
  }

  async prepareBuy(input: {
    marketId: string;
    depositAmountMicroUsd: bigint;
    outcomeMint?: string;
    isYes?: boolean;
  }): Promise<JupiterPredictionOrderBuild> {
    if (input.isYes === false) {
      throw new Error("Jupiter Forecast outcome markets must be bought through their YES-side outcome mint");
    }
    const outcomeMint = input.outcomeMint ?? await this.#outcomeMint(input.marketId);
    const order = await this.#swapClient.createOrder({
      inputMint: USDC_MINT,
      outputMint: outcomeMint,
      amount: input.depositAmountMicroUsd,
      taker: this.ownerPubkey,
    });
    return forecastSwapBuild({ order, marketId: input.marketId, outcomeMint, isBuy: true, ownerPubkey: this.ownerPubkey });
  }

  async prepareClose(positionPubkey: string): Promise<JupiterPredictionOrderBuild> {
    const position = parseSwapPositionId(positionPubkey);
    const contractsMicro = await this.#tokenBalance(position.outcomeMint);
    if (contractsMicro <= 0n) throw new Error(`Forecast outcome token ${position.outcomeMint} has no wallet balance`);
    return await this.prepareSell(positionPubkey, contractsMicro);
  }

  async prepareSell(positionPubkey: string, contractsMicro: bigint): Promise<JupiterPredictionOrderBuild> {
    const position = parseSwapPositionId(positionPubkey);
    if (contractsMicro <= 0n) throw new Error("Forecast outcome-token sell amount must be positive");
    const order = await this.#swapClient.createOrder({
      inputMint: position.outcomeMint,
      outputMint: USDC_MINT,
      amount: contractsMicro,
      taker: this.ownerPubkey,
    });
    return forecastSwapBuild({
      order,
      marketId: position.marketId,
      outcomeMint: position.outcomeMint,
      isBuy: false,
      ownerPubkey: this.ownerPubkey,
    });
  }

  async prepareSubmission(build: JupiterPredictionOrderBuild): Promise<PreparedJupiterSubmission> {
    if (build.execution.endpoint !== "/swap/v2/execute") {
      throw new Error(`Jupiter Forecast Swap build has unsupported endpoint ${build.execution.endpoint}`);
    }
    const transaction = VersionedTransaction.deserialize(Buffer.from(build.transaction, "base64"));
    const requiredKeys = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
    if (!requiredKeys.some((key) => key.equals(this.#keypair.publicKey))) {
      throw new Error("Jupiter Forecast Swap transaction does not require the configured owner signature");
    }
    transaction.sign([this.#keypair]);
    return { build, signedTransaction: Buffer.from(transaction.serialize()).toString("base64") };
  }

  async submitPreparedAndWait(
    prepared: PreparedJupiterSubmission,
    _options: { timeoutMs: number; pollMs?: number },
  ): Promise<SubmittedJupiterOrder> {
    const submissionStartedAtMs = Date.now();
    const requestId = asString(prepared.build.execution.context.requestId);
    if (!requestId) throw new Error("Jupiter Forecast Swap build has no requestId");
    const deadlineMs = submissionStartedAtMs + Math.max(0, _options.timeoutMs);
    let execution: JupiterSwapExecution | null = null;
    let lastTransportError: unknown = null;
    // /execute is idempotent for the same requestId + signed transaction. One
    // resubmission resolves an ambiguous dropped HTTP response without building
    // or signing a different transaction that could double-fill.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        execution = await this.#swapClient.execute({
          signedTransaction: prepared.signedTransaction,
          requestId,
        });
        break;
      } catch (error) {
        lastTransportError = error;
        if (attempt > 0 || Date.now() + 100 >= deadlineMs) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!execution) throw lastTransportError ?? new Error("Jupiter Swap execution returned no result");
    if (execution.status !== "Success" || !execution.signature || execution.code !== 0) {
      throw new JupiterSwapExecutionError(
        execution.code,
        asString(prepared.build.execution.context.router, "unknown"),
        execution.signature,
        `Jupiter Forecast Swap execution failed (${execution.code}): ${execution.error ?? "missing signature"}`,
      );
    }
    return {
      transactionSignature: execution.signature,
      submissionStartedAtMs,
      status: swapExecutionStatus(prepared.build, execution),
    };
  }

  async waitForOrder(): Promise<JupiterPredictionOrderStatus> {
    throw new Error("Forecast Swap V2 executions are atomic and have no keeper order to poll");
  }

  async getPosition(positionPubkey: string): Promise<JupiterPredictionPosition> {
    const position = parseSwapPositionId(positionPubkey);
    return {
      positionPubkey,
      marketId: position.marketId,
      isYes: true,
      contractsMicro: await this.#tokenBalance(position.outcomeMint),
      totalCostMicroUsd: 0n,
      feesPaidMicroUsd: 0n,
      sellPriceMicroUsd: null,
      claimable: false,
      claimed: false,
      claimedMicroUsd: 0n,
      result: null,
    };
  }

  async claimPosition(
    positionPubkey: string,
    expectedPayoutMicroUsd = 0n,
  ): Promise<{ transactionSignature: string; payoutMicroUsd: bigint }> {
    const position = parseSwapPositionId(positionPubkey);
    const accounts = await this.#tokenAccounts(position.outcomeMint);
    const remaining = accounts.reduce((total, account) => total + account.amount, 0n);
    if (remaining > AUTO_SETTLEMENT_TOLERANCE_MICRO) {
      throw new Error(`Forecast winning token ${position.outcomeMint} has not auto-settled yet`);
    }
    const settlement = await this.#findAutoSettlement(
      accounts.map((account) => account.pubkey),
      position.outcomeMint,
      expectedPayoutMicroUsd,
    );
    if (!settlement) {
      throw new Error(
        `Forecast winning token ${position.outcomeMint} is empty, but no confirmed USDC ` +
        `settlement credit was found on-chain`,
      );
    }
    return settlement;
  }

  async reclaimPositionRent(
    positionPubkey: string,
  ): Promise<{ transactionSignatures: string[]; reclaimedLamports: bigint }> {
    const position = parseSwapPositionId(positionPubkey);
    const accounts = await this.#tokenAccounts(position.outcomeMint);
    const nonEmpty = accounts.filter((account) => account.amount > 0n);
    if (nonEmpty.length > 0) {
      throw new Error(
        `Forecast token account ${position.outcomeMint} still contains ` +
        `${nonEmpty.reduce((total, account) => total + account.amount, 0n)} raw tokens`,
      );
    }
    const closable = accounts.filter((account) => account.programId === TOKEN_2022_PROGRAM_ID.toBase58());
    const transactionSignatures: string[] = [];
    let reclaimedLamports = 0n;
    for (const account of closable) {
      const lamports = BigInt(await this.#connection.getBalance(account.pubkey, this.#commitment));
      const latest = await this.#connection.getLatestBlockhash(this.#commitment);
      const instruction = new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
          { pubkey: account.pubkey, isSigner: false, isWritable: true },
          { pubkey: this.#keypair.publicKey, isSigner: false, isWritable: true },
          { pubkey: this.#keypair.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([CLOSE_TOKEN_ACCOUNT_INSTRUCTION]),
      });
      const transaction = new VersionedTransaction(new TransactionMessage({
        payerKey: this.#keypair.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [instruction],
      }).compileToV0Message());
      transaction.sign([this.#keypair]);
      const signature = await this.#connection.sendRawTransaction(transaction.serialize(), {
        maxRetries: 3,
        preflightCommitment: this.#commitment,
        skipPreflight: false,
      });
      const confirmation = await this.#connection.confirmTransaction({
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }, this.#commitment);
      if (confirmation.value.err) {
        throw new Error(
          `Forecast token-account close failed: ${JSON.stringify(confirmation.value.err)}`,
        );
      }
      transactionSignatures.push(signature);
      reclaimedLamports += lamports;
    }
    return { transactionSignatures, reclaimedLamports };
  }

  async #outcomeMint(marketId: string): Promise<string> {
    const market = await this.#predictionClient.getMarket(marketId);
    if (market.provider !== "bisonfi" || !market.outcomeMint) {
      throw new Error(`Jupiter Forecast market ${marketId} has no outcomeMint`);
    }
    return market.outcomeMint;
  }

  async #tokenBalance(mint: string): Promise<bigint> {
    const tokenAccounts = await this.#tokenAccounts(mint);
    return tokenAccounts.reduce((total, account) => total + account.amount, 0n);
  }

  async #tokenAccounts(mint: string): Promise<Array<{
    pubkey: PublicKey;
    amount: bigint;
    programId: string;
  }>> {
    const tokenAccounts = await this.#connection.getParsedTokenAccountsByOwner(
      this.#keypair.publicKey,
      { mint: new PublicKey(mint) },
      this.#commitment,
    );
    return tokenAccounts.value.map((account) => {
      const parsed = account.account.data.parsed as {
        info?: { owner?: string; tokenAmount?: { amount?: string } };
      };
      if (parsed.info?.owner !== this.ownerPubkey) {
        throw new Error(`Forecast token account ${account.pubkey.toBase58()} has an unexpected owner`);
      }
      const amount = parsed.info?.tokenAmount?.amount;
      return {
        pubkey: account.pubkey,
        amount: amount && /^\d+$/.test(amount) ? BigInt(amount) : 0n,
        programId: account.account.owner.toBase58(),
      };
    });
  }

  async #findAutoSettlement(
    tokenAccounts: readonly PublicKey[],
    outcomeMint: string,
    expectedPayoutMicroUsd: bigint,
  ): Promise<{ transactionSignature: string; payoutMicroUsd: bigint } | null> {
    const signatures = new Map<string, number>();
    for (const tokenAccount of tokenAccounts) {
      for (const record of await this.#connection.getSignaturesForAddress(
        tokenAccount,
        { limit: 25 },
        transactionReadFinality(this.#commitment),
      )) {
        if (record.err === null) signatures.set(record.signature, record.slot);
      }
    }
    const tolerance = maximum(AUTO_SETTLEMENT_TOLERANCE_MICRO, expectedPayoutMicroUsd / 1_000n);
    for (const [signature] of [...signatures.entries()].sort((left, right) => right[1] - left[1])) {
      const transaction = await this.#connection.getTransaction(signature, {
        commitment: transactionReadFinality(this.#commitment),
        maxSupportedTransactionVersion: 0,
      });
      if (!transaction?.meta || transaction.meta.err) continue;
      const outcomeDebit = -tokenDeltaForOwner(
        transaction.meta.preTokenBalances ?? [],
        transaction.meta.postTokenBalances ?? [],
        this.ownerPubkey,
        outcomeMint,
      );
      const usdcDelta = tokenDeltaForOwner(
        transaction.meta.preTokenBalances ?? [],
        transaction.meta.postTokenBalances ?? [],
        this.ownerPubkey,
        USDC_MINT,
      );
      const payoutMismatch = absolute(outcomeDebit - usdcDelta);
      if (outcomeDebit >= maximum(0n, expectedPayoutMicroUsd - tolerance) &&
        usdcDelta > 0n && payoutMismatch <= tolerance) {
        return { transactionSignature: signature, payoutMicroUsd: usdcDelta };
      }
    }
    return null;
  }
}

export function forecastSwapBuild(input: {
  order: JupiterSwapOrder;
  marketId: string;
  outcomeMint: string;
  isBuy: boolean;
  ownerPubkey: string;
}): JupiterPredictionOrderBuild {
  const quantityMicro = input.isBuy ? input.order.outAmount : input.order.inAmount;
  const grossMicroUsd = input.isBuy ? input.order.inAmount : input.order.outAmount;
  const averagePriceMicroUsd = quantityMicro > 0n
    ? (input.isBuy
      ? ceilDivide(grossMicroUsd * ONE_CONTRACT_MICRO, quantityMicro)
      : grossMicroUsd * ONE_CONTRACT_MICRO / quantityMicro)
    : 0n;
  if (averagePriceMicroUsd <= 0n || averagePriceMicroUsd >= ONE_USD_MICRO) {
    throw new Error(`Jupiter Forecast Swap returned invalid average price ${averagePriceMicroUsd}`);
  }
  const positionPubkey = forecastSwapPositionId(input.marketId, input.outcomeMint);
  return {
    outcomeMint: input.outcomeMint,
    transaction: input.order.transaction,
    txMeta: { blockhash: "managed-by-swap-v2", lastValidBlockHeight: input.order.lastValidBlockHeight },
    externalOrderId: input.order.requestId,
    jupiterSwapRequestId: input.order.requestId,
    requiredSigners: [input.ownerPubkey],
    execution: {
      endpoint: "/swap/v2/execute",
      context: {
        requestId: input.order.requestId,
        router: input.order.router,
        mode: input.order.mode,
        otherAmountThreshold: input.order.otherAmountThreshold,
        rtseSlippageBps: input.order.slippageBps,
        priceImpact: input.order.priceImpact,
        feeBps: input.order.feeBps,
        signatureFeeLamports: input.order.signatureFeeLamports,
        prioritizationFeeLamports: input.order.prioritizationFeeLamports,
        rentFeeLamports: input.order.rentFeeLamports,
        inputMint: input.order.inputMint,
        outputMint: input.order.outputMint,
      },
    },
    executionModel: "atomic_swap",
    settlement: "auto",
    order: {
      orderPubkey: null,
      positionPubkey,
      marketId: input.marketId,
      isBuy: input.isBuy,
      isYes: true,
      contractsMicro: quantityMicro,
      newContractsMicro: input.isBuy ? quantityMicro : 0n,
      maxBuyPriceMicroUsd: input.isBuy ? averagePriceMicroUsd : null,
      minSellPriceMicroUsd: input.isBuy ? null : averagePriceMicroUsd,
      orderCostMicroUsd: input.isBuy ? grossMicroUsd : 0n,
      newAveragePriceMicroUsd: input.isBuy ? averagePriceMicroUsd : null,
      newSizeMicroUsd: input.isBuy ? grossMicroUsd : 0n,
      payoutMicroUsd: input.isBuy ? quantityMicro : grossMicroUsd,
      // Swap V2's quoted input/output amounts are already net of its fee.
      estimatedTotalFeeMicroUsd: 0n,
    },
  };
}

function parseOptionalUnsignedInteger(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  return parseUnsignedInteger(value, field);
}

function optionalScalarString(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function swapExecutionStatus(
  build: JupiterPredictionOrderBuild,
  execution: JupiterSwapExecution,
): JupiterPredictionOrderStatus {
  const filledContractsMicro = build.order.isBuy
    ? execution.totalOutputAmount
    : execution.totalInputAmount;
  const sizeMicroUsd = build.order.isBuy
    ? execution.totalInputAmount
    : execution.totalOutputAmount;
  const averageFillPriceMicroUsd = filledContractsMicro > 0n
    ? (build.order.isBuy
      ? ceilDivide(sizeMicroUsd * ONE_CONTRACT_MICRO, filledContractsMicro)
      : sizeMicroUsd * ONE_CONTRACT_MICRO / filledContractsMicro)
    : 0n;
  return {
    orderPubkey: null,
    positionPubkey: build.order.positionPubkey,
    marketId: build.order.marketId,
    status: filledContractsMicro > 0n ? "filled" : "failed",
    isBuy: build.order.isBuy,
    isYes: true,
    contractsMicro: filledContractsMicro,
    filledContractsMicro,
    averageFillPriceMicroUsd,
    sizeMicroUsd,
    settled: true,
    reconciliationSource: "swap_execute",
    quotedContractsMicro: build.order.newContractsMicro,
  };
}

export function forecastSwapPositionId(marketId: string, outcomeMint: string): string {
  return `${SWAP_POSITION_PREFIX}:${marketId}:${outcomeMint}`;
}

function parseSwapPositionId(value: string): { marketId: string; outcomeMint: string } {
  const [prefix, marketId, outcomeMint, extra] = value.split(":");
  if (prefix !== SWAP_POSITION_PREFIX || !marketId || !outcomeMint || extra !== undefined) {
    throw new Error(`Unsupported Forecast Swap position identity ${value}`);
  }
  return { marketId, outcomeMint };
}

function parseUnsignedInteger(value: unknown, field: string): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`Jupiter Swap response is missing ${field}`);
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Cannot divide by a non-positive quantity");
  return (numerator + denominator - 1n) / denominator;
}

interface SettlementTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

function tokenDeltaForOwner(
  pre: readonly SettlementTokenBalance[],
  post: readonly SettlementTokenBalance[],
  ownerPubkey: string,
  mint: string,
): bigint {
  return settlementBalance(post, pre, post, ownerPubkey, mint) -
    settlementBalance(pre, pre, post, ownerPubkey, mint);
}

function settlementBalance(
  balances: readonly SettlementTokenBalance[],
  pre: readonly SettlementTokenBalance[],
  post: readonly SettlementTokenBalance[],
  ownerPubkey: string,
  mint: string,
): bigint {
  const indexes = new Set(
    [...pre, ...post]
      .filter((balance) => balance.mint === mint && balance.owner === ownerPubkey)
      .map((balance) => balance.accountIndex),
  );
  return balances.reduce((total, balance) => {
    if (balance.mint !== mint ||
      (balance.owner !== ownerPubkey && !indexes.has(balance.accountIndex))) return total;
    return total + (/^\d+$/.test(balance.uiTokenAmount.amount)
      ? BigInt(balance.uiTokenAmount.amount)
      : 0n);
  }, 0n);
}

function transactionReadFinality(commitment: Commitment): Finality {
  return commitment === "finalized" || commitment === "confirmed" ? commitment : "confirmed";
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}
