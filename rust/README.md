# Jupol Rust runtime

The production short-window scanner and live trader run entirely in Rust. The
dashboard remains browser JavaScript, and the old TypeScript runtime is retained
as a regression/reference implementation; neither is on the live execution hot
path.

## Crates

- `jupol-domain`: exact fixed-point prices, quantities, fees, route ranking and
  sizing. Trading math contains no floating-point arithmetic.
- `jupol-runtime`: bounded/coalescing queues and the shared priority Jupiter
  request scheduler.
- `jupol-http`: pooled HTTP transport, timeouts and bounded rate-limit retries.
- `jupol-jupiter`: Prediction market metadata, executable Swap V2 order
  construction, transaction signing, confirmation, fill reconciliation, claim
  and rent reclaim.
- `jupol-polymarket`: Gamma discovery, CLOB market WebSocket with REST fallback,
  authenticated exact-share FOK orders, balance reconciliation, approvals and
  gasless redemption.
- `jupol-solana`: RPC, balances, transaction simulation/submission/confirmation,
  owned-token deltas and empty token-account closure.
- `jupol-state`: TypeScript schema-v1-compatible durable state with atomic
  sibling temporary-file replacement.
- `jupol-live`: durable concurrent two-venue execution, four-state exposure
  accounting, bounded recovery and settlement.
- `jupol-scanner`: 15-minute market discovery, continuously pipelined executable
  Jupiter prices, status API, structured JSONL diagnostics and the CLI.

## Build and verify

Rust 1.90 or newer is required.

```bash
cargo build --release -p jupol-scanner
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Or run the repository wrapper:

```bash
npm run rust:check
```

## Run

```bash
# Read only
cargo run --release -p jupol-scanner -- monitor

# Real orders; also requires LIVE_TRADING_CONFIRMATION in .env
cargo run --release -p jupol-scanner -- live

# Read-only wallet/API checks
cargo run --release -p jupol-scanner -- readiness

# Check public IP geoblocking and authenticated Polymarket read access
cargo run --release -p jupol-scanner -- check-polymarket-access

# Explicitly reconcile an interrupted durable state and make bounded repairs
cargo run --release -p jupol-scanner -- recover
```

Use only one live process per wallet and state file. Port `3210` is bound before
wallet/API initialization and acts as the local single-instance lock.

## Jupiter Developer plan

Prediction market-metadata discovery and Swap V2 `/order` requests share one
scheduler at 100 ms minimum spacing, matching a 10 RPS Developer main bucket.
The scanner alternates executable 15m UP/DOWN builds every 100 ms globally by
default, refreshing each side every 200 ms. It requests a fixed 300 bps Jupiter
tolerance by default and screens against the returned guaranteed minimum output.
Authenticated Swap V2 `/execute` uses Jupiter's
separate paid-plan execution bucket. Jupiter's public price WebSocket is not
used.

A plan/key existing is not enough by itself: the key must have both Prediction
and Swap product access. A Prediction `401 Unauthorized` is terminal and the CLI
exits with a portal-permission message instead of retrying forever.

## Execution boundary

Each entry persists an intent, signs both exact orders, then releases the
Polymarket FOK and Jupiter transaction concurrently. Swap V2 pairs against its
guaranteed output threshold and reconciles confirmed execute amounts; Prediction
uses status plus owner history after keeper orders close. Unsafe or unresolved
positions quarantine new entries while settlement continues. Live mode does
not run startup, periodic, or immediate post-entry repair. The `recover`
command is an explicit operator action and may submit a bounded Polymarket
repair. Unknown quantities or costs remain reconciliation work; they are never
reported as profit.
Finalized records move to a durable settled audit ledger. This reduces process
overhead, but cross-chain execution and the two venues' different resolution
observations can never be atomic.
