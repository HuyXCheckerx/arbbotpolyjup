# How to run the Jupol arbitrage bot

Run every command from:

```bash
cd /Users/perycent/Downloads/Jupol
```

## Choose a mode

| Goal | Command | Can place real orders? |
| --- | --- | --- |
| Safest first run: reference-directed monitor | `pnpm monitor:short-window` | No |
| Monitor both complementary routes | `pnpm monitor:short-window:any-route` | No |
| Reference-directed live bot | `pnpm bot:short-window:live` | Yes |
| Live bot that takes whichever complementary route qualifies | `pnpm bot:short-window:any-route` | Yes |
| Check both live wallets and venue readiness | `pnpm check:live:readiness` | No orders or transactions |
| Check only Polymarket readiness | `pnpm check:polymarket:live` | No orders or transactions |
| Create missing Polymarket approvals | `pnpm setup:polymarket:live` | May submit approval transactions, never market orders |

`pnpm bot:short-window` is an alias of `pnpm bot:short-window:live`.

The reference-directed version chooses the complementary route implied by the two venues' opening references. The any-route version evaluates both `Poly UP + Jup DOWN` and `Poly DOWN + Jup UP`, then takes the best route that passes every fee, size, freshness, and live-risk check. Any-route mode has greater basis risk: both purchased outcomes can lose if the venues settle inside their opening-reference gap.

All short-window commands monitor BTC 5-minute and 15-minute pairs. Daily “Bitcoin above ___ on date?” markets are also enabled by default. Add `--no-daily-threshold` if you want only the 5-minute and 15-minute strategy.

## Install and verify

Requirements:

- Node.js 24 or newer;
- pnpm;
- internet access to Polymarket, Jupiter, Solana RPC, and the public price streams.

Install dependencies and run all checks:

```bash
pnpm install
pnpm check
```

`pnpm check` does not place orders. Run it after changing code or updating dependencies.

## Read-only runs

Start with the normal reference-directed monitor:

```bash
pnpm monitor:short-window
```

Monitor both complementary routes without trading:

```bash
pnpm monitor:short-window:any-route
```

Monitor only the short-window markets, excluding daily strike markets:

```bash
pnpm monitor:short-window -- --no-daily-threshold
```

Useful bounded runs:

```bash
# Stop after the first synchronized sample.
pnpm monitor:short-window -- --once

# Stop after 100 synchronized samples.
pnpm monitor:short-window -- --max-samples=100

# Stop after the first recorded fee-adjusted candidate.
pnpm monitor:short-window -- --max-opportunities=1
```

Choose a separate output file or status port:

```bash
pnpm monitor:short-window -- \
  --output=logs/my-read-only-run.jsonl \
  --web-port=3211
```

Read-only mode may use `--no-web`. Live mode may not, because its status port is also the single-instance safety lock.

## Configure live credentials

Use dedicated, low-balance wallets. Do not use a main wallet or seed phrase.

Create the local environment file:

```bash
cp -n .env.example .env
chmod 600 .env
```

Set these values in `.env`:

```text
JUPITER_API_KEY=your_jupiter_api_key
JUPITER_SOLANA_PRIVATE_KEY=your_dedicated_solana_secret
SOLANA_RPC_URL=https://your-solana-rpc.example

POLYMARKET_PRIVATE_KEY=0xyour_dedicated_polygon_signer_key
POLYMARKET_WALLET_ADDRESS=0xyour_polymarket_funder_address
POLYMARKET_RELAYER_API_KEY=your_polymarket_relayer_key
POLYMARKET_RELAYER_API_KEY_ADDRESS=0xthe_relayer_key_owner_address

LIVE_TRADING_CONFIRMATION=I_ACCEPT_REAL_MONEY_RISK
```

Important details:

- `POLYMARKET_PRIVATE_KEY` must be a `0x`-prefixed 32-byte key.
- `JUPITER_SOLANA_PRIVATE_KEY` accepts a base58 secret key or a JSON byte array.
- `POLYMARKET_WALLET_ADDRESS` is the funded Polymarket account controlled by the signer. It can differ from the signer address.
- `POLYMARKET_RELAYER_API_KEY_ADDRESS` is the owner address shown beside the key in Polymarket settings. Do not assume it equals the wallet address.
- Never commit, paste, screenshot, or include `.env` in logs or support messages.
- The packaged live and readiness commands load `.env` automatically. You do not need to run `source .env`.

Suggested minimum funding for the default settings:

- Jupiter wallet: at least `$50` USDC and `0.001 SOL`;
- Polymarket wallet: at least `$50` collateral plus any gas required by its wallet type.

## Prepare and verify live trading

First check Polymarket without submitting anything:

```bash
pnpm check:polymarket:live
```

If approvals are missing, run the setup-only command:

```bash
pnpm setup:polymarket:live
```

This command may submit approval or wallet-deployment transactions. It exits after setup and cannot continue into market trading.

Then run the complete read-only live readiness check:

```bash
pnpm check:live:readiness
```

Do not start live trading until this passes with the wallet addresses and balances you expect.

## Start the live bot

Reference-directed live strategy:

```bash
pnpm bot:short-window:live
```

Take whichever complementary route currently offers the best qualified edge:

```bash
pnpm bot:short-window:any-route
```

Only 5-minute and 15-minute markets, with daily strike markets disabled:

```bash
pnpm bot:short-window:live -- --no-daily-threshold
```

Do not run the two live variants simultaneously. They share the default durable state and port `3210`; the port lock intentionally prevents a second live executor.

Live trading remains non-atomic across Polygon and Solana. A detected candidate is not guaranteed profit because Polymarket settles from a 60-second Chainlink TWAP while Jupiter Forecast settles from Chainlink spot.

For native Jupiter Forecast markets, live execution is hybrid:

- Jupiter Prediction `/orders` → `/execute` is used when the Jupiter deposit is at least `$5`, matching Jupiter's recommended website-style path;
- direct outcome-token Swap V2 is used below `$5`, because Prediction rejects smaller builds;
- Prediction `/execute` amounts are never treated as fills: the bot confirms the transaction and measures the wallet's real outcome-token credit and USDC debit;
- after both legs execute, the bot predicts Polymarket-only win, Jupiter-only win, both-win, and both-lose P&L from confirmed fills. Because the venues use different resolution observations, the last two cases are real basis outcomes. A known but imperfect fill is isolated as `recovery_planning` while unrelated pairs remain enabled; an unknown fill still halts globally;
- Forecast winners are credited from the confirmed settlement USDC delta, and empty Token-2022 outcome accounts are closed automatically to reclaim SOL rent;
- live mode continuously rolls unsigned executable builds through a shared `125ms` scheduler (`8 RPS`), leaving headroom below the Developer plan's `10 RPS` limit; critical entry/recovery work jumps ahead of discovery;
- out-of-order responses cannot replace a newer build, and the selected exact build is signed during Polymarket preparation only while it remains within the configured submission-age limit.

## Customize risk and entry requirements

Example with smaller allocation and stricter entry requirements:

```bash
pnpm bot:short-window:live -- \
  --minimum-venue-balance-usd=50 \
  --max-venue-allocation-usd=20 \
  --maximum-open-positions=1 \
  --maximum-slippage-bps=50 \
  --maximum-jupiter-submit-quote-age-ms=750 \
  --maximum-emergency-hedge-loss-usd=0.50 \
  --minimum-entry-edge-usd=0.02 \
  --minimum-entry-profit-usd=0.25
```

Example using any-route mode, no daily markets, and a separate log:

```bash
pnpm bot:short-window:any-route -- \
  --no-daily-threshold \
  --max-venue-allocation-usd=20 \
  --maximum-open-positions=1 \
  --output=logs/live-any-route-short-window-only.jsonl
```

Common controls:

| Option | Default | Effect |
| --- | ---: | --- |
| `--max-venue-allocation-usd=50` | `$50` | Maximum cost at each venue for one position |
| `--maximum-open-positions=5` | `5` | Portfolio-wide unsettled-position limit; wallet balances can impose a lower practical limit |
| `--minimum-entry-edge-usd=0.001` | `$0.001` | Minimum modeled edge per contract after entry fees |
| `--minimum-entry-profit-usd=0.10` | `$0.10` | Minimum modeled total entry profit |
| Exit policy | hold until resolution | Automatic profit-taking exits are disabled; recovery hedges and settlement remain enabled |
| `--maximum-slippage-bps=100` | `100 bps` | Maximum live price protection per leg; allowed range is 1–500 bps |
| `--maximum-jupiter-submit-quote-age-ms=500` | `0.5 seconds` | Requotes instead of submitting an older signed Jupiter build after Polymarket fills |
| `--maximum-emergency-hedge-loss-usd=1` | `$1` | Base post-fill hedge-loss budget; after Polymarket fills, it may expand to that leg's already-at-risk entry cost. It does not relax pre-entry profit checks or hard allocation limits |
| `--jupiter-quote-usd=MAX_ALLOCATION` | per-position allocation | Maximum rolling executable-quote gross; exact sizing adapts below this cap |
| `--jupiter-fill-timeout-ms=20000` | `20 seconds` | Jupiter fill/reconciliation timeout |
| `--market-log-interval-ms=30000` | `30 seconds` | Suppresses repetitive snapshots without slowing execution evaluation |
| `--max-polymarket-age-ms=750` | `0.75 seconds` | Rejects entry decisions based on an older Polymarket snapshot |
| `--max-jupiter-age-ms=2000` | `2 seconds` | Rejects entry decisions based on an older Jupiter snapshot |
| `--jupiter-request-interval-ms=125` | `125 ms` | Caps the shared main bucket at 8 RPS; critical builds jump ahead of rolling discovery |
| `--no-daily-threshold` | off | Disables daily Bitcoin-above-strike markets |
| `--web-port=3210` | `3210` | Local status API and live single-instance lock |
| `--output=PATH` | standard JSONL path | Selects the append-only event log |
| `--live-state=PATH` | standard state path | Selects the durable live exposure state |

New entries are always disabled during the final 30 seconds of both short-window durations. This cutoff is fixed in the strategy and is not a command-line option.

Show the complete current option list:

```bash
pnpm monitor:short-window -- --help
```

## Deliberate one-shot live test

This mode can intentionally submit one unprofitable real trade. It is not a paper test.

Add the second confirmation to `.env`:

```text
LIVE_TEST_ENTRY_CONFIRMATION=I_ACCEPT_ONE_UNPROFITABLE_TEST_TRADE
```

Then run:

```bash
pnpm bot:short-window:live -- --live-test-entry
```

All identity, balance, allocation, freshness, depth, slippage, and reconciliation checks remain active, but entry-profit minimums are bypassed for one submission attempt.

## Run the dashboard

Keep the scanner or bot in the first terminal. In a second terminal:

```bash
cd /Users/perycent/Downloads/Jupol
pnpm dashboard:dev
```

Open:

```text
http://localhost:3000
```

The scanner status endpoint is `http://127.0.0.1:3210/api/status`. If the scanner uses another port, such as `--web-port=3211`, open the dashboard with:

```text
http://localhost:3000/?scannerPort=3211
```

The dashboard is read-only and cannot place orders.

## Logs and state

Default reference-directed files:

```text
logs/btc-poly-jup-short-window-arb.jsonl
logs/btc-poly-jup-short-window-live-state.json
```

The any-route script uses:

```text
logs/btc-poly-jup-short-window-any-route.jsonl
```

It still shares the default live-state file unless you explicitly select another one.

Watch candidates:

```bash
tail -f logs/btc-poly-jup-short-window-arb.jsonl | \
  jq --unbuffered -c 'select(.type == "arb_opportunity")'
```

Watch live entries, exits, recovery plans, recovery, and halts:

```bash
tail -f logs/btc-poly-jup-short-window-arb.jsonl | \
  jq --unbuffered -c 'select(.type == "live_entry" or .type == "live_exit" or .type == "live_recovery_plan" or .type == "live_recovery" or .type == "live_halt")'
```

Every live-entry execution record distinguishes `jupiter.result: "skipped"` from an actual rejection and includes `submissionAttempted`, `signed`, `executionPath`, `endpoint`, `requestId`, `usedPreflightBuild`, `quoteAgeAtSubmissionMs`, `quotedContractsMicro`, `filledContractsMicro`, `contractShortfallMicro`, `quotedCostMicroUsd`, `executedCostMicroUsd`, `reconciliationSource`, and the transaction signature.

The first run after upgrading archives the old quote-derived realized P&L as `legacyUnverifiedRealizedProfitMicroUsd` and displays verified realized P&L from zero. Do not treat the archived figure as wallet profit. A legacy state containing an open Jupiter fill halts with `LEGACY_UNVERIFIED_JUPITER_FILL` for manual transaction reconciliation.

The JSONL and durable state contain public order, transaction, and exposure information but should still be protected.

## Stop safely

Press `Ctrl-C` once and wait for the session-end message. The live bot persists managed positions before exiting. Do not kill it during signing, submission, reconciliation, redemption, or state persistence unless there is no safer alternative.

## Restart or recover after a halt

1. Do not delete, edit, or replace the halted state file.
2. Check the actual Polymarket conditional-token balance and Jupiter outcome-token balance for the recorded markets.
3. Preserve the JSONL and state file as the exposure audit trail.
4. Restart with the same command and state file when you want the bot to attempt its supported automatic read-only reconciliation and post-resolution recovery.
5. A bounded residual can continue to normal hold/exit management. An excessive or negative single-winner residual becomes a position-level `quote_repair` plan instead of halting every pair. The dashboard shows all four terminal P&Ls and the maximum modeled loss. The bot does not yet place a top-up or trim merely because one leg is smaller: it must first obtain fresh executable quotes and prove the proposed repair improves the complete portfolio. If either venue's fill is unknown or pending, global halt remains appropriate; determine the exact exposure and neutralize it manually if necessary.
6. Use a new `--live-state` only after every old exposure is accounted for on both venues.

Example after fully completed manual recovery:

```bash
pnpm bot:short-window:live -- \
  --live-state=logs/live-state-after-manual-recovery.json
```

A new state file does not close or forget positions on-chain; it only tells the new process that it is not managing the old exposure.

## Common messages

- `ENTRY_CUTOFF_REACHED`: fewer than 30 seconds remain, so the bot correctly refuses a new position.
- `ENTRY_PREFLIGHT_COOLDOWN`: a recent exact-quote or venue preflight failed; the affected pair is waiting for its short classified retry delay.
- `POST_FILL_HEDGE_LOSS_LIMIT_EXCEEDED`: one venue already filled, but the available Jupiter hedge exceeded both `--maximum-emergency-hedge-loss-usd` and the already-at-risk Polymarket entry cost; the bot attempts the supported first-leg unwind and otherwise halts with the reconciled exposure.
- No candidates: displayed raw asks may cease to qualify after taker fees, minimum collateral, exact Swap pricing, available depth, or the configured profit floors.
- Port `3210` already occupied: another scanner/live bot may be running. Inspect it before choosing another port; never bypass the live lock to run two bots against the same state.
- Degen price WebSocket repeatedly disconnects: the client reconnects automatically. Live execution still requires a fresh authenticated rolling build; the socket is only an indicative size selector. If Jupiter has moved its public frontend service, set `JUPITER_PREDICTION_PRICE_WEBSOCKET_URL` only after verifying the replacement endpoint and payload schema.

For the detailed execution and recovery model, read [docs/LIVE_TRADING.md](docs/LIVE_TRADING.md). For market qualification, fee handling, and record formats, read [docs/SHORT_WINDOW_MONITOR.md](docs/SHORT_WINDOW_MONITOR.md).
