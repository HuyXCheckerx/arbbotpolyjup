# BTC above $72,000 on August 21 ask monitor

This is a read-only, fixed-market monitor for:

| Field | Value |
| --- | --- |
| Claim | BTC strictly above $72,000 on August 21, 2026 |
| Observation | Binance BTC/USDT one-minute candle final Close at 12:00 ET |
| Polymarket parent event | ID `862400`, slug `bitcoin-above-on-august-21-2026` |
| Jupiter parent event | `POLY-862400`, provider `polymarket` |
| Resolved $72,000 child books | Polymarket `3651166`; Jupiter `POLY-3651166` |
| Scheduled close | `2026-08-21T16:00:00Z` |

The command loads the named parent event on each venue, selects its one $72,000 child market, and then verifies the parent IDs, open status, strike, comparison, observation mode, close time, full resolution-rule hash, and both CLOB token IDs before it writes a session. It stops with an error rather than monitoring a changed, closed, ambiguous, or different contract.

The parent and child identifiers serve different purposes. `POLY-862400` is the Jupiter event/page containing the strike ladder; its orderbook endpoint uses the selected child market `POLY-3651166`. Polymarket likewise uses the event slug for the ladder and child `3651166` for the $72,000 CLOB tokens.

The two routes are shared Polymarket liquidity. The monitor records each displayed top ask and selects the lowest ask for YES and NO independently. It deliberately does not add the two sides or estimate arbitrage profit.

## 1. Requirements

- Node.js 24 or newer
- pnpm
- Internet access to the public Polymarket and Jupiter APIs
- A terminal opened in `/Users/perycent/Downloads/Jupol`

Check the installed versions:

```bash
node --version
pnpm --version
```

Install dependencies and validate the project:

```bash
cd /Users/perycent/Downloads/Jupol
pnpm install
pnpm check
```

`JUPITER_API_KEY` is optional for this monitor. Without one, the client serializes Jupiter requests to respect the observed keyless rate limit. If you have a key, copy `.env.example` to `.env` and set:

```dotenv
JUPITER_API_KEY=jup_your_key_here
```

The monitor loads `.env` automatically. It never needs a wallet private key and cannot place orders.

## 2. Verify one live sample

Start with one sample:

```bash
pnpm monitor:btc-aug21 -- --once
```

Successful output resembles:

```text
#1 2026-08-20T18:28:38.988Z Poly[Y 0.675 x 10.55 | N 0.329 x 80] Jup[Y 0.67 x 40 | N 0.331 x 45] BEST_ASK[Y J 0.67 x 40 | N P 0.329 x 80] skew=77ms warnings=SHARED_LIQUIDITY,JUPITER_SOURCE_TIMESTAMP_UNAVAILABLE
```

`BEST_ASK` chooses YES and NO independently. `P` means Polymarket and `J` means Jupiter. A `(tie)` suffix means both displayed asks were equal and the monitor selected direct Polymarket because it avoids Jupiter's asynchronous keeper route.

The default append-only log is:

```text
/Users/perycent/Downloads/Jupol/logs/btc-above-72000-2026-08-21.jsonl
```

## 3. Run continuously

```bash
pnpm monitor:btc-aug21
```

The default start-to-start interval is five seconds. Polls never overlap. Press `Ctrl-C` once to request a graceful stop; the current request finishes and the monitor appends a `session_end` record.

### Hybrid real-time mode

For real-time Polymarket top-of-book changes, run:

```bash
pnpm monitor:btc-aug21 -- --realtime
```

This mode uses:

- the public Polymarket market WebSocket for full snapshots and incremental price-level changes;
- Jupiter's prediction REST orderbook every 2.5 seconds by default, because Jupiter does not currently document a public prediction-orderbook WebSocket;
- event-driven JSONL samples whenever the Polymarket top bid/ask price or size changes, plus a sample after each Jupiter refresh.

The real-time default log is:

```text
/Users/perycent/Downloads/Jupol/logs/btc-above-72000-2026-08-21-realtime.jsonl
```

Run a bounded real-time session:

```bash
pnpm monitor:btc-aug21 -- --realtime --max-samples=100
```

With no `JUPITER_API_KEY`, `--jupiter-poll-ms` must be at least `2500`. With an API key, the monitor permits shorter intervals down to `250`, but the selected interval must still respect the limits of your Jupiter plan.

Each real-time sample has a `.transport` object:

| JSON path | Meaning |
| --- | --- |
| `.transport.trigger` | `polymarket_websocket_book`, `polymarket_websocket_price_change`, or `jupiter_rest_poll` |
| `.transport.jupiterSnapshotAgeMs` | Age of the Jupiter REST snapshot when the comparison was logged |
| `.transport.polymarket` | Always `websocket` in real-time mode |
| `.transport.jupiter` | Always `rest_poll` until Jupiter offers a documented prediction stream |

The WebSocket sends `PING` every ten seconds, reconnects with bounded exponential backoff, and rebuilds its local state from new full snapshots after reconnecting. It emits only when the top price or top quantity changes; non-top depth updates are retained without adding a log line.

For a bounded run of 120 successful samples:

```bash
pnpm monitor:btc-aug21 -- --max-samples=120
```

For a ten-second interval and a separate log:

```bash
pnpm monitor:btc-aug21 -- \
  --interval-ms=10000 \
  --max-samples=360 \
  --output=logs/btc-aug21-72000-run-02.jsonl
```

Existing logs are never truncated: records are appended. Use a new `--output` name when you want an isolated experiment. Files under `logs/*.jsonl` are ignored by Git.

## 4. Available options

```bash
pnpm monitor:btc-aug21 -- --help
```

| Option | Default | Meaning |
| --- | ---: | --- |
| `--interval-ms` | `5000` | Start-to-start polling interval; continuous minimum is 2500 ms |
| `--realtime` | off | Use Polymarket WebSocket plus Jupiter REST hybrid mode |
| `--jupiter-poll-ms` | `2500` | Jupiter REST refresh interval in real-time mode |
| `--max-samples` | `0` | Stop after this many successful samples; zero means unlimited |
| `--once` | off | Fetch one successful sample and stop |
| `--output` | `logs/btc-above-72000-2026-08-21.jsonl` | Append-only JSONL destination |
| `--metadata-refresh-samples` | `12` | Revalidate identity, rules, token IDs, and status periodically |
| `--max-consecutive-errors` | `5` | Stop after this many consecutive failures |

## 5. Log format

JSON Lines stores one complete JSON object per line. Each run normally adds:

1. `session_start`: parent event IDs/slug, resolved child market IDs, complete market metadata, rules, normalized rules, token IDs, and a unique session ID;
2. `sample`: books, timestamps, best bids/asks, sizes, ask differences, and the selected route for each outcome;
3. zero or more `sample_error` records;
4. `session_end`: totals and stop signal.

Every price is logged twice:

- `priceMicroUsd`: exact integer micro-dollars for analysis;
- `priceUsd`: readable decimal string.

Every quantity is likewise stored as exact micro-contracts and a decimal string. No floating-point arithmetic is used.

Important sample fields:

| JSON path | Meaning |
| --- | --- |
| `.books.polymarket.yesBestAsk` | Direct Polymarket executable YES top ask and size |
| `.books.polymarket.noBestAsk` | Direct Polymarket executable NO top ask and size |
| `.books.jupiter.yesBestAsk` | Jupiter YES ask derived from the highest NO bid |
| `.books.jupiter.noBestAsk` | Jupiter NO ask derived from the highest YES bid |
| `.askDifferences.yes` | Jupiter YES ask minus Polymarket YES ask |
| `.askDifferences.no` | Jupiter NO ask minus Polymarket NO ask |
| `.bestAvailable.yes` | Lowest raw YES ask and selected venue |
| `.bestAvailable.no` | Lowest raw NO ask and selected venue |
| `.bestAvailable.<side>.rawPriceTie` | Whether the two raw asks were equal |
| `.receiptSkewMs` | Difference between local receipt timestamps |
| `.warnings` | Shared-liquidity, staleness, skew, and missing-depth flags |

`BEST_ASK` compares the observable top asks only. It does not claim that the selected route has the lowest final execution cost. The public Jupiter market/orderbook response does not contain an exact fee quote. Any future execution logic must request a size-specific order quote and compare Jupiter's fee fields with Polymarket's taker fee before placing an order.

## Why the displayed volumes differ

The two interfaces share Polymarket's executable CLOB liquidity, but their displayed volume counters do not come from the same real-time delivery path:

- Polymarket Gamma exposes decimal cumulative and rolling 24-hour counters and updates them on its own indexer schedule.
- Jupiter imports provider volume into its prediction event/market records, rounds child `pricing.volume` to whole dollars, and may lag Polymarket's indexer.
- A page can display event-wide volume across all 11 strikes, a single $72,000 child market's volume, or rolling 24-hour volume. Those are different measures even when read at the same instant.
- Browser/UI caching can add another delay.

In a simultaneous check on 2026-08-20 UTC, Jupiter event `POLY-862400` reported `$692,716` cumulative and `$498,773` 24-hour volume, while Polymarket event `862400` reported `$808,401.292462` cumulative and `$539,231.545223` 24-hour volume. The child counters were also behind by different amounts, showing that this was provider-indexing lag rather than separate orderbook liquidity.

## 6. Examine a running log

Watch compact live samples in another terminal:

```bash
tail -f logs/btc-above-72000-2026-08-21.jsonl | \
  jq --unbuffered -c 'select(.type == "sample") | {
    time: .completedAt,
    polyYes: .books.polymarket.yesBestAsk.priceUsd,
    polyNo: .books.polymarket.noBestAsk.priceUsd,
    jupYes: .books.jupiter.yesBestAsk.priceUsd,
    jupNo: .books.jupiter.noBestAsk.priceUsd,
    bestYesVenue: .bestAvailable.yes.venue,
    bestYes: .bestAvailable.yes.level.priceUsd,
    bestNoVenue: .bestAvailable.no.venue,
    bestNo: .bestAvailable.no.level.priceUsd,
    skewMs: .receiptSkewMs,
    warnings
  }'
```

Find samples where the selected YES and NO venues differ:

```bash
jq -c '
  select(.type == "sample") |
  select(.bestAvailable.yes.venue != .bestAvailable.no.venue) |
  {
    time: .completedAt,
    bestYes: .bestAvailable.yes,
    bestNo: .bestAvailable.no,
    skewMs: .receiptSkewMs,
    warnings
  }
' logs/btc-above-72000-2026-08-21.jsonl
```

Count samples and errors:

```bash
jq -s '{
  samples: map(select(.type == "sample")) | length,
  errors: map(select(.type == "sample_error")) | length,
  sessions: map(select(.type == "session_start")) | length
}' logs/btc-above-72000-2026-08-21.jsonl
```

Export samples to CSV for spreadsheet analysis:

```bash
jq -r '
  select(.type == "sample") |
  [
    .completedAt,
    .books.polymarket.yesBestAsk.priceUsd,
    .books.polymarket.noBestAsk.priceUsd,
    .books.jupiter.yesBestAsk.priceUsd,
    .books.jupiter.noBestAsk.priceUsd,
    .bestAvailable.yes.venue,
    .bestAvailable.yes.level.priceUsd,
    .bestAvailable.no.venue,
    .bestAvailable.no.level.priceUsd,
    .receiptSkewMs,
    (.warnings | join(";"))
  ] | @csv
' logs/btc-above-72000-2026-08-21.jsonl > btc-aug21-72000-analysis.csv
```

## 7. Interpretation and data-quality rules

- `SHARED_LIQUIDITY` is always present because the $72,000 child of Jupiter event `POLY-862400` resolves to `POLY-3651166`, which routes to the same CLOB tokens as child `3651166` of Polymarket event `862400`.
- `JUPITER_SOURCE_TIMESTAMP_UNAVAILABLE` is expected: the current Jupiter endpoint does not expose an upstream timestamp.
- Treat `SNAPSHOT_RECEIPT_SKEW_EXCEEDED` as non-comparable timing. The default threshold is two seconds.
- Treat `POLYMARKET_SOURCE_STALE` or missing asks as unusable data.
- Even with low skew, the Jupiter order path is asynchronous and is not an atomic second leg.

## 8. Troubleshooting

### `HTTP 429`

Increase the interval:

```bash
pnpm monitor:btc-aug21 -- --interval-ms=10000
```

Alternatively provide `JUPITER_API_KEY` in `.env` according to your Jupiter plan.

### `Fixed-market validation failed`

The market is closed, its rules changed, its provider changed, or its CLOB tokens no longer match. Do not bypass this check. This fixed monitor is intentionally unusable after the named contract closes.

### `fetch failed`

Check Internet/DNS access and retry. The monitor records errors that occur after a validated session starts and stops after five consecutive failures by default.

### Log contains several sessions

That is expected because the format is append-only. Filter by `.sessionId` or start a new run with a different `--output` path.
