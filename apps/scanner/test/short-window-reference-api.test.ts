import assert from "node:assert/strict";
import test from "node:test";

import { HttpClient } from "../../../packages/domain/src/http.ts";
import {
  fetchJupiterForecastOpeningReference,
  fetchPolymarketOpeningReference,
} from "../src/short-window-reference-api.ts";

test("requests Polymarket's exact TWAP 60s price to beat", async () => {
  let requestedUrl = "";
  let requestedReferer = "";
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedReferer = new Headers(init?.headers).get("referer") ?? "";
      return jsonResponse({
        openPrice: 77_417.64932789918,
        closePrice: 77_478.93424728613,
        completed: true,
        incomplete: false,
      });
    },
  });

  const reference = await fetchPolymarketOpeningReference({
    http,
    duration: "5m",
    startMs: 1_787_343_600_000,
    endMs: 1_787_343_900_000,
    endpointUrl: "https://polymarket.example.test/api/crypto/crypto-price",
  });

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("symbol"), "BTC");
  assert.equal(url.searchParams.get("eventStartTime"), "2026-08-21T20:20:00Z");
  assert.equal(url.searchParams.get("endDate"), "2026-08-21T20:25:00Z");
  assert.equal(url.searchParams.get("variant"), "fiveminute");
  assert.equal(url.searchParams.get("twapEnabled"), "true");
  assert.equal(url.searchParams.get("twapLookbackSeconds"), "60");
  assert.equal(requestedReferer, "https://polymarket.com/event/btc-updown-5m-1787343600");
  assert.equal(reference.priceMicroUsd, 77_417_649_327n);
  assert.equal(reference.boundaryMs, 1_787_343_600_000);
  assert.equal(reference.observedAtMs, 1_787_343_600_000);
});

test("accepts an active Polymarket round when only the closing TWAP is incomplete", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({ openPrice: 77_417.65, incomplete: true }),
  });

  const reference = await fetchPolymarketOpeningReference({
    http,
    duration: "15m",
    startMs: 1_787_343_300_000,
    endMs: 1_787_344_200_000,
    endpointUrl: "https://polymarket.example.test/api/crypto/crypto-price",
  });

  assert.equal(reference.priceMicroUsd, 77_417_650_000n);
});

test("backfills Jupiter Forecast's exact website price-to-beat reference", async () => {
  let requestedUrl = "";
  let requestedReferer = "";
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedReferer = new Headers(init?.headers).get("referer") ?? "";
      return jsonResponse({
        symbol: "btcusdt",
        timestamp: 1_787_343_300_000,
        value: 77_250.64807148575,
      });
    },
  });

  const reference = await fetchJupiterForecastOpeningReference({
    http,
    eventId: "BISON-round-1",
    startMs: 1_787_343_300_000,
    baseUrl: "https://price.example.test",
  });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/price/crypto/btcusdt");
  assert.equal(url.searchParams.get("timestamp"), "1787343300");
  assert.equal(url.searchParams.get("eventId"), "BISON-round-1");
  assert.equal(requestedReferer, "https://jup.ag/prediction");
  assert.equal(reference.priceMicroUsd, 77_250_648_071n);
  assert.equal(reference.boundaryMs, 1_787_343_300_000);
  assert.equal(reference.observedAtMs, 1_787_343_300_000);
});

test("rejects a Jupiter website reference from a different timestamp", async () => {
  const http = new HttpClient({
    retries: 0,
    fetchImpl: async () => jsonResponse({
      symbol: "btcusdt",
      timestamp: 1_787_343_301_000,
      value: 77_250.65,
    }),
  });

  await assert.rejects(
    fetchJupiterForecastOpeningReference({
      http,
      eventId: "BISON-round-1",
      startMs: 1_787_343_300_000,
      baseUrl: "https://price.example.test",
    }),
    /timestamp mismatch/,
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
