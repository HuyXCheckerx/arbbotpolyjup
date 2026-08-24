use anyhow::{Result, bail};
use jupol_domain::types::{BinaryOrderBook, BookLevel, SideOrderBook, Venue, VenueMarket};
use jupol_jupiter::{DiscoveryOptions, JupiterClient};
use jupol_polymarket::{PolymarketGammaClient, PolymarketMarketData};

const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Debug)]
pub struct DailyThresholdPair {
    pub key: String,
    pub close_ms: i64,
    pub polymarket_slug: String,
    pub polymarket: VenueMarket,
    pub jupiter: VenueMarket,
}

impl DailyThresholdPair {
    #[must_use]
    pub fn yes_token(&self) -> &str {
        outcome_token(&self.polymarket, "yes")
    }

    #[must_use]
    pub fn no_token(&self) -> &str {
        outcome_token(&self.polymarket, "no")
    }
}

pub async fn discover_daily_threshold_pairs(
    jupiter: &JupiterClient,
    gamma: &PolymarketGammaClient,
    now_ms: i64,
) -> Result<Vec<DailyThresholdPair>> {
    let options = DiscoveryOptions {
        provider: "polymarket".to_owned(),
        category: "crypto".to_owned(),
        subcategory: None,
        filter: Some("live".to_owned()),
        tag: None,
        // Jupiter's current events API only accepts volume, volume24hr, or beginAt.
        // We apply the close-time window below and sort the validated pairs locally.
        sort_by: Some("beginAt".to_owned()),
        sort_direction: Some("asc".to_owned()),
        max_events: 100,
        page_size: 20,
    };
    let markets = jupiter.get_markets(&options).await?;
    let mut pairs = Vec::new();
    for jupiter_market in markets {
        let Some(polymarket_id) = jupiter_market.market_id.strip_prefix("POLY-") else {
            continue;
        };
        if !polymarket_id.bytes().all(|byte| byte.is_ascii_digit())
            || jupiter_market.provider != "polymarket"
            || jupiter_market.status != "open"
            || !jupiter_market
                .event_title
                .trim()
                .starts_with("Bitcoin above ")
        {
            continue;
        }
        let Some(close_ms) = jupiter_market.close_time_ms else {
            continue;
        };
        if close_ms <= now_ms || close_ms > now_ms.saturating_add(14 * DAY_MS) {
            continue;
        }
        let polymarket = gamma.get_market(polymarket_id).await?;
        validate_mirror(&jupiter_market, &polymarket)?;
        pairs.push(DailyThresholdPair {
            key: format!("daily:{polymarket_id}"),
            close_ms,
            polymarket_slug: format!("daily-market-{polymarket_id}"),
            polymarket,
            jupiter: jupiter_market,
        });
    }
    pairs.sort_unstable_by_key(|pair| pair.close_ms);
    pairs.dedup_by(|left, right| left.key == right.key);
    Ok(pairs)
}

pub async fn refresh_daily_books(
    pair: &mut DailyThresholdPair,
    jupiter: &JupiterClient,
    polymarket: &PolymarketMarketData,
) -> Result<(BinaryOrderBook, BinaryOrderBook)> {
    let (jupiter_market, polymarket_book) = tokio::join!(
        jupiter.get_market(&pair.jupiter.market_id),
        polymarket.binary_order_book(
            &pair.polymarket.market_id,
            pair.yes_token(),
            pair.no_token(),
        ),
    );
    pair.jupiter = jupiter_market?;
    let polymarket_book = polymarket_book?;
    let received_at_ms = chrono::Utc::now().timestamp_millis();
    let jupiter_book = BinaryOrderBook {
        venue: Venue::Jupiter,
        provider: pair.jupiter.provider.clone(),
        market_id: pair.jupiter.market_id.clone(),
        received_at_ms,
        source_timestamp_ms: None,
        yes: SideOrderBook {
            bids: pricing_level(
                pair.jupiter.pricing.sell_yes_micro_usd,
                top_depth(&polymarket_book.yes.bids),
            ),
            asks: pricing_level(
                pair.jupiter.pricing.buy_yes_micro_usd,
                top_depth(&polymarket_book.yes.asks),
            ),
        },
        no: SideOrderBook {
            bids: pricing_level(
                pair.jupiter.pricing.sell_no_micro_usd,
                top_depth(&polymarket_book.no.bids),
            ),
            asks: pricing_level(
                pair.jupiter.pricing.buy_no_micro_usd,
                top_depth(&polymarket_book.no.asks),
            ),
        },
    };
    Ok((polymarket_book, jupiter_book))
}

fn validate_mirror(jupiter: &VenueMarket, polymarket: &VenueMarket) -> Result<()> {
    if polymarket.status != "open"
        || polymarket.market_id != jupiter.market_id.trim_start_matches("POLY-")
        || polymarket.close_time_ms != jupiter.close_time_ms
        || polymarket.clob_token_ids != jupiter.clob_token_ids
        || !has_yes_no(polymarket)
        || !has_yes_no(jupiter)
    {
        bail!(
            "daily threshold mirror {} does not exactly match Gamma",
            jupiter.market_id
        );
    }
    let poly_rules = format!(
        "{}\n{}",
        polymarket.rules_primary, polymarket.rules_secondary
    );
    let jup_rules = format!("{}\n{}", jupiter.rules_primary, jupiter.rules_secondary);
    if poly_rules.trim() != jup_rules.trim() {
        bail!(
            "daily threshold mirror {} has different rules",
            jupiter.market_id
        );
    }
    Ok(())
}

fn has_yes_no(market: &VenueMarket) -> bool {
    market
        .outcomes
        .iter()
        .any(|value| value.eq_ignore_ascii_case("yes"))
        && market
            .outcomes
            .iter()
            .any(|value| value.eq_ignore_ascii_case("no"))
}

fn outcome_token<'a>(market: &'a VenueMarket, expected: &str) -> &'a str {
    market
        .outcomes
        .iter()
        .position(|outcome| outcome.eq_ignore_ascii_case(expected))
        .and_then(|index| market.clob_token_ids.get(index))
        .map_or("", String::as_str)
}

fn pricing_level(price: Option<i128>, depth: i128) -> Vec<BookLevel> {
    price
        .filter(|_| depth > 0)
        .map(|price| vec![BookLevel::new(price, depth).fee_included()])
        .unwrap_or_default()
}

fn top_depth(levels: &[BookLevel]) -> i128 {
    levels.first().map_or(0, |level| level.contracts_micro)
}
