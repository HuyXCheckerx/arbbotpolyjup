# Live discovery report — 2026-08-20

Run time: 2026-08-20 23:53 Asia/Ho_Chi_Minh  
Mode: read-only  
Assets: BTC, ETH, SOL, XRP

## Result

No exact independent-provider arbitrage pair was found in the configured discovery window.

The scanner inspected:

- 549 open Polymarket price-threshold markets returned by two public-search pages per asset;
- 48 open Kalshi-backed Jupiter price-threshold markets from the first 100 crypto events;
- 33 same-asset, same/near-strike, near-close-time candidate pairs.

Classification of those 33 independent-provider candidates:

| Verdict | Count |
| --- | ---: |
| `EXACT` | 0 |
| `REVIEW_REQUIRED` | 0 |
| `BASIS` | 0 |
| `REJECT` | 33 |

This is a bounded scan, not a claim that no pair can ever exist. Results change as venues list markets, and pagination limits were intentionally bounded.

## Addendum: daily `BTC above ___ on DATE` ladders

A follow-up scan at 2026-08-20 17:13 UTC specifically checked point-in-time BTC thresholds. Polymarket had six active daily ladders for August 21–26, with 11 strikes per date. Each resolves from the final Close of the Binance BTC/USDT one-minute candle at 12:00 noon ET on the named date, using a strict `>` comparison.

Jupiter exposes these events under its Polymarket provider. Parent events contain strike-specific child markets/orderbooks. For example:

| Polymarket parent | Jupiter parent | Child books | Claim |
| --- | --- | --- | --- |
| `862400` / `bitcoin-above-on-august-21-2026` | `POLY-862400` | `3651166` / `POLY-3651166` | BTC above $72,000 on August 21 |
| August 22 event | Jupiter August 22 event | `3652319` / `POLY-3652319` | BTC above $72,000 on August 22 |

The paired records contain the same two `clobTokenIds`. A contemporaneous orderbook check of `3652319`/`POLY-3652319` also returned the same best YES ask (0.687); small bid/depth differences reflected snapshots taken several seconds apart. These are two routes to the same Polymarket CLOB, not independent legs.

The current Jupiter Kalshi feed contained no daily point-in-time BTC threshold family. Its BTC threshold listings were period-crossing or year-end contracts using CF Benchmarks/BRTI rules. Consequently, the daily ladders produced zero independent-provider point candidates.

The scanner now queries Jupiter per asset subcategory and sorts by `beginAt`, rather than relying only on the volume-ordered crypto feed. It also recognizes Jupiter's numeric-only ladder labels such as `72,000`. This closes the discovery gap that initially hid these lower-volume daily events.

## Why the apparent matches fail

The independent listings often look equivalent by title and strike but represent different claims.

### BTC above $100,000 during August 2026

Polymarket market `3257332`:

- resolves YES on a Binance BTC/USDT 1-minute candle final High at or above $100,000;
- measurement period is the August calendar month in Eastern Time;
- operator is inclusive (`>=`).

Jupiter/Kalshi market `KXBTCMAX100-26-AUG`:

- resolves from the CF Bitcoin Real-Time Index/BRTI;
- applies a trimmed-mean series and early-expiration crossing logic;
- measurement begins July 21, not August 1;
- operator is strict (`>`).

Same headline and strike, but different oracle, sampling, start time, and boundary. The pair is rejected.

### Year-end BTC and SOL candidates

Common differences included:

- Polymarket `>= $100,000` versus Kalshi `> $99,999.99`;
- close timestamps offset by 60 seconds;
- Binance 1-minute High/Low versus CF Real-Time Index calculations;
- “touch at any time” versus a point-in-time 60-second average;
- different market issuance/start times.

These are basis trades, not guaranteed complementary payouts. The strict arbitrage strategy does not trade them.

## Shared-liquidity proof

Jupiter’s Polymarket-backed listings returned the same `clobTokenIds` as Polymarket Gamma. The scanner marked every such pairing `SHARED_LIQUIDITY` before evaluating price.

For live BTC threshold examples, normalized Jupiter and direct Polymarket orderbooks also matched level-for-level. One observed example, Polymarket `1057883` versus Jupiter `POLY-1057883`, showed:

| Outcome | Best bid | Best ask |
| --- | ---: | ---: |
| YES | 0.014 | 0.015 |
| NO | 0.985 | 0.986 |

That is the same underlying CLOB exposed through two APIs, not an arbitrage venue pair.

## Orderbook implementation validation

### Polymarket

The adapter:

1. resolves YES and NO token IDs from market outcomes;
2. fetches both CLOB books;
3. verifies both tokens belong to the same condition;
4. converts prices and quantities to integer micro-units;
5. sorts bids descending and asks ascending.

### Jupiter

Jupiter’s Prediction orderbook exposes YES and NO bid arrays. The adapter constructs executable asks using binary complementarity:

```text
YES ask = 1 - NO bid
NO ask  = 1 - YES bid
```

For independent market `KXBTCMAX100-26-AUG`, the live response had no YES bids and a best NO bid of 0.99. The normalized book therefore correctly produced a best YES ask of 0.01, with no fabricated NO ask.

The endpoint does not currently return a source timestamp, so Jupiter books carry local monotonic receipt time and `sourceTimestampMs=null`. Future execution must impose a short maximum receipt age.

## Operational observation

Keyless Jupiter access worked during this run, but repeated orderbook calls triggered HTTP 429 after the initial burst. The client now serializes keyless Jupiter requests at 2.1-second intervals. Supplying `JUPITER_API_KEY` removes that local throttle; production limits must still follow the account’s actual plan.

## Decision

- Keep all Jupiter `provider=polymarket` pairs disabled as shared liquidity.
- Keep all discovered Kalshi-backed candidates disabled because their payout conditions are not identical.
- Continue with read-only recording/replay and fee-aware depth calculation.
- Do not add signing or order submission until at least one reviewed `EXACT` mapping exists and Jupiter taker semantics pass the separate capability gate.
