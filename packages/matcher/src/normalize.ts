import { createHash } from "node:crypto";

import { parseUsd } from "../../domain/src/fixed.ts";
import type {
  Asset,
  CanonicalRule,
  Comparison,
  ObservationMode,
  VenueMarket,
  WindowAnchor,
} from "../../domain/src/types.ts";

const ASSET_PATTERNS: readonly [Asset, RegExp][] = [
  ["BTC", /\b(?:btc|bitcoin)\b/i],
  ["ETH", /\b(?:eth|ethereum|ether)\b/i],
  ["SOL", /\b(?:sol|solana)\b/i],
  ["XRP", /\b(?:xrp|ripple)\b/i],
];

export function normalizeMarketRule(market: VenueMarket): CanonicalRule {
  const primaryText = normalizeText(market.rulesPrimary);
  const secondaryText = normalizeText(market.rulesSecondary);
  const ruleText = normalizeText(`${market.rulesPrimary}\n${market.rulesSecondary}`);
  const titleText = normalizeText(`${market.eventTitle}\n${market.title}`);
  const combined = `${ruleText}\n${titleText}`;

  const asset = extractAsset(combined);
  const thresholdMicroUsd =
    extractThresholdMicroUsd(primaryText) ??
    extractThresholdMicroUsd(titleText) ??
    extractBareThresholdMicroUsd(market.title) ??
    extractThresholdMicroUsd(secondaryText);
  const comparison =
    extractComparison(primaryText) ?? extractComparison(titleText) ?? extractComparison(secondaryText) ?? "UNKNOWN";
  const observationMode = extractObservationMode(ruleText, titleText);
  const windowAnchor = extractWindowAnchor(ruleText, observationMode);
  const oracle = extractOracle(ruleText, asset);
  const sampling = extractSampling(ruleText);
  const timezone = extractTimezone(ruleText);
  const ruleHash = hashRules(market.rulesPrimary, market.rulesSecondary);

  return {
    asset,
    thresholdMicroUsd,
    comparison,
    observationMode,
    windowAnchor,
    openTimeMs: market.openTimeMs,
    closeTimeMs: market.closeTimeMs,
    oracle,
    sampling,
    timezone,
    ruleHash,
    complete:
      asset !== null &&
      thresholdMicroUsd !== null &&
      comparison !== "UNKNOWN" &&
      observationMode !== "UNKNOWN" &&
      oracle !== null &&
      sampling !== null &&
      market.closeTimeMs !== null,
  };
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function hashRules(primary: string, secondary: string): string {
  return createHash("sha256")
    .update(`${normalizeText(primary)}\n${normalizeText(secondary)}`)
    .digest("hex");
}

function extractAsset(text: string): Asset | null {
  for (const [asset, pattern] of ASSET_PATTERNS) {
    if (pattern.test(text)) return asset;
  }
  return null;
}

function extractThresholdMicroUsd(text: string): bigint | null {
  const currency = /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(text);
  const arrow = /[↑↓]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(text);
  const value = currency?.[1] ?? arrow?.[1];
  if (!value) return null;

  try {
    return parseUsd(value.replaceAll(",", ""));
  } catch {
    return null;
  }
}

function extractBareThresholdMicroUsd(title: string): bigint | null {
  const value = /^\s*(?:[<>]=?\s*)?\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/.exec(title)?.[1];
  if (!value) return null;

  try {
    return parseUsd(value.replaceAll(",", ""));
  } catch {
    return null;
  }
}

function extractComparison(text: string): Comparison | null {
  if (/equal to or greater|greater than or equal|at least|or above/.test(text)) return "GTE";
  if (/equal to or (?:lower|less)|less than or equal|at most|or below/.test(text)) return "LTE";
  if (/greater than|higher than|strictly exceed|\babove\b|\bover\b|\breach\b|\breach(?:es)?\b/.test(text)) return "GT";
  if (/less than|lower than|strictly less|\bbelow\b|\bunder\b|\bdip to\b/.test(text)) return "LT";
  if (/\breach\b|\breaches\b/.test(text)) return "GTE";
  return null;
}

function extractObservationMode(ruleText: string, titleText: string): ObservationMode {
  if (/between \$?[0-9,.]+ and \$?[0-9,.]+/.test(titleText)) return "RANGE";
  if (
    /at any point|any .*candle|during the month|from (?:market )?creation|between .* and .*then the market resolves/.test(
      ruleText,
    )
  ) {
    return "TOUCH";
  }
  if (
    /final ["']?close["']? price|last minute before expiration|at \d{1,2}(?::\d{2})?\s*(?:am|pm)|at 12 am|simple average of the sixty seconds|on the date specified/.test(
      ruleText,
    )
  ) {
    return "POINT";
  }
  if (/\bon\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)/.test(titleText)) {
    return "POINT";
  }
  return "UNKNOWN";
}

function extractWindowAnchor(ruleText: string, mode: ObservationMode): WindowAnchor {
  if (mode === "POINT") return "POINT";
  if (/from (?:the )?(?:creation|market's creation|issuance)/.test(ruleText)) return "MARKET_CREATION";
  if (/during the month|first day to .*last day of the month/.test(ruleText)) return "CALENDAR_MONTH";
  if (/between .* and |from .* through |starting .* (?:before|through|until)/.test(ruleText)) return "EXPLICIT_PERIOD";
  return "UNKNOWN";
}

function extractOracle(ruleText: string, asset: Asset | null): string | null {
  if (/binance/.test(ruleText)) {
    const pair = /\b(btc|eth|sol|xrp)\s*\/\s*(usdt|usd)\b/i.exec(ruleText);
    if (pair?.[1] && pair[2]) return `BINANCE:${pair[1].toUpperCase()}/${pair[2].toUpperCase()}`;
    return asset ? `BINANCE:${asset}/UNKNOWN` : "BINANCE:UNKNOWN";
  }

  if (/cf benchmarks|cf .*real-time index|\bbrti\b|(?:btc|eth|sol|xrp)usd_rti|real time index/.test(ruleText)) {
    const namedIndex = /\b([a-z]{1,8}rti)\b/i.exec(ruleText);
    if (namedIndex?.[1]) return `CF_BENCHMARKS:${namedIndex[1].toUpperCase()}`;
    const rti = /\b(btc|eth|sol|xrp)usd_rti\b/i.exec(ruleText);
    return `CF_BENCHMARKS:${(rti?.[1] ?? asset ?? "UNKNOWN").toUpperCase()}USD_RTI`;
  }

  if (/coinbase/.test(ruleText)) return asset ? `COINBASE:${asset}/USD` : "COINBASE:UNKNOWN";
  if (/chainlink/.test(ruleText)) return asset ? `CHAINLINK:${asset}/USD` : "CHAINLINK:UNKNOWN";
  return null;
}

function extractSampling(ruleText: string): string | null {
  if (/trimmed mean|removing the top .*bottom/.test(ruleText)) return "RTI_TRIMMED_MEAN_SERIES";
  if (/1 minute candle|1m/.test(ruleText)) {
    if (/final high|\bhigh price/.test(ruleText)) return "CANDLE_1M_HIGH";
    if (/final low|\blow price/.test(ruleText)) return "CANDLE_1M_LOW";
    if (/final ["']?close["']? price|\bclose prices?/.test(ruleText)) return "CANDLE_1M_CLOSE";
    return "CANDLE_1M_UNKNOWN";
  }
  if (/simple average of the sixty seconds|60 rti prices/.test(ruleText)) return "RTI_60S_AVERAGE";
  if (/simple average .* each minute|values for each minute/.test(ruleText)) return "RTI_1M_AVERAGE_SERIES";
  if (/monitored continuously|at any point/.test(ruleText)) return "CONTINUOUS_INDEX";
  return null;
}

function extractTimezone(ruleText: string): string | null {
  if (/\b(?:eastern time|et timezone|\bet\b)/.test(ruleText)) return "AMERICA_NEW_YORK";
  if (/\best\b/.test(ruleText)) return "EST";
  if (/\bedt\b/.test(ruleText)) return "EDT";
  if (/\butc\b/.test(ruleText)) return "UTC";
  return null;
}
