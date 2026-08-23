import { ONE_USD_MICRO } from "../../domain/src/fixed.ts";
import type { MarketMatch, MatchVerdict, VenueMarket } from "../../domain/src/types.ts";
import { normalizeMarketRule } from "./normalize.ts";

export interface DiscoveryMatchOptions {
  maxStrikeDifferenceMicroUsd?: bigint;
  maxCloseDifferenceMs?: number;
  includeRejected?: boolean;
}

export function compareMarkets(polymarket: VenueMarket, jupiter: VenueMarket): MarketMatch {
  const polyRule = normalizeMarketRule(polymarket);
  const jupiterRule = normalizeMarketRule(jupiter);
  const polyTokens = new Set(polymarket.clobTokenIds);
  const sharedTokenIds = jupiter.clobTokenIds.filter((token) => polyTokens.has(token));
  const sharedProvider = jupiter.provider.toLowerCase() === "polymarket";

  const reasons: string[] = [];
  if (sharedProvider) reasons.push("Jupiter provider is Polymarket");
  if (sharedTokenIds.length > 0) reasons.push("Underlying CLOB token IDs overlap");

  if (sharedProvider || sharedTokenIds.length > 0) {
    return buildMatch("SHARED_LIQUIDITY", 100, reasons, sharedTokenIds);
  }

  compareField("asset", polyRule.asset, jupiterRule.asset, reasons);
  compareField("threshold", polyRule.thresholdMicroUsd, jupiterRule.thresholdMicroUsd, reasons);
  compareField("comparison operator", polyRule.comparison, jupiterRule.comparison, reasons);
  compareField("observation mode", polyRule.observationMode, jupiterRule.observationMode, reasons);
  compareField("window anchor", polyRule.windowAnchor, jupiterRule.windowAnchor, reasons);
  compareField("close time", polyRule.closeTimeMs, jupiterRule.closeTimeMs, reasons);
  if (polyRule.observationMode === "TOUCH" || jupiterRule.observationMode === "TOUCH") {
    compareField("open time", polyRule.openTimeMs, jupiterRule.openTimeMs, reasons);
  }
  compareField("oracle", polyRule.oracle, jupiterRule.oracle, reasons);
  compareField("sampling", polyRule.sampling, jupiterRule.sampling, reasons);
  compareField("timezone", polyRule.timezone, jupiterRule.timezone, reasons);

  const coreMismatch = reasons.some((reason) =>
    /asset|threshold|comparison operator|observation mode|close time/.test(reason),
  );
  const sourceMismatch = reasons.some((reason) => /oracle|sampling|timezone|window anchor|open time/.test(reason));

  let verdict: MatchVerdict;
  let score: number;
  if (coreMismatch) {
    verdict = "REJECT";
    score = 20;
  } else if (sourceMismatch || !polyRule.complete || !jupiterRule.complete) {
    verdict = "BASIS";
    score = 60;
    if (!polyRule.complete || !jupiterRule.complete) reasons.push("Canonical extraction is incomplete");
  } else if (polyRule.ruleHash !== jupiterRule.ruleHash) {
    verdict = "REVIEW_REQUIRED";
    score = 90;
    reasons.push("Canonical fields match but complete rule hashes differ");
  } else {
    verdict = "EXACT";
    score = 100;
    reasons.push("Independent providers with identical canonical fields and rule hash");
  }

  return buildMatch(verdict, score, reasons, sharedTokenIds);

  function buildMatch(
    verdict: MatchVerdict,
    score: number,
    matchReasons: readonly string[],
    overlap: readonly string[],
  ): MarketMatch {
    return {
      polymarket,
      jupiter,
      polyRule,
      jupiterRule,
      verdict,
      score,
      reasons: matchReasons,
      sharedTokenIds: overlap,
    };
  }
}

export function discoverMarketMatches(
  polymarkets: readonly VenueMarket[],
  jupiterMarkets: readonly VenueMarket[],
  options: DiscoveryMatchOptions = {},
): MarketMatch[] {
  const maxStrikeDifference = options.maxStrikeDifferenceMicroUsd ?? ONE_USD_MICRO;
  const maxCloseDifference = options.maxCloseDifferenceMs ?? 24 * 60 * 60 * 1_000;
  const includeRejected = options.includeRejected ?? false;
  const matches: MarketMatch[] = [];
  const seen = new Set<string>();

  const jupiterByToken = new Map<string, VenueMarket[]>();
  for (const market of jupiterMarkets) {
    for (const token of market.clobTokenIds) {
      const existing = jupiterByToken.get(token) ?? [];
      existing.push(market);
      jupiterByToken.set(token, existing);
    }
  }

  for (const polymarket of polymarkets) {
    for (const token of polymarket.clobTokenIds) {
      for (const jupiter of jupiterByToken.get(token) ?? []) {
        add(polymarket, jupiter);
      }
    }
  }

  const normalizedPoly = polymarkets.map((market) => ({ market, rule: normalizeMarketRule(market) }));
  const normalizedJupiter = jupiterMarkets.map((market) => ({ market, rule: normalizeMarketRule(market) }));

  for (const poly of normalizedPoly) {
    if (poly.rule.asset === null || poly.rule.thresholdMicroUsd === null) continue;
    for (const jupiter of normalizedJupiter) {
      if (poly.rule.asset !== jupiter.rule.asset || jupiter.rule.thresholdMicroUsd === null) continue;
      const strikeDifference = absolute(poly.rule.thresholdMicroUsd - jupiter.rule.thresholdMicroUsd);
      if (strikeDifference > maxStrikeDifference) continue;
      if (
        poly.rule.closeTimeMs !== null &&
        jupiter.rule.closeTimeMs !== null &&
        Math.abs(poly.rule.closeTimeMs - jupiter.rule.closeTimeMs) > maxCloseDifference
      ) {
        continue;
      }
      add(poly.market, jupiter.market);
    }
  }

  return matches
    .filter((match) => includeRejected || match.verdict !== "REJECT")
    .sort((a, b) => b.score - a.score || a.polymarket.marketId.localeCompare(b.polymarket.marketId));

  function add(polymarket: VenueMarket, jupiter: VenueMarket): void {
    const key = `${polymarket.marketId}:${jupiter.marketId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const match = compareMarkets(polymarket, jupiter);
    if (includeRejected || match.verdict !== "REJECT") matches.push(match);
  }
}

function compareField(label: string, left: unknown, right: unknown, reasons: string[]): void {
  if (left === null || left === "UNKNOWN" || right === null || right === "UNKNOWN") {
    reasons.push(`${label} is incomplete (${String(left)} vs ${String(right)})`);
  } else if (left !== right) {
    reasons.push(`${label} differs (${String(left)} vs ${String(right)})`);
  }
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}
