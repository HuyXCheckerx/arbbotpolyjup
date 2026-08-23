import type { CrossVenueShortWindowRoute, ShortWindowOutcome } from "../../../packages/domain/src/short-window.ts";
import type { BinaryOrderBook, BookLevel, VenueMarket } from "../../../packages/domain/src/types.ts";
import { normalizeMarketRule } from "../../../packages/matcher/src/normalize.ts";
import type { LivePairIdentity } from "./short-window-live-trader.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_HORIZON_DAYS = 14;

export const DAILY_THRESHOLD_ROUTES: readonly CrossVenueShortWindowRoute[] = [
  { polymarketOutcome: "UP", jupiterOutcome: "DOWN", reason: "REFERENCES_EQUAL" },
  { polymarketOutcome: "DOWN", jupiterOutcome: "UP", reason: "REFERENCES_EQUAL" },
];

export interface DailyThresholdPair {
  key: string;
  closeMs: number;
  thresholdMicroUsd: bigint;
  polymarketSlug: string;
  polymarket: VenueMarket;
  jupiter: VenueMarket;
}

export function discoverDailyThresholdPairs(
  jupiterMarkets: readonly VenueMarket[],
  nowMs = Date.now(),
  horizonDays = DEFAULT_HORIZON_DAYS,
): DailyThresholdPair[] {
  const latestCloseMs = nowMs + horizonDays * DAY_MS;
  const pairs: DailyThresholdPair[] = [];
  for (const jupiter of jupiterMarkets) {
    const parsedDate = parseDailyEventTitle(jupiter.eventTitle);
    const polymarketId = /^POLY-(\d+)$/.exec(jupiter.marketId)?.[1];
    const polymarketEventId = /^POLY-(\d+)$/.exec(jupiter.eventId ?? "")?.[1];
    const closeMs = jupiter.closeTimeMs;
    const rule = normalizeMarketRule(jupiter);
    if (!parsedDate || !polymarketId || !polymarketEventId || closeMs === null) continue;
    if (jupiter.provider !== "polymarket" || jupiter.status !== "open") continue;
    if (closeMs <= nowMs || closeMs > latestCloseMs || !closeMatchesTitle(closeMs, parsedDate)) continue;
    if (jupiter.clobTokenIds.length !== 2 || !hasYesNoOutcomes(jupiter)) continue;
    if (rule.asset !== "BTC" || rule.thresholdMicroUsd === null || rule.comparison !== "GT" ||
      rule.observationMode !== "POINT" || rule.oracle !== "BINANCE:BTC/USDT" ||
      rule.sampling !== "CANDLE_1M_CLOSE" || rule.timezone !== "AMERICA_NEW_YORK") continue;

    const polymarket = mirroredPolymarket(jupiter, polymarketId, polymarketEventId);
    pairs.push({
      key: `daily:${polymarketId}`,
      closeMs,
      thresholdMicroUsd: rule.thresholdMicroUsd,
      polymarketSlug: dailyEventSlug(parsedDate, closeMs),
      polymarket,
      jupiter,
    });
  }
  return [...new Map(pairs.map((pair) => [pair.key, pair])).values()]
    .sort((left, right) => left.closeMs - right.closeMs || compareBigint(left.thresholdMicroUsd, right.thresholdMicroUsd));
}

export function validateDailyThresholdPair(
  pair: DailyThresholdPair,
  polymarket: VenueMarket,
): DailyThresholdPair {
  const expectedPolymarketId = pair.jupiter.marketId.replace(/^POLY-/, "");
  const polyRule = normalizeMarketRule(polymarket);
  const jupiterRule = normalizeMarketRule(pair.jupiter);
  const problems: string[] = [];
  if (polymarket.marketId !== expectedPolymarketId) problems.push("market IDs do not map through POLY- prefix");
  if (polymarket.status !== "open") problems.push(`Polymarket status is ${polymarket.status}`);
  if (!sameStrings(polymarket.clobTokenIds, pair.jupiter.clobTokenIds)) problems.push("CLOB token IDs differ");
  if (polyRule.ruleHash !== jupiterRule.ruleHash) problems.push("resolution rule hashes differ");
  if (polyRule.asset !== "BTC" || polyRule.thresholdMicroUsd !== pair.thresholdMicroUsd) problems.push("BTC strike differs");
  if (polyRule.comparison !== "GT" || polyRule.observationMode !== "POINT") problems.push("comparison is not point-in-time strict above");
  if (polyRule.oracle !== "BINANCE:BTC/USDT" || polyRule.sampling !== "CANDLE_1M_CLOSE") {
    problems.push("oracle or sampling differs");
  }
  if (polymarket.closeTimeMs !== pair.closeMs) problems.push("close time differs");
  if (!polymarket.feeSchedule || polymarket.feeSchedule.rate !== "0.07" ||
    polymarket.feeSchedule.exponent !== 1 || polymarket.feeSchedule.takerOnly !== true) {
    problems.push("Polymarket fee schedule is missing or unexpected");
  }
  if (problems.length > 0) throw new Error(`Daily threshold pair validation failed: ${problems.join("; ")}`);
  return { ...pair, polymarket };
}

export function dailyPricingBook(
  market: VenueMarket,
  polymarketBook: BinaryOrderBook,
  receivedAtMs = Date.now(),
): BinaryOrderBook {
  return {
    venue: "jupiter",
    provider: market.provider,
    marketId: market.marketId,
    receivedAtMs,
    sourceTimestampMs: null,
    yes: {
      bids: pricingLevel(market.pricing.sellYesMicroUsd, topDepth(polymarketBook.yes.bids)),
      asks: pricingLevel(market.pricing.buyYesMicroUsd, topDepth(polymarketBook.yes.asks)),
    },
    no: {
      bids: pricingLevel(market.pricing.sellNoMicroUsd, topDepth(polymarketBook.no.bids)),
      asks: pricingLevel(market.pricing.buyNoMicroUsd, topDepth(polymarketBook.no.asks)),
    },
  };
}

export function dailyLivePairIdentity(
  pair: DailyThresholdPair,
  route: CrossVenueShortWindowRoute,
): LivePairIdentity {
  const polymarketTokenId = outcomeToken(pair.polymarket, route.polymarketOutcome);
  return {
    key: pair.key,
    duration: "daily",
    startMs: pair.polymarket.openTimeMs ?? 0,
    endMs: pair.closeMs,
    polymarketMarketId: pair.polymarket.marketId,
    polymarketSlug: pair.polymarketSlug,
    polymarketTokenId,
    polymarketOutcome: route.polymarketOutcome,
    jupiterMarketId: pair.jupiter.marketId,
    jupiterOutcome: route.jupiterOutcome,
  };
}

function mirroredPolymarket(jupiter: VenueMarket, marketId: string, eventId: string): VenueMarket {
  return {
    ...jupiter,
    venue: "polymarket",
    provider: "polymarket",
    eventId,
    marketId,
    feeSchedule: { rate: "0.07", exponent: 1, takerOnly: true },
    sourceUrl: `https://gamma-api.polymarket.com/markets/${marketId}`,
  };
}

function parseDailyEventTitle(value: string): { month: string; day: number } | null {
  const match = /^Bitcoin above ___ on ([A-Z][a-z]+) (\d{1,2})\?$/.exec(value.trim());
  const day = Number(match?.[2]);
  return match?.[1] && Number.isInteger(day) && day >= 1 && day <= 31
    ? { month: match[1], day }
    : null;
}

function closeMatchesTitle(closeMs: number, expected: { month: string; day: number }): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(closeMs);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return part("month") === expected.month && Number(part("day")) === expected.day &&
    Number(part("hour")) === 12 && Number(part("minute")) === 0;
}

function dailyEventSlug(date: { month: string; day: number }, closeMs: number): string {
  const year = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
  }).format(closeMs);
  return `bitcoin-above-on-${date.month.toLowerCase()}-${date.day}-${year}`;
}

function hasYesNoOutcomes(market: VenueMarket): boolean {
  const outcomes = market.outcomes.map((outcome) => outcome.trim().toLowerCase());
  return outcomes.includes("yes") && outcomes.includes("no");
}

function outcomeToken(market: VenueMarket, outcome: ShortWindowOutcome): string {
  const expected = outcome === "UP" ? "yes" : "no";
  const index = market.outcomes.findIndex((value) => value.trim().toLowerCase() === expected);
  const token = market.clobTokenIds[index];
  if (index < 0 || !token) throw new Error(`Daily threshold market has no ${expected.toUpperCase()} token`);
  return token;
}

function pricingLevel(priceMicroUsd: bigint | null, depthMicro: bigint): BookLevel[] {
  return priceMicroUsd === null || depthMicro <= 0n ? [] : [{ priceMicroUsd, contractsMicro: depthMicro }];
}

function topDepth(levels: readonly BookLevel[]): bigint {
  return levels[0]?.contractsMicro ?? 0n;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
