# Jupol

Risk-first arbitrage research and execution between Polymarket and prediction markets exposed through Jupiter.

The first target is a pair of binary contracts such as “BTC above strike `K` at time `T`”. The bot buys complementary outcomes only when they form the same economic contract and their worst-case, taker-only cost is below the guaranteed payout after fees and safety buffers.

The production BTC 5m/15m and daily-threshold scanner/trader is Rust. The browser dashboard and retained TypeScript discovery/regression tools are outside the live execution path. Live mode is experimental and non-atomic; monitor mode remains read-only.

## Non-negotiable invariants

- Taker-only execution; no strategy order may rest on an order book.
- Never treat a Jupiter market backed by Polymarket as a second venue.
- Never call two merely similar resolution rules “arbitrage”.
- Use executable depth and returned fee quotes, not displayed midpoint prices.
- A detected spread is not profit until both legs are confirmed and reconciled.
- Pre-fund both venues; bridging is treasury work, never part of the hot path.
- Stop automatically on stale data, uncertain state, rule changes, or risk-limit breaches.

## Start here

- [How to run every bot mode](HOW_TO_RUN.md)
- [Project direction](docs/PROJECT_DIRECTION.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Risk and execution specification](docs/RISK_AND_EXECUTION.md)
- [Live discovery report — 2026-08-20](docs/LIVE_DISCOVERY_2026-08-20.md)
- [Real-money live trader](docs/LIVE_TRADING.md)

## Run the scanner

Requirements: Rust 1.90+, plus Node.js 24+ and pnpm for the dashboard and retained tools/tests.

```bash
pnpm install
pnpm check
pnpm scan -- --assets=BTC,ETH,SOL,XRP --jupiter-providers=polymarket,kalshi
```

Include rejected near-matches and fetch normalized books for the top candidates:

```bash
pnpm scan -- \
  --assets=BTC \
  --jupiter-providers=polymarket,kalshi \
  --include-rejected \
  --with-orderbooks \
  --book-limit=3
```

Fetch a single book:

```bash
pnpm book -- --venue=polymarket --market-id=3257342
pnpm book -- --venue=jupiter --market-id=KXBTCMAX100-26-AUG
```

Run the dedicated BTC-above-$72,000-on-August-21 ask monitor:

```bash
pnpm monitor:btc-aug21
```

Use the hybrid real-time mode for event-driven Polymarket WebSocket updates and Jupiter REST comparison snapshots:

```bash
pnpm monitor:btc-aug21 -- --realtime
```

It continuously appends exact Polymarket and Jupiter YES/NO best asks, sizes, timestamps, snapshot skew, and the independently selected best route for each outcome to an ignored JSONL log. It does not add the two sides or estimate profit. See [BTC August 21 $72,000 monitor](docs/BTC_AUG21_72000_MONITOR.md) for setup, bounded runs, graceful shutdown, log schema, analysis commands, and troubleshooting.

Run the separate native Jupiter Forecast versus Polymarket short-window scanner:

```bash
pnpm monitor:short-window
```

It runs two independent pair loops: Polymarket 5m versus Jupiter Forecast 5m, and Polymarket 15m versus Jupiter Forecast 15m. Each pair must have identical start/end times. Opening-reference difference is recorded for basis-risk diagnostics but no longer rejects a pair. Rust consumes the Polymarket market WebSocket (REST is stale-data fallback) plus the public Jupiter Degen top-price WebSocket, includes both taker fees, and evaluates both complementary routes. Authenticated size-specific Jupiter builds are reserved for candidates that reach live-entry preflight and remain the authoritative liquidity/profitability check. These candidates are explicitly non-guaranteed because Polymarket closes on Chainlink TWAP 60s while Jupiter Forecast closes on Chainlink spot. See [Short-window monitor](docs/SHORT_WINDOW_MONITOR.md).

Run the real-money bot after completing wallet setup and readiness checks:

```bash
pnpm bot:short-window
```

`bot:short-window` and `bot:short-window:live` are equivalent live-only commands. They can submit real orders only after wallet preflights and an exact confirmation phrase:

```bash
pnpm bot:short-window:live
```

Do not run either command before completing the setup, approval, funding, and recovery instructions in [Real-money live trader](docs/LIVE_TRADING.md). Native Jupiter Forecast execution uses Prediction for deposits of at least `$5` and Swap V2 by default below that minimum, down to the bot's `$0.10` strategy floor. Prediction fills are reconciled from confirmed on-chain outcome-token and USDC deltas rather than quoted output. The cross-chain pair is still not atomic and is not guaranteed arbitrage. Live sizing and the dashboard's available cash are refreshed from the real Polymarket collateral and Jupiter USDC wallet balances; there is no seeded paper balance.

Run the live dashboard in another terminal:

```bash
pnpm dashboard:dev
```

Open `http://localhost:3000`. The local dashboard reads the running short-window scanner's status API and explains waiting/skipped rounds, feed health, exact opening references, both venues' best asks, and the best fee-adjusted route. The scanner must remain running in the first terminal.

Every Rust live command evaluates `Poly UP + Jup DOWN` and `Poly DOWN + Jup UP` and submits whichever has the best qualifying fee-adjusted edge. `pnpm bot:short-window:any-route` is retained as an output-file alias. The aliases share the same live state and status-port lock, so they cannot safely run together. Both legs can lose if settlement lands inside the venues' reference gap.

Candidates and errors are appended as JSONL through `--output`. `JUPITER_API_KEY` is required for Prediction discovery and must have Prediction plus Swap product access. Prediction and Swap V2 `/order` builds use one request every `100ms`, matching this bot's Developer 10 RPS main bucket; authenticated Swap V2 `/execute` uses Jupiter's separate paid-plan execution bucket. Public Degen WebSocket discovery consumes no authenticated build requests, and candidate entry/recovery builds receive priority.

## Live execution boundary

The live adapter uses native `bisonfi` Jupiter Forecast markets discovered as `BISON-...` outcomes and verified standard `POLY-*` Jupiter Prediction pairs. Native Forecast entries use Prediction at `$5+` and direct Swap V2 below `$5`, down to a `$0.10` strategy floor by default. Standard `POLY-*` markets retain an effective `$5` Prediction floor. Swap sizing uses the guaranteed `otherAmountThreshold`, and confirmed `/execute` input/output amounts drive accounting. The Rust coordinator persists intent and releases both prepared legs concurrently, then projects all four joint resolution cases, quarantines unsafe exposure from further entries, and allows only bounded recovery. It claims/redeems settled winners, verifies actual settlement wallet credits, closes empty Token-2022 accounts to reclaim rent, and archives the full position in the durable settled audit ledger. Confirmed-but-not-yet-observed redemptions remain durable and are not resubmitted. Unknown identity, quantity, cash debit, or payout is never reported as profit. No software guard can make the venues' resolution observations or Polygon and Solana execution atomic.
# arbbotpolyjup
