use std::collections::VecDeque;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderValue, Method};
use axum::routing::get;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub schema_version: u32,
    pub scanner: ScannerStatus,
    pub feeds: FeedsStatus,
    pub strategy: StrategyStatus,
    pub durations: DurationsStatus,
    pub events: Vec<StatusEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerStatus {
    pub running: bool,
    pub read_only: bool,
    pub session_id: String,
    pub started_at: String,
    pub output_path: String,
    pub generated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedsStatus {
    pub polymarket_twap: FeedStatus,
    pub jupiter_spot: FeedStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    pub status: String,
    pub message: Option<String>,
    pub last_observation_received_at: Option<String>,
    pub last_observed_at: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyStatus {
    pub mode: String,
    pub halted: bool,
    pub halt_reason: Option<String>,
    pub entry_quarantine_reason: Option<String>,
    pub polymarket_cash_usd: String,
    pub jupiter_cash_usd: String,
    pub realized_profit_usd: String,
    pub open_positions: usize,
    pub settled_positions: usize,
    pub awaiting_resolution: usize,
    pub last_action: String,
    pub positions: Vec<serde_json::Value>,
    pub wallet_balances: WalletStatus,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletStatus {
    pub polymarket_collateral_usd: Option<String>,
    pub jupiter_usdc_usd: Option<String>,
    pub jupiter_sol: Option<String>,
    pub observed_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DurationsStatus {
    #[serde(rename = "5m")]
    pub five_minutes: DurationStatus,
    #[serde(rename = "15m")]
    pub fifteen_minutes: DurationStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationStatus {
    pub duration: String,
    pub phase: String,
    pub message: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub next_boundary: Option<String>,
    pub started_mid_round: bool,
    pub pair: Option<PairStatus>,
    pub references: ReferencesStatus,
    pub books: BooksStatus,
    pub best_route: Option<RouteStatus>,
    pub samples: u64,
    pub opportunities: u64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStatus {
    pub polymarket_slug: String,
    pub polymarket_market_id: String,
    pub jupiter_event_id: String,
    pub jupiter_up_market_id: String,
    pub jupiter_down_market_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferencesStatus {
    pub polymarket: ReferenceStatus,
    pub jupiter: ReferenceStatus,
    pub difference_usd: Option<String>,
    pub limit_usd: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceStatus {
    pub ready: bool,
    pub price_usd: Option<String>,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BooksStatus {
    pub polymarket: Option<BookStatus>,
    pub jupiter: Option<BookStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStatus {
    pub up: Option<BestAskStatus>,
    pub down: Option<BestAskStatus>,
    pub received_at: String,
    pub age_ms: i64,
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BestAskStatus {
    pub price_usd: String,
    pub contracts: String,
    pub received_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteStatus {
    pub label: String,
    pub all_in_usd_per_contract: String,
    pub edge_usd_per_contract: String,
    pub common_contracts: String,
    pub fee_adjusted_candidate: bool,
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub id: String,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub level: String,
    pub duration: Option<String>,
    pub code: Option<String>,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

#[derive(Clone)]
pub struct StatusStore {
    inner: Arc<RwLock<StatusSnapshot>>,
}

impl StatusStore {
    pub fn new(session_id: &str, output_path: &str, mode: &str) -> Self {
        let now = now_iso();
        let feed = FeedStatus {
            status: "connecting".to_owned(),
            message: None,
            last_observation_received_at: None,
            last_observed_at: None,
            updated_at: now.clone(),
        };
        Self {
            inner: Arc::new(RwLock::new(StatusSnapshot {
                schema_version: 1,
                scanner: ScannerStatus {
                    running: true,
                    read_only: mode != "live",
                    session_id: session_id.to_owned(),
                    started_at: now.clone(),
                    output_path: output_path.to_owned(),
                    generated_at: now.clone(),
                },
                feeds: FeedsStatus {
                    polymarket_twap: feed.clone(),
                    jupiter_spot: feed,
                },
                strategy: StrategyStatus {
                    mode: mode.to_owned(),
                    halted: false,
                    halt_reason: None,
                    entry_quarantine_reason: None,
                    polymarket_cash_usd: "0".to_owned(),
                    jupiter_cash_usd: "0".to_owned(),
                    realized_profit_usd: "0".to_owned(),
                    open_positions: 0,
                    settled_positions: 0,
                    awaiting_resolution: 0,
                    last_action: "Starting Rust runtime.".to_owned(),
                    positions: Vec::new(),
                    wallet_balances: WalletStatus {
                        polymarket_collateral_usd: None,
                        jupiter_usdc_usd: None,
                        jupiter_sol: None,
                        observed_at: None,
                        error: None,
                    },
                    updated_at: now.clone(),
                },
                durations: DurationsStatus {
                    five_minutes: initial_duration("5m", &now),
                    fifteen_minutes: initial_duration("15m", &now),
                },
                events: Vec::new(),
            })),
        }
    }

    pub async fn snapshot(&self) -> StatusSnapshot {
        let mut snapshot = self.inner.read().await.clone();
        snapshot.scanner.generated_at = now_iso();
        snapshot
    }

    pub async fn update_duration(&self, duration: &str, update: impl FnOnce(&mut DurationStatus)) {
        let mut status = self.inner.write().await;
        let target = if duration == "5m" {
            &mut status.durations.five_minutes
        } else {
            &mut status.durations.fifteen_minutes
        };
        update(target);
        target.updated_at = now_iso();
    }

    pub async fn update_strategy(&self, update: impl FnOnce(&mut StrategyStatus)) {
        let mut status = self.inner.write().await;
        update(&mut status.strategy);
        status.strategy.updated_at = now_iso();
    }

    pub async fn update_feed_health(
        &self,
        polymarket_received_at_ms: i64,
        jupiter_received_at_ms: i64,
    ) {
        let mut status = self.inner.write().await;
        let now = now_iso();
        status.feeds.polymarket_twap.status = "connected".to_owned();
        status.feeds.polymarket_twap.message =
            Some("Polymarket CLOB WebSocket/REST fallback".to_owned());
        status.feeds.polymarket_twap.last_observation_received_at =
            Some(iso_ms(polymarket_received_at_ms));
        status.feeds.polymarket_twap.last_observed_at = Some(iso_ms(polymarket_received_at_ms));
        status.feeds.polymarket_twap.updated_at.clone_from(&now);
        status.feeds.jupiter_spot.status = "connected".to_owned();
        status.feeds.jupiter_spot.message = Some("Executable Swap V2 /order responses".to_owned());
        status.feeds.jupiter_spot.last_observation_received_at =
            Some(iso_ms(jupiter_received_at_ms));
        status.feeds.jupiter_spot.last_observed_at = Some(iso_ms(jupiter_received_at_ms));
        status.feeds.jupiter_spot.updated_at = now;
    }

    pub async fn event(&self, mut event: StatusEvent) {
        let mut status = self.inner.write().await;
        event.id = format!("evt-{}", status.events.len().saturating_add(1));
        event.timestamp = now_iso();
        let mut events = VecDeque::from(std::mem::take(&mut status.events));
        events.push_front(event);
        events.truncate(50);
        status.events = events.into();
    }

    pub async fn stop(&self) {
        self.inner.write().await.scanner.running = false;
    }
}

pub async fn serve(store: StatusStore, listener: tokio::net::TcpListener) -> anyhow::Result<()> {
    let cors = CorsLayer::new().allow_methods([Method::GET]).allow_origin([
        HeaderValue::from_static("http://127.0.0.1:3000"),
        HeaderValue::from_static("http://localhost:3000"),
    ]);
    let app = Router::new()
        .route("/api/status", get(status))
        .route("/health", get(status))
        .layer(cors)
        .with_state(store);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn status(State(store): State<StatusStore>) -> Json<StatusSnapshot> {
    Json(store.snapshot().await)
}

fn initial_duration(duration: &str, now: &str) -> DurationStatus {
    DurationStatus {
        duration: duration.to_owned(),
        phase: "discovering".to_owned(),
        message: "Looking for the current same-duration market pair.".to_owned(),
        start: None,
        end: None,
        next_boundary: None,
        started_mid_round: false,
        pair: None,
        references: ReferencesStatus {
            polymarket: ReferenceStatus {
                ready: false,
                price_usd: None,
                source: None,
            },
            jupiter: ReferenceStatus {
                ready: false,
                price_usd: None,
                source: None,
            },
            difference_usd: None,
            limit_usd: None,
        },
        books: BooksStatus {
            polymarket: None,
            jupiter: None,
        },
        best_route: None,
        samples: 0,
        opportunities: 0,
        updated_at: now.to_owned(),
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn iso_ms(timestamp_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(timestamp_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
