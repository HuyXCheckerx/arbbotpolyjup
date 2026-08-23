import assert from "node:assert/strict";
import test from "node:test";

import type { VenueMarket } from "../../../packages/domain/src/types.ts";
import {
  DAILY_THRESHOLD_ROUTES,
  dailyLivePairIdentity,
  discoverDailyThresholdPairs,
  validateDailyThresholdPair,
} from "../src/btc-daily-threshold.ts";

const RULE = `This market will resolve to "Yes" if the Binance 1 minute candle for BTC/USDT 12:00 in the ET timezone (noon) on the date specified in the title has a final "Close" price higher than the price specified in the title. Otherwise, this market will resolve to "No".`;

test("discovers future Bitcoin daily threshold POLY markets and maps both complementary routes", () => {
  const pairs = discoverDailyThresholdPairs([market()], Date.parse("2026-08-22T17:00:00Z"));
  assert.equal(pairs.length, 1);
  const pair = pairs[0]!;
  assert.equal(pair.key, "daily:3635565");
  assert.equal(pair.thresholdMicroUsd, 74_000_000_000n);
  assert.equal(pair.polymarketSlug, "bitcoin-above-on-august-23-2026");
  assert.equal(pair.polymarket.marketId, "3635565");
  assert.equal(dailyLivePairIdentity(pair, DAILY_THRESHOLD_ROUTES[0]!).polymarketTokenId, "yes-token");
  const noOnJupiter = dailyLivePairIdentity(pair, DAILY_THRESHOLD_ROUTES[0]!);
  assert.equal(noOnJupiter.jupiterOutcome, "DOWN");
  assert.equal(noOnJupiter.jupiterOutcomeMint, undefined);
});

test("rejects expired, wrong-time, or independently sourced lookalikes", () => {
  const now = Date.parse("2026-08-22T17:00:00Z");
  assert.equal(discoverDailyThresholdPairs([market({ closeTimeMs: Date.parse("2026-08-21T16:00:00Z") })], now).length, 0);
  assert.equal(discoverDailyThresholdPairs([market({ closeTimeMs: Date.parse("2026-08-23T15:00:00Z") })], now).length, 0);
  assert.equal(discoverDailyThresholdPairs([market({ provider: "kalshi" })], now).length, 0);
});

test("requires live Polymarket metadata to retain identical rules and CLOB tokens", () => {
  const pair = discoverDailyThresholdPairs([market()], Date.parse("2026-08-22T17:00:00Z"))[0]!;
  const verified = validateDailyThresholdPair(pair, market({
    venue: "polymarket",
    marketId: "3635565",
    eventId: "859791",
    feeSchedule: { rate: "0.07", exponent: 1, takerOnly: true },
  }));
  assert.equal(verified.polymarket.marketId, "3635565");
  assert.throws(() => validateDailyThresholdPair(pair, { ...verified.polymarket, clobTokenIds: ["other", "tokens"] }), /CLOB token IDs differ/);
});

function market(overrides: Partial<VenueMarket> = {}): VenueMarket {
  return {
    venue: "jupiter",
    provider: "polymarket",
    eventId: "POLY-859791",
    marketId: "POLY-3635565",
    title: "74,000",
    eventTitle: "Bitcoin above ___ on August 23?",
    rulesPrimary: RULE,
    rulesSecondary: "",
    status: "open",
    openTimeMs: Date.parse("2026-08-16T16:00:29Z"),
    closeTimeMs: Date.parse("2026-08-23T16:00:00Z"),
    clobTokenIds: ["yes-token", "no-token"],
    outcomes: ["Yes", "No"],
    pricing: {
      buyYesMicroUsd: 960_000n,
      sellYesMicroUsd: 959_000n,
      buyNoMicroUsd: 41_000n,
      sellNoMicroUsd: 40_000n,
    },
    sourceUrl: "https://example.test/POLY-3635565",
    ...overrides,
  };
}
