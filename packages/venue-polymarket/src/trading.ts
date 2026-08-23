import {
  OrderSide,
  OrderType,
  RequestRejectedError,
  createSecureClient,
  relayerApiKey,
  type SecureClient,
} from "@polymarket/client";
import { fetchBalanceAllowance, fetchTickSize } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";

import { formatContracts, formatUsd, parseContracts, parseUsd } from "../../domain/src/fixed.ts";

type OfficialSecureClient = Awaited<ReturnType<typeof createSecureClient>>;
type OfficialSignedOrder = Awaited<ReturnType<OfficialSecureClient["createMarketOrder"]>>;

function ceilToTick(value: bigint, tick: bigint): bigint {
  if (tick <= 0n) throw new Error("Polymarket tick size must be positive");
  return (value + tick - 1n) / tick * tick;
}

function floorToCent(value: bigint): bigint {
  return value / 10_000n * 10_000n;
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
    // Polymarket market BUYs are quote-denominated: `amount` is the exact USD
    // notional to spend, while `maxPrice` is only the worst acceptable price.
    // Consequently the filled share count can be larger than the indicative
    // target when the CLOB provides price improvement. The live trader always
    // sizes its second venue from the returned fill instead of assuming this
    // requested contract count is exact.
    const signedOrder = await this.#client.createMarketOrder({
      tokenId: input.tokenId,
      side: OrderSide.BUY,
      amount: formatUsd(grossAmountMicroUsd),
      maxPrice: formatUsd(maximumLimitPriceMicroUsd),
      orderType: OrderType.FOK,
    });
    assertPolymarketMarketOrderPrecision(signedOrder);
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

export function assertPolymarketMarketableBuyMinimum(grossAmountMicroUsd: bigint): void {
  if (grossAmountMicroUsd < POLYMARKET_MARKETABLE_BUY_MINIMUM_MICRO_USD) {
    throw new Error(
      `Polymarket marketable BUY amount $${formatUsd(grossAmountMicroUsd)} is below the $1 minimum`,
    );
  }
}
