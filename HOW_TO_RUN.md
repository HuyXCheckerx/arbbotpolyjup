# How to run Jupol

Run commands from the repository root:

```bash
cd /Users/perycent/Downloads/Jupol
```

The production scanner and trader are Rust. The browser dashboard and the old
TypeScript regression suite remain JavaScript/TypeScript, but they do not sign,
submit, reconcile, settle, or redeem live orders.

## Commands and side effects

| Goal | Command | Can change venue/on-chain state? |
| --- | --- | --- |
| Monitor 5m, 15m and daily BTC markets | `pnpm monitor:short-window` | No |
| Monitor short-window only | `pnpm monitor:short-window --no-daily-threshold` | No |
| Check both wallets and APIs | `pnpm check:live:readiness` | No |
| Check only Polymarket | `pnpm check:polymarket:live` | No |
| Start live trading | `pnpm bot:short-window:live` | Yes |
| Reconcile/repair interrupted positions | `pnpm recover:live` | **Yes, may submit bounded repair orders** |
| Create Polymarket approvals | `pnpm setup:polymarket:live` | Yes |
| Redeem settled Polymarket positions | `pnpm redeem:polymarket` | Yes |

Every Rust monitor/live command evaluates both complementary directions and
chooses the best qualified one: `Poly UP + Jup DOWN` or `Poly DOWN + Jup UP`.
The `:any-route` package aliases now differ only in their JSONL output filename.
There is no opening-reference-difference limit; the difference is diagnostic
only. Because the two venues can use different final observations, this is a
basis trade and not guaranteed arbitrage.

## Install and build

Requirements:

- Rust 1.90 or newer;
- Node.js 24 and pnpm for the dashboard and retained regression tests;
- network access to Jupiter, Polymarket and a reliable Solana RPC.

```bash
pnpm install
npm install --prefix apps/dashboard
cargo build --release -p jupol-scanner
pnpm check
```

The optimized executable is `target/release/jupol`. On a server, start that
binary directly after building instead of compiling through `cargo run` on each
restart.

## Configure `.env`

Use dedicated, low-balance wallets, never a main wallet or seed phrase.

```bash
cp -n .env.example .env
chmod 600 .env
```

Set:

```text
JUPITER_API_KEY=your_developer_key
JUPITER_SOLANA_PRIVATE_KEY=your_dedicated_solana_secret
SOLANA_RPC_URL=https://your-low-latency-solana-rpc

POLYMARKET_PRIVATE_KEY=0xyour_dedicated_polygon_signer_key
POLYMARKET_WALLET_ADDRESS=0xyour_polymarket_funder_or_deposit_wallet
POLYMARKET_SIGNATURE_TYPE=poly1271
POLYMARKET_RELAYER_API_KEY=your_polymarket_relayer_key
POLYMARKET_RELAYER_API_KEY_ADDRESS=0xthe_key_owner_address

LIVE_TRADING_CONFIRMATION=I_ACCEPT_REAL_MONEY_RISK
```

Key details:

- `JUPITER_SOLANA_PRIVATE_KEY` accepts base58 or a JSON byte array.
- `POLYMARKET_PRIVATE_KEY` is a `0x`-prefixed 32-byte signer key.
- `POLYMARKET_WALLET_ADDRESS` may differ from the signer for a deposit/proxy
  wallet. Select `eoa`, `proxy`, `gnosis_safe`, or `poly1271` accurately.
- New deposit wallets use `poly1271`; older Polymarket proxy accounts use
  `proxy`. `pnpm check:live:readiness` verifies that the configured address is
  exactly the address derived from the signer and selected wallet type.
- Production CLOB V2 runs at `https://clob.polymarket.com` and uses pUSD atomic
  balances. Do not use the retired pre-cutover `clob-v2` testing host.
- The relayer key owner address is the address displayed with the key in
  Polymarket settings; do not assume it equals the funded wallet.
- The Rust CLI loads `.env` automatically. Do not paste secrets into commands,
  logs, screenshots, or support messages.

### Jupiter Developer key: request buckets and product access

Prediction requests and Swap V2 `/order` builds share one process-wide 100 ms
scheduler, matching the Developer plan's 10 RPS main bucket. Entry and recovery
work has priority and jumps queued discovery. Authenticated Swap V2 `/execute`
uses Jupiter's separate paid-plan execute bucket (documented at 100 RPS), so a
signed transaction no longer waits behind discovery/build traffic. Public Degen
and Polymarket WebSockets do not consume either authenticated budget.

The Developer plan and product access are separate. The key must be enabled for
both **Prediction** and **Swap** in the Jupiter portal. If startup reports:

```text
Jupiter rejected JUPITER_API_KEY ... Prediction product permission
```

the program received a real `401 Unauthorized`. Enable/allow-list Prediction or
replace the key; changing retry timing cannot fix it.

## Safe first run

Read-only monitoring:

```bash
pnpm monitor:short-window --no-daily-threshold
```

One synchronized sample and no status server:

```bash
pnpm monitor:short-window --once --no-web --no-daily-threshold
```

With the `pnpm <script>` shorthand, pass Rust CLI options directly. Do not add
an extra standalone `--`; that would reach `jupol` as an option terminator and
make a following option such as `--once` an unexpected positional argument.

The short-window scanner uses the Polymarket market WebSocket with REST only as
a stale/missing-book fallback, plus Jupiter's public Degen price WebSocket for
screening. A candidate must still pass a new authenticated, executable Jupiter
build immediately before an order can be armed.

Then run read-only live readiness:

```bash
pnpm check:polymarket:live
pnpm check:live:readiness
```

Readiness verifies the configured wallet identity, real collateral/USDC, CLOB
allowances, Jupiter status, and the SOL reserve. It never signs or submits an
order or transaction.

If Polymarket allowances are missing, explicitly run:

```bash
pnpm setup:polymarket:live
```

That command may send approval/deployment transactions and exits afterward.

## Start live trading

```bash
pnpm bot:short-window:live
```

Short-window only:

```bash
pnpm bot:short-window:live --no-daily-threshold
```

Do not run two live variants at once. Live mode binds `127.0.0.1:3210` before
wallet/API setup, making the status port a single-instance lock, and uses the
same durable state by default.

The live path:

1. ranks both complementary routes from fresh WebSocket data;
2. gets a new exact Jupiter Prediction or Swap build;
3. re-reads Polymarket depth and prepares an exact-share FOK;
4. persists an intent before exposure;
5. releases the signed Polymarket and Jupiter submissions concurrently;
6. reconciles actual conditional tokens and wallet collateral/USDC before
   recording quantities or cost; Swap V2 uses `/execute`'s confirmed
   `totalInputAmount` and `totalOutputAmount` and Prediction uses its documented
   status/history APIs;
7. computes Polymarket-only-win, Jupiter-only-win, both-win and both-lose P&L;
8. holds reconciled exposure to settlement, automatically redeems/claims, and
   reclaims empty Forecast token-account rent.

Unknown quantity, identity, or cash debit is kept in recovery state and is not
reported as realized profit. Known mismatches can use only the configured
bounded repair. An unresolved, one-sided, mismatched, or negative-floor position
quarantines new entries while settlement and recovery keep running; it does not
globally halt the process. Live mode re-runs recovery every 15 seconds, waits out
ambiguous Swap handoffs, and never races a pending Jupiter keeper order.
Cross-chain execution is still non-atomic.

Jupiter Prediction is used for `$5+` native Forecast orders and all standard
`POLY-*` markets. Native Forecast orders below `$5` may use direct Swap V2 down
to the configured `$0.10` strategy floor when an outcome mint and viable route
exist.

## Current controls

Show the authoritative list:

```bash
pnpm bot:short-window:live --help
```

Common options:

| Option | Default | Meaning |
| --- | ---: | --- |
| `--max-venue-allocation-usd` | `$50` | Maximum cost at either venue for one position |
| `--minimum-venue-balance-usd` | `$50` | Startup wallet requirement |
| `--maximum-open-positions` | `5` | Portfolio-wide unsettled-position limit |
| `--minimum-entry-edge-usd` | `$0.001` | Minimum edge per contract |
| `--minimum-entry-profit-usd` | `$0.10` | Minimum total modeled edge |
| `--jupiter-minimum-order-usd` | `$0.10` | Native Forecast Swap floor; Prediction remains `$5` |
| `--polymarket-minimum-order-usd` | `$1` | Marketable BUY minimum |
| `--maximum-slippage-bps` | `100` | Entry/repair protection, allowed range 1–500 |
| `--polymarket-depth-haircut-bps` | `2000` | Ignores the last 20% of displayed depth |
| `--maximum-jupiter-submit-quote-age-ms` | `500` | Build-to-handoff ceiling, including a conservative 250 ms critical-slot budget |
| `--maximum-emergency-hedge-loss-usd` | `$1` | Bound for a post-fill repair |
| `--jupiter-fill-timeout-ms` | `20000` | Confirmation/reconciliation timeout |
| `--max-polymarket-age-ms` | `750` | Maximum entry snapshot age |
| `--max-jupiter-age-ms` | `2000` | Maximum indicative snapshot age |
| `--polymarket-poll-ms` | `5000` | REST fallback cadence; WebSocket is primary |
| `--entry-cutoff-seconds` | `30` | Final no-entry window; values below 30 are rejected |
| `--disable-sub-five-jupiter-swap` | off | Require Jupiter Prediction's `$5` minimum |
| `--no-daily-threshold` | off | Disable daily Bitcoin-above-strike mirrors |
| `--output` | Rust JSONL path | Append-only diagnostics/candidates |
| `--live-state` | shared state path | Durable exposure and settlement state |
| `--web-port` | `3210` | Status API and live instance lock |

Example conservative live run:

```bash
pnpm bot:short-window:live \
  --no-daily-threshold \
  --max-venue-allocation-usd=10 \
  --maximum-open-positions=1 \
  --minimum-entry-profit-usd=0.25 \
  --maximum-slippage-bps=50
```

## Dashboard

In another terminal:

```bash
pnpm dashboard:dev
```

Open `http://localhost:3000`. The status source is
`http://127.0.0.1:3210/api/status`. For another scanner port, use
`http://localhost:3000/?scannerPort=3211`. The dashboard is read-only.

## Logs and durable state

Defaults:

```text
logs/btc-poly-jup-short-window-rust.jsonl
logs/btc-poly-jup-short-window-live-state.json
```

Inspect candidates and execution errors:

```bash
tail -f logs/btc-poly-jup-short-window-rust.jsonl | \
  jq --unbuffered -c 'select(.type == "candidate" or .type == "daily_threshold_candidate" or .type == "execution_error")'
```

Inspect the durable state without editing it:

```bash
cargo run --release -p jupol-scanner -- state
```

State writes use a unique sibling temporary file, sync it, and atomically
replace the destination. Live mode's instance lock prevents two coordinators;
the unique temporary names also avoid the Windows `.tmp` source collision seen
in the previous runtime.

## Stop, recover, redeem

Press `Ctrl-C` once and allow an active entry/reconciliation to finish. Never
delete the state to clear a halt: a new file forgets exposure but cannot close
it on either venue.

First inspect the state and both real wallets. Then, if the recorded identities
are correct, run the explicit recovery command:

```bash
pnpm recover:live --maximum-repair-loss-usd=1 --maximum-slippage-bps=100
```

This command is **not read-only**. It re-observes both legs and may buy or sell a
Polymarket FOK only when the resulting repair is within both bounds. If costs or
identities remain unknown, it leaves the position for manual reconciliation.

Live mode automatically handles supported settlement. To manually retry
Polymarket redemption for markets still present in state:

```bash
pnpm redeem:polymarket
```

Or target one market already present in the durable state:

```bash
pnpm redeem:polymarket --market-id=MARKET_ID
```

Redemption sends a gasless relayer transaction.
An arbitrary market ID outside the state is refused because its payout could
not be attached to an entry or included safely in realized P&L.

Automatic settlement records realized P&L from confirmed wallet credits. A
confirmed Polymarket redemption is saved as pending before credit observation,
so a restart rechecks that transaction instead of submitting the redemption
again. Jupiter claim accounting likewise uses the confirmed owned-USDC credit,
not the API's pre-transaction payout estimate. Fully settled positions are moved
to the state's immutable `settled_positions` audit ledger instead of being
discarded.

Polymarket redemption also refreshes the exact held conditional-token balance
before submitting. If it differs from durable state by more than 0.01 contracts,
redemption is blocked and the position remains reconciliation work. This catches
old states that retained an initial fill after the contracts had already been
sold or repaired; a confirmed zero-value relay transaction is not accepted as a
payout.

## Common failures

- `401 Unauthorized`: the key lacks Prediction product access or is invalid;
  enable it in the Jupiter portal. The 10 RPS plan alone does not grant access.
- `429` from Prediction or Swap `/order`: another process may share the same key,
  or the upstream main bucket is tighter than expected. This process spaces the
  main bucket at 100 ms. A Solana RPC `429` is separate: use a paid, low-latency
  RPC and do not confuse it with Jupiter API rate limiting.
- Swap `/execute` failure: diagnostics include request ID, router, execution
  mode, code and error. Failed-to-land/unknown results are retried only with the
  identical signed transaction and request ID; expired/rejected builds are not
  rebuilt blindly.
- `NEW ENTRIES PAUSED`: an existing position failed the post-fill safety gate or
  still needs reconciliation. Recovery and settlement continue. Inspect the
  position and submission diagnostics; do not delete the state file.
- `ENTRY_CUTOFF`: fewer than 30 seconds remain; no new entry is allowed.
- `JUPITER_BUILD_EXPIRED`: local preparation plus the reserved 10 RPS execution
  slot cannot fit inside the 500 ms freshness ceiling; the transaction is
  discarded, never submitted stale.
- `VENUE_MINIMUM_REJECTED`: exact price/quantity fell below Jupiter Prediction,
  Swap routing, or Polymarket's current minimum.
- stale Polymarket feed: the WebSocket reconnects automatically and the REST
  fallback refreshes every five seconds; stale data cannot arm entry.
- port `3210` in use: another scanner/live process is running. Do not evade this
  protection for the same wallets/state.

For the risk model, see [docs/LIVE_TRADING.md](docs/LIVE_TRADING.md). For the Rust
crate layout, see [rust/README.md](rust/README.md).
