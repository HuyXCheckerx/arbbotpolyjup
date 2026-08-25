# BTC Polymarket / Jupiter short-window monitor

The Rust monitor compares Polymarket BTC Up/Down with native Jupiter Forecast
for the current 5-minute and 15-minute intervals. Daily verified
Bitcoin-above-strike mirrors are enabled by default.

It is read-only:

```bash
pnpm monitor:short-window
```

Disable daily markets or stop after one synchronized sample:

```bash
pnpm monitor:short-window --no-daily-threshold --once
```

## Qualification

For a short-window pair, both venues must have the same scheduled start and end
time and unambiguous Up/Down outcome identities. Jupiter events must be native
`bisonfi` markets, not Jupiter routing the same Polymarket liquidity.

The opening-reference difference is recorded but has no maximum gate. Both
complementary directions are evaluated on every sample, and the best qualifying
route is selected. This intentionally permits basis trades and therefore is not
guaranteed arbitrage: Polymarket observes a Chainlink 60-second TWAP while
Jupiter Forecast observes Chainlink spot.

Daily markets require an exact `POLY-*` Jupiter market ID mirrored to the same
Polymarket market ID, close time, outcomes and rules. Independently sourced
lookalikes are rejected.

## Data and executable checks

- Polymarket short-window depth is event-driven through its market WebSocket.
  REST refresh runs only when the book is absent/stale, every five seconds by
  default.
- Jupiter's public Degen WebSocket supplies indicative top prices and consumes
  no authenticated Prediction quota.
- A live candidate must request a new exact Jupiter Prediction or Swap V2 build.
  The public price cannot arm an order by itself.
- Swap V2 builds must explicitly be `ExactIn`, with a positive
  `otherAmountThreshold` no larger than quoted `outAmount`. Confirmed execution
  amounts are authoritative and any profitable extra output is retained.
- Prediction and Swap `/order` builds share one 100 ms Developer-key main-bucket
  scheduler (10 RPS), with entry/recovery priority. Authenticated Swap
  `/execute` uses Jupiter's separate paid-plan execution bucket.
- A Jupiter build must fit inside the 500 ms build-to-handoff ceiling, including
  a conservative 250 ms allowance for the critical 10 RPS slot.
- Polymarket displayed depth is reduced by 20% by default and then re-read before
  an exact-share protected FOK is prepared.
- The final 30 seconds are a mandatory no-entry window.

Both fees and actual executable prices are included. Swap V2's returned amounts
already include its platform fee/price impact and are not charged a second
prediction fee locally. Unequal final quantities do not trigger repair when both
intended single-winner P&Ls meet the post-fill floor.

## Output and dashboard

Default JSONL:

```text
logs/btc-poly-jup-short-window-rust.jsonl
```

Records include `session_start`, `candidate`, `daily_threshold_candidate`,
`execution_error`, live entry results, and `session_stop`. Repetitive unchanged
top books are not continuously logged.

The local status API is:

```text
http://127.0.0.1:3210/api/status
```

Run `pnpm dashboard:dev` in another terminal and open
`http://localhost:3000`.

## Options

The CLI help is authoritative:

```bash
pnpm monitor:short-window --help
```

Important monitor controls are `--sample-interval-ms`,
`--polymarket-poll-ms`, `--max-polymarket-age-ms`,
`--max-jupiter-age-ms`, `--max-samples`, `--once`, `--no-web`,
`--no-daily-threshold`, `--output`, and `--web-port`. Risk/sizing flags are also
accepted so read-only screening matches live eligibility.

The Jupiter key is required for Prediction market discovery and must have
Prediction product access. A Developer plan's 10 RPS allowance does not itself
grant that access; `401 Unauthorized` is terminal and reported directly.

See [HOW_TO_RUN.md](../HOW_TO_RUN.md) for all current flags and
[LIVE_TRADING.md](LIVE_TRADING.md) before enabling real orders.
