import { formatContracts, formatUsd } from "./fixed.ts";
import type { BinaryOrderBook, BookLevel, Venue } from "./types.ts";

export interface LoggedBookLevel {
  priceMicroUsd: string;
  priceUsd: string;
  contractsMicro: string;
  contracts: string;
}

export interface LoggedBookSnapshot {
  venue: string;
  provider: string;
  marketId: string;
  receivedAt: string;
  receivedAtMs: number;
  sourceTimestamp: string | null;
  sourceTimestampMs: number | null;
  sourceAgeAtCompletionMs: number | null;
  yesBestBid: LoggedBookLevel | null;
  yesBestAsk: LoggedBookLevel | null;
  noBestBid: LoggedBookLevel | null;
  noBestAsk: LoggedBookLevel | null;
}

export interface LoggedAskDifference {
  jupiterMinusPolymarketMicroUsd: string | null;
  jupiterMinusPolymarketUsd: string | null;
}

export interface LoggedBestAskRoute {
  venue: Venue | null;
  level: LoggedBookLevel | null;
  rawPriceTie: boolean;
  selectionReason:
    | "LOWER_RAW_ASK"
    | "ONLY_AVAILABLE_ASK"
    | "RAW_PRICE_TIE_PREFER_POLYMARKET_LOWER_ROUTE_RISK"
    | "NO_ASK_AVAILABLE";
}

export interface LoggedBestAvailableCombination {
  yes: LoggedBestAskRoute;
  no: LoggedBestAskRoute;
}

export interface AskMonitorSample {
  schemaVersion: 1;
  type: "sample";
  sessionId: string;
  sequence: number;
  startedAt: string;
  completedAt: string;
  cycleDurationMs: number;
  receiptSkewMs: number;
  books: {
    polymarket: LoggedBookSnapshot;
    jupiter: LoggedBookSnapshot;
  };
  askDifferences: {
    yes: LoggedAskDifference;
    no: LoggedAskDifference;
  };
  bestAvailable: LoggedBestAvailableCombination;
  warnings: readonly string[];
}

export interface AskMonitorSampleInput {
  sessionId: string;
  sequence: number;
  startedAtMs: number;
  completedAtMs: number;
  polymarket: BinaryOrderBook;
  jupiter: BinaryOrderBook;
  maxReceiptSkewMs?: number;
  maxSourceAgeMs?: number;
}

export function buildAskMonitorSample(input: AskMonitorSampleInput): AskMonitorSample {
  const maxReceiptSkewMs = input.maxReceiptSkewMs ?? 2_000;
  const maxSourceAgeMs = input.maxSourceAgeMs ?? 5_000;
  const polymarket = summarizeBook(input.polymarket, input.completedAtMs);
  const jupiter = summarizeBook(input.jupiter, input.completedAtMs);
  const receiptSkewMs = Math.abs(input.polymarket.receivedAtMs - input.jupiter.receivedAtMs);
  const bestAvailable: LoggedBestAvailableCombination = {
    yes: bestAskRoute(polymarket.yesBestAsk, jupiter.yesBestAsk),
    no: bestAskRoute(polymarket.noBestAsk, jupiter.noBestAsk),
  };
  const warnings = ["SHARED_LIQUIDITY"];

  if (receiptSkewMs > maxReceiptSkewMs) warnings.push("SNAPSHOT_RECEIPT_SKEW_EXCEEDED");
  if (polymarket.sourceAgeAtCompletionMs !== null && polymarket.sourceAgeAtCompletionMs > maxSourceAgeMs) {
    warnings.push("POLYMARKET_SOURCE_STALE");
  }
  if (jupiter.sourceTimestampMs === null) warnings.push("JUPITER_SOURCE_TIMESTAMP_UNAVAILABLE");
  if (!polymarket.yesBestAsk || !polymarket.noBestAsk) warnings.push("POLYMARKET_ASK_DEPTH_MISSING");
  if (!jupiter.yesBestAsk || !jupiter.noBestAsk) warnings.push("JUPITER_ASK_DEPTH_MISSING");

  return {
    schemaVersion: 1,
    type: "sample",
    sessionId: input.sessionId,
    sequence: input.sequence,
    startedAt: iso(input.startedAtMs),
    completedAt: iso(input.completedAtMs),
    cycleDurationMs: input.completedAtMs - input.startedAtMs,
    receiptSkewMs,
    books: { polymarket, jupiter },
    askDifferences: {
      yes: askDifference(polymarket.yesBestAsk, jupiter.yesBestAsk),
      no: askDifference(polymarket.noBestAsk, jupiter.noBestAsk),
    },
    bestAvailable,
    warnings,
  };
}

function bestAskRoute(
  polymarket: LoggedBookLevel | null,
  jupiter: LoggedBookLevel | null,
): LoggedBestAskRoute {
  if (!polymarket && !jupiter) {
    return { venue: null, level: null, rawPriceTie: false, selectionReason: "NO_ASK_AVAILABLE" };
  }
  if (!polymarket) {
    return { venue: "jupiter", level: jupiter, rawPriceTie: false, selectionReason: "ONLY_AVAILABLE_ASK" };
  }
  if (!jupiter) {
    return { venue: "polymarket", level: polymarket, rawPriceTie: false, selectionReason: "ONLY_AVAILABLE_ASK" };
  }

  const polymarketPrice = BigInt(polymarket.priceMicroUsd);
  const jupiterPrice = BigInt(jupiter.priceMicroUsd);
  if (polymarketPrice < jupiterPrice) {
    return { venue: "polymarket", level: polymarket, rawPriceTie: false, selectionReason: "LOWER_RAW_ASK" };
  }
  if (jupiterPrice < polymarketPrice) {
    return { venue: "jupiter", level: jupiter, rawPriceTie: false, selectionReason: "LOWER_RAW_ASK" };
  }
  return {
    venue: "polymarket",
    level: polymarket,
    rawPriceTie: true,
    selectionReason: "RAW_PRICE_TIE_PREFER_POLYMARKET_LOWER_ROUTE_RISK",
  };
}

function summarizeBook(book: BinaryOrderBook, completedAtMs: number): LoggedBookSnapshot {
  return {
    venue: book.venue,
    provider: book.provider,
    marketId: book.marketId,
    receivedAt: iso(book.receivedAtMs),
    receivedAtMs: book.receivedAtMs,
    sourceTimestamp: book.sourceTimestampMs === null ? null : iso(book.sourceTimestampMs),
    sourceTimestampMs: book.sourceTimestampMs,
    sourceAgeAtCompletionMs: book.sourceTimestampMs === null ? null : completedAtMs - book.sourceTimestampMs,
    yesBestBid: logLevel(bestBid(book.yes.bids)),
    yesBestAsk: logLevel(bestAsk(book.yes.asks)),
    noBestBid: logLevel(bestBid(book.no.bids)),
    noBestAsk: logLevel(bestAsk(book.no.asks)),
  };
}

function askDifference(polymarket: LoggedBookLevel | null, jupiter: LoggedBookLevel | null): LoggedAskDifference {
  if (!polymarket || !jupiter) {
    return { jupiterMinusPolymarketMicroUsd: null, jupiterMinusPolymarketUsd: null };
  }
  const difference = BigInt(jupiter.priceMicroUsd) - BigInt(polymarket.priceMicroUsd);
  return {
    jupiterMinusPolymarketMicroUsd: difference.toString(),
    jupiterMinusPolymarketUsd: formatUsd(difference),
  };
}

function logLevel(level: BookLevel | null): LoggedBookLevel | null {
  if (!level) return null;
  return {
    priceMicroUsd: level.priceMicroUsd.toString(),
    priceUsd: formatUsd(level.priceMicroUsd),
    contractsMicro: level.contractsMicro.toString(),
    contracts: formatContracts(level.contractsMicro),
  };
}

function bestBid(levels: readonly BookLevel[]): BookLevel | null {
  let best: BookLevel | null = null;
  for (const level of levels) {
    if (!best || level.priceMicroUsd > best.priceMicroUsd) best = level;
  }
  return best;
}

function bestAsk(levels: readonly BookLevel[]): BookLevel | null {
  let best: BookLevel | null = null;
  for (const level of levels) {
    if (!best || level.priceMicroUsd < best.priceMicroUsd) best = level;
  }
  return best;
}

function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}
