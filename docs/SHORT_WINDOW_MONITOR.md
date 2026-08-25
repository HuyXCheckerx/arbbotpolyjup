# BTC Polymarket / Jupiter short-window monitor

The Rust monitor compares Polymarket BTC Up/Down with native Jupiter Forecast
for the current 5-minute interval only. The 15-minute and daily loops are
disabled.

It is read-only:

```bash
pnpm monitor:short-window
```

Stop after one synchronized executable sample:

```bash
pnpm monitor:short-window --once
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

## Data and executable checks

- Polymarket short-window depth is event-driven through its market WebSocket.
  REST refresh runs only when the book is absent/stale, every five seconds by
  default.
- Jupiter's public price WebSocket and indicative REST prices are not used.
- Wallet-specific Swap V2 `/order` builds are continuously pipelined for UP and
  DOWN and are themselves the Jupiter price source.
- Swap V2 builds must explicitly be `ExactIn`, with a positive
  `otherAmountThreshold` no larger than quoted `outAmount`. Confirmed execution
  amounts are authoritative and any profitable extra output is retained.
- The two outcomes alternate every 125 ms globally by default (8 RPS), leaving
  headroom in the Developer 10-RPS main bucket. Authenticated Swap `/execute`
  uses Jupiter's separate paid-plan execution bucket.
- Out-of-order responses are discarded. A selected response must reach handoff
  within 250 ms of local receipt by default.
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

Records include `session_start`, `candidate`, `execution_error`, live entry
results, and `session_stop`. Repetitive unchanged
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
`--max-jupiter-age-ms`, `--jupiter-order-input-usd`,
`--jupiter-order-request-interval-ms`, `--max-samples`, `--once`, `--no-web`,
`--output`, and `--web-port`. Risk/sizing flags are also accepted so read-only
screening matches live eligibility.

The Jupiter key is required for Prediction market discovery and must have
Prediction product access. A Developer plan's 10 RPS allowance does not itself
grant that access; `401 Unauthorized` is terminal and reported directly.

See [HOW_TO_RUN.md](../HOW_TO_RUN.md) for all current flags and
[LIVE_TRADING.md](LIVE_TRADING.md) before enabling real orders.
