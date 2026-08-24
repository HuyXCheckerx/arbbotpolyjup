# BTC short-window live trader

The live command can submit real orders on native Jupiter Forecast and Polymarket. It is deliberately gated and remains a cross-venue basis strategy, not guaranteed arbitrage: Polymarket resolves from a 60-second Chainlink TWAP while Jupiter Forecast resolves from Chainlink spot, and Polygon/Solana execution cannot be atomic.

No live order is submitted by installation, tests, dashboard startup, or monitor mode. The bot command is live-only.

## Strategy in plain language

For each current BTC 5-minute and 15-minute round, the process:

1. Pairs only equal-duration markets with identical start and end times.
2. Requires exact opening references to differ by strictly less than `$30`.
3. Selects the complementary route implied by the two opening references.
4. Discovers entries from Jupiter's public Degen top-price WebSocket with synthetic screening depth capped by the per-position Jupiter allocation, then requests one exact executable build only after a candidate reaches preflight. The strategy selects the largest screened size that fits both venue budgets and preserves at least `$0.01` per contract and `$0.10` total after modeled fees. Live entry reserves the configured 5% post-fill normalization allowance plus the configured slippage allowance beneath the hard venue cap, so a price-improved Polymarket fill can still be fully hedged. The exact build must preserve the same profit limits after price impact and slippage protection.
5. Uses Jupiter Prediction `/orders` → `/execute` for native Forecast deposits of at least `$5`, matching the recommended website-style path. Smaller native Forecast legs use direct outcome-token Swap V2 because Prediction enforces a `$5` build minimum. Standard `POLY-*` prediction markets always use Prediction.
6. Limits each leg of each position to `$50`, including modeled/quoted entry fees, and permits at most five concurrent unsettled positions. Real wallet balances can impose a lower practical limit.
7. Verifies Polymarket balances and approvals before exposing the Jupiter leg. The same read supplies the pre-entry token-balance snapshot, avoiding a redundant API round trip.
8. Validates and signs the exact Jupiter build while reading the Polymarket balance and signing a protected Polymarket market FOK. The bot rejects a rounded market BUY below `$1` and signed maker/taker amounts outside Polymarket's 2/4-decimal limits. No venue submission happens during this preparation phase.
9. Submits Polymarket first. A zero FOK fill explicitly skips Jupiter. After a Polymarket fill, the bot immediately executes the already-signed Jupiter build when it is no more than one second old and within the bounded size mismatch; otherwise it requotes and resizes from the observed fill.
10. Once Polymarket has filled, the normal entry-profit threshold no longer applies. The second leg is exposure management: a Jupiter hedge is submitted whenever its conservative loss is within `--maximum-emergency-hedge-loss-usd` (default `$1`). Larger projected losses trigger the supported Polymarket unwind path instead of an unbounded hedge.
11. Reconciles both venue results independently and normalizes small observed size differences by selling the excess. Rejected, pending, ambiguous, or unrecoverable exposure halts all new trading and remains durably recorded.
12. Holds a balanced position through market resolution. Automatic profit-taking exits are disabled; the post-resolution loop still claims or redeems winning legs and records settlement.

Gas and ordinary network fees are not included in strategy P&L, as requested. They still reduce actual wallet balances.

## Hard safety behavior

- `--live-trade` alone is insufficient. The exact confirmation phrase `I_ACCEPT_REAL_MONEY_RISK` is also required.
- Paper execution has been removed from the bot command; use monitor mode for a read-only run.
- Only native Forecast outcome mints from `bisonfi` markets are accepted for Jupiter Swap V2 execution.
- Polymarket entry orders are FOK. Native market BUY entry fixes a cent-denominated collateral spend with a protected maximum price; actual share quantity is reconciled against Jupiter after both fills. A rejected FOK does not rest on the book.
- Entry is Polymarket-first; Jupiter is pre-signed and submitted only after a positive observed Polymarket fill. Submission timing is written to the JSONL/state record.
- No one-sided buy top-up or excess sell is placed after a fully observed two-sided size mismatch. Both recorded venue balances are retained through resolution; the unmatched remainder remains directional exposure.
- A stale or unavailable Jupiter atomic executable quote cannot trigger an entry. Generic Jupiter orderbook asks never arm live entry, and balanced open positions do not consume REST requests for exit screening.
- New entries stop in the final 30 seconds of both 5m and 15m rounds.
- State is atomically persisted with file mode `0600` before and after execution phases.
- An ambiguous submission, unmatched second leg, or mismatched exit halts all new entries. A fully observed two-sided entry-size mismatch does not halt: it remains open and is held through resolution because both balances are known exactly.
- A terminal entry rejection automatically clears without a recovery trade only after both market-token balances are read back as zero. Structured terminal rejections can recover immediately; a persisted Jupiter terminal failure is retried read-only after the round closes and on later wallet refreshes. A zero-exposure attempt may retry the still-open pair after its short cooldown. Unknown, pending, nonzero, or identity-mismatched exposure remains halted.
- New fully observed two-sided size mismatches remain open and advance normally to settlement after market close. Legacy positions previously halted for that condition still advance to quarantined settlement and release the global halt. Known terminal one-sided fills receive the same treatment. Unknown or pending fills remain halted.
- Entry-preflight failures write a dedicated `live_entry_preflight_failed` record with the failing stage, stable code, retry class, cooldown duration, quote reuse/age, execution path, endpoint, request ID, router/mode, per-stage latency, and nested error metadata. Backoff is per pair: 250ms for changed market conditions, 750ms for transient failures, and 2500ms for likely configuration problems. Execution diagnostics distinguish `skipped` from `rejected` and record whether Jupiter was signed/submitted, which path was used, quote age at submission, transaction signature, fills, and nested venue errors.
- The setup command submits only Polymarket approval transactions and exits; it cannot continue into market trading.

Sequential entry is not cross-chain atomicity. Polymarket can fill before Jupiter moves or rejects; the emergency loss budget and automatic unwind reduce that risk but cannot remove it. Unknown exposure remains halted unless a supported reconciliation or settlement path proves the balances.

## Prerequisites

- Node.js 24 or newer and pnpm.
- A Jupiter API key.
- A dedicated Solana wallet with at least `$50` USDC and at least `0.001 SOL`.
- A dedicated Polymarket wallet/funder with at least `$50` USDC.
- A Polymarket Relayer API Key for gasless approvals and resolution redemption.
- A reliable Solana RPC endpoint.
- Polygon gas/funding required by the selected Polymarket wallet type and approvals.

Use dedicated low-balance wallets. Do not use a main wallet or seed phrase. `POLYMARKET_PRIVATE_KEY` must be a `0x`-prefixed 32-byte key. `JUPITER_SOLANA_PRIVATE_KEY` accepts either a base58 secret key or the wallet's JSON byte array.

`POLYMARKET_WALLET_ADDRESS` is the Polymarket account/funder address controlled by the signer. It may differ from the signer address for a Polymarket deposit wallet or proxy wallet.

## Install and verify without trading

```bash
cd /Users/perycent/Downloads/Jupol
pnpm install
pnpm check
pnpm monitor:short-window
```

The monitor never signs or submits. Let it run across several boundaries before configuring live execution.

## Configure credentials

```bash
cd /Users/perycent/Downloads/Jupol
cp -n .env.example .env
chmod 600 .env
```

Edit `.env` and set:

```text
JUPITER_API_KEY=your_jupiter_api_key
JUPITER_SOLANA_PRIVATE_KEY=your_dedicated_solana_secret
SOLANA_RPC_URL=https://your-solana-rpc.example
POLYMARKET_PRIVATE_KEY=0xyour_dedicated_polygon_signer_key
POLYMARKET_WALLET_ADDRESS=0xyour_polymarket_funder_address
POLYMARKET_RELAYER_API_KEY=your_relayer_api_key
POLYMARKET_RELAYER_API_KEY_ADDRESS=0xthe_key_owner_address_shown_by_polymarket
LIVE_TRADING_CONFIRMATION=I_ACCEPT_REAL_MONEY_RISK
```

The repository ignores `.env` and `.env.*` except `.env.example`. Confirm that no real secret appears in Git, terminal history, screenshots, logs, or support messages.

Load the file into the current zsh session:

```bash
set -a
source .env
set +a
```

The program reads environment variables; it does not automatically load `.env`.

Create the Relayer API Key in Polymarket **Settings > API Keys**. Copy both the key and its displayed
owner address. The owner address is not necessarily `POLYMARKET_WALLET_ADDRESS`; do not substitute one
for the other. The Relayer API Key authorizes gasless wallet operations, while the private key still
signs orders and wallet calls.

## Read-only Polymarket preflight

Before submitting approvals, check the configured wallet's collateral and current allowances:

```bash
pnpm check:polymarket:live
```

This authenticates and reads account state but does not submit a transaction or order. If it passes,
the required approvals already exist. You may still need the Relayer API Key later to redeem a winning
position after resolution.

## One-time Polymarket approvals

Run the setup-only command:

```bash
pnpm setup:polymarket:live
```

This may submit approval/deployment transactions. It prints a completion message and exits without starting the scanner or placing market orders. If approval checks later fail, run it again and verify the wallet/funder pairing.

## Start real trading

First, run the combined read-only preflight:

```bash
pnpm check:live:readiness
```

It verifies the `$50` minimum balance at each venue, Polymarket allowances, Jupiter's trading status,
and the Jupiter SOL fee/rent reserve. It exits without submitting transactions or orders.

First terminal:

```bash
cd /Users/perycent/Downloads/Jupol
pnpm bot:short-window:live
```

The live/readiness package commands load `.env` directly with Node. Do not run `source .env`.

Second terminal:

```bash
cd /Users/perycent/Downloads/Jupol
pnpm dashboard:dev
```

Open `http://localhost:3000`. Live mode is labeled `LIVE REAL-MONEY TRADER`; the dashboard is not an order-entry surface and exposes no private keys.

The live dashboard shows the actual Polymarket collateral and Jupiter USDC balances, refreshed every five seconds. The live trader uses those same successful wallet reads as its available-cash source; it does not seed a simulated `$50` bankroll. Per-position spending is still capped by `--max-venue-allocation-usd`.

Each successful wallet refresh is also appended as a `live_wallet_balance` JSONL record. A temporary
refresh failure keeps the last successful values visible and writes a change-only
`live_wallet_balance_error` record. Acquired outcome positions are not included in the wallet collateral
number, so use the position count and strategy ledger alongside it.

The default files are:

```text
logs/btc-poly-jup-short-window-arb.jsonl
logs/btc-poly-jup-short-window-live-state.json
```

The JSONL contains public market/order/transaction identifiers but no wallet secret. The state file contains exposure and public order identifiers, not keys. Protect both anyway.

## Defaults and overrides

| Setting | Default |
| --- | ---: |
| Minimum real wallet balance per venue at startup | `$50` |
| Maximum allocation per venue per position | `$50` |
| Maximum concurrent unsettled positions | `5` |
| Jupiter strategy floor | `$0.01` |
| Jupiter websocket entry-screening gross cap | Follows the `$50` maximum venue allocation unless overridden |
| Minimum entry edge per contract | `$0.01` |
| Minimum total entry edge | `$0.10` |
| Exit policy | Hold through resolution; no automatic profit-taking |
| Entry cutoff before market close | `30 seconds` |
| Maximum live slippage per leg | `100 bps` |
| Maximum signed Jupiter quote age at submission | `1 second` |
| Maximum emergency hedge loss after first-leg fill | `$1` |
| Jupiter execution wait | `20 seconds` |
| Opening-reference difference | strictly `< $30` |

Example with tighter risk limits:

```bash
pnpm bot:short-window:live -- \
  --minimum-venue-balance-usd=50 \
  --max-venue-allocation-usd=20 \
  --maximum-open-positions=1 \
  --maximum-slippage-bps=50 \
  --maximum-jupiter-submit-quote-age-ms=750 \
  --maximum-emergency-hedge-loss-usd=0.50 \
  --minimum-entry-profit-usd=0.25
```

`--minimum-venue-balance-usd` is a startup readiness requirement, not fake or credited cash. All sizing uses balances read from the two real wallets. With the default 5% normalization allowance and 1% slippage setting, the largest entry can consume up to `hard venue capacity / 1.06`; the remaining capacity is reserved only for post-fill hedge normalization.

## Stop and recovery

Press `Ctrl-C` once. The signal stops discovery and feeds; an execution already in progress is allowed to reconcile and persist before the process ends.

If the dashboard or terminal says `LIVE TRADER HALTED`:

1. Do not restart repeatedly.
2. Inspect both venues using the public order, position, token, and transaction IDs in the JSONL/state file.
3. If the halt records a terminal Jupiter entry failure and zero recorded exposure, keep the same state file available. The bot will re-read both outcome-token balances after close and automatically clear the halt only when both are zero; a `live_recovery` record explains the proof used.
4. If Polymarket filled but the Jupiter hedge exceeded the emergency loss budget or failed terminally, the bot first attempts its protected Polymarket unwind. A successful unwind clears the position and writes `live_recovery`; an unsuccessful unwind remains halted with the exact observed balance.
5. If the halt is a fully observed entry size mismatch or known terminal one-sided fill, the bot waits until market close, quarantines the position for settlement, and re-enables new entries when no ambiguous exposure remains. Redemption and claim retries continue in the background.
6. If either venue fill remains unknown or is one-sided for any other reason, determine the exact quantity and manually neutralize it if necessary; automatic recovery and redemption will not guess.
7. Preserve the halted state file as the audit record.
8. After all exposure is accounted for, start with a new explicit state path, for example `--live-state=logs/live-state-after-manual-recovery.json`.

Never delete or replace the halted state before checking both venues. A fresh state file tells the software there is no managed exposure; it does not close anything on-chain.

## What is deliberately not promised

- The route is not guaranteed to pay `$1` because the venues use different closing observations.
- FOK on Polymarket cannot make a Polygon/Solana pair atomic.
- Displayed depth can disappear between observation and execution.
- API, RPC, router, chain, or wallet failures can leave manual recovery work.
- The strategy's fee/accounting model cannot include every venue-side rebate, rounding adjustment, network fee, or wallet implementation detail.
- Tests use mocks and never prove that a future venue API change is safe. The live adapter refuses unknown Jupiter execution models and malformed responses instead of guessing.

Review current venue documentation before funding and after dependency/API upgrades.
