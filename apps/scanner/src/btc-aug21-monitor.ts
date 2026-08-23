import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { buildAskMonitorSample, type AskMonitorSample, type LoggedBookLevel } from "../../../packages/domain/src/ask-monitor.ts";
import { stringifyJson } from "../../../packages/domain/src/json.ts";
import type { BinaryOrderBook, VenueMarket } from "../../../packages/domain/src/types.ts";
import { normalizeMarketRule } from "../../../packages/matcher/src/normalize.ts";
import { JupiterClient } from "../../../packages/venue-jupiter/src/client.ts";
import { PolymarketClient } from "../../../packages/venue-polymarket/src/client.ts";
import {
  streamPolymarketOrderBooks,
  type PolymarketStreamBookUpdate,
  type PolymarketStreamStatus,
} from "../../../packages/venue-polymarket/src/market-stream.ts";
import { CliArgs } from "./args.ts";

const POLYMARKET_EVENT_ID = "862400";
const POLYMARKET_EVENT_SLUG = "bitcoin-above-on-august-21-2026";
const JUPITER_EVENT_ID = `POLY-${POLYMARKET_EVENT_ID}`;
const EXPECTED_EVENT_DATE = "2026-08-21";
const EXPECTED_STRIKE_MICRO_USD = 72_000_000_000n;
const EXPECTED_CLOSE_TIME_MS = Date.parse("2026-08-21T16:00:00Z");
const DEFAULT_OUTPUT = "logs/btc-above-72000-2026-08-21.jsonl";
const DEFAULT_REALTIME_OUTPUT = "logs/btc-above-72000-2026-08-21-realtime.jsonl";

async function main(): Promise<void> {
  loadOptionalEnvFile(resolve(process.cwd(), ".env"));
  const args = new CliArgs(process.argv.slice(2));
  if (args.has("help")) {
    printHelp();
    return;
  }
  if (args.has("realtime")) {
    await runRealtime(args);
    return;
  }

  const intervalMs = args.integer("interval-ms", 5_000);
  const maxSamples = args.has("once") ? 1 : args.integer("max-samples", 0);
  const maxConsecutiveErrors = args.integer("max-consecutive-errors", 5);
  const metadataRefreshSamples = args.integer("metadata-refresh-samples", 12);
  const outputPath = resolve(process.cwd(), args.string("output", DEFAULT_OUTPUT));
  if (intervalMs < 2_500 && !args.has("once")) {
    throw new Error("--interval-ms must be at least 2500 for continuous monitoring");
  }
  if (maxConsecutiveErrors < 1) throw new Error("--max-consecutive-errors must be at least 1");

  await mkdir(dirname(outputPath), { recursive: true });
  const sessionId = randomUUID();
  const sessionStartedAtMs = Date.now();
  const polyClient = new PolymarketClient();
  const jupiterClient = new JupiterClient();
  let [polymarket, jupiter] = await loadAndValidateMarkets(polyClient, jupiterClient);
  let stopRequested = false;
  let stopSignal: string | null = null;
  let sampleCount = 0;
  let errorCount = 0;
  let consecutiveErrors = 0;
  let attempt = 0;
  const stopWaiters = new Set<() => void>();

  const requestStop = (signal: string): void => {
    stopRequested = true;
    stopSignal = signal;
    for (const wake of stopWaiters) wake();
    stopWaiters.clear();
  };
  const onSigint = (): void => requestStop("SIGINT");
  const onSigterm = (): void => requestStop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  await appendJsonLine(outputPath, {
    schemaVersion: 1,
    type: "session_start",
    sessionId,
    startedAt: iso(sessionStartedAtMs),
    configuration: {
      polymarketEventId: POLYMARKET_EVENT_ID,
      polymarketEventSlug: POLYMARKET_EVENT_SLUG,
      jupiterEventId: JUPITER_EVENT_ID,
      resolvedPolymarketMarketId: polymarket.marketId,
      resolvedJupiterMarketId: jupiter.marketId,
      expectedEventDate: EXPECTED_EVENT_DATE,
      expectedStrikeMicroUsd: EXPECTED_STRIKE_MICRO_USD,
      expectedCloseTime: iso(EXPECTED_CLOSE_TIME_MS),
      intervalMs,
      maxSamples: maxSamples === 0 ? null : maxSamples,
      metadataRefreshSamples,
      outputPath,
    },
    sharedLiquidityVerified: true,
    markets: {
      polymarket: marketLogRecord(polymarket),
      jupiter: marketLogRecord(jupiter),
    },
  });

  console.log("BTC above $72,000 on August 21, 2026 ask monitor");
  console.log(`Polymarket event ${POLYMARKET_EVENT_SLUG} (${POLYMARKET_EVENT_ID})`);
  console.log(`Jupiter event ${JUPITER_EVENT_ID}`);
  console.log(`Resolved books: Polymarket ${polymarket.marketId} <-> Jupiter ${jupiter.marketId} (shared liquidity verified)`);
  console.log(`Appending JSONL to ${outputPath}`);
  console.log(maxSamples === 0 ? "Press Ctrl-C to stop." : `Stopping after ${maxSamples} successful sample(s).`);

  try {
    while (!stopRequested && (maxSamples === 0 || sampleCount < maxSamples)) {
      attempt += 1;
      const cycleStartedAtMs = Date.now();
      try {
        if (metadataRefreshSamples > 0 && attempt > 1 && (attempt - 1) % metadataRefreshSamples === 0) {
          [polymarket, jupiter] = await loadAndValidateMarkets(polyClient, jupiterClient);
        }

        const [polyBook, jupiterBook] = await Promise.all([
          polyClient.getOrderBook(polymarket),
          jupiterClient.getOrderBook(jupiter),
        ]);
        const sample = buildAskMonitorSample({
          sessionId,
          sequence: attempt,
          startedAtMs: cycleStartedAtMs,
          completedAtMs: Date.now(),
          polymarket: polyBook,
          jupiter: jupiterBook,
        });
        await appendJsonLine(outputPath, sample);
        printSample(sample);
        sampleCount += 1;
        consecutiveErrors = 0;
      } catch (error) {
        errorCount += 1;
        consecutiveErrors += 1;
        const message = errorMessage(error);
        await appendJsonLine(outputPath, {
          schemaVersion: 1,
          type: "sample_error",
          sessionId,
          sequence: attempt,
          startedAt: iso(cycleStartedAtMs),
          failedAt: iso(Date.now()),
          consecutiveErrors,
          message,
        });
        console.error(`#${attempt} ERROR ${message}`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(`Stopped after ${consecutiveErrors} consecutive errors: ${message}`);
        }
      }

      if (!stopRequested && (maxSamples === 0 || sampleCount < maxSamples)) {
        const remainingMs = Math.max(0, intervalMs - (Date.now() - cycleStartedAtMs));
        await waitOrStop(remainingMs, stopWaiters, () => stopRequested);
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await appendJsonLine(outputPath, {
      schemaVersion: 1,
      type: "session_end",
      sessionId,
      startedAt: iso(sessionStartedAtMs),
      endedAt: iso(Date.now()),
      samplesWritten: sampleCount,
      errorsWritten: errorCount,
      stopSignal,
    });
    console.log(`Stopped. Wrote ${sampleCount} sample(s) and ${errorCount} error record(s) to ${outputPath}`);
  }
}

type RealtimeEvent =
  | { type: "polymarket_book"; update: PolymarketStreamBookUpdate; enqueuedAtMs: number }
  | { type: "jupiter_book"; book: BinaryOrderBook; enqueuedAtMs: number }
  | { type: "stream_status"; status: PolymarketStreamStatus }
  | { type: "jupiter_error"; message: string; consecutiveErrors: number; atMs: number }
  | { type: "stop"; reason: string };

async function runRealtime(args: CliArgs): Promise<void> {
  const jupiterPollMs = args.integer("jupiter-poll-ms", 2_500);
  const maxSamples = args.has("once") ? 1 : args.integer("max-samples", 0);
  const maxConsecutiveErrors = args.integer("max-consecutive-errors", 5);
  const outputPath = resolve(process.cwd(), args.string("output", DEFAULT_REALTIME_OUTPUT));
  const minimumJupiterPollMs = process.env.JUPITER_API_KEY ? 250 : 2_500;
  if (jupiterPollMs < minimumJupiterPollMs) {
    throw new Error(`--jupiter-poll-ms must be at least ${minimumJupiterPollMs}${process.env.JUPITER_API_KEY ? "" : " without JUPITER_API_KEY"}`);
  }
  if (maxConsecutiveErrors < 1) throw new Error("--max-consecutive-errors must be at least 1");

  await mkdir(dirname(outputPath), { recursive: true });
  const sessionId = randomUUID();
  const sessionStartedAtMs = Date.now();
  const polyClient = new PolymarketClient();
  const jupiterClient = new JupiterClient();
  const [polymarket, jupiter] = await loadAndValidateMarkets(polyClient, jupiterClient);
  let latestPolymarket: BinaryOrderBook | null = null;
  let latestJupiter = await jupiterClient.getOrderBook(jupiter);
  let sampleCount = 0;
  let errorCount = 0;
  let sequence = 0;
  let stopSignal: string | null = null;
  const controller = new AbortController();
  const queue = new AsyncEventQueue<RealtimeEvent>();

  const requestStop = (reason: string): void => {
    if (controller.signal.aborted) return;
    stopSignal = reason;
    controller.abort();
    queue.push({ type: "stop", reason });
  };
  const onSigint = (): void => requestStop("SIGINT");
  const onSigterm = (): void => requestStop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  await appendJsonLine(outputPath, {
    schemaVersion: 1,
    type: "session_start",
    sessionId,
    startedAt: iso(sessionStartedAtMs),
    configuration: {
      mode: "hybrid_realtime",
      polymarketTransport: "websocket",
      jupiterTransport: "rest_poll",
      jupiterPollMs,
      polymarketEventId: POLYMARKET_EVENT_ID,
      polymarketEventSlug: POLYMARKET_EVENT_SLUG,
      jupiterEventId: JUPITER_EVENT_ID,
      resolvedPolymarketMarketId: polymarket.marketId,
      resolvedJupiterMarketId: jupiter.marketId,
      expectedEventDate: EXPECTED_EVENT_DATE,
      expectedStrikeMicroUsd: EXPECTED_STRIKE_MICRO_USD,
      expectedCloseTime: iso(EXPECTED_CLOSE_TIME_MS),
      maxSamples: maxSamples === 0 ? null : maxSamples,
      outputPath,
    },
    sharedLiquidityVerified: true,
    markets: {
      polymarket: marketLogRecord(polymarket),
      jupiter: marketLogRecord(jupiter),
    },
  });

  console.log("BTC above $72,000 on August 21, 2026 real-time ask monitor");
  console.log(`Polymarket WebSocket ${polymarket.marketId} <-> Jupiter REST ${jupiter.marketId}`);
  console.log(`Jupiter refresh interval: ${jupiterPollMs}ms; Polymarket samples emit on top-of-book changes`);
  console.log(`Appending JSONL to ${outputPath}`);
  console.log(maxSamples === 0 ? "Press Ctrl-C to stop." : `Stopping after ${maxSamples} successful sample(s).`);

  const websocketTask = streamPolymarketOrderBooks(polymarket, {
    signal: controller.signal,
    onBook: (update) => queue.push({ type: "polymarket_book", update, enqueuedAtMs: Date.now() }),
    onStatus: (status) => queue.push({ type: "stream_status", status }),
  });
  const jupiterTask = pollJupiterOrderBook({
    client: jupiterClient,
    market: jupiter,
    intervalMs: jupiterPollMs,
    maxConsecutiveErrors,
    signal: controller.signal,
    queue,
  });

  try {
    while (!controller.signal.aborted) {
      const event = await queue.next();
      if (event.type === "stop") break;
      if (event.type === "stream_status") {
        await appendJsonLine(outputPath, {
          schemaVersion: 1,
          type: "stream_status",
          sessionId,
          status: event.status.status,
          at: iso(event.status.atMs),
          attempt: event.status.attempt,
          message: event.status.message ?? null,
        });
        if (event.status.status !== "connecting") {
          console.log(`WS ${event.status.status}${event.status.message ? `: ${event.status.message}` : ""}`);
        }
        continue;
      }
      if (event.type === "jupiter_error") {
        errorCount += 1;
        await appendJsonLine(outputPath, {
          schemaVersion: 1,
          type: "sample_error",
          sessionId,
          sequence: sequence + 1,
          startedAt: iso(event.atMs),
          failedAt: iso(event.atMs),
          consecutiveErrors: event.consecutiveErrors,
          source: "jupiter_rest_poll",
          message: event.message,
        });
        console.error(`Jupiter poll ERROR ${event.message}`);
        if (event.consecutiveErrors >= maxConsecutiveErrors) requestStop("MAX_CONSECUTIVE_ERRORS");
        continue;
      }

      const trigger = event.type === "polymarket_book"
        ? `polymarket_websocket_${event.update.eventType}`
        : "jupiter_rest_poll";
      const eventStartedAtMs = event.enqueuedAtMs;
      if (event.type === "polymarket_book") latestPolymarket = event.update.book;
      else latestJupiter = event.book;
      if (!latestPolymarket) continue;

      sequence += 1;
      const completedAtMs = Date.now();
      const sample = buildAskMonitorSample({
        sessionId,
        sequence,
        startedAtMs: eventStartedAtMs,
        completedAtMs,
        polymarket: latestPolymarket,
        jupiter: latestJupiter,
        maxReceiptSkewMs: jupiterPollMs + 1_000,
      });
      await appendJsonLine(outputPath, {
        ...sample,
        transport: {
          mode: "hybrid_realtime",
          trigger,
          polymarket: "websocket",
          jupiter: "rest_poll",
          jupiterSnapshotAgeMs: completedAtMs - latestJupiter.receivedAtMs,
        },
      });
      printSample(sample, trigger);
      sampleCount += 1;
      if (maxSamples > 0 && sampleCount >= maxSamples) requestStop("MAX_SAMPLES");
    }
  } finally {
    controller.abort();
    await Promise.allSettled([websocketTask, jupiterTask]);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await appendJsonLine(outputPath, {
      schemaVersion: 1,
      type: "session_end",
      sessionId,
      startedAt: iso(sessionStartedAtMs),
      endedAt: iso(Date.now()),
      samplesWritten: sampleCount,
      errorsWritten: errorCount,
      stopSignal,
    });
    console.log(`Stopped. Wrote ${sampleCount} sample(s) and ${errorCount} error record(s) to ${outputPath}`);
  }
}

async function pollJupiterOrderBook(input: {
  client: JupiterClient;
  market: VenueMarket;
  intervalMs: number;
  maxConsecutiveErrors: number;
  signal: AbortSignal;
  queue: AsyncEventQueue<RealtimeEvent>;
}): Promise<void> {
  let consecutiveErrors = 0;
  while (!input.signal.aborted) {
    await waitForAbort(input.intervalMs, input.signal);
    if (input.signal.aborted) break;
    try {
      const book = await input.client.getOrderBook(input.market);
      consecutiveErrors = 0;
      input.queue.push({ type: "jupiter_book", book, enqueuedAtMs: Date.now() });
    } catch (error) {
      consecutiveErrors += 1;
      input.queue.push({
        type: "jupiter_error",
        message: errorMessage(error),
        consecutiveErrors,
        atMs: Date.now(),
      });
      if (consecutiveErrors >= input.maxConsecutiveErrors) break;
    }
  }
}

class AsyncEventQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }

  async next(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return item;
    return await new Promise<T>((resolveNext) => this.#waiters.push(resolveNext));
  }
}

async function waitForAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveWait();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function loadOptionalEnvFile(path: string): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) throw error;
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function loadAndValidateMarkets(
  polyClient: PolymarketClient,
  jupiterClient: JupiterClient,
): Promise<[VenueMarket, VenueMarket]> {
  const [polymarket, jupiter] = await Promise.all([
    polyClient.getEventMarketsBySlug(POLYMARKET_EVENT_SLUG).then((markets) => selectTargetMarket(markets, "Polymarket")),
    jupiterClient.getEventMarkets(JUPITER_EVENT_ID, {
      provider: "polymarket",
      category: "crypto",
      subcategory: "btc",
      sortBy: "beginAt",
      sortDirection: "desc",
      maxEvents: 100,
      pageSize: 100,
    }).then((markets) => selectTargetMarket(markets, "Jupiter")),
  ]);
  validateMarkets(polymarket, jupiter);
  return [polymarket, jupiter];
}

function selectTargetMarket(markets: readonly VenueMarket[], label: string): VenueMarket {
  const matches = markets.filter((market) => {
    const rule = normalizeMarketRule(market);
    return (
      rule.asset === "BTC" &&
      rule.thresholdMicroUsd === EXPECTED_STRIKE_MICRO_USD &&
      rule.comparison === "GT" &&
      rule.observationMode === "POINT" &&
      market.closeTimeMs === EXPECTED_CLOSE_TIME_MS
    );
  });
  if (matches.length !== 1) {
    throw new Error(`${label} parent event resolved ${matches.length} matching $72,000 child markets; expected exactly 1`);
  }
  const market = matches[0];
  if (!market) throw new Error(`${label} $72,000 child market is missing`);
  return market;
}

function validateMarkets(polymarket: VenueMarket, jupiter: VenueMarket): void {
  const polyRule = normalizeMarketRule(polymarket);
  const jupiterRule = normalizeMarketRule(jupiter);
  const problems: string[] = [];

  if (polymarket.eventId !== POLYMARKET_EVENT_ID) problems.push(`unexpected Polymarket parent event ${polymarket.eventId}`);
  if (jupiter.eventId !== JUPITER_EVENT_ID) problems.push(`unexpected Jupiter parent event ${jupiter.eventId}`);
  if (jupiter.provider !== "polymarket") problems.push(`Jupiter provider is ${jupiter.provider}, not polymarket`);
  if (polymarket.status !== "open") problems.push(`Polymarket status is ${polymarket.status}`);
  if (jupiter.status !== "open") problems.push(`Jupiter status is ${jupiter.status}`);
  if (polyRule.asset !== "BTC" || jupiterRule.asset !== "BTC") problems.push("asset is not BTC on both records");
  if (polyRule.thresholdMicroUsd !== EXPECTED_STRIKE_MICRO_USD || jupiterRule.thresholdMicroUsd !== EXPECTED_STRIKE_MICRO_USD) {
    problems.push("strike is not $72,000 on both records");
  }
  if (polyRule.comparison !== "GT" || jupiterRule.comparison !== "GT") problems.push("comparison is not strict above on both records");
  if (polyRule.observationMode !== "POINT" || jupiterRule.observationMode !== "POINT") {
    problems.push("observation mode is not point-in-time on both records");
  }
  if (polymarket.closeTimeMs !== EXPECTED_CLOSE_TIME_MS || jupiter.closeTimeMs !== EXPECTED_CLOSE_TIME_MS) {
    problems.push("close time is not 2026-08-21 12:00 ET / 16:00 UTC on both records");
  }
  if (polyRule.ruleHash !== jupiterRule.ruleHash) problems.push("resolution rule hashes differ");
  if (!sameStrings(polymarket.clobTokenIds, jupiter.clobTokenIds) || polymarket.clobTokenIds.length !== 2) {
    problems.push("the two CLOB token IDs do not match exactly");
  }

  if (problems.length > 0) throw new Error(`Fixed-market validation failed: ${problems.join("; ")}`);
}

function marketLogRecord(market: VenueMarket): object {
  return {
    venue: market.venue,
    provider: market.provider,
    eventId: market.eventId,
    marketId: market.marketId,
    eventTitle: market.eventTitle,
    title: market.title,
    status: market.status,
    openTime: market.openTimeMs === null ? null : iso(market.openTimeMs),
    closeTime: market.closeTimeMs === null ? null : iso(market.closeTimeMs),
    clobTokenIds: market.clobTokenIds,
    outcomes: market.outcomes,
    rulesPrimary: market.rulesPrimary,
    rulesSecondary: market.rulesSecondary,
    normalizedRule: normalizeMarketRule(market),
    sourceUrl: market.sourceUrl,
  };
}

function printSample(sample: AskMonitorSample, trigger?: string): void {
  const poly = sample.books.polymarket;
  const jupiter = sample.books.jupiter;
  const best = sample.bestAvailable;
  console.log(
    `#${sample.sequence} ${sample.completedAt} ` +
    `Poly[Y ${displayLevel(poly.yesBestAsk)} | N ${displayLevel(poly.noBestAsk)}] ` +
    `Jup[Y ${displayLevel(jupiter.yesBestAsk)} | N ${displayLevel(jupiter.noBestAsk)}] ` +
    `BEST_ASK[Y ${displayRoute(best.yes)} | N ${displayRoute(best.no)}] ` +
    `skew=${sample.receiptSkewMs}ms${trigger ? ` trigger=${trigger}` : ""} warnings=${sample.warnings.join(",")}`,
  );
}

function displayRoute(route: AskMonitorSample["bestAvailable"]["yes"]): string {
  const venue = route.venue === "polymarket" ? "P" : route.venue === "jupiter" ? "J" : "?";
  const tie = route.rawPriceTie ? "(tie)" : "";
  return `${venue}${tie} ${displayLevel(route.level)}`;
}

function displayLevel(level: LoggedBookLevel | null): string {
  return level ? `${level.priceUsd} x ${level.contracts}` : "missing";
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${stringifyJson(value, false)}\n`, "utf8");
}

async function waitOrStop(
  milliseconds: number,
  waiters: Set<() => void>,
  isStopped: () => boolean,
): Promise<void> {
  if (milliseconds <= 0 || isStopped()) return;
  await new Promise<void>((resolveWait) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(finish);
      resolveWait();
    };
    const timer = setTimeout(finish, milliseconds);
    waiters.add(finish);
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  console.log(`Usage:
  pnpm monitor:btc-aug21
  pnpm monitor:btc-aug21 -- --realtime
  pnpm monitor:btc-aug21 -- --once
  pnpm monitor:btc-aug21 -- --max-samples=120 --interval-ms=5000

Fixed market:
  Polymarket event bitcoin-above-on-august-21-2026 (862400)
  Jupiter event POLY-862400
  The $72,000 child market/orderbook is resolved and verified at startup
  BTC strictly above $72,000 on August 21, 2026
  Binance BTC/USDT 1-minute candle final Close at 12:00 ET

Options:
  --realtime                     Stream Polymarket and poll Jupiter REST
  --interval-ms=5000             Start-to-start polling interval (minimum 2500)
  --jupiter-poll-ms=2500         Jupiter refresh interval in real-time mode
  --max-samples=0                Successful samples before exit; 0 means unlimited
  --once                         Fetch exactly one sample and exit
  --output=${DEFAULT_OUTPUT}
                                 Real-time default: ${DEFAULT_REALTIME_OUTPUT}
  --metadata-refresh-samples=12  Revalidate identity, rules, tokens, and open status
  --max-consecutive-errors=5
  --help

The output is append-only JSON Lines. Press Ctrl-C once for a graceful stop.`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
