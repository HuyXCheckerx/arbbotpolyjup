//! Polymarket market-data and live CLOB adapter.
//!
//! This crate deliberately keeps order construction separate from submission.
//! A live strategy can therefore build and sign the exact-share FOK order before
//! entering its concurrent critical section and only perform the final HTTP POST
//! alongside the Jupiter transaction handoff.

#![allow(clippy::missing_errors_doc)]

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy::signers::Signer as _;
use alloy::signers::local::{LocalSigner, PrivateKeySigner};
use ethers::abi::{Token, encode};
use ethers::signers::LocalWallet;
use ethers::types::{Address as EthersAddress, U256 as EthersU256};
use ethers::utils::keccak256;
use futures::{SinkExt as _, StreamExt as _};
use jupol_domain::Micro;
use jupol_domain::fixed::{
    ONE_USD_MICRO, format_contracts, format_usd, parse_contracts, parse_usd,
};
use jupol_domain::types::{
    BinaryOrderBook, BookLevel, MarketFeeSchedule, MarketPricing, SideOrderBook, Venue, VenueMarket,
};
use jupol_http::{HttpClient, HttpClientOptions};
use polymarket_client_sdk_v2::POLYGON;
use polymarket_client_sdk_v2::auth::Normal;
use polymarket_client_sdk_v2::auth::state::{Authenticated, Unauthenticated};
use polymarket_client_sdk_v2::clob::types::request::{
    BalanceAllowanceRequest, OrderBookSummaryRequest,
};
use polymarket_client_sdk_v2::clob::types::{
    AssetType, OrderPayload, OrderStatusType, OrderType, Side, SignatureType, SignedOrder,
};
use polymarket_client_sdk_v2::clob::{Client, Config};
use polymarket_client_sdk_v2::types::{Address, Decimal, U256};
use polymarket_relayer::{
    AuthMethod, DepositWalletCall, RelayClient, RelayerTxType, Transaction, TxResult, operations,
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_CLOB_URL: &str = "https://clob.polymarket.com";
const DEFAULT_GAMMA_URL: &str = "https://gamma-api.polymarket.com";
const DEFAULT_MARKET_WEBSOCKET_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalletSignature {
    Eoa,
    Proxy,
    GnosisSafe,
    Poly1271,
}

impl WalletSignature {
    #[must_use]
    pub const fn sdk(self) -> SignatureType {
        match self {
            Self::Eoa => SignatureType::Eoa,
            Self::Proxy => SignatureType::Proxy,
            Self::GnosisSafe => SignatureType::GnosisSafe,
            Self::Poly1271 => SignatureType::Poly1271,
        }
    }
}

impl FromStr for WalletSignature {
    type Err = PolymarketError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "eoa" | "0" => Ok(Self::Eoa),
            "proxy" | "1" => Ok(Self::Proxy),
            "gnosis" | "gnosis_safe" | "safe" | "2" => Ok(Self::GnosisSafe),
            "poly1271" | "poly_1271" | "1271" | "3" => Ok(Self::Poly1271),
            other => Err(PolymarketError::Configuration(format!(
                "unsupported Polymarket signature type {other}"
            ))),
        }
    }
}

#[derive(Clone, Debug)]
pub struct PolymarketOptions {
    pub clob_url: String,
    pub private_key: String,
    pub funder: Option<String>,
    pub signature: WalletSignature,
}

impl PolymarketOptions {
    pub fn from_env() -> Result<Self, PolymarketError> {
        let private_key = required_env(&[
            "POLYMARKET_PRIVATE_KEY",
            "POLYMARKET_WALLET_PRIVATE_KEY",
            "PRIVATE_KEY",
        ])?;
        let funder = optional_env(&[
            "POLYMARKET_WALLET_ADDRESS",
            "POLYMARKET_FUNDER_ADDRESS",
            "DEPOSIT_WALLET",
        ]);
        let signature = match std::env::var("POLYMARKET_SIGNATURE_TYPE") {
            Ok(value) => WalletSignature::from_str(&value)?,
            Err(_) if funder.is_some() => WalletSignature::Poly1271,
            Err(_) => WalletSignature::Eoa,
        };
        if signature != WalletSignature::Eoa && funder.is_none() {
            return Err(PolymarketError::Configuration(
                "a Polymarket funder/deposit wallet is required for contract-wallet signatures"
                    .to_owned(),
            ));
        }
        Ok(Self {
            clob_url: std::env::var("POLYMARKET_CLOB_URL")
                .unwrap_or_else(|_| DEFAULT_CLOB_URL.to_owned()),
            private_key,
            funder,
            signature,
        })
    }
}

#[derive(Debug)]
pub enum PolymarketError {
    Configuration(String),
    Sdk(String),
    InvalidValue(String),
    Rejected(String),
    AmbiguousSubmission(String),
}

impl fmt::Display for PolymarketError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) => {
                write!(formatter, "Polymarket configuration: {message}")
            }
            Self::Sdk(message) => write!(formatter, "Polymarket SDK: {message}"),
            Self::InvalidValue(message) => write!(formatter, "Invalid Polymarket value: {message}"),
            Self::Rejected(message) => write!(formatter, "Polymarket order rejected: {message}"),
            Self::AmbiguousSubmission(message) => {
                write!(formatter, "Ambiguous Polymarket submission: {message}")
            }
        }
    }
}

impl std::error::Error for PolymarketError {}

#[derive(Clone)]
pub struct PolymarketGammaClient {
    gamma_url: String,
    http: HttpClient,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolymarketSettlementMetadata {
    pub market_id: String,
    pub condition_id: [u8; 32],
    pub negative_risk: bool,
    pub closed: bool,
}

impl PolymarketGammaClient {
    pub fn new(gamma_url: Option<&str>) -> Result<Self, PolymarketError> {
        Ok(Self {
            gamma_url: gamma_url
                .unwrap_or(DEFAULT_GAMMA_URL)
                .trim_end_matches('/')
                .to_owned(),
            http: HttpClient::new(&HttpClientOptions::default()).map_err(sdk_error)?,
        })
    }

    pub async fn get_event_markets_by_slug(
        &self,
        slug: &str,
    ) -> Result<Vec<VenueMarket>, PolymarketError> {
        if !slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(PolymarketError::InvalidValue(format!(
                "unsafe event slug {slug}"
            )));
        }
        let payload: serde_json::Value = self
            .http
            .get_json(&format!("{}/events/slug/{slug}", self.gamma_url))
            .await
            .map_err(sdk_error)?;
        let markets = parse_gamma_event(&payload, &self.gamma_url)?;
        if markets.is_empty() {
            return Err(PolymarketError::InvalidValue(format!(
                "event {slug} has no markets"
            )));
        }
        Ok(markets)
    }

    pub async fn get_market(&self, market_id: &str) -> Result<VenueMarket, PolymarketError> {
        if !market_id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(PolymarketError::InvalidValue(format!(
                "invalid Gamma market id {market_id}"
            )));
        }
        let payload: serde_json::Value = self
            .http
            .get_json(&format!("{}/markets/{market_id}", self.gamma_url))
            .await
            .map_err(sdk_error)?;
        parse_gamma_market(&payload, None, "", &self.gamma_url)
    }

    pub async fn settlement_metadata(
        &self,
        market_id: &str,
    ) -> Result<PolymarketSettlementMetadata, PolymarketError> {
        if !market_id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(PolymarketError::InvalidValue(format!(
                "invalid Gamma market id {market_id}"
            )));
        }
        let payload: serde_json::Value = self
            .http
            .get_json(&format!("{}/markets/{market_id}", self.gamma_url))
            .await
            .map_err(sdk_error)?;
        let raw = payload.as_object().ok_or_else(|| {
            PolymarketError::InvalidValue("Gamma market is not an object".to_owned())
        })?;
        let condition = gamma_text(raw, "conditionId").trim_start_matches("0x");
        let decoded = hex::decode(condition).map_err(|error| {
            PolymarketError::InvalidValue(format!("invalid conditionId for {market_id}: {error}"))
        })?;
        let condition_id: [u8; 32] = decoded.try_into().map_err(|value: Vec<u8>| {
            PolymarketError::InvalidValue(format!(
                "conditionId for {market_id} is {} bytes, expected 32",
                value.len()
            ))
        })?;
        Ok(PolymarketSettlementMetadata {
            market_id: market_id.to_owned(),
            condition_id,
            negative_risk: gamma_bool(raw.get("negRisk")).unwrap_or(false),
            closed: gamma_bool(raw.get("closed")).unwrap_or(false),
        })
    }

    pub async fn resolved_outcome_by_slug(
        &self,
        slug: &str,
    ) -> Result<Option<String>, PolymarketError> {
        let markets = self.get_event_markets_by_slug(slug).await?;
        let Some(market) = markets.first() else {
            return Ok(None);
        };
        if market.status != "closed" {
            return Ok(None);
        }
        // A separate market fetch carries the final `outcomePrices` array.
        let payload: serde_json::Value = self
            .http
            .get_json(&format!("{}/markets/{}", self.gamma_url, market.market_id))
            .await
            .map_err(sdk_error)?;
        let outcomes = json_string_array(payload.get("outcomes"));
        let prices = json_scalar_array(payload.get("outcomePrices"));
        Ok(prices
            .iter()
            .position(|price| parse_usd(price).is_ok_and(|value| value >= 999_999))
            .and_then(|index| outcomes.get(index))
            .map(|outcome| outcome.trim().to_ascii_uppercase()))
    }

    pub async fn resolved_outcome_by_market_id(
        &self,
        market_id: &str,
    ) -> Result<Option<String>, PolymarketError> {
        if !market_id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(PolymarketError::InvalidValue(format!(
                "invalid Gamma market id {market_id}"
            )));
        }
        let payload: serde_json::Value = self
            .http
            .get_json(&format!("{}/markets/{market_id}", self.gamma_url))
            .await
            .map_err(sdk_error)?;
        let raw = payload.as_object().ok_or_else(|| {
            PolymarketError::InvalidValue("Gamma market is not an object".to_owned())
        })?;
        if !gamma_bool(raw.get("closed")).unwrap_or(false) {
            return Ok(None);
        }
        let outcomes = json_string_array(raw.get("outcomes"));
        let prices = json_scalar_array(raw.get("outcomePrices"));
        Ok(prices
            .iter()
            .position(|price| parse_usd(price).is_ok_and(|value| value >= 999_999))
            .and_then(|index| outcomes.get(index))
            .map(|outcome| outcome.trim().to_ascii_uppercase()))
    }
}

#[derive(Clone, Debug)]
pub struct PolymarketRelayerOptions {
    pub private_key: String,
    pub wallet_address: String,
    pub api_key: String,
    pub api_key_address: String,
    pub signature: WalletSignature,
    pub polygon_rpc_url: Option<String>,
}

impl PolymarketRelayerOptions {
    pub fn from_env() -> Result<Self, PolymarketError> {
        let execution = PolymarketOptions::from_env()?;
        let wallet_address = execution.funder.ok_or_else(|| {
            PolymarketError::Configuration(
                "POLYMARKET_WALLET_ADDRESS is required for gasless redemption".to_owned(),
            )
        })?;
        Ok(Self {
            private_key: execution.private_key,
            wallet_address,
            api_key: required_env(&["POLYMARKET_RELAYER_API_KEY"])?,
            api_key_address: required_env(&["POLYMARKET_RELAYER_API_KEY_ADDRESS"])?,
            signature: execution.signature,
            polygon_rpc_url: optional_env(&["POLYGON_RPC_URL", "POLYMARKET_RPC_URL"]),
        })
    }
}

#[derive(Clone)]
pub struct PolymarketRelayer {
    client: RelayClient,
    signature: WalletSignature,
    wallet_address: EthersAddress,
}

impl PolymarketRelayer {
    pub async fn new(options: PolymarketRelayerOptions) -> Result<Self, PolymarketError> {
        let wallet: LocalWallet = options.private_key.parse().map_err(sdk_error)?;
        let auth = AuthMethod::relayer_key(&options.api_key, &options.api_key_address);
        let tx_type = match options.signature {
            WalletSignature::Eoa | WalletSignature::Poly1271 => RelayerTxType::Eoa,
            WalletSignature::Proxy => RelayerTxType::Proxy,
            WalletSignature::GnosisSafe => RelayerTxType::Safe,
        };
        let mut client = RelayClient::new(137, wallet, auth, tx_type)
            .await
            .map_err(sdk_error)?;
        if let Some(rpc) = options.polygon_rpc_url {
            client.set_rpc_url(rpc);
        }
        let wallet_address: EthersAddress = options.wallet_address.parse().map_err(sdk_error)?;
        let derived = if options.signature == WalletSignature::Poly1271 {
            client.derive_deposit_wallet_address().map_err(sdk_error)?
        } else {
            client.wallet_address().map_err(sdk_error)?
        };
        if derived != wallet_address {
            return Err(PolymarketError::Configuration(format!(
                "configured wallet {wallet_address:?} does not match the signer-derived {derived:?}"
            )));
        }
        Ok(Self {
            client,
            signature: options.signature,
            wallet_address,
        })
    }

    pub async fn setup_trading_approvals(&self) -> Result<Vec<String>, PolymarketError> {
        let calls = vec![
            operations::approve_pusd_for_ctf_exchange_v2(),
            operations::approve_pusd_for_neg_risk_exchange_v2(),
            operations::approve_pusd_for_ctf_adapter(),
            operations::approve_pusd_for_neg_risk_ctf_adapter(),
            operations::approve_ctf_for_ctf_exchange_v2(),
            operations::approve_ctf_for_neg_risk_exchange_v2(),
            operations::approve_ctf_for_ctf_adapter(),
            operations::approve_ctf_for_neg_risk_ctf_adapter(),
        ];
        if self.signature == WalletSignature::Poly1271 {
            return Ok(vec![
                self.execute_deposit_wallet(calls, "Jupol V2 approvals")
                    .await?,
            ]);
        }
        if self.signature == WalletSignature::Eoa {
            return Err(PolymarketError::Configuration(
                "EOA approvals require a funded direct Polygon transaction; gasless relayer is unavailable"
                    .to_owned(),
            ));
        }
        // Keep Proxy/Safe approval batches small. Large approval batches can
        // exceed the relayer's gas envelope and are difficult to diagnose.
        let mut hashes = Vec::new();
        for call in calls {
            hashes.push(self.execute_legacy(vec![call], "Jupol V2 approval").await?);
        }
        Ok(hashes)
    }

    pub async fn redeem(
        &self,
        metadata: &PolymarketSettlementMetadata,
    ) -> Result<String, PolymarketError> {
        if !metadata.closed {
            return Err(PolymarketError::InvalidValue(format!(
                "market {} is not closed",
                metadata.market_id
            )));
        }
        let adapter = if metadata.negative_risk {
            polymarket_relayer::contracts::NEG_RISK_CTF_COLLATERAL_ADAPTER
        } else {
            polymarket_relayer::contracts::CTF_COLLATERAL_ADAPTER
        };
        let call = redeem_pusd_via_adapter(adapter, metadata.condition_id, &[1, 2]);
        if self.signature == WalletSignature::Poly1271 {
            self.execute_deposit_wallet(vec![call], "Jupol automatic redemption")
                .await
        } else if self.signature == WalletSignature::Eoa {
            Err(PolymarketError::Configuration(
                "EOA redemption requires a funded direct Polygon transaction; gasless relayer is unavailable"
                    .to_owned(),
            ))
        } else {
            self.execute_legacy(vec![call], "Jupol automatic redemption")
                .await
        }
    }

    async fn execute_deposit_wallet(
        &self,
        calls: Vec<Transaction>,
        description: &str,
    ) -> Result<String, PolymarketError> {
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(sdk_error)?
            .as_secs()
            .saturating_add(240);
        let calls = calls.into_iter().map(DepositWalletCall::from).collect();
        let handle = self
            .client
            .execute_deposit_wallet_batch(
                calls,
                Some(self.wallet_address),
                deadline,
                Some(description),
            )
            .await
            .map_err(sdk_error)?;
        relay_result(handle.wait().await.map_err(sdk_error)?)
    }

    async fn execute_legacy(
        &self,
        calls: Vec<Transaction>,
        description: &str,
    ) -> Result<String, PolymarketError> {
        let handle = self
            .client
            .execute(calls, description)
            .await
            .map_err(sdk_error)?;
        relay_result(handle.wait().await.map_err(sdk_error)?)
    }
}

fn redeem_pusd_via_adapter(
    adapter: &str,
    condition_id: [u8; 32],
    index_sets: &[u64],
) -> Transaction {
    let collateral: EthersAddress = polymarket_relayer::contracts::PUSD
        .parse()
        .expect("canonical pUSD address");
    let selector = keccak256(b"redeemPositions(address,bytes32,bytes32,uint256[])");
    let mut calldata = selector[..4].to_vec();
    calldata.extend_from_slice(&encode(&[
        Token::Address(collateral),
        Token::FixedBytes(vec![0_u8; 32]),
        Token::FixedBytes(condition_id.to_vec()),
        Token::Array(
            index_sets
                .iter()
                .map(|&index| Token::Uint(EthersU256::from(index)))
                .collect(),
        ),
    ]));
    Transaction {
        to: adapter.to_owned(),
        data: format!("0x{}", hex::encode(calldata)),
        value: "0".to_owned(),
    }
}

fn relay_result(result: TxResult) -> Result<String, PolymarketError> {
    if !result.state.is_success() {
        return Err(PolymarketError::Sdk(format!(
            "relayer state={:?} error={}",
            result.state,
            result.error.as_deref().unwrap_or("none")
        )));
    }
    result.tx_hash.ok_or_else(|| {
        PolymarketError::Sdk("relayer confirmed without a transaction hash".to_owned())
    })
}

fn parse_gamma_event(
    value: &serde_json::Value,
    gamma_url: &str,
) -> Result<Vec<VenueMarket>, PolymarketError> {
    let raw = value
        .as_object()
        .ok_or_else(|| PolymarketError::InvalidValue("Gamma event is not an object".to_owned()))?;
    let event_id = gamma_text(raw, "id");
    let event_title = gamma_text(raw, "title");
    raw.get("markets")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .map(|market| {
            parse_gamma_market(
                market,
                (!event_id.is_empty()).then(|| event_id.to_owned()),
                event_title,
                gamma_url,
            )
        })
        .collect()
}

fn parse_gamma_market(
    value: &serde_json::Value,
    event_id: Option<String>,
    event_title: &str,
    gamma_url: &str,
) -> Result<VenueMarket, PolymarketError> {
    let raw = value
        .as_object()
        .ok_or_else(|| PolymarketError::InvalidValue("Gamma market is not an object".to_owned()))?;
    let market_id = gamma_text(raw, "id");
    if market_id.is_empty() {
        return Err(PolymarketError::InvalidValue(
            "Gamma market is missing id".to_owned(),
        ));
    }
    let closed = gamma_bool(raw.get("closed")).unwrap_or(false);
    let active = gamma_bool(raw.get("active")).unwrap_or(!closed);
    let accepting_orders = gamma_bool(raw.get("acceptingOrders")).unwrap_or(active);
    let outcomes = json_string_array(raw.get("outcomes"));
    let best_bid = raw
        .get("bestBid")
        .and_then(gamma_scalar)
        .and_then(|value| parse_usd(&value).ok());
    let best_ask = raw
        .get("bestAsk")
        .and_then(gamma_scalar)
        .and_then(|value| parse_usd(&value).ok());
    let fee_schedule = raw.get("feeSchedule").and_then(|value| {
        let fee = value.as_object()?;
        Some(MarketFeeSchedule {
            rate: gamma_scalar(fee.get("rate")?)?,
            exponent: fee
                .get("exponent")
                .and_then(serde_json::Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())?,
            taker_only: gamma_bool(fee.get("takerOnly"))?,
        })
    });
    Ok(VenueMarket {
        venue: Venue::Polymarket,
        provider: "polymarket".to_owned(),
        event_id,
        market_id: market_id.to_owned(),
        title: {
            let question = gamma_text(raw, "question");
            if question.is_empty() {
                gamma_text(raw, "groupItemTitle").to_owned()
            } else {
                question.to_owned()
            }
        },
        event_title: event_title.to_owned(),
        rules_primary: gamma_text(raw, "description").to_owned(),
        rules_secondary: gamma_text(raw, "resolutionSource").to_owned(),
        status: if !closed && active && accepting_orders {
            "open"
        } else if closed {
            "closed"
        } else {
            "inactive"
        }
        .to_owned(),
        open_time_ms: gamma_iso_ms(raw.get("startDate")),
        close_time_ms: gamma_iso_ms(raw.get("endDate")),
        clob_token_ids: json_string_array(raw.get("clobTokenIds")),
        outcomes,
        outcome_mint: None,
        pricing: MarketPricing {
            buy_yes_micro_usd: best_ask,
            sell_yes_micro_usd: best_bid,
            buy_no_micro_usd: best_bid.and_then(|value| ONE_USD_MICRO.checked_sub(value)),
            sell_no_micro_usd: best_ask.and_then(|value| ONE_USD_MICRO.checked_sub(value)),
        },
        fee_schedule,
        source_url: format!("{gamma_url}/markets/{market_id}"),
    })
}

fn gamma_text<'a>(raw: &'a serde_json::Map<String, serde_json::Value>, field: &str) -> &'a str {
    raw.get(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
}

fn gamma_bool(value: Option<&serde_json::Value>) -> Option<bool> {
    value.and_then(serde_json::Value::as_bool)
}

fn gamma_scalar(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.is_number().then(|| value.to_string()))
}

fn json_string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    let decoded = match value {
        Some(serde_json::Value::String(text)) => serde_json::from_str(text).ok(),
        Some(serde_json::Value::Array(values)) => Some(values.clone()),
        _ => None,
    };
    decoded
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn json_scalar_array(value: Option<&serde_json::Value>) -> Vec<String> {
    let decoded = match value {
        Some(serde_json::Value::String(text)) => serde_json::from_str(text).ok(),
        Some(serde_json::Value::Array(values)) => Some(values.clone()),
        _ => None,
    };
    decoded
        .into_iter()
        .flatten()
        .filter_map(|value| gamma_scalar(&value))
        .collect()
}

fn gamma_iso_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value?.as_str()?)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

#[derive(Clone)]
pub struct PolymarketMarketData {
    client: Client<Unauthenticated>,
}

impl PolymarketMarketData {
    pub fn new(clob_url: Option<&str>) -> Result<Self, PolymarketError> {
        let client = Client::new(clob_url.unwrap_or(DEFAULT_CLOB_URL), Config::default())
            .map_err(sdk_error)?;
        Ok(Self { client })
    }

    pub async fn binary_order_book(
        &self,
        market_id: &str,
        yes_token_id: &str,
        no_token_id: &str,
    ) -> Result<BinaryOrderBook, PolymarketError> {
        let yes_token = parse_token(yes_token_id)?;
        let no_token = parse_token(no_token_id)?;
        let (yes, no) = tokio::try_join!(self.order_book(yes_token), self.order_book(no_token))?;
        let received_at_ms = unix_timestamp_ms();
        let source_timestamp_ms = Some(
            yes.timestamp
                .timestamp_millis()
                .min(no.timestamp.timestamp_millis()),
        );
        Ok(BinaryOrderBook {
            venue: Venue::Polymarket,
            provider: "polymarket-clob-v2".to_owned(),
            market_id: market_id.to_owned(),
            received_at_ms,
            source_timestamp_ms,
            yes: convert_side_book(&yes)?,
            no: convert_side_book(&no)?,
        })
    }

    async fn order_book(
        &self,
        token_id: U256,
    ) -> Result<
        polymarket_client_sdk_v2::clob::types::response::OrderBookSummaryResponse,
        PolymarketError,
    > {
        self.client
            .order_book(
                &OrderBookSummaryRequest::builder()
                    .token_id(token_id)
                    .build(),
            )
            .await
            .map_err(sdk_error)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolymarketStreamMarket {
    pub market_id: String,
    pub yes_token_id: String,
    pub no_token_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolymarketStreamUpdate {
    pub market_id: String,
    pub book: BinaryOrderBook,
}

#[derive(Default)]
struct MutableTokenBook {
    initialized: bool,
    bids: HashMap<Micro, Micro>,
    asks: HashMap<Micro, Micro>,
    source_timestamp_ms: Option<i64>,
}

struct StreamBookState {
    market: PolymarketStreamMarket,
    tokens: HashMap<String, MutableTokenBook>,
}

impl StreamBookState {
    fn new(market: PolymarketStreamMarket) -> Self {
        let mut tokens = HashMap::new();
        tokens.insert(market.yes_token_id.clone(), MutableTokenBook::default());
        tokens.insert(market.no_token_id.clone(), MutableTokenBook::default());
        Self { market, tokens }
    }

    fn apply_payload(
        &mut self,
        payload: &serde_json::Value,
        received_at_ms: i64,
    ) -> Result<Option<BinaryOrderBook>, PolymarketError> {
        let messages = payload
            .as_array()
            .map_or_else(|| std::slice::from_ref(payload), Vec::as_slice);
        let mut changed = false;
        for message in messages {
            let Some(object) = message.as_object() else {
                continue;
            };
            match gamma_text(object, "event_type") {
                "book" => changed |= self.apply_snapshot(object)?,
                "price_change" => changed |= self.apply_price_changes(object)?,
                _ => {}
            }
        }
        if !changed {
            return Ok(None);
        }
        let Some(yes) = self.tokens.get(&self.market.yes_token_id) else {
            return Ok(None);
        };
        let Some(no) = self.tokens.get(&self.market.no_token_id) else {
            return Ok(None);
        };
        if !yes.initialized || !no.initialized {
            return Ok(None);
        }
        Ok(Some(BinaryOrderBook {
            venue: Venue::Polymarket,
            provider: "polymarket-market-websocket".to_owned(),
            market_id: self.market.market_id.clone(),
            received_at_ms,
            source_timestamp_ms: match (yes.source_timestamp_ms, no.source_timestamp_ms) {
                (Some(left), Some(right)) => Some(left.max(right)),
                (left, right) => left.or(right),
            },
            yes: stream_side_book(yes),
            no: stream_side_book(no),
        }))
    }

    fn apply_snapshot(
        &mut self,
        object: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<bool, PolymarketError> {
        let asset_id = gamma_text(object, "asset_id");
        let Some(token) = self.tokens.get_mut(asset_id) else {
            return Ok(false);
        };
        token.bids = stream_levels(object.get("bids"))?;
        token.asks = stream_levels(object.get("asks"))?;
        token.source_timestamp_ms = stream_timestamp_ms(object.get("timestamp"));
        token.initialized = true;
        Ok(true)
    }

    fn apply_price_changes(
        &mut self,
        object: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<bool, PolymarketError> {
        let timestamp = stream_timestamp_ms(object.get("timestamp"));
        let mut changed = false;
        let Some(price_changes) = object
            .get("price_changes")
            .and_then(serde_json::Value::as_array)
        else {
            return Ok(false);
        };
        for change in price_changes {
            let Some(change) = change.as_object() else {
                continue;
            };
            let asset_id = gamma_text(change, "asset_id");
            let Some(token) = self.tokens.get_mut(asset_id) else {
                continue;
            };
            if !token.initialized {
                continue;
            }
            let price = parse_usd(gamma_text(change, "price")).map_err(|error| {
                PolymarketError::InvalidValue(format!("invalid stream price: {error}"))
            })?;
            let size = parse_contracts(gamma_text(change, "size")).map_err(|error| {
                PolymarketError::InvalidValue(format!("invalid stream size: {error}"))
            })?;
            let levels = match gamma_text(change, "side").to_ascii_uppercase().as_str() {
                "BUY" => &mut token.bids,
                "SELL" => &mut token.asks,
                _ => continue,
            };
            if size == 0 {
                levels.remove(&price);
            } else {
                levels.insert(price, size);
            }
            token.source_timestamp_ms = timestamp.or(token.source_timestamp_ms);
            changed = true;
        }
        Ok(changed)
    }
}

#[must_use]
pub fn spawn_market_stream(
    markets: Vec<PolymarketStreamMarket>,
    websocket_url: Option<String>,
) -> mpsc::Receiver<Result<PolymarketStreamUpdate, PolymarketError>> {
    let (sender, receiver) = mpsc::channel(256);
    tokio::spawn(async move {
        if markets.is_empty() {
            let _ = sender
                .send(Err(PolymarketError::InvalidValue(
                    "market stream needs at least one market".to_owned(),
                )))
                .await;
            return;
        }
        let url = websocket_url.unwrap_or_else(|| DEFAULT_MARKET_WEBSOCKET_URL.to_owned());
        let mut attempt = 0_u32;
        while !sender.is_closed() {
            attempt = attempt.saturating_add(1);
            match run_market_stream_once(&url, &markets, &sender).await {
                Ok(()) if sender.is_closed() => break,
                Ok(()) => {}
                Err(error) => {
                    if sender.send(Err(error)).await.is_err() {
                        break;
                    }
                }
            }
            let delay = Duration::from_millis(500_u64.saturating_mul(1_u64 << attempt.min(5)));
            tokio::time::sleep(delay.min(Duration::from_secs(15))).await;
        }
    });
    receiver
}

async fn run_market_stream_once(
    url: &str,
    markets: &[PolymarketStreamMarket],
    sender: &mpsc::Sender<Result<PolymarketStreamUpdate, PolymarketError>>,
) -> Result<(), PolymarketError> {
    let (socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| {
            PolymarketError::Sdk(format!("market WebSocket connect failed: {error}"))
        })?;
    let (mut write, mut read) = socket.split();
    let asset_ids = markets
        .iter()
        .flat_map(|market| [&market.yes_token_id, &market.no_token_id])
        .collect::<Vec<_>>();
    write
        .send(Message::Text(
            serde_json::json!({
                "assets_ids": asset_ids,
                "type": "market",
                "custom_feature_enabled": true,
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|error| {
            PolymarketError::Sdk(format!("market WebSocket subscribe failed: {error}"))
        })?;
    let mut states = markets
        .iter()
        .cloned()
        .map(|market| (market.market_id.clone(), StreamBookState::new(market)))
        .collect::<HashMap<_, _>>();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                write.send(Message::Text("PING".into())).await.map_err(|error| {
                    PolymarketError::Sdk(format!("market WebSocket heartbeat failed: {error}"))
                })?;
            }
            message = read.next() => {
                let Some(message) = message else {
                    return Err(PolymarketError::Sdk("market WebSocket closed".to_owned()));
                };
                let message = message.map_err(|error| {
                    PolymarketError::Sdk(format!("market WebSocket read failed: {error}"))
                })?;
                let Message::Text(text) = message else { continue; };
                if text == "PONG" { continue; }
                let payload: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(error) => {
                        if sender.send(Err(PolymarketError::InvalidValue(format!(
                            "ignored malformed market WebSocket JSON: {error}"
                        )))).await.is_err() { return Ok(()); }
                        continue;
                    }
                };
                let received_at_ms = unix_timestamp_ms();
                for (market_id, state) in &mut states {
                    match state.apply_payload(&payload, received_at_ms) {
                        Ok(Some(book)) => {
                            if sender.send(Ok(PolymarketStreamUpdate {
                                market_id: market_id.clone(),
                                book,
                            })).await.is_err() { return Ok(()); }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            if sender.send(Err(error)).await.is_err() { return Ok(()); }
                        }
                    }
                }
            }
        }
    }
}

fn stream_levels(
    raw: Option<&serde_json::Value>,
) -> Result<HashMap<Micro, Micro>, PolymarketError> {
    let mut levels = HashMap::new();
    let Some(raw) = raw.and_then(serde_json::Value::as_array) else {
        return Ok(levels);
    };
    for value in raw {
        let Some(value) = value.as_object() else {
            continue;
        };
        let price = parse_usd(gamma_text(value, "price")).map_err(|error| {
            PolymarketError::InvalidValue(format!("invalid stream price: {error}"))
        })?;
        let size = parse_contracts(gamma_text(value, "size")).map_err(|error| {
            PolymarketError::InvalidValue(format!("invalid stream size: {error}"))
        })?;
        if size > 0 {
            levels.insert(price, size);
        }
    }
    Ok(levels)
}

fn stream_side_book(token: &MutableTokenBook) -> SideOrderBook {
    let mut bids = token
        .bids
        .iter()
        .map(|(&price, &contracts)| BookLevel::new(price, contracts))
        .collect::<Vec<_>>();
    bids.sort_unstable_by(|left, right| right.price_micro_usd.cmp(&left.price_micro_usd));
    let mut asks = token
        .asks
        .iter()
        .map(|(&price, &contracts)| BookLevel::new(price, contracts))
        .collect::<Vec<_>>();
    asks.sort_unstable_by_key(|level| level.price_micro_usd);
    SideOrderBook { bids, asks }
}

fn stream_timestamp_ms(raw: Option<&serde_json::Value>) -> Option<i64> {
    raw.and_then(|value| {
        value.as_i64().or_else(|| {
            value
                .as_u64()
                .and_then(|timestamp| i64::try_from(timestamp).ok())
                .or_else(|| value.as_str()?.parse().ok())
        })
    })
}

pub struct PreparedFokOrder {
    signed: SignedOrder,
    side: Side,
    requested_contracts_micro: Micro,
    prepared_at_ms: i64,
}

impl fmt::Debug for PreparedFokOrder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedFokOrder")
            .field("side", &self.side)
            .field("requested_contracts_micro", &self.requested_contracts_micro)
            .field("prepared_at_ms", &self.prepared_at_ms)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolymarketFill {
    pub order_id: String,
    pub side: LiveOrderSide,
    pub requested_contracts_micro: Micro,
    pub filled_contracts_micro: Micro,
    pub gross_micro_usd: Micro,
    pub submitted_at_ms: i64,
    pub transaction_hashes: Vec<String>,
    pub trade_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveOrderSide {
    Buy,
    Sell,
}

#[derive(Clone)]
pub struct PolymarketExecutor {
    signer: PrivateKeySigner,
    client: Client<Authenticated<Normal>>,
    account: Address,
    signature: WalletSignature,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PolymarketReadiness {
    pub collateral_balance_micro_usd: Micro,
    pub minimum_allowance_micro_usd: Micro,
}

impl PolymarketExecutor {
    pub async fn new(options: PolymarketOptions) -> Result<Self, PolymarketError> {
        let signer = LocalSigner::from_str(options.private_key.trim())
            .map_err(sdk_error)?
            .with_chain_id(Some(POLYGON));
        let funder = options
            .funder
            .as_deref()
            .map(Address::from_str)
            .transpose()
            .map_err(sdk_error)?;
        let account = funder.unwrap_or_else(|| signer.address());
        let base = Client::new(&options.clob_url, Config::default()).map_err(sdk_error)?;
        let mut authentication = base.authentication_builder(&signer);
        if let Some(funder) = funder {
            authentication = authentication
                .funder(funder)
                .signature_type(options.signature.sdk());
        }
        let client = authentication.authenticate().await.map_err(sdk_error)?;
        Ok(Self {
            signer,
            client,
            account,
            signature: options.signature,
        })
    }

    #[must_use]
    pub const fn account(&self) -> Address {
        self.account
    }

    #[must_use]
    pub const fn signature_type(&self) -> WalletSignature {
        self.signature
    }

    pub async fn collateral_balance_micro_usd(&self) -> Result<Micro, PolymarketError> {
        let response = self
            .client
            .balance_allowance(
                BalanceAllowanceRequest::builder()
                    .asset_type(AssetType::Collateral)
                    .build(),
            )
            .await
            .map_err(sdk_error)?;
        decimal_atomic_micro(response.balance, "collateral balance")
    }

    pub async fn refresh_collateral_balance_micro_usd(&self) -> Result<Micro, PolymarketError> {
        let request = BalanceAllowanceRequest::builder()
            .asset_type(AssetType::Collateral)
            .build();
        self.client
            .update_balance_allowance(request)
            .await
            .map_err(sdk_error)?;
        self.collateral_balance_micro_usd().await
    }

    pub async fn assert_ready(
        &self,
        minimum_collateral_micro_usd: Micro,
    ) -> Result<PolymarketReadiness, PolymarketError> {
        let response = self
            .client
            .balance_allowance(
                BalanceAllowanceRequest::builder()
                    .asset_type(AssetType::Collateral)
                    .build(),
            )
            .await
            .map_err(sdk_error)?;
        let collateral_balance_micro_usd =
            decimal_atomic_micro(response.balance, "collateral balance")?;
        let mut allowances = response
            .allowances
            .values()
            .map(|allowance| parse_atomic_micro_saturating(allowance, "collateral allowance"))
            .collect::<Result<Vec<_>, _>>()?;
        allowances.sort_unstable();
        let minimum_allowance_micro_usd = allowances.first().copied().ok_or_else(|| {
            PolymarketError::Configuration(
                "no collateral allowance records; run setup-approvals".to_owned(),
            )
        })?;
        if collateral_balance_micro_usd < minimum_collateral_micro_usd {
            return Err(PolymarketError::Configuration(format!(
                "collateral {collateral_balance_micro_usd} is below required {minimum_collateral_micro_usd} micro-USD"
            )));
        }
        if minimum_allowance_micro_usd < minimum_collateral_micro_usd {
            return Err(PolymarketError::Configuration(format!(
                "minimum collateral allowance {minimum_allowance_micro_usd} is below required {minimum_collateral_micro_usd}; run setup-approvals"
            )));
        }
        Ok(PolymarketReadiness {
            collateral_balance_micro_usd,
            minimum_allowance_micro_usd,
        })
    }

    pub async fn conditional_balance_micro(
        &self,
        token_id: &str,
    ) -> Result<Micro, PolymarketError> {
        let response = self
            .client
            .balance_allowance(
                BalanceAllowanceRequest::builder()
                    .asset_type(AssetType::Conditional)
                    .token_id(parse_token(token_id)?)
                    .build(),
            )
            .await
            .map_err(sdk_error)?;
        decimal_atomic_micro(response.balance, "conditional-token balance")
    }

    pub async fn refresh_conditional_balance_micro(
        &self,
        token_id: &str,
    ) -> Result<Micro, PolymarketError> {
        let request = BalanceAllowanceRequest::builder()
            .asset_type(AssetType::Conditional)
            .token_id(parse_token(token_id)?)
            .build();
        self.client
            .update_balance_allowance(request)
            .await
            .map_err(sdk_error)?;
        self.conditional_balance_micro(token_id).await
    }

    pub async fn best_bid_ask_micro_usd(
        &self,
        token_id: &str,
    ) -> Result<(Option<Micro>, Option<Micro>), PolymarketError> {
        let response = self
            .client
            .order_book(
                &OrderBookSummaryRequest::builder()
                    .token_id(parse_token(token_id)?)
                    .build(),
            )
            .await
            .map_err(sdk_error)?;
        let best_bid = response
            .bids
            .iter()
            .map(|level| decimal_usd(level.price))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .max();
        let best_ask = response
            .asks
            .iter()
            .map(|level| decimal_usd(level.price))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .min();
        Ok((best_bid, best_ask))
    }

    pub async fn prime_token(&self, token_id: &str) -> Result<(), PolymarketError> {
        let token_id = parse_token(token_id)?;
        let (version, tick_size) =
            tokio::join!(self.client.version(), self.client.tick_size(token_id));
        version.map_err(sdk_error)?;
        tick_size.map_err(sdk_error)?;
        Ok(())
    }

    pub async fn prepare_buy_fok(
        &self,
        token_id: &str,
        limit_price_micro_usd: Micro,
        contracts_micro: Micro,
    ) -> Result<PreparedFokOrder, PolymarketError> {
        self.prepare_fok(token_id, Side::Buy, limit_price_micro_usd, contracts_micro)
            .await
    }

    pub async fn prepare_sell_fok(
        &self,
        token_id: &str,
        limit_price_micro_usd: Micro,
        contracts_micro: Micro,
    ) -> Result<PreparedFokOrder, PolymarketError> {
        self.prepare_fok(token_id, Side::Sell, limit_price_micro_usd, contracts_micro)
            .await
    }

    async fn prepare_fok(
        &self,
        token_id: &str,
        side: Side,
        limit_price_micro_usd: Micro,
        contracts_micro: Micro,
    ) -> Result<PreparedFokOrder, PolymarketError> {
        if !(1..1_000_000).contains(&limit_price_micro_usd) {
            return Err(PolymarketError::InvalidValue(format!(
                "limit price must be between 0 and 1 USD, got {}",
                format_usd(limit_price_micro_usd)
            )));
        }
        if contracts_micro < 10_000 {
            return Err(PolymarketError::InvalidValue(
                "FOK size must be at least 0.01 contracts and have at most two decimals".to_owned(),
            ));
        }
        // A marketable order has two independent precision constraints: the share
        // amount has at most four decimals and its USDC leg has at most two. A
        // two-decimal size alone is insufficient (for example 14.11 * $0.34).
        let normalized_contracts =
            normalize_fok_contracts_for_price(limit_price_micro_usd, contracts_micro);
        if normalized_contracts < 10_000 {
            return Err(PolymarketError::InvalidValue(format!(
                "FOK size {} has no positive quantity satisfying the CLOB amount precision at price {}",
                format_contracts(contracts_micro),
                format_usd(limit_price_micro_usd),
            )));
        }
        let signable = self
            .client
            .limit_order()
            .token_id(parse_token(token_id)?)
            .side(side)
            .price(decimal_from_usd(limit_price_micro_usd)?)
            .size(decimal_from_contracts(normalized_contracts)?)
            .order_type(OrderType::FOK)
            .build()
            .await
            .map_err(sdk_error)?;
        let signed = self
            .client
            .sign(&self.signer, signable)
            .await
            .map_err(sdk_error)?;
        validate_fok_amount_precision(&signed, side)?;
        Ok(PreparedFokOrder {
            signed,
            side,
            requested_contracts_micro: normalized_contracts,
            prepared_at_ms: unix_timestamp_ms(),
        })
    }

    pub async fn submit_fok(
        &self,
        prepared: PreparedFokOrder,
    ) -> Result<PolymarketFill, PolymarketError> {
        let submitted_at_ms = unix_timestamp_ms();
        let response = self
            .client
            .post_order(prepared.signed)
            .await
            .map_err(classify_submission_error)?;
        if !response.success || !matches!(response.status, OrderStatusType::Matched) {
            return Err(PolymarketError::Rejected(format!(
                "order_id={} success={} status={} error={}",
                response.order_id,
                response.success,
                response.status,
                response.error_msg.as_deref().unwrap_or("none")
            )));
        }
        let (filled_contracts_micro, gross_micro_usd, side) = match prepared.side {
            Side::Buy => (
                decimal_contracts(response.taking_amount)?,
                decimal_usd(response.making_amount)?,
                LiveOrderSide::Buy,
            ),
            Side::Sell => (
                decimal_contracts(response.making_amount)?,
                decimal_usd(response.taking_amount)?,
                LiveOrderSide::Sell,
            ),
            Side::Unknown => {
                return Err(PolymarketError::AmbiguousSubmission(
                    "SDK returned an unknown order side".to_owned(),
                ));
            }
            _ => {
                return Err(PolymarketError::AmbiguousSubmission(
                    "SDK returned an unsupported order side".to_owned(),
                ));
            }
        };
        if filled_contracts_micro <= 0 || gross_micro_usd <= 0 {
            return Err(PolymarketError::AmbiguousSubmission(format!(
                "matched order {} reported zero execution amounts",
                response.order_id
            )));
        }
        Ok(PolymarketFill {
            order_id: response.order_id,
            side,
            requested_contracts_micro: prepared.requested_contracts_micro,
            filled_contracts_micro,
            gross_micro_usd,
            submitted_at_ms,
            transaction_hashes: response
                .transaction_hashes
                .into_iter()
                .map(|hash| hash.to_string())
                .collect(),
            trade_ids: response.trade_ids,
        })
    }
}

/// Floors a requested FOK quantity to the greatest value for which the signed
/// share amount has at most four decimals and the USDC amount has at most two.
#[must_use]
pub fn normalize_fok_contracts_for_price(
    limit_price_micro_usd: Micro,
    contracts_micro: Micro,
) -> Micro {
    if limit_price_micro_usd <= 0 || contracts_micro <= 0 {
        return 0;
    }
    let requested_share_cents = contracts_micro / 10_000;
    let divisor = gcd_micro(limit_price_micro_usd, ONE_USD_MICRO);
    let share_cent_step = ONE_USD_MICRO / divisor;
    (requested_share_cents / share_cent_step) * share_cent_step * 10_000
}

fn gcd_micro(mut left: Micro, mut right: Micro) -> Micro {
    left = left.abs();
    right = right.abs();
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

fn validate_fok_amount_precision(signed: &SignedOrder, side: Side) -> Result<(), PolymarketError> {
    let (maker_amount, taker_amount) = match &signed.payload {
        OrderPayload::V1(payload) => (&payload.order.makerAmount, &payload.order.takerAmount),
        OrderPayload::V2(payload) => (&payload.order.makerAmount, &payload.order.takerAmount),
        _ => {
            return Err(PolymarketError::InvalidValue(
                "unsupported signed CLOB order version".to_owned(),
            ));
        }
    };
    let cents = U256::from(10_000_u64);
    let four_decimals = U256::from(100_u64);
    let (usdc_amount, share_amount) = match side {
        Side::Buy => (maker_amount, taker_amount),
        Side::Sell => (taker_amount, maker_amount),
        _ => {
            return Err(PolymarketError::InvalidValue(
                "unsupported signed CLOB order side".to_owned(),
            ));
        }
    };
    if *usdc_amount % cents != U256::ZERO || *share_amount % four_decimals != U256::ZERO {
        return Err(PolymarketError::InvalidValue(format!(
            "signed FOK amounts violate CLOB precision: USDC={usdc_amount}, shares={share_amount}"
        )));
    }
    Ok(())
}

fn convert_side_book(
    response: &polymarket_client_sdk_v2::clob::types::response::OrderBookSummaryResponse,
) -> Result<SideOrderBook, PolymarketError> {
    let mut bids = response
        .bids
        .iter()
        .map(|level| convert_level(level.price, level.size))
        .collect::<Result<Vec<_>, _>>()?;
    let mut asks = response
        .asks
        .iter()
        .map(|level| convert_level(level.price, level.size))
        .collect::<Result<Vec<_>, _>>()?;
    bids.sort_unstable_by(|left, right| right.price_micro_usd.cmp(&left.price_micro_usd));
    asks.sort_unstable_by_key(|level| level.price_micro_usd);
    Ok(SideOrderBook { bids, asks })
}

fn convert_level(price: Decimal, size: Decimal) -> Result<BookLevel, PolymarketError> {
    Ok(BookLevel::new(
        decimal_usd(price)?,
        decimal_contracts(size)?,
    ))
}

fn decimal_from_usd(value: Micro) -> Result<Decimal, PolymarketError> {
    Decimal::from_str(&format_usd(value)).map_err(sdk_error)
}

fn decimal_from_contracts(value: Micro) -> Result<Decimal, PolymarketError> {
    Decimal::from_str(&format_contracts(value)).map_err(sdk_error)
}

fn decimal_usd(value: Decimal) -> Result<Micro, PolymarketError> {
    parse_usd(&value.to_string()).map_err(|error| PolymarketError::InvalidValue(error.to_string()))
}

fn decimal_contracts(value: Decimal) -> Result<Micro, PolymarketError> {
    parse_contracts(&value.to_string())
        .map_err(|error| PolymarketError::InvalidValue(error.to_string()))
}

fn decimal_atomic_micro(value: Decimal, label: &str) -> Result<Micro, PolymarketError> {
    parse_atomic_micro(&value.to_string(), label)
}

fn parse_atomic_micro(value: &str, label: &str) -> Result<Micro, PolymarketError> {
    let (whole, fractional) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fractional.bytes().any(|byte| byte != b'0')
    {
        return Err(PolymarketError::InvalidValue(format!(
            "{label} is not a non-negative integer atomic amount: {value}"
        )));
    }
    whole.parse().map_err(|error| {
        PolymarketError::InvalidValue(format!("invalid {label} atomic amount {value}: {error}"))
    })
}

fn parse_atomic_micro_saturating(value: &str, label: &str) -> Result<Micro, PolymarketError> {
    match parse_atomic_micro(value, label) {
        Ok(value) => Ok(value),
        Err(_) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
            Ok(Micro::MAX)
        }
        Err(error) => Err(error),
    }
}

fn parse_token(value: &str) -> Result<U256, PolymarketError> {
    U256::from_str(value.trim())
        .map_err(|error| PolymarketError::InvalidValue(format!("token id {value}: {error}")))
}

fn sdk_error(error: impl fmt::Display) -> PolymarketError {
    PolymarketError::Sdk(error.to_string())
}

fn classify_submission_error(error: impl fmt::Display) -> PolymarketError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    let is_definitive_client_rejection = lower.contains("http 400")
        || lower.contains("status 400")
        || lower.contains("400 bad request")
        || lower.contains("http 422")
        || lower.contains("status 422")
        || lower.contains("invalid amount")
        || lower.contains("min size")
        || lower.contains("precision")
        || lower.contains("couldn't be fully filled")
        || lower.contains("could not be fully filled")
        || lower.contains("fully filled or killed");
    if is_definitive_client_rejection {
        PolymarketError::Rejected(message)
    } else {
        PolymarketError::AmbiguousSubmission(format!(
            "POST /order returned no authoritative fill state: {message}"
        ))
    }
}

fn required_env(names: &[&str]) -> Result<String, PolymarketError> {
    optional_env(names).ok_or_else(|| {
        PolymarketError::Configuration(format!(
            "missing one of the required environment variables: {}",
            names.join(", ")
        ))
    })
}

fn optional_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn unix_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_supported_wallet_signatures() {
        assert_eq!(
            WalletSignature::from_str("eoa").unwrap(),
            WalletSignature::Eoa
        );
        assert_eq!(
            WalletSignature::from_str("proxy").unwrap(),
            WalletSignature::Proxy
        );
        assert_eq!(
            WalletSignature::from_str("safe").unwrap(),
            WalletSignature::GnosisSafe
        );
        assert_eq!(
            WalletSignature::from_str("poly1271").unwrap(),
            WalletSignature::Poly1271
        );
        assert!(WalletSignature::from_str("bad").is_err());
    }

    #[test]
    fn fixed_decimal_round_trip_is_exact() {
        assert_eq!(
            decimal_usd(decimal_from_usd(576_000).unwrap()).unwrap(),
            576_000
        );
        assert_eq!(
            decimal_contracts(decimal_from_contracts(12_340_000).unwrap()).unwrap(),
            12_340_000
        );
    }

    #[test]
    fn fok_quantity_satisfies_both_market_order_precision_limits() {
        assert_eq!(
            normalize_fok_contracts_for_price(340_000, 14_110_000),
            14_000_000
        );
        assert_eq!(
            normalize_fok_contracts_for_price(200_000, 6_480_000),
            6_450_000
        );
        assert_eq!(
            normalize_fok_contracts_for_price(180_000, 8_000_000),
            8_000_000
        );
        assert_eq!(
            normalize_fok_contracts_for_price(500_000, 11_084_672),
            11_080_000
        );
    }

    #[test]
    fn wallet_balances_are_already_atomic_micro_units() {
        assert_eq!(
            decimal_atomic_micro(Decimal::from_str("74840000").unwrap(), "balance").unwrap(),
            74_840_000
        );
        assert_eq!(
            parse_atomic_micro_saturating(
                "115792089237316195423570985008687907853269984665640564039457584007913129639935",
                "allowance",
            )
            .unwrap(),
            Micro::MAX
        );
    }

    #[test]
    fn v2_redemption_targets_the_pusd_collateral_adapter() {
        let call = redeem_pusd_via_adapter(
            polymarket_relayer::contracts::CTF_COLLATERAL_ADAPTER,
            [7_u8; 32],
            &[1, 2],
        );
        assert_eq!(
            call.to,
            polymarket_relayer::contracts::CTF_COLLATERAL_ADAPTER
        );
        let selector =
            hex::encode(&keccak256(b"redeemPositions(address,bytes32,bytes32,uint256[])")[..4]);
        assert!(call.data.starts_with(&format!("0x{selector}")));
    }

    #[test]
    fn websocket_state_builds_and_updates_both_outcomes() {
        let mut state = StreamBookState::new(PolymarketStreamMarket {
            market_id: "market-1".to_owned(),
            yes_token_id: "yes-token".to_owned(),
            no_token_id: "no-token".to_owned(),
        });
        let snapshots = serde_json::json!([
            {
                "event_type": "book",
                "asset_id": "yes-token",
                "timestamp": "1000",
                "bids": [{"price": "0.40", "size": "10"}],
                "asks": [{"price": "0.42", "size": "8"}]
            },
            {
                "event_type": "book",
                "asset_id": "no-token",
                "timestamp": "1001",
                "bids": [{"price": "0.57", "size": "9"}],
                "asks": [{"price": "0.59", "size": "7"}]
            }
        ]);
        let book = state.apply_payload(&snapshots, 2_000).unwrap().unwrap();
        assert_eq!(book.provider, "polymarket-market-websocket");
        assert_eq!(book.source_timestamp_ms, Some(1_001));
        assert_eq!(book.yes.asks[0], BookLevel::new(420_000, 8_000_000));
        assert_eq!(book.no.asks[0], BookLevel::new(590_000, 7_000_000));

        let change = serde_json::json!({
            "event_type": "price_change",
            "timestamp": "1002",
            "price_changes": [{
                "asset_id": "yes-token",
                "side": "SELL",
                "price": "0.41",
                "size": "4.5"
            }]
        });
        let book = state.apply_payload(&change, 2_001).unwrap().unwrap();
        assert_eq!(book.yes.asks[0], BookLevel::new(410_000, 4_500_000));
        assert_eq!(book.source_timestamp_ms, Some(1_002));
    }

    #[test]
    fn definitive_fok_validation_errors_are_not_ambiguous() {
        assert!(matches!(
            classify_submission_error(
                "HTTP 400: order couldn't be fully filled. FOK orders are fully filled or killed"
            ),
            PolymarketError::Rejected(_)
        ));
        assert!(matches!(
            classify_submission_error("request timed out after bytes were sent"),
            PolymarketError::AmbiguousSubmission(_)
        ));
    }
}
