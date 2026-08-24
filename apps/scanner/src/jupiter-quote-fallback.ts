import { ONE_CONTRACT_MICRO, ONE_USD_MICRO } from "../../../packages/domain/src/fixed.ts";
import type { ShortWindowOutcome } from "../../../packages/domain/src/short-window.ts";
import type { BinaryOrderBook, BookLevel, VenueMarket } from "../../../packages/domain/src/types.ts";
import type { JupiterPredictionOrderBuild } from "../../../packages/venue-jupiter/src/client.ts";
import type { JupiterPredictionPriceUpdate } from "../../../packages/venue-jupiter/src/price-stream.ts";

const CONTRACT_STEP_MICRO = 10_000n;

export function initialJupiterRollingQuoteGross(
  minimumGrossMicroUsd: bigint,
  maximumScreeningGrossMicroUsd: bigint,
): bigint {
  if (minimumGrossMicroUsd <= 0n || maximumScreeningGrossMicroUsd <= 0n) {
    throw new Error("Jupiter rolling quote gross limits must be positive");
  }
  return minimumGrossMicroUsd < maximumScreeningGrossMicroUsd
    ? minimumGrossMicroUsd
    : maximumScreeningGrossMicroUsd;
}

export function jupiterRollingQuoteRetryDelayMs(
  baseIntervalMs: number,
  consecutiveErrors: number,
): number {
  if (!Number.isInteger(baseIntervalMs) || baseIntervalMs < 1) {
    throw new Error("Jupiter rolling quote base interval must be a positive integer");
  }
  const exponent = Math.min(Math.max(1, Math.trunc(consecutiveErrors)), 6);
  return Math.min(10_000, baseIntervalMs * (2 ** exponent));
}

export interface JupiterBuyQuoteGateway {
  prepareBuy(input: {
    marketId: string;
    depositAmountMicroUsd: bigint;
    outcomeMint?: string;
  }): Promise<JupiterPredictionOrderBuild>;
}

export interface JupiterMarketPricingGateway {
  getMarket(marketId: string): Promise<VenueMarket>;
}

export interface JupiterOrderBookGateway {
  getOrderBook(marketId: string): Promise<BinaryOrderBook>;
}

export interface JupiterAtomicQuoteBook {
  book: BinaryOrderBook;
  builds: ReadonlyMap<ShortWindowOutcome, JupiterPredictionOrderBuild>;
}

export interface JupiterRollingAtomicQuoteSnapshot extends JupiterAtomicQuoteBook {
  buildAtMs: ReadonlyMap<ShortWindowOutcome, number>;
}

interface RollingAtomicQuote {
  sequence: number;
  build: JupiterPredictionOrderBuild;
  builtAtMs: number;
}

/**
 * Retains only the newest completed executable quote for each Forecast outcome.
 * Several quote requests are intentionally allowed in flight at once; the
 * monotonically increasing request sequence prevents a slower old response
 * from replacing a newer transaction.
 */
export class JupiterRollingAtomicQuoteBookState {
  readonly #upMarketId: string;
  readonly #downMarketId: string;
  readonly #outcomes: readonly ShortWindowOutcome[];
  readonly #quotes = new Map<ShortWindowOutcome, RollingAtomicQuote>();

  constructor(input: {
    upMarketId: string;
    downMarketId: string;
    outcomes: readonly ShortWindowOutcome[];
  }) {
    this.#upMarketId = input.upMarketId;
    this.#downMarketId = input.downMarketId;
    this.#outcomes = [...new Set(input.outcomes)];
    if (this.#outcomes.length === 0) throw new Error("Jupiter rolling quote state has no selected outcome");
  }

  apply(input: {
    outcome: ShortWindowOutcome;
    sequence: number;
    build: JupiterPredictionOrderBuild;
    builtAtMs: number;
    maximumAgeMs: number;
  }): JupiterRollingAtomicQuoteSnapshot | null {
    if (!this.#outcomes.includes(input.outcome)) return null;
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
      throw new Error("Jupiter rolling quote sequence must be a positive safe integer");
    }
    if (!Number.isFinite(input.builtAtMs) || input.builtAtMs < 0) {
      throw new Error("Jupiter rolling quote timestamp must be non-negative");
    }
    if (!Number.isInteger(input.maximumAgeMs) || input.maximumAgeMs < 0) {
      throw new Error("Jupiter rolling quote maximum age must be a non-negative integer");
    }
    const marketId = this.#marketId(input.outcome);
    validateBuild(input.build, marketId, input.build.order.orderCostMicroUsd);
    const current = this.#quotes.get(input.outcome);
    if (current && current.sequence >= input.sequence) return null;
    this.#quotes.set(input.outcome, {
      sequence: input.sequence,
      build: input.build,
      builtAtMs: input.builtAtMs,
    });
    return this.snapshot(input.builtAtMs, input.maximumAgeMs);
  }

  snapshot(atMs: number, maximumAgeMs: number): JupiterRollingAtomicQuoteSnapshot | null {
    const active = this.#outcomes.flatMap((outcome) => {
      const quote = this.#quotes.get(outcome);
      if (!quote) return [];
      const ageMs = atMs - quote.builtAtMs;
      return ageMs >= 0 && ageMs <= maximumAgeMs ? [{ outcome, quote }] : [];
    });
    if (active.length === 0) return null;
    const builds = new Map<ShortWindowOutcome, JupiterPredictionOrderBuild>();
    const buildAtMs = new Map<ShortWindowOutcome, number>();
    const yesAsks: BookLevel[] = [];
    const noAsks: BookLevel[] = [];
    for (const { outcome, quote } of active) {
      builds.set(outcome, quote.build);
      buildAtMs.set(outcome, quote.builtAtMs);
      (outcome === "UP" ? yesAsks : noAsks).push(quoteLevel(quote.build));
    }
    return {
      book: {
        venue: "jupiter",
        provider: "bisonfi_atomic_quote",
        marketId: active.map(({ outcome }) => this.#marketId(outcome)).join("|"),
        // The oldest included side controls composite freshness. This prevents
        // a new UP response from making an older DOWN build appear new.
        receivedAtMs: Math.min(...active.map(({ quote }) => quote.builtAtMs)),
        sourceTimestampMs: null,
        yes: { bids: [], asks: yesAsks },
        no: { bids: [], asks: noAsks },
      },
      builds,
      buildAtMs,
    };
  }

  #marketId(outcome: ShortWindowOutcome): string {
    return outcome === "UP" ? this.#upMarketId : this.#downMarketId;
  }
}

/**
 * Converts Jupiter's public Degen price websocket into the logical UP/DOWN
 * book used by the short-window strategy. The socket exposes top prices but
 * not executable depth, so each side is capped to the configured screening
 * gross; the live trader still requires a fresh atomic `/order` build before
 * it can submit either venue.
 */
export class JupiterPredictionPriceBookState {
  readonly #upMarketId: string;
  readonly #downMarketId: string;
  readonly #outcomes: readonly ShortWindowOutcome[];
  readonly #grossAmountMicroUsd: bigint;
  readonly #updates = new Map<string, JupiterPredictionPriceUpdate>();

  constructor(input: {
    upMarketId: string;
    downMarketId: string;
    outcomes: readonly ShortWindowOutcome[];
    grossAmountMicroUsd: bigint;
  }) {
    this.#upMarketId = input.upMarketId;
    this.#downMarketId = input.downMarketId;
    this.#outcomes = [...new Set(input.outcomes)];
    this.#grossAmountMicroUsd = input.grossAmountMicroUsd;
    if (this.#outcomes.length === 0) throw new Error("Jupiter price stream has no selected outcome");
    if (this.#grossAmountMicroUsd <= 0n) throw new Error("Jupiter price stream screening gross must be positive");
  }

  marketIds(): readonly string[] {
    return this.#outcomes.map((outcome) => this.#marketId(outcome));
  }

  apply(update: JupiterPredictionPriceUpdate): BinaryOrderBook | null {
    if (!this.marketIds().includes(update.marketId)) return null;
    this.#updates.set(update.marketId, update);

    const yes = this.#logicalSide("UP");
    const no = this.#logicalSide("DOWN");
    const updates = this.#outcomes
      .map((outcome) => this.#updates.get(this.#marketId(outcome)))
      .filter((value): value is JupiterPredictionPriceUpdate => value !== undefined);
    return {
      venue: "jupiter",
      provider: "bisonfi_price_websocket",
      marketId: this.marketIds().join("|"),
      // The oldest included ticker controls composite freshness. A new UP
      // message must not make an old DOWN quote safe for route selection (or
      // vice versa).
      receivedAtMs: Math.min(...updates.map((value) => value.receivedAtMs)),
      sourceTimestampMs: Math.min(...updates.map((value) => value.sourceTimestampMs)),
      yes,
      no,
    };
  }

  #logicalSide(outcome: ShortWindowOutcome): { bids: BookLevel[]; asks: BookLevel[] } {
    if (!this.#outcomes.includes(outcome)) return { bids: [], asks: [] };
    const update = this.#updates.get(this.#marketId(outcome));
    if (!update) return { bids: [], asks: [] };
    return {
      // The top-price socket does not include bid depth. Keep entry discovery
      // ask-only so an open position can never be exited against synthetic
      // liquidity; the monitor switches to Jupiter's REST orderbook for exits.
      bids: [],
      asks: priceLevel(update.yesAskMicroUsd, this.#grossAmountMicroUsd),
    };
  }

  #marketId(outcome: ShortWindowOutcome): string {
    return outcome === "UP" ? this.#upMarketId : this.#downMarketId;
  }
}

/**
 * Forecast models UP and DOWN as separate YES-only markets. Query the market
 * selected by the reference-dominance route and map that market's YES book to
 * the scanner's logical UP/DOWN side. Treating the NO side of the UP market as
 * the DOWN market produces incorrect prices and needlessly fails whenever the
 * unselected UP market is unavailable.
 */
export async function buildJupiterForecastOrderBook(input: {
  gateway: JupiterOrderBookGateway;
  upMarketId: string;
  downMarketId: string;
  outcomes: readonly ShortWindowOutcome[];
}): Promise<BinaryOrderBook> {
  const outcomes = [...new Set(input.outcomes)];
  if (outcomes.length === 0) throw new Error("Jupiter Forecast orderbook has no selected outcome");
  const fetched = await Promise.all(outcomes.map(async (outcome) => {
    const marketId = outcome === "UP" ? input.upMarketId : input.downMarketId;
    const book = await input.gateway.getOrderBook(marketId);
    if (book.marketId !== marketId) {
      throw new Error(`Jupiter orderbook identity ${book.marketId} differs from selected market ${marketId}`);
    }
    return { outcome, marketId, book };
  }));
  const up = fetched.find((value) => value.outcome === "UP") ?? null;
  const down = fetched.find((value) => value.outcome === "DOWN") ?? null;
  const receivedAtMs = Math.max(...fetched.map((value) => value.book.receivedAtMs));
  return {
    venue: "jupiter",
    provider: "bisonfi",
    marketId: fetched.map((value) => value.marketId).join("|"),
    receivedAtMs,
    sourceTimestampMs: null,
    yes: up?.book.yes ?? { bids: [], asks: [] },
    no: down?.book.yes ?? { bids: [], asks: [] },
  };
}

export async function buildJupiterMarketPricingBook(input: {
  gateway: JupiterMarketPricingGateway;
  upMarketId: string;
  downMarketId: string;
  outcomes: readonly ShortWindowOutcome[];
  grossAmountMicroUsd: bigint;
}): Promise<BinaryOrderBook> {
  const outcomes = [...new Set(input.outcomes)];
  if (outcomes.length === 0) throw new Error("Jupiter market-price fallback has no selected outcome");
  const quoted = await Promise.all(outcomes.map(async (outcome) => {
    const marketId = outcome === "UP" ? input.upMarketId : input.downMarketId;
    const market = await input.gateway.getMarket(marketId);
    const priceMicroUsd = market.pricing.buyYesMicroUsd;
    if (market.marketId !== marketId || priceMicroUsd === null ||
      priceMicroUsd <= 0n || priceMicroUsd >= ONE_USD_MICRO) {
      throw new Error(`Jupiter market ${marketId} has no valid indicative buy price`);
    }
    const quantityMicro = ceilDivide(
      input.grossAmountMicroUsd * ONE_CONTRACT_MICRO,
      priceMicroUsd,
    );
    return {
      outcome,
      level: {
        priceMicroUsd,
        contractsMicro: ceilDivide(quantityMicro, CONTRACT_STEP_MICRO) * CONTRACT_STEP_MICRO,
      } satisfies BookLevel,
    };
  }));
  const yesAsks: BookLevel[] = [];
  const noAsks: BookLevel[] = [];
  for (const value of quoted) (value.outcome === "UP" ? yesAsks : noAsks).push(value.level);
  return {
    venue: "jupiter",
    provider: "bisonfi_market_pricing",
    marketId: outcomes.length === 1
      ? (outcomes[0] === "UP" ? input.upMarketId : input.downMarketId)
      : `${input.upMarketId}|${input.downMarketId}`,
    receivedAtMs: Date.now(),
    sourceTimestampMs: null,
    yes: { bids: [], asks: yesAsks },
    no: { bids: [], asks: noAsks },
  };
}

/**
 * Builds an entry-only book from Jupiter's unsigned atomic-swap quotes.
 * No transaction is signed or submitted. The quote is authoritative for its
 * exact gross amount, unlike the occasionally unavailable indicative ladder.
 */
export async function buildJupiterAtomicQuoteBook(input: {
  gateway: JupiterBuyQuoteGateway;
  upMarketId: string;
  downMarketId: string;
  upOutcomeMint?: string | null;
  downOutcomeMint?: string | null;
  outcomes: readonly ShortWindowOutcome[];
  grossAmountMicroUsd: bigint;
}): Promise<JupiterAtomicQuoteBook> {
  const outcomes = [...new Set(input.outcomes)];
  if (outcomes.length === 0) throw new Error("Jupiter fallback quote has no selected outcome");
  const quoted = await Promise.all(outcomes.map(async (outcome) => {
    const marketId = outcome === "UP" ? input.upMarketId : input.downMarketId;
    const outcomeMint = outcome === "UP" ? input.upOutcomeMint : input.downOutcomeMint;
    const build = await input.gateway.prepareBuy({
      marketId,
      depositAmountMicroUsd: input.grossAmountMicroUsd,
      ...(outcomeMint ? { outcomeMint } : {}),
    });
    validateBuild(build, marketId, input.grossAmountMicroUsd);
    return { outcome, build, level: quoteLevel(build) };
  }));
  const builds = new Map<ShortWindowOutcome, JupiterPredictionOrderBuild>();
  const yesAsks: BookLevel[] = [];
  const noAsks: BookLevel[] = [];
  for (const value of quoted) {
    builds.set(value.outcome, value.build);
    (value.outcome === "UP" ? yesAsks : noAsks).push(value.level);
  }
  return {
    book: {
      venue: "jupiter",
      provider: "bisonfi_atomic_quote",
      marketId: outcomes.length === 1
        ? (outcomes[0] === "UP" ? input.upMarketId : input.downMarketId)
        : `${input.upMarketId}|${input.downMarketId}`,
      receivedAtMs: Date.now(),
      sourceTimestampMs: null,
      yes: { bids: [], asks: yesAsks },
      no: { bids: [], asks: noAsks },
    },
    builds,
  };
}

function validateBuild(
  build: JupiterPredictionOrderBuild,
  marketId: string,
  requestedGrossMicroUsd: bigint,
): void {
  if (build.order.marketId !== marketId || !build.order.isBuy || !build.order.isYes) {
    throw new Error("Jupiter fallback quote identity differs from the selected outcome market");
  }
  if (build.executionModel !== "atomic_swap" || build.settlement !== "auto") {
    throw new Error("Jupiter fallback quote is not an atomic auto-settling swap");
  }
  if (build.order.newContractsMicro <= 0n || build.order.orderCostMicroUsd <= 0n) {
    throw new Error("Jupiter fallback quote has no executable contracts or cost");
  }
  if (build.order.orderCostMicroUsd !== requestedGrossMicroUsd) {
    throw new Error(
      `Jupiter fallback quote cost ${build.order.orderCostMicroUsd} differs from requested gross ${requestedGrossMicroUsd}`,
    );
  }
}

function quoteLevel(build: JupiterPredictionOrderBuild): BookLevel {
  // Strategy sizing uses Polymarket's 0.01-contract step. Round the displayed
  // depth up by less than one step; the exact Jupiter contracts are retained in
  // `build` and are revalidated before either real leg is submitted.
  const quantityMicro = ceilDivide(build.order.newContractsMicro, CONTRACT_STEP_MICRO) * CONTRACT_STEP_MICRO;
  const priceMicroUsd = ceilDivide(
    build.order.orderCostMicroUsd * ONE_CONTRACT_MICRO,
    build.order.newContractsMicro,
  );
  if (priceMicroUsd <= 0n || priceMicroUsd >= ONE_USD_MICRO) {
    throw new Error(`Jupiter fallback quote returned invalid average price ${priceMicroUsd}`);
  }
  // `orderCostMicroUsd / newContractsMicro` is already all-in: the atomic
  // build tells us the exact outcome-token amount received for the requested
  // USDC deposit. Applying the documented prediction fee formula again would
  // double-count the fee embedded in this executable swap quote.
  return { priceMicroUsd, contractsMicro: quantityMicro, takerFeeIncluded: true };
}

function priceLevel(priceMicroUsd: bigint, grossAmountMicroUsd: bigint): BookLevel[] {
  if (priceMicroUsd <= 0n || priceMicroUsd >= ONE_USD_MICRO) return [];
  const quantityMicro = ceilDivide(
    grossAmountMicroUsd * ONE_CONTRACT_MICRO,
    priceMicroUsd,
  );
  return [{
    priceMicroUsd,
    contractsMicro: ceilDivide(quantityMicro, CONTRACT_STEP_MICRO) * CONTRACT_STEP_MICRO,
  }];
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Cannot divide by a non-positive quantity");
  return (numerator + denominator - 1n) / denominator;
}
