import { asNumber, asString, isRecord } from "../../domain/src/json.ts";

const DEFAULT_RTDS_URL = "wss://ws-live-data.polymarket.com";
const E18_TO_MICRO_DIVISOR = 1_000_000_000_000n;

export interface ChainlinkTwapObservation {
  symbol: string;
  observedAtMs: number;
  publishedAtMs: number | null;
  receivedAtMs: number;
  priceMicroUsd: bigint;
  fullAccuracyE18: string;
  windowSeconds: 60;
}

export interface ChainlinkTwapStreamOptions {
  signal: AbortSignal;
  symbol?: string;
  url?: string;
  heartbeatMs?: number;
  livenessTimeoutMs?: number;
  reconnectMaxMs?: number;
  onObservation: (observation: ChainlinkTwapObservation) => void | Promise<void>;
  onStatus?: (status: { status: "connecting" | "connected" | "disconnected" | "reconnecting"; message?: string }) => void | Promise<void>;
}

export interface ChainlinkSpotObservation {
  symbol: string;
  observedAtMs: number;
  publishedAtMs: number | null;
  receivedAtMs: number;
  priceMicroUsd: bigint;
  fullAccuracyE18: string | null;
}

export interface ChainlinkSpotStreamOptions {
  signal: AbortSignal;
  symbol?: string;
  url?: string;
  heartbeatMs?: number;
  livenessTimeoutMs?: number;
  reconnectMaxMs?: number;
  onObservation: (observation: ChainlinkSpotObservation) => void | Promise<void>;
  onStatus?: (status: { status: "connecting" | "connected" | "disconnected" | "reconnecting"; message?: string }) => void | Promise<void>;
}

export class ExactTwapAnchorStore {
  readonly #observations = new Map<number, ChainlinkTwapObservation>();
  readonly #retentionMs: number;

  constructor(retentionMs = 60 * 60 * 1_000) {
    this.#retentionMs = retentionMs;
  }

  add(observation: ChainlinkTwapObservation): void {
    this.#observations.set(observation.observedAtMs, observation);
    const oldestAllowed = observation.observedAtMs - this.#retentionMs;
    for (const timestamp of this.#observations.keys()) {
      if (timestamp < oldestAllowed) this.#observations.delete(timestamp);
    }
  }

  getExact(timestampMs: number): ChainlinkTwapObservation | null {
    return this.#observations.get(timestampMs) ?? null;
  }
}

export class ExactChainlinkSpotStore {
  readonly #observations = new Map<number, ChainlinkSpotObservation>();
  readonly #retentionMs: number;

  constructor(retentionMs = 60 * 60 * 1_000) {
    this.#retentionMs = retentionMs;
  }

  add(observation: ChainlinkSpotObservation): void {
    this.#observations.set(observation.observedAtMs, observation);
    const oldestAllowed = observation.observedAtMs - this.#retentionMs;
    for (const timestamp of this.#observations.keys()) {
      if (timestamp < oldestAllowed) this.#observations.delete(timestamp);
    }
  }

  getExact(timestampMs: number): ChainlinkSpotObservation | null {
    return this.#observations.get(timestampMs) ?? null;
  }
}

export function parseChainlinkTwapObservation(value: unknown, receivedAtMs = Date.now()): ChainlinkTwapObservation | null {
  if (!isRecord(value) || asString(value.topic) !== "crypto_prices_twap_sixty" || asString(value.type) !== "update") {
    return null;
  }
  const payload = isRecord(value.payload) ? value.payload : null;
  if (!payload || asNumber(payload.window_s) !== 60) return null;
  const symbol = asString(payload.symbol).toLowerCase();
  const observedAtMs = asNumber(payload.timestamp);
  const publishedAtMs = asNumber(value.timestamp);
  const fullAccuracyE18 = asString(payload.full_accuracy_value);
  if (!symbol || observedAtMs === null || !Number.isSafeInteger(observedAtMs) || !/^\d+$/.test(fullAccuracyE18)) return null;
  const e18 = BigInt(fullAccuracyE18);
  const priceMicroUsd = (e18 + E18_TO_MICRO_DIVISOR / 2n) / E18_TO_MICRO_DIVISOR;
  return {
    symbol,
    observedAtMs,
    publishedAtMs: publishedAtMs !== null && Number.isSafeInteger(publishedAtMs) ? publishedAtMs : null,
    receivedAtMs,
    priceMicroUsd,
    fullAccuracyE18,
    windowSeconds: 60,
  };
}

export function parseChainlinkSpotObservations(value: unknown, receivedAtMs = Date.now()): ChainlinkSpotObservation[] {
  if (!isRecord(value)) return [];
  const topic = asString(value.topic);
  const type = asString(value.type);
  const payload = isRecord(value.payload) ? value.payload : null;
  if (!payload) return [];

  if (topic === "crypto_prices_chainlink" && type === "update") {
    const observation = parseSpotPayload(payload, asNumber(value.timestamp), receivedAtMs);
    return observation ? [observation] : [];
  }

  // The public RTDS service returns a short historical snapshot with the
  // legacy crypto_prices topic after a crypto_prices_chainlink subscription.
  if (topic === "crypto_prices" && type === "subscribe" && Array.isArray(payload.data)) {
    const symbol = asString(payload.symbol).toLowerCase();
    if (!symbol) return [];
    const observations: ChainlinkSpotObservation[] = [];
    for (const item of payload.data) {
      if (!isRecord(item)) continue;
      const observedAtMs = asNumber(item.timestamp);
      const valueNumber = asNumber(item.value);
      if (observedAtMs === null || !Number.isSafeInteger(observedAtMs) || valueNumber === null) continue;
      observations.push({
        symbol,
        observedAtMs,
        publishedAtMs: null,
        receivedAtMs,
        priceMicroUsd: decimalNumberToMicroUsd(valueNumber),
        fullAccuracyE18: null,
      });
    }
    return observations;
  }
  return [];
}

function parseSpotPayload(
  payload: Record<string, unknown>,
  publishedAtMs: number | null,
  receivedAtMs: number,
): ChainlinkSpotObservation | null {
  const symbol = asString(payload.symbol).toLowerCase();
  const observedAtMs = asNumber(payload.timestamp);
  const fullAccuracyE18 = asString(payload.full_accuracy_value);
  if (!symbol || observedAtMs === null || !Number.isSafeInteger(observedAtMs)) return null;
  let priceMicroUsd: bigint;
  if (/^\d+$/.test(fullAccuracyE18)) {
    const e18 = BigInt(fullAccuracyE18);
    priceMicroUsd = (e18 + E18_TO_MICRO_DIVISOR / 2n) / E18_TO_MICRO_DIVISOR;
  } else {
    const valueNumber = asNumber(payload.value);
    if (valueNumber === null) return null;
    priceMicroUsd = decimalNumberToMicroUsd(valueNumber);
  }
  return {
    symbol,
    observedAtMs,
    publishedAtMs: publishedAtMs !== null && Number.isSafeInteger(publishedAtMs) ? publishedAtMs : null,
    receivedAtMs,
    priceMicroUsd,
    fullAccuracyE18: /^\d+$/.test(fullAccuracyE18) ? fullAccuracyE18 : null,
  };
}

function decimalNumberToMicroUsd(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid Chainlink price ${value}`);
  return BigInt(Math.round(value * 1_000_000));
}

export async function streamChainlinkTwap60(options: ChainlinkTwapStreamOptions): Promise<void> {
  const url = options.url ?? process.env.POLYMARKET_RTDS_URL ?? DEFAULT_RTDS_URL;
  const symbol = (options.symbol ?? "btc/usd").toLowerCase();
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const livenessTimeoutMs = options.livenessTimeoutMs ?? 6_000;
  const reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  let attempt = 0;

  while (!options.signal.aborted) {
    attempt += 1;
    await options.onStatus?.({ status: attempt === 1 ? "connecting" : "reconnecting" });
    try {
      await connectOnce(url, symbol, heartbeatMs, livenessTimeoutMs, options);
    } catch (error) {
      if (options.signal.aborted) break;
      await options.onStatus?.({ status: "disconnected", message: errorMessage(error) });
    }
    if (!options.signal.aborted) {
      await waitForAbort(Math.min(reconnectMaxMs, 500 * 2 ** Math.min(attempt - 1, 5)), options.signal);
    }
  }
}

export async function streamChainlinkSpot(options: ChainlinkSpotStreamOptions): Promise<void> {
  const url = options.url ?? process.env.POLYMARKET_RTDS_URL ?? DEFAULT_RTDS_URL;
  const symbol = (options.symbol ?? "btc/usd").toLowerCase();
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const livenessTimeoutMs = options.livenessTimeoutMs ?? 6_000;
  const reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  let attempt = 0;

  while (!options.signal.aborted) {
    attempt += 1;
    await options.onStatus?.({ status: attempt === 1 ? "connecting" : "reconnecting" });
    try {
      await connectSpotOnce(url, symbol, heartbeatMs, livenessTimeoutMs, options);
    } catch (error) {
      if (options.signal.aborted) break;
      await options.onStatus?.({ status: "disconnected", message: errorMessage(error) });
    }
    if (!options.signal.aborted) {
      await waitForAbort(Math.min(reconnectMaxMs, 500 * 2 ** Math.min(attempt - 1, 5)), options.signal);
    }
  }
}

async function connectSpotOnce(
  url: string,
  symbol: string,
  heartbeatMs: number,
  livenessTimeoutMs: number,
  options: ChainlinkSpotStreamOptions,
): Promise<void> {
  const socket = new WebSocket(url);
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let livenessCheck: ReturnType<typeof setInterval> | null = null;
  let lastValidObservationAtMs = Date.now();
  let delivery = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      if (livenessCheck) clearInterval(livenessCheck);
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
        action: "subscribe",
        subscriptions: [{
          topic: "crypto_prices_chainlink",
          type: "update",
          filters: JSON.stringify({ symbol }),
        }],
      }));
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, heartbeatMs);
      livenessCheck = setInterval(() => {
        const silenceMs = Date.now() - lastValidObservationAtMs;
        if (silenceMs <= livenessTimeoutMs) return;
        finish(new Error(`Polymarket Chainlink spot RTDS stale: no valid ${symbol} observation for ${silenceMs}ms`));
        socket.close(4001, "spot observation timeout");
      }, 1_000);
      delivery = delivery.then(() => options.onStatus?.({ status: "connected" }));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data === "PONG" || event.data === "") return;
      try {
        const observations = parseChainlinkSpotObservations(JSON.parse(event.data) as unknown, Date.now());
        for (const observation of observations) {
          if (observation.symbol === symbol) {
            lastValidObservationAtMs = Date.now();
            delivery = delivery.then(() => options.onObservation(observation));
          }
        }
      } catch {
        // A later valid update repairs a malformed public frame.
      }
    });
    socket.addEventListener("error", () => finish(new Error("Polymarket Chainlink RTDS WebSocket error")));
    socket.addEventListener("close", (event) => {
      if (options.signal.aborted || event.code === 1000) finish();
      else finish(new Error(`Polymarket Chainlink RTDS WebSocket closed (${event.code} ${event.reason})`));
    });
  });
}

async function connectOnce(
  url: string,
  symbol: string,
  heartbeatMs: number,
  livenessTimeoutMs: number,
  options: ChainlinkTwapStreamOptions,
): Promise<void> {
  const socket = new WebSocket(url);
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let livenessCheck: ReturnType<typeof setInterval> | null = null;
  let lastValidObservationAtMs = Date.now();
  let delivery = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      if (livenessCheck) clearInterval(livenessCheck);
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
        action: "subscribe",
        subscriptions: [{
          topic: "crypto_prices_twap_sixty",
          type: "update",
          filters: JSON.stringify({ symbol }),
        }],
      }));
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, heartbeatMs);
      livenessCheck = setInterval(() => {
        const silenceMs = Date.now() - lastValidObservationAtMs;
        if (silenceMs <= livenessTimeoutMs) return;
        finish(new Error(`Polymarket TWAP RTDS stale: no valid ${symbol} observation for ${silenceMs}ms`));
        socket.close(4001, "TWAP observation timeout");
      }, 1_000);
      delivery = delivery.then(() => options.onStatus?.({ status: "connected" }));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data === "PONG") return;
      try {
        const observation = parseChainlinkTwapObservation(JSON.parse(event.data) as unknown, Date.now());
        if (observation && observation.symbol === symbol) {
          lastValidObservationAtMs = Date.now();
          delivery = delivery.then(() => options.onObservation(observation));
        }
      } catch {
        // A later valid update repairs a malformed public frame.
      }
    });
    socket.addEventListener("error", () => finish(new Error("Polymarket RTDS WebSocket error")));
    socket.addEventListener("close", (event) => {
      if (options.signal.aborted || event.code === 1000) finish();
      else finish(new Error(`Polymarket RTDS WebSocket closed (${event.code} ${event.reason})`));
    });
  });
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
