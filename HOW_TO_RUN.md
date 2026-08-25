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
| Monitor the current 5m BTC pair | `pnpm monitor:short-window` | No |
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
JUPITER_SOLANA_PUBLIC_KEY=your_dedicated_solana_address
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

- Read-only monitoring needs `JUPITER_SOLANA_PUBLIC_KEY` so `/order` can return
  wallet-specific executable transactions. If the private key is configured,
  Rust derives the same public key and the explicit public variable is optional.
- `JUPITER_SOLANA_PRIVATE_KEY` accepts base58 or a JSON byte array and is
  required for live trading.
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

Market-metadata requests and Swap V2 `/order` builds share one process-wide
100 ms scheduler, matching the Developer plan's 10 RPS main bucket. UP and DOWN
executable orders alternate every 100 ms globally by default, refreshing each
side every 200 ms without a two-request burst. Authenticated Swap V2 `/execute`
uses Jupiter's separate paid-plan execute bucket (documented at 100 RPS), so a
signed transaction does not wait behind price discovery.

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
pnpm monitor:short-window
```

One synchronized sample and no status server:

```bash
pnpm monitor:short-window --once --no-web
```

With the `pnpm <script>` shorthand, pass Rust CLI options directly. Do not add
an extra standalone `--`; that would reach `jupol` as an option terminator and
make a following option such as `--once` an unexpected positional argument.

The scanner uses the Polymarket market WebSocket with REST only as a
stale/missing-book fallback. Jupiter WebSocket and indicative REST prices are
not used. Direct Swap V2 `/order` responses are the Jupiter price source and
already contain the wallet-specific transaction that live mode can sign.

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

Do not run two live variants at once. Live mode binds `127.0.0.1:3210` before
wallet/API setup, making the status port a single-instance lock, and uses the
same durable state by default.

The live path:

1. continuously pipelines exact 5m UP and DOWN Swap V2 executable orders;
2. ranks both complementary routes using `otherAmountThreshold` and fresh
   Polymarket depth;
3. selects the newest in-budget Jupiter build, uses cached balances and fresh
   WebSocket depth when available, and falls back to live reads only when cold;
4. prepares an exact-share Polymarket FOK and signs that existing Jupiter build;
5. persists an intent before exposure;
6. releases the signed Polymarket and Jupiter submissions concurrently;
7. reconciles actual conditional tokens and wallet collateral/USDC before
   recording quantities or cost; Swap V2 uses `/execute`'s confirmed
   wallet totals (`totalInputAmount` and `totalOutputAmount`) and does not
   confuse their fee-adjusted route-result counterparts with contradictory
   fills; Prediction uses its documented status/history APIs;
8. computes Polymarket-only-win, Jupiter-only-win, both-win and both-lose P&L;
9. holds reconciled exposure to settlement, automatically redeems/claims, and
   reclaims empty Forecast token-account rent.

Unknown quantity, identity, or cash debit is kept in reconciliation state and
is not reported as realized profit. A known quantity mismatch is retained when
both intended single-winner payouts exceed actual combined cost by the
configured post-fill floor. Automatic startup, periodic, and immediate
post-entry repair are disabled. An unresolved, one-sided, negative-floor, or
ambiguous position is persisted and quarantines new entries; live mode will not
submit a repair order. Settlement continues independently. Cross-chain
execution is still non-atomic.

All new 5-minute entries use direct Swap V2. The executable price-discovery
amount defaults to `$5` and is configurable; every candidate is therefore
size-specific rather than extrapolated from a displayed unit price.

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
| `--minimum-post-fill-profit-usd` | `$0` | Actual single-winner P&L floor; positive residuals are retained by default |
| `--jupiter-minimum-order-usd` | `$0.10` | Native Forecast Swap floor; Prediction remains `$5` |
| `--jupiter-order-input-usd` | `$5` | Exact USDC input for every executable UP/DOWN discovery order |
| `--jupiter-order-request-interval-ms` | `100` | Global alternating `/order` cadence; each side refreshes every 200 ms at 10 RPS total |
| `--polymarket-minimum-order-usd` | `$1` | Marketable BUY minimum |
| `--maximum-slippage-bps` | `300` | Polymarket entry and explicit repair protection only, allowed range 1–2500; the modeled-profit gate uses the protected limit |
| `--jupiter-fixed-slippage-bps` | omitted | Diagnostic override only; omission sends no `slippageBps` and uses Jupiter RTSE |
| `--polymarket-depth-haircut-bps` | `2000` | Ignores the last 20% of displayed depth |
| `--maximum-jupiter-submit-quote-age-ms` | `400` | `/order` request-start-to-entry-handoff budget, including remote build RTT |
| `--maximum-jupiter-adverse-move-bps` | `300` | Blocks an entry after a larger adverse move between consecutive Jupiter builds |
| `--jupiter-velocity-window-ms` | `1000` | Lookback window for the adverse-move gate |
| `--maximum-emergency-hedge-loss-usd` | `$1` | Dormant while automatic live repair is disabled |
| `--jupiter-fill-timeout-ms` | `20000` | Confirmation/reconciliation timeout |
| `--max-polymarket-age-ms` | `750` | Maximum entry snapshot age |
| `--max-jupiter-age-ms` | `2000` | Maximum executable-order snapshot age used for screening |
| `--polymarket-poll-ms` | `5000` | REST fallback cadence; WebSocket is primary |
| `--entry-cutoff-seconds` | `30` | Final no-entry window; values below 30 are rejected |
| `--disable-sub-five-jupiter-swap` | off | Legacy recovery compatibility; new 5m entries always use Swap V2 |
| `--output` | Rust JSONL path | Append-only diagnostics/candidates |
| `--live-state` | shared state path | Durable exposure and settlement state |
| `--web-port` | `3210` | Status API and live instance lock |

Example conservative live run:

```bash
pnpm bot:short-window:live \
  --jupiter-order-input-usd=5 \
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
  jq --unbuffered -c 'select(.type == "candidate" or .type == "execution_error")'
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

Live mode never starts recovery or submits a repair automatically. First
inspect the state and both real wallets. Then, only if the recorded identities
are correct, run the explicit operator recovery command:

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
  still needs reconciliation. Automatic recovery is disabled, while settlement
  continues. Inspect the position and submission diagnostics; do not delete the
  state file.
- `ENTRY_CUTOFF`: fewer than 30 seconds remain; no new entry is allowed.
- `JUPITER_BUILD_EXPIRED`: remote build time plus local preparation cannot fit
  inside the 400 ms request-start-to-handoff budget; the transaction is
  discarded, never submitted stale.
- `JUPITER_HIGH_VELOCITY`: consecutive executable Jupiter prices moved adversely
  beyond the configured threshold; widening fixed slippage is not the remedy.
- `VENUE_MINIMUM_REJECTED`: exact price/quantity fell below Jupiter Prediction,
  Swap routing, or Polymarket's current minimum.
- stale Polymarket feed: the WebSocket reconnects automatically and the REST
  fallback refreshes every five seconds; stale data cannot arm entry.
- port `3210` in use: another scanner/live process is running. Do not evade this
  protection for the same wallets/state.

For the risk model, see [docs/LIVE_TRADING.md](docs/LIVE_TRADING.md). For the Rust
crate layout, see [rust/README.md](rust/README.md).
