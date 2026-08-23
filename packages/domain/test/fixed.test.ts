import assert from "node:assert/strict";
import test from "node:test";

import { formatContracts, formatUsd, parseContracts, parseUsd } from "../src/fixed.ts";

test("fixed-point USD parsing is exact", () => {
  assert.equal(parseUsd("0.576"), 576_000n);
  assert.equal(parseUsd("100,000".replaceAll(",", "")), 100_000_000_000n);
  assert.equal(formatUsd(100_000_000_000n), "100000");
});

test("contract parsing floors sub-micro dust explicitly", () => {
  assert.equal(parseContracts("5.1234569"), 5_123_456n);
  assert.equal(formatContracts(5_123_456n), "5.123456");
});

test("USD parsing rejects hidden precision", () => {
  assert.throws(() => parseUsd("0.1234567"), /Too many decimal places/);
});
