import { parseFixed } from "../../../packages/domain/src/fixed.ts";
import type { HttpClient } from "../../../packages/domain/src/http.ts";
import { isRecord } from "../../../packages/domain/src/json.ts";

const DEFAULT_JUPITER_FORECAST_PRICE_URL = "https://prediction-market-price-service.fly.dev";
const DEFAULT_POLYMARKET_REFERENCE_URL = "https://polymarket.com/api/crypto/crypto-price";

export interface PolymarketOpeningReference {
  priceMicroUsd: bigint;
  source: "polymarket_crypto_price_api";
  boundaryMs: number;
  observedAtMs: number;
  receivedAtMs: number;
}

export interface JupiterForecastOpeningReference {
  priceMicroUsd: bigint;
  source: "jupiter_forecast_price_service";
  boundaryMs: number;
  observedAtMs: number;
  receivedAtMs: number;
}

export async function fetchPolymarketOpeningReference(input: {
  http: HttpClient;
  duration: "5m" | "15m";
  startMs: number;
  endMs: number;
  endpointUrl?: string;
}): Promise<PolymarketOpeningReference> {
  const endpointUrl = input.endpointUrl ?? process.env.POLYMARKET_REFERENCE_URL ??
    DEFAULT_POLYMARKET_REFERENCE_URL;
  const url = new URL(endpointUrl);
  url.searchParams.set("symbol", "BTC");
  url.searchParams.set("eventStartTime", isoSeconds(input.startMs));
  url.searchParams.set("variant", input.duration === "5m" ? "fiveminute" : "fifteen");
  url.searchParams.set("endDate", isoSeconds(input.endMs));
  // Polymarket's short-window markets resolve against the BTC/USD TWAP 60s
  // stream. Without these two parameters this endpoint returns a spot price,
  // which can look valid while disagreeing with the Price To Beat on the page.
  url.searchParams.set("twapEnabled", "true");
  url.searchParams.set("twapLookbackSeconds", "60");
  const payload = await input.http.getJson(url, {
    referer: `https://polymarket.com/event/btc-updown-${input.duration}-${input.startMs / 1_000}`,
  });
  if (!isRecord(payload)) throw new Error("Polymarket price-to-beat response is not an object");
  const rawOpenPrice = payload.openPrice;
  if ((typeof rawOpenPrice !== "string" && typeof rawOpenPrice !== "number") ||
    String(rawOpenPrice).trim() === "" || !Number.isFinite(Number(rawOpenPrice)) || Number(rawOpenPrice) <= 0) {
    throw new Error("Polymarket price-to-beat response has no valid openPrice");
  }
  return {
    priceMicroUsd: parseFixed(String(rawOpenPrice), 6, "down"),
    source: "polymarket_crypto_price_api",
    boundaryMs: input.startMs,
    observedAtMs: input.startMs,
    receivedAtMs: Date.now(),
  };
}

export async function fetchJupiterForecastOpeningReference(input: {
  http: HttpClient;
  eventId: string;
  startMs: number;
  baseUrl?: string;
}): Promise<JupiterForecastOpeningReference> {
  const baseUrl = (input.baseUrl ?? process.env.JUPITER_FORECAST_PRICE_URL ??
    DEFAULT_JUPITER_FORECAST_PRICE_URL).replace(/\/$/, "");
  const url = new URL(`${baseUrl}/price/crypto/btcusdt`);
  url.searchParams.set("timestamp", String(input.startMs / 1_000));
  url.searchParams.set("eventId", input.eventId);
  const payload = await input.http.getJson(url, {
    referer: "https://jup.ag/prediction",
  });
  if (!isRecord(payload)) throw new Error("Jupiter Forecast price-to-beat response is not an object");
  if (String(payload.symbol).toLowerCase() !== "btcusdt") {
    throw new Error("Jupiter Forecast price-to-beat response has an unexpected symbol");
  }
  const timestampMs = parseExactInteger(payload.timestamp);
  if (timestampMs !== input.startMs) {
    throw new Error(
      `Jupiter Forecast price timestamp mismatch: expected ${input.startMs}, received ${timestampMs ?? "missing"}`,
    );
  }
  const rawValue = payload.value;
  if ((typeof rawValue !== "string" && typeof rawValue !== "number") ||
    String(rawValue).trim() === "" || !Number.isFinite(Number(rawValue)) || Number(rawValue) <= 0) {
    throw new Error("Jupiter Forecast price-to-beat response has no valid value");
  }
  return {
    priceMicroUsd: parseFixed(String(rawValue), 6, "down"),
    source: "jupiter_forecast_price_service",
    boundaryMs: input.startMs,
    observedAtMs: timestampMs,
    receivedAtMs: Date.now(),
  };
}

function parseExactInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function isoSeconds(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace(".000Z", "Z");
}
