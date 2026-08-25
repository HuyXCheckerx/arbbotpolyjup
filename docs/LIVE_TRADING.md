# BTC short-window live trader

The production live command is the Rust `jupol-scanner` binary. It can submit
real Polymarket and Jupiter orders. Monitor mode, tests and the dashboard never
submit orders.

This strategy is not guaranteed arbitrage. Polygon and Solana cannot be atomic,
and Polymarket's 60-second Chainlink TWAP observation can disagree with
Jupiter Forecast's Chainlink spot observation.

## Entry pipeline

For current BTC 5-minute and 15-minute rounds, and optionally verified daily
Bitcoin-above-strike mirrors, the trader:

1. verifies exact market identity, interval and outcome mapping;
2. evaluates both `Poly UP + Jup DOWN` and `Poly DOWN + Jup UP`;
3. screens through the public Jupiter Degen price WebSocket and Polymarket CLOB
   WebSocket without spending Jupiter's authenticated request budget;
4. requires fresh data, at least 30 seconds to close, real wallet capacity,
   conservative depth after a 20% default haircut, fees, and both profit floors;
5. requests a new exact Jupiter build through the 10 RPS Developer main-bucket
   scheduler, then re-reads Polymarket depth;
6. prepares a protected exact-share Polymarket FOK and signs the Jupiter
   transaction before either is released;
7. persists the complete entry intent, then submits both venue operations
   concurrently;
8. reads back conditional tokens, Polymarket collateral, Jupiter USDC, the
   Prediction position and/or Solana token deltas before it books fill quantity
   or cost.

Jupiter Prediction `/orders` then `/execute` is used for native Forecast orders
of at least `$5` and for standard `POLY-*` markets. Native Forecast orders below
`$5` can use Swap V2 down to the configured `$0.10` strategy floor when an
outcome mint and viable route exist. Swap uses Jupiter-managed RTSE rather than
a manually forced zero-slippage value. Swap sizing and the paired Polymarket
quantity use `otherAmountThreshold`, Jupiter's guaranteed minimum output, rather
than the optimistic quoted `outAmount`.

The executable Jupiter build must fit inside a 500 ms build-to-handoff ceiling.
Prediction handoff retains priority in the shared main bucket. Authenticated Swap
V2 `/execute` uses Jupiter's separate paid-plan execution bucket and therefore
does not wait behind `/order` builds. Network time used to obtain the build is
not counted as its local age. An old build is discarded, never sent stale.

## Why concurrent execution

Sequential Polymarket-first entry avoids a Jupiter-only fill but increases the
delay before Jupiter handoff. Jupiter-first does the reverse. Concurrent release
reduces average skew without pretending the venues are atomic. It creates four
execution states that must all be handled:

| Observed execution | Action |
| --- | --- |
| Neither filled and both terminal | Remove the intent as zero exposure |
| Both filled and quantities/costs are known | Hold if matched; otherwise evaluate bounded repair |
| Only one filled, quantities/costs known | Attempt only a bounded Polymarket repair; otherwise isolate for recovery/settlement |
| Any identity, quantity, debit or submission remains unknown | Preserve durable recovery state; never guess or report profit |

A known problem is position-local. After observation/repair, the bot recomputes
the actual single-winner floor and contract mismatch. A negative floor, mismatch
over 0.01 contracts, one-sided exposure, or unresolved recovery quarantines all
new entries while existing settlement and recovery continue. The startup
recovery command re-reads both venues before acting.

## Four resolution outcomes

Let `P` be confirmed Polymarket contracts, `J` confirmed Jupiter contracts, and
`C` the actual combined entry debit.

| Resolution | Payout | P&L |
| --- | ---: | ---: |
| Polymarket wins, Jupiter loses | `P` | `P - C` |
| Polymarket loses, Jupiter wins | `J` | `J - C` |
| Both win | `P + J` | `P + J - C` |
| Both lose | `0` | `-C` |

The entry edge checks the two intended single-winner cases. The both-win and
both-lose cases remain possible because the resolution observations differ.

## Balance and P&L accounting

The bot does not infer a fill from quoted output. Around every live entry it
captures:

- Polymarket conditional-token and collateral balances;
- Jupiter outcome-token/Prediction-position and USDC balances;
- the confirmed Solana transaction's owned token deltas for native Forecast;
- venue order/transaction identities and actual responses.

Actual wallet debits take precedence over quotes. Swap V2's confirmed
`totalInputAmount`/`totalOutputAmount` are authoritative and avoid a redundant
RPC confirmation pass; Prediction keeper orders are reconciled through
`/orders/status/{pubkey}` plus owner order history because a filled order account
can be closed. If tokens appear but their cash debit cannot be reconciled, the
position enters recovery and its cost is not silently treated as zero. Realized
P&L is posted only after both venues are settled and Jupiter rent reclaim is
complete. The complete finalized record is retained in `settled_positions`.
Outcome tokens temporarily reduce displayed free cash; the position ledger must
be considered with wallet cash.

## Recovery and repair

`pnpm recover:live` is an explicit, state-changing command. It re-observes every
incomplete position. A Polymarket top-up or trim may be submitted only when:

- both venue identities and quantities are known;
- the exact 0.01-contract step is valid;
- a fresh bid/ask exists;
- configured slippage is respected; and
- modeled loss is below `--maximum-repair-loss-usd` (default `$1`).

The loss bound is checked before signing/submission. Unknown or over-budget
repairs remain durable manual-reconciliation work. Never delete a state file to
clear a halt; doing so does not close exposure.

While live mode is running, the same recovery pass repeats every 15 seconds.
Definitive FOK/HTTP client rejections are separated from ambiguous transport
failures. A pending Jupiter keeper order blocks repair, and an ambiguous Swap V2
handoff gets a 90-second latent-fill window before any zero-balance repair is
considered. Zero exposure requires two separated observations; contracts with
unknown actual cash debit are never repaired or settled as though their cost
were zero.

## Settlement

The live process checks expired positions every 15 seconds:

- winning Polymarket positions are redeemed through the configured gasless
  relayer, with the confirmed transaction and pre-redemption collateral
  snapshot persisted before the process accepts the actual wallet credit;
- standard Jupiter Prediction winners use the claim transaction and are
  reconciled from the confirmed owned-USDC credit, not the quoted payout;
- native Forecast settlement is likewise verified from the wallet's USDC
  credit;
- empty Token-2022 outcome accounts are closed and their rent SOL is reclaimed;
- verified realized P&L is finalized only after both venue payouts and rent are
  complete. A confirmed transaction whose credit is still unavailable remains
  pending and is re-observed without resubmitting redemption.

`pnpm redeem:polymarket` manually retries Polymarket redemption. It sends a real
relayer transaction.

Legacy Proxy-wallet redemption uses a four-call relayer batch so the current
relayer SDK supplies its maximum 400k rather than its insufficient 200k
single-call gas limit. The three padding calls are zero-value/no-data calls to
the signer; they do not transfer funds. Before submission, the bot requires the
wallet's current conditional-token balance to match durable state within 0.01
contracts, preventing stale repaired/unwound positions from producing
zero-value redemption transactions. `poly1271` and Safe execution are unchanged.

## Required configuration

- Rust 1.90 or newer;
- Jupiter Developer API key with Prediction and Swap product access;
- dedicated Solana wallet with USDC and SOL;
- reliable low-latency Solana RPC;
- dedicated Polymarket wallet with correct signature type and CLOB approvals;
- Polymarket relayer key for gasless approvals/redemption;
- `LIVE_TRADING_CONFIRMATION=I_ACCEPT_REAL_MONEY_RISK`.

The Jupiter key's 10 RPS main allowance is enforced by a single 100 ms scheduler
for Prediction and Swap `/order`; Swap `/execute` uses Jupiter's distinct
paid-plan execution bucket. A `401 Unauthorized` means product access/key
configuration is wrong; retrying cannot repair it.

See [HOW_TO_RUN.md](../HOW_TO_RUN.md) for commands, flags, setup and
troubleshooting.
