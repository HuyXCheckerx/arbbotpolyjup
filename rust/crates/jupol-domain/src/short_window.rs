use std::cmp::{Ordering, min};
use std::fmt;

use crate::Micro;
use crate::fixed::{ONE_CONTRACT_MICRO, ONE_USD_MICRO};
use crate::types::{BinaryOrderBook, BookLevel, ShortWindowOutcome};

const FEE_RATE_NUMERATOR: Micro = 7;
const FEE_RATE_DENOMINATOR: Micro = 100;
const POLYMARKET_FEE_ROUNDING_MICRO_USD: Micro = 10;
const JUPITER_ORDER_FEE_ROUNDING_MICRO_USD: Micro = 10_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DomainError {
    InvalidBinaryPrice(Micro),
    NegativeContractQuantity(Micro),
    ArithmeticOverflow,
    NonPositiveDivisor,
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBinaryPrice(value) => {
                write!(formatter, "Binary price is outside $0-$1: {value}")
            }
            Self::NegativeContractQuantity(value) => {
                write!(formatter, "Contract quantity is negative: {value}")
            }
            Self::ArithmeticOverflow => {
                formatter.write_str("Exact financial calculation overflowed i128")
            }
            Self::NonPositiveDivisor => {
                formatter.write_str("Cannot divide by a non-positive value")
            }
        }
    }
}

impl std::error::Error for DomainError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteReason {
    PolymarketReferenceLower,
    PolymarketReferenceHigher,
    ReferencesEqual,
    AnyComplementaryRoute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CrossVenueShortWindowRoute {
    pub polymarket_outcome: ShortWindowOutcome,
    pub jupiter_outcome: ShortWindowOutcome,
    pub reason: RouteReason,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluatedCrossVenueRoute {
    pub route: CrossVenueShortWindowRoute,
    pub polymarket_ask: BookLevel,
    pub jupiter_ask: BookLevel,
    pub polymarket_asks: Vec<BookLevel>,
    pub jupiter_asks: Vec<BookLevel>,
    pub common_top_contracts_micro: Micro,
    pub common_depth_contracts_micro: Micro,
    pub gross_cost_total_micro_usd: Micro,
    pub polymarket_taker_fee_total_micro_usd: Micro,
    pub jupiter_taker_fee_total_micro_usd: Micro,
    pub taker_fee_total_micro_usd: Micro,
    pub all_in_cost_total_micro_usd: Micro,
    pub nominal_complementary_payout_total_micro_usd: Micro,
    pub nominal_edge_total_micro_usd: Micro,
    pub effective_all_in_micro_usd_per_contract: Micro,
    pub effective_edge_micro_usd_per_contract: Micro,
    pub is_fee_adjusted_candidate: bool,
}

#[must_use]
pub fn reference_prices_within(
    polymarket_reference_micro_usd: Micro,
    jupiter_reference_micro_usd: Micro,
    maximum_difference_micro_usd: Micro,
) -> bool {
    reference_difference_micro_usd(polymarket_reference_micro_usd, jupiter_reference_micro_usd)
        .is_some_and(|difference| difference < maximum_difference_micro_usd)
}

#[must_use]
pub fn reference_difference_micro_usd(left: Micro, right: Micro) -> Option<Micro> {
    left.checked_sub(right)?.checked_abs()
}

#[must_use]
pub fn eligible_cross_venue_routes(
    polymarket_reference_micro_usd: Micro,
    jupiter_reference_micro_usd: Micro,
) -> Vec<CrossVenueShortWindowRoute> {
    match polymarket_reference_micro_usd.cmp(&jupiter_reference_micro_usd) {
        Ordering::Less => vec![CrossVenueShortWindowRoute {
            polymarket_outcome: ShortWindowOutcome::Up,
            jupiter_outcome: ShortWindowOutcome::Down,
            reason: RouteReason::PolymarketReferenceLower,
        }],
        Ordering::Greater => vec![CrossVenueShortWindowRoute {
            polymarket_outcome: ShortWindowOutcome::Down,
            jupiter_outcome: ShortWindowOutcome::Up,
            reason: RouteReason::PolymarketReferenceHigher,
        }],
        Ordering::Equal => vec![
            CrossVenueShortWindowRoute {
                polymarket_outcome: ShortWindowOutcome::Up,
                jupiter_outcome: ShortWindowOutcome::Down,
                reason: RouteReason::ReferencesEqual,
            },
            CrossVenueShortWindowRoute {
                polymarket_outcome: ShortWindowOutcome::Down,
                jupiter_outcome: ShortWindowOutcome::Up,
                reason: RouteReason::ReferencesEqual,
            },
        ],
    }
}

#[must_use]
pub fn all_complementary_cross_venue_routes() -> [CrossVenueShortWindowRoute; 2] {
    [
        CrossVenueShortWindowRoute {
            polymarket_outcome: ShortWindowOutcome::Up,
            jupiter_outcome: ShortWindowOutcome::Down,
            reason: RouteReason::AnyComplementaryRoute,
        },
        CrossVenueShortWindowRoute {
            polymarket_outcome: ShortWindowOutcome::Down,
            jupiter_outcome: ShortWindowOutcome::Up,
            reason: RouteReason::AnyComplementaryRoute,
        },
    ]
}

pub fn polymarket_crypto_taker_fee_per_contract_micro_usd(
    price: Micro,
) -> Result<Micro, DomainError> {
    assert_binary_price(price)?;
    let numerator = checked_product(&[
        price,
        ONE_USD_MICRO
            .checked_sub(price)
            .ok_or(DomainError::ArithmeticOverflow)?,
        FEE_RATE_NUMERATOR,
    ])?;
    let denominator = checked_product(&[FEE_RATE_DENOMINATOR, ONE_USD_MICRO])?;
    round_rational_to_multiple(numerator, denominator, POLYMARKET_FEE_ROUNDING_MICRO_USD)
}

pub fn jupiter_prediction_taker_fee_total_micro_usd(
    price: Micro,
    contracts: Micro,
) -> Result<Micro, DomainError> {
    assert_binary_price(price)?;
    if contracts < 0 {
        return Err(DomainError::NegativeContractQuantity(contracts));
    }
    if contracts == 0 || price == 0 || price == ONE_USD_MICRO {
        return Ok(0);
    }
    let numerator = checked_product(&[
        price,
        ONE_USD_MICRO
            .checked_sub(price)
            .ok_or(DomainError::ArithmeticOverflow)?,
        FEE_RATE_NUMERATOR,
        contracts,
    ])?;
    let denominator = checked_product(&[FEE_RATE_DENOMINATOR, ONE_USD_MICRO, ONE_CONTRACT_MICRO])?;
    ceil_rational_to_multiple(numerator, denominator, JUPITER_ORDER_FEE_ROUNDING_MICRO_USD)
}

pub fn evaluate_cross_venue_routes(
    polymarket_book: &BinaryOrderBook,
    jupiter_book: &BinaryOrderBook,
    routes: &[CrossVenueShortWindowRoute],
) -> Result<Vec<EvaluatedCrossVenueRoute>, DomainError> {
    let mut evaluated = Vec::with_capacity(routes.len());
    for &route in routes {
        let polymarket_asks = sorted_asks(polymarket_book, route.polymarket_outcome);
        let jupiter_asks = sorted_asks(jupiter_book, route.jupiter_outcome);
        let (Some(&polymarket_ask), Some(&jupiter_ask)) =
            (polymarket_asks.first(), jupiter_asks.first())
        else {
            continue;
        };
        let common_top_contracts_micro =
            min(polymarket_ask.contracts_micro, jupiter_ask.contracts_micro);
        if common_top_contracts_micro <= 0 {
            continue;
        }
        let common_depth_contracts_micro = min(
            total_contracts(&polymarket_asks)?,
            total_contracts(&jupiter_asks)?,
        );
        let gross_cost_per_contract = polymarket_ask
            .price_micro_usd
            .checked_add(jupiter_ask.price_micro_usd)
            .ok_or(DomainError::ArithmeticOverflow)?;
        let gross_cost_total_micro_usd = divide_round_nearest(
            gross_cost_per_contract
                .checked_mul(common_top_contracts_micro)
                .ok_or(DomainError::ArithmeticOverflow)?,
            ONE_CONTRACT_MICRO,
        )?;
        let polymarket_taker_fee_total_micro_usd = divide_round_nearest(
            polymarket_crypto_taker_fee_per_contract_micro_usd(polymarket_ask.price_micro_usd)?
                .checked_mul(common_top_contracts_micro)
                .ok_or(DomainError::ArithmeticOverflow)?,
            ONE_CONTRACT_MICRO,
        )?;
        let jupiter_taker_fee_total_micro_usd = if jupiter_ask.taker_fee_included {
            0
        } else {
            jupiter_prediction_taker_fee_total_micro_usd(
                jupiter_ask.price_micro_usd,
                common_top_contracts_micro,
            )?
        };
        let taker_fee_total_micro_usd = polymarket_taker_fee_total_micro_usd
            .checked_add(jupiter_taker_fee_total_micro_usd)
            .ok_or(DomainError::ArithmeticOverflow)?;
        let all_in_cost_total_micro_usd = gross_cost_total_micro_usd
            .checked_add(taker_fee_total_micro_usd)
            .ok_or(DomainError::ArithmeticOverflow)?;
        let nominal_payout = common_top_contracts_micro;
        let nominal_edge_total_micro_usd = nominal_payout
            .checked_sub(all_in_cost_total_micro_usd)
            .ok_or(DomainError::ArithmeticOverflow)?;
        let effective_all_in_micro_usd_per_contract = all_in_cost_total_micro_usd
            .checked_mul(ONE_CONTRACT_MICRO)
            .ok_or(DomainError::ArithmeticOverflow)?
            / common_top_contracts_micro;
        let effective_edge_micro_usd_per_contract = nominal_edge_total_micro_usd
            .checked_mul(ONE_CONTRACT_MICRO)
            .ok_or(DomainError::ArithmeticOverflow)?
            / common_top_contracts_micro;

        evaluated.push(EvaluatedCrossVenueRoute {
            route,
            polymarket_ask,
            jupiter_ask,
            polymarket_asks,
            jupiter_asks,
            common_top_contracts_micro,
            common_depth_contracts_micro,
            gross_cost_total_micro_usd,
            polymarket_taker_fee_total_micro_usd,
            jupiter_taker_fee_total_micro_usd,
            taker_fee_total_micro_usd,
            all_in_cost_total_micro_usd,
            nominal_complementary_payout_total_micro_usd: nominal_payout,
            nominal_edge_total_micro_usd,
            effective_all_in_micro_usd_per_contract,
            effective_edge_micro_usd_per_contract,
            is_fee_adjusted_candidate: nominal_edge_total_micro_usd > 0,
        });
    }
    evaluated.sort_unstable_by(|left, right| {
        right
            .nominal_edge_total_micro_usd
            .cmp(&left.nominal_edge_total_micro_usd)
    });
    Ok(evaluated)
}

fn sorted_asks(book: &BinaryOrderBook, outcome: ShortWindowOutcome) -> Vec<BookLevel> {
    let source = match outcome {
        ShortWindowOutcome::Up => &book.yes.asks,
        ShortWindowOutcome::Down => &book.no.asks,
    };
    let mut levels: Vec<_> = source
        .iter()
        .copied()
        .filter(|level| {
            level.contracts_micro > 0 && (0..=ONE_USD_MICRO).contains(&level.price_micro_usd)
        })
        .collect();
    levels.sort_unstable_by_key(|level| level.price_micro_usd);
    levels
}

fn total_contracts(levels: &[BookLevel]) -> Result<Micro, DomainError> {
    levels.iter().try_fold(0_i128, |total, level| {
        total
            .checked_add(level.contracts_micro)
            .ok_or(DomainError::ArithmeticOverflow)
    })
}

fn assert_binary_price(price: Micro) -> Result<(), DomainError> {
    if (0..=ONE_USD_MICRO).contains(&price) {
        Ok(())
    } else {
        Err(DomainError::InvalidBinaryPrice(price))
    }
}

pub(crate) fn checked_product(values: &[Micro]) -> Result<Micro, DomainError> {
    values.iter().try_fold(1_i128, |product, value| {
        product
            .checked_mul(*value)
            .ok_or(DomainError::ArithmeticOverflow)
    })
}

pub(crate) fn round_rational_to_multiple(
    numerator: Micro,
    denominator: Micro,
    multiple: Micro,
) -> Result<Micro, DomainError> {
    let scaled_denominator = denominator
        .checked_mul(multiple)
        .ok_or(DomainError::ArithmeticOverflow)?;
    if scaled_denominator <= 0 {
        return Err(DomainError::NonPositiveDivisor);
    }
    numerator
        .checked_add(scaled_denominator / 2)
        .and_then(|value| value.checked_div(scaled_denominator))
        .and_then(|value| value.checked_mul(multiple))
        .ok_or(DomainError::ArithmeticOverflow)
}

pub(crate) fn ceil_rational_to_multiple(
    numerator: Micro,
    denominator: Micro,
    multiple: Micro,
) -> Result<Micro, DomainError> {
    let scaled_denominator = denominator
        .checked_mul(multiple)
        .ok_or(DomainError::ArithmeticOverflow)?;
    if scaled_denominator <= 0 {
        return Err(DomainError::NonPositiveDivisor);
    }
    numerator
        .checked_add(scaled_denominator - 1)
        .and_then(|value| value.checked_div(scaled_denominator))
        .and_then(|value| value.checked_mul(multiple))
        .ok_or(DomainError::ArithmeticOverflow)
}

pub(crate) fn divide_round_nearest(
    numerator: Micro,
    denominator: Micro,
) -> Result<Micro, DomainError> {
    if denominator <= 0 {
        return Err(DomainError::NonPositiveDivisor);
    }
    numerator
        .checked_add(denominator / 2)
        .and_then(|value| value.checked_div(denominator))
        .ok_or(DomainError::ArithmeticOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SideOrderBook, Venue};

    #[test]
    fn reference_difference_is_strict() {
        assert!(reference_prices_within(
            72_000_000_000,
            72_004_999_999,
            5_000_000
        ));
        assert!(!reference_prices_within(
            72_000_000_000,
            72_005_000_000,
            5_000_000
        ));
    }

    #[test]
    fn route_evaluation_includes_both_fees() {
        let routes = eligible_cross_venue_routes(72_000_000_000, 72_004_000_000);
        let result = evaluate_cross_venue_routes(
            &book(Venue::Polymarket, 400_000, 610_000, 10_000_000),
            &book(Venue::Jupiter, 460_000, 550_000, 8_000_000),
            &routes,
        )
        .expect("valid evaluation");
        let route = &result[0];
        assert_eq!(route.common_top_contracts_micro, 8_000_000);
        assert_eq!(route.gross_cost_total_micro_usd, 7_600_000);
        assert_eq!(route.polymarket_taker_fee_total_micro_usd, 134_400);
        assert_eq!(route.jupiter_taker_fee_total_micro_usd, 140_000);
        assert!(route.is_fee_adjusted_candidate);
    }

    #[test]
    fn fee_included_jupiter_quote_is_not_double_charged() {
        let poly = book(Venue::Polymarket, 400_000, 610_000, 10_000_000);
        let mut jupiter = book(Venue::Jupiter, 460_000, 550_000, 10_000_000);
        jupiter.no.asks[0].taker_fee_included = true;
        let result = evaluate_cross_venue_routes(
            &poly,
            &jupiter,
            &eligible_cross_venue_routes(72_000_000_000, 72_004_000_000),
        )
        .expect("valid evaluation");
        assert_eq!(result[0].jupiter_taker_fee_total_micro_usd, 0);
    }

    fn book(venue: Venue, up_ask: Micro, down_ask: Micro, contracts: Micro) -> BinaryOrderBook {
        BinaryOrderBook {
            venue,
            provider: String::new(),
            market_id: String::new(),
            received_at_ms: 1,
            source_timestamp_ms: None,
            yes: SideOrderBook {
                bids: vec![],
                asks: vec![BookLevel::new(up_ask, contracts)],
            },
            no: SideOrderBook {
                bids: vec![],
                asks: vec![BookLevel::new(down_ask, contracts)],
            },
        }
    }
}
