import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPolymarketBuyLimitOrder,
  floorPolymarketFokBuyContractsToAmountPrecision,
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

test("Polymarket FOK BUY accepts whole-cent maker and exact two-decimal shares", () => {
  assert.doesNotThrow(() => assertPolymarketBuyLimitOrder(
    { makerAmount: "12350000", takerAmount: "61750000" },
    61_750_000n,
    200_000n,
  ));
});

test("Polymarket FOK BUY floors shares to the largest whole-cent maker amount", () => {
  assert.equal(floorPolymarketFokBuyContractsToAmountPrecision(14_110_000n, 340_000n), 14_000_000n);
  assert.equal(floorPolymarketFokBuyContractsToAmountPrecision(6_480_000n, 200_000n), 6_450_000n);
  assert.equal(floorPolymarketFokBuyContractsToAmountPrecision(8_000_000n, 180_000n), 8_000_000n);
});

test("Polymarket BUY limit rejects changed shares or spend above its price ceiling", () => {
  assert.throws(
    () => assertPolymarketBuyLimitOrder(
      { makerAmount: "12358000", takerAmount: "61780000" },
      61_790_000n,
      200_000n,
    ),
    /changed the BUY limit share quantity/,
  );
  assert.throws(
    () => assertPolymarketBuyLimitOrder(
      { makerAmount: "12358001", takerAmount: "61790000" },
      61_790_000n,
      200_000n,
    ),
    /above the configured maximum price/,
  );
  assert.throws(
    () => assertPolymarketBuyLimitOrder(
      { makerAmount: "12358000", takerAmount: "61790000" },
      61_790_000n,
      200_000n,
    ),
    /outside the CLOB 2\/4-decimal amount limits/,
  );
});
