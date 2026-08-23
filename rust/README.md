# Jupol Rust migration

This directory is a side-by-side native migration of the trading runtime. The
existing `npm run bot:short-window` entrypoint remains the production command
until every live-execution gate below is complete. Do not point both runtimes at
the same wallet and state file concurrently.

## Implemented

- `jupol-domain`: exact `i128` micro-USD and micro-contract parsing, formatting,
  fee calculation, complementary-route evaluation, depth walking, entry sizing,
  and green-exit evaluation.
- `jupol-runtime`: bounded coalescing market-data queue and priority-aware shared
  Jupiter request scheduler.
- `jupol-http`: pooled HTTP/1.1 + HTTP/2 transport with timeouts, bounded retries,
  and Jupiter rate-limit delay handling.
- `jupol-state`: schema-v1 live-state compatibility, including the TypeScript
  `"123n"` bigint representation and atomic temporary-file replacement.
- `jupol-jupiter`: developer-key Prediction API operations used by the live hot
  path: trading status, buy/close build, signed execution, order/position poll,
  and exact order-book conversion.

The Rust sizing search sorts each venue book once. Repeated binary-search probes
walk borrowed sorted slices and allocate no temporary vectors.

## Commands

```powershell
npm run rust:check
npm run rust:test
npm run rust:bench:domain
```

On the initial Windows development machine, the release benchmark completed one
million full exact entry-sizing evaluations in about 2.29 seconds, or about
2.29 microseconds per evaluation. This is a microbenchmark, not an order-fill or
profit claim; network and venue matching latency remain dominant in live trades.

## Required before switching the live command

- Integrate Polymarket's official `polymarket_client_sdk_v2` 0.6 client (it
  supports both the V1 USDC.e host and V2 pUSD host), then port and test CLOB
  authentication, signing, FOK submission,
  approvals, redemption, and balance reconciliation.
- Port Solana transaction decoding/signing, RPC balance checks, simulation,
  confirmation, and Jupiter claim handling.
- Port Forecast Swap fallback, both WebSocket feeds, market discovery, reference
  streams, window selection, and recovery/reconciliation logic.
- Port the live trader state machine and reproduce all TypeScript fault-injection
  tests, especially ambiguous submission and one-sided exposure cases.
- Serve the existing dashboard/status JSON from the Rust process.
- Run shadow mode against the same public feeds without signing, compare every
  proposal and rejection reason, then perform readiness checks with zero open or
  unresolved exposure before changing the production script.

The browser dashboard assets can remain JavaScript without affecting trading
latency; the native status server will serve them as static files. Rewriting the
browser UI to WebAssembly is intentionally not on the execution critical path.
