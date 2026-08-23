import { formatContracts, formatUsd } from "../../../packages/domain/src/fixed.ts";
import {
  evaluateShortWindowEntry,
  evaluateShortWindowExit,
  type EntryEvaluation,
  type ShortWindowEntryProposal,
  type ShortWindowExitProposal,
  type ShortWindowStrategyConfig,
} from "../../../packages/domain/src/short-window-strategy.ts";
import type { EvaluatedCrossVenueRoute, ShortWindowOutcome } from "../../../packages/domain/src/short-window.ts";
import type { BinaryOrderBook } from "../../../packages/domain/src/types.ts";

export type PaperPositionStatus = "open" | "awaiting_resolution";

export interface PaperPairIdentity {
  key: string;
  duration: "5m" | "15m";
  startMs: number;
  endMs: number;
  polymarketSlug: string;
  polymarketMarketId: string;
  jupiterSelectedMarketId: string;
}

export interface PaperPosition {
  id: string;
  pair: PaperPairIdentity;
  status: PaperPositionStatus;
  enteredAtMs: number;
  polymarketOutcome: ShortWindowOutcome;
  jupiterOutcome: ShortWindowOutcome;
  quantityMicro: bigint;
  polymarketEntryCostMicroUsd: bigint;
  jupiterEntryCostMicroUsd: bigint;
  entryAllInCostMicroUsd: bigint;
  nominalEntryEdgeMicroUsd: bigint;
}

export type PaperDecision =
  | { type: "entry"; position: PaperPosition; proposal: ShortWindowEntryProposal }
  | { type: "exit"; position: PaperPosition; proposal: ShortWindowExitProposal }
  | { type: "hold"; position: PaperPosition; projectedProfitMicroUsd: bigint | null; reason: string }
  | { type: "skip"; reason: string; entryEvaluation?: EntryEvaluation };

export interface PaperSettlement {
  position: PaperPosition;
  polymarketWon: boolean;
  jupiterWon: boolean;
  polymarketPayoutMicroUsd: bigint;
  jupiterPayoutMicroUsd: bigint;
  totalPayoutMicroUsd: bigint;
  realizedProfitMicroUsd: bigint;
}

export class ShortWindowPaperTrader {
  readonly #config: ShortWindowStrategyConfig;
  readonly #maximumOpenPositions: number;
  readonly #entryCutoffMs: Readonly<Record<"5m" | "15m", number>>;
  readonly #positions = new Map<string, PaperPosition>();
  readonly #completedPairs = new Set<string>();
  #polymarketCashMicroUsd: bigint;
  #jupiterCashMicroUsd: bigint;
  #realizedProfitMicroUsd = 0n;
  #positionSequence = 0;
  #lastAction = "Waiting for a qualified route.";

  constructor(input: {
    polymarketStartingCashMicroUsd: bigint;
    jupiterStartingCashMicroUsd: bigint;
    strategy: ShortWindowStrategyConfig;
    maximumOpenPositions?: number;
    fiveMinuteEntryCutoffMs?: number;
    fifteenMinuteEntryCutoffMs?: number;
  }) {
    this.#polymarketCashMicroUsd = input.polymarketStartingCashMicroUsd;
    this.#jupiterCashMicroUsd = input.jupiterStartingCashMicroUsd;
    this.#config = input.strategy;
    this.#maximumOpenPositions = input.maximumOpenPositions ?? 2;
    this.#entryCutoffMs = {
      "5m": input.fiveMinuteEntryCutoffMs ?? 30_000,
      "15m": input.fifteenMinuteEntryCutoffMs ?? 30_000,
    };
  }

  consider(input: {
    pair: PaperPairIdentity;
    bestRoute: EvaluatedCrossVenueRoute | null;
    polymarketBook: BinaryOrderBook;
    jupiterBook: BinaryOrderBook;
    atMs: number;
  }): PaperDecision {
    const existing = this.#positions.get(input.pair.key);
    if (existing?.status === "open") {
      const exit = evaluateShortWindowExit({
        polymarketBook: input.polymarketBook,
        jupiterBook: input.jupiterBook,
        polymarketOutcome: existing.polymarketOutcome,
        jupiterOutcome: existing.jupiterOutcome,
        quantityMicro: existing.quantityMicro,
        entryAllInCostMicroUsd: existing.entryAllInCostMicroUsd,
        minimumExitProfitMicroUsd: this.#config.minimumExitProfitMicroUsd,
      });
      if (!exit.eligible) {
        return {
          type: "hold",
          position: existing,
          projectedProfitMicroUsd: exit.projectedProfitMicroUsd,
          reason: exit.reason,
        };
      }
      this.#polymarketCashMicroUsd += exit.proposal.polymarketGrossProceedsMicroUsd -
        exit.proposal.polymarketTakerFeeMicroUsd;
      this.#jupiterCashMicroUsd += exit.proposal.jupiterGrossProceedsMicroUsd -
        exit.proposal.jupiterTakerFeeMicroUsd;
      this.#realizedProfitMicroUsd += exit.proposal.realizedProfitMicroUsd;
      this.#positions.delete(input.pair.key);
      this.#completedPairs.add(input.pair.key);
      this.#lastAction = `Exited ${existing.pair.duration} position green for $${formatUsd(exit.proposal.realizedProfitMicroUsd)}.`;
      return { type: "exit", position: existing, proposal: exit.proposal };
    }

    if (this.#completedPairs.has(input.pair.key)) {
      return { type: "skip", reason: "PAIR_ALREADY_TRADED" };
    }

    if (this.#positions.size >= this.#maximumOpenPositions) {
      return { type: "skip", reason: "MAXIMUM_OPEN_POSITIONS" };
    }
    if (input.pair.endMs - input.atMs <= this.#entryCutoffMs[input.pair.duration]) {
      return { type: "skip", reason: "ENTRY_CUTOFF_REACHED" };
    }
    const entry = evaluateShortWindowEntry({
      route: input.bestRoute,
      polymarketAvailableMicroUsd: this.#polymarketCashMicroUsd,
      jupiterAvailableMicroUsd: this.#jupiterCashMicroUsd,
      config: this.#config,
    });
    if (!entry.eligible) return { type: "skip", reason: entry.reason, entryEvaluation: entry };

    const position: PaperPosition = {
      id: `paper-${++this.#positionSequence}`,
      pair: input.pair,
      status: "open",
      enteredAtMs: input.atMs,
      polymarketOutcome: entry.proposal.route.polymarketOutcome,
      jupiterOutcome: entry.proposal.route.jupiterOutcome,
      quantityMicro: entry.proposal.quantityMicro,
      polymarketEntryCostMicroUsd: entry.proposal.polymarket.allInMicroUsd,
      jupiterEntryCostMicroUsd: entry.proposal.jupiter.allInMicroUsd,
      entryAllInCostMicroUsd: entry.proposal.allInCostMicroUsd,
      nominalEntryEdgeMicroUsd: entry.proposal.nominalEdgeMicroUsd,
    };
    this.#polymarketCashMicroUsd -= position.polymarketEntryCostMicroUsd;
    this.#jupiterCashMicroUsd -= position.jupiterEntryCostMicroUsd;
    this.#positions.set(input.pair.key, position);
    this.#lastAction = `Paper entry ${position.pair.duration}: ${formatContracts(position.quantityMicro)} contracts, ` +
      `$${formatUsd(position.entryAllInCostMicroUsd)} all-in.`;
    return { type: "entry", position, proposal: entry.proposal };
  }

  markPairEnded(pairKey: string): PaperPosition | null {
    const position = this.#positions.get(pairKey);
    if (!position || position.status !== "open") return null;
    position.status = "awaiting_resolution";
    this.#lastAction = `${position.pair.duration} position did not exit green; awaiting both venue results.`;
    return position;
  }

  awaitingResolution(): PaperPosition[] {
    return [...this.#positions.values()].filter((position) => position.status === "awaiting_resolution");
  }

  settle(pairKey: string, polymarketWon: boolean, jupiterWon: boolean): PaperSettlement | null {
    const position = this.#positions.get(pairKey);
    if (!position || position.status !== "awaiting_resolution") return null;
    const polymarketPayoutMicroUsd = polymarketWon ? position.quantityMicro : 0n;
    const jupiterPayoutMicroUsd = jupiterWon ? position.quantityMicro : 0n;
    const totalPayoutMicroUsd = polymarketPayoutMicroUsd + jupiterPayoutMicroUsd;
    const realizedProfitMicroUsd = totalPayoutMicroUsd - position.entryAllInCostMicroUsd;
    this.#polymarketCashMicroUsd += polymarketPayoutMicroUsd;
    this.#jupiterCashMicroUsd += jupiterPayoutMicroUsd;
    this.#realizedProfitMicroUsd += realizedProfitMicroUsd;
    this.#positions.delete(pairKey);
    this.#completedPairs.add(pairKey);
    this.#lastAction = `Resolved ${position.pair.duration} position for $${formatUsd(realizedProfitMicroUsd)} P&L.`;
    return {
      position,
      polymarketWon,
      jupiterWon,
      polymarketPayoutMicroUsd,
      jupiterPayoutMicroUsd,
      totalPayoutMicroUsd,
      realizedProfitMicroUsd,
    };
  }

  snapshot(): {
    polymarketCashUsd: string;
    jupiterCashUsd: string;
    realizedProfitUsd: string;
    openPositions: number;
    awaitingResolution: number;
    lastAction: string;
  } {
    return {
      polymarketCashUsd: formatUsd(this.#polymarketCashMicroUsd),
      jupiterCashUsd: formatUsd(this.#jupiterCashMicroUsd),
      realizedProfitUsd: formatUsd(this.#realizedProfitMicroUsd),
      openPositions: this.#positions.size,
      awaitingResolution: this.awaitingResolution().length,
      lastAction: this.#lastAction,
    };
  }
}
