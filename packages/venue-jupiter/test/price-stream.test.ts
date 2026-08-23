import assert from "node:assert/strict";
import test from "node:test";

import {
  parseJupiterPredictionPriceUpdate,
  streamJupiterPredictionPrices,
} from "../src/price-stream.ts";

test("parses Jupiter Degen top prices as exact micro-USD integers", () => {
  const update = parseJupiterPredictionPriceUpdate({
    type: "price",
    ticker: "BISON-event-DOWN",
    ts: 1_787_474_401_445,
    yesBidUsd: 628,
    yesAskUsd: 32_542,
    noBidUsd: 0,
    noAskUsd: 0,
  }, new Set(["BISON-event-DOWN"]), 1_787_474_401_500);

  assert.deepEqual(update, {
    marketId: "BISON-event-DOWN",
    sourceTimestampMs: 1_787_474_401_445,
    receivedAtMs: 1_787_474_401_500,
    yesBidMicroUsd: 628n,
    yesAskMicroUsd: 32_542n,
    noBidMicroUsd: 0n,
    noAskMicroUsd: 0n,
  });
  assert.equal(parseJupiterPredictionPriceUpdate({
    type: "price",
    ticker: "another-market",
    ts: 1,
    yesBidUsd: 1,
    yesAskUsd: 2,
    noBidUsd: 3,
    noAskUsd: 4,
  }, new Set(["BISON-event-DOWN"])), null);
});

test("subscribes to all selected market IDs on one public price socket", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sent: string[] = [];
  const controller = new AbortController();

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly OPEN = 1;
    readyState = 0;
    readonly #listeners = new Map<string, Array<(event: never) => void>>();

    constructor() {
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.#emit("open", {});
      });
    }

    addEventListener(type: string, listener: (event: never) => void): void {
      const listeners = this.#listeners.get(type) ?? [];
      listeners.push(listener);
      this.#listeners.set(type, listeners);
    }

    send(value: string): void {
      sent.push(value);
      queueMicrotask(() => this.#emit("message", {
        data: JSON.stringify({
          type: "price",
          ticker: "BISON-event-UP",
          ts: 1_000,
          yesBidUsd: 400_000,
          yesAskUsd: 410_000,
          noBidUsd: 0,
          noAskUsd: 0,
        }),
      }));
    }

    close(code = 1_000, reason = ""): void {
      this.readyState = 3;
      this.#emit("close", { code, reason });
    }

    #emit(type: string, event: object): void {
      for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
    }
  }

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    await streamJupiterPredictionPrices(["BISON-event-UP", "BISON-event-DOWN", "BISON-event-UP"], {
      signal: controller.signal,
      onPrice: (update) => {
        assert.equal(update.marketId, "BISON-event-UP");
        controller.abort();
      },
    });
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }

  assert.deepEqual(JSON.parse(sent[0] ?? "{}"), {
    type: "subscribe",
    marketIds: ["BISON-event-UP", "BISON-event-DOWN"],
  });
});
