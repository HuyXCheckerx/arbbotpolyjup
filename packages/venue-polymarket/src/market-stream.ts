import { parseContracts, parseUsd } from "../../domain/src/fixed.ts";
import { asArray, asString, isRecord } from "../../domain/src/json.ts";
import type { BinaryOrderBook, BookLevel, SideOrderBook, VenueMarket } from "../../domain/src/types.ts";
import { resolveYesNoTokens } from "./client.ts";

const DEFAULT_MARKET_WEBSOCKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface PolymarketStreamBookUpdate {
  book: BinaryOrderBook;
  eventType: "book" | "price_change";
}

export interface PolymarketStreamStatus {
  status: "connecting" | "connected" | "disconnected" | "reconnecting";
  atMs: number;
  attempt: number;
  message?: string;
}

export interface PolymarketStreamOptions {
  url?: string;
  signal: AbortSignal;
  onBook: (update: PolymarketStreamBookUpdate) => void | Promise<void>;
  onStatus?: (status: PolymarketStreamStatus) => void | Promise<void>;
  heartbeatMs?: number;
  reconnectMaxMs?: number;
}

export interface PolymarketMarketSetStreamOptions {
  url?: string;
  signal: AbortSignal;
  onBook: (market: VenueMarket, update: PolymarketStreamBookUpdate) => void | Promise<void>;
  onStatus?: (status: PolymarketStreamStatus) => void | Promise<void>;
  heartbeatMs?: number;
  reconnectMaxMs?: number;
}

interface MutableTokenBook {
  initialized: boolean;
  bids: Map<string, BookLevel>;
  asks: Map<string, BookLevel>;
  sourceTimestampMs: number | null;
}

export class PolymarketOrderBookState {
  readonly #market: VenueMarket;
  readonly #yesToken: string;
  readonly #noToken: string;
  readonly #tokenBooks = new Map<string, MutableTokenBook>();
  #lastTopSignature = "";

  constructor(market: VenueMarket) {
    this.#market = market;
    [this.#yesToken, this.#noToken] = resolveYesNoTokens(market);
    this.#tokenBooks.set(this.#yesToken, emptyTokenBook());
    this.#tokenBooks.set(this.#noToken, emptyTokenBook());
  }

  applyPayload(payload: unknown, receivedAtMs = Date.now()): PolymarketStreamBookUpdate | null {
    let eventType: PolymarketStreamBookUpdate["eventType"] | null = null;
    for (const message of Array.isArray(payload) ? payload : [payload]) {
      if (!isRecord(message)) continue;
      const currentEventType = asString(message.event_type);
      if (currentEventType === "book" && this.#applySnapshot(message)) eventType = "book";
      if (currentEventType === "price_change" && this.#applyPriceChanges(message)) eventType = "price_change";
    }
    if (!eventType) return null;

    const yes = this.#tokenBooks.get(this.#yesToken);
    const no = this.#tokenBooks.get(this.#noToken);
    if (!yes?.initialized || !no?.initialized) return null;
    const book = this.#buildBook(yes, no, receivedAtMs);
    const signature = topSignature(book);
    if (signature === this.#lastTopSignature) return null;
    this.#lastTopSignature = signature;
    return { book, eventType };
  }

  #applySnapshot(message: Record<string, unknown>): boolean {
    const tokenBook = this.#tokenBooks.get(asString(message.asset_id));
    if (!tokenBook) return false;
    tokenBook.bids = parseLevels(message.bids);
    tokenBook.asks = parseLevels(message.asks);
    tokenBook.sourceTimestampMs = parseTimestampMs(message.timestamp);
    tokenBook.initialized = true;
    return true;
  }

  #applyPriceChanges(message: Record<string, unknown>): boolean {
    let changed = false;
    const timestampMs = parseTimestampMs(message.timestamp);
    for (const rawChange of asArray(message.price_changes)) {
      if (!isRecord(rawChange)) continue;
      const tokenBook = this.#tokenBooks.get(asString(rawChange.asset_id));
      if (!tokenBook?.initialized) continue;
      const side = asString(rawChange.side).toUpperCase();
      const price = asString(rawChange.price);
      const size = asString(rawChange.size);
      if (!price || !size || (side !== "BUY" && side !== "SELL")) continue;
      const level: BookLevel = {
        priceMicroUsd: parseUsd(price),
        contractsMicro: parseContracts(size),
      };
      const levels = side === "BUY" ? tokenBook.bids : tokenBook.asks;
      const key = level.priceMicroUsd.toString();
      if (level.contractsMicro === 0n) levels.delete(key);
      else levels.set(key, level);
      tokenBook.sourceTimestampMs = timestampMs ?? tokenBook.sourceTimestampMs;
      changed = true;
    }
    return changed;
  }

  #buildBook(yes: MutableTokenBook, no: MutableTokenBook, receivedAtMs: number): BinaryOrderBook {
    return {
      venue: "polymarket",
      provider: "polymarket",
      marketId: this.#market.marketId,
      receivedAtMs,
      sourceTimestampMs: maxNullable(yes.sourceTimestampMs, no.sourceTimestampMs),
      yes: freezeBook(yes),
      no: freezeBook(no),
    };
  }
}

export async function streamPolymarketOrderBooks(
  market: VenueMarket,
  options: PolymarketStreamOptions,
): Promise<void> {
  const url = options.url ?? process.env.POLYMARKET_MARKET_WS_URL ?? DEFAULT_MARKET_WEBSOCKET_URL;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  let attempt = 0;

  while (!options.signal.aborted) {
    attempt += 1;
    await options.onStatus?.({
      status: attempt === 1 ? "connecting" : "reconnecting",
      atMs: Date.now(),
      attempt,
    });
    try {
      await connectOnce(market, url, heartbeatMs, attempt, options);
    } catch (error) {
      if (options.signal.aborted) break;
      await options.onStatus?.({
        status: "disconnected",
        atMs: Date.now(),
        attempt,
        message: errorMessage(error),
      });
    }
    if (!options.signal.aborted) {
      await waitForAbort(Math.min(reconnectMaxMs, 500 * 2 ** Math.min(attempt - 1, 5)), options.signal);
    }
  }
}

export async function streamPolymarketOrderBookSet(
  markets: readonly VenueMarket[],
  options: PolymarketMarketSetStreamOptions,
): Promise<void> {
  if (markets.length === 0) return;
  const url = options.url ?? process.env.POLYMARKET_MARKET_WS_URL ?? DEFAULT_MARKET_WEBSOCKET_URL;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  let attempt = 0;
  while (!options.signal.aborted) {
    attempt += 1;
    await options.onStatus?.({
      status: attempt === 1 ? "connecting" : "reconnecting",
      atMs: Date.now(),
      attempt,
    });
    try {
      await connectSetOnce(markets, url, heartbeatMs, attempt, options);
    } catch (error) {
      if (options.signal.aborted) break;
      await options.onStatus?.({
        status: "disconnected",
        atMs: Date.now(),
        attempt,
        message: errorMessage(error),
      });
    }
    if (!options.signal.aborted) {
      await waitForAbort(Math.min(reconnectMaxMs, 500 * 2 ** Math.min(attempt - 1, 5)), options.signal);
    }
  }
}

async function connectOnce(
  market: VenueMarket,
  url: string,
  heartbeatMs: number,
  attempt: number,
  options: PolymarketStreamOptions,
): Promise<void> {
  const state = new PolymarketOrderBookState(market);
  const [yesToken, noToken] = resolveYesNoTokens(market);
  const socket = new WebSocket(url);
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let delivery = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      options.signal.removeEventListener("abort", onAbort);
      void delivery.then(() => error ? reject(error) : resolve());
    };
    const onAbort = (): void => {
      socket.close(1000, "monitor stopped");
      finish();
    };

    options.signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        assets_ids: [yesToken, noToken],
        type: "market",
        custom_feature_enabled: true,
      }));
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, heartbeatMs);
      delivery = delivery.then(() => options.onStatus?.({
        status: "connected",
        atMs: Date.now(),
        attempt,
      }));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data === "PONG") return;
      try {
        const update = state.applyPayload(JSON.parse(event.data) as unknown, Date.now());
        if (update) delivery = delivery.then(() => options.onBook(update));
      } catch (error) {
        delivery = delivery.then(() => options.onStatus?.({
          status: "disconnected",
          atMs: Date.now(),
          attempt,
          message: `ignored malformed WebSocket message: ${errorMessage(error)}`,
        }));
      }
    });
    socket.addEventListener("error", () => finish(new Error("Polymarket market WebSocket error")));
    socket.addEventListener("close", (event) => {
      if (options.signal.aborted || event.code === 1000) finish();
      else finish(new Error(`Polymarket market WebSocket closed (${event.code} ${event.reason})`));
    });
  });
}

async function connectSetOnce(
  markets: readonly VenueMarket[],
  url: string,
  heartbeatMs: number,
  attempt: number,
  options: PolymarketMarketSetStreamOptions,
): Promise<void> {
  const states = markets.map((market) => ({ market, state: new PolymarketOrderBookState(market) }));
  const assetIds = [...new Set(markets.flatMap((market) => resolveYesNoTokens(market)))];
  const socket = new WebSocket(url);
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let delivery = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      options.signal.removeEventListener("abort", onAbort);
      void delivery.then(() => error ? reject(error) : resolve());
    };
    const onAbort = (): void => {
      socket.close(1000, "monitor stopped");
      finish();
    };

    options.signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        assets_ids: assetIds,
        type: "market",
        custom_feature_enabled: true,
      }));
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, heartbeatMs);
      delivery = delivery.then(() => options.onStatus?.({
        status: "connected",
        atMs: Date.now(),
        attempt,
      }));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data === "PONG") return;
      try {
        const payload = JSON.parse(event.data) as unknown;
        const receivedAtMs = Date.now();
        for (const { market, state } of states) {
          const update = state.applyPayload(payload, receivedAtMs);
          if (update) delivery = delivery.then(() => options.onBook(market, update));
        }
      } catch (error) {
        delivery = delivery.then(() => options.onStatus?.({
          status: "disconnected",
          atMs: Date.now(),
          attempt,
          message: `ignored malformed WebSocket message: ${errorMessage(error)}`,
        }));
      }
    });
    socket.addEventListener("error", () => finish(new Error("Polymarket market-set WebSocket error")));
    socket.addEventListener("close", (event) => {
      if (options.signal.aborted || event.code === 1000) finish();
      else finish(new Error(`Polymarket market-set WebSocket closed (${event.code} ${event.reason})`));
    });
  });
}

function emptyTokenBook(): MutableTokenBook {
  return { initialized: false, bids: new Map(), asks: new Map(), sourceTimestampMs: null };
}

function parseLevels(value: unknown): Map<string, BookLevel> {
  const levels = new Map<string, BookLevel>();
  for (const raw of asArray(value)) {
    if (!isRecord(raw)) continue;
    const price = asString(raw.price);
    const size = asString(raw.size);
    if (!price || !size) continue;
    const level = { priceMicroUsd: parseUsd(price), contractsMicro: parseContracts(size) };
    if (level.contractsMicro > 0n) levels.set(level.priceMicroUsd.toString(), level);
  }
  return levels;
}

function freezeBook(book: MutableTokenBook): SideOrderBook {
  return {
    bids: [...book.bids.values()].sort((a, b) => compareBigint(b.priceMicroUsd, a.priceMicroUsd)),
    asks: [...book.asks.values()].sort((a, b) => compareBigint(a.priceMicroUsd, b.priceMicroUsd)),
  };
}

function topSignature(book: BinaryOrderBook): string {
  return [book.yes.bids[0], book.yes.asks[0], book.no.bids[0], book.no.asks[0]]
    .map((level) => level ? `${level.priceMicroUsd}:${level.contractsMicro}` : "missing")
    .join("|");
}

function parseTimestampMs(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function waitForAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
