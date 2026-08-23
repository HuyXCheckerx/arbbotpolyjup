import assert from "node:assert/strict";
import test from "node:test";

import { JupiterRequestScheduler } from "../src/request-scheduler.ts";

test("shared Jupiter request scheduler spaces concurrent main-bucket reservations", async () => {
  const scheduler = new JupiterRequestScheduler(15);
  const starts: number[] = [];

  await Promise.all(Array.from({ length: 3 }, async () => {
    await scheduler.wait();
    starts.push(Date.now());
  }));

  assert.equal(starts.length, 3);
  assert.ok((starts[1] ?? 0) - (starts[0] ?? 0) >= 12);
  assert.ok((starts[2] ?? 0) - (starts[1] ?? 0) >= 12);
});

test("shared Jupiter request scheduler rejects invalid intervals", () => {
  assert.throws(() => new JupiterRequestScheduler(-1), /non-negative integer/);
  assert.throws(() => new JupiterRequestScheduler(0.5), /non-negative integer/);
});
