# Implementation plan

The project advances by evidence-backed gates. A later phase does not begin merely because code exists; the preceding acceptance criteria must pass.

## Phase 0 — venue and strategy viability

Status on 2026-08-20: read-only discovery, normalization, shared-provider rejection, and snapshot orderbook fetching are implemented. The first bounded live scan found no independent `EXACT` pair, so the live-execution exit criteria have not passed.

Deliverables:

- Read-only scripts for Jupiter event/provider/market/orderbook discovery.
- Read-only scripts for Polymarket event, rule, token, fee, and orderbook discovery.
- One manually reviewed BTC candidate mapping.
- Provider/underlying-liquidity identity report.
- Jupiter taker/FOK capability decision for the candidate market family.
- Jurisdiction and venue-account eligibility checklist.

Exit criteria:

- At least one pair has independent liquidity and `EXACT` rules.
- The Jupiter path meets the agreed definition of taker-only, or scope is changed.
- Fee and order precision can be obtained programmatically.

Stop condition: if no such pair exists, keep the project as a scanner and do not build live execution.

## Phase 1 — domain foundation

Repository shape:

```text
apps/
  scanner/
  executor/
  operator-cli/
packages/
  domain/
  matcher/
  venue-polymarket/
  venue-jupiter/
  risk/
  persistence/
  test-fixtures/
docs/
```

Deliverables:

- TypeScript workspace with strict compiler/lint/test configuration.
- Branded fixed-point types for micro-USD, micro-contracts, basis points, and timestamps.
- Canonical contract, book, fee, quote, opportunity, order, fill, and saga models.
- Explicit rounding library and golden tests.
- PostgreSQL migrations for mappings, snapshots, sagas, actions, fills, and reconciliation.
- Structured/redacted logging and configuration validation.

Exit criteria:

- No money path uses floating-point arithmetic.
- Serialization round-trips values above JavaScript’s safe integer limit.
- All external actions have durable intent and idempotency fields.

## Phase 2 — read-only adapters and matcher

Deliverables:

- Polymarket discovery, fee, snapshot, and real-time orderbook adapter.
- Jupiter discovery, provider metadata, market, orderbook, and trading-status adapter.
- Snapshot bootstrap plus stream-gap recovery.
- Candidate matcher and reviewed mapping registry with rule hashes.
- Shared-liquidity rejection using provider and underlying CLOB identifiers.

Exit criteria:

- Recorded books reproduce venue top-of-book and depth totals.
- Restart/snapshot recovery introduces no silent book gaps.
- Known near-matches (`> / >=`, timezone, oracle, and void differences) are rejected.
- `provider=polymarket` is always rejected as the Jupiter hedge for a Polymarket leg.

## Phase 3 — fee-aware scanner and simulator

Deliverables:

- Depth-walking VWAP and quantity solver for both directions.
- Per-market Polymarket fee lookup/calculation.
- Jupiter quote/order-build parser for exact contracts and all returned fee fields.
- Conservative network, rounding, stablecoin, and legging buffers.
- Opportunity stream with complete calculation trace.
- Deterministic replay simulator using recorded venue data.

Exit criteria:

- Golden examples agree with venue fee tables and quote responses.
- No opportunity is emitted from midpoint-only data.
- Profit stays positive under configured worst-price and fee bounds.
- Simulator accounts for partial fills, latency, staleness, and rejection—not instant perfect fills.

## Phase 4 — execution saga in a closed environment

Deliverables:

- Transaction validators and signer interfaces.
- Polymarket marketable FOK builder and status/fill reconciliation.
- Jupiter build/sign/submit/status/position reconciliation for the approved execution model.
- Durable state machine and per-market lock.
- Compensation logic, kill switch, and operator CLI.
- Fault-injection harness for timeouts, duplicates, partials, reorg/RPC ambiguity, and restarts.

Exit criteria:

- A crash at every state transition recovers without duplicating exposure.
- Request timeouts are reconciled before retry.
- Both venue submissions launch concurrently after pre-sign/pre-simulation; mismatched or partial outcomes halt without a sequential catch-up order.
- Risk-reducing actions remain possible while new entries are paused.
- Unexpected Solana transaction contents are rejected before signing.

## Phase 5 — shadow and canary

Shadow mode records decisions and counterfactual fills without signing.

Required shadow metrics:

- detected versus executable opportunities;
- quote-to-submit and submit-to-fill latency distributions;
- edge decay by latency;
- partial/failure rate by venue;
- expected versus confirmed fees and quantity;
- simulated legging losses and recovery success;
- false matches and rule/provider changes.

Canary mode:

- one approved BTC market family;
- one execution saga at a time;
- minimum practical clip size;
- supervised operation with immediate alerts;
- automatic halt after any uncertain state or limit breach.

Promotion criteria:

- sustained reconciliation accuracy;
- no taker-only invariant violations;
- confirmed net P&L matches the ledger within rounding tolerance;
- measured failure/recovery behavior fits configured capital-at-risk limits.

## Phase 6 — production hardening

- Redundant market-data/RPC paths and health scoring.
- Managed secret/signing service.
- PostgreSQL backup and recovery drills.
- Metrics dashboards, pages, and runbooks.
- Automated claims and treasury reports.
- Separate, rate-limited treasury rebalancer.
- Dependency/API changelog monitoring and contract-rule revalidation.

## Test strategy

### Unit and property tests

- fee curves and venue rounding;
- integer conversion and overflow boundaries;
- orderbook depth/VWAP and inverse deposit-to-contract solving;
- complement/payout invariants;
- contract normalization and rule mismatch rejection;
- size limits and residual dust.

### State-machine tests

Generate event sequences containing duplicate, delayed, missing, and out-of-order responses. Assert exposure and state invariants after every event.

### Integration tests

- recorded HTTP/WebSocket fixtures by default;
- read-only live smoke tests behind an explicit flag;
- transaction build/decode validation without signing;
- test wallets only for any chain submission.

### Failure drills

- crash after signing but before response persistence;
- Jupiter partial fill followed by Polymarket book removal;
- Polymarket FOK rejection after Jupiter fill;
- RPC says timeout while transaction later confirms;
- provider/rules change between quote and submission;
- stablecoin or venue trading-status circuit breaker.

## First engineering backlog

1. Capture real JSON for one BTC candidate from both APIs.
2. Write the canonical `BinaryContract` schema and manual mapping file.
3. Implement integer money/quantity primitives and fee golden tests.
4. Implement shared-provider rejection.
5. Build read-only depth/VWAP adapters.
6. Build the opportunity calculator with a full audit trace.
7. Record a market-data session and replay it deterministically.
8. Resolve the Jupiter taker-only capability gate.
9. Only then add signing and order submission.

## Decisions intentionally deferred

- Exact deployment region, pending measured latency to both venues.
- Rust rewrite, pending profiler evidence.
- Hardware/KMS signer vendor.
- Automated market mapping; manual approval is required for MVP.
- Perpetual/spot disaster hedge, pending a separate risk review.
