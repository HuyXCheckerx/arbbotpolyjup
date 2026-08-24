# BTC Polymarket / Jupiter Forecast short-window monitor

This read-only scanner runs two separate cross-venue comparisons:

- Polymarket BTC 5-minute Up/Down versus native Jupiter Forecast BTC 5-minute Up/Down.
- Polymarket BTC 15-minute Up/Down versus native Jupiter Forecast BTC 15-minute Up/Down.

It never pairs a 5-minute market with a 15-minute market. Every pair must have the same scheduled start and end timestamps.

## Pair qualification

For each duration, the scanner discovers:

- Polymarket slug `btc-updown-<duration>-<start epoch>`;
- Jupiter events from `provider=bisonfi`, not Jupiter's mirrored Polymarket provider;
- Jupiter's native `BISON-...-UP` and `BISON-...-DOWN` outcome markets.

It records the exact Polymarket TWAP opening reference and exact Jupiter Chainlink spot opening reference. Monitoring begins only when:

```text
abs(Polymarket reference - Jupiter reference) < $20
```

The comparison is strict: exactly `$20.00` is rejected.

The reference ordering selects the complementary route:

| Opening references | Route evaluated |
| --- | --- |
| Polymarket lower | Buy Polymarket Up + Jupiter Down |
| Polymarket higher | Buy Polymarket Down + Jupiter Up |
| Equal | Evaluate both directions |

## Important oracle-basis warning

These are not guaranteed arbitrages. The markets share the same start and end times, but their closing observations differ:

- Polymarket: Chainlink BTC/USD TWAP 60-second stream.
- Jupiter Forecast: Chainlink BTC/USD spot data stream.

The two closing values can land on opposite sides of their respective references, including a state where both purchased outcomes lose. Every qualification, sample, and opportunity record therefore includes `NOT_GUARANTEED_ORACLE_BASIS` and `guaranteed: false`.

## Books and fees

Polymarket top-of-book changes arrive over its market WebSocket. The public price WebSocket used by Jupiter's Degen UI is only an indicative route/size selector. In live mode, overlapping authenticated Prediction builds produce the discovery book and newest unsigned screening transaction for each selected outcome. The shared scheduler starts at most one main-bucket request every `125ms` (`8 RPS`), while critical entry and recovery requests jump ahead of rolling discovery. A slower response cannot overwrite a newer request sequence, and a screening build older than `100ms` cannot arm entry. Every real entry requests a separate fresh build, which must be submitted within `100ms`; one expired build may be discarded and rebuilt. Exact sizing steps down when price impact removes the edge and grows in bounded increments toward the largest conservatively profitable size. Polymarket depth receives a default 20% haircut, and the exact-share FOK maximum price is capped by the remaining profit budget. The default Jupiter strategy floor is `$5` and uses Prediction; sub-`$5` RTSE Swap V2 requires explicit opt-in. Once a position is open, balanced positions are held through resolution.

Entry-preflight backoff is isolated per round. A market-change rejection waits 250ms, a transient venue/network failure waits 750ms, and a likely configuration/readiness error waits 2500ms. A failure on the 5m pair therefore cannot suppress the 15m pair. Cooldown decisions state the affected pair, remaining time, previous stage, and stable error code.

Without `JUPITER_API_KEY`, Jupiter requests are serialized to respect the keyless rate limit; because 5m and 15m are both active, each duration may refresh less often than the configured target.

The scanner evaluates the smaller size available at the two selected top asks and includes:

- Polymarket crypto taker fee: `0.07 × price × (1-price)`, with the documented per-contract rounding.
- Jupiter generic-orderbook taker-fee estimate: `contracts × 0.07 × price × (1-price)`, rounded up to the nearest cent per order.
- Jupiter live Swap V2 quote: the effective ask is `input USDC / output outcome-token units`. The returned amounts already include Swap V2's platform fee and price impact, so the scanner does not add a second prediction-market fee.

An `arb_opportunity` record is written only when the nominal complementary payout exceeds the fee-adjusted asks and the Jupiter snapshot is fresh. In live mode that snapshot comes from a rolling authenticated executable build, and the associated unsigned transaction must still be fresh when the bot prepares both venues. The record remains a non-guaranteed candidate because of oracle basis and non-atomic cross-chain execution.

## Run

```bash
cd /Users/perycent/Downloads/Jupol
pnpm install
pnpm check
pnpm monitor:short-window
```

To run the explicitly gated real-money strategy:

```bash
pnpm bot:short-window
```

This is not a paper command. It can submit real orders after the required wallet checks and confirmation phrase. Complete [the live-trading runbook](LIVE_TRADING.md) before using it. Use `pnpm monitor:short-window` when you only want read-only market monitoring.

Press `Ctrl-C` once for a graceful stop.

The scanner also starts a local read-only status API at:

```text
http://127.0.0.1:3210/api/status
```

In a second terminal, start the dashboard:

```bash
cd /Users/perycent/Downloads/Jupol
pnpm dashboard:dev
```

Then open `http://localhost:3000`. The dashboard makes a missed startup boundary explicit, shows the next boundary countdown, and displays books and the best fee-adjusted route after qualification.

The append-only log is:

```text
/Users/perycent/Downloads/Jupol/logs/btc-poly-jup-short-window-arb.jsonl
```

Start the scanner before a new 5m/15m boundary when possible. It maintains two exact Chainlink streams:

- TWAP 60s for Polymarket's opening reference;
- spot Chainlink BTC/USD for Jupiter Forecast's opening reference.

The Polymarket and Jupiter website price-to-beat endpoints are also tried as fallbacks. The Jupiter fallback supplies the round event ID and exact opening timestamp, and the scanner rejects any response whose returned timestamp differs. If either exact reference is unavailable, the scanner skips the round instead of substituting a nearby tick.

If the scanner starts mid-round, `RTDS connected` only means new observations are flowing. The scanner now queries both venues' website price-to-beat services to backfill the exact opening references; it falls back to waiting for the next boundary only when an exact timestamp-validated response is unavailable.

The scanner also requires continuing valid observations after a WebSocket opens. If either RTDS socket remains connected but stops delivering its subscribed BTC feed for six seconds, the scanner marks it stale, closes it, and reconnects. The dashboard shows the age of the last valid TWAP and spot observations beside each feed.

## Options

```bash
pnpm monitor:short-window -- --help
```

| Option | Default | Meaning |
| --- | ---: | --- |
| `--reference-retry-ms` | `2000` | Retry interval while references are unavailable |
| `--reference-api-timeout-ms` | `2000` | Polymarket web reference timeout |
| `--sample-interval-ms` | `50` | Minimum interval between WebSocket-triggered route evaluations; execution remains responsive at this cadence |
| `--market-log-interval-ms` | `30000` | Minimum interval per duration between repetitive `book_sample` and changed `arb_opportunity` records |
| `--jupiter-poll-ms` | `200` | REST retry/poll baseline; resolution-only live positions do not request exit books |
| `--max-polymarket-age-ms` | `750` | Maximum Polymarket snapshot age for an entry decision |
| `--max-jupiter-age-ms` | `2000` | Maximum Jupiter snapshot age for an entry decision |
| `--jupiter-request-interval-ms` | `125` | Shared 8-RPS Developer-tier spacing; critical entry/recovery builds are prioritized over rolling discovery |
| `--max-consecutive-jupiter-errors` | `5` | Persistent-error warning threshold; the pair remains active with exponential backoff |
| `--max-samples` | `0` | Stop after N synchronized samples; zero is unlimited |
| `--max-opportunities` | `0` | Stop after N distinct candidate records; zero is unlimited |
| `--once` | off | Stop after the first synchronized sample across either duration |
| `--live-trade` | off | Enable explicitly confirmed real-money execution |
| `--confirm-live-trading` | none | Exact required real-money confirmation phrase |
| `--live-state` | `logs/btc-poly-jup-short-window-live-state.json` | Durable live execution/exposure state |
| `--setup-trading-approvals` | off | Submit Polymarket approvals and exit without market orders |
| `--maximum-slippage-bps` | `100` | Polymarket and recovery price protection; Jupiter Swap uses RTSE |
| `--polymarket-depth-haircut-bps` | `2000` | Ignore the final 20% of displayed Polymarket depth when sizing |
| `--jupiter-fill-timeout-ms` | `20000` | Jupiter execution reconciliation timeout |
| `--minimum-venue-balance-usd` | `50` | Minimum real wallet balance required at each venue on startup |
| `--max-venue-allocation-usd` | `50` | Maximum entry cost at each venue per position |
| `--jupiter-minimum-order-usd` | `5` | Default strategy floor matching Jupiter Prediction minimum |
| `--allow-sub-five-jupiter-swap` | off | Explicitly permit direct RTSE Swap V2 Forecast orders below `$5` |
| `--polymarket-minimum-order-usd` | `1` | Minimum collateral for a marketable Polymarket BUY; sizing scales cheap legs up to this floor |
| `--jupiter-quote-usd` | follows `--max-venue-allocation-usd` (`50`) | Maximum rolling executable-quote gross; adaptive sizing may request less |
| `--minimum-entry-edge-usd` | `0.001` | Minimum nominal entry edge per contract after entry fees |
| `--minimum-entry-profit-usd` | `0.10` | Minimum nominal total entry edge |
| `--minimum-exit-profit-usd` | `0.10` | Legacy threshold retained for compatibility; live automatic exits are disabled |
| `--maximum-open-positions` | `5` | Portfolio-wide unsettled-position cap |
| `--web-port` | `3210` | Local dashboard status API port |
| `--no-web` | off | Disable the local dashboard status API |
| `--output` | `logs/btc-poly-jup-short-window-arb.jsonl` | Append-only JSONL path |

Short-window live discovery subscribes to the same public top-price WebSocket as Jupiter's Degen UI, but that feed only retargets the rolling quote size and cannot trigger an order. The execution signal is built from authenticated unsigned Prediction transactions (or explicitly enabled sub-`$5` Swap V2 transactions). Several requests may overlap, but the shared scheduler caps their starts at 8 RPS and the per-outcome sequence cache retains only the newest response. Once a balanced position is open, automatic profit-taking is skipped and rolling entry builds pause; the settlement loop takes over after resolution.

The Degen price service is a public frontend dependency but is not part of Jupiter's documented Prediction API contract. The stream reconnects with exponential backoff after errors or 30 seconds without messages. If Jupiter moves the service before this beta stabilizes, override it with `JUPITER_PREDICTION_PRICE_WEBSOCKET_URL` while updating the integration.

## Examine the log

Watch fee-adjusted candidates:

```bash
tail -f logs/btc-poly-jup-short-window-arb.jsonl | \
  jq --unbuffered -c 'select(.type == "arb_opportunity") | {
    time: .detectedAt,
    duration,
    guaranteed,
    references,
    route,
    warnings
  }'
```

Summarize a completed log:

```bash
jq -s '{
  qualifiedPairs: map(select(.type == "pair_qualified")) | length,
  rejectedPairs: map(select(.type == "pair_rejected")) | length,
  opportunities: map(select(.type == "arb_opportunity")) | length,
  errors: map(select(.type == "pair_error")) | length
}' logs/btc-poly-jup-short-window-arb.jsonl
```

## Record types

| Type | Meaning |
| --- | --- |
| `session_start` / `session_end` | Configuration and totals |
| `pair_discovered` | Same-duration native Jupiter and Polymarket records passed identity checks |
| `pair_qualified` | Exact opening references were strictly less than the limit apart |
| `pair_rejected` | Opening references were too far apart |
| `book_sample` | Periodic synchronized top asks, sizes, fee evaluation, freshness, and basis warnings; also emitted immediately for material trading decisions |
| `arb_opportunity` | Rate-limited fee-adjusted non-guaranteed candidate update |
| `jupiter_poll_error` | Jupiter REST refresh failed |
| `pair_error` | Discovery or exact-reference data was unavailable |
| `pair_end` | Market closed, error limit was reached, or the session stopped |
| `live_entry` / `live_exit` | Confirmed real-money entry or legacy/manual-policy exit; production live mode holds balanced positions through resolution |
| `live_entry_preflight_failed` | Structured preflight stage, stable code, retry class, cooldown, per-stage timings, quote inputs/results, router/mode, and nested error details |
| `live_recovery` | Read-only balance reconciliation proved a terminal entry failure left zero exposure; no recovery trade was submitted |
| `live_recovery_plan` | Fully reconciled exposure was isolated without a global halt; includes all four terminal P&Ls and the required quote-based next action |
| `live_halt` | Execution became ambiguous; new entries stopped, with independent Jupiter/Polymarket result, fill, transaction/order, and nested-error fields |
| `live_position_awaiting_resolution` / `live_settlement` | Resolution fallback and automatic Forecast/Polymarket redemption accounting, including retained fully observed size mismatches and legacy halted mismatches |

References:

- Jupiter Forecast: <https://developers.jup.ag/docs/prediction/forecast.md>
- Jupiter Swap V2 order and execute: <https://developers.jup.ag/docs/swap/order-and-execute>
- Jupiter prediction markets and fees: <https://developers.jup.ag/docs/prediction>
- Polymarket Chainlink TWAP: <https://docs.polymarket.com/market-data/chainlink-twap>
- Polymarket market WebSocket: <https://docs.polymarket.com/api-reference/wss/market>
- Polymarket fees: <https://docs.polymarket.com/trading/fees>
