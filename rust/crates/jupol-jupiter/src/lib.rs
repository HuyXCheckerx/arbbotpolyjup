//! Jupiter Prediction developer API client for live order construction,
//! execution, position polling, and exact order-book ingestion.

#![allow(clippy::missing_errors_doc)]

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jupol_domain::Micro;
use jupol_domain::fixed::{ONE_USD_MICRO, parse_contracts, parse_usd};
use jupol_domain::types::{BinaryOrderBook, BookLevel, SideOrderBook, Venue};
use jupol_http::{HttpClient, HttpClientOptions, HttpError};
use jupol_runtime::request_scheduler::{JupiterRequestScheduler, RequestPriority, SchedulerError};
use reqwest::{Method, Url};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

const DEFAULT_PREDICTION_URL: &str = "https://api.jup.ag/prediction/v1";
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

#[derive(Clone)]
pub struct JupiterClientOptions {
    pub base_url: String,
    pub api_key: Option<String>,
    pub minimum_request_interval: Option<Duration>,
    pub request_scheduler: Option<JupiterRequestScheduler>,
    pub request_priority: RequestPriority,
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

#[derive(Debug)]
pub enum JupiterError {
    Http(HttpError),
    Scheduler(SchedulerError),
    InvalidUrl(String),
    InvalidResponse(String),
}

impl fmt::Display for JupiterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(error) => error.fmt(formatter),
            Self::Scheduler(error) => error.fmt(formatter),
            Self::InvalidUrl(error) => write!(formatter, "Invalid Jupiter URL: {error}"),
            Self::InvalidResponse(error) => write!(formatter, "Invalid Jupiter response: {error}"),
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
                Duration::ZERO
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
                &json!({ "signedTransaction": signed_transaction, "context": context }),
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
        let status = text(value, "status").to_ascii_lowercase();
        if !matches!(status.as_str(), "pending" | "filled" | "failed") {
            return Err(invalid(format!("unsupported order status {status}")));
        }
        Ok(PredictionOrderStatus {
            order_pubkey: optional_text(value, "pubkey").or_else(|| Some(order_pubkey.to_owned())),
            position_pubkey: text(value, "position").to_owned(),
            market_id: text(value, "marketId").to_owned(),
            status,
            is_buy: boolean(value, "isBuy"),
            is_yes: boolean(value, "isYes"),
            contracts_micro: required_micro(value.get("contracts"), "contracts")?,
            filled_contracts_micro: required_micro(
                value.get("filledContracts"),
                "filledContracts",
            )?,
            average_fill_price_micro_usd: required_micro(
                value.get("avgFillPriceUsd"),
                "avgFillPriceUsd",
            )?,
            size_micro_usd: required_micro(value.get("sizeUsd"), "sizeUsd")?,
            settled: boolean(value, "settled"),
        })
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
        self.reserve(&url).await?;
        Ok(self.http.get_json(url.as_str()).await?)
    }

    async fn send<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: &B,
    ) -> Result<Value, JupiterError> {
        let url = self.url(path)?;
        self.reserve(&url).await?;
        match method {
            Method::POST => Ok(self.http.post_json(url.as_str(), body).await?),
            Method::DELETE => Ok(self.http.delete_json(url.as_str(), body).await?),
            _ => Err(invalid("unsupported request method")),
        }
    }

    async fn reserve(&self, url: &Url) -> Result<(), JupiterError> {
        // Signed transaction handoff is latency critical and never waits behind
        // discovery/order-build reservations.
        if let Some(scheduler) = &self.scheduler
            && !url.path().ends_with("/execute")
        {
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
            contracts_micro: required_micro(order.get("contractsMicro"), "contractsMicro")?,
            new_contracts_micro: required_micro(
                order.get("newContractsMicro"),
                "newContractsMicro",
            )?,
            max_buy_price_micro_usd: optional_micro(order.get("maxBuyPriceUsd")),
            min_sell_price_micro_usd: optional_micro(order.get("minSellPriceUsd")),
            order_cost_micro_usd: optional_micro(order.get("orderCostUsd")).unwrap_or(0),
            new_average_price_micro_usd: optional_micro(order.get("newAvgPriceUsd")),
            new_size_micro_usd: optional_micro(order.get("newSizeUsd")).unwrap_or(0),
            payout_micro_usd: optional_micro(order.get("payoutUsd")).unwrap_or(0),
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

fn invalid(message: impl Into<String>) -> JupiterError {
    JupiterError::InvalidResponse(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn complements_exact_book_levels() {
        let bids = vec![BookLevel::new(290_000, 8_000_000)];
        assert_eq!(complement(&bids), vec![BookLevel::new(710_000, 8_000_000)]);
    }
}
