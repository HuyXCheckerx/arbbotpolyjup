# Project direction

Status: planning  
Research snapshot: 2026-08-20

## Objective

Build a bot that acquires complementary binary outcomes across independent venues when the combined worst-case acquisition cost is less than the common payout.

For an exactly equivalent event `E`, one direction is:

```text
buy YES(E) on Polymarket + buy NO(E) through Jupiter
```

The other direction reverses the venues. For matched quantity `q`:

```text
locked_profit(q)
  = q * payout_per_contract
  - polymarket_all_in_cost(q)
  - jupiter_all_in_cost(q)
  - operating_buffer(q)
```

All inputs must be calculated at executable depth. Midpoints and top-of-book prices are useful for discovery only.

## Venue reality and viability gate

“Polymarket versus jup.ag” is not automatically a two-venue trade:

- Jupiter’s Prediction API aggregates provider liquidity, including Polymarket and Kalshi.
- Jupiter market data exposes a `provider` and underlying provider-specific identifiers such as `clobTokenIds`.
- Jupiter defaults event discovery to the Polymarket provider.
- A Jupiter `provider=polymarket` listing is the same economic/liquidity source, not an independent hedge. It must be rejected.
- Ordinary Jupiter prediction orders are created on Solana and filled by a keeper. They may be `created`, `partiallyfilled`, `filled`, or `failed`. Creating the order does not guarantee a fill.
- Jupiter Forecast (`provider=bisonfi`) has an atomic-swap execution model, but the documented product currently consists of 15-minute BTC up/down rounds. It is not a substitute for arbitrary daily threshold markets.

Phase 0 is therefore a hard go/no-go gate:

1. Find a Jupiter market backed by an independent provider.
2. Prove its resolution contract is exactly complementary to the Polymarket contract.
3. Determine whether its order path can meet the strict taker-only invariant without leaving a resting intention.
4. Confirm both APIs and the intended deployment jurisdiction permit the activity.

If step 2 fails, classify the pair as a basis/convergence trade, not arbitrage, and keep it disabled in the arbitrage strategy. If step 3 fails, do not ship live trading through that Jupiter path.

## Contract equivalence

Automated title matching is only candidate generation. A pair is eligible only after a normalized contract record matches on every material dimension:

| Dimension | Required comparison |
| --- | --- |
| Underlying | Same asset and reference symbol |
| Predicate | `>` versus `>=` must match |
| Strike | Same value, currency, and precision |
| Observation | Same instant/window and explicit timezone |
| Price source | Same exchange, index, or oracle and sampling rule |
| Resolution | Same primary/secondary rules and dispute path |
| Exceptional cases | Same outage, ambiguity, postponement, and cancellation behavior |
| Void behavior | Same refund/payout behavior in every non-binary outcome |
| Payout | Same value per contract after claim costs |
| Provider | Independent underlying venues/order books |

The normalizer produces one of three states:

- `EXACT`: logically complementary in all outcomes; eligible for strict arbitrage.
- `BASIS`: economically related but different oracle, timing, wording, or void behavior; disabled by default.
- `REJECT`: different event, shared liquidity, ambiguous rules, or incomplete metadata.

Every approved mapping is versioned by hashes of both venues’ complete rules. A rule change disables the mapping until it is reviewed again.

## Fee and price model

Use integer fixed-point units throughout:

- USD and contract prices: micro-USD (`1_000_000 = $1`).
- Contract quantities: micro-contracts (`1_000_000 = 1 contract`).
- Timestamps: integer milliseconds.
- JavaScript `number` is prohibited for money and quantity accounting; use `bigint` plus explicit rounding helpers.

Polymarket’s current crypto taker fee is price-dependent:

```text
fee = contracts * fee_rate * price * (1 - price)
```

The current documented crypto fee rate is `0.07`, but the bot must query per-market fee parameters and must not hard-code that value. Polymarket fees are assessed at match time.

Jupiter returns estimated protocol, venue, and total fees in its order build. Jupiter also documents cent-up fee rounding. Treat its returned fee fields as authoritative for the quote and round conservatively if a field is absent. Do not assume Jupiter’s fee equals Polymarket’s fee, even where the displayed curve looks similar.

For direction `P:YES + J:NO`, the trade is eligible only if:

```text
max_pair_cost(q)
  = poly_vwap_yes(q)
  + poly_taker_fee(q)
  + jup_quote_cost_for_exact_filled_q
  + jup_total_fee(q)
  + chain_cost_buffer
  + stablecoin_haircut
  + legging_loss_reserve

max_pair_cost(q) <= q - required_profit(q)
```

Evaluate both directions and solve for the largest safe `q` using full depth. Jupiter buys are deposit-driven, so its adapter must convert the deposit to exact quoted `contractsMicro` before execution. Both venue orders are then prepared against that quote and released concurrently; a mismatch halts rather than triggering a delayed one-sided catch-up order.

## Product scope

### MVP

- BTC threshold markets first; one event family and one approved provider pair.
- Read-only discovery and semantic mapping.
- Full-depth, fee-aware opportunity calculation.
- Deterministic replay simulator.
- Taker-only Polymarket execution through marketable FOK orders.
- Jupiter capability spike and, only if it passes, small-clip live execution.
- Persistent state machine, reconciliation, kill switch, and operator alerts.

### Later

- ETH, SOL, and XRP.
- More time horizons and independent providers.
- Automated treasury rebalancing outside the execution path.
- Portfolio-wide capital allocation.

### Explicit non-goals

- Market making or maker rebates.
- Directional prediction or machine-learning alpha.
- Treating oracle/rule basis as risk-free arbitrage.
- Just-in-time bridging.
- Unbounded retries or martingale sizing.
- Circumventing geographic, KYC, or venue restrictions.

## Proposed architecture

The original MVP used TypeScript/Node.js. The production short-window scanner,
execution coordinator, venue adapters, state, reconciliation and settlement are
now Rust; TypeScript remains for historical discovery/regression tests and the
browser dashboard remains JavaScript. Network and venue latency still dominate,
so the runtime also relies on WebSocket discovery, pooled clients and prepared
concurrent submission rather than expecting a language rewrite alone to improve
fills.

```text
market discovery
      |
contract normalizer/mapping registry
      |
live venue books -> executable quote engine -> opportunity/risk engine
                                              |
                                      execution coordinator
                                       /               \
                              Jupiter adapter    Polymarket adapter
                                       \               /
                                  ledger + reconciler
                                          |
                               metrics, audit, alerts
```

Core modules:

- `domain`: fixed-point types, contracts, quotes, opportunities, fills, and state transitions.
- `venue-polymarket`: discovery, real-time book, fee lookup, FOK orders, fills, and balances.
- `venue-jupiter`: events, provider identity, depth, order build/sign/submit, positions, and fees.
- `matcher`: normalized contract comparison and reviewed mapping registry.
- `scanner`: synchronized books, depth walking, sizing, and threshold checks.
- `coordinator`: durable execution saga and recovery actions.
- `risk`: pre-trade, in-flight, portfolio, and circuit-breaker checks.
- `ledger`: orders, transactions, fills, positions, fees, and reconciliation.
- `operator`: health, metrics, alerts, pause, and emergency flatten commands.

Use PostgreSQL as the durable source of truth. Market-data snapshots may use an in-memory cache, but any external action must be journaled before submission and reconciled afterward.

## Security direction

- Separate low-balance hot wallets for Polygon/Polymarket and Solana/Jupiter.
- No seed phrases or raw private keys in source, logs, database rows, crash dumps, or command history.
- Put signing behind a narrow interface so it can move to a hardware/KMS-backed signer later.
- Scope API credentials, rotate them, and redact authentication headers.
- Treat server-built Solana transactions as untrusted: decode and validate program IDs, accounts, mint, amount, market, and price limits before signing.
- Apply withdrawal allowlists and keep treasury credentials out of the trading process.
- Reconcile venue balances independently of the strategy’s local ledger.

## Sources consulted

Current venue behavior must be rechecked before implementation because both APIs are evolving.

- [Jupiter Prediction overview](https://github.com/jup-ag/docs/blob/main/prediction/index.mdx)
- [Jupiter event, provider, market, and orderbook data](https://github.com/jup-ag/docs/blob/main/prediction/events-and-markets.mdx)
- [Jupiter order lifecycle](https://github.com/jup-ag/docs/blob/main/prediction/open-positions.mdx)
- [Jupiter Prediction OpenAPI schema](https://github.com/jup-ag/docs/blob/main/openapi-spec/prediction/prediction.yaml)
- [Polymarket fee model](https://docs.polymarket.com/trading/fees)
- [Polymarket order lifecycle and FOK/FAK semantics](https://docs.polymarket.com/concepts/order-lifecycle)
- [Polymarket real-time market data](https://docs.polymarket.com/market-data/realtime-data)
- [Polymarket geographic restrictions](https://docs.polymarket.com/api-reference/geoblock)
