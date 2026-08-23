import assert from "node:assert/strict";
import test from "node:test";

import { CoalescingAsyncQueue } from "../src/coalescing-async-queue.ts";

type Event =
  | { type: "book"; venue: "polymarket" | "jupiter"; sequence: number }
  | { type: "status"; message: string };

function key(event: Event): string | null {
  return event.type === "book" ? event.venue : null;
}

test("coalescing async queue keeps only the newest pending snapshot per venue", async () => {
  const queue = new CoalescingAsyncQueue<Event>({ capacity: 8, coalesceKey: key });
  queue.push({ type: "book", venue: "polymarket", sequence: 1 });
  queue.push({ type: "book", venue: "jupiter", sequence: 1 });
  queue.push({ type: "book", venue: "polymarket", sequence: 2 });
  queue.push({ type: "status", message: "connected" });

  assert.equal(queue.pendingCount, 3);
  assert.deepEqual(await queue.next(), { type: "book", venue: "polymarket", sequence: 2 });
  assert.deepEqual(await queue.next(), { type: "book", venue: "jupiter", sequence: 1 });
  assert.deepEqual(await queue.next(), { type: "status", message: "connected" });
});

test("coalescing async queue stays bounded and drops a snapshot before control events", async () => {
  const queue = new CoalescingAsyncQueue<Event>({ capacity: 2, coalesceKey: key });
  queue.push({ type: "status", message: "first" });
  queue.push({ type: "book", venue: "polymarket", sequence: 1 });
  queue.push({ type: "status", message: "second" });

  assert.equal(queue.pendingCount, 2);
  assert.deepEqual(await queue.next(), { type: "status", message: "first" });
  assert.deepEqual(await queue.next(), { type: "status", message: "second" });
});

test("coalescing async queue hands an event directly to a waiting consumer", async () => {
  const queue = new CoalescingAsyncQueue<Event>({ capacity: 2, coalesceKey: key });
  const pending = queue.next();
  queue.push({ type: "book", venue: "jupiter", sequence: 4 });

  assert.deepEqual(await pending, { type: "book", venue: "jupiter", sequence: 4 });
  assert.equal(queue.pendingCount, 0);
});
