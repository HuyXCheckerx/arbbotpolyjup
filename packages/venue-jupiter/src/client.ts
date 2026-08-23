import { ONE_USD_MICRO, parseContracts, parseUsd } from "../../domain/src/fixed.ts";
import { HttpClient } from "../../domain/src/http.ts";
import { asArray, asNumber, asString, isRecord } from "../../domain/src/json.ts";
import type { BinaryOrderBook, BookLevel, MarketPricing, VenueMarket } from "../../domain/src/types.ts";
import type { JupiterRequestPriority, JupiterRequestScheduler } from "./request-scheduler.ts";

const DEFAULT_PREDICTION_URL = "https://api.jup.ag/prediction/v1";

export interface JupiterClientOptions {
  baseUrl?: string;
  apiKey?: string;
  http?: HttpClient;
  minRequestIntervalMs?: number;
  requestScheduler?: JupiterRequestScheduler;
  requestPriority?: JupiterRequestPriority;
}

export interface JupiterDiscoveryOptions {
  provider: string;
  category?: string;
  subcategory?: string;
  filter?: "new" | "live" | "trending";
  tag?: string;
  sortBy?: "volume" | "beginAt";
  sortDirection?: "asc" | "desc";
  maxEvents?: number;
  pageSize?: number;
}

export interface JupiterPredictionOrderBuild {
  transaction: string;
  txMeta: { blockhash: string; lastValidBlockHeight: number };
  externalOrderId: string | null;
  jupiterSwapRequestId: string | null;
  requiredSigners: string[];
  execution: { endpoint: string; context: Record<string, unknown> };
  executionModel: string | null;
  settlement: string | null;
  order: {
    orderPubkey: string | null;
    positionPubkey: string;
    marketId: string;
    isBuy: boolean;
    isYes: boolean;
    contractsMicro: bigint;
    newContractsMicro: bigint;
    maxBuyPriceMicroUsd: bigint | null;
    minSellPriceMicroUsd: bigint | null;
    orderCostMicroUsd: bigint;
    newAveragePriceMicroUsd: bigint | null;
    newSizeMicroUsd: bigint;
    payoutMicroUsd: bigint;
    estimatedTotalFeeMicroUsd: bigint;
  };
}

export interface JupiterPredictionExecutionResult {
  status: "Success" | "Failed";
  signature: string | null;
  error: string | null;
  requestId: string;
}

export interface JupiterPredictionOrderStatus {
  orderPubkey: string | null;
  positionPubkey: string;
  marketId: string;
  status: "pending" | "filled" | "failed";
  isBuy: boolean;
  isYes: boolean;
  contractsMicro: bigint;
  filledContractsMicro: bigint;
  averageFillPriceMicroUsd: bigint;
  sizeMicroUsd: bigint;
  settled: boolean;
}

export interface JupiterPredictionPosition {
  positionPubkey: string;
  marketId: string;
  isYes: boolean;
  contractsMicro: bigint;
  totalCostMicroUsd: bigint;
  feesPaidMicroUsd: bigint;
  sellPriceMicroUsd: bigint | null;
  claimable: boolean;
  claimed: boolean;
  claimedMicroUsd: bigint;
  result: "yes" | "no" | "pending" | null;
}

export interface JupiterPredictionClaimBuild {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  positionPubkey: string;
  contractsMicro: bigint;
  payoutMicroUsd: bigint;
}

export class JupiterClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #http: HttpClient;
  readonly #minRequestIntervalMs: number;
  readonly #requestScheduler: JupiterRequestScheduler | undefined;
  readonly #requestPriority: JupiterRequestPriority;
  #lastRequestAtMs = 0;
  #requestQueue: Promise<void> = Promise.resolve();

  constructor(options: JupiterClientOptions = {}) {
    this.#baseUrl = trimSlash(options.baseUrl ?? process.env.JUPITER_PREDICTION_URL ?? DEFAULT_PREDICTION_URL);
    this.#apiKey = options.apiKey ?? process.env.JUPITER_API_KEY;
    this.#http = options.http ?? new HttpClient();
    this.#minRequestIntervalMs = options.minRequestIntervalMs ?? (this.#apiKey ? 0 : 2_100);
    this.#requestScheduler = options.requestScheduler;
    this.#requestPriority = options.requestPriority ?? "normal";
  }

  async getMarkets(options: JupiterDiscoveryOptions): Promise<VenueMarket[]> {
    const maxEvents = options.maxEvents ?? 100;
    const pageSize = Math.min(options.pageSize ?? 50, maxEvents);
    const markets: VenueMarket[] = [];
    let start = 0;

    while (start < maxEvents) {
      const end = Math.min(start + pageSize, maxEvents);
      const url = new URL(`${this.#baseUrl}/events`);
      url.searchParams.set("provider", options.provider);
      url.searchParams.set("category", options.category ?? "crypto");
      url.searchParams.set("includeMarkets", "true");
      if (options.subcategory) url.searchParams.set("subcategory", options.subcategory);
      if (options.filter) url.searchParams.set("filter", options.filter);
      if (options.tag) url.searchParams.set("tag", options.tag);
      if (options.sortBy) url.searchParams.set("sortBy", options.sortBy);
      if (options.sortDirection) url.searchParams.set("sortDirection", options.sortDirection);
      url.searchParams.set("start", String(start));
      url.searchParams.set("end", String(end));
      const payload = await this.#getJson(url);
      if (!isRecord(payload)) throw new Error("Jupiter events response is not an object");

      for (const rawEvent of asArray(payload.data)) {
        if (!isRecord(rawEvent)) continue;
        markets.push(...parseJupiterEvent(rawEvent, this.#baseUrl));
      }

      const pagination = isRecord(payload.pagination) ? payload.pagination : {};
      if (pagination.hasNext !== true) break;
      start = end;
    }

    return markets;
  }

  async getMarket(marketId: string): Promise<VenueMarket> {
    const payload = await this.#getJson(`${this.#baseUrl}/markets/${encodeURIComponent(marketId)}`);
    if (!isRecord(payload)) throw new Error(`Jupiter market ${marketId} is not an object`);
    return parseJupiterMarket(payload, null, "", this.#baseUrl);
  }

  async didSelectedMarketWin(marketId: string): Promise<boolean | null> {
    const payload = await this.#getJson(`${this.#baseUrl}/markets/${encodeURIComponent(marketId)}`);
    if (!isRecord(payload)) return null;
    const result = asString(payload.result).toLowerCase();
    if (result === "yes") return true;
    if (result === "no") return false;
    return null;
  }

  async getTradingStatus(): Promise<boolean> {
    const payload = await this.#getJson(`${this.#baseUrl}/trading-status`);
    return isRecord(payload) && payload.trading_active === true;
  }

  async createPredictionBuyOrder(input: {
    ownerPubkey: string;
    marketId: string;
    isYes?: boolean;
    depositAmountMicroUsd: bigint;
    depositMint?: string;
  }): Promise<JupiterPredictionOrderBuild> {
    const payload = await this.#requestJson("POST", `${this.#baseUrl}/orders`, {
      isBuy: true,
      ownerPubkey: input.ownerPubkey,
      marketId: input.marketId,
      isYes: input.isYes ?? true,
      depositAmount: input.depositAmountMicroUsd.toString(),
      depositMint: input.depositMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
    return parsePredictionOrderBuild(payload);
  }

  async createPredictionCloseOrder(input: {
    ownerPubkey: string;
    positionPubkey: string;
  }): Promise<JupiterPredictionOrderBuild> {
    const payload = await this.#requestJson(
      "DELETE",
      `${this.#baseUrl}/positions/${encodeURIComponent(input.positionPubkey)}`,
      { ownerPubkey: input.ownerPubkey },
    );
    return parsePredictionOrderBuild(payload);
  }

  async executePredictionOrder(input: {
    signedTransaction: string;
    context: Record<string, unknown>;
    requestId: string;
  }): Promise<JupiterPredictionExecutionResult> {
    // The documented Prediction endpoint accepts the signed transaction and
    // the opaque context returned by POST /orders. `requestId` remains local
    // correlation metadata; sending it as an extra top-level field diverged
    // from both the Forecast docs and the current jup.ag client.
    const payload = await this.#requestJson("POST", `${this.#baseUrl}/execute`, {
      signedTransaction: input.signedTransaction,
      context: input.context,
    });
    if (!isRecord(payload)) throw new Error("Jupiter execution response is not an object");
    const status = asString(payload.status);
    if (status !== "Success" && status !== "Failed") {
      throw new Error(`Jupiter execution returned unsupported status ${status || "missing"}`);
    }
    return {
      status,
      signature: asString(payload.signature) || null,
      error: asString(payload.error) || null,
      requestId: asString(payload.requestId, input.requestId),
    };
  }

  async getPredictionOrder(orderPubkey: string): Promise<JupiterPredictionOrderStatus> {
    const payload = await this.#getJson(`${this.#baseUrl}/orders/${encodeURIComponent(orderPubkey)}`);
    if (!isRecord(payload)) throw new Error(`Jupiter order ${orderPubkey} is not an object`);
    const status = asString(payload.status).toLowerCase();
    if (status !== "pending" && status !== "filled" && status !== "failed") {
      throw new Error(`Jupiter order ${orderPubkey} has unsupported status ${status || "missing"}`);
    }
    return {
      orderPubkey: asString(payload.pubkey, orderPubkey),
      positionPubkey: asString(payload.position),
      marketId: asString(payload.marketId),
      status,
      isBuy: payload.isBuy === true,
      isYes: payload.isYes === true,
      contractsMicro: parseRequiredMicroInteger(payload.contracts, "contracts (micro-contract u64)"),
      filledContractsMicro: parseRequiredMicroInteger(payload.filledContracts, "filledContracts (micro-contract u64)"),
      averageFillPriceMicroUsd: parseRequiredMicroInteger(payload.avgFillPriceUsd, "avgFillPriceUsd"),
      sizeMicroUsd: parseRequiredMicroInteger(payload.sizeUsd, "sizeUsd"),
      settled: payload.settled === true,
    };
  }

  async getPredictionPosition(positionPubkey: string): Promise<JupiterPredictionPosition> {
    const payload = await this.#getJson(`${this.#baseUrl}/positions/${encodeURIComponent(positionPubkey)}`);
    if (!isRecord(payload)) throw new Error(`Jupiter position ${positionPubkey} is not an object`);
    const marketMetadata = isRecord(payload.marketMetadata) ? payload.marketMetadata : {};
    const rawResult = asString(marketMetadata.result).toLowerCase();
    const result = rawResult === "yes" || rawResult === "no" || rawResult === "pending" ? rawResult : null;
    return {
      positionPubkey: asString(payload.pubkey, positionPubkey),
      marketId: asString(payload.marketId),
      isYes: payload.isYes === true,
      contractsMicro: parsePositionContracts(payload, "position.contracts"),
      totalCostMicroUsd: parseRequiredMicroInteger(payload.totalCostUsd, "totalCostUsd"),
      feesPaidMicroUsd: parseRequiredMicroInteger(payload.feesPaidUsd, "feesPaidUsd"),
      sellPriceMicroUsd: parseOptionalMicroInteger(payload.sellPriceUsd),
      claimable: payload.claimable === true,
      claimed: payload.claimed === true,
      claimedMicroUsd: parseOptionalMicroInteger(payload.claimedUsd) ?? 0n,
      result,
    };
  }

  async createPredictionClaim(input: {
    ownerPubkey: string;
    positionPubkey: string;
  }): Promise<JupiterPredictionClaimBuild> {
    const payload = await this.#requestJson(
      "POST",
      `${this.#baseUrl}/positions/${encodeURIComponent(input.positionPubkey)}/claim`,
      { ownerPubkey: input.ownerPubkey },
    );
    if (!isRecord(payload) || !isRecord(payload.position)) {
      throw new Error("Jupiter claim build is missing position data");
    }
    const transaction = asString(payload.transaction);
    const positionPubkey = asString(payload.position.pubkey);
    const blockhash = asString(payload.blockhash);
    const lastValidBlockHeight = asNumber(payload.lastValidBlockHeight) ?? 0;
    if (!transaction || !positionPubkey || !blockhash || lastValidBlockHeight <= 0) {
      throw new Error("Jupiter claim build is missing executable transaction metadata");
    }
    return {
      transaction,
      blockhash,
      lastValidBlockHeight,
      positionPubkey,
      contractsMicro: parsePositionContracts(payload.position, "claim.position.contracts"),
      payoutMicroUsd: parseRequiredMicroInteger(payload.position.payoutAmountUsd, "claim.position.payoutAmountUsd"),
    };
  }

  async getEventMarkets(eventId: string, options: JupiterDiscoveryOptions): Promise<VenueMarket[]> {
    const markets = (await this.getMarkets(options)).filter((market) => market.eventId === eventId);
    if (markets.length === 0) {
      throw new Error(`Jupiter event ${eventId} was not found in the configured discovery window`);
    }
    return markets;
  }

  async getOrderBook(market: VenueMarket | string): Promise<BinaryOrderBook> {
    const marketId = typeof market === "string" ? market : market.marketId;
    const provider = typeof market === "string" ? "unknown" : market.provider;
    const payload = await this.#getJson(`${this.#baseUrl}/orderbook/${encodeURIComponent(marketId)}`);
    if (!isRecord(payload)) throw new Error(`Jupiter orderbook ${marketId} is not an object`);
    const yesBids = parseJupiterBidLevels(payload.yes_dollars);
    const noBids = parseJupiterBidLevels(payload.no_dollars);
    if (yesBids.length === 0 && noBids.length === 0) {
      throw new Error(`Jupiter orderbook ${marketId} has no exact dollar-price levels`);
    }

    return {
      venue: "jupiter",
      provider,
      marketId,
      receivedAtMs: Date.now(),
      sourceTimestampMs: null,
      yes: {
        bids: sortBids(yesBids),
        asks: sortAsks(complementLevels(noBids)),
      },
      no: {
        bids: sortBids(noBids),
        asks: sortAsks(complementLevels(yesBids)),
      },
    };
  }

  #headers(): Readonly<Record<string, string>> {
    return this.#apiKey ? { "x-api-key": this.#apiKey } : {};
  }

  async #getJson(url: URL | string): Promise<unknown> {
    return await this.#requestJson("GET", url);
  }

  async #requestJson(method: "GET" | "POST" | "DELETE", url: URL | string, body?: unknown): Promise<unknown> {
    const requestUrl = typeof url === "string" ? new URL(url) : url;
    // Execute is the latency-sensitive signed-transaction handoff. Jupiter's
    // execute endpoints are not discovery polling and must not sit behind a
    // later candidate's order-build reservation.
    if (this.#requestScheduler && !requestUrl.pathname.endsWith("/execute")) {
      await this.#requestScheduler.wait(this.#requestPriority);
      if (method === "POST") return await this.#http.postJson(requestUrl, body, this.#headers());
      if (method === "DELETE") return await this.#http.deleteJson(requestUrl, body, this.#headers());
      return await this.#http.getJson(requestUrl, this.#headers());
    }
    let release!: () => void;
    const previous = this.#requestQueue;
    this.#requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.#lastRequestAtMs + this.#minRequestIntervalMs - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      this.#lastRequestAtMs = Date.now();
      if (method === "POST") return await this.#http.postJson(url, body, this.#headers());
      if (method === "DELETE") return await this.#http.deleteJson(url, body, this.#headers());
      return await this.#http.getJson(url, this.#headers());
    } finally {
      release();
    }
  }
}

function parsePredictionOrderBuild(payload: unknown): JupiterPredictionOrderBuild {
  if (!isRecord(payload)) throw new Error("Jupiter order build is not an object");
  if (!isRecord(payload.txMeta) || !isRecord(payload.order)) {
    throw new Error("Jupiter order build is missing txMeta or order");
  }
  const transaction = asString(payload.transaction);
  const execution = isRecord(payload.execution) ? payload.execution : {};
  const executionContext = isRecord(execution.context) ? execution.context : {};
  const executionModel = asString(payload.executionModel) || null;
  const settlement = asString(payload.settlement) || null;
  const orderPubkey = asString(payload.order.orderPubkey) || null;
  const positionPubkey = asString(payload.order.positionPubkey);
  const marketId = asString(payload.order.marketId);
  const topLevelSwapRequestId = asString(payload.jupiterSwapRequestId);
  const contextSwapRequestId = asString(executionContext.jupiterSwapRequestId);
  if (topLevelSwapRequestId && contextSwapRequestId && topLevelSwapRequestId !== contextSwapRequestId) {
    throw new Error("Jupiter order build has conflicting atomic-swap request IDs");
  }
  const jupiterSwapRequestId = topLevelSwapRequestId || contextSwapRequestId || null;
  if (!transaction || !positionPubkey || !marketId) {
    throw new Error("Jupiter order build is missing executable identity fields");
  }
  if (!orderPubkey && executionModel !== "atomic_swap") {
    throw new Error("Jupiter keeper order build is missing orderPubkey");
  }
  if (executionModel === "atomic_swap" && !jupiterSwapRequestId) {
    throw new Error("Jupiter atomic-swap build is missing jupiterSwapRequestId");
  }
  return {
    transaction,
    txMeta: {
      blockhash: asString(payload.txMeta.blockhash),
      lastValidBlockHeight: asNumber(payload.txMeta.lastValidBlockHeight) ?? 0,
    },
    externalOrderId: asString(payload.externalOrderId) || null,
    jupiterSwapRequestId,
    requiredSigners: asArray(payload.requiredSigners).filter((value): value is string => typeof value === "string"),
    execution: {
      endpoint: asString(execution.endpoint),
      context: executionContext,
    },
    executionModel,
    settlement,
    order: {
      orderPubkey,
      positionPubkey,
      marketId,
      isBuy: payload.order.isBuy === true,
      isYes: payload.order.isYes === true,
      contractsMicro: parseRequiredMicroInteger(payload.order.contractsMicro, "order.contractsMicro"),
      newContractsMicro: parseRequiredMicroInteger(payload.order.newContractsMicro, "order.newContractsMicro"),
      maxBuyPriceMicroUsd: parseOptionalMicroInteger(payload.order.maxBuyPriceUsd),
      minSellPriceMicroUsd: parseOptionalMicroInteger(payload.order.minSellPriceUsd),
      orderCostMicroUsd: parseOptionalMicroInteger(payload.order.orderCostUsd) ?? 0n,
      newAveragePriceMicroUsd: parseOptionalMicroInteger(payload.order.newAvgPriceUsd),
      newSizeMicroUsd: parseOptionalMicroInteger(payload.order.newSizeUsd) ?? 0n,
      payoutMicroUsd: parseOptionalMicroInteger(payload.order.payoutUsd) ?? 0n,
      estimatedTotalFeeMicroUsd: parseOptionalMicroInteger(payload.order.estimatedTotalFeeUsd) ?? 0n,
    },
  };
}

function parseRequiredMicroInteger(value: unknown, field: string): bigint {
  const parsed = parseOptionalMicroInteger(value);
  if (parsed === null) throw new Error(`Jupiter response is missing ${field}`);
  return parsed;
}

function parseOptionalMicroInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if ((typeof value === "string" || typeof value === "number") && /^\d+(?:\.\d+)?$/.test(String(value))) {
    return parseUsd(String(value));
  }
  return null;
}

function parsePositionContracts(payload: Record<string, unknown>, field: string): bigint {
  const explicitMicro = parseOptionalMicroInteger(payload.contractsMicro);
  if (explicitMicro !== null) return explicitMicro;
  const contracts = payload.contracts;
  if (typeof contracts === "string" || typeof contracts === "number") return parseContracts(contracts);
  throw new Error(`Jupiter response is missing ${field}`);
}

function parseJupiterEvent(rawEvent: Record<string, unknown>, baseUrl: string): VenueMarket[] {
  const eventId = asString(rawEvent.eventId) || null;
  const metadata = isRecord(rawEvent.metadata) ? rawEvent.metadata : {};
  const eventTitle = asString(metadata.title);
  return asArray(rawEvent.markets)
    .filter(isRecord)
    .map((market) => parseJupiterMarket(market, eventId, eventTitle, baseUrl));
}

function parseJupiterMarket(
  raw: Record<string, unknown>,
  eventId: string | null,
  eventTitle: string,
  baseUrl: string,
): VenueMarket {
  const marketId = asString(raw.marketId);
  if (!marketId) throw new Error("Jupiter market is missing marketId");
  const pricing = isRecord(raw.pricing) ? raw.pricing : {};
  return {
    venue: "jupiter",
    provider: asString(raw.provider, "unknown").toLowerCase(),
    eventId,
    marketId,
    title: asString(raw.title),
    eventTitle,
    rulesPrimary: asString(raw.rulesPrimary),
    rulesSecondary: asString(raw.rulesSecondary),
    status: asString(raw.status, "unknown"),
    openTimeMs: epochSecondsToMs(raw.openTime),
    closeTimeMs: epochSecondsToMs(raw.closeTime),
    clobTokenIds: parseStringArray(raw.clobTokenIds),
    outcomes: parseStringArray(raw.outcomes),
    outcomeMint: asString(raw.outcomeMint) || null,
    pricing: parsePricing(pricing),
    sourceUrl: `${baseUrl}/markets/${encodeURIComponent(marketId)}`,
  };
}

function parsePricing(raw: Record<string, unknown>): MarketPricing {
  return {
    buyYesMicroUsd: parseMicroInteger(raw.buyYesPriceUsd),
    sellYesMicroUsd: parseMicroInteger(raw.sellYesPriceUsd),
    buyNoMicroUsd: parseMicroInteger(raw.buyNoPriceUsd),
    sellNoMicroUsd: parseMicroInteger(raw.sellNoPriceUsd),
  };
}

function parseMicroInteger(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  const number = asNumber(value);
  return number !== null && Number.isSafeInteger(number) ? BigInt(number) : null;
}

function parseJupiterBidLevels(value: unknown): BookLevel[] {
  const levels: BookLevel[] = [];
  for (const raw of asArray(value)) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const price = raw[0];
    const quantity = raw[1];
    if ((typeof price !== "string" && typeof price !== "number") ||
        (typeof quantity !== "string" && typeof quantity !== "number")) continue;
    levels.push({
      priceMicroUsd: parseUsd(price),
      contractsMicro: parseContracts(quantity),
    });
  }
  return levels;
}

function complementLevels(levels: readonly BookLevel[]): BookLevel[] {
  return levels
    .filter((level) => level.priceMicroUsd >= 0n && level.priceMicroUsd <= ONE_USD_MICRO)
    .map((level) => ({
      priceMicroUsd: ONE_USD_MICRO - level.priceMicroUsd,
      contractsMicro: level.contractsMicro,
    }));
}

function sortBids(levels: readonly BookLevel[]): BookLevel[] {
  return [...levels].sort((a, b) => compareBigint(b.priceMicroUsd, a.priceMicroUsd));
}

function sortAsks(levels: readonly BookLevel[]): BookLevel[] {
  return [...levels].sort((a, b) => compareBigint(a.priceMicroUsd, b.priceMicroUsd));
}

function parseStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function epochSecondsToMs(value: unknown): number | null {
  const seconds = asNumber(value);
  return seconds === null ? null : seconds * 1_000;
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
