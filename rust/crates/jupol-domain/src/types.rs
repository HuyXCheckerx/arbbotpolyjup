use crate::Micro;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Venue {
    Polymarket,
    Jupiter,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Asset {
    Btc,
    Eth,
    Sol,
    Xrp,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MarketPricing {
    pub buy_yes_micro_usd: Option<Micro>,
    pub sell_yes_micro_usd: Option<Micro>,
    pub buy_no_micro_usd: Option<Micro>,
    pub sell_no_micro_usd: Option<Micro>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketFeeSchedule {
    pub rate: String,
    pub exponent: i32,
    pub taker_only: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VenueMarket {
    pub venue: Venue,
    pub provider: String,
    pub event_id: Option<String>,
    pub market_id: String,
    pub title: String,
    pub event_title: String,
    pub rules_primary: String,
    pub rules_secondary: String,
    pub status: String,
    pub open_time_ms: Option<i64>,
    pub close_time_ms: Option<i64>,
    pub clob_token_ids: Vec<String>,
    pub outcomes: Vec<String>,
    pub outcome_mint: Option<String>,
    pub pricing: MarketPricing,
    pub fee_schedule: Option<MarketFeeSchedule>,
    pub source_url: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShortWindowOutcome {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BookLevel {
    pub price_micro_usd: Micro,
    pub contracts_micro: Micro,
    pub taker_fee_included: bool,
}

impl BookLevel {
    #[must_use]
    pub const fn new(price_micro_usd: Micro, contracts_micro: Micro) -> Self {
        Self {
            price_micro_usd,
            contracts_micro,
            taker_fee_included: false,
        }
    }

    #[must_use]
    pub const fn fee_included(mut self) -> Self {
        self.taker_fee_included = true;
        self
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SideOrderBook {
    pub bids: Vec<BookLevel>,
    pub asks: Vec<BookLevel>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BinaryOrderBook {
    pub venue: Venue,
    pub provider: String,
    pub market_id: String,
    pub received_at_ms: i64,
    pub source_timestamp_ms: Option<i64>,
    pub yes: SideOrderBook,
    pub no: SideOrderBook,
}
