import assert from "node:assert/strict";
import test from "node:test";

import {
  ExactChainlinkSpotStore,
  ExactTwapAnchorStore,
  parseChainlinkSpotObservations,
  parseChainlinkTwapObservation,
  streamChainlinkTwap60,
} from "../src/chainlink-twap-stream.ts";

test("parses exact E18 Chainlink TWAP updates into micro-dollars", () => {
  const observation = parseChainlinkTwapObservation({
    topic: "crypto_prices_twap_sixty",
    type: "update",
    timestamp: 1_787_303_375_385,
    payload: {
      symbol: "btc/usd",
      timestamp: 1_787_303_374_000,
      full_accuracy_value: "77708420490657494204416",
      window_s: 60,
    },
  }, 1_787_303_375_500);

  assert.equal(observation?.priceMicroUsd, 77_708_420_491n);
  assert.equal(observation?.observedAtMs, 1_787_303_374_000);
  assert.equal(observation?.windowSeconds, 60);
});

test("stores only exact observation timestamps as reference anchors", () => {
  const store = new ExactTwapAnchorStore();
  const observation = parseChainlinkTwapObservation({
    topic: "crypto_prices_twap_sixty",
    type: "update",
    timestamp: 1_100,
    payload: { symbol: "btc/usd", timestamp: 1_000, full_accuracy_value: "72000000000000000000000", window_s: 60 },
  }, 1_200);
  assert.ok(observation);
  store.add(observation);
  assert.equal(store.getExact(1_000)?.priceMicroUsd, 72_000_000_000n);
  assert.equal(store.getExact(2_000), null);
});

test("parses live and historical Chainlink spot observations", () => {
  const live = parseChainlinkSpotObservations({
    topic: "crypto_prices_chainlink",
    type: "update",
    timestamp: 1_787_304_923_965,
    payload: {
      symbol: "btc/usd",
      timestamp: 1_787_304_923_000,
      value: 77_876.38410841984,
      full_accuracy_value: "77876384108419835000000",
    },
  }, 1_787_304_924_000);
  assert.equal(live[0]?.priceMicroUsd, 77_876_384_108n);

  const historical = parseChainlinkSpotObservations({
    topic: "crypto_prices",
    type: "subscribe",
    payload: {
      symbol: "btc/usd",
      data: [{ timestamp: 1_787_304_900_000, value: 77_890.37846771984 }],
    },
  }, 1_787_304_924_000);
  assert.equal(historical[0]?.priceMicroUsd, 77_890_378_468n);

  const store = new ExactChainlinkSpotStore();
  assert.ok(live[0]);
  store.add(live[0]);
  assert.equal(store.getExact(1_787_304_923_000)?.priceMicroUsd, 77_876_384_108n);
  assert.equal(store.getExact(1_787_304_922_000), null);
});

test("reconnects a TWAP socket that stays open without valid observations", async () => {
  const originalWebSocket = globalThis.WebSocket;
  let connections = 0;
  const statuses: string[] = [];

  class SilentWebSocket {
    static readonly OPEN = 1;
    readonly OPEN = 1;
    readyState = SilentWebSocket.OPEN;
    readonly #listeners = new Map<string, Array<(event: never) => void>>();

    constructor() {
      connections += 1;
      queueMicrotask(() => this.#emit("open", {}));
    }

    addEventListener(type: string, listener: (event: never) => void): void {
      const listeners = this.#listeners.get(type) ?? [];
      listeners.push(listener);
      this.#listeners.set(type, listeners);
    }

    send(): void {}

    close(code = 1_000, reason = ""): void {
      this.readyState = 3;
      this.#emit("close", { code, reason });
    }

    #emit(type: string, event: object): void {
      for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
    }
  }

  globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket;
  const controller = new AbortController();
  try {
    await streamChainlinkTwap60({
      signal: controller.signal,
      heartbeatMs: 25,
      livenessTimeoutMs: 50,
      reconnectMaxMs: 10,
      onObservation: () => undefined,
      onStatus: (status) => {
        statuses.push(`${status.status}:${status.message ?? ""}`);
        if (status.status === "disconnected" && status.message?.includes("stale")) controller.abort();
      },
    });
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }

  assert.equal(connections, 1);
  assert.ok(statuses.some((status) => status.includes("disconnected:Polymarket TWAP RTDS stale")));
});
