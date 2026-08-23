import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPolymarketMarketableBuyMinimum,
  assertPolymarketMarketOrderPrecision,
} from "../src/trading.ts";

test("Polymarket market-order precision accepts two maker and four taker decimals", () => {
  assert.doesNotThrow(() => assertPolymarketMarketOrderPrecision({
    makerAmount: "7630000",
    takerAmount: "9658300",
  }));
});

test("Polymarket market-order precision rejects invalid SDK output before submission", () => {
  assert.throws(
    () => assertPolymarketMarketOrderPrecision({ makerAmount: "7631000", takerAmount: "9658300" }),
    /outside the CLOB 2\/4-decimal amount limits/,
  );
  assert.throws(
    () => assertPolymarketMarketOrderPrecision({ makerAmount: "7630000", takerAmount: "9658320" }),
    /outside the CLOB 2\/4-decimal amount limits/,
  );
});

test("Polymarket marketable BUY rejects collateral below one dollar before submission", () => {
  assert.doesNotThrow(() => assertPolymarketMarketableBuyMinimum(1_000_000n));
  assert.throws(
    () => assertPolymarketMarketableBuyMinimum(990_000n),
    /below the \$1 minimum/,
  );
});
