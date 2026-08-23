import assert from "node:assert/strict";
import test from "node:test";

import type { VenueMarket } from "../../domain/src/types.ts";
import { compareMarkets, discoverMarketMatches } from "../src/match.ts";
import { normalizeMarketRule } from "../src/normalize.ts";

const POLY_RULE = `This market will immediately resolve to "Yes" if any Binance 1 minute candle for BTC/USDT during the month specified in the title (from 00:00 AM ET on the first day to 11:59 PM ET on the last), has a final High price equal to or greater than the price specified in the title. Otherwise, this market will resolve to "No." The resolution source for this market is Binance, specifically the BTC/USDT High prices.`;

test("normalizes a Polymarket monthly BTC touch contract", () => {
  const normalized = normalizeMarketRule(market({
    title: "Will Bitcoin reach $75,000 in August?",
    rulesPrimary: POLY_RULE,
  }));
  assert.equal(normalized.asset, "BTC");
  assert.equal(normalized.thresholdMicroUsd, 75_000_000_000n);
  assert.equal(normalized.comparison, "GTE");
  assert.equal(normalized.observationMode, "TOUCH");
  assert.equal(normalized.windowAnchor, "CALENDAR_MONTH");
  assert.equal(normalized.oracle, "BINANCE:BTC/USDT");
  assert.equal(normalized.sampling, "CANDLE_1M_HIGH");
});

test("rejects Jupiter Polymarket routing as shared liquidity", () => {
  const poly = market({ clobTokenIds: ["yes-token", "no-token"] });
  const jupiter = market({
    venue: "jupiter",
    provider: "polymarket",
    marketId: "POLY-1",
    clobTokenIds: ["yes-token", "no-token"],
  });
  const result = compareMarkets(poly, jupiter);
  assert.equal(result.verdict, "SHARED_LIQUIDITY");
  assert.deepEqual(result.sharedTokenIds, ["yes-token", "no-token"]);
});

test("rejects a touch contract paired with a point-in-time contract", () => {
  const poly = market({});
  const jupiter = market({
    venue: "jupiter",
    provider: "kalshi",
    marketId: "KXBTC-75000",
    rulesPrimary: "If the CF Benchmarks BTCUSD_RTI is above $75,000.00 at 12 AM ET on Sep 1, 2026, this market resolves Yes.",
    rulesSecondary: "The official value is the simple average of the sixty seconds of BTCUSD_RTI.",
    title: "Above $75,000",
    openTimeMs: 1_785_560_000_000,
  });
  const result = compareMarkets(poly, jupiter);
  assert.equal(result.verdict, "REJECT");
  assert.ok(result.reasons.some((reason) => reason.includes("observation mode differs")));
  assert.ok(result.reasons.some((reason) => reason.includes("oracle differs")));
});

test("accepts identical independent canonical rules", () => {
  const poly = market({});
  const jupiter = market({
    venue: "jupiter",
    provider: "kalshi",
    marketId: "KX-INDEPENDENT",
    clobTokenIds: [],
  });
  assert.equal(compareMarkets(poly, jupiter).verdict, "EXACT");
});

test("candidate discovery surfaces one-cent boundary differences", () => {
  const poly = market({ title: "Will Bitcoin reach $75,000 in August?" });
  const jupiter = market({
    venue: "jupiter",
    provider: "kalshi",
    marketId: "KX-7499999",
    title: "Above $74,999.99",
    rulesPrimary: "If CF Benchmarks BTCUSD_RTI is above $74,999.99 at 12 AM ET on Sep 1, 2026, this market resolves Yes.",
    rulesSecondary: "The official value is the simple average of the sixty seconds of BTCUSD_RTI.",
  });
  const results = discoverMarketMatches([poly], [jupiter], {
    includeRejected: true,
  });
  assert.equal(results.length, 1);
  assert.ok(results[0]?.reasons.some((reason) => reason.includes("threshold differs")));
});

test("normalizes Kalshi BRTI trimmed-mean rules", () => {
  const normalized = normalizeMarketRule(market({
    venue: "jupiter",
    provider: "kalshi",
    title: "Before September 2026",
    rulesPrimary: "If the Bitcoin spot price according to the CF Bitcoin Real-Time Index is above $100000.00 starting Jul 21, 2026 and before Sep 1, 2026 at 12:00 AM ET, then the market resolves to Yes.",
    rulesSecondary: "The market resolves based on the CF Bitcoin Real-Time Index (BRTI) using a trimmed mean calculation, removing the top 20% and bottom 20% of values. If the BRTI crosses the threshold at any point, the market immediately resolves.",
  }));
  assert.equal(normalized.oracle, "CF_BENCHMARKS:BRTI");
  assert.equal(normalized.sampling, "RTI_TRIMMED_MEAN_SERIES");
  assert.equal(normalized.windowAnchor, "EXPLICIT_PERIOD");
  assert.equal(normalized.observationMode, "TOUCH");
});

test("normalizes a numeric-only Jupiter daily strike label", () => {
  const normalized = normalizeMarketRule(market({
    venue: "jupiter",
    provider: "polymarket",
    marketId: "POLY-3651166",
    title: "72,000",
    eventTitle: "",
    rulesPrimary: "This market resolves Yes if the Binance 1 minute candle for BTC/USDT at 12:00 in the ET timezone has a final Close price higher than the price specified in the title.",
    rulesSecondary: "",
  }));

  assert.equal(normalized.thresholdMicroUsd, 72_000_000_000n);
  assert.equal(normalized.comparison, "GT");
  assert.equal(normalized.observationMode, "POINT");
  assert.equal(normalized.oracle, "BINANCE:BTC/USDT");
  assert.equal(normalized.sampling, "CANDLE_1M_CLOSE");
});

test("uses primary rule direction when secondary text explains both operators", () => {
  const normalized = normalizeMarketRule(market({
    venue: "jupiter",
    provider: "kalshi",
    title: "Below $1,500",
    rulesPrimary: "If the ETH price is below $1,500.00 before Jan 1, 2027, the market resolves Yes.",
    rulesSecondary: "The above operator resolves early. The below operator uses a different final check.",
  }));
  assert.equal(normalized.comparison, "LT");
});

function market(overrides: Partial<VenueMarket>): VenueMarket {
  return {
    venue: "polymarket",
    provider: "polymarket",
    eventId: "event-1",
    marketId: "market-1",
    title: "Will Bitcoin reach $75,000 in August?",
    eventTitle: "What price will Bitcoin hit in August?",
    rulesPrimary: POLY_RULE,
    rulesSecondary: "",
    status: "open",
    openTimeMs: 1_785_560_000_000,
    closeTimeMs: Date.parse("2026-09-01T04:00:00Z"),
    clobTokenIds: [],
    outcomes: ["Yes", "No"],
    pricing: {
      buyYesMicroUsd: 576_000n,
      sellYesMicroUsd: 571_000n,
      buyNoMicroUsd: 429_000n,
      sellNoMicroUsd: 424_000n,
    },
    sourceUrl: "https://example.test/market",
    ...overrides,
  };
}
