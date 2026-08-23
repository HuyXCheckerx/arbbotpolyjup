import { ONE_USD_MICRO } from "../../domain/src/fixed.ts";
import { asNumber, asString, isRecord } from "../../domain/src/json.ts";

const DEFAULT_PRICE_WEBSOCKET_URL = "wss://prediction-market-price-service.fly.dev/ws/prices";

export interface JupiterPredictionPriceUpdate {
  marketId: string;
  sourceTimestampMs: number;
  receivedAtMs: number;
  yesBidMicroUsd: bigint;
  yesAskMicroUsd: bigint;
  noBidMicroUsd: bigint;
  noAskMicroUsd: bigint;
}

export interface JupiterPredictionPriceStreamStatus {
  status: "connecting" | "connected" | "disconnected" | "reconnecting";
  atMs: number;
  attempt: number;
  retryInMs?: number;
  message?: string;
}

export interface JupiterPredictionPriceStreamOptions {
  url?: string;
  signal: AbortSignal;
  onPrice: (update: JupiterPredictionPriceUpdate) => void | Promise<void>;
  onStatus?: (status: JupiterPredictionPriceStreamStatus) => void | Promise<void>;
  livenessTimeoutMs?: number;
  reconnectMaxMs?: number;
}

/**
 * Streams the same prediction top-of-book prices used by Jupiter's public
 * Degen UI. This service is deliberately separate from authenticated Swap V2
 * order construction, so observing a market never consumes an `/order` call.
 */
export async function streamJupiterPredictionPrices(
  marketIds: readonly string[],
  options: JupiterPredictionPriceStreamOptions,
): Promise<void> {
  const uniqueMarketIds = [...new Set(marketIds.filter(Boolean))];
  if (uniqueMarketIds.length === 0) throw new Error("Jupiter price stream requires at least one market ID");
  const url = options.url ?? process.env.JUPITER_PREDICTION_PRICE_WEBSOCKET_URL ?? DEFAULT_PRICE_WEBSOCKET_URL;
  const livenessTimeoutMs = options.livenessTimeoutMs ?? 30_000;
  const reconnectMaxMs = options.reconnectMaxMs ?? 15_000;
  let attempt = 0;

  while (!options.signal.aborted) {
    attempt += 1;
    await options.onStatus?.({
      status: attempt === 1 ? "connecting" : "reconnecting",
      atMs: Date.now(),
      attempt,
    });
    try {
      await connectOnce(uniqueMarketIds, url, livenessTimeoutMs, attempt, options);
    } catch (error) {
      if (options.signal.aborted) break;
      const retryInMs = Math.min(reconnectMaxMs, 500 * 2 ** Math.min(attempt - 1, 5));
      await options.onStatus?.({
        status: "disconnected",
        atMs: Date.now(),
        attempt,
        retryInMs,
        message: errorMessage(error),
      });
      await waitForAbort(retryInMs, options.signal);
    }
  }
}

export function parseJupiterPredictionPriceUpdate(
  payload: unknown,
  expectedMarketIds: ReadonlySet<string>,
  receivedAtMs = Date.now(),
): JupiterPredictionPriceUpdate | null {
  if (!isRecord(payload) || asString(payload.type) !== "price") return null;
  const marketId = asString(payload.ticker);
  if (!marketId || !expectedMarketIds.has(marketId)) return null;
  const sourceTimestampMs = asNumber(payload.ts);
  if (sourceTimestampMs === null || sourceTimestampMs <= 0) {
    throw new Error(`Jupiter price update for ${marketId} has an invalid timestamp`);
  }
  return {
    marketId,
    sourceTimestampMs,
    receivedAtMs,
    yesBidMicroUsd: parsePrice(payload.yesBidUsd, marketId, "yesBidUsd"),
    yesAskMicroUsd: parsePrice(payload.yesAskUsd, marketId, "yesAskUsd"),
    noBidMicroUsd: parsePrice(payload.noBidUsd, marketId, "noBidUsd"),
    noAskMicroUsd: parsePrice(payload.noAskUsd, marketId, "noAskUsd"),
  };
}

async function connectOnce(
  marketIds: readonly string[],
  url: string,
  livenessTimeoutMs: number,
  attempt: number,
  options: JupiterPredictionPriceStreamOptions,
): Promise<void> {
  const expectedMarketIds = new Set(marketIds);
  const socket = new WebSocket(url);
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let lastMessageAtMs = Date.now();
  let delivery = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (livenessTimer) clearInterval(livenessTimer);
      options.signal.removeEventListener("abort", onAbort);
      void delivery.then(() => error ? reject(error) : resolve());
    };
    const onAbort = (): void => {
      socket.close(1_000, "monitor stopped");
      finish();
    };

    options.signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", marketIds }));
      lastMessageAtMs = Date.now();
      livenessTimer = setInterval(() => {
        const silentForMs = Date.now() - lastMessageAtMs;
        if (silentForMs <= livenessTimeoutMs) return;
        socket.close(4_000, "stale price stream");
        finish(new Error(`Jupiter prediction price WebSocket stale for ${silentForMs}ms`));
      }, Math.max(1_000, Math.min(10_000, Math.floor(livenessTimeoutMs / 3))));
      delivery = delivery.then(() => options.onStatus?.({
        status: "connected",
        atMs: Date.now(),
        attempt,
      }));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      lastMessageAtMs = Date.now();
      try {
        const payload = JSON.parse(event.data) as unknown;
        if (isRecord(payload) && asString(payload.type) === "error") {
          finish(new Error(`Jupiter prediction price WebSocket error: ${asString(payload.message, "unknown error")}`));
          return;
        }
        const update = parseJupiterPredictionPriceUpdate(payload, expectedMarketIds, lastMessageAtMs);
        if (update) delivery = delivery.then(() => options.onPrice(update));
      } catch (error) {
        finish(new Error(`Jupiter prediction price WebSocket sent malformed data: ${errorMessage(error)}`));
      }
    });
    socket.addEventListener("error", () => finish(new Error("Jupiter prediction price WebSocket error")));
    socket.addEventListener("close", (event) => {
      if (options.signal.aborted || event.code === 1_000) finish();
      else finish(new Error(`Jupiter prediction price WebSocket closed (${event.code} ${event.reason})`));
    });
  });
}

function parsePrice(value: unknown, marketId: string, field: string): bigint {
  const raw = asString(value);
  const numeric = asNumber(value);
  const price = /^\d+$/.test(raw)
    ? BigInt(raw)
    : numeric !== null && Number.isSafeInteger(numeric)
      ? BigInt(numeric)
      : null;
  if (price === null) throw new Error(`Jupiter price update for ${marketId} has invalid ${field}`);
  if (price < 0n || price > ONE_USD_MICRO) {
    throw new Error(`Jupiter price update for ${marketId} has out-of-range ${field}`);
  }
  return price;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
