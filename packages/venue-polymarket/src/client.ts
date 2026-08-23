import { parseContracts, parseUsd } from "../../domain/src/fixed.ts";
import { HttpClient } from "../../domain/src/http.ts";
import {
  asArray,
  asBoolean,
  asNumber,
  asString,
  isRecord,
} from "../../domain/src/json.ts";
import type { BinaryOrderBook, BookLevel, MarketFeeSchedule, MarketPricing, VenueMarket } from "../../domain/src/types.ts";

const DEFAULT_GAMMA_URL = "https://gamma-api.polymarket.com";
const DEFAULT_CLOB_URL = "https://clob.polymarket.com";

export interface PolymarketClientOptions {
  gammaUrl?: string;
  clobUrl?: string;
  http?: HttpClient;
}

export interface SearchOptions {
  maxPagesPerAsset?: number;
  limitPerType?: number;
}

export class PolymarketClient {
  readonly #gammaUrl: string;
  readonly #clobUrl: string;
  readonly #http: HttpClient;

  constructor(options: PolymarketClientOptions = {}) {
    this.#gammaUrl = trimSlash(options.gammaUrl ?? process.env.POLYMARKET_GAMMA_URL ?? DEFAULT_GAMMA_URL);
    this.#clobUrl = trimSlash(options.clobUrl ?? process.env.POLYMARKET_CLOB_URL ?? DEFAULT_CLOB_URL);
    this.#http = options.http ?? new HttpClient();
  }

  async searchCryptoMarkets(
    assets: readonly string[],
    options: SearchOptions = {},
  ): Promise<VenueMarket[]> {
    const maxPages = options.maxPagesPerAsset ?? 2;
    const limitPerType = options.limitPerType ?? 50;
    const markets = new Map<string, VenueMarket>();

    for (const asset of assets) {
      const query = searchTerm(asset);
      for (let page = 1; page <= maxPages; page += 1) {
        const url = new URL(`${this.#gammaUrl}/public-search`);
        url.searchParams.set("q", query);
        url.searchParams.set("events_status", "active");
        url.searchParams.set("limit_per_type", String(limitPerType));
        url.searchParams.set("page", String(page));
        url.searchParams.set("keep_closed_markets", "0");
        url.searchParams.set("search_profiles", "false");
        url.searchParams.set("search_tags", "false");

        const payload = await this.#http.getJson(url);
        if (!isRecord(payload)) throw new Error("Polymarket search response is not an object");
        for (const rawEvent of asArray(payload.events)) {
          if (!isRecord(rawEvent)) continue;
          for (const market of parseSearchEvent(rawEvent, this.#gammaUrl)) {
            if (market.status === "open") markets.set(market.marketId, market);
          }
        }

        const pagination = isRecord(payload.pagination) ? payload.pagination : {};
        if (pagination.hasMore !== true) break;
      }
    }

    return [...markets.values()];
  }

  async getMarket(marketId: string): Promise<VenueMarket> {
    const payload = await this.#http.getJson(`${this.#gammaUrl}/markets/${encodeURIComponent(marketId)}`);
    if (!isRecord(payload)) throw new Error(`Polymarket market ${marketId} is not an object`);
    return parseGammaMarket(payload, null, "", this.#gammaUrl);
  }

  async getEventMarketsBySlug(eventSlug: string): Promise<VenueMarket[]> {
    const payload = await this.#http.getJson(
      `${this.#gammaUrl}/events/slug/${encodeURIComponent(eventSlug)}`,
    );
    if (!isRecord(payload)) throw new Error(`Polymarket event ${eventSlug} is not an object`);
    const markets = parseSearchEvent(payload, this.#gammaUrl);
    if (markets.length === 0) throw new Error(`Polymarket event ${eventSlug} has no markets`);
    return markets;
  }

  async getResolvedOutcomeBySlug(eventSlug: string): Promise<"UP" | "DOWN" | null> {
    const payload = await this.#http.getJson(
      `${this.#gammaUrl}/events/slug/${encodeURIComponent(eventSlug)}`,
    );
    if (!isRecord(payload)) return null;
    const market = asArray(payload.markets).find(isRecord);
    if (!market || asBoolean(market.closed) !== true) return null;
    const outcomes = parseStringArray(market.outcomes).map((outcome) => outcome.trim().toUpperCase());
    const prices = parseNumberArray(market.outcomePrices);
    const winnerIndex = prices.findIndex((price) => price >= 0.999_999);
    const winner = outcomes[winnerIndex];
    return winner === "UP" || winner === "DOWN" ? winner : null;
  }

  async getResolvedOutcomeByMarketId(marketId: string): Promise<"UP" | "DOWN" | null> {
    const payload = await this.#http.getJson(`${this.#gammaUrl}/markets/${encodeURIComponent(marketId)}`);
    if (!isRecord(payload) || asBoolean(payload.closed) !== true) return null;
    const outcomes = parseStringArray(payload.outcomes).map((outcome) => outcome.trim().toUpperCase());
    const prices = parseNumberArray(payload.outcomePrices);
    const winnerIndex = prices.findIndex((price) => price >= 0.999_999);
    const winner = outcomes[winnerIndex];
    if (winner === "UP" || winner === "YES") return "UP";
    if (winner === "DOWN" || winner === "NO") return "DOWN";
    return null;
  }

  async getOrderBook(market: VenueMarket): Promise<BinaryOrderBook> {
    const [yesToken, noToken] = resolveYesNoTokens(market);
    const [yesPayload, noPayload] = await Promise.all([
      this.#http.getJson(`${this.#clobUrl}/book?token_id=${encodeURIComponent(yesToken)}`),
      this.#http.getJson(`${this.#clobUrl}/book?token_id=${encodeURIComponent(noToken)}`),
    ]);

    if (!isRecord(yesPayload) || !isRecord(noPayload)) {
      throw new Error(`Polymarket orderbook response for ${market.marketId} is malformed`);
    }
    if (asString(yesPayload.market) !== asString(noPayload.market)) {
      throw new Error(`YES/NO token books belong to different Polymarket conditions for ${market.marketId}`);
    }

    const yesTimestamp = parseTimestampMs(yesPayload.timestamp);
    const noTimestamp = parseTimestampMs(noPayload.timestamp);
    return {
      venue: "polymarket",
      provider: "polymarket",
      marketId: market.marketId,
      receivedAtMs: Date.now(),
      sourceTimestampMs: maxNullable(yesTimestamp, noTimestamp),
      yes: parseClobSide(yesPayload),
      no: parseClobSide(noPayload),
    };
  }
}

function parseSearchEvent(rawEvent: Record<string, unknown>, gammaUrl: string): VenueMarket[] {
  const eventId = asString(rawEvent.id) || null;
  const eventTitle = asString(rawEvent.title);
  return asArray(rawEvent.markets)
    .filter(isRecord)
    .map((market) => parseGammaMarket(market, eventId, eventTitle, gammaUrl));
}

function parseGammaMarket(
  raw: Record<string, unknown>,
  eventId: string | null,
  eventTitle: string,
  gammaUrl: string,
): VenueMarket {
  const marketId = asString(raw.id);
  if (!marketId) throw new Error("Polymarket market is missing id");
  const closed = asBoolean(raw.closed) ?? false;
  const active = asBoolean(raw.active) ?? !closed;
  const acceptingOrders = asBoolean(raw.acceptingOrders) ?? active;
  const event = asArray(raw.events).find(isRecord);
  const resolvedEventId = eventId ?? (event && asString(event.id) ? asString(event.id) : null);
  const resolvedEventTitle = eventTitle || (event ? asString(event.title) : "");
  const feeSchedule = parseFeeSchedule(raw.feeSchedule);

  return {
    venue: "polymarket",
    provider: "polymarket",
    eventId: resolvedEventId,
    marketId,
    title: asString(raw.question) || asString(raw.groupItemTitle),
    eventTitle: resolvedEventTitle,
    rulesPrimary: asString(raw.description),
    rulesSecondary: asString(raw.resolutionSource),
    status: !closed && active && acceptingOrders ? "open" : closed ? "closed" : "inactive",
    openTimeMs: parseIsoMs(raw.startDate),
    closeTimeMs: parseIsoMs(raw.endDate),
    clobTokenIds: parseStringArray(raw.clobTokenIds),
    outcomes: parseStringArray(raw.outcomes),
    pricing: parseGammaPricing(raw),
    ...(feeSchedule ? { feeSchedule } : {}),
    sourceUrl: `${gammaUrl}/markets/${marketId}`,
  };
}

function parseFeeSchedule(value: unknown): MarketFeeSchedule | null {
  if (!isRecord(value)) return null;
  const rawRate = value.rate;
  const exponent = asNumber(value.exponent);
  const takerOnly = asBoolean(value.takerOnly);
  if ((typeof rawRate !== "string" && typeof rawRate !== "number") || exponent === null || takerOnly === null) return null;
  return { rate: String(rawRate), exponent, takerOnly };
}

function parseGammaPricing(raw: Record<string, unknown>): MarketPricing {
  const bestBid = asNumber(raw.bestBid);
  const bestAsk = asNumber(raw.bestAsk);
  return {
    buyYesMicroUsd: bestAsk === null ? null : parseUsd(String(bestAsk)),
    sellYesMicroUsd: bestBid === null ? null : parseUsd(String(bestBid)),
    buyNoMicroUsd: bestBid === null ? null : 1_000_000n - parseUsd(String(bestBid)),
    sellNoMicroUsd: bestAsk === null ? null : 1_000_000n - parseUsd(String(bestAsk)),
  };
}

function parseClobSide(raw: Record<string, unknown>): { bids: BookLevel[]; asks: BookLevel[] } {
  return {
    bids: parseClobLevels(raw.bids).sort((a, b) => compareBigint(b.priceMicroUsd, a.priceMicroUsd)),
    asks: parseClobLevels(raw.asks).sort((a, b) => compareBigint(a.priceMicroUsd, b.priceMicroUsd)),
  };
}

function parseClobLevels(value: unknown): BookLevel[] {
  const levels: BookLevel[] = [];
  for (const raw of asArray(value)) {
    if (!isRecord(raw)) continue;
    const price = asString(raw.price);
    const size = asString(raw.size);
    if (!price || !size) continue;
    levels.push({ priceMicroUsd: parseUsd(price), contractsMicro: parseContracts(size) });
  }
  return levels;
}

export function resolveYesNoTokens(market: VenueMarket): readonly [string, string] {
  if (market.clobTokenIds.length !== 2) {
    throw new Error(`Polymarket market ${market.marketId} does not have exactly two CLOB tokens`);
  }
  const normalized = market.outcomes.map((outcome) => outcome.trim().toLowerCase());
  if (normalized.length === 0) {
    const [first, second] = market.clobTokenIds;
    if (!first || !second) throw new Error(`Missing CLOB token IDs for ${market.marketId}`);
    return [first, second];
  }
  const yesIndex = normalized.findIndex((outcome) => outcome === "yes" || outcome === "up");
  const noIndex = normalized.findIndex((outcome) => outcome === "no" || outcome === "down");
  const yes = market.clobTokenIds[yesIndex];
  const no = market.clobTokenIds[noIndex];
  if (yesIndex < 0 || noIndex < 0 || !yes || !no) {
    throw new Error(`Cannot map outcomes to CLOB token IDs for ${market.marketId}`);
  }
  return [yes, no];
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: unknown): number[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? parseJsonArray(value) : [];
  return source
    .map((item) => typeof item === "string" || typeof item === "number" ? Number(item) : Number.NaN)
    .filter(Number.isFinite);
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestampMs(value: unknown): number | null {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function searchTerm(asset: string): string {
  switch (asset.toUpperCase()) {
    case "BTC":
      return "bitcoin";
    case "ETH":
      return "ethereum";
    case "SOL":
      return "solana";
    case "XRP":
      return "xrp";
    default:
      return asset;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
