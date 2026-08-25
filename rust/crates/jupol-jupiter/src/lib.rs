//! Jupiter Prediction developer API client for live order construction,
//! execution, position polling, and exact order-book ingestion.

#![allow(clippy::missing_errors_doc)]

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::{SinkExt as _, StreamExt as _};
use jupol_domain::Micro;
use jupol_domain::fixed::{ONE_USD_MICRO, parse_contracts, parse_usd};
use jupol_domain::types::{
    BinaryOrderBook, BookLevel, MarketPricing, SideOrderBook, Venue, VenueMarket,
};
use jupol_http::{HttpClient, HttpClientOptions, HttpError};
use jupol_runtime::request_scheduler::{JupiterRequestScheduler, RequestPriority, SchedulerError};
use jupol_solana::{SolanaError, SolanaRpc, parse_keypair, sign_versioned_transaction};
use reqwest::{Method, Url};
use serde::Serialize;
use serde_json::{Map, Value, json};
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer as _;
use tokio::sync::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_PREDICTION_URL: &str = "https://api.jup.ag/prediction/v1";
const DEFAULT_SWAP_URL: &str = "https://api.jup.ag/swap/v2";
const DEFAULT_PRICE_WEBSOCKET_URL: &str = "wss://prediction-market-price-service.fly.dev/ws/prices";
const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const PREDICTION_MINIMUM_BUY_MICRO_USD: Micro = 5_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JupiterPriceUpdate {
    pub market_id: String,
    pub source_timestamp_ms: i64,
    pub received_at_ms: i64,
    pub yes_bid_micro_usd: Micro,
    pub yes_ask_micro_usd: Micro,
    pub no_bid_micro_usd: Micro,
    pub no_ask_micro_usd: Micro,
}

pub struct JupiterPriceBookState {
    up_market_id: String,
    down_market_id: String,
    screening_gross_micro_usd: Micro,
    updates: HashMap<String, JupiterPriceUpdate>,
}

impl JupiterPriceBookState {
    pub fn new(
        up_market_id: impl Into<String>,
        down_market_id: impl Into<String>,
        screening_gross_micro_usd: Micro,
    ) -> Result<Self, JupiterError> {
        if screening_gross_micro_usd <= 0 {
            return Err(invalid("screening gross must be positive"));
        }
        Ok(Self {
            up_market_id: up_market_id.into(),
            down_market_id: down_market_id.into(),
            screening_gross_micro_usd,
            updates: HashMap::new(),
        })
    }

    #[must_use]
    pub fn market_ids(&self) -> Vec<String> {
        vec![self.up_market_id.clone(), self.down_market_id.clone()]
    }

    pub fn apply(
        &mut self,
        update: JupiterPriceUpdate,
    ) -> Result<Option<BinaryOrderBook>, JupiterError> {
        if update.market_id != self.up_market_id && update.market_id != self.down_market_id {
            return Ok(None);
        }
        // The public screening feed transiently publishes zero asks while a
        // market snapshot is being initialized. A zero/one-dollar sentinel is
        // not executable liquidity: retain the last valid update instead of
        // poisoning the book or terminating the monitor.
        if update.yes_ask_micro_usd <= 0 || update.yes_ask_micro_usd >= ONE_USD_MICRO {
            return Ok(None);
        }
        self.updates.insert(update.market_id.clone(), update);
        let Some(up) = self.updates.get(&self.up_market_id) else {
            return Ok(None);
        };
        let Some(down) = self.updates.get(&self.down_market_id) else {
            return Ok(None);
        };
        Ok(Some(BinaryOrderBook {
            venue: Venue::Jupiter,
            provider: "bisonfi_price_websocket".to_owned(),
            market_id: format!("{}|{}", self.up_market_id, self.down_market_id),
            received_at_ms: up.received_at_ms.min(down.received_at_ms),
            source_timestamp_ms: Some(up.source_timestamp_ms.min(down.source_timestamp_ms)),
            yes: SideOrderBook {
                bids: Vec::new(),
                asks: vec![self.screening_level(up.yes_ask_micro_usd)?],
            },
            no: SideOrderBook {
                bids: Vec::new(),
                asks: vec![self.screening_level(down.yes_ask_micro_usd)?],
            },
        }))
    }

    fn screening_level(&self, price_micro_usd: Micro) -> Result<BookLevel, JupiterError> {
        if price_micro_usd <= 0 || price_micro_usd >= ONE_USD_MICRO {
            return Err(invalid(format!(
                "invalid screening price {price_micro_usd}"
            )));
        }
        let quantity = ceil_divide(
            self.screening_gross_micro_usd
                .checked_mul(ONE_USD_MICRO)
                .ok_or_else(|| invalid("screening quantity overflow"))?,
            price_micro_usd,
        )?;
        let aligned = ((quantity + 9_999) / 10_000) * 10_000;
        Ok(BookLevel::new(price_micro_usd, aligned).fee_included())
    }
}

#[must_use]
pub fn spawn_price_stream(
    market_ids: Vec<String>,
    websocket_url: Option<String>,
) -> mpsc::Receiver<Result<JupiterPriceUpdate, JupiterError>> {
    let (sender, receiver) = mpsc::channel(128);
    tokio::spawn(async move {
        let unique = market_ids.into_iter().filter(|id| !id.is_empty()).fold(
            Vec::<String>::new(),
            |mut ids, id| {
                if !ids.contains(&id) {
                    ids.push(id);
                }
                ids
            },
        );
        if unique.is_empty() {
            let _ = sender
                .send(Err(invalid("price stream needs a market ID")))
                .await;
            return;
        }
        let url = websocket_url.unwrap_or_else(|| DEFAULT_PRICE_WEBSOCKET_URL.to_owned());
        let mut attempt = 0_u32;
        while !sender.is_closed() {
            attempt = attempt.saturating_add(1);
            match run_price_stream_once(&url, &unique, &sender).await {
                Ok(()) if sender.is_closed() => break,
                Ok(()) => {}
                Err(error) => {
                    if sender.send(Err(error)).await.is_err() {
                        break;
                    }
                }
            }
            let exponent = attempt.min(5);
            let delay = Duration::from_millis(500_u64.saturating_mul(1_u64 << exponent));
            tokio::time::sleep(delay.min(Duration::from_secs(15))).await;
        }
    });
    receiver
}

async fn run_price_stream_once(
    url: &str,
    market_ids: &[String],
    sender: &mpsc::Sender<Result<JupiterPriceUpdate, JupiterError>>,
) -> Result<(), JupiterError> {
    let (socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| invalid(format!("price WebSocket connect failed: {error}")))?;
    let (mut write, mut read) = socket.split();
    write
        .send(Message::Text(
            json!({ "type": "subscribe", "marketIds": market_ids })
                .to_string()
                .into(),
        ))
        .await
        .map_err(|error| invalid(format!("price WebSocket subscribe failed: {error}")))?;
    while let Some(message) = read.next().await {
        let message =
            message.map_err(|error| invalid(format!("price WebSocket read failed: {error}")))?;
        let Message::Text(text) = message else {
            continue;
        };
        let payload: Value = serde_json::from_str(&text)
            .map_err(|error| invalid(format!("price WebSocket JSON is invalid: {error}")))?;
        if let Some(update) = parse_price_update(&payload, market_ids)?
            && sender.send(Ok(update)).await.is_err()
        {
            return Ok(());
        }
    }
    Err(invalid("price WebSocket closed"))
}

fn parse_price_update(
    payload: &Value,
    market_ids: &[String],
) -> Result<Option<JupiterPriceUpdate>, JupiterError> {
    let Some(value) = payload.as_object() else {
        return Ok(None);
    };
    if text(value, "type") != "price" {
        return Ok(None);
    }
    let market_id = text(value, "ticker");
    if market_id.is_empty() || !market_ids.iter().any(|expected| expected == market_id) {
        return Ok(None);
    }
    let source_timestamp_ms = value
        .get("ts")
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("ts")
                .and_then(Value::as_u64)
                .and_then(|value| i64::try_from(value).ok())
        })
        .ok_or_else(|| invalid("price update has invalid timestamp"))?;
    Ok(Some(JupiterPriceUpdate {
        market_id: market_id.to_owned(),
        source_timestamp_ms,
        received_at_ms: unix_timestamp_ms(),
        yes_bid_micro_usd: stream_price(value.get("yesBidUsd"), "yesBidUsd")?,
        yes_ask_micro_usd: stream_price(value.get("yesAskUsd"), "yesAskUsd")?,
        no_bid_micro_usd: stream_price(value.get("noBidUsd"), "noBidUsd")?,
        no_ask_micro_usd: stream_price(value.get("noAskUsd"), "noAskUsd")?,
    }))
}

fn stream_price(value: Option<&Value>, field: &str) -> Result<Micro, JupiterError> {
    let price = optional_unsigned_micro(value)
        .ok_or_else(|| invalid(format!("price update has invalid {field}")))?;
    if !(0..=ONE_USD_MICRO).contains(&price) {
        return Err(invalid(format!("price update has out-of-range {field}")));
    }
    Ok(price)
}

#[derive(Clone)]
pub struct JupiterClientOptions {
    pub base_url: String,
    pub api_key: Option<String>,
    pub minimum_request_interval: Option<Duration>,
    pub request_scheduler: Option<JupiterRequestScheduler>,
    pub request_priority: RequestPriority,
}

#[derive(Clone, Debug)]
pub struct DiscoveryOptions {
    pub provider: String,
    pub category: String,
    pub subcategory: Option<String>,
    pub filter: Option<String>,
    pub tag: Option<String>,
    pub sort_by: Option<String>,
    pub sort_direction: Option<String>,
    pub max_events: usize,
    pub page_size: usize,
}

impl DiscoveryOptions {
    #[must_use]
    pub fn forecast_btc() -> Self {
        Self {
            provider: "bisonfi".to_owned(),
            category: "crypto".to_owned(),
            subcategory: Some("btc".to_owned()),
            filter: Some("live".to_owned()),
            tag: None,
            sort_by: Some("beginAt".to_owned()),
            sort_direction: Some("desc".to_owned()),
            max_events: 20,
            page_size: 20,
        }
    }
}

impl Default for JupiterClientOptions {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_PREDICTION_URL.to_owned(),
            api_key: None,
            minimum_request_interval: None,
            request_scheduler: None,
            request_priority: RequestPriority::Normal,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PredictionOrderBuild {
    pub outcome_mint: Option<String>,
    pub transaction: String,
    pub blockhash: String,
    pub last_valid_block_height: u64,
    pub external_order_id: Option<String>,
    pub jupiter_swap_request_id: Option<String>,
    pub required_signers: Vec<String>,
    pub execution_endpoint: String,
    pub execution_context: Map<String, Value>,
    pub execution_model: Option<String>,
    pub settlement: Option<String>,
    pub order: PredictionOrder,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PredictionOrder {
    pub order_pubkey: Option<String>,
    pub position_pubkey: String,
    pub market_id: String,
    pub is_buy: bool,
    pub is_yes: bool,
    pub contracts_micro: Micro,
    pub new_contracts_micro: Micro,
    pub max_buy_price_micro_usd: Option<Micro>,
    pub min_sell_price_micro_usd: Option<Micro>,
    pub order_cost_micro_usd: Micro,
    pub new_average_price_micro_usd: Option<Micro>,
    pub new_size_micro_usd: Micro,
    pub payout_micro_usd: Micro,
    pub estimated_total_fee_micro_usd: Micro,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionStatus {
    Success,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PredictionExecutionResult {
    pub status: ExecutionStatus,
    pub signature: Option<String>,
    pub error: Option<String>,
    pub request_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PredictionOrderStatus {
    pub order_pubkey: Option<String>,
    pub position_pubkey: String,
    pub market_id: String,
    pub status: String,
    pub is_buy: bool,
    pub is_yes: bool,
    pub contracts_micro: Micro,
    pub filled_contracts_micro: Micro,
    pub average_fill_price_micro_usd: Micro,
    pub size_micro_usd: Micro,
    pub settled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PredictionPosition {
    pub position_pubkey: String,
    pub market_id: String,
    pub is_yes: bool,
    pub contracts_micro: Micro,
    pub total_cost_micro_usd: Micro,
    pub fees_paid_micro_usd: Micro,
    pub sell_price_micro_usd: Option<Micro>,
    pub claimable: bool,
    pub claimed: bool,
    pub claimed_micro_usd: Micro,
    pub result: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PredictionClaimBuild {
    pub transaction: String,
    pub blockhash: String,
    pub last_valid_block_height: u64,
    pub position_pubkey: String,
    pub contracts_micro: Micro,
    pub payout_micro_usd: Micro,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JupiterClaim {
    pub transaction_signature: String,
    pub payout_micro_usd: Micro,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JupiterRentReclaim {
    pub transaction_signatures: Vec<String>,
    pub reclaimed_lamports: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapOrder {
    pub transaction: String,
    pub request_id: String,
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: Micro,
    pub out_amount: Micro,
    pub other_amount_threshold: Micro,
    pub swap_mode: String,
    pub slippage_bps: Option<u64>,
    pub price_impact: Option<String>,
    pub fee_bps: Option<u64>,
    pub signature_fee_lamports: Option<u64>,
    pub prioritization_fee_lamports: Option<u64>,
    pub rent_fee_lamports: Option<u64>,
    pub last_valid_block_height: u64,
    pub router: String,
    pub mode: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapExecution {
    pub status: ExecutionStatus,
    pub signature: Option<String>,
    pub code: i64,
    pub total_input_amount: Micro,
    pub total_output_amount: Micro,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct SwapClientOptions {
    pub base_url: String,
    pub api_key: Option<String>,
    pub minimum_request_interval: Option<Duration>,
    pub request_scheduler: Option<JupiterRequestScheduler>,
    pub request_priority: RequestPriority,
}

impl Default for SwapClientOptions {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_SWAP_URL.to_owned(),
            api_key: None,
            minimum_request_interval: None,
            request_scheduler: None,
            request_priority: RequestPriority::Critical,
        }
    }
}

#[derive(Clone)]
pub struct JupiterSwapClient {
    base_url: String,
    http: HttpClient,
    minimum_request_interval: Duration,
    scheduler: Option<JupiterRequestScheduler>,
    priority: RequestPriority,
    last_local_request: Arc<Mutex<Option<tokio::time::Instant>>>,
    last_execute_request: Arc<Mutex<Option<tokio::time::Instant>>>,
    authenticated: bool,
}

impl JupiterSwapClient {
    pub fn new(options: SwapClientOptions) -> Result<Self, JupiterError> {
        let mut http_options = HttpClientOptions::default();
        if let Some(ref key) = options.api_key {
            http_options
                .default_headers
                .insert("x-api-key".to_owned(), key.clone());
        }
        let minimum_request_interval = options.minimum_request_interval.unwrap_or_else(|| {
            if options.api_key.is_some() {
                Duration::from_millis(100)
            } else {
                Duration::from_millis(2_100)
            }
        });
        Ok(Self {
            base_url: options.base_url.trim_end_matches('/').to_owned(),
            http: HttpClient::new(&http_options)?,
            minimum_request_interval,
            scheduler: options.request_scheduler,
            priority: options.request_priority,
            last_local_request: Arc::new(Mutex::new(None)),
            last_execute_request: Arc::new(Mutex::new(None)),
            authenticated: options.api_key.is_some(),
        })
    }

    pub async fn create_order(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: Micro,
        taker: Option<&str>,
        slippage_bps: Option<u64>,
    ) -> Result<SwapOrder, JupiterError> {
        if amount <= 0 {
            return Err(invalid("Swap V2 amount must be positive"));
        }
        let mut url = Url::parse(&format!("{}/order", self.base_url))
            .map_err(|error| JupiterError::InvalidUrl(error.to_string()))?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("inputMint", input_mint)
                .append_pair("outputMint", output_mint)
                .append_pair("amount", &amount.to_string());
            if let Some(taker) = taker {
                query.append_pair("taker", taker);
            }
            // Omission selects Jupiter's RTSE. A hardcoded manual slippage value
            // caused avoidable 6001 failures on fast Forecast pools.
            if let Some(slippage_bps) = slippage_bps {
                query.append_pair("slippageBps", &slippage_bps.to_string());
            }
        }
        self.reserve().await?;
        let payload: Value = self.http.get_json(url.as_str()).await?;
        parse_swap_order(&payload, input_mint, output_mint)
    }

    pub async fn execute(
        &self,
        signed_transaction: &str,
        request_id: &str,
    ) -> Result<SwapExecution, JupiterError> {
        // Swap V2 /execute has a dedicated bucket (100 RPS for paid plans),
        // separate from the shared /order and discovery bucket. Do not make a
        // fresh executable order wait behind quote traffic.
        self.reserve_execute().await;
        let payload: Value = self
            .http
            .post_json(
                &format!("{}/execute", self.base_url),
                &json!({
                    "signedTransaction": signed_transaction,
                    "requestId": request_id,
                }),
            )
            .await?;
        parse_swap_execution(&payload)
    }

    async fn reserve_execute(&self) {
        let minimum_interval = if self.authenticated {
            Duration::from_millis(10)
        } else {
            Duration::from_millis(50)
        };
        let mut last = self.last_execute_request.lock().await;
        if let Some(previous) = *last {
            let wait = minimum_interval.saturating_sub(previous.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        *last = Some(tokio::time::Instant::now());
    }

    async fn reserve(&self) -> Result<(), JupiterError> {
        if let Some(scheduler) = &self.scheduler {
            scheduler.wait(self.priority).await?;
            return Ok(());
        }
        let mut last = self.last_local_request.lock().await;
        if let Some(previous) = *last {
            let wait = self
                .minimum_request_interval
                .saturating_sub(previous.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        *last = Some(tokio::time::Instant::now());
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedJupiterSubmission {
    pub build: PredictionOrderBuild,
    pub signed_transaction: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubmittedJupiterOrder {
    pub transaction_signature: String,
    pub submission_started_at_ms: i64,
    pub status: PredictionOrderStatus,
}

#[derive(Debug)]
pub enum JupiterError {
    Http(HttpError),
    Scheduler(SchedulerError),
    InvalidUrl(String),
    InvalidResponse(String),
    Solana(SolanaError),
    ExecutionFailed(String),
    AmbiguousExecution(String),
}

impl fmt::Display for JupiterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(error) => error.fmt(formatter),
            Self::Scheduler(error) => error.fmt(formatter),
            Self::InvalidUrl(error) => write!(formatter, "Invalid Jupiter URL: {error}"),
            Self::InvalidResponse(error) => write!(formatter, "Invalid Jupiter response: {error}"),
            Self::Solana(error) => error.fmt(formatter),
            Self::ExecutionFailed(error) => write!(formatter, "Jupiter execution failed: {error}"),
            Self::AmbiguousExecution(error) => {
                write!(formatter, "Ambiguous Jupiter execution: {error}")
            }
        }
    }
}

impl std::error::Error for JupiterError {}

impl From<HttpError> for JupiterError {
    fn from(error: HttpError) -> Self {
        Self::Http(error)
    }
}

impl From<SchedulerError> for JupiterError {
    fn from(error: SchedulerError) -> Self {
        Self::Scheduler(error)
    }
}

impl From<SolanaError> for JupiterError {
    fn from(error: SolanaError) -> Self {
        Self::Solana(error)
    }
}

#[derive(Clone)]
pub struct JupiterClient {
    base_url: String,
    http: HttpClient,
    minimum_request_interval: Duration,
    scheduler: Option<JupiterRequestScheduler>,
    priority: RequestPriority,
    last_local_request: Arc<Mutex<Option<tokio::time::Instant>>>,
}

impl JupiterClient {
    /// Creates a pooled developer-tier Prediction client.
    ///
    /// # Errors
    ///
    /// Fails when the API key is not a valid HTTP header or TLS setup fails.
    pub fn new(options: JupiterClientOptions) -> Result<Self, JupiterError> {
        let mut http_options = HttpClientOptions::default();
        if let Some(ref key) = options.api_key {
            http_options
                .default_headers
                .insert("x-api-key".to_owned(), key.clone());
        }
        let interval = options.minimum_request_interval.unwrap_or_else(|| {
            if options.api_key.is_some() {
                // Jupiter's Developer plan permits 10 requests per second.
                Duration::from_millis(100)
            } else {
                Duration::from_millis(2_100)
            }
        });
        Ok(Self {
            base_url: options.base_url.trim_end_matches('/').to_owned(),
            http: HttpClient::new(&http_options)?,
            minimum_request_interval: interval,
            scheduler: options.request_scheduler,
            priority: options.request_priority,
            last_local_request: Arc::new(Mutex::new(None)),
        })
    }

    pub async fn get_trading_status(&self) -> Result<bool, JupiterError> {
        let payload = self.get("trading-status").await?;
        Ok(payload.get("trading_active").and_then(Value::as_bool) == Some(true))
    }

    pub async fn get_markets(
        &self,
        options: &DiscoveryOptions,
    ) -> Result<Vec<VenueMarket>, JupiterError> {
        let mut markets = Vec::new();
        let mut start = 0_usize;
        let page_size = options.page_size.max(1).min(options.max_events.max(1));
        while start < options.max_events {
            let end = (start + page_size).min(options.max_events);
            let mut url = Url::parse(&format!("{}/events", self.base_url))
                .map_err(|error| JupiterError::InvalidUrl(error.to_string()))?;
            {
                let mut query = url.query_pairs_mut();
                query
                    .append_pair("provider", &options.provider)
                    .append_pair("category", &options.category)
                    .append_pair("includeMarkets", "true")
                    .append_pair("start", &start.to_string())
                    .append_pair("end", &end.to_string());
                for (name, value) in [
                    ("subcategory", options.subcategory.as_deref()),
                    ("filter", options.filter.as_deref()),
                    ("tag", options.tag.as_deref()),
                    ("sortBy", options.sort_by.as_deref()),
                    ("sortDirection", options.sort_direction.as_deref()),
                ] {
                    if let Some(value) = value {
                        query.append_pair(name, value);
                    }
                }
            }
            self.reserve().await?;
            let payload: Value = self.http.get_json(url.as_str()).await?;
            let value = object(&payload, "events response")?;
            for event in value
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                markets.extend(parse_jupiter_event(event)?);
            }
            let has_next = value
                .get("pagination")
                .and_then(Value::as_object)
                .and_then(|pagination| pagination.get("hasNext"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !has_next {
                break;
            }
            start = end;
        }
        Ok(markets)
    }

    pub async fn get_market(&self, market_id: &str) -> Result<VenueMarket, JupiterError> {
        let payload = self.get(&format!("markets/{market_id}")).await?;
        parse_jupiter_market(&payload, None, "")
    }

    pub async fn did_selected_market_win(
        &self,
        market_id: &str,
    ) -> Result<Option<bool>, JupiterError> {
        let payload = self.get(&format!("markets/{market_id}")).await?;
        let value = object(&payload, "market")?;
        Ok(match text(value, "result").to_ascii_lowercase().as_str() {
            "yes" => Some(true),
            "no" => Some(false),
            _ => None,
        })
    }

    pub async fn create_prediction_buy_order(
        &self,
        owner_pubkey: &str,
        market_id: &str,
        is_yes: bool,
        deposit_amount_micro_usd: Micro,
        deposit_mint: Option<&str>,
    ) -> Result<PredictionOrderBuild, JupiterError> {
        let payload = self
            .send(
                Method::POST,
                "orders",
                &json!({
                    "isBuy": true,
                    "ownerPubkey": owner_pubkey,
                    "marketId": market_id,
                    "isYes": is_yes,
                    "depositAmount": deposit_amount_micro_usd.to_string(),
                    "depositMint": deposit_mint.unwrap_or(USDC_MINT),
                }),
            )
            .await?;
        parse_order_build(&payload)
    }

    pub async fn create_prediction_close_order(
        &self,
        owner_pubkey: &str,
        position_pubkey: &str,
    ) -> Result<PredictionOrderBuild, JupiterError> {
        let payload = self
            .send(
                Method::DELETE,
                &format!("positions/{position_pubkey}"),
                &json!({ "ownerPubkey": owner_pubkey }),
            )
            .await?;
        parse_order_build(&payload)
    }

    pub async fn execute_prediction_order(
        &self,
        signed_transaction: &str,
        context: &Map<String, Value>,
        request_id: &str,
    ) -> Result<PredictionExecutionResult, JupiterError> {
        let payload = self
            .send(
                Method::POST,
                "execute",
                &prediction_execute_body(signed_transaction, context, request_id),
            )
            .await?;
        let value = object(&payload, "execution response")?;
        let status = match text(value, "status") {
            "Success" => ExecutionStatus::Success,
            "Failed" => ExecutionStatus::Failed,
            other => return Err(invalid(format!("unsupported execution status {other}"))),
        };
        Ok(PredictionExecutionResult {
            status,
            signature: optional_text(value, "signature"),
            error: optional_text(value, "error"),
            request_id: optional_text(value, "requestId").unwrap_or_else(|| request_id.to_owned()),
        })
    }

    pub async fn get_prediction_order(
        &self,
        order_pubkey: &str,
    ) -> Result<PredictionOrderStatus, JupiterError> {
        let payload = self.get(&format!("orders/{order_pubkey}")).await?;
        let value = object(&payload, "order")?;
        parse_prediction_order(value, order_pubkey)
    }

    pub async fn get_prediction_order_status(
        &self,
        order_pubkey: &str,
    ) -> Result<String, JupiterError> {
        let payload = self.get(&format!("orders/status/{order_pubkey}")).await?;
        let value = object(&payload, "order status")?;
        normalize_prediction_order_status(text(value, "status"))
    }

    pub async fn get_prediction_order_for_owner(
        &self,
        owner_pubkey: &str,
        order_pubkey: &str,
    ) -> Result<Option<PredictionOrderStatus>, JupiterError> {
        let mut url = self.url("orders")?;
        url.query_pairs_mut()
            .append_pair("ownerPubkey", owner_pubkey)
            .append_pair("start", "0")
            .append_pair("end", "100");
        self.reserve().await?;
        let payload: Value = self.http.get_json(url.as_str()).await?;
        let value = object(&payload, "orders response")?;
        value
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|order| order.get("pubkey").and_then(Value::as_str) == Some(order_pubkey))
            .map(|order| {
                object(order, "order history")
                    .and_then(|order| parse_prediction_order(order, order_pubkey))
            })
            .transpose()
    }

    pub async fn get_prediction_position(
        &self,
        position_pubkey: &str,
    ) -> Result<PredictionPosition, JupiterError> {
        let payload = self.get(&format!("positions/{position_pubkey}")).await?;
        let value = object(&payload, "position")?;
        let result = value
            .get("marketMetadata")
            .and_then(Value::as_object)
            .and_then(|metadata| optional_text(metadata, "result"))
            .map(|result| result.to_ascii_lowercase())
            .filter(|result| matches!(result.as_str(), "yes" | "no" | "pending"));
        Ok(PredictionPosition {
            position_pubkey: optional_text(value, "pubkey")
                .unwrap_or_else(|| position_pubkey.to_owned()),
            market_id: text(value, "marketId").to_owned(),
            is_yes: boolean(value, "isYes"),
            contracts_micro: position_contracts(value)?,
            total_cost_micro_usd: required_micro(value.get("totalCostUsd"), "totalCostUsd")?,
            fees_paid_micro_usd: required_micro(value.get("feesPaidUsd"), "feesPaidUsd")?,
            sell_price_micro_usd: optional_micro(value.get("sellPriceUsd")),
            claimable: boolean(value, "claimable"),
            claimed: boolean(value, "claimed"),
            claimed_micro_usd: optional_micro(value.get("claimedUsd")).unwrap_or(0),
            result,
        })
    }

    pub async fn create_prediction_claim(
        &self,
        owner_pubkey: &str,
        position_pubkey: &str,
    ) -> Result<PredictionClaimBuild, JupiterError> {
        let payload = self
            .send(
                Method::POST,
                &format!("positions/{position_pubkey}/claim"),
                &json!({ "ownerPubkey": owner_pubkey }),
            )
            .await?;
        parse_claim_build(&payload)
    }

    pub async fn get_order_book(
        &self,
        market_id: &str,
        provider: &str,
    ) -> Result<BinaryOrderBook, JupiterError> {
        let payload = self.get(&format!("orderbook/{market_id}")).await?;
        let value = object(&payload, "orderbook")?;
        let mut yes_bids = parse_levels(value.get("yes_dollars"))?;
        let mut no_bids = parse_levels(value.get("no_dollars"))?;
        if yes_bids.is_empty() && no_bids.is_empty() {
            return Err(invalid(format!(
                "orderbook {market_id} has no exact levels"
            )));
        }
        let mut yes_asks = complement(&no_bids);
        let mut no_asks = complement(&yes_bids);
        yes_bids.sort_unstable_by(|left, right| right.price_micro_usd.cmp(&left.price_micro_usd));
        no_bids.sort_unstable_by(|left, right| right.price_micro_usd.cmp(&left.price_micro_usd));
        yes_asks.sort_unstable_by_key(|level| level.price_micro_usd);
        no_asks.sort_unstable_by_key(|level| level.price_micro_usd);
        Ok(BinaryOrderBook {
            venue: Venue::Jupiter,
            provider: provider.to_owned(),
            market_id: market_id.to_owned(),
            received_at_ms: unix_timestamp_ms(),
            source_timestamp_ms: None,
            yes: SideOrderBook {
                bids: yes_bids,
                asks: yes_asks,
            },
            no: SideOrderBook {
                bids: no_bids,
                asks: no_asks,
            },
        })
    }

    async fn get(&self, path: &str) -> Result<Value, JupiterError> {
        let url = self.url(path)?;
        self.reserve().await?;
        Ok(self.http.get_json(url.as_str()).await?)
    }

    async fn send<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: &B,
    ) -> Result<Value, JupiterError> {
        let url = self.url(path)?;
        self.reserve().await?;
        match method {
            Method::POST => Ok(self.http.post_json(url.as_str(), body).await?),
            Method::DELETE => Ok(self.http.delete_json(url.as_str(), body).await?),
            _ => Err(invalid("unsupported request method")),
        }
    }

    async fn reserve(&self) -> Result<(), JupiterError> {
        // Signed transaction handoff is latency critical and uses a Critical
        // client, but it still belongs to the Developer key's shared 10 RPS
        // bucket. Critical requests jump queued Normal discovery work.
        if let Some(scheduler) = &self.scheduler {
            scheduler.wait(self.priority).await?;
            return Ok(());
        }
        let mut last = self.last_local_request.lock().await;
        if let Some(previous) = *last {
            let wait = self
                .minimum_request_interval
                .saturating_sub(previous.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        *last = Some(tokio::time::Instant::now());
        Ok(())
    }

    fn url(&self, path: &str) -> Result<Url, JupiterError> {
        Url::parse(&format!("{}/{path}", self.base_url))
            .map_err(|error| JupiterError::InvalidUrl(error.to_string()))
    }
}

pub struct JupiterPredictionExecutor {
    client: JupiterClient,
    rpc: SolanaRpc,
    keypair: Keypair,
}

impl JupiterPredictionExecutor {
    pub fn new(
        client: JupiterClient,
        rpc_url: &str,
        private_key: &str,
    ) -> Result<Self, JupiterError> {
        Ok(Self {
            client,
            rpc: SolanaRpc::new(rpc_url)?,
            keypair: parse_keypair(private_key)?,
        })
    }

    #[must_use]
    pub fn owner_pubkey(&self) -> String {
        self.keypair.pubkey().to_string()
    }

    pub async fn assert_ready(
        &self,
        minimum_usdc_micro: Micro,
    ) -> Result<jupol_solana::WalletBalances, JupiterError> {
        if !self.client.get_trading_status().await? {
            return Err(JupiterError::ExecutionFailed(
                "Prediction trading is not active".to_owned(),
            ));
        }
        let balances = self
            .rpc
            .wallet_balances(&self.keypair.pubkey(), USDC_MINT)
            .await?;
        if balances.sol_lamports < 1_000_000 {
            return Err(JupiterError::ExecutionFailed(
                "wallet needs at least 0.001 SOL for fees and rent".to_owned(),
            ));
        }
        if balances.usdc_micro < minimum_usdc_micro {
            return Err(JupiterError::ExecutionFailed(format!(
                "wallet USDC {} is below required {minimum_usdc_micro} micro-USDC",
                balances.usdc_micro
            )));
        }
        Ok(balances)
    }

    pub async fn wallet_balances(&self) -> Result<jupol_solana::WalletBalances, JupiterError> {
        Ok(self
            .rpc
            .wallet_balances(&self.keypair.pubkey(), USDC_MINT)
            .await?)
    }

    pub async fn usdc_balance(&self) -> Result<Micro, JupiterError> {
        Ok(self
            .rpc
            .get_token_balance(&self.keypair.pubkey(), USDC_MINT)
            .await?)
    }

    pub async fn token_balance(&self, mint: &str) -> Result<Micro, JupiterError> {
        Ok(self
            .rpc
            .get_token_balance(&self.keypair.pubkey(), mint)
            .await?)
    }

    pub async fn get_position(
        &self,
        position_pubkey: &str,
    ) -> Result<PredictionPosition, JupiterError> {
        self.client.get_prediction_position(position_pubkey).await
    }

    pub async fn get_order_status(
        &self,
        order_pubkey: &str,
    ) -> Result<PredictionOrderStatus, JupiterError> {
        let status = self
            .client
            .get_prediction_order_status(order_pubkey)
            .await?;
        Ok(PredictionOrderStatus {
            order_pubkey: Some(order_pubkey.to_owned()),
            position_pubkey: String::new(),
            market_id: String::new(),
            status,
            is_buy: false,
            is_yes: false,
            contracts_micro: 0,
            filled_contracts_micro: 0,
            average_fill_price_micro_usd: 0,
            size_micro_usd: 0,
            settled: false,
        })
    }

    pub async fn did_selected_market_win(
        &self,
        market_id: &str,
    ) -> Result<Option<bool>, JupiterError> {
        self.client.did_selected_market_win(market_id).await
    }

    pub async fn prepare_buy(
        &self,
        market_id: &str,
        is_yes: bool,
        deposit_amount_micro_usd: Micro,
        outcome_mint: Option<&str>,
    ) -> Result<PredictionOrderBuild, JupiterError> {
        let mut build = self
            .client
            .create_prediction_buy_order(
                &self.owner_pubkey(),
                market_id,
                is_yes,
                deposit_amount_micro_usd,
                Some(USDC_MINT),
            )
            .await?;
        if !build.order.is_buy || build.order.is_yes != is_yes || build.order.market_id != market_id
        {
            return Err(invalid(
                "Prediction API built an order for an unexpected market or side",
            ));
        }
        build.outcome_mint = outcome_mint.map(str::to_owned);
        Ok(build)
    }

    pub async fn prepare_close(
        &self,
        position_pubkey: &str,
    ) -> Result<PredictionOrderBuild, JupiterError> {
        let build = self
            .client
            .create_prediction_close_order(&self.owner_pubkey(), position_pubkey)
            .await?;
        if build.order.is_buy || build.order.position_pubkey != position_pubkey {
            return Err(invalid(
                "Prediction API built a close for an unexpected position",
            ));
        }
        Ok(build)
    }

    pub async fn claim_position(
        &self,
        position_pubkey: &str,
        expected_payout_micro_usd: Micro,
        timeout: Duration,
    ) -> Result<JupiterClaim, JupiterError> {
        let position = self.get_position(position_pubkey).await?;
        if position.claimed {
            return Ok(JupiterClaim {
                transaction_signature: "already-claimed".to_owned(),
                payout_micro_usd: position.claimed_micro_usd,
            });
        }
        if !position.claimable {
            return Err(JupiterError::ExecutionFailed(format!(
                "position {position_pubkey} is not claimable"
            )));
        }
        let expected_payout_micro_usd = if expected_payout_micro_usd > 0 {
            expected_payout_micro_usd
        } else {
            position.contracts_micro
        };
        let before_usdc = self.wallet_balances().await?.usdc_micro;
        let build = self
            .client
            .create_prediction_claim(&self.owner_pubkey(), position_pubkey)
            .await?;
        if build.position_pubkey != position_pubkey {
            return Err(invalid("claim build targets an unexpected position"));
        }
        let tolerance = 10_000.max(expected_payout_micro_usd / 1_000);
        if (build.contracts_micro - position.contracts_micro).abs() > tolerance
            || (build.payout_micro_usd - expected_payout_micro_usd).abs() > tolerance
        {
            return Err(invalid(format!(
                "claim build quantity/payout changed: contracts={}, payout={}, expected={expected_payout_micro_usd}",
                build.contracts_micro, build.payout_micro_usd
            )));
        }
        let signed = sign_versioned_transaction(&build.transaction, &self.keypair)?;
        self.rpc.simulate_transaction(&signed).await?;
        let signature = self.rpc.send_transaction(&signed).await?;
        self.rpc.confirm_transaction(&signature, timeout).await?;
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(transaction) = self.rpc.get_transaction(&signature).await?
                && transaction.pointer("/meta/err").is_none_or(Value::is_null)
            {
                let deltas = jupol_solana::parse_token_deltas(
                    &transaction,
                    &self.owner_pubkey(),
                    &[USDC_MINT],
                )?;
                if let Some(usdc) = deltas.iter().find(|delta| delta.mint == USDC_MINT) {
                    let credit = usdc.after.saturating_sub(usdc.before);
                    if credit > 0 && (credit - expected_payout_micro_usd).abs() <= tolerance {
                        return Ok(JupiterClaim {
                            transaction_signature: signature,
                            payout_micro_usd: credit,
                        });
                    }
                }
            }
            let after_usdc = self.wallet_balances().await?.usdc_micro;
            let credit = after_usdc.saturating_sub(before_usdc);
            let claimed = self.get_position(position_pubkey).await?;
            if claimed.claimed
                && credit > 0
                && (credit - expected_payout_micro_usd).abs() <= tolerance
            {
                return Ok(JupiterClaim {
                    transaction_signature: signature,
                    payout_micro_usd: credit,
                });
            }
            if Instant::now() >= deadline {
                return Err(JupiterError::AmbiguousExecution(format!(
                    "claim {signature} confirmed but no matching owned USDC credit was observed; expected {expected_payout_micro_usd}, wallet delta {credit}, claimedUsd {}",
                    claimed.claimed_micro_usd
                )));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub fn prepare_submission(
        &self,
        build: PredictionOrderBuild,
    ) -> Result<PreparedJupiterSubmission, JupiterError> {
        validate_required_signers(&build, &self.owner_pubkey())?;
        if !build.execution_endpoint.is_empty() && !build.execution_endpoint.ends_with("/execute") {
            return Err(invalid(format!(
                "unsupported execution endpoint {}",
                build.execution_endpoint
            )));
        }
        let signed_transaction = sign_versioned_transaction(&build.transaction, &self.keypair)?;
        // Jupiter's /execute endpoint submits the signed transaction and
        // returns an authoritative execution result. A separate local RPC
        // simulation adds latency and can reject a valid handoff solely because
        // the configured RPC is rate-limited. Atomic fills retain their
        // post-execute on-chain delta audit below.
        Ok(PreparedJupiterSubmission {
            build,
            signed_transaction,
        })
    }

    pub async fn submit_prepared_and_wait(
        &self,
        prepared: PreparedJupiterSubmission,
        timeout: Duration,
    ) -> Result<SubmittedJupiterOrder, JupiterError> {
        let submission_started_at_ms = unix_timestamp_ms();
        let request_id = prediction_execution_request_id(&prepared.build)?;
        let execution = self
            .client
            .execute_prediction_order(
                &prepared.signed_transaction,
                &prepared.build.execution_context,
                &request_id,
            )
            .await
            .map_err(|error| {
                if definitive_http_rejection(&error) {
                    JupiterError::ExecutionFailed(format!(
                        "Prediction /execute request {request_id} was rejected before broadcast: {error}"
                    ))
                } else {
                    JupiterError::AmbiguousExecution(format!(
                        "Prediction /execute request {request_id} returned no authoritative state: {error}"
                    ))
                }
            })?;
        if execution.status != ExecutionStatus::Success || execution.signature.is_none() {
            return Err(JupiterError::ExecutionFailed(format!(
                "request {} status={:?} error={}",
                execution.request_id,
                execution.status,
                execution.error.as_deref().unwrap_or("missing signature")
            )));
        }
        let Some(signature) = execution.signature.clone() else {
            return Err(JupiterError::ExecutionFailed(
                "successful Prediction execution omitted its signature".to_owned(),
            ));
        };
        let status = if prepared.build.execution_model.as_deref() == Some("atomic_swap") {
            // Atomic Prediction builds do not return authoritative token
            // amounts from /execute, so retain the on-chain delta audit.
            self.rpc.confirm_transaction(&signature, timeout).await?;
            self.reconcile_atomic(&prepared.build, &signature, timeout)
                .await?
        } else {
            let order_pubkey = prepared
                .build
                .order
                .order_pubkey
                .as_deref()
                .ok_or_else(|| invalid("keeper order has no order pubkey"))?;
            // Prediction /execute already performs landing and confirmation.
            // Poll the documented status/history APIs instead of spending a
            // second RPC confirmation budget and then querying /orders/{id},
            // which returns 400 after a filled order account is closed.
            self.wait_for_order(&prepared.build, order_pubkey, timeout)
                .await?
        };
        if status.status == "pending" {
            return Err(JupiterError::AmbiguousExecution(format!(
                "Prediction keeper order {} remains pending after confirmation timeout",
                status.order_pubkey.as_deref().unwrap_or("unknown")
            )));
        }
        Ok(SubmittedJupiterOrder {
            transaction_signature: signature,
            submission_started_at_ms,
            status,
        })
    }

    pub async fn wait_for_order(
        &self,
        build: &PredictionOrderBuild,
        order_pubkey: &str,
        timeout: Duration,
    ) -> Result<PredictionOrderStatus, JupiterError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match self.client.get_prediction_order_status(order_pubkey).await {
                Ok(status) if status == "pending" => {}
                Ok(_) => {
                    if let Some(status) = self
                        .client
                        .get_prediction_order_for_owner(&self.owner_pubkey(), order_pubkey)
                        .await?
                    {
                        return Ok(status);
                    }
                }
                Err(error) if is_http_not_found(&error) => {
                    // The documented API can return "no order history found"
                    // for a few slots immediately after submission.
                }
                Err(error) => return Err(error),
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(PredictionOrderStatus {
                    order_pubkey: Some(order_pubkey.to_owned()),
                    position_pubkey: build.order.position_pubkey.clone(),
                    market_id: build.order.market_id.clone(),
                    status: "pending".to_owned(),
                    is_buy: build.order.is_buy,
                    is_yes: build.order.is_yes,
                    contracts_micro: build.order.contracts_micro,
                    filled_contracts_micro: 0,
                    average_fill_price_micro_usd: 0,
                    size_micro_usd: 0,
                    settled: false,
                });
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn reconcile_atomic(
        &self,
        build: &PredictionOrderBuild,
        signature: &str,
        timeout: Duration,
    ) -> Result<PredictionOrderStatus, JupiterError> {
        let outcome_mint = build.outcome_mint.as_deref().ok_or_else(|| {
            invalid("atomic Prediction fill cannot be reconciled without outcomeMint")
        })?;
        let deltas = self
            .rpc
            .wait_for_token_deltas(
                signature,
                &self.keypair.pubkey(),
                &[USDC_MINT, outcome_mint],
                timeout,
            )
            .await?;
        reconcile_token_deltas(build, &deltas)
    }
}

pub struct JupiterForecastSwapExecutor {
    client: JupiterSwapClient,
    rpc: SolanaRpc,
    keypair: Keypair,
    slippage_bps: Option<u64>,
}

/// Builds wallet-specific executable Forecast orders without holding signing
/// authority. This is suitable for continuously using Swap V2 `/order` as an
/// Low-overhead price discovery quoter for Forecast markets. It prepares an
/// executable price feed: only the selected build is later signed by the live
/// executor (or pre-signed immediately if keypair is available).
#[derive(Clone)]
pub struct JupiterForecastSwapQuoter {
    client: JupiterSwapClient,
    owner_pubkey: String,
    keypair: Option<Arc<Keypair>>,
    slippage_bps: Option<u64>,
}

impl JupiterForecastSwapQuoter {
    pub fn new(
        client: JupiterSwapClient,
        owner_pubkey: impl Into<String>,
        slippage_bps: Option<u64>,
    ) -> Result<Self, JupiterError> {
        let owner_pubkey = owner_pubkey.into();
        owner_pubkey
            .parse::<solana_sdk::pubkey::Pubkey>()
            .map_err(|error| invalid(format!("invalid Jupiter taker public key: {error}")))?;
        Ok(Self {
            client,
            owner_pubkey,
            keypair: None,
            slippage_bps,
        })
    }

    pub fn from_private_key(
        client: JupiterSwapClient,
        private_key: &str,
        slippage_bps: Option<u64>,
    ) -> Result<Self, JupiterError> {
        let keypair = parse_keypair(private_key)?;
        let owner_pubkey = keypair.pubkey().to_string();
        Ok(Self {
            client,
            owner_pubkey,
            keypair: Some(Arc::new(keypair)),
            slippage_bps,
        })
    }

    #[must_use]
    pub fn owner_pubkey(&self) -> &str {
        &self.owner_pubkey
    }

    pub fn prepare_submission(
        &self,
        build: PredictionOrderBuild,
    ) -> Result<PreparedJupiterSubmission, JupiterError> {
        let keypair = self
            .keypair
            .as_ref()
            .ok_or_else(|| invalid("quoter has no keypair configured for pre-signing"))?;
        validate_required_signers(&build, &self.owner_pubkey)?;
        if build.execution_endpoint != "/swap/v2/execute" {
            return Err(invalid(format!(
                "Forecast Swap build has unsupported endpoint {}",
                build.execution_endpoint
            )));
        }
        let signed_transaction = sign_versioned_transaction(&build.transaction, keypair)?;
        Ok(PreparedJupiterSubmission {
            build,
            signed_transaction,
        })
    }

    pub async fn prepare_buy(
        &self,
        market_id: &str,
        outcome_mint: &str,
        deposit_amount_micro_usd: Micro,
    ) -> Result<PredictionOrderBuild, JupiterError> {
        let order = self
            .client
            .create_order(
                USDC_MINT,
                outcome_mint,
                deposit_amount_micro_usd,
                Some(&self.owner_pubkey),
                self.slippage_bps,
            )
            .await?;
        forecast_swap_build(order, market_id, outcome_mint, true, &self.owner_pubkey)
    }
}

impl JupiterForecastSwapExecutor {
    pub fn new(
        client: JupiterSwapClient,
        rpc_url: &str,
        private_key: &str,
        slippage_bps: Option<u64>,
    ) -> Result<Self, JupiterError> {
        Ok(Self {
            client,
            rpc: SolanaRpc::new(rpc_url)?,
            keypair: parse_keypair(private_key)?,
            slippage_bps,
        })
    }

    #[must_use]
    pub fn owner_pubkey(&self) -> String {
        self.keypair.pubkey().to_string()
    }

    pub async fn token_balance(&self, mint: &str) -> Result<Micro, JupiterError> {
        Ok(self
            .rpc
            .get_token_balance(&self.keypair.pubkey(), mint)
            .await?)
    }

    pub async fn get_position(
        &self,
        position_pubkey: &str,
    ) -> Result<PredictionPosition, JupiterError> {
        let (market_id, outcome_mint) = parse_swap_position_id(position_pubkey)?;
        Ok(PredictionPosition {
            position_pubkey: position_pubkey.to_owned(),
            market_id,
            is_yes: true,
            contracts_micro: self.token_balance(&outcome_mint).await?,
            total_cost_micro_usd: 0,
            fees_paid_micro_usd: 0,
            sell_price_micro_usd: None,
            claimable: false,
            claimed: false,
            claimed_micro_usd: 0,
            result: None,
        })
    }

    pub async fn prepare_buy(
        &self,
        market_id: &str,
        outcome_mint: &str,
        deposit_amount_micro_usd: Micro,
    ) -> Result<PredictionOrderBuild, JupiterError> {
        let order = self
            .client
            .create_order(
                USDC_MINT,
                outcome_mint,
                deposit_amount_micro_usd,
                Some(&self.owner_pubkey()),
                self.slippage_bps,
            )
            .await?;
        forecast_swap_build(order, market_id, outcome_mint, true, &self.owner_pubkey())
    }

    pub async fn prepare_sell(
        &self,
        position_pubkey: &str,
        contracts_micro: Micro,
    ) -> Result<PredictionOrderBuild, JupiterError> {
        let (market_id, outcome_mint) = parse_swap_position_id(position_pubkey)?;
        let order = self
            .client
            .create_order(
                &outcome_mint,
                USDC_MINT,
                contracts_micro,
                Some(&self.owner_pubkey()),
                self.slippage_bps,
            )
            .await?;
        forecast_swap_build(
            order,
            &market_id,
            &outcome_mint,
            false,
            &self.owner_pubkey(),
        )
    }

    pub async fn claim_position(
        &self,
        position_pubkey: &str,
        expected_payout_micro_usd: Micro,
    ) -> Result<JupiterClaim, JupiterError> {
        let (_, outcome_mint) = parse_swap_position_id(position_pubkey)?;
        let accounts = self
            .rpc
            .get_token_accounts(&self.keypair.pubkey(), &outcome_mint)
            .await?;
        let remaining = accounts.iter().try_fold(0_i128, |total, account| {
            total
                .checked_add(account.amount)
                .ok_or_else(|| invalid("Forecast token balance overflow"))
        })?;
        if remaining > 10_000 {
            return Err(JupiterError::ExecutionFailed(format!(
                "Forecast winning token {outcome_mint} has not auto-settled ({remaining} remain)"
            )));
        }
        let mut signatures = HashMap::<String, u64>::new();
        for account in &accounts {
            for record in self
                .rpc
                .get_signatures_for_address(&account.pubkey, 25)
                .await?
            {
                signatures.insert(record.signature, record.slot);
            }
        }
        let mut signatures = signatures.into_iter().collect::<Vec<_>>();
        signatures.sort_unstable_by(|left, right| right.1.cmp(&left.1));
        let tolerance = 10_000.max(expected_payout_micro_usd.max(0) / 1_000);
        for (signature, _) in signatures {
            let Some(transaction) = self.rpc.get_transaction(&signature).await? else {
                continue;
            };
            if transaction
                .pointer("/meta/err")
                .is_some_and(|error| !error.is_null())
            {
                continue;
            }
            let deltas = jupol_solana::parse_token_deltas(
                &transaction,
                &self.keypair.pubkey().to_string(),
                &[&outcome_mint, USDC_MINT],
            )?;
            let outcome = deltas.iter().find(|delta| delta.mint == outcome_mint);
            let usdc = deltas.iter().find(|delta| delta.mint == USDC_MINT);
            let (Some(outcome), Some(usdc)) = (outcome, usdc) else {
                continue;
            };
            let outcome_debit = outcome.before.saturating_sub(outcome.after);
            let usdc_credit = usdc.after.saturating_sub(usdc.before);
            if outcome_debit >= expected_payout_micro_usd.saturating_sub(tolerance).max(0)
                && usdc_credit > 0
                && (outcome_debit - usdc_credit).abs() <= tolerance
            {
                return Ok(JupiterClaim {
                    transaction_signature: signature,
                    payout_micro_usd: usdc_credit,
                });
            }
        }
        Err(JupiterError::ExecutionFailed(format!(
            "Forecast token {outcome_mint} is empty but no confirmed USDC settlement credit was found"
        )))
    }

    pub async fn reclaim_position_rent(
        &self,
        position_pubkey: &str,
        timeout: Duration,
    ) -> Result<JupiterRentReclaim, JupiterError> {
        let (_, outcome_mint) = parse_swap_position_id(position_pubkey)?;
        let accounts = self
            .rpc
            .get_token_accounts(&self.keypair.pubkey(), &outcome_mint)
            .await?;
        if accounts.iter().any(|account| account.amount > 0) {
            return Err(JupiterError::ExecutionFailed(format!(
                "Forecast token {outcome_mint} still has a non-empty token account"
            )));
        }
        let mut signatures = Vec::new();
        let mut reclaimed_lamports = 0_u64;
        for account in accounts
            .iter()
            .filter(|account| account.program_id == TOKEN_2022_PROGRAM_ID)
        {
            let (signature, lamports) = self
                .rpc
                .close_empty_token_account(account, &self.keypair, timeout)
                .await?;
            signatures.push(signature);
            reclaimed_lamports = reclaimed_lamports.saturating_add(lamports);
        }
        Ok(JupiterRentReclaim {
            transaction_signatures: signatures,
            reclaimed_lamports,
        })
    }

    pub fn prepare_submission(
        &self,
        build: PredictionOrderBuild,
    ) -> Result<PreparedJupiterSubmission, JupiterError> {
        validate_required_signers(&build, &self.owner_pubkey())?;
        if build.execution_endpoint != "/swap/v2/execute" {
            return Err(invalid(format!(
                "Forecast Swap build has unsupported endpoint {}",
                build.execution_endpoint
            )));
        }
        let signed_transaction = sign_versioned_transaction(&build.transaction, &self.keypair)?;
        Ok(PreparedJupiterSubmission {
            build,
            signed_transaction,
        })
    }

    pub async fn submit_prepared_and_wait(
        &self,
        prepared: PreparedJupiterSubmission,
        _timeout: Duration,
    ) -> Result<SubmittedJupiterOrder, JupiterError> {
        let submission_started_at_ms = unix_timestamp_ms();
        let request_id = prepared
            .build
            .execution_context
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Forecast Swap build is missing requestId"))?;

        // Concurrently dispatch the signed transaction directly to Solana RPC to minimize block-landing latency.
        let _rpc_dispatch = {
            let rpc = self.rpc.clone();
            let tx_b64 = prepared.signed_transaction.clone();
            tokio::spawn(async move {
                let _ = rpc.send_transaction_with_options(&tx_b64, true, 0).await;
            })
        };

        let mut execution = match self
            .client
            .execute(&prepared.signed_transaction, request_id)
            .await
        {
            Ok(execution) => execution,
            Err(first_error) if definitive_http_rejection(&first_error) => {
                return Err(JupiterError::ExecutionFailed(format!(
                    "Swap V2 /execute request {request_id} was rejected before broadcast: {first_error}"
                )));
            }
            Err(first_error) => {
                // One retry of the identical request resolves an ambiguous dropped
                // response. Never rebuild here: a new requestId could double-fill.
                tokio::time::sleep(Duration::from_millis(100)).await;
                self.client
                    .execute(&prepared.signed_transaction, request_id)
                    .await
                    .map_err(|second_error| {
                        JupiterError::AmbiguousExecution(format!(
                            "Swap V2 /execute failed twice for {request_id}: first={first_error}; second={second_error}"
                        ))
                    })?
            }
        };
        // A failed-to-land/unknown response is definitive about this attempt
        // but the exact same signed transaction and requestId remain
        // idempotent. Retry them in the dedicated execute bucket; never rebuild
        // here, because a new request could race the Polymarket leg.
        for _ in 0..2 {
            if execution.status == ExecutionStatus::Success
                || !matches!(execution.code, -1_000 | -1_001 | -2_000 | -2_001)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(75)).await;
            execution = self
                .client
                .execute(&prepared.signed_transaction, request_id)
                .await
                .map_err(|error| {
                    JupiterError::AmbiguousExecution(format!(
                        "Swap V2 retry returned no authoritative state for request {request_id}: {error}"
                    ))
                })?;
        }
        if execution.status != ExecutionStatus::Success
            || execution.code != 0
            || execution.signature.is_none()
        {
            let router = prepared
                .build
                .execution_context
                .get("router")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let mode = prepared
                .build
                .execution_context
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            return Err(JupiterError::ExecutionFailed(format!(
                "Swap V2 request {request_id} router={router} mode={mode} code={} error={}",
                execution.code,
                execution.error.as_deref().unwrap_or("missing signature")
            )));
        }
        let Some(signature) = execution.signature.clone() else {
            return Err(JupiterError::ExecutionFailed(
                "successful Swap V2 execution omitted its signature".to_owned(),
            ));
        };
        // /execute already performs landing, confirmation polling, and returns
        // wallet-reflected totals. Using those authoritative totals avoids two
        // latency-sensitive RPC round trips and the Helius 429 failures seen in
        // the entry logs.
        let status = reconcile_swap_execution(&prepared.build, &execution)?;
        Ok(SubmittedJupiterOrder {
            transaction_signature: signature,
            submission_started_at_ms,
            status,
        })
    }
}

pub struct JupiterHybridExecutor {
    pub prediction: JupiterPredictionExecutor,
    pub forecast: JupiterForecastSwapExecutor,
    pub prediction_minimum_buy_micro_usd: Micro,
    pub allow_subminimum_forecast_swap: bool,
}

impl JupiterHybridExecutor {
    pub fn validate(&self) -> Result<(), JupiterError> {
        if self.prediction.owner_pubkey() != self.forecast.owner_pubkey() {
            return Err(invalid(
                "Prediction and Forecast Swap executors use different owners",
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn owner_pubkey(&self) -> String {
        self.prediction.owner_pubkey()
    }

    pub async fn assert_ready(
        &self,
        minimum_usdc_micro: Micro,
    ) -> Result<jupol_solana::WalletBalances, JupiterError> {
        self.validate()?;
        self.prediction.assert_ready(minimum_usdc_micro).await
    }

    pub async fn wallet_balances(&self) -> Result<jupol_solana::WalletBalances, JupiterError> {
        self.prediction.wallet_balances().await
    }

    pub async fn usdc_balance(&self) -> Result<Micro, JupiterError> {
        self.prediction.usdc_balance().await
    }

    pub async fn prepare_buy(
        &self,
        market_id: &str,
        is_yes: bool,
        deposit_amount_micro_usd: Micro,
        outcome_mint: Option<&str>,
    ) -> Result<PredictionOrderBuild, JupiterError> {
        if let Some(outcome_mint) = outcome_mint
            && deposit_amount_micro_usd < self.prediction_minimum_buy_micro_usd
        {
            if !self.allow_subminimum_forecast_swap {
                return Err(JupiterError::ExecutionFailed(format!(
                    "Forecast order {deposit_amount_micro_usd} is below the Prediction API minimum {}",
                    self.prediction_minimum_buy_micro_usd
                )));
            }
            if !is_yes {
                return Err(invalid(
                    "native Forecast outcome-token markets must use the YES-side outcome mint",
                ));
            }
            return self
                .forecast
                .prepare_buy(market_id, outcome_mint, deposit_amount_micro_usd)
                .await;
        }
        self.prediction
            .prepare_buy(market_id, is_yes, deposit_amount_micro_usd, outcome_mint)
            .await
    }

    pub async fn token_balance(&self, mint: &str) -> Result<Micro, JupiterError> {
        self.prediction.token_balance(mint).await
    }

    pub async fn get_position(
        &self,
        position_pubkey: &str,
    ) -> Result<PredictionPosition, JupiterError> {
        if position_pubkey.starts_with("swap-v2:") {
            self.forecast.get_position(position_pubkey).await
        } else {
            self.prediction.get_position(position_pubkey).await
        }
    }

    pub async fn get_order_status(
        &self,
        order_pubkey: &str,
    ) -> Result<PredictionOrderStatus, JupiterError> {
        self.prediction.get_order_status(order_pubkey).await
    }

    pub async fn did_selected_market_win(
        &self,
        market_id: &str,
    ) -> Result<Option<bool>, JupiterError> {
        self.prediction.did_selected_market_win(market_id).await
    }

    pub async fn claim_position(
        &self,
        position_pubkey: &str,
        expected_payout_micro_usd: Micro,
        timeout: Duration,
    ) -> Result<JupiterClaim, JupiterError> {
        if position_pubkey.starts_with("swap-v2:") {
            self.forecast
                .claim_position(position_pubkey, expected_payout_micro_usd)
                .await
        } else {
            self.prediction
                .claim_position(position_pubkey, expected_payout_micro_usd, timeout)
                .await
        }
    }

    pub async fn reclaim_position_rent(
        &self,
        position_pubkey: &str,
        timeout: Duration,
    ) -> Result<JupiterRentReclaim, JupiterError> {
        if position_pubkey.starts_with("swap-v2:") {
            self.forecast
                .reclaim_position_rent(position_pubkey, timeout)
                .await
        } else {
            Ok(JupiterRentReclaim {
                transaction_signatures: Vec::new(),
                reclaimed_lamports: 0,
            })
        }
    }

    pub fn prepare_submission(
        &self,
        build: PredictionOrderBuild,
    ) -> Result<PreparedJupiterSubmission, JupiterError> {
        if is_forecast_swap_build(&build) {
            self.forecast.prepare_submission(build)
        } else {
            self.prediction.prepare_submission(build)
        }
    }

    pub async fn submit_prepared_and_wait(
        &self,
        prepared: PreparedJupiterSubmission,
        timeout: Duration,
    ) -> Result<SubmittedJupiterOrder, JupiterError> {
        if is_forecast_swap_build(&prepared.build) {
            self.forecast
                .submit_prepared_and_wait(prepared, timeout)
                .await
        } else {
            self.prediction
                .submit_prepared_and_wait(prepared, timeout)
                .await
        }
    }
}

fn parse_swap_order(
    payload: &Value,
    fallback_input_mint: &str,
    fallback_output_mint: &str,
) -> Result<SwapOrder, JupiterError> {
    let value = object(payload, "Swap V2 order")?;
    let transaction = text(value, "transaction").to_owned();
    let request_id = text(value, "requestId").to_owned();
    let router = optional_text(value, "router").unwrap_or_else(|| "unknown".to_owned());
    if transaction.is_empty() {
        return Err(JupiterError::ExecutionFailed(format!(
            "Swap V2 {router} build code={} error={}",
            value
                .get("errorCode")
                .and_then(Value::as_i64)
                .map_or_else(|| "unknown".to_owned(), |code| code.to_string()),
            text(value, "errorMessage")
        )));
    }
    let in_amount = required_unsigned_micro(value.get("inAmount"), "inAmount")?;
    let out_amount = required_unsigned_micro(value.get("outAmount"), "outAmount")?;
    let other_amount_threshold =
        required_unsigned_micro(value.get("otherAmountThreshold"), "otherAmountThreshold")?;
    let swap_mode = optional_text(value, "swapMode")
        .ok_or_else(|| invalid("Swap V2 order is missing swapMode"))?;
    if request_id.is_empty() || in_amount <= 0 || out_amount <= 0 {
        return Err(invalid("Swap V2 order is missing executable quote fields"));
    }
    if swap_mode != "ExactIn" {
        return Err(invalid(format!(
            "Swap V2 order must explicitly use ExactIn, received {swap_mode}"
        )));
    }
    if other_amount_threshold <= 0 || other_amount_threshold > out_amount {
        return Err(invalid(format!(
            "Swap V2 ExactIn order returned invalid minimum output {other_amount_threshold} for expected output {out_amount}"
        )));
    }
    Ok(SwapOrder {
        transaction,
        request_id,
        input_mint: optional_text(value, "inputMint")
            .unwrap_or_else(|| fallback_input_mint.to_owned()),
        output_mint: optional_text(value, "outputMint")
            .unwrap_or_else(|| fallback_output_mint.to_owned()),
        in_amount,
        out_amount,
        other_amount_threshold,
        swap_mode,
        slippage_bps: optional_u64(value.get("slippageBps")),
        price_impact: value
            .get("priceImpact")
            .and_then(scalar)
            .filter(|value| !value.is_empty()),
        fee_bps: optional_u64(value.get("feeBps")),
        signature_fee_lamports: optional_u64(value.get("signatureFeeLamports")),
        prioritization_fee_lamports: optional_u64(value.get("prioritizationFeeLamports")),
        rent_fee_lamports: optional_u64(value.get("rentFeeLamports")),
        last_valid_block_height: optional_u64(value.get("lastValidBlockHeight")).unwrap_or(0),
        router,
        mode: optional_text(value, "mode").unwrap_or_else(|| "unknown".to_owned()),
    })
}

fn parse_swap_execution(payload: &Value) -> Result<SwapExecution, JupiterError> {
    let value = object(payload, "Swap V2 execution")?;
    let status = parse_execution_status(text(value, "status"))?;
    Ok(SwapExecution {
        status,
        signature: optional_text(value, "signature"),
        code: value
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| {
                if status == ExecutionStatus::Success {
                    0
                } else {
                    -1
                }
            }),
        // Jupiter documents total*Amount as the wallet-reflected amount and
        // *AmountResult as the amount that entered/exited the swap route. The
        // two values legitimately differ when a fee is collected in that mint
        // (for example, 5_000_000 total input and 4_995_000 routed input).
        // Prefer wallet totals for cost/position accounting and retain the
        // result fields only as a backwards-compatible fallback.
        total_input_amount: wallet_swap_execution_amount(
            value,
            "totalInputAmount",
            "inputAmountResult",
        ),
        total_output_amount: wallet_swap_execution_amount(
            value,
            "totalOutputAmount",
            "outputAmountResult",
        ),
        error: optional_text(value, "error"),
    })
}

fn wallet_swap_execution_amount(
    value: &Map<String, Value>,
    wallet_total_field: &str,
    route_result_field: &str,
) -> Micro {
    let wallet_total = optional_unsigned_micro(value.get(wallet_total_field));
    let route_result = optional_unsigned_micro(value.get(route_result_field));
    wallet_total.or(route_result).unwrap_or(0)
}

fn parse_jupiter_event(value: &Value) -> Result<Vec<VenueMarket>, JupiterError> {
    let event = value
        .as_object()
        .ok_or_else(|| invalid("Jupiter event is not an object"))?;
    let event_id = optional_text(event, "eventId");
    let event_title = event
        .get("metadata")
        .and_then(Value::as_object)
        .map_or("", |metadata| text(metadata, "title"));
    event
        .get("markets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|market| parse_jupiter_market(market, event_id.clone(), event_title))
        .collect()
}

fn parse_jupiter_market(
    value: &Value,
    event_id: Option<String>,
    event_title: &str,
) -> Result<VenueMarket, JupiterError> {
    let raw = value
        .as_object()
        .ok_or_else(|| invalid("Jupiter market is not an object"))?;
    let market_id = text(raw, "marketId");
    if market_id.is_empty() {
        return Err(invalid("Jupiter market is missing marketId"));
    }
    let pricing = raw.get("pricing").and_then(Value::as_object);
    Ok(VenueMarket {
        venue: Venue::Jupiter,
        provider: optional_text(raw, "provider")
            .unwrap_or_else(|| "unknown".to_owned())
            .to_ascii_lowercase(),
        event_id,
        market_id: market_id.to_owned(),
        title: text(raw, "title").to_owned(),
        event_title: event_title.to_owned(),
        rules_primary: text(raw, "rulesPrimary").to_owned(),
        rules_secondary: text(raw, "rulesSecondary").to_owned(),
        status: optional_text(raw, "status").unwrap_or_else(|| "unknown".to_owned()),
        open_time_ms: epoch_seconds_to_ms(raw.get("openTime")),
        close_time_ms: epoch_seconds_to_ms(raw.get("closeTime")),
        clob_token_ids: string_array(raw.get("clobTokenIds")),
        outcomes: string_array(raw.get("outcomes")),
        outcome_mint: optional_text(raw, "outcomeMint"),
        pricing: MarketPricing {
            buy_yes_micro_usd: pricing
                .and_then(|value| optional_micro(value.get("buyYesPriceUsd"))),
            sell_yes_micro_usd: pricing
                .and_then(|value| optional_micro(value.get("sellYesPriceUsd"))),
            buy_no_micro_usd: pricing.and_then(|value| optional_micro(value.get("buyNoPriceUsd"))),
            sell_no_micro_usd: pricing
                .and_then(|value| optional_micro(value.get("sellNoPriceUsd"))),
        },
        fee_schedule: None,
        source_url: format!("{DEFAULT_PREDICTION_URL}/markets/{market_id}"),
    })
}

fn epoch_seconds_to_ms(value: Option<&Value>) -> Option<i64> {
    let seconds = value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
    })?;
    seconds.checked_mul(1_000)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn forecast_swap_build(
    order: SwapOrder,
    market_id: &str,
    outcome_mint: &str,
    is_buy: bool,
    owner_pubkey: &str,
) -> Result<PredictionOrderBuild, JupiterError> {
    let quoted_quantity_micro = if is_buy {
        order.out_amount
    } else {
        order.in_amount
    };
    if order.swap_mode != "ExactIn" {
        return Err(invalid(format!(
            "Forecast Swap V2 build requires ExactIn, received {}",
            order.swap_mode
        )));
    }
    let guaranteed_quantity_micro = if is_buy {
        order.other_amount_threshold
    } else {
        order.in_amount
    };
    if guaranteed_quantity_micro <= 0
        || (is_buy && guaranteed_quantity_micro > quoted_quantity_micro)
    {
        return Err(invalid(format!(
            "Swap V2 returned invalid guaranteed output {guaranteed_quantity_micro} for quote {quoted_quantity_micro}"
        )));
    }
    let gross_micro_usd = if is_buy {
        order.in_amount
    } else {
        order.out_amount
    };
    let optimistic_price_micro_usd = if is_buy {
        ceil_divide(
            gross_micro_usd
                .checked_mul(ONE_USD_MICRO)
                .ok_or_else(|| invalid("Swap price overflow"))?,
            quoted_quantity_micro,
        )?
    } else {
        gross_micro_usd
            .checked_mul(ONE_USD_MICRO)
            .ok_or_else(|| invalid("Swap price overflow"))?
            / quoted_quantity_micro
    };
    if !(1..ONE_USD_MICRO).contains(&optimistic_price_micro_usd) {
        return Err(invalid(format!(
            "Swap V2 returned invalid optimistic price {optimistic_price_micro_usd}"
        )));
    }
    let raw_average_price_micro_usd = if is_buy {
        ceil_divide(
            gross_micro_usd
                .checked_mul(ONE_USD_MICRO)
                .ok_or_else(|| invalid("Swap price overflow"))?,
            guaranteed_quantity_micro,
        )?
    } else {
        gross_micro_usd
            .checked_mul(ONE_USD_MICRO)
            .ok_or_else(|| invalid("Swap price overflow"))?
            / guaranteed_quantity_micro
    };
    let average_price_micro_usd = raw_average_price_micro_usd.min(ONE_USD_MICRO - 1);
    let position_pubkey = forecast_swap_position_id(market_id, outcome_mint);
    let execution_context = forecast_swap_execution_context(&order);
    Ok(PredictionOrderBuild {
        outcome_mint: Some(outcome_mint.to_owned()),
        transaction: order.transaction,
        blockhash: "managed-by-swap-v2".to_owned(),
        last_valid_block_height: order.last_valid_block_height,
        external_order_id: Some(order.request_id.clone()),
        jupiter_swap_request_id: Some(order.request_id),
        required_signers: vec![owner_pubkey.to_owned()],
        execution_endpoint: "/swap/v2/execute".to_owned(),
        execution_context,
        execution_model: Some("atomic_swap".to_owned()),
        settlement: Some("auto".to_owned()),
        order: PredictionOrder {
            order_pubkey: None,
            position_pubkey,
            market_id: market_id.to_owned(),
            is_buy,
            is_yes: true,
            // Preserve the optimistic quote for diagnostics, but expose only
            // the guaranteed minimum as executable new size to strategy code.
            contracts_micro: quoted_quantity_micro,
            new_contracts_micro: if is_buy { guaranteed_quantity_micro } else { 0 },
            max_buy_price_micro_usd: is_buy.then_some(average_price_micro_usd),
            min_sell_price_micro_usd: (!is_buy).then_some(average_price_micro_usd),
            order_cost_micro_usd: if is_buy { gross_micro_usd } else { 0 },
            new_average_price_micro_usd: is_buy.then_some(average_price_micro_usd),
            new_size_micro_usd: if is_buy { gross_micro_usd } else { 0 },
            payout_micro_usd: if is_buy {
                guaranteed_quantity_micro
            } else {
                gross_micro_usd
            },
            estimated_total_fee_micro_usd: 0,
        },
    })
}

fn forecast_swap_execution_context(order: &SwapOrder) -> Map<String, Value> {
    Map::from_iter([
        (
            "requestId".to_owned(),
            Value::String(order.request_id.clone()),
        ),
        ("router".to_owned(), Value::String(order.router.clone())),
        ("mode".to_owned(), Value::String(order.mode.clone())),
        (
            "inputMint".to_owned(),
            Value::String(order.input_mint.clone()),
        ),
        (
            "outputMint".to_owned(),
            Value::String(order.output_mint.clone()),
        ),
        (
            "quotedOutAmount".to_owned(),
            Value::String(order.out_amount.to_string()),
        ),
        (
            "otherAmountThreshold".to_owned(),
            Value::String(order.other_amount_threshold.to_string()),
        ),
        (
            "swapMode".to_owned(),
            Value::String(order.swap_mode.clone()),
        ),
        (
            "slippageBps".to_owned(),
            order.slippage_bps.map_or(Value::Null, Value::from),
        ),
    ])
}

#[must_use]
pub fn forecast_swap_position_id(market_id: &str, outcome_mint: &str) -> String {
    format!("swap-v2:{market_id}:{outcome_mint}")
}

fn parse_swap_position_id(value: &str) -> Result<(String, String), JupiterError> {
    let mut parts = value.split(':');
    let prefix = parts.next();
    let market_id = parts.next();
    let outcome_mint = parts.next();
    if prefix != Some("swap-v2")
        || market_id.is_none_or(str::is_empty)
        || outcome_mint.is_none_or(str::is_empty)
        || parts.next().is_some()
    {
        return Err(invalid(format!(
            "unsupported Forecast Swap position identity {value}"
        )));
    }
    Ok((
        market_id.unwrap_or_default().to_owned(),
        outcome_mint.unwrap_or_default().to_owned(),
    ))
}

fn is_forecast_swap_build(build: &PredictionOrderBuild) -> bool {
    build.execution_endpoint == "/swap/v2/execute"
        || build.order.position_pubkey.starts_with("swap-v2:")
}

fn validate_required_signers(
    build: &PredictionOrderBuild,
    owner_pubkey: &str,
) -> Result<(), JupiterError> {
    if !build.required_signers.iter().any(|key| key == owner_pubkey) {
        return Err(invalid(
            "transaction does not require the configured owner signature",
        ));
    }
    let unsupported = build
        .required_signers
        .iter()
        .filter(|key| key.as_str() != owner_pubkey)
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported.is_empty() {
        return Err(invalid(format!(
            "transaction requires unsupported additional signers: {}",
            unsupported.join(", ")
        )));
    }
    if build.blockhash.is_empty() || build.last_valid_block_height == 0 {
        return Err(invalid("transaction has invalid blockhash metadata"));
    }
    Ok(())
}

fn prediction_execution_request_id(build: &PredictionOrderBuild) -> Result<String, JupiterError> {
    build
        .external_order_id
        .clone()
        .or_else(|| build.jupiter_swap_request_id.clone())
        .or_else(|| build.order.order_pubkey.clone())
        .ok_or_else(|| invalid("Prediction build has no execution request ID"))
}

fn prediction_execute_body(
    signed_transaction: &str,
    context: &Map<String, Value>,
    request_id: &str,
) -> Value {
    json!({
        "signedTransaction": signed_transaction,
        "context": context,
        "requestId": request_id,
    })
}

fn reconcile_token_deltas(
    build: &PredictionOrderBuild,
    deltas: &[jupol_solana::TokenBalanceDelta],
) -> Result<PredictionOrderStatus, JupiterError> {
    let outcome_mint = build
        .outcome_mint
        .as_deref()
        .ok_or_else(|| invalid("fill reconciliation is missing outcomeMint"))?;
    let usdc = deltas
        .iter()
        .find(|delta| delta.mint == USDC_MINT)
        .ok_or_else(|| invalid("transaction has no owned USDC balance delta"))?;
    let outcome = deltas
        .iter()
        .find(|delta| delta.mint == outcome_mint)
        .ok_or_else(|| invalid("transaction has no owned outcome-token balance delta"))?;
    let filled_contracts_micro = if build.order.is_buy {
        outcome.after - outcome.before
    } else {
        outcome.before - outcome.after
    };
    let gross_micro_usd = if build.order.is_buy {
        usdc.before - usdc.after
    } else {
        usdc.after - usdc.before
    };
    if filled_contracts_micro <= 0 || gross_micro_usd <= 0 {
        return Err(JupiterError::AmbiguousExecution(format!(
            "confirmed transaction has invalid owned token deltas: contracts={filled_contracts_micro}, USDC={gross_micro_usd}"
        )));
    }
    let numerator = gross_micro_usd
        .checked_mul(ONE_USD_MICRO)
        .ok_or_else(|| invalid("fill price overflow"))?;
    let average_fill_price_micro_usd = if build.order.is_buy {
        ceil_divide(numerator, filled_contracts_micro)?
    } else {
        numerator / filled_contracts_micro
    };
    Ok(PredictionOrderStatus {
        order_pubkey: build.order.order_pubkey.clone(),
        position_pubkey: build.order.position_pubkey.clone(),
        market_id: build.order.market_id.clone(),
        status: "filled".to_owned(),
        is_buy: build.order.is_buy,
        is_yes: build.order.is_yes,
        contracts_micro: filled_contracts_micro,
        filled_contracts_micro,
        average_fill_price_micro_usd,
        size_micro_usd: gross_micro_usd,
        settled: true,
    })
}

fn reconcile_swap_execution(
    build: &PredictionOrderBuild,
    execution: &SwapExecution,
) -> Result<PredictionOrderStatus, JupiterError> {
    let (filled_contracts_micro, gross_micro_usd) = if build.order.is_buy {
        (execution.total_output_amount, execution.total_input_amount)
    } else {
        (execution.total_input_amount, execution.total_output_amount)
    };
    if filled_contracts_micro <= 0 || gross_micro_usd <= 0 {
        return Err(JupiterError::AmbiguousExecution(format!(
            "successful Swap V2 response has invalid wallet totals: contracts={filled_contracts_micro}, USDC={gross_micro_usd}"
        )));
    }
    if build.order.is_buy && filled_contracts_micro < build.order.new_contracts_micro {
        return Err(JupiterError::AmbiguousExecution(format!(
            "Swap V2 output {filled_contracts_micro} is below its guaranteed threshold {}",
            build.order.new_contracts_micro
        )));
    }
    let numerator = gross_micro_usd
        .checked_mul(ONE_USD_MICRO)
        .ok_or_else(|| invalid("Swap V2 fill price overflow"))?;
    let average_fill_price_micro_usd = if build.order.is_buy {
        ceil_divide(numerator, filled_contracts_micro)?
    } else {
        numerator / filled_contracts_micro
    };
    Ok(PredictionOrderStatus {
        order_pubkey: None,
        position_pubkey: build.order.position_pubkey.clone(),
        market_id: build.order.market_id.clone(),
        status: "filled".to_owned(),
        is_buy: build.order.is_buy,
        is_yes: build.order.is_yes,
        contracts_micro: filled_contracts_micro,
        filled_contracts_micro,
        average_fill_price_micro_usd,
        size_micro_usd: gross_micro_usd,
        settled: true,
    })
}

fn parse_execution_status(value: &str) -> Result<ExecutionStatus, JupiterError> {
    match value {
        "Success" => Ok(ExecutionStatus::Success),
        "Failed" => Ok(ExecutionStatus::Failed),
        other => Err(invalid(format!(
            "unsupported execution status {}",
            if other.is_empty() { "missing" } else { other }
        ))),
    }
}

fn required_unsigned_micro(value: Option<&Value>, field: &str) -> Result<Micro, JupiterError> {
    optional_unsigned_micro(value).ok_or_else(|| invalid(format!("response is missing {field}")))
}

fn optional_unsigned_micro(value: Option<&Value>) -> Option<Micro> {
    let value = value?;
    if let Some(number) = value.as_u64() {
        return Some(Micro::from(number));
    }
    value
        .as_str()
        .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|text| text.parse().ok())
}

fn optional_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value
            .as_str()
            .filter(|text| text.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|text| text.parse().ok())
    })
}

fn ceil_divide(numerator: Micro, denominator: Micro) -> Result<Micro, JupiterError> {
    if denominator <= 0 {
        return Err(invalid("cannot divide by a non-positive quantity"));
    }
    Ok((numerator + denominator - 1) / denominator)
}

fn parse_claim_build(payload: &Value) -> Result<PredictionClaimBuild, JupiterError> {
    let value = object(payload, "claim build")?;
    let tx_meta = value
        .get("txMeta")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("claim build is missing txMeta"))?;
    let position = value
        .get("position")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("claim build has no position"))?;
    let transaction = text(value, "transaction").to_owned();
    let blockhash = text(tx_meta, "blockhash").to_owned();
    let last_valid_block_height = optional_u64(tx_meta.get("lastValidBlockHeight")).unwrap_or(0);
    let position_pubkey = optional_text(position, "positionPubkey")
        .or_else(|| optional_text(position, "pubkey"))
        .unwrap_or_default();
    if transaction.is_empty()
        || blockhash.is_empty()
        || last_valid_block_height == 0
        || position_pubkey.is_empty()
    {
        return Err(invalid("claim build is missing executable fields"));
    }
    Ok(PredictionClaimBuild {
        transaction,
        blockhash,
        last_valid_block_height,
        position_pubkey,
        contracts_micro: position_contracts(position)?,
        payout_micro_usd: required_micro(
            position.get("payoutAmountUsd"),
            "claim.position.payoutAmountUsd",
        )?,
    })
}

fn parse_prediction_order(
    value: &Map<String, Value>,
    fallback_order_pubkey: &str,
) -> Result<PredictionOrderStatus, JupiterError> {
    let status = normalize_prediction_order_status(text(value, "status"))?;
    Ok(PredictionOrderStatus {
        order_pubkey: optional_text(value, "pubkey")
            .or_else(|| Some(fallback_order_pubkey.to_owned())),
        position_pubkey: text(value, "position").to_owned(),
        market_id: text(value, "marketId").to_owned(),
        status,
        is_buy: boolean(value, "isBuy"),
        is_yes: boolean(value, "isYes"),
        contracts_micro: required_micro(value.get("contracts"), "contracts")?,
        filled_contracts_micro: required_micro(value.get("filledContracts"), "filledContracts")?,
        average_fill_price_micro_usd: required_micro(
            value.get("avgFillPriceUsd"),
            "avgFillPriceUsd",
        )?,
        size_micro_usd: required_micro(value.get("sizeUsd"), "sizeUsd")?,
        settled: boolean(value, "settled"),
    })
}

fn normalize_prediction_order_status(status: &str) -> Result<String, JupiterError> {
    match status.to_ascii_lowercase().as_str() {
        // /orders/status uses these keeper lifecycle names. Internally both are
        // pending because neither proves a terminal fill quantity.
        "created" | "partiallyfilled" | "pending" => Ok("pending".to_owned()),
        "filled" => Ok("filled".to_owned()),
        "failed" => Ok("failed".to_owned()),
        status => Err(invalid(format!("unsupported order status {status}"))),
    }
}

fn parse_order_build(payload: &Value) -> Result<PredictionOrderBuild, JupiterError> {
    let value = object(payload, "order build")?;
    let tx_meta = value
        .get("txMeta")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("order build is missing txMeta"))?;
    let order = value
        .get("order")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("order build is missing order"))?;
    let execution = value.get("execution").and_then(Value::as_object);
    let context = execution
        .and_then(|execution| execution.get("context"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let execution_model = optional_text(value, "executionModel");
    let order_pubkey = optional_text(order, "orderPubkey");
    let position_pubkey = text(order, "positionPubkey").to_owned();
    let market_id = text(order, "marketId").to_owned();
    let top_swap_id = optional_text(value, "jupiterSwapRequestId");
    let context_swap_id = optional_text(&context, "jupiterSwapRequestId");
    if top_swap_id.is_some() && context_swap_id.is_some() && top_swap_id != context_swap_id {
        return Err(invalid("conflicting atomic-swap request IDs"));
    }
    let swap_id = top_swap_id.or(context_swap_id);
    let transaction = text(value, "transaction").to_owned();
    if transaction.is_empty() || position_pubkey.is_empty() || market_id.is_empty() {
        return Err(invalid("order build is missing executable identity fields"));
    }
    if order_pubkey.is_none() && execution_model.as_deref() != Some("atomic_swap") {
        return Err(invalid("keeper order build is missing orderPubkey"));
    }
    if execution_model.as_deref() == Some("atomic_swap") && swap_id.is_none() {
        return Err(invalid("atomic swap is missing jupiterSwapRequestId"));
    }
    Ok(PredictionOrderBuild {
        outcome_mint: optional_text(value, "outcomeMint"),
        transaction,
        blockhash: text(tx_meta, "blockhash").to_owned(),
        last_valid_block_height: tx_meta
            .get("lastValidBlockHeight")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        external_order_id: optional_text(value, "externalOrderId"),
        jupiter_swap_request_id: swap_id,
        required_signers: value
            .get("requiredSigners")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        execution_endpoint: execution
            .map_or("", |execution| text(execution, "endpoint"))
            .to_owned(),
        execution_context: context,
        execution_model,
        settlement: optional_text(value, "settlement"),
        order: PredictionOrder {
            order_pubkey,
            position_pubkey,
            market_id,
            is_buy: boolean(order, "isBuy"),
            is_yes: boolean(order, "isYes"),
            contracts_micro: required_contracts_micro(
                order,
                "contractsMicro",
                "contractsDecimal",
                "contracts",
            )?,
            new_contracts_micro: required_contracts_micro(
                order,
                "newContractsMicro",
                "newContractsDecimal",
                "newContracts",
            )?,
            max_buy_price_micro_usd: optional_micro(order.get("maxBuyPriceUsd")),
            min_sell_price_micro_usd: optional_micro(order.get("minSellPriceUsd")),
            order_cost_micro_usd: optional_micro(order.get("orderCostUsd")).unwrap_or(0),
            new_average_price_micro_usd: optional_micro(order.get("newAvgPriceUsd")),
            new_size_micro_usd: optional_micro(order.get("newSizeUsd")).unwrap_or(0),
            payout_micro_usd: optional_micro(order.get("newPayoutUsd"))
                .or_else(|| optional_micro(order.get("payoutUsd")))
                .unwrap_or(0),
            estimated_total_fee_micro_usd: optional_micro(order.get("estimatedTotalFeeUsd"))
                .unwrap_or(0),
        },
    })
}

fn parse_levels(value: Option<&Value>) -> Result<Vec<BookLevel>, JupiterError> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .filter(|level| level.len() >= 2)
        .map(|level| {
            let price =
                scalar(&level[0]).ok_or_else(|| invalid("orderbook price is not scalar"))?;
            let quantity =
                scalar(&level[1]).ok_or_else(|| invalid("orderbook quantity is not scalar"))?;
            Ok(BookLevel::new(
                parse_usd(&price).map_err(|error| invalid(error.to_string()))?,
                parse_contracts(&quantity).map_err(|error| invalid(error.to_string()))?,
            ))
        })
        .collect()
}

fn complement(levels: &[BookLevel]) -> Vec<BookLevel> {
    levels
        .iter()
        .filter(|level| (0..=ONE_USD_MICRO).contains(&level.price_micro_usd))
        .map(|level| BookLevel::new(ONE_USD_MICRO - level.price_micro_usd, level.contracts_micro))
        .collect()
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, JupiterError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{label} is not an object")))
}

fn text<'a>(value: &'a Map<String, Value>, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

fn optional_text(value: &Map<String, Value>, field: &str) -> Option<String> {
    let value = text(value, field);
    (!value.is_empty()).then(|| value.to_owned())
}

fn boolean(value: &Map<String, Value>, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn required_micro(value: Option<&Value>, field: &str) -> Result<Micro, JupiterError> {
    optional_micro(value).ok_or_else(|| invalid(format!("response is missing {field}")))
}

fn required_contracts_micro(
    value: &Map<String, Value>,
    micro_field: &str,
    decimal_field: &str,
    legacy_field: &str,
) -> Result<Micro, JupiterError> {
    if let Some(contracts) = optional_unsigned_micro(value.get(micro_field)) {
        return Ok(contracts);
    }
    for field in [decimal_field, legacy_field] {
        if let Some(raw) = value.get(field).and_then(scalar) {
            return parse_contracts(&raw).map_err(|error| invalid(error.to_string()));
        }
    }
    Err(invalid(format!(
        "response is missing {micro_field}, {decimal_field}, and {legacy_field}"
    )))
}

fn optional_micro(value: Option<&Value>) -> Option<Micro> {
    let value = value?;
    if let Some(number) = value.as_u64() {
        return Some(Micro::from(number));
    }
    let value = scalar(value)?;
    if value.bytes().all(|byte| byte.is_ascii_digit()) {
        return value.parse().ok();
    }
    parse_usd(&value).ok()
}

fn position_contracts(value: &Map<String, Value>) -> Result<Micro, JupiterError> {
    if let Some(contracts) = optional_micro(value.get("contractsMicro")) {
        return Ok(contracts);
    }
    let contracts = value
        .get("contracts")
        .and_then(scalar)
        .ok_or_else(|| invalid("position is missing contracts"))?;
    parse_contracts(&contracts).map_err(|error| invalid(error.to_string()))
}

fn scalar(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.is_number().then(|| value.to_string()))
}

fn unix_timestamp_ms() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis();
    i64::try_from(millis).unwrap_or(i64::MAX)
}

fn definitive_http_rejection(error: &JupiterError) -> bool {
    let JupiterError::Http(error) = error else {
        return false;
    };
    error.status().is_some_and(|status| {
        status.is_client_error() && !matches!(status.as_u16(), 408 | 425 | 429)
    })
}

fn is_http_not_found(error: &JupiterError) -> bool {
    matches!(
        error,
        JupiterError::Http(error)
            if error.status().is_some_and(|status| status.as_u16() == 404)
    )
}

fn invalid(message: impl Into<String>) -> JupiterError {
    JupiterError::InvalidResponse(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn accepts_atomic_swap_without_keeper_pubkey() {
        let payload = json!({
            "transaction": "base64",
            "txMeta": { "blockhash": "hash", "lastValidBlockHeight": 10 },
            "jupiterSwapRequestId": "swap-1",
            "requiredSigners": ["owner"],
            "execution": { "endpoint": "/execute", "context": {} },
            "executionModel": "atomic_swap",
            "order": {
                "positionPubkey": "position",
                "marketId": "market",
                "isBuy": true,
                "isYes": false,
                "contractsMicro": "7000000",
                "newContractsMicro": "7000000"
            }
        });
        let build = parse_order_build(&payload).expect("valid build");
        assert_eq!(build.order.order_pubkey, None);
        assert_eq!(build.jupiter_swap_request_id.as_deref(), Some("swap-1"));
        assert_eq!(build.order.contracts_micro, 7_000_000);
    }

    #[test]
    fn accepts_documented_decimal_order_fields() {
        let payload = json!({
            "transaction": "base64",
            "txMeta": { "blockhash": "hash", "lastValidBlockHeight": 10 },
            "externalOrderId": "external-1",
            "requiredSigners": ["owner"],
            "execution": { "endpoint": "/api/v1/execute", "context": {} },
            "order": {
                "orderPubkey": "order",
                "positionPubkey": "position",
                "marketId": "market",
                "isBuy": true,
                "isYes": true,
                "contracts": "7.25",
                "newContracts": "8.5",
                "newPayoutUsd": "8500000"
            }
        });
        let build = parse_order_build(&payload).expect("documented order build");
        assert_eq!(build.order.contracts_micro, 7_250_000);
        assert_eq!(build.order.new_contracts_micro, 8_500_000);
        assert_eq!(build.order.payout_micro_usd, 8_500_000);
    }

    #[test]
    fn accepts_documented_claim_schema() {
        let payload = json!({
            "transaction": "base64",
            "txMeta": { "blockhash": "hash", "lastValidBlockHeight": 10 },
            "position": {
                "positionPubkey": "position",
                "contracts": "10",
                "contractsMicro": "10000000",
                "payoutAmountUsd": "10000000"
            }
        });
        let build = parse_claim_build(&payload).expect("documented claim build");
        assert_eq!(build.position_pubkey, "position");
        assert_eq!(build.contracts_micro, 10_000_000);
        assert_eq!(build.payout_micro_usd, 10_000_000);
        assert_eq!(build.blockhash, "hash");
    }

    #[test]
    fn complements_exact_book_levels() {
        let bids = vec![BookLevel::new(290_000, 8_000_000)];
        assert_eq!(complement(&bids), vec![BookLevel::new(710_000, 8_000_000)]);
    }

    #[test]
    fn only_definitive_client_errors_are_prebroadcast_rejections() {
        let response = |status| {
            JupiterError::Http(HttpError::Response {
                status,
                url: "https://api.jup.ag/execute".to_owned(),
                body: "error".to_owned(),
                rate_limit_reset_ms: None,
                retry_delay_ms: None,
            })
        };
        assert!(definitive_http_rejection(&response(
            StatusCode::BAD_REQUEST
        )));
        assert!(!definitive_http_rejection(&response(
            StatusCode::TOO_MANY_REQUESTS
        )));
        assert!(!definitive_http_rejection(&response(
            StatusCode::INTERNAL_SERVER_ERROR
        )));
    }

    #[test]
    fn prediction_execute_carries_the_idempotency_key() {
        let body = prediction_execute_body("signed", &Map::new(), "request-1");
        assert_eq!(
            body.get("requestId").and_then(Value::as_str),
            Some("request-1")
        );
        assert_eq!(
            body.get("signedTransaction").and_then(Value::as_str),
            Some("signed")
        );
    }

    #[test]
    fn forecast_build_sizes_against_guaranteed_output_not_optimistic_quote() {
        let build = forecast_swap_build(
            SwapOrder {
                transaction: "base64".to_owned(),
                request_id: "swap-1".to_owned(),
                input_mint: USDC_MINT.to_owned(),
                output_mint: "outcome".to_owned(),
                in_amount: 5_000_000,
                out_amount: 10_000_000,
                other_amount_threshold: 8_500_000,
                swap_mode: "ExactIn".to_owned(),
                slippage_bps: Some(1_500),
                price_impact: None,
                fee_bps: None,
                signature_fee_lamports: None,
                prioritization_fee_lamports: None,
                rent_fee_lamports: None,
                last_valid_block_height: 100,
                router: "metis".to_owned(),
                mode: "ultra".to_owned(),
            },
            "market",
            "outcome",
            true,
            "owner",
        )
        .expect("valid forecast build");
        assert_eq!(build.order.contracts_micro, 10_000_000);
        assert_eq!(build.order.new_contracts_micro, 8_500_000);
        assert_eq!(build.order.payout_micro_usd, 8_500_000);
        assert_eq!(build.order.max_buy_price_micro_usd, Some(588_236));
        assert_eq!(
            build
                .execution_context
                .get("otherAmountThreshold")
                .and_then(Value::as_str),
            Some("8500000")
        );
    }

    #[test]
    fn swap_execution_uses_wallet_totals_and_enforces_threshold() {
        let mut build = parse_order_build(&json!({
            "transaction": "base64",
            "txMeta": { "blockhash": "hash", "lastValidBlockHeight": 10 },
            "jupiterSwapRequestId": "swap-1",
            "requiredSigners": ["owner"],
            "execution": { "endpoint": "/swap/v2/execute", "context": {} },
            "executionModel": "atomic_swap",
            "outcomeMint": "outcome",
            "order": {
                "positionPubkey": "position",
                "marketId": "market",
                "isBuy": true,
                "isYes": true,
                "contractsMicro": "10000000",
                "newContractsMicro": "8500000"
            }
        }))
        .expect("valid build");
        let execution = SwapExecution {
            status: ExecutionStatus::Success,
            signature: Some("signature".to_owned()),
            code: 0,
            total_input_amount: 5_000_000,
            total_output_amount: 8_750_000,
            error: None,
        };
        let status = reconcile_swap_execution(&build, &execution).expect("above threshold");
        assert_eq!(status.filled_contracts_micro, 8_750_000);
        assert_eq!(status.size_micro_usd, 5_000_000);

        build.order.new_contracts_micro = 9_000_000;
        assert!(reconcile_swap_execution(&build, &execution).is_err());
    }

    #[test]
    fn swap_order_requires_consistent_exact_in_price_protection() {
        let exact_in = json!({
            "transaction": "base64",
            "requestId": "swap-1",
            "inputMint": USDC_MINT,
            "outputMint": "outcome",
            "inAmount": "5000000",
            "outAmount": "5236055",
            "otherAmountThreshold": "4995221",
            "swapMode": "ExactIn",
            "router": "iris",
            "mode": "ultra"
        });
        let order =
            parse_swap_order(&exact_in, USDC_MINT, "outcome").expect("consistent ExactIn order");
        assert_eq!(order.swap_mode, "ExactIn");
        assert_eq!(order.other_amount_threshold, 4_995_221);

        let mut exact_out = exact_in.clone();
        exact_out["swapMode"] = Value::String("ExactOut".to_owned());
        assert!(
            parse_swap_order(&exact_out, USDC_MINT, "outcome")
                .expect_err("ExactOut must be rejected")
                .to_string()
                .contains("explicitly use ExactIn")
        );

        let mut inconsistent = exact_in;
        inconsistent["otherAmountThreshold"] = Value::String("5236055".to_owned());
        inconsistent["outAmount"] = Value::String("4995221".to_owned());
        assert!(
            parse_swap_order(&inconsistent, USDC_MINT, "outcome")
                .expect_err("minimum output above expected output must be rejected")
                .to_string()
                .contains("invalid minimum output")
        );
    }

    #[test]
    fn swap_execution_prefers_documented_wallet_totals_over_fee_adjusted_route_amounts() {
        let result_shape = json!({
            "status": "Success",
            "signature": "signature",
            "code": 0,
            "inputAmountResult": "5000000",
            "outputAmountResult": "5250000"
        });
        let execution = parse_swap_execution(&result_shape).expect("result amount shape");
        assert_eq!(execution.total_input_amount, 5_000_000);
        assert_eq!(execution.total_output_amount, 5_250_000);

        let fee_bearing = json!({
            "status": "Success",
            "signature": "signature",
            "code": 0,
            "totalInputAmount": "5000000",
            "inputAmountResult": "4995000",
            "totalOutputAmount": "5245000",
            "outputAmountResult": "5250000"
        });
        let execution = parse_swap_execution(&fee_bearing).expect("fee-bearing execution");
        assert_eq!(execution.total_input_amount, 5_000_000);
        assert_eq!(execution.total_output_amount, 5_245_000);
    }

    #[test]
    fn parses_documented_closed_order_history_shape() {
        let order = json!({
            "pubkey": "order",
            "position": "position",
            "marketId": "market",
            "status": "filled",
            "isBuy": true,
            "isYes": false,
            "contracts": "7000000",
            "filledContracts": "6850000",
            "avgFillPriceUsd": "510000",
            "sizeUsd": "3493500",
            "settled": true
        });
        let status = parse_prediction_order(order.as_object().expect("object"), "fallback")
            .expect("valid history order");
        assert_eq!(status.order_pubkey.as_deref(), Some("order"));
        assert_eq!(status.filled_contracts_micro, 6_850_000);
    }

    #[test]
    fn normalizes_documented_keeper_lifecycle_statuses() {
        assert_eq!(
            normalize_prediction_order_status("created").expect("created is live"),
            "pending"
        );
        assert_eq!(
            normalize_prediction_order_status("partiallyfilled").expect("partial is live"),
            "pending"
        );
        assert_eq!(
            normalize_prediction_order_status("filled").expect("filled is terminal"),
            "filled"
        );
    }

    #[test]
    fn ignores_zero_screening_asks_without_replacing_the_last_valid_price() {
        let update = |market_id: &str, yes_ask_micro_usd| JupiterPriceUpdate {
            market_id: market_id.to_owned(),
            source_timestamp_ms: 1,
            received_at_ms: 2,
            yes_bid_micro_usd: 390_000,
            yes_ask_micro_usd,
            no_bid_micro_usd: 590_000,
            no_ask_micro_usd: 610_000,
        };
        let mut state = JupiterPriceBookState::new("up", "down", 5_000_000).expect("valid state");

        assert!(
            state
                .apply(update("up", 400_000))
                .expect("valid update")
                .is_none()
        );
        assert!(
            state
                .apply(update("down", 600_000))
                .expect("valid update")
                .is_some()
        );
        assert!(
            state
                .apply(update("up", 0))
                .expect("zero sentinel is ignored")
                .is_none()
        );

        let book = state
            .apply(update("down", 590_000))
            .expect("valid update")
            .expect("complete book");
        assert_eq!(book.yes.asks[0].price_micro_usd, 400_000);
        assert_eq!(book.no.asks[0].price_micro_usd, 590_000);
    }
}
