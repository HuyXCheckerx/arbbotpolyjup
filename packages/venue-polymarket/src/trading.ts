import {
  OrderSide,
  OrderType,
  RequestRejectedError,
  createSecureClient,
  relayerApiKey,
  type SecureClient,
} from "@polymarket/client";
import { fetchBalanceAllowance, fetchTickSize, updateBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";

import {
  ONE_CONTRACT_MICRO,
  formatContracts,
  formatUsd,
  parseContracts,
  parseUsd,
} from "../../domain/src/fixed.ts";
import type { BookLevel } from "../../domain/src/types.ts";

type OfficialSecureClient = Awaited<ReturnType<typeof createSecureClient>>;
type OfficialSignedOrder = Awaited<ReturnType<OfficialSecureClient["createMarketOrder"]>>;

function ceilToTick(value: bigint, tick: bigint): bigint {
  if (tick <= 0n) throw new Error("Polymarket tick size must be positive");
  return (value + tick - 1n) / tick * tick;
}

function floorToCent(value: bigint): bigint {
  return value / 10_000n * 10_000n;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export const POLYMARKET_MARKETABLE_BUY_MINIMUM_MICRO_USD = 1_000_000n;

export interface PolymarketLiveFill {
  orderId: string;
  contractsMicro: bigint;
  grossMicroUsd: bigint;
  submissionStartedAtMs: number;
  transactionHashes: string[];
}

export interface PreparedPolymarketFokOrder {
  kind: "buy" | "sell";
  signedOrder: OfficialSignedOrder;
}

export interface PolymarketExecutableAsks {
  asks: BookLevel[];
  receivedAtMs: number;
  sourceTimestampMs: number | null;
}

export class PolymarketFokSubmissionError extends Error {
  readonly code: string;
  readonly status: string;

  constructor(code: string, status: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PolymarketFokSubmissionError";
    this.code = code;
    this.status = status;
  }
}

export class PolymarketLiveExecutor {
  readonly #client: OfficialSecureClient;
  readonly #tickSizeCache = new Map<string, { value: bigint; expiresAtMs: number }>();

  private constructor(client: OfficialSecureClient) {
    this.#client = client;
  }

  static async create(input: {
    privateKey: string;
    walletAddress: string;
    relayerApiKey?: string | undefined;
    relayerApiKeyAddress?: string | undefined;
  }): Promise<PolymarketLiveExecutor> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.privateKey)) {
      throw new Error("POLYMARKET_PRIVATE_KEY must be a 0x-prefixed 32-byte private key");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress)) {
      throw new Error("POLYMARKET_WALLET_ADDRESS must be a Polygon wallet address");
    }
    const hasRelayerKey = Boolean(input.relayerApiKey);
    const hasRelayerAddress = Boolean(input.relayerApiKeyAddress);
    if (hasRelayerKey !== hasRelayerAddress) {
      throw new Error(
        "POLYMARKET_RELAYER_API_KEY and POLYMARKET_RELAYER_API_KEY_ADDRESS must be supplied together",
      );
    }
    if (input.relayerApiKeyAddress && !/^0x[0-9a-fA-F]{40}$/.test(input.relayerApiKeyAddress)) {
      throw new Error("POLYMARKET_RELAYER_API_KEY_ADDRESS must be a Polygon wallet address");
    }
    const gaslessAuthorization = input.relayerApiKey && input.relayerApiKeyAddress
      ? relayerApiKey({ key: input.relayerApiKey, address: input.relayerApiKeyAddress })
      : undefined;
    const signer = privateKey(input.privateKey);
    const client = await createSecureClient({
      wallet: input.walletAddress,
      signer,
      ...(gaslessAuthorization ? { apiKey: gaslessAuthorization } : {}),
    });
    return new PolymarketLiveExecutor(client);
  }

  async assertReady(minimumCollateralMicroUsd: bigint): Promise<{
    collateralBalanceMicroUsd: bigint;
    minimumAllowanceMicroUsd: bigint;
  }> {
    if (await this.#client.fetchClosedOnlyMode()) {
      throw new Error("Polymarket account is in closed-only mode and cannot open new positions");
    }
    const balance = await fetchBalanceAllowance(this.#client, { assetType: "COLLATERAL" as never });
    const collateralBalanceMicroUsd = BigInt(balance.balance as unknown as bigint);
    const allowanceValues = Object.values(balance.allowances);
    if (allowanceValues.length === 0) {
      throw new Error("Polymarket returned no collateral allowance records; run approval setup first");
    }
    const minimumAllowanceMicroUsd = allowanceValues.reduce<bigint>(
      (minimum, value) => BigInt(value as bigint) < minimum ? BigInt(value as bigint) : minimum,
      2n ** 255n,
    );
    if (collateralBalanceMicroUsd < minimumCollateralMicroUsd) {
      throw new Error(
        `Polymarket collateral balance $${formatUsd(collateralBalanceMicroUsd)} is below required ` +
        `$${formatUsd(minimumCollateralMicroUsd)}`,
      );
    }
    if (minimumAllowanceMicroUsd < minimumCollateralMicroUsd) {
      throw new Error("Polymarket trading allowances are insufficient; run the documented approval setup first");
    }
    return { collateralBalanceMicroUsd, minimumAllowanceMicroUsd };
  }

  async fetchCollateralBalance(): Promise<bigint> {
    const balance = await fetchBalanceAllowance(this.#client, { assetType: "COLLATERAL" as never });
    return BigInt(balance.balance as unknown as bigint);
  }

  async setupTradingApprovals(): Promise<void> {
    await this.#client.setupTradingApprovals();
  }

  async getTokenBalance(tokenId: string): Promise<bigint> {
    const balance = await fetchBalanceAllowance(this.#client, {
      assetType: "CONDITIONAL" as never,
      tokenId,
    });
    return BigInt(balance.balance as unknown as bigint);
  }

  async refreshTokenBalance(tokenId: string): Promise<bigint> {
    // A matched BUY settles on Polygon asynchronously. Force the CLOB's
    // balance/allowance cache to refresh before an emergency SELL; a plain
    // balance read can otherwise continue reporting the pre-fill zero balance.
    const balance = await updateBalanceAllowance(this.#client, {
      assetType: "CONDITIONAL" as never,
      tokenId,
    });
    return BigInt(balance.balance as unknown as bigint);
  }

  async assertTokenReady(tokenId: string, minimumContractsMicro: bigint): Promise<bigint> {
    const balance = await fetchBalanceAllowance(this.#client, {
      assetType: "CONDITIONAL" as never,
      tokenId,
    });
    const allowances = Object.values(balance.allowances).map((value) => BigInt(value as bigint));
    if (allowances.length === 0 || allowances.some((value) => value < minimumContractsMicro)) {
      throw new Error("Polymarket conditional-token allowances are insufficient; run approval setup first");
    }
    return BigInt(balance.balance as unknown as bigint);
  }

  async redeemMarket(marketId: string): Promise<string> {
    const handle = await this.#client.redeemPositions({ marketId });
    const outcome = await handle.wait();
    return outcome.transactionHash;
  }

  async primeBuyToken(tokenId: string): Promise<void> {
    await this.#tickSize(tokenId);
  }

  async fetchBuyAsks(tokenId: string): Promise<PolymarketExecutableAsks> {
    const book = await this.#client.fetchOrderBook({ tokenId });
    return {
      asks: book.asks.map((level) => ({
        priceMicroUsd: parseUsd(String(level.price)),
        contractsMicro: parseContracts(String(level.size)),
      })),
      receivedAtMs: Date.now(),
      sourceTimestampMs: book.timestamp === null || book.timestamp === undefined
        ? null
        : Number(book.timestamp),
    };
  }

  async prepareBuyFok(input: {
    tokenId: string;
    contractsMicro: bigint;
    grossAmountMicroUsd: bigint;
    maximumPriceMicroUsd: bigint;
  }): Promise<PreparedPolymarketFokOrder> {
    const grossAmountMicroUsd = floorToCent(input.grossAmountMicroUsd);
    assertPolymarketMarketableBuyMinimum(grossAmountMicroUsd);
    const tickSizeMicroUsd = await this.#tickSize(input.tokenId);
    const maximumLimitPriceMicroUsd = ceilToTick(input.maximumPriceMicroUsd, tickSizeMicroUsd);
    // Sign a share-denominated marketable limit, then post it with FOK
    // time-in-force. In CLOB V2 orderType is a posting parameter rather than a
    // field in the EIP-712 order hash, so this preserves the exact requested
    // share count while retaining all-or-nothing execution.
    const limitOrder = await this.#client.createLimitOrder({
      tokenId: input.tokenId,
      side: OrderSide.BUY,
      size: formatContracts(input.contractsMicro),
      price: formatUsd(maximumLimitPriceMicroUsd),
      postOnly: false,
    });
    const signedOrder: OfficialSignedOrder = { ...limitOrder, orderType: OrderType.FOK, postOnly: false };
    assertPolymarketBuyLimitOrder(
      signedOrder,
      input.contractsMicro,
      maximumLimitPriceMicroUsd,
    );
    return { kind: "buy", signedOrder };
  }

  async prepareSellFok(input: {
    tokenId: string;
    contractsMicro: bigint;
    minimumPriceMicroUsd: bigint;
  }): Promise<PreparedPolymarketFokOrder> {
    const signedOrder = await this.#client.createMarketOrder({
      tokenId: input.tokenId,
      side: OrderSide.SELL,
      shares: formatContracts(input.contractsMicro),
      minPrice: formatUsd(input.minimumPriceMicroUsd),
      orderType: OrderType.FOK,
    });
    return { kind: "sell", signedOrder };
  }

  async submitPreparedFok(prepared: PreparedPolymarketFokOrder): Promise<PolymarketLiveFill> {
    const submissionStartedAtMs = Date.now();
    let response: Awaited<ReturnType<OfficialSecureClient["postOrder"]>>;
    try {
      response = await this.#client.postOrder(prepared.signedOrder);
    } catch (error) {
      if (error instanceof RequestRejectedError) {
        throw new PolymarketFokSubmissionError(
          error.code ?? `HTTP_${error.status}`,
          "rejected",
          `Polymarket FOK ${prepared.kind} rejected (${error.status}): ${error.message}`,
          error,
        );
      }
      throw error;
    }
    if (!response.ok) {
      throw new PolymarketFokSubmissionError(
        String(response.code),
        "rejected",
        `Polymarket FOK ${prepared.kind} rejected (${response.code}): ${response.message}`,
      );
    }
    if (response.status !== "matched") {
      throw new PolymarketFokSubmissionError(
        "UNEXPECTED_STATUS",
        response.status,
        `Polymarket FOK ${prepared.kind} returned unexpected status ${response.status}`,
      );
    }
    // A `matched` CLOB response is the definitive fill acknowledgement. Polygon
    // settlement follows asynchronously and is not needed before submitting the
    // other arb leg; waiting here added roughly a second to the critical path.
    void this.#client.waitForOrderFillSettlement(response).catch(() => []);
    const transactionHashes: string[] = [];
    return prepared.kind === "buy"
      ? {
          orderId: response.orderId,
          grossMicroUsd: parseUsd(response.makingAmount),
          contractsMicro: parseContracts(response.takingAmount),
          submissionStartedAtMs,
          transactionHashes,
        }
      : {
          orderId: response.orderId,
          contractsMicro: parseContracts(response.makingAmount),
          grossMicroUsd: parseUsd(response.takingAmount),
          submissionStartedAtMs,
          transactionHashes,
        };
  }

  async buyFok(input: {
    tokenId: string;
    contractsMicro: bigint;
    grossAmountMicroUsd: bigint;
    maximumPriceMicroUsd: bigint;
  }): Promise<PolymarketLiveFill> {
    return await this.submitPreparedFok(await this.prepareBuyFok(input));
  }

  async sellFok(input: {
    tokenId: string;
    contractsMicro: bigint;
    minimumPriceMicroUsd: bigint;
  }): Promise<PolymarketLiveFill> {
    return await this.submitPreparedFok(await this.prepareSellFok(input));
  }

  get client(): SecureClient {
    return this.#client;
  }

  async #tickSize(tokenId: string): Promise<bigint> {
    const cached = this.#tickSizeCache.get(tokenId);
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;
    const value = parseUsd(String(await fetchTickSize(this.#client, { tokenId })));
    // Tick-size changes are possible near price extremes, so keep this cache
    // deliberately short. It still removes a redundant REST round-trip from
    // rapid retries in the same opportunity window.
    this.#tickSizeCache.set(tokenId, { value, expiresAtMs: Date.now() + 300_000 });
    return value;
  }
}

export function assertPolymarketMarketOrderPrecision(
  order: Pick<OfficialSignedOrder, "makerAmount" | "takerAmount">,
): void {
  const makerAmount = BigInt(order.makerAmount);
  const takerAmount = BigInt(order.takerAmount);
  if (makerAmount % 10_000n !== 0n || takerAmount % 100n !== 0n) {
    throw new Error("Polymarket SDK produced a market order outside the CLOB 2/4-decimal amount limits");
  }
}

export function assertPolymarketBuyLimitOrder(
  order: Pick<OfficialSignedOrder, "makerAmount" | "takerAmount">,
  requestedContractsMicro: bigint,
  maximumPriceMicroUsd: bigint,
): void {
  const makerAmount = BigInt(order.makerAmount);
  const takerAmount = BigInt(order.takerAmount);
  if (requestedContractsMicro <= 0n || maximumPriceMicroUsd <= 0n || makerAmount <= 0n || takerAmount <= 0n) {
    throw new Error("Polymarket SDK produced a non-positive BUY limit order");
  }
  if (takerAmount !== requestedContractsMicro) {
    throw new Error(
      `Polymarket SDK changed the BUY limit share quantity from ` +
      `${formatContracts(requestedContractsMicro)} to ${formatContracts(takerAmount)}`,
    );
  }
  const maximumMakerAmount = (
    maximumPriceMicroUsd * requestedContractsMicro + ONE_CONTRACT_MICRO - 1n
  ) / ONE_CONTRACT_MICRO;
  if (makerAmount > maximumMakerAmount) {
    throw new Error(
      `Polymarket SDK produced a BUY limit maker amount above the configured maximum price`,
    );
  }
  // FOK is treated as a marketable BUY by the CLOB even though the signed
  // payload was built with the limit-order helper. Its collateral maker amount
  // must therefore be cent-precision and its share taker amount may use at most
  // four decimals.
  assertPolymarketMarketOrderPrecision(order);
}

export function floorPolymarketFokBuyContractsToAmountPrecision(
  requestedContractsMicro: bigint,
  limitPriceMicroUsd: bigint,
): bigint {
  if (requestedContractsMicro <= 0n || limitPriceMicroUsd <= 0n || limitPriceMicroUsd >= 1_000_000n) {
    return 0n;
  }
  // The signed limit order uses two-decimal shares. For an FOK BUY the CLOB
  // additionally requires (price * shares) to produce a whole-cent collateral
  // maker amount. If price is P micro-USD and size is S share-cents, that means
  // P*S must be divisible by 1_000_000.
  const shareCentStep = 1_000_000n / greatestCommonDivisor(limitPriceMicroUsd, 1_000_000n);
  const requestedShareCents = requestedContractsMicro / 10_000n;
  return requestedShareCents / shareCentStep * shareCentStep * 10_000n;
}

export function assertPolymarketMarketableBuyMinimum(grossAmountMicroUsd: bigint): void {
  if (grossAmountMicroUsd < POLYMARKET_MARKETABLE_BUY_MINIMUM_MICRO_USD) {
    throw new Error(
      `Polymarket marketable BUY amount $${formatUsd(grossAmountMicroUsd)} is below the $1 minimum`,
    );
  }
}
