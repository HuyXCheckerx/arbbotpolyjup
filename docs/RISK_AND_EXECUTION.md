# Risk and execution specification

## Safety properties

The coordinator must preserve these properties even after restarts, timeouts, duplicate responses, partial fills, and RPC ambiguity:

1. Never submit a strategy order from stale or sequence-gapped market data.
2. Never increase exposure after the opportunity’s worst-case edge is below the configured threshold.
3. Prepare both legs for the same quoted quantity and submit them concurrently; never send a later one-sided catch-up order automatically.
4. Never regard a request timeout as a failed submission. Reconcile by client ID, order ID, transaction signature, balances, and fills first.
5. Never continue normal scanning while an execution is in an uncertain or unhedged state.
6. Never allow the same provider/order book to masquerade as two venues.

## Taker-only enforcement

### Polymarket

Use a protected market order with `FOK`:

- The limit price is the worst price at which the pair still meets minimum locked profit after the exact Polymarket fee curve.
- FOK avoids resting and avoids partial execution on this leg.
- A response other than immediate match is an execution failure and triggers reconciliation.
- `FAK` is reserved for emergency risk reduction, where reducing some exposure is preferable to retaining all of it.

### Jupiter

The live path accepts only native Forecast order builds whose documented execution model is `atomic_swap`. The order build returns an executable quote, not proof of the final fractional contract quantity.

Consequences:

- `executionModel=atomic_swap` is treated as filled only after transaction confirmation and reconciliation of the owner's real outcome-token and USDC balance deltas.
- A null or keeper execution model does not satisfy the strict taker-only requirement and is rejected before signing.

## Execution strategy

Cross-chain atomicity is unavailable. The baseline is a durable concurrent-submit saga with reconciliation:

```text
READY
  -> BOTH_LEGS_PREPARED_AND_VALIDATED
  -> INTENT_PERSISTED
  -> CONCURRENT_SUBMISSION_RELEASED
  -> BOTH_FILLED | ONE_FILLED | AMBIGUOUS | BOTH_UNFILLED
  -> RECONCILED
```

Failure branches lead to `ABORTING`, `UNWINDING`, `MANUAL_REVIEW`, or `HALTED`.

### Entry sequence

1. Acquire a per-market execution lock.
2. Verify reviewed rule hashes, distinct provider identity, venue status, geographic eligibility, balances, allowances, clock health, and data freshness.
3. Calculate executable depth and fees for both directions over allowed clip sizes.
4. Build the Jupiter order without submitting it. Validate its quoted `contractsMicro`, price protection, fees, signer set, automatic settlement, and `atomic_swap` execution model. Never treat the quote as an executed fill.
5. Build and sign the protected Polymarket FOK using the same quote snapshot and quantity target.
6. Sign and simulate the Jupiter transaction. No venue order has been submitted yet.
7. Persist the complete two-leg intent and prepared identities.
8. Release both submission functions through the same in-process barrier and record their submission-start timestamps.
9. Reconcile the Jupiter transaction's actual token deltas and Polymarket order/balance independently.
10. Recompute the Poly-win and Jupiter-win payoff from final quantities and costs. Mark the position open only when the residual is bounded and both cases still meet the entry floors. Otherwise quarantine it and halt new trading without pretending the quote was earned.

Concurrent release reduces systematic leg delay but does not make two chains atomic. Network scheduling, venue acceptance, and settlement can still leave one-sided or ambiguous exposure.

## Compensation and emergency behavior

If the concurrent results are not equal and final:

1. Reconcile both venues using order IDs, transaction signatures, and token/position balances.
2. Persist the exact or conservatively observed residual exposure.
3. Halt all new entries and alert the operator.
4. Do not automatically chase the missing leg; manual neutralization is required under the configured recovery policy.

A BTC perpetual is not an exact hedge for a binary contract. It may be considered only as a separately approved disaster hedge with a documented delta model; it is not part of MVP recovery.

## Risk limits

Configuration must include, at minimum:

| Limit | Purpose |
| --- | --- |
| Minimum net edge | Covers fees, chain costs, and model error |
| Required profit per clip | Prevents rounding from erasing small trades |
| Maximum clip contracts/notional | Caps one-leg loss |
| Maximum unhedged contracts | Portfolio exposure cap |
| Maximum unhedged duration | Forces compensation/halt |
| Maximum adverse hedge price | Bounds legging loss |
| Maximum open sagas | Prevents correlated execution pile-up |
| Maximum daily realized loss | Global kill switch |
| Minimum venue balance reserve | Keeps emergency actions possible |
| Maximum data age and clock drift | Rejects stale comparisons |
| No-entry window before close | Avoids close/settlement races |

Initial live limits should be no larger than Jupiter’s minimum order (currently documented as $5) plus enough size to meet Polymarket’s minimum order. Increase only from measured fill and recovery data.

## Circuit breakers

Immediately stop new entries for any of:

- provider or rule hash changes;
- shared underlying identifiers between the two legs;
- WebSocket sequence gap or snapshot mismatch;
- quote age above threshold;
- three consecutive venue/API failures;
- Solana or Polygon/RPC degradation;
- unexpected transaction instruction/program/account;
- balance or position reconciliation mismatch;
- fill status ambiguity beyond timeout;
- market closed, cancelled, paused, or geographically blocked;
- stablecoin haircut/depeg above tolerance;
- an implausibly large edge, which is more likely bad mapping or stale data.

The kill switch blocks new entries but does not block risk-reducing hedges, closes, claims, or reconciliation.

## Persistence and idempotency

Store:

- normalized contract and complete rule hashes;
- book snapshots and monotonic receive times used for each decision;
- opportunity calculation inputs and rounding decisions;
- intent/client identifier before each external action;
- unsigned/signed transaction hashes and venue order IDs;
- every observed status transition and raw response reference;
- confirmed fills, fees, chain costs, balances, and positions;
- compensation decisions and operator actions.

On restart, enter reconciliation mode before scanning. Any saga not in a terminal state is recovered from venue truth. Exactly-once submission cannot be assumed.

## Definition of “locked profit”

A trade is `HEDGED` only when the confirmed quantities are complementary and equal after venue precision/rounding. It is `LOCKED` only when:

- the contract mapping remains `EXACT`;
- both fills are final enough for the configured chain policy;
- total confirmed costs and fees are known or conservatively bounded;
- common payout minus all-in costs remains above the required profit;
- no residual quantity exceeds dust tolerance.

Anything else is mark-to-market exposure, not arbitrage profit.
