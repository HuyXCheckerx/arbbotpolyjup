import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpClient,
  HttpError,
  parseRateLimitDelayMs,
  parseRateLimitResetTimestampMs,
} from "../src/http.ts";

test("parseRateLimitResetTimestampMs extracts Unix timestamp in seconds and converts to milliseconds", () => {
  const resetSeconds = 1724400123;
  const headers = new Headers({
    "x-ratelimit-reset": String(resetSeconds),
  });
  const result = parseRateLimitResetTimestampMs(headers);
  assert.equal(result, 1724400123000);
});

test("parseRateLimitResetTimestampMs handles plain Record<string, string>", () => {
  const resetSeconds = 1724400500;
  const headers = { "x-ratelimit-reset": String(resetSeconds) };
  const result = parseRateLimitResetTimestampMs(headers);
  assert.equal(result, 1724400500000);
});

test("parseRateLimitDelayMs computes exact duration by subtracting nowMs", () => {
  const nowMs = 1724400000000;
  const resetSeconds = 1724400005; // 5 seconds in future
  const headers = new Headers({
    "x-ratelimit-reset": String(resetSeconds),
  });
  const delayMs = parseRateLimitDelayMs(headers, nowMs);
  assert.equal(delayMs, 5000);
});

test("parseRateLimitDelayMs falls back to retry-after in seconds", () => {
  const nowMs = 1724400000000;
  const headers = new Headers({
    "retry-after": "3",
  });
  const delayMs = parseRateLimitDelayMs(headers, nowMs);
  assert.equal(delayMs, 3000);
});

test("HttpError captures status, headers, rateLimitResetMs, and retryDelayMs", () => {
  const resetSeconds = Math.floor(Date.now() / 1000) + 10;
  const headers = new Headers({
    "x-ratelimit-reset": String(resetSeconds),
  });
  const error = new HttpError("https://api.jup.ag/swap/v2/order", 429, '{"message":"Too many requests"}', headers);
  assert.equal(error.status, 429);
  assert.equal(error.rateLimitResetMs, resetSeconds * 1000);
  assert.ok(error.retryDelayMs !== null && error.retryDelayMs > 0 && error.retryDelayMs <= 10000);
});

test("HttpClient retries using rate limit reset duration on 429", async () => {
  let callCount = 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetSeconds = nowSeconds + 1; // 1s in future

  const mockFetch: typeof fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response('{"code":429,"message":"Too many requests"}', {
        status: 429,
        headers: {
          "x-ratelimit-reset": String(resetSeconds),
        },
      });
    }
    return new Response('{"success":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new HttpClient({
    retries: 2,
    fetchImpl: mockFetch,
  });

  const startTime = Date.now();
  const res = (await client.getJson("https://api.jup.ag/swap/v2/order")) as { success: boolean };
  const duration = Date.now() - startTime;

  assert.equal(callCount, 2);
  assert.equal(res.success, true);
  assert.ok(duration >= 50, `Expected duration >= 50ms, got ${duration}ms`);
});
