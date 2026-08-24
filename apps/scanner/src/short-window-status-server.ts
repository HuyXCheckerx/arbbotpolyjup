import { createServer, type Server } from "node:http";

export type ShortWindowDuration = "5m" | "15m";
export type ScannerPhase =
  | "discovering"
  | "waiting_references"
  | "rejected"
  | "qualified"
  | "monitoring"
  | "ended"
  | "error";

export interface FeedStatus {
  status: "connecting" | "connected" | "disconnected" | "reconnecting";
  message: string | null;
  lastObservationReceivedAt: string | null;
  lastObservedAt: string | null;
  updatedAt: string;
}

export interface ReferenceStatus {
  ready: boolean;
  priceUsd: string | null;
  source: string | null;
}

export interface BestAskStatus {
  priceUsd: string;
  contracts: string;
  receivedAt: string;
}

export interface BookStatus {
  up: BestAskStatus | null;
  down: BestAskStatus | null;
  receivedAt: string;
  ageMs: number;
  stale: boolean;
}

export interface RouteStatus {
  label: string;
  allInUsdPerContract: string;
  edgeUsdPerContract: string;
  commonContracts: string;
  feeAdjustedCandidate: boolean;
  stale: boolean;
}

export interface DurationStatus {
  duration: ShortWindowDuration;
  phase: ScannerPhase;
  message: string;
  start: string | null;
  end: string | null;
  nextBoundary: string | null;
  startedMidRound: boolean;
  pair: {
    polymarketSlug: string;
    polymarketMarketId: string;
    jupiterEventId: string;
    jupiterUpMarketId: string;
    jupiterDownMarketId: string;
  } | null;
  references: {
    polymarket: ReferenceStatus;
    jupiter: ReferenceStatus;
    differenceUsd: string | null;
    limitUsd: string;
  };
  books: {
    polymarket: BookStatus | null;
    jupiter: BookStatus | null;
  };
  bestRoute: RouteStatus | null;
  samples: number;
  opportunities: number;
  updatedAt: string;
}

export interface LivePositionSnapshot {
  id: string;
  pairKey: string;
  duration: string;
  start: string;
  end: string;
  polymarketSlug: string;
  polymarketMarketId: string;
  jupiterMarketId: string;
  phase: string;
  polymarketOutcome: string;
  jupiterOutcome: string;
  polymarketContracts: string;
  jupiterContracts: string;
  polymarketCostUsd: string;
  jupiterCostUsd: string;
  totalCostUsd: string;
  contractSkew: string;
  isHedged: boolean;
  polymarketSettled: boolean;
  jupiterSettled: boolean;
  realizedProfitUsd: string;
  enteredAt: string;
  lastError: string | null;
  settlementError: string | null;
}

export interface StatusEvent {
  id: string;
  timestamp: string;
  type: string;
  level: "info" | "warn" | "error" | "success";
  duration?: string | undefined;
  code?: string | undefined;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface ShortWindowStatusSnapshot {
  schemaVersion: 1;
  scanner: {
    running: boolean;
    readOnly: boolean;
    sessionId: string;
    startedAt: string;
    outputPath: string;
    generatedAt: string;
  };
  feeds: {
    polymarketTwap: FeedStatus;
    jupiterSpot: FeedStatus;
  };
  strategy: {
    mode: "monitor" | "paper" | "live";
    halted: boolean;
    haltReason: string | null;
    polymarketCashUsd: string;
    jupiterCashUsd: string;
    realizedProfitUsd: string;
    openPositions: number;
    awaitingResolution: number;
    lastAction: string;
    positions?: LivePositionSnapshot[];
    walletBalances: {
      polymarketCollateralUsd: string | null;
      jupiterUsdcUsd: string | null;
      jupiterSol: string | null;
      observedAt: string | null;
      error: string | null;
    };
    updatedAt: string;
  };
  durations: Record<ShortWindowDuration, DurationStatus>;
  events: StatusEvent[];
}

export class ShortWindowStatusStore {
  readonly #sessionId: string;
  readonly #startedAt: string;
  readonly #outputPath: string;
  readonly #limitUsd: string;
  readonly #readOnly: boolean;
  #running = true;
  readonly #feeds: ShortWindowStatusSnapshot["feeds"];
  #strategy: ShortWindowStatusSnapshot["strategy"];
  readonly #durations: ShortWindowStatusSnapshot["durations"];
  readonly #events: StatusEvent[] = [];
  #eventSequence = 0;

  constructor(input: {
    sessionId: string;
    startedAtMs: number;
    outputPath: string;
    limitUsd: string;
    paperStrategyEnabled?: boolean;
    liveStrategyEnabled?: boolean;
  }) {
    this.#sessionId = input.sessionId;
    this.#startedAt = new Date(input.startedAtMs).toISOString();
    this.#outputPath = input.outputPath;
    this.#limitUsd = input.limitUsd;
    this.#readOnly = !input.liveStrategyEnabled;
    this.#feeds = {
      polymarketTwap: initialFeed(),
      jupiterSpot: initialFeed(),
    };
    this.#strategy = {
      mode: input.liveStrategyEnabled ? "live" : input.paperStrategyEnabled ? "paper" : "monitor",
      halted: false,
      haltReason: null,
      polymarketCashUsd: "0",
      jupiterCashUsd: "0",
      realizedProfitUsd: "0",
      openPositions: 0,
      awaitingResolution: 0,
      lastAction: input.liveStrategyEnabled
        ? "Live trader is starting."
        : input.paperStrategyEnabled ? "Waiting for a qualified route." : "Read-only monitor; real trading disabled.",
      walletBalances: {
        polymarketCollateralUsd: null,
        jupiterUsdcUsd: null,
        jupiterSol: null,
        observedAt: null,
        error: null,
      },
      updatedAt: new Date().toISOString(),
    };
    this.#durations = {
      "5m": initialDuration("5m", input.limitUsd),
      "15m": initialDuration("15m", input.limitUsd),
    };
  }

  updateFeed(
    name: keyof ShortWindowStatusSnapshot["feeds"],
    update: Pick<FeedStatus, "status" | "message">,
  ): void {
    this.#feeds[name] = { ...this.#feeds[name], ...update, updatedAt: new Date().toISOString() };
  }

  recordFeedObservation(
    name: keyof ShortWindowStatusSnapshot["feeds"],
    observedAtMs: number,
    receivedAtMs: number,
  ): void {
    this.#feeds[name] = {
      ...this.#feeds[name],
      lastObservationReceivedAt: new Date(receivedAtMs).toISOString(),
      lastObservedAt: new Date(observedAtMs).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  updateDuration(duration: ShortWindowDuration, update: Partial<Omit<DurationStatus, "duration" | "updatedAt">>): void {
    Object.assign(this.#durations[duration], update, { updatedAt: new Date().toISOString() });
  }

  updateReference(
    duration: ShortWindowDuration,
    venue: "polymarket" | "jupiter",
    reference: ReferenceStatus,
  ): void {
    const current = this.#durations[duration];
    current.references = { ...current.references, [venue]: reference };
    current.updatedAt = new Date().toISOString();
  }

  updateBook(duration: ShortWindowDuration, venue: "polymarket" | "jupiter", book: BookStatus): void {
    const current = this.#durations[duration];
    current.books = { ...current.books, [venue]: book };
    current.updatedAt = new Date().toISOString();
  }

  updateStrategy(update: Partial<Omit<ShortWindowStatusSnapshot["strategy"], "updatedAt">>): void {
    this.#strategy = { ...this.#strategy, ...update, updatedAt: new Date().toISOString() };
  }

  updateWalletBalances(
    update: Partial<ShortWindowStatusSnapshot["strategy"]["walletBalances"]>,
  ): void {
    this.#strategy = {
      ...this.#strategy,
      walletBalances: { ...this.#strategy.walletBalances, ...update },
      updatedAt: new Date().toISOString(),
    };
  }

  recordEvent(event: Omit<StatusEvent, "id" | "timestamp"> & { id?: string; timestamp?: string }): void {
    this.#eventSequence += 1;
    const entry: StatusEvent = {
      id: event.id ?? `evt-${this.#eventSequence}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
      type: event.type,
      level: event.level,
      duration: event.duration,
      code: event.code,
      message: event.message,
      details: event.details,
    };
    this.#events.unshift(entry);
    if (this.#events.length > 50) this.#events.pop();
  }

  stop(): void {
    this.#running = false;
  }

  snapshot(): ShortWindowStatusSnapshot {
    return {
      schemaVersion: 1,
      scanner: {
        running: this.#running,
        readOnly: this.#readOnly,
        sessionId: this.#sessionId,
        startedAt: this.#startedAt,
        outputPath: this.#outputPath,
        generatedAt: new Date().toISOString(),
      },
      feeds: structuredClone(this.#feeds),
      strategy: structuredClone(this.#strategy),
      durations: structuredClone(this.#durations),
      events: structuredClone(this.#events),
    };
  }
}

export async function startShortWindowStatusServer(
  store: ShortWindowStatusStore,
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin === "http://127.0.0.1:3000" || origin === "http://localhost:3000") {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
    }
    response.setHeader("access-control-allow-methods", "GET, OPTIONS");
    response.setHeader("cache-control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && (request.url === "/api/status" || request.url === "/health")) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.writeHead(200).end(JSON.stringify(store.snapshot()));
      return;
    }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
  });

  await listen(server, port);
  return {
    url: `http://127.0.0.1:${port}/api/status`,
    close: async () => await close(server),
  };
}

function initialFeed(): FeedStatus {
  return {
    status: "connecting",
    message: null,
    lastObservationReceivedAt: null,
    lastObservedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function initialDuration(duration: ShortWindowDuration, limitUsd: string): DurationStatus {
  return {
    duration,
    phase: "discovering",
    message: "Looking for the current same-duration market pair.",
    start: null,
    end: null,
    nextBoundary: null,
    startedMidRound: false,
    pair: null,
    references: {
      polymarket: { ready: false, priceUsd: null, source: null },
      jupiter: { ready: false, priceUsd: null, source: null },
      differenceUsd: null,
      limitUsd,
    },
    books: { polymarket: null, jupiter: null },
    bestRoute: null,
    samples: 0,
    opportunities: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
