# BTC short-window paper strategy

> Retired design note. The runnable paper mode and simulated bankroll have been removed. `pnpm bot:short-window` now starts the explicitly gated live trader; use `pnpm monitor:short-window` for read-only observation.

This strategy consumes live Polymarket and native Jupiter Forecast books but does not sign or submit orders. It exists to measure whether the proposed execution and exit rules survive real liquidity, fee rounding, asynchronous data, and the difference between the two closing oracles.

## Classification

The trade is a cross-venue basis candidate, not a guaranteed arbitrage:

- Polymarket opens and closes against Chainlink BTC/USD TWAP 60s.
- Jupiter Forecast opens and closes against Chainlink BTC/USD spot.
- The two venues can resolve differently even when their opening references are less than `$20` apart.
- Polygon and Solana execution cannot be atomic.

Every entry, exit, and settlement record remains `guaranteed: false`.

## Starting portfolio

| Parameter | Default |
| --- | ---: |
| Polymarket cash | `$50` |
| Jupiter cash | `$50` |
| Maximum used at either venue for one entry | `$50` |
| Maximum concurrent positions | `2` |
| Jupiter minimum gross order | `$5` |
| Polymarket minimum quantity | `5` contracts |

The strategy deliberately chooses the smallest qualifying position instead of filling the entire displayed top level. This leaves most capital uncommitted and reduces oracle-basis and failed-leg exposure.

## Entry gates

All gates must pass:

1. Pair Polymarket 5m only with Jupiter 5m, or Polymarket 15m only with Jupiter 15m.
2. Require identical scheduled opening and closing timestamps.
3. Require exact opening observations from both rule-specific Chainlink feeds.
4. Require `abs(Polymarket open - Jupiter open) < $20`. Exactly `$20` is rejected.
5. Require fresh books from both venues and usable asks for the selected outcomes.
6. Stop new entries for both 5m and 15m pairs during their final 30 seconds.
7. Require at least five contracts of common top-level depth.
8. Require the Jupiter leg's gross spend to be at least `$5`.
9. Keep each venue's entry cost, including its entry taker fee, at or below `$50` and its available paper balance.
10. Require at least `$0.01` nominal edge per contract and `$0.10` total nominal edge after both entry taker fees.
11. Allow up to two portfolio positions at a time and never re-enter the same pair after an exit.

The reference ordering selects the route:

| Opening references | Candidate route |
| --- | --- |
| Polymarket lower | Buy Polymarket UP + Jupiter DOWN |
| Polymarket higher | Buy Polymarket DOWN + Jupiter UP |
| Equal | Evaluate both routes and select the better fee-adjusted book |

## Position sizing

The strategy first computes the minimum quantity needed to make the selected Jupiter leg worth `$5`. It rounds quantity up to `0.01` contract, enforces Polymarket's five-contract minimum, and then increases size only if necessary to reach the entry-profit thresholds.

It rejects the route when the `$5` Jupiter minimum would require more than `$50` on the Polymarket leg or exceed the remaining venue balance. This matters when Jupiter's selected outcome costs only a few cents and the complementary Polymarket outcome is near `$1`.

## Fees

Polymarket crypto taker fees are included on entry and early exit:

```text
contracts × 0.07 × price × (1 - price)
```

The scanner uses Polymarket's per-contract fee rounding already encoded by the market fee schedule.

Jupiter's documented prediction fee curve is also included and rounded up to the nearest cent per order. Live mode replaces the estimate with `estimatedTotalFeeUsd` returned by Jupiter's size-specific unsigned order build.

Gas, bridge, and ordinary network submission fees are not included, as requested. They should still be logged by a live executor.

## Green exit

After paper entry, every synchronized book update checks a complete two-leg liquidation:

1. Require a bid for the held outcome at both venues.
2. Require both bids to cover the entire held quantity; the strategy does not model a partial one-sided exit.
3. Calculate gross sale proceeds at executable bids.
4. Subtract Polymarket and Jupiter exit taker fees.
5. Compare net proceeds with the original entry cost including entry fees.
6. Exit only when the resulting realized profit is at least `$0.10`.

After a green exit, both venue balances are released and the pair is marked completed. The strategy can evaluate the next pair.

## Resolution fallback

If no full-size green exit exists before the scheduled close, the position becomes `awaiting_resolution`. A background reconciler polls both venue result APIs:

- winning contracts credit `$1` each at their respective venue;
- losing contracts credit `$0`;
- no claim fee is modeled;
- realized P&L is the combined payout minus the original fee-inclusive entry cost.

Because TWAP and spot can finish on different sides, both purchased outcomes can win, one can win, or both can lose.

## Relationship to live mode

This historical simulator informed the live strategy, but it is no longer runnable. The real-money adapter accepts only native Jupiter Forecast `atomic_swap` builds, prepares and validates both venue orders before execution, then releases the Jupiter and Polymarket FOK submissions concurrently. It records submission skew, independently reconciles both legs, and halts on ambiguous or mismatched exposure without a sequential catch-up order. This does not remove closing-oracle basis or cross-chain leg risk. See [Real-money live trader](LIVE_TRADING.md).

## Run

Use the read-only monitor instead:

```bash
cd /Users/perycent/Downloads/Jupol
pnpm monitor:short-window
```

Start the dashboard in another terminal:

```bash
pnpm dashboard:dev
```

Open `http://localhost:3000`. The monitor displays live market data but no simulated cash or positions.
