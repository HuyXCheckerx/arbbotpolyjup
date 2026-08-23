import { ONE_CONTRACT_MICRO, ONE_USD_MICRO } from "./fixed.ts";
import type { BinaryOrderBook, BookLevel } from "./types.ts";

const FEE_RATE_NUMERATOR = 7n;
const FEE_RATE_DENOMINATOR = 100n;
const POLYMARKET_FEE_ROUNDING_MICRO_USD = 10n;
const JUPITER_ORDER_FEE_ROUNDING_MICRO_USD = 10_000n;

export type ShortWindowOutcome = "UP" | "DOWN";

export interface CrossVenueShortWindowRoute {
  polymarketOutcome: ShortWindowOutcome;
  jupiterOutcome: ShortWindowOutcome;
  reason:
    | "POLYMARKET_REFERENCE_LOWER"
    | "POLYMARKET_REFERENCE_HIGHER"
    | "REFERENCES_EQUAL"
    | "ANY_COMPLEMENTARY_ROUTE";
}

export interface EvaluatedCrossVenueRoute {
  route: CrossVenueShortWindowRoute;
  polymarketAsk: BookLevel;
  jupiterAsk: BookLevel;
  polymarketAsks: readonly BookLevel[];
  jupiterAsks: readonly BookLevel[];
  commonTopContractsMicro: bigint;
  commonDepthContractsMicro: bigint;
  grossCostTotalMicroUsd: bigint;
  polymarketTakerFeeTotalMicroUsd: bigint;
  jupiterTakerFeeTotalMicroUsd: bigint;
  takerFeeTotalMicroUsd: bigint;
  allInCostTotalMicroUsd: bigint;
  nominalComplementaryPayoutTotalMicroUsd: bigint;
  nominalEdgeTotalMicroUsd: bigint;
  effectiveAllInMicroUsdPerContract: bigint;
  effectiveEdgeMicroUsdPerContract: bigint;
  isFeeAdjustedCandidate: boolean;
}

export function referencePricesWithin(
  polymarketReferenceMicroUsd: bigint,
  jupiterReferenceMicroUsd: bigint,
  maximumDifferenceMicroUsd: bigint,
): boolean {
  return absolute(polymarketReferenceMicroUsd - jupiterReferenceMicroUsd) < maximumDifferenceMicroUsd;
}

export function referenceDifferenceMicroUsd(
  polymarketReferenceMicroUsd: bigint,
  jupiterReferenceMicroUsd: bigint,
): bigint {
  return absolute(polymarketReferenceMicroUsd - jupiterReferenceMicroUsd);
}

export function eligibleCrossVenueRoutes(
  polymarketReferenceMicroUsd: bigint,
  jupiterReferenceMicroUsd: bigint,
): readonly CrossVenueShortWindowRoute[] {
  if (polymarketReferenceMicroUsd < jupiterReferenceMicroUsd) {
    return [{
      polymarketOutcome: "UP",
      jupiterOutcome: "DOWN",
      reason: "POLYMARKET_REFERENCE_LOWER",
    }];
  }
  if (polymarketReferenceMicroUsd > jupiterReferenceMicroUsd) {
    return [{
      polymarketOutcome: "DOWN",
      jupiterOutcome: "UP",
      reason: "POLYMARKET_REFERENCE_HIGHER",
    }];
  }
  return [
    { polymarketOutcome: "UP", jupiterOutcome: "DOWN", reason: "REFERENCES_EQUAL" },
    { polymarketOutcome: "DOWN", jupiterOutcome: "UP", reason: "REFERENCES_EQUAL" },
  ];
}

export function allComplementaryCrossVenueRoutes(): readonly CrossVenueShortWindowRoute[] {
  return [
    { polymarketOutcome: "UP", jupiterOutcome: "DOWN", reason: "ANY_COMPLEMENTARY_ROUTE" },
    { polymarketOutcome: "DOWN", jupiterOutcome: "UP", reason: "ANY_COMPLEMENTARY_ROUTE" },
  ];
}

export function polymarketCryptoTakerFeePerContractMicroUsd(priceMicroUsd: bigint): bigint {
  assertBinaryPrice(priceMicroUsd);
  const numerator = priceMicroUsd * (ONE_USD_MICRO - priceMicroUsd) * FEE_RATE_NUMERATOR;
  const denominator = FEE_RATE_DENOMINATOR * ONE_USD_MICRO;
  return roundRationalToMultiple(numerator, denominator, POLYMARKET_FEE_ROUNDING_MICRO_USD);
}

export function jupiterPredictionTakerFeeTotalMicroUsd(
  priceMicroUsd: bigint,
  contractsMicro: bigint,
): bigint {
  assertBinaryPrice(priceMicroUsd);
  if (contractsMicro < 0n) throw new Error(`Contract quantity is negative: ${contractsMicro}`);
  if (contractsMicro === 0n || priceMicroUsd === 0n || priceMicroUsd === ONE_USD_MICRO) return 0n;
  const numerator = priceMicroUsd * (ONE_USD_MICRO - priceMicroUsd) * FEE_RATE_NUMERATOR * contractsMicro;
  const denominator = FEE_RATE_DENOMINATOR * ONE_USD_MICRO * ONE_CONTRACT_MICRO;
  return ceilRationalToMultiple(numerator, denominator, JUPITER_ORDER_FEE_ROUNDING_MICRO_USD);
}

export function evaluateCrossVenueRoutes(
  polymarketBook: BinaryOrderBook,
  jupiterBook: BinaryOrderBook,
  routes: readonly CrossVenueShortWindowRoute[],
): readonly EvaluatedCrossVenueRoute[] {
  const evaluated: EvaluatedCrossVenueRoute[] = [];
  for (const route of routes) {
    const polymarketAsks = sortedAsks(polymarketBook, route.polymarketOutcome);
    const jupiterAsks = sortedAsks(jupiterBook, route.jupiterOutcome);
    const polymarketAsk = polymarketAsks[0] ?? null;
    const jupiterAsk = jupiterAsks[0] ?? null;
    if (!polymarketAsk || !jupiterAsk) continue;
    const commonTopContractsMicro = minimum(polymarketAsk.contractsMicro, jupiterAsk.contractsMicro);
    if (commonTopContractsMicro <= 0n) continue;
    const commonDepthContractsMicro = minimum(totalContracts(polymarketAsks), totalContracts(jupiterAsks));

    const grossCostPerContractMicroUsd = polymarketAsk.priceMicroUsd + jupiterAsk.priceMicroUsd;
    const grossCostTotalMicroUsd = divideRoundNearest(
      grossCostPerContractMicroUsd * commonTopContractsMicro,
      ONE_CONTRACT_MICRO,
    );
    const polymarketTakerFeeTotalMicroUsd = divideRoundNearest(
      polymarketCryptoTakerFeePerContractMicroUsd(polymarketAsk.priceMicroUsd) * commonTopContractsMicro,
      ONE_CONTRACT_MICRO,
    );
    const jupiterTakerFeeTotalMicroUsd = jupiterAsk.takerFeeIncluded === true
      ? 0n
      : jupiterPredictionTakerFeeTotalMicroUsd(
        jupiterAsk.priceMicroUsd,
        commonTopContractsMicro,
      );
    const takerFeeTotalMicroUsd = polymarketTakerFeeTotalMicroUsd + jupiterTakerFeeTotalMicroUsd;
    const allInCostTotalMicroUsd = grossCostTotalMicroUsd + takerFeeTotalMicroUsd;
    const nominalComplementaryPayoutTotalMicroUsd = commonTopContractsMicro;
    const nominalEdgeTotalMicroUsd = nominalComplementaryPayoutTotalMicroUsd - allInCostTotalMicroUsd;
    const effectiveAllInMicroUsdPerContract = allInCostTotalMicroUsd * ONE_CONTRACT_MICRO / commonTopContractsMicro;
    const effectiveEdgeMicroUsdPerContract = nominalEdgeTotalMicroUsd * ONE_CONTRACT_MICRO / commonTopContractsMicro;

    evaluated.push({
      route,
      polymarketAsk,
      jupiterAsk,
      polymarketAsks,
      jupiterAsks,
      commonTopContractsMicro,
      commonDepthContractsMicro,
      grossCostTotalMicroUsd,
      polymarketTakerFeeTotalMicroUsd,
      jupiterTakerFeeTotalMicroUsd,
      takerFeeTotalMicroUsd,
      allInCostTotalMicroUsd,
      nominalComplementaryPayoutTotalMicroUsd,
      nominalEdgeTotalMicroUsd,
      effectiveAllInMicroUsdPerContract,
      effectiveEdgeMicroUsdPerContract,
      isFeeAdjustedCandidate: nominalEdgeTotalMicroUsd > 0n,
    });
  }
  return evaluated.sort((left, right) => compareBigint(right.nominalEdgeTotalMicroUsd, left.nominalEdgeTotalMicroUsd));
}

function sortedAsks(book: BinaryOrderBook, outcome: ShortWindowOutcome): BookLevel[] {
  const levels = outcome === "UP" ? book.yes.asks : book.no.asks;
  return levels
    .filter((level) => level.contractsMicro > 0n && level.priceMicroUsd >= 0n && level.priceMicroUsd <= ONE_USD_MICRO)
    .sort((left, right) => compareBigint(left.priceMicroUsd, right.priceMicroUsd));
}

function totalContracts(levels: readonly BookLevel[]): bigint {
  return levels.reduce((total, level) => total + level.contractsMicro, 0n);
}

function assertBinaryPrice(priceMicroUsd: bigint): void {
  if (priceMicroUsd < 0n || priceMicroUsd > ONE_USD_MICRO) {
    throw new Error(`Binary price is outside $0-$1: ${priceMicroUsd}`);
  }
}

function roundRationalToMultiple(numerator: bigint, denominator: bigint, multiple: bigint): bigint {
  const scaledDenominator = denominator * multiple;
  return ((numerator + scaledDenominator / 2n) / scaledDenominator) * multiple;
}

function ceilRationalToMultiple(numerator: bigint, denominator: bigint, multiple: bigint): bigint {
  const scaledDenominator = denominator * multiple;
  return ((numerator + scaledDenominator - 1n) / scaledDenominator) * multiple;
}

function divideRoundNearest(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
