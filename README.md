# Jupol

Risk-first arbitrage research and execution between Polymarket and prediction markets exposed through Jupiter.

The first target is a pair of binary contracts such as “BTC above strike `K` at time `T`”. The bot buys complementary outcomes only when they form the same economic contract and their worst-case, taker-only cost is below the guaranteed payout after fees and safety buffers.

The repository contains read-only discovery tools and an explicitly gated real-money adapter for native Jupiter Forecast versus Polymarket BTC 5m/15m markets. Live mode is experimental and non-atomic; the monitor remains read-only.

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

Requirements: Node.js 24+ and pnpm.

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

It runs two independent pair loops: Polymarket 5m versus Jupiter Forecast 5m, and Polymarket 15m versus Jupiter Forecast 15m. Each pair must have identical start/end times and opening references strictly less than $30 apart. It streams Polymarket books plus the public Jupiter Degen top-price WebSocket, includes both taker fees, and logs fee-adjusted cross-venue candidates. Authenticated Jupiter Swap `/order` calls are reserved for candidates that reach live-entry preflight. These candidates are explicitly non-guaranteed because Polymarket closes on Chainlink TWAP 60s while Jupiter Forecast closes on Chainlink spot. See [Short-window monitor](docs/SHORT_WINDOW_MONITOR.md).

Run the real-money bot after completing wallet setup and readiness checks:

```bash
pnpm bot:short-window
```

`bot:short-window` and `bot:short-window:live` are equivalent live-only commands. They can submit real orders only after wallet preflights and an exact confirmation phrase:

```bash
pnpm bot:short-window:live
```

Do not run either command before completing the setup, approval, funding, and recovery instructions in [Real-money live trader](docs/LIVE_TRADING.md). Native Jupiter Forecast execution uses Swap V2 against the market's Token-2022 `outcomeMint`, while the cross-chain pair as a whole is still not atomic and is not guaranteed arbitrage. Live sizing and the dashboard's available cash are refreshed from the real Polymarket collateral and Jupiter USDC wallet balances; there is no seeded paper balance.

Run the live dashboard in another terminal:

```bash
pnpm dashboard:dev
```

Open `http://localhost:3000`. The local dashboard reads the running short-window scanner's status API and explains waiting/skipped rounds, feed health, exact opening references, both venues' best asks, and the best fee-adjusted route. The scanner must remain running in the first terminal.

To run the alternative route-agnostic version, use `pnpm bot:short-window:any-route`. It evaluates both `Poly UP + Jup DOWN` and `Poly DOWN + Jup UP` on every qualified round and submits whichever has the best qualifying fee-adjusted edge. It intentionally keeps the same live state and status-port lock as the reference-directed version, so the two live bots cannot safely run at the same time. Because this mode ignores opening-reference direction, both legs can lose if settlement lands inside the venues' reference gap.

Add `--json` to the scanner for machine-readable output. `JUPITER_API_KEY` is optional for the currently observed read-only endpoints. Without a key, the Jupiter client serializes requests at 2.1-second intervals. In live mode, one shared 110 ms Developer-tier scheduler covers Prediction and Swap quote requests, while latency-sensitive live builds take priority over background discovery.

## Live execution boundary

The live adapter is restricted to native `bisonfi` Jupiter Forecast markets discovered as `BISON-...` outcomes. It rejects Jupiter's Polymarket-routed markets as shared liquidity. Prediction API remains the market-discovery and resolution source; native Forecast entry uses Swap V2 against the same `outcomeMint`, avoiding the Prediction path's `$5` build minimum. The Polymarket entry is a protected native market FOK whose collateral amount is rounded to the CLOB's required two decimals. After its observed fill, the bot requests one fresh Jupiter ExactIn hedge and immediately normalizes a bounded size difference by selling the excess. Balanced live positions are held through market resolution rather than closed by automatic profit-taking. Ambiguous unwind responses are reconciled against wallet token balances. The software persists and halts only when exposure cannot be determined or safely normalized, but no software guard can make Polygon and Solana execution atomic.
# arbbotpolyjup
