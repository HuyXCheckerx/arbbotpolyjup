import { ONE_CONTRACT_MICRO, ONE_USD_MICRO } from "./fixed.ts";
import {
  jupiterPredictionTakerFeeTotalMicroUsd,
  polymarketCryptoTakerFeePerContractMicroUsd,
  type EvaluatedCrossVenueRoute,
  type ShortWindowOutcome,
} from "./short-window.ts";
import type { BinaryOrderBook, BookLevel } from "./types.ts";

const CONTRACT_STEP_MICRO = 10_000n;

export interface ShortWindowStrategyConfig {
  polymarketMaximumAllocationMicroUsd: bigint;
  jupiterMaximumAllocationMicroUsd: bigint;
  jupiterMinimumGrossOrderMicroUsd: bigint;
  polymarketMinimumGrossOrderMicroUsd: bigint;
  polymarketMinimumContractsMicro: bigint;
  minimumEntryEdgeMicroUsdPerContract: bigint;
  minimumEntryEdgeTotalMicroUsd: bigint;
  minimumExitProfitMicroUsd: bigint;
}

export interface VenueTradeCost {
  /** Conservative volume-weighted average price across every consumed level. */
  priceMicroUsd: bigint;
  /** Worst ask consumed; use this as the taker limit-price basis. */
  limitPriceMicroUsd: bigint;
  levelsConsumed: number;
  quantityMicro: bigint;
  grossMicroUsd: bigint;
  takerFeeMicroUsd: bigint;
  allInMicroUsd: bigint;
}

export interface ShortWindowEntryProposal {
  route: EvaluatedCrossVenueRoute["route"];
  quantityMicro: bigint;
  polymarket: VenueTradeCost;
  jupiter: VenueTradeCost;
  allInCostMicroUsd: bigint;
  nominalPayoutMicroUsd: bigint;
  nominalEdgeMicroUsd: bigint;
  edgeMicroUsdPerContract: bigint;
}

export type EntryEvaluation =
  | { eligible: true; proposal: ShortWindowEntryProposal }
  | {
      eligible: false;
      reason:
        | "NO_FEE_ADJUSTED_ROUTE"
        | "INSUFFICIENT_TOP_DEPTH"
        | "POLYMARKET_BALANCE_OR_ALLOCATION"
        | "JUPITER_BALANCE_OR_ALLOCATION"
        | "POLYMARKET_MINIMUM_ORDER_UNREACHABLE"
        | "JUPITER_MINIMUM_ORDER_UNREACHABLE"
        | "ENTRY_EDGE_BELOW_MINIMUM";
    };

export interface ShortWindowExitProposal {
  quantityMicro: bigint;
  polymarketBid: BookLevel;
  jupiterBid: BookLevel;
  polymarketGrossProceedsMicroUsd: bigint;
  jupiterGrossProceedsMicroUsd: bigint;
  polymarketTakerFeeMicroUsd: bigint;
  jupiterTakerFeeMicroUsd: bigint;
  netProceedsMicroUsd: bigint;
  realizedProfitMicroUsd: bigint;
}

export type ExitEvaluation =
  | { eligible: true; proposal: ShortWindowExitProposal }
  | { eligible: false; reason: "MISSING_EXIT_BID" | "INSUFFICIENT_EXIT_DEPTH" | "EXIT_NOT_GREEN"; projectedProfitMicroUsd: bigint | null };

export function evaluateShortWindowEntry(input: {
  route: EvaluatedCrossVenueRoute | null;
  polymarketAvailableMicroUsd: bigint;
  jupiterAvailableMicroUsd: bigint;
  config: ShortWindowStrategyConfig;
}): EntryEvaluation {
  const { route, config } = input;
  if (!route?.isFeeAdjustedCandidate) return { eligible: false, reason: "NO_FEE_ADJUSTED_ROUTE" };
  const maximumQuantityMicro = floorToStep(route.commonDepthContractsMicro);
  if (maximumQuantityMicro < config.polymarketMinimumContractsMicro) {
    return { eligible: false, reason: "INSUFFICIENT_TOP_DEPTH" };
  }

  const polymarketBudget = minimum(input.polymarketAvailableMicroUsd, config.polymarketMaximumAllocationMicroUsd);
  const jupiterBudget = minimum(input.jupiterAvailableMicroUsd, config.jupiterMaximumAllocationMicroUsd);
  const polymarketAffordable = maximumAffordableQuantity(
    route.polymarketAsks,
    maximumQuantityMicro,
    polymarketBudget,
    "polymarket",
  );
  if (polymarketAffordable < config.polymarketMinimumContractsMicro) {
    return { eligible: false, reason: "POLYMARKET_BALANCE_OR_ALLOCATION" };
  }
  const jupiterAffordable = maximumAffordableQuantity(
    route.jupiterAsks,
    maximumQuantityMicro,
    jupiterBudget,
    "jupiter",
  );
  if (jupiterAffordable < config.polymarketMinimumContractsMicro) {
    return { eligible: false, reason: "JUPITER_BALANCE_OR_ALLOCATION" };
  }

  const affordableQuantityMicro = minimum(maximumQuantityMicro, minimum(polymarketAffordable, jupiterAffordable));
  const minimumJupiterQuantityMicro = minimumQuantityForGross(
    route.jupiterAsks,
    affordableQuantityMicro,
    config.jupiterMinimumGrossOrderMicroUsd,
    "jupiter",
  );
  if (minimumJupiterQuantityMicro === null) {
    return { eligible: false, reason: "JUPITER_MINIMUM_ORDER_UNREACHABLE" };
  }
  const minimumPolymarketQuantityMicro = minimumQuantityForGross(
    route.polymarketAsks,
    affordableQuantityMicro,
    config.polymarketMinimumGrossOrderMicroUsd,
    "polymarket",
  );
  if (minimumPolymarketQuantityMicro === null) {
    return { eligible: false, reason: "POLYMARKET_MINIMUM_ORDER_UNREACHABLE" };
  }
  const minimumQuantityMicro = maximum(
    config.polymarketMinimumContractsMicro,
    maximum(minimumJupiterQuantityMicro, minimumPolymarketQuantityMicro),
  );
  if (minimumQuantityMicro > affordableQuantityMicro) {
    return { eligible: false, reason: "JUPITER_MINIMUM_ORDER_UNREACHABLE" };
  }

  const proposal = largestQualifyingProposal({
    route,
    minimumQuantityMicro,
    maximumQuantityMicro: affordableQuantityMicro,
    config,
  });
  return proposal
    ? { eligible: true, proposal }
    : { eligible: false, reason: "ENTRY_EDGE_BELOW_MINIMUM" };
}

export function evaluateShortWindowExit(input: {
  polymarketBook: BinaryOrderBook;
  jupiterBook: BinaryOrderBook;
  polymarketOutcome: ShortWindowOutcome;
  jupiterOutcome: ShortWindowOutcome;
  quantityMicro: bigint;
  entryAllInCostMicroUsd: bigint;
  minimumExitProfitMicroUsd: bigint;
}): ExitEvaluation {
  const polymarketBids = sortedBids(input.polymarketBook, input.polymarketOutcome);
  const jupiterBids = sortedBids(input.jupiterBook, input.jupiterOutcome);
  if (polymarketBids.length === 0 || jupiterBids.length === 0) {
    return { eligible: false, reason: "MISSING_EXIT_BID", projectedProfitMicroUsd: null };
  }
  const polymarketQuote = quoteAcrossLevels(polymarketBids, input.quantityMicro, "polymarket", "sell");
  const jupiterQuote = quoteAcrossLevels(jupiterBids, input.quantityMicro, "jupiter", "sell");
  if (!polymarketQuote || !jupiterQuote) {
    return { eligible: false, reason: "INSUFFICIENT_EXIT_DEPTH", projectedProfitMicroUsd: null };
  }

  const polymarketGrossProceedsMicroUsd = polymarketQuote.grossMicroUsd;
  const jupiterGrossProceedsMicroUsd = jupiterQuote.grossMicroUsd;
  const polymarketTakerFeeMicroUsd = polymarketQuote.takerFeeMicroUsd;
  const jupiterTakerFeeMicroUsd = jupiterQuote.takerFeeMicroUsd;
  const netProceedsMicroUsd = polymarketGrossProceedsMicroUsd + jupiterGrossProceedsMicroUsd -
    polymarketTakerFeeMicroUsd - jupiterTakerFeeMicroUsd;
  const realizedProfitMicroUsd = netProceedsMicroUsd - input.entryAllInCostMicroUsd;
  if (realizedProfitMicroUsd < input.minimumExitProfitMicroUsd) {
    return { eligible: false, reason: "EXIT_NOT_GREEN", projectedProfitMicroUsd: realizedProfitMicroUsd };
  }
  return {
    eligible: true,
    proposal: {
      quantityMicro: input.quantityMicro,
      polymarketBid: {
        priceMicroUsd: polymarketQuote.limitPriceMicroUsd,
        contractsMicro: input.quantityMicro,
      },
      jupiterBid: {
        priceMicroUsd: jupiterQuote.limitPriceMicroUsd,
        contractsMicro: input.quantityMicro,
      },
      polymarketGrossProceedsMicroUsd,
      jupiterGrossProceedsMicroUsd,
      polymarketTakerFeeMicroUsd,
      jupiterTakerFeeMicroUsd,
      netProceedsMicroUsd,
      realizedProfitMicroUsd,
    },
  };
}

function largestQualifyingProposal(input: {
  route: EvaluatedCrossVenueRoute;
  minimumQuantityMicro: bigint;
  maximumQuantityMicro: bigint;
  config: ShortWindowStrategyConfig;
}): ShortWindowEntryProposal | null {
  let largest: ShortWindowEntryProposal | null = null;
  let segmentStart = input.minimumQuantityMicro;
  for (const segmentEnd of depthBreakpoints(input.route, segmentStart, input.maximumQuantityMicro)) {
    const startProposal = entryProposal(input.route, segmentStart);
    if (!meetsPerContractMinimum(startProposal, input.config)) return largest;

    let viableEnd = segmentEnd;
    const endProposal = entryProposal(input.route, segmentEnd);
    if (!meetsPerContractMinimum(endProposal, input.config)) {
      viableEnd = lastQuantityMeetingPerContractMinimum(
        input.route,
        segmentStart,
        segmentEnd,
        input.config,
      );
    }
    const viableProposal = entryProposal(input.route, viableEnd);
    if (meetsEntryMinimums(viableProposal, input.config)) {
      largest = viableProposal;
    }
    if (viableEnd < segmentEnd) return largest;
    if (viableProposal.nominalEdgeMicroUsd < startProposal.nominalEdgeMicroUsd) return largest;
    segmentStart = segmentEnd + CONTRACT_STEP_MICRO;
    if (segmentStart > input.maximumQuantityMicro) break;
  }
  return largest;
}

function entryProposal(route: EvaluatedCrossVenueRoute, quantityMicro: bigint): ShortWindowEntryProposal {
  const polymarket = requiredBuyQuote(route.polymarketAsks, quantityMicro, "polymarket");
  const jupiter = requiredBuyQuote(route.jupiterAsks, quantityMicro, "jupiter");
  const allInCostMicroUsd = polymarket.allInMicroUsd + jupiter.allInMicroUsd;
  const nominalPayoutMicroUsd = quantityMicro;
  const nominalEdgeMicroUsd = nominalPayoutMicroUsd - allInCostMicroUsd;
  return {
    route: route.route,
    quantityMicro,
    polymarket,
    jupiter,
    allInCostMicroUsd,
    nominalPayoutMicroUsd,
    nominalEdgeMicroUsd,
    edgeMicroUsdPerContract: nominalEdgeMicroUsd * ONE_CONTRACT_MICRO / quantityMicro,
  };
}

function meetsEntryMinimums(proposal: ShortWindowEntryProposal, config: ShortWindowStrategyConfig): boolean {
  return proposal.nominalEdgeMicroUsd >= config.minimumEntryEdgeTotalMicroUsd &&
    proposal.edgeMicroUsdPerContract >= config.minimumEntryEdgeMicroUsdPerContract &&
    proposal.polymarket.grossMicroUsd >= config.polymarketMinimumGrossOrderMicroUsd &&
    proposal.jupiter.grossMicroUsd >= config.jupiterMinimumGrossOrderMicroUsd;
}

function meetsPerContractMinimum(
  proposal: ShortWindowEntryProposal,
  config: ShortWindowStrategyConfig,
): boolean {
  return proposal.edgeMicroUsdPerContract >= config.minimumEntryEdgeMicroUsdPerContract;
}

export function quoteBuyAcrossLevels(
  levels: readonly BookLevel[],
  quantityMicro: bigint,
  venue: "polymarket" | "jupiter",
): VenueTradeCost | null {
  return quoteAcrossLevels(sortedLevels(levels, "buy"), quantityMicro, venue, "buy");
}

function maximumAffordableQuantity(
  levels: readonly BookLevel[],
  maximumQuantityMicro: bigint,
  budgetMicroUsd: bigint,
  venue: "polymarket" | "jupiter",
): bigint {
  let low = 0n;
  let high = maximumQuantityMicro / CONTRACT_STEP_MICRO;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const quote = quoteBuyAcrossLevels(levels, middle * CONTRACT_STEP_MICRO, venue);
    const cost = quote?.allInMicroUsd ?? budgetMicroUsd + 1n;
    if (cost <= budgetMicroUsd) low = middle;
    else high = middle - 1n;
  }
  return low * CONTRACT_STEP_MICRO;
}

function minimumQuantityForGross(
  levels: readonly BookLevel[],
  maximumQuantityMicro: bigint,
  minimumGrossMicroUsd: bigint,
  venue: "polymarket" | "jupiter",
): bigint | null {
  const maximumQuote = quoteBuyAcrossLevels(levels, maximumQuantityMicro, venue);
  if (!maximumQuote || maximumQuote.grossMicroUsd < minimumGrossMicroUsd) return null;
  let low = 0n;
  let high = maximumQuantityMicro / CONTRACT_STEP_MICRO;
  while (low < high) {
    const middle = (low + high) / 2n;
    const quote = quoteBuyAcrossLevels(levels, middle * CONTRACT_STEP_MICRO, venue);
    if (quote && quote.grossMicroUsd >= minimumGrossMicroUsd) high = middle;
    else low = middle + 1n;
  }
  return low * CONTRACT_STEP_MICRO;
}

function requiredBuyQuote(
  levels: readonly BookLevel[],
  quantityMicro: bigint,
  venue: "polymarket" | "jupiter",
): VenueTradeCost {
  const quote = quoteBuyAcrossLevels(levels, quantityMicro, venue);
  if (!quote) throw new Error(`Insufficient ${venue} depth for ${quantityMicro} micro-contracts`);
  return quote;
}

function quoteAcrossLevels(
  levels: readonly BookLevel[],
  quantityMicro: bigint,
  venue: "polymarket" | "jupiter",
  side: "buy" | "sell",
): VenueTradeCost | null {
  if (quantityMicro <= 0n) return null;
  let remaining = quantityMicro;
  let grossMicroUsd = 0n;
  let takerFeeMicroUsd = 0n;
  let limitPriceMicroUsd = 0n;
  let levelsConsumed = 0;
  for (const level of levels) {
    if (remaining <= 0n) break;
    if (level.contractsMicro <= 0n) continue;
    const consumed = minimum(remaining, level.contractsMicro);
    grossMicroUsd += tradeGrossMicroUsd(level.priceMicroUsd, consumed);
    takerFeeMicroUsd += venue === "polymarket"
      ? polymarketFeeTotal(level.priceMicroUsd, consumed)
      : level.takerFeeIncluded === true
        ? 0n
        : jupiterPredictionTakerFeeTotalMicroUsd(level.priceMicroUsd, consumed);
    limitPriceMicroUsd = level.priceMicroUsd;
    levelsConsumed += 1;
    remaining -= consumed;
  }
  if (remaining > 0n) return null;
  const priceMicroUsd = side === "buy"
    ? ceilDivide(grossMicroUsd * ONE_CONTRACT_MICRO, quantityMicro)
    : grossMicroUsd * ONE_CONTRACT_MICRO / quantityMicro;
  return {
    priceMicroUsd,
    limitPriceMicroUsd,
    levelsConsumed,
    quantityMicro,
    grossMicroUsd,
    takerFeeMicroUsd,
    allInMicroUsd: side === "buy"
      ? grossMicroUsd + takerFeeMicroUsd
      : grossMicroUsd - takerFeeMicroUsd,
  };
}

function lastQuantityMeetingPerContractMinimum(
  route: EvaluatedCrossVenueRoute,
  minimumQuantityMicro: bigint,
  maximumQuantityMicro: bigint,
  config: ShortWindowStrategyConfig,
): bigint {
  let low = minimumQuantityMicro / CONTRACT_STEP_MICRO;
  let high = maximumQuantityMicro / CONTRACT_STEP_MICRO;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (meetsPerContractMinimum(entryProposal(route, middle * CONTRACT_STEP_MICRO), config)) low = middle;
    else high = middle - 1n;
  }
  return low * CONTRACT_STEP_MICRO;
}

function depthBreakpoints(
  route: EvaluatedCrossVenueRoute,
  minimumQuantityMicro: bigint,
  maximumQuantityMicro: bigint,
): bigint[] {
  const points = new Set<bigint>([maximumQuantityMicro]);
  for (const levels of [route.polymarketAsks, route.jupiterAsks]) {
    let cumulative = 0n;
    for (const level of levels) {
      cumulative += level.contractsMicro;
      for (const point of [floorToStep(cumulative), ceilToStep(cumulative)]) {
        if (point >= minimumQuantityMicro && point <= maximumQuantityMicro) points.add(point);
      }
    }
  }
  return [...points].sort(compareBigint);
}

function polymarketFeeTotal(priceMicroUsd: bigint, quantityMicro: bigint): bigint {
  return divideRoundNearest(
    polymarketCryptoTakerFeePerContractMicroUsd(priceMicroUsd) * quantityMicro,
    ONE_CONTRACT_MICRO,
  );
}

function tradeGrossMicroUsd(priceMicroUsd: bigint, quantityMicro: bigint): bigint {
  return divideRoundNearest(priceMicroUsd * quantityMicro, ONE_CONTRACT_MICRO);
}

function sortedBids(book: BinaryOrderBook, outcome: ShortWindowOutcome): BookLevel[] {
  const levels = outcome === "UP" ? book.yes.bids : book.no.bids;
  return sortedLevels(levels, "sell");
}

function sortedLevels(levels: readonly BookLevel[], side: "buy" | "sell"): BookLevel[] {
  return levels
    .filter((level) =>
      level.contractsMicro > 0n && level.priceMicroUsd >= 0n && level.priceMicroUsd <= ONE_USD_MICRO
    )
    .sort((left, right) => side === "buy"
      ? compareBigint(left.priceMicroUsd, right.priceMicroUsd)
      : compareBigint(right.priceMicroUsd, left.priceMicroUsd));
}

function floorToStep(value: bigint): bigint {
  return value / CONTRACT_STEP_MICRO * CONTRACT_STEP_MICRO;
}

function ceilToStep(value: bigint): bigint {
  return ceilDivide(value, CONTRACT_STEP_MICRO) * CONTRACT_STEP_MICRO;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Cannot divide by a non-positive value");
  return (numerator + denominator - 1n) / denominator;
}

function divideRoundNearest(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
