use anyhow::{Context as _, Result, bail};
use jupol_domain::types::VenueMarket;
use jupol_jupiter::{DiscoveryOptions, JupiterClient};
use jupol_polymarket::PolymarketGammaClient;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum DurationKind {
    FiveMinutes,
    FifteenMinutes,
}

impl DurationKind {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::FiveMinutes => "5m",
            Self::FifteenMinutes => "15m",
        }
    }

    #[must_use]
    pub const fn milliseconds(self) -> i64 {
        match self {
            Self::FiveMinutes => 300_000,
            Self::FifteenMinutes => 900_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct CrossVenuePair {
    pub duration: DurationKind,
    pub start_ms: i64,
    pub end_ms: i64,
    pub polymarket_slug: String,
    pub polymarket: VenueMarket,
    pub jupiter_event_id: String,
    pub jupiter_up: VenueMarket,
    pub jupiter_down: VenueMarket,
}

impl CrossVenuePair {
    #[must_use]
    pub fn key(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.duration.label(),
            self.start_ms,
            self.polymarket.market_id,
            self.jupiter_event_id
        )
    }

    #[must_use]
    pub fn polymarket_up_token(&self) -> &str {
        &self.polymarket.clob_token_ids[0]
    }

    #[must_use]
    pub fn polymarket_down_token(&self) -> &str {
        &self.polymarket.clob_token_ids[1]
    }
}

pub async fn discover_pair(
    duration: DurationKind,
    now_ms: i64,
    gamma: &PolymarketGammaClient,
    jupiter: &JupiterClient,
) -> Result<CrossVenuePair> {
    let duration_ms = duration.milliseconds();
    let start_ms = now_ms.div_euclid(duration_ms) * duration_ms;
    let end_ms = start_ms + duration_ms;
    let slug = format!("btc-updown-{}-{}", duration.label(), start_ms / 1_000);
    let forecast_options = DiscoveryOptions::forecast_btc();
    let (polymarket_markets, forecast_markets) = tokio::join!(
        gamma.get_event_markets_by_slug(&slug),
        jupiter.get_markets(&forecast_options),
    );
    let polymarket_markets =
        polymarket_markets.context("Polymarket same-duration discovery failed")?;
    let forecast_markets = forecast_markets.context("Jupiter same-duration discovery failed")?;
    if polymarket_markets.len() != 1 {
        bail!(
            "{} Polymarket event resolved {} markets, expected one",
            duration.label(),
            polymarket_markets.len()
        );
    }
    let polymarket = polymarket_markets
        .into_iter()
        .next()
        .expect("length checked");
    validate_polymarket(&polymarket, duration, end_ms)?;

    let candidates = forecast_markets
        .into_iter()
        .filter(|market| {
            market.provider == "bisonfi"
                && market.open_time_ms == Some(start_ms)
                && market.close_time_ms == Some(end_ms)
                && market
                    .event_title
                    .to_ascii_lowercase()
                    .contains(&format!("({})", duration.label()))
        })
        .collect::<Vec<_>>();
    let up = require_jupiter_side(&candidates, "up", duration)?;
    let down = require_jupiter_side(&candidates, "down", duration)?;
    let up_event = up
        .event_id
        .clone()
        .context("Jupiter UP side has no event ID")?;
    if down.event_id.as_deref() != Some(up_event.as_str()) {
        bail!("{} Jupiter sides do not share one event", duration.label());
    }
    if up.rules_primary != down.rules_primary || up.rules_secondary != down.rules_secondary {
        bail!("{} Jupiter side rules differ", duration.label());
    }
    Ok(CrossVenuePair {
        duration,
        start_ms,
        end_ms,
        polymarket_slug: slug,
        polymarket,
        jupiter_event_id: up_event,
        jupiter_up: up,
        jupiter_down: down,
    })
}

fn validate_polymarket(market: &VenueMarket, duration: DurationKind, end_ms: i64) -> Result<()> {
    if market.status != "open" {
        bail!(
            "{} Polymarket status is {}",
            duration.label(),
            market.status
        );
    }
    if market.close_time_ms != Some(end_ms) {
        bail!("{} Polymarket close boundary differs", duration.label());
    }
    if market.outcomes.len() != 2
        || !market.outcomes[0].eq_ignore_ascii_case("up")
        || !market.outcomes[1].eq_ignore_ascii_case("down")
        || market.clob_token_ids.len() != 2
    {
        bail!(
            "{} Polymarket is not a two-token Up/Down CLOB",
            duration.label()
        );
    }
    let rules =
        format!("{}\n{}", market.rules_primary, market.rules_secondary).to_ascii_lowercase();
    for required in ["chainlink", "twap", "btc/usd", "60s"] {
        if !rules.contains(required) {
            bail!(
                "{} Polymarket rules are missing {required}",
                duration.label()
            );
        }
    }
    Ok(())
}

fn require_jupiter_side(
    markets: &[VenueMarket],
    side: &str,
    duration: DurationKind,
) -> Result<VenueMarket> {
    let matching = markets
        .iter()
        .filter(|market| market.title.trim().eq_ignore_ascii_case(side))
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        bail!(
            "{} Jupiter resolved {} {} sides, expected one",
            duration.label(),
            matching.len(),
            side.to_ascii_uppercase()
        );
    }
    let market = matching[0];
    if market.status != "open" || !market.market_id.starts_with("BISON-") {
        bail!(
            "{} Jupiter {} is not an open native Forecast market",
            duration.label(),
            side.to_ascii_uppercase()
        );
    }
    let rules = market.rules_primary.to_ascii_lowercase();
    if !rules.contains("chainlink") || !rules.contains("btc/usd") {
        bail!(
            "{} Jupiter {} rules are not BTC/USD Chainlink",
            duration.label(),
            side.to_ascii_uppercase()
        );
    }
    Ok(market.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floors_round_boundaries() {
        let duration = DurationKind::FiveMinutes;
        let now = 1_725_000_123_456_i64;
        let start = now.div_euclid(duration.milliseconds()) * duration.milliseconds();
        assert!(start <= now);
        assert!(now < start + duration.milliseconds());
    }
}
