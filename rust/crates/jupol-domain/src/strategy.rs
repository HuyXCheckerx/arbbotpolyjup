use std::cmp::{max, min};

use crate::Micro;
use crate::fixed::{ONE_CONTRACT_MICRO, ONE_USD_MICRO};
use crate::short_window::{
    CrossVenueShortWindowRoute, DomainError, EvaluatedCrossVenueRoute, divide_round_nearest,
    jupiter_prediction_taker_fee_total_micro_usd,
    polymarket_crypto_taker_fee_per_contract_micro_usd,
};
use crate::types::{BinaryOrderBook, BookLevel, ShortWindowOutcome};

const CONTRACT_STEP_MICRO: Micro = 10_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ShortWindowStrategyConfig {
    pub polymarket_maximum_allocation_micro_usd: Micro,
    pub jupiter_maximum_allocation_micro_usd: Micro,
    pub jupiter_minimum_gross_order_micro_usd: Micro,
    pub polymarket_minimum_gross_order_micro_usd: Micro,
    pub polymarket_minimum_contracts_micro: Micro,
    pub minimum_entry_edge_micro_usd_per_contract: Micro,
    pub minimum_entry_edge_total_micro_usd: Micro,
    pub minimum_exit_profit_micro_usd: Micro,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VenueTradeCost {
    pub price_micro_usd: Micro,
    pub limit_price_micro_usd: Micro,
    pub levels_consumed: usize,
    pub quantity_micro: Micro,
    pub gross_micro_usd: Micro,
    pub taker_fee_micro_usd: Micro,
    pub all_in_micro_usd: Micro,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ShortWindowEntryProposal {
    pub route: CrossVenueShortWindowRoute,
    pub quantity_micro: Micro,
    pub polymarket: VenueTradeCost,
    pub jupiter: VenueTradeCost,
    pub all_in_cost_micro_usd: Micro,
    pub nominal_payout_micro_usd: Micro,
    pub nominal_edge_micro_usd: Micro,
    pub edge_micro_usd_per_contract: Micro,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntryRejection {
    NoFeeAdjustedRoute,
    InsufficientTopDepth,
    PolymarketBalanceOrAllocation,
    JupiterBalanceOrAllocation,
    PolymarketMinimumOrderUnreachable,
    JupiterMinimumOrderUnreachable,
    EntryEdgeBelowMinimum,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum EntryEvaluation {
    Eligible(ShortWindowEntryProposal),
    Rejected(EntryRejection),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ShortWindowExitProposal {
    pub quantity_micro: Micro,
    pub polymarket_bid: BookLevel,
    pub jupiter_bid: BookLevel,
    pub polymarket_gross_proceeds_micro_usd: Micro,
    pub jupiter_gross_proceeds_micro_usd: Micro,
    pub polymarket_taker_fee_micro_usd: Micro,
    pub jupiter_taker_fee_micro_usd: Micro,
    pub net_proceeds_micro_usd: Micro,
    pub realized_profit_micro_usd: Micro,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitEvaluation {
    Eligible(ShortWindowExitProposal),
    MissingExitBid,
    InsufficientExitDepth,
    ExitNotGreen { projected_profit_micro_usd: Micro },
}

pub fn evaluate_short_window_entry(
    route: Option<&EvaluatedCrossVenueRoute>,
    polymarket_available_micro_usd: Micro,
    jupiter_available_micro_usd: Micro,
    config: &ShortWindowStrategyConfig,
) -> Result<EntryEvaluation, DomainError> {
    let Some(route) = route.filter(|route| route.is_fee_adjusted_candidate) else {
        return Ok(EntryEvaluation::Rejected(
            EntryRejection::NoFeeAdjustedRoute,
        ));
    };
    let maximum_quantity = floor_to_step(route.common_depth_contracts_micro);
    if maximum_quantity < config.polymarket_minimum_contracts_micro {
        return Ok(EntryEvaluation::Rejected(
            EntryRejection::InsufficientTopDepth,
        ));
    }

    let polymarket_budget = min(
        polymarket_available_micro_usd,
        config.polymarket_maximum_allocation_micro_usd,
    );
    let jupiter_budget = min(
        jupiter_available_micro_usd,
        config.jupiter_maximum_allocation_micro_usd,
    );
    let polymarket_affordable = maximum_affordable_quantity(
        &route.polymarket_asks,
        maximum_quantity,
        polymarket_budget,
        QuoteVenue::Polymarket,
    )?;
    if polymarket_affordable < config.polymarket_minimum_contracts_micro {
        return Ok(EntryEvaluation::Rejected(
            EntryRejection::PolymarketBalanceOrAllocation,
        ));
    }
    let jupiter_affordable = maximum_affordable_quantity(
        &route.jupiter_asks,
        maximum_quantity,
        jupiter_budget,
        QuoteVenue::Jupiter,
    )?;
    if jupiter_affordable < config.polymarket_minimum_contracts_micro {
        return Ok(EntryEvaluation::Rejected(
            EntryRejection::JupiterBalanceOrAllocation,
        ));
    }

    let affordable_quantity = min(
        maximum_quantity,
        min(polymarket_affordable, jupiter_affordable),
    );
    let Some(minimum_jupiter_quantity) = minimum_quantity_for_gross(
        &route.jupiter_asks,
        affordable_quantity,
        config.jupiter_minimum_gross_order_micro_usd,
        QuoteVenue::Jupiter,
    )?
    else {
        return Ok(EntryEvaluation::Rejected(
            EntryRejection::JupiterMinimumOrderUnreachable,
        ));
    };
    let Some(minimum_polymarket_quantity) = minimum_quantity_for_gross(
        &route.polymarket_asks,
        affordable_quantity,
        config.polymarket_minimum_gross_order_micro_usd,
        QuoteVenue::Polymarket,
    )?
    else {
        return Ok(EntryEvaluation::Rejected(
            EntryRejection::PolymarketMinimumOrderUnreachable,
        ));
    };
    let minimum_quantity = max(
        config.polymarket_minimum_contracts_micro,
        max(minimum_jupiter_quantity, minimum_polymarket_quantity),
    );
    if minimum_quantity > affordable_quantity {
        return Ok(EntryEvaluation::Rejected(
            EntryRejection::JupiterMinimumOrderUnreachable,
        ));
    }

    Ok(
        match minimum_qualifying_proposal(route, minimum_quantity, affordable_quantity, config)? {
            Some(proposal) => EntryEvaluation::Eligible(proposal),
            None => EntryEvaluation::Rejected(EntryRejection::EntryEdgeBelowMinimum),
        },
    )
}

pub fn evaluate_short_window_exit(
    polymarket_book: &BinaryOrderBook,
    jupiter_book: &BinaryOrderBook,
    polymarket_outcome: ShortWindowOutcome,
    jupiter_outcome: ShortWindowOutcome,
    quantity_micro: Micro,
    entry_all_in_cost_micro_usd: Micro,
    minimum_exit_profit_micro_usd: Micro,
) -> Result<ExitEvaluation, DomainError> {
    let polymarket_bids = sorted_bids(polymarket_book, polymarket_outcome);
    let jupiter_bids = sorted_bids(jupiter_book, jupiter_outcome);
    if polymarket_bids.is_empty() || jupiter_bids.is_empty() {
        return Ok(ExitEvaluation::MissingExitBid);
    }
    let Some(polymarket_quote) = quote_across_levels(
        &polymarket_bids,
        quantity_micro,
        QuoteVenue::Polymarket,
        QuoteSide::Sell,
    )?
    else {
        return Ok(ExitEvaluation::InsufficientExitDepth);
    };
    let Some(jupiter_quote) = quote_across_levels(
        &jupiter_bids,
        quantity_micro,
        QuoteVenue::Jupiter,
        QuoteSide::Sell,
    )?
    else {
        return Ok(ExitEvaluation::InsufficientExitDepth);
    };
    let net_proceeds = polymarket_quote
        .gross_micro_usd
        .checked_add(jupiter_quote.gross_micro_usd)
        .and_then(|value| value.checked_sub(polymarket_quote.taker_fee_micro_usd))
        .and_then(|value| value.checked_sub(jupiter_quote.taker_fee_micro_usd))
        .ok_or(DomainError::ArithmeticOverflow)?;
    let realized_profit = net_proceeds
        .checked_sub(entry_all_in_cost_micro_usd)
        .ok_or(DomainError::ArithmeticOverflow)?;
    if realized_profit < minimum_exit_profit_micro_usd {
        return Ok(ExitEvaluation::ExitNotGreen {
            projected_profit_micro_usd: realized_profit,
        });
    }
    Ok(ExitEvaluation::Eligible(ShortWindowExitProposal {
        quantity_micro,
        polymarket_bid: BookLevel::new(polymarket_quote.limit_price_micro_usd, quantity_micro),
        jupiter_bid: BookLevel::new(jupiter_quote.limit_price_micro_usd, quantity_micro),
        polymarket_gross_proceeds_micro_usd: polymarket_quote.gross_micro_usd,
        jupiter_gross_proceeds_micro_usd: jupiter_quote.gross_micro_usd,
        polymarket_taker_fee_micro_usd: polymarket_quote.taker_fee_micro_usd,
        jupiter_taker_fee_micro_usd: jupiter_quote.taker_fee_micro_usd,
        net_proceeds_micro_usd: net_proceeds,
        realized_profit_micro_usd: realized_profit,
    }))
}

pub fn quote_buy_across_levels(
    levels: &[BookLevel],
    quantity_micro: Micro,
    jupiter: bool,
) -> Result<Option<VenueTradeCost>, DomainError> {
    let sorted = sorted_levels(levels, QuoteSide::Buy);
    quote_across_levels(
        &sorted,
        quantity_micro,
        if jupiter {
            QuoteVenue::Jupiter
        } else {
            QuoteVenue::Polymarket
        },
        QuoteSide::Buy,
    )
}

fn minimum_qualifying_proposal(
    route: &EvaluatedCrossVenueRoute,
    minimum_quantity: Micro,
    maximum_quantity: Micro,
    config: &ShortWindowStrategyConfig,
) -> Result<Option<ShortWindowEntryProposal>, DomainError> {
    let mut segment_start = minimum_quantity;
    for segment_end in depth_breakpoints(route, segment_start, maximum_quantity)? {
        let start_proposal = entry_proposal(route, segment_start)?;
        if meets_entry_minimums(&start_proposal, config) {
            return Ok(Some(start_proposal));
        }
        if !meets_per_contract_minimum(&start_proposal, config) {
            return Ok(None);
        }

        let end_proposal = entry_proposal(route, segment_end)?;
        let viable_end = if meets_per_contract_minimum(&end_proposal, config) {
            segment_end
        } else {
            last_quantity_meeting_per_contract_minimum(route, segment_start, segment_end, config)?
        };
        let viable_proposal = entry_proposal(route, viable_end)?;
        if meets_entry_minimums(&viable_proposal, config) {
            return first_qualifying_quantity(route, segment_start, viable_end, config).map(Some);
        }
        if viable_end < segment_end
            || viable_proposal.nominal_edge_micro_usd < start_proposal.nominal_edge_micro_usd
        {
            return Ok(None);
        }
        segment_start = segment_end
            .checked_add(CONTRACT_STEP_MICRO)
            .ok_or(DomainError::ArithmeticOverflow)?;
        if segment_start > maximum_quantity {
            break;
        }
    }
    Ok(None)
}

fn entry_proposal(
    route: &EvaluatedCrossVenueRoute,
    quantity_micro: Micro,
) -> Result<ShortWindowEntryProposal, DomainError> {
    let polymarket = required_buy_quote_sorted(
        &route.polymarket_asks,
        quantity_micro,
        QuoteVenue::Polymarket,
    )?;
    let jupiter =
        required_buy_quote_sorted(&route.jupiter_asks, quantity_micro, QuoteVenue::Jupiter)?;
    let all_in_cost = polymarket
        .all_in_micro_usd
        .checked_add(jupiter.all_in_micro_usd)
        .ok_or(DomainError::ArithmeticOverflow)?;
    let nominal_edge = quantity_micro
        .checked_sub(all_in_cost)
        .ok_or(DomainError::ArithmeticOverflow)?;
    let edge_per_contract = nominal_edge
        .checked_mul(ONE_CONTRACT_MICRO)
        .ok_or(DomainError::ArithmeticOverflow)?
        .checked_div(quantity_micro)
        .ok_or(DomainError::NonPositiveDivisor)?;
    Ok(ShortWindowEntryProposal {
        route: route.route,
        quantity_micro,
        polymarket,
        jupiter,
        all_in_cost_micro_usd: all_in_cost,
        nominal_payout_micro_usd: quantity_micro,
        nominal_edge_micro_usd: nominal_edge,
        edge_micro_usd_per_contract: edge_per_contract,
    })
}

fn meets_entry_minimums(
    proposal: &ShortWindowEntryProposal,
    config: &ShortWindowStrategyConfig,
) -> bool {
    proposal.nominal_edge_micro_usd >= config.minimum_entry_edge_total_micro_usd
        && proposal.edge_micro_usd_per_contract >= config.minimum_entry_edge_micro_usd_per_contract
        && proposal.polymarket.gross_micro_usd >= config.polymarket_minimum_gross_order_micro_usd
        && proposal.jupiter.gross_micro_usd >= config.jupiter_minimum_gross_order_micro_usd
}

fn meets_per_contract_minimum(
    proposal: &ShortWindowEntryProposal,
    config: &ShortWindowStrategyConfig,
) -> bool {
    proposal.edge_micro_usd_per_contract >= config.minimum_entry_edge_micro_usd_per_contract
}

fn maximum_affordable_quantity(
    levels: &[BookLevel],
    maximum_quantity: Micro,
    budget: Micro,
    venue: QuoteVenue,
) -> Result<Micro, DomainError> {
    let sorted = sorted_levels(levels, QuoteSide::Buy);
    let mut low = 0;
    let mut high = maximum_quantity / CONTRACT_STEP_MICRO;
    while low < high {
        let middle = upper_midpoint(low, high);
        let cost =
            quote_across_levels(&sorted, middle * CONTRACT_STEP_MICRO, venue, QuoteSide::Buy)?
                .map_or_else(
                    || budget.checked_add(1).ok_or(DomainError::ArithmeticOverflow),
                    |quote| Ok(quote.all_in_micro_usd),
                )?;
        if cost <= budget {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    low.checked_mul(CONTRACT_STEP_MICRO)
        .ok_or(DomainError::ArithmeticOverflow)
}

fn minimum_quantity_for_gross(
    levels: &[BookLevel],
    maximum_quantity: Micro,
    minimum_gross: Micro,
    venue: QuoteVenue,
) -> Result<Option<Micro>, DomainError> {
    let sorted = sorted_levels(levels, QuoteSide::Buy);
    let Some(maximum_quote) =
        quote_across_levels(&sorted, maximum_quantity, venue, QuoteSide::Buy)?
    else {
        return Ok(None);
    };
    if maximum_quote.gross_micro_usd < minimum_gross {
        return Ok(None);
    }
    let mut low = 0;
    let mut high = maximum_quantity / CONTRACT_STEP_MICRO;
    while low < high {
        let middle = low.midpoint(high);
        let qualifies =
            quote_across_levels(&sorted, middle * CONTRACT_STEP_MICRO, venue, QuoteSide::Buy)?
                .is_some_and(|quote| quote.gross_micro_usd >= minimum_gross);
        if qualifies {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    Ok(Some(low * CONTRACT_STEP_MICRO))
}

/// Route asks are normalized and sorted once during route evaluation. Keeping
/// this inner sizing-loop function allocation-free avoids temporary vectors
/// for every binary-search probe.
fn required_buy_quote_sorted(
    levels: &[BookLevel],
    quantity: Micro,
    venue: QuoteVenue,
) -> Result<VenueTradeCost, DomainError> {
    quote_across_levels(levels, quantity, venue, QuoteSide::Buy)?
        .ok_or(DomainError::NegativeContractQuantity(quantity))
}

fn quote_across_levels(
    levels: &[BookLevel],
    quantity: Micro,
    venue: QuoteVenue,
    side: QuoteSide,
) -> Result<Option<VenueTradeCost>, DomainError> {
    if quantity <= 0 {
        return Ok(None);
    }
    let mut remaining = quantity;
    let mut gross = 0_i128;
    let mut taker_fee = 0_i128;
    let mut limit_price = 0_i128;
    let mut levels_consumed = 0_usize;
    for level in levels {
        if remaining <= 0 {
            break;
        }
        if level.contracts_micro <= 0 {
            continue;
        }
        let consumed = min(remaining, level.contracts_micro);
        gross = gross
            .checked_add(trade_gross_micro_usd(level.price_micro_usd, consumed)?)
            .ok_or(DomainError::ArithmeticOverflow)?;
        let level_fee = match venue {
            QuoteVenue::Polymarket => polymarket_fee_total(level.price_micro_usd, consumed)?,
            QuoteVenue::Jupiter if level.taker_fee_included => 0,
            QuoteVenue::Jupiter => {
                jupiter_prediction_taker_fee_total_micro_usd(level.price_micro_usd, consumed)?
            }
        };
        taker_fee = taker_fee
            .checked_add(level_fee)
            .ok_or(DomainError::ArithmeticOverflow)?;
        limit_price = level.price_micro_usd;
        levels_consumed += 1;
        remaining -= consumed;
    }
    if remaining > 0 {
        return Ok(None);
    }
    let scaled_gross = gross
        .checked_mul(ONE_CONTRACT_MICRO)
        .ok_or(DomainError::ArithmeticOverflow)?;
    let price = match side {
        QuoteSide::Buy => ceil_divide(scaled_gross, quantity)?,
        QuoteSide::Sell => scaled_gross / quantity,
    };
    let all_in = match side {
        QuoteSide::Buy => gross.checked_add(taker_fee),
        QuoteSide::Sell => gross.checked_sub(taker_fee),
    }
    .ok_or(DomainError::ArithmeticOverflow)?;
    Ok(Some(VenueTradeCost {
        price_micro_usd: price,
        limit_price_micro_usd: limit_price,
        levels_consumed,
        quantity_micro: quantity,
        gross_micro_usd: gross,
        taker_fee_micro_usd: taker_fee,
        all_in_micro_usd: all_in,
    }))
}

fn first_qualifying_quantity(
    route: &EvaluatedCrossVenueRoute,
    minimum_quantity: Micro,
    maximum_quantity: Micro,
    config: &ShortWindowStrategyConfig,
) -> Result<ShortWindowEntryProposal, DomainError> {
    let mut low = minimum_quantity / CONTRACT_STEP_MICRO;
    let mut high = maximum_quantity / CONTRACT_STEP_MICRO;
    while low < high {
        let middle = low.midpoint(high);
        if meets_entry_minimums(
            &entry_proposal(route, middle * CONTRACT_STEP_MICRO)?,
            config,
        ) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    entry_proposal(route, low * CONTRACT_STEP_MICRO)
}

fn last_quantity_meeting_per_contract_minimum(
    route: &EvaluatedCrossVenueRoute,
    minimum_quantity: Micro,
    maximum_quantity: Micro,
    config: &ShortWindowStrategyConfig,
) -> Result<Micro, DomainError> {
    let mut low = minimum_quantity / CONTRACT_STEP_MICRO;
    let mut high = maximum_quantity / CONTRACT_STEP_MICRO;
    while low < high {
        let middle = upper_midpoint(low, high);
        if meets_per_contract_minimum(
            &entry_proposal(route, middle * CONTRACT_STEP_MICRO)?,
            config,
        ) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    Ok(low * CONTRACT_STEP_MICRO)
}

fn depth_breakpoints(
    route: &EvaluatedCrossVenueRoute,
    minimum_quantity: Micro,
    maximum_quantity: Micro,
) -> Result<Vec<Micro>, DomainError> {
    let mut points = vec![maximum_quantity];
    for levels in [&route.polymarket_asks, &route.jupiter_asks] {
        let mut cumulative = 0_i128;
        for level in levels {
            cumulative = cumulative
                .checked_add(level.contracts_micro)
                .ok_or(DomainError::ArithmeticOverflow)?;
            for point in [floor_to_step(cumulative), ceil_to_step(cumulative)?] {
                if point >= minimum_quantity && point <= maximum_quantity {
                    points.push(point);
                }
            }
        }
    }
    points.sort_unstable();
    points.dedup();
    Ok(points)
}

fn polymarket_fee_total(price: Micro, quantity: Micro) -> Result<Micro, DomainError> {
    divide_round_nearest(
        polymarket_crypto_taker_fee_per_contract_micro_usd(price)?
            .checked_mul(quantity)
            .ok_or(DomainError::ArithmeticOverflow)?,
        ONE_CONTRACT_MICRO,
    )
}

fn trade_gross_micro_usd(price: Micro, quantity: Micro) -> Result<Micro, DomainError> {
    divide_round_nearest(
        price
            .checked_mul(quantity)
            .ok_or(DomainError::ArithmeticOverflow)?,
        ONE_CONTRACT_MICRO,
    )
}

fn sorted_bids(book: &BinaryOrderBook, outcome: ShortWindowOutcome) -> Vec<BookLevel> {
    let levels = match outcome {
        ShortWindowOutcome::Up => &book.yes.bids,
        ShortWindowOutcome::Down => &book.no.bids,
    };
    sorted_levels(levels, QuoteSide::Sell)
}

fn sorted_levels(levels: &[BookLevel], side: QuoteSide) -> Vec<BookLevel> {
    let mut sorted: Vec<_> = levels
        .iter()
        .copied()
        .filter(|level| {
            level.contracts_micro > 0 && (0..=ONE_USD_MICRO).contains(&level.price_micro_usd)
        })
        .collect();
    match side {
        QuoteSide::Buy => sorted.sort_unstable_by_key(|level| level.price_micro_usd),
        QuoteSide::Sell => {
            sorted.sort_unstable_by(|left, right| right.price_micro_usd.cmp(&left.price_micro_usd));
        }
    }
    sorted
}

const fn floor_to_step(value: Micro) -> Micro {
    value / CONTRACT_STEP_MICRO * CONTRACT_STEP_MICRO
}

fn ceil_to_step(value: Micro) -> Result<Micro, DomainError> {
    ceil_divide(value, CONTRACT_STEP_MICRO)?
        .checked_mul(CONTRACT_STEP_MICRO)
        .ok_or(DomainError::ArithmeticOverflow)
}

fn ceil_divide(numerator: Micro, denominator: Micro) -> Result<Micro, DomainError> {
    if denominator <= 0 {
        return Err(DomainError::NonPositiveDivisor);
    }
    numerator
        .checked_add(denominator - 1)
        .and_then(|value| value.checked_div(denominator))
        .ok_or(DomainError::ArithmeticOverflow)
}

const fn upper_midpoint(low: Micro, high: Micro) -> Micro {
    low.midpoint(high) + ((low ^ high) & 1)
}

#[derive(Clone, Copy)]
enum QuoteVenue {
    Polymarket,
    Jupiter,
}

#[derive(Clone, Copy)]
enum QuoteSide {
    Buy,
    Sell,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::short_window::{eligible_cross_venue_routes, evaluate_cross_venue_routes};
    use crate::types::{SideOrderBook, Venue};

    const CONFIG: ShortWindowStrategyConfig = ShortWindowStrategyConfig {
        polymarket_maximum_allocation_micro_usd: 25_000_000,
        jupiter_maximum_allocation_micro_usd: 25_000_000,
        jupiter_minimum_gross_order_micro_usd: 5_000_000,
        polymarket_minimum_gross_order_micro_usd: 1_000_000,
        polymarket_minimum_contracts_micro: 5_000_000,
        minimum_entry_edge_micro_usd_per_contract: 10_000,
        minimum_entry_edge_total_micro_usd: 100_000,
        minimum_exit_profit_micro_usd: 100_000,
    };

    #[test]
    fn sizes_smallest_entry_meeting_jupiter_minimum() {
        let route = route(
            &book(
                Venue::Polymarket,
                400_000,
                610_000,
                390_000,
                600_000,
                50_000_000,
            ),
            &book(
                Venue::Jupiter,
                460_000,
                550_000,
                450_000,
                540_000,
                50_000_000,
            ),
            72_000_000_000,
            72_004_000_000,
        );
        let result = evaluate_short_window_entry(route.as_ref(), 100_000_000, 100_000_000, &CONFIG)
            .expect("valid sizing");
        let EntryEvaluation::Eligible(proposal) = result else {
            panic!("entry rejected: {result:?}")
        };
        assert!(proposal.jupiter.gross_micro_usd >= 5_000_000);
        assert!(proposal.polymarket.all_in_micro_usd <= 25_000_000);
        assert!(proposal.jupiter.all_in_micro_usd <= 25_000_000);
        assert!(proposal.edge_micro_usd_per_contract >= 10_000);
        assert!(proposal.nominal_edge_micro_usd >= 100_000);
        assert!(proposal.quantity_micro < 10_000_000);
    }

    #[test]
    fn walks_deeper_asks_to_reach_order_minimum() {
        let poly = book(
            Venue::Polymarket,
            690_000,
            320_000,
            680_000,
            310_000,
            100_000_000,
        );
        let mut jupiter = book(
            Venue::Jupiter,
            770_000,
            238_000,
            760_000,
            228_000,
            100_000_000,
        );
        jupiter.no.asks = vec![
            BookLevel::new(238_000, 16_403_917),
            BookLevel::new(248_000, 100_000_000),
        ];
        let route = route(&poly, &jupiter, 77_000_000_000, 77_010_000_000);
        let result = evaluate_short_window_entry(route.as_ref(), 100_000_000, 100_000_000, &CONFIG)
            .expect("valid sizing");
        let EntryEvaluation::Eligible(proposal) = result else {
            panic!("entry rejected: {result:?}")
        };
        assert!(proposal.quantity_micro > 16_403_917);
        assert!(proposal.jupiter.gross_micro_usd >= 5_000_000);
        assert_eq!(proposal.jupiter.levels_consumed, 2);
        assert_eq!(proposal.jupiter.limit_price_micro_usd, 248_000);
    }

    #[test]
    fn exits_only_with_full_green_depth() {
        let mut poly = book(
            Venue::Polymarket,
            510_000,
            500_000,
            500_000,
            490_000,
            20_000_000,
        );
        let mut jupiter = book(
            Venue::Jupiter,
            460_000,
            560_000,
            450_000,
            550_000,
            20_000_000,
        );
        poly.yes.bids = vec![
            BookLevel::new(510_000, 4_000_000),
            BookLevel::new(500_000, 20_000_000),
        ];
        jupiter.no.bids = vec![
            BookLevel::new(560_000, 4_000_000),
            BookLevel::new(550_000, 20_000_000),
        ];
        let result = evaluate_short_window_exit(
            &poly,
            &jupiter,
            ShortWindowOutcome::Up,
            ShortWindowOutcome::Down,
            10_000_000,
            9_500_000,
            CONFIG.minimum_exit_profit_micro_usd,
        )
        .expect("valid exit evaluation");
        let ExitEvaluation::Eligible(proposal) = result else {
            panic!("exit rejected: {result:?}")
        };
        assert!(proposal.realized_profit_micro_usd >= 100_000);
        assert_eq!(proposal.polymarket_bid.price_micro_usd, 500_000);
        assert_eq!(proposal.jupiter_bid.price_micro_usd, 550_000);
    }

    fn route(
        poly: &BinaryOrderBook,
        jupiter: &BinaryOrderBook,
        poly_reference: Micro,
        jupiter_reference: Micro,
    ) -> Option<EvaluatedCrossVenueRoute> {
        evaluate_cross_venue_routes(
            poly,
            jupiter,
            &eligible_cross_venue_routes(poly_reference, jupiter_reference),
        )
        .expect("valid route")
        .into_iter()
        .next()
    }

    fn book(
        venue: Venue,
        up_ask: Micro,
        down_ask: Micro,
        up_bid: Micro,
        down_bid: Micro,
        contracts: Micro,
    ) -> BinaryOrderBook {
        BinaryOrderBook {
            venue,
            provider: String::new(),
            market_id: String::new(),
            received_at_ms: 1,
            source_timestamp_ms: None,
            yes: SideOrderBook {
                bids: vec![BookLevel::new(up_bid, contracts)],
                asks: vec![BookLevel::new(up_ask, contracts)],
            },
            no: SideOrderBook {
                bids: vec![BookLevel::new(down_bid, contracts)],
                asks: vec![BookLevel::new(down_ask, contracts)],
            },
        }
    }
}
