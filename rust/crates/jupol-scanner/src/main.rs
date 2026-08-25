#![allow(
    clippy::assigning_clones,
    clippy::collapsible_if,
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::trivially_copy_pass_by_ref
)]

mod daily;
mod market;
mod status;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand};
use daily::{DailyThresholdPair, discover_daily_threshold_pairs, refresh_daily_books};
use jupol_domain::Micro;
use jupol_domain::fixed::{
    ONE_CONTRACT_MICRO, ONE_USD_MICRO, format_contracts, format_usd, parse_usd,
};
use jupol_domain::short_window::{
    CrossVenueShortWindowRoute, EvaluatedCrossVenueRoute, all_complementary_cross_venue_routes,
    evaluate_cross_venue_routes, polymarket_crypto_taker_fee_per_contract_micro_usd,
};
use jupol_domain::strategy::{
    EntryEvaluation, ShortWindowStrategyConfig, evaluate_short_window_entry,
    quote_buy_across_levels,
};
use jupol_domain::types::{BinaryOrderBook, BookLevel, ShortWindowOutcome};
use jupol_jupiter::{
    JupiterClient, JupiterClientOptions, JupiterForecastSwapExecutor, JupiterHybridExecutor,
    JupiterPredictionExecutor, JupiterPriceBookState, JupiterSwapClient,
    PREDICTION_MINIMUM_BUY_MICRO_USD, SwapClientOptions, spawn_price_stream,
};
use jupol_live::{EntryDisposition, LiveCoordinator, LiveEntryRequest, capture_entry_balances};
use jupol_polymarket::{
    PolymarketExecutor, PolymarketGammaClient, PolymarketMarketData, PolymarketOptions,
    PolymarketRelayer, PolymarketRelayerOptions, PolymarketStreamMarket,
    normalize_fok_contracts_for_price, spawn_market_stream,
};
use jupol_runtime::request_scheduler::{JupiterRequestScheduler, RequestPriority};
use jupol_state::{
    LivePairIdentity, LivePosition, LivePositionPhase, Outcome, PostFillAction,
    ResolutionScenarioCode,
};
use market::{CrossVenuePair, DurationKind, discover_pair};
use serde_json::json;
use status::{
    BestAskStatus, BookStatus, PairStatus, RouteStatus, StatusEvent, StatusStore, iso_ms, now_iso,
};
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::Mutex;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

const LIVE_CONFIRMATION: &str = "I_ACCEPT_REAL_MONEY_RISK";
const DEFAULT_OUTPUT: &str = "logs/btc-poly-jup-short-window-rust.jsonl";
const DEFAULT_STATE: &str = "logs/btc-poly-jup-short-window-live-state.json";
const DEVELOPER_REQUEST_INTERVAL_MS: u64 = 100;
const JUPITER_CRITICAL_SLOT_BUDGET_MS: i64 = 100;
const MAXIMUM_PRECISION_SIZE_MISMATCH_BPS: Micro = 500;

#[derive(Parser, Debug)]
#[command(
    name = "jupol",
    version,
    about = "Rust Polymarket/Jupiter arbitrage runtime"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    Monitor(RunArgs),
    Live(RunArgs),
    Readiness(ReadinessArgs),
    Recover(RecoveryArgs),
    SetupApprovals,
    Redeem(RedeemArgs),
    State(StateArgs),
}

#[derive(Args, Clone, Debug)]
#[allow(clippy::struct_excessive_bools)]
struct RunArgs {
    #[arg(long, default_value = DEFAULT_OUTPUT)]
    output: PathBuf,
    #[arg(long, default_value = DEFAULT_STATE)]
    live_state: PathBuf,
    #[arg(long, default_value_t = 3_210)]
    web_port: u16,
    #[arg(long, default_value_t = false)]
    no_web: bool,
    #[arg(long, default_value_t = false)]
    once: bool,
    #[arg(long, default_value_t = 0)]
    max_samples: u64,
    #[arg(long, default_value_t = 50)]
    sample_interval_ms: u64,
    #[arg(long, default_value_t = 5_000)]
    polymarket_poll_ms: u64,
    #[arg(long, default_value_t = 750)]
    max_polymarket_age_ms: i64,
    #[arg(long, default_value_t = 2_000)]
    max_jupiter_age_ms: i64,
    #[arg(long, default_value_t = 500)]
    maximum_jupiter_submit_quote_age_ms: i64,
    #[arg(long, default_value_t = 30)]
    entry_cutoff_seconds: i64,
    #[arg(long, default_value = "50")]
    minimum_venue_balance_usd: String,
    #[arg(long, default_value = "50")]
    max_venue_allocation_usd: String,
    #[arg(long, default_value = "0.10")]
    jupiter_minimum_order_usd: String,
    #[arg(long, default_value = "1")]
    polymarket_minimum_order_usd: String,
    #[arg(long, default_value = "0.001")]
    minimum_entry_edge_usd: String,
    #[arg(long, default_value = "0.10")]
    minimum_entry_profit_usd: String,
    #[arg(long, default_value_t = 100)]
    maximum_slippage_bps: u32,
    #[arg(long, default_value_t = 2_000)]
    polymarket_depth_haircut_bps: u32,
    #[arg(long, default_value = "1")]
    maximum_emergency_hedge_loss_usd: String,
    #[arg(long, default_value_t = 20_000)]
    jupiter_fill_timeout_ms: u64,
    #[arg(long, default_value_t = 5)]
    maximum_open_positions: usize,
    #[arg(long, default_value_t = false)]
    disable_sub_five_jupiter_swap: bool,
    #[arg(long, default_value_t = false)]
    no_daily_threshold: bool,
}

impl Default for RunArgs {
    fn default() -> Self {
        Self {
            output: PathBuf::from(DEFAULT_OUTPUT),
            live_state: PathBuf::from(DEFAULT_STATE),
            web_port: 3_210,
            no_web: false,
            once: false,
            max_samples: 0,
            sample_interval_ms: 50,
            polymarket_poll_ms: 5_000,
            max_polymarket_age_ms: 750,
            max_jupiter_age_ms: 2_000,
            maximum_jupiter_submit_quote_age_ms: 500,
            entry_cutoff_seconds: 30,
            minimum_venue_balance_usd: "50".to_owned(),
            max_venue_allocation_usd: "50".to_owned(),
            jupiter_minimum_order_usd: "0.10".to_owned(),
            polymarket_minimum_order_usd: "1".to_owned(),
            minimum_entry_edge_usd: "0.001".to_owned(),
            minimum_entry_profit_usd: "0.10".to_owned(),
            maximum_slippage_bps: 100,
            polymarket_depth_haircut_bps: 2_000,
            maximum_emergency_hedge_loss_usd: "1".to_owned(),
            jupiter_fill_timeout_ms: 20_000,
            maximum_open_positions: 5,
            disable_sub_five_jupiter_swap: false,
            no_daily_threshold: false,
        }
    }
}

#[derive(Args, Debug)]
struct ReadinessArgs {
    #[arg(long, default_value = "50")]
    minimum_venue_balance_usd: String,
    #[arg(long, default_value_t = false)]
    polymarket_only: bool,
}

#[derive(Args, Debug)]
struct RecoveryArgs {
    #[arg(long, default_value = DEFAULT_STATE)]
    live_state: PathBuf,
    #[arg(long, default_value = "1")]
    maximum_repair_loss_usd: String,
    #[arg(long, default_value_t = 100)]
    maximum_slippage_bps: u32,
}

#[derive(Args, Debug)]
struct RedeemArgs {
    #[arg(long)]
    market_id: Option<String>,
    #[arg(long, default_value = DEFAULT_STATE)]
    live_state: PathBuf,
    #[arg(long, default_value_t = 20_000)]
    timeout_ms: u64,
}

#[derive(Args, Debug)]
struct StateArgs {
    #[arg(long, default_value = DEFAULT_STATE)]
    live_state: PathBuf,
}

#[derive(Clone)]
struct JsonlWriter {
    file: Arc<Mutex<File>>,
}

impl JsonlWriter {
    async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await?;
        Ok(Self {
            file: Arc::new(Mutex::new(file)),
        })
    }

    async fn append(&self, value: serde_json::Value) -> Result<()> {
        let mut line = serde_json::to_vec(&value)?;
        line.push(b'\n');
        self.file.lock().await.write_all(&line).await?;
        Ok(())
    }
}

struct RuntimePair {
    pair: CrossVenuePair,
    jupiter_state: JupiterPriceBookState,
    jupiter_book: Option<BinaryOrderBook>,
    polymarket_book: Option<BinaryOrderBook>,
    last_candidate_signature: Option<String>,
    entry_preflight_after_ms: i64,
    last_preflight_error: Option<String>,
}

struct DailyRuntime {
    pair: DailyThresholdPair,
    last_candidate_signature: Option<String>,
    entry_preflight_after_ms: i64,
    last_preflight_error: Option<String>,
}

#[derive(Clone, Copy)]
struct EngineConfig {
    strategy: ShortWindowStrategyConfig,
    minimum_venue_balance_micro_usd: Micro,
    maximum_jupiter_submit_quote_age_ms: i64,
    entry_cutoff_ms: i64,
    max_polymarket_age_ms: i64,
    max_jupiter_age_ms: i64,
    maximum_slippage_bps: u32,
    polymarket_depth_haircut_bps: u32,
    maximum_emergency_hedge_loss_micro_usd: Micro,
    jupiter_fill_timeout: Duration,
    maximum_open_positions: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "jupol=info,warn".into()),
        )
        .with_target(false)
        .compact()
        .init();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Monitor(RunArgs::default())) {
        Command::Monitor(args) => run_engine(args, false).await,
        Command::Live(args) => run_engine(args, true).await,
        Command::Readiness(args) => readiness(args).await,
        Command::Recover(args) => recover(args).await,
        Command::SetupApprovals => setup_approvals().await,
        Command::Redeem(args) => redeem(args).await,
        Command::State(args) => print_state(&args.live_state),
    }
}

async fn run_engine(args: RunArgs, live: bool) -> Result<()> {
    validate_run_args(&args, live)?;
    if live && env_optional("LIVE_TRADING_CONFIRMATION").as_deref() != Some(LIVE_CONFIRMATION) {
        bail!("live trading refused; set LIVE_TRADING_CONFIRMATION={LIVE_CONFIRMATION}");
    }
    let config = engine_config(&args)?;
    let writer = JsonlWriter::open(&args.output).await?;
    let session_id = Uuid::new_v4().to_string();
    let mode = if live { "live" } else { "monitor" };
    let status = StatusStore::new(&session_id, &args.output.display().to_string(), mode);
    if !args.no_web {
        // Binding before any wallet/API initialization makes the status port a
        // real single-instance lock. A second live process fails immediately.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.web_port))
            .await
            .with_context(|| format!("status port {} is already in use", args.web_port))?;
        let store = status.clone();
        let port = args.web_port;
        tokio::spawn(async move {
            if let Err(error) = status::serve(store, listener).await {
                error!("status server failed: {error:#}");
            }
        });
        info!(port, "status API listening on /api/status");
    }

    let api_key = env_optional("JUPITER_API_KEY");
    let scheduler = api_key.as_ref().map(|_| {
        JupiterRequestScheduler::new(Duration::from_millis(DEVELOPER_REQUEST_INTERVAL_MS))
    });
    let discovery = JupiterClient::new(JupiterClientOptions {
        base_url: env_optional("JUPITER_PREDICTION_URL")
            .unwrap_or_else(|| "https://api.jup.ag/prediction/v1".to_owned()),
        api_key: api_key.clone(),
        minimum_request_interval: Some(Duration::ZERO),
        request_scheduler: scheduler.clone(),
        request_priority: RequestPriority::Normal,
    })?;
    let gamma_url = env_optional("POLYMARKET_GAMMA_URL");
    let clob_url = env_optional("POLYMARKET_CLOB_URL");
    let gamma = PolymarketGammaClient::new(gamma_url.as_deref())?;
    let polymarket_data = PolymarketMarketData::new(clob_url.as_deref())?;

    let (jupiter_executor, polymarket_executor, mut coordinator, relayer) = if live {
        let (jupiter, polymarket) =
            live_components(scheduler.clone(), !args.disable_sub_five_jupiter_swap).await?;
        let poly_ready = polymarket
            .assert_ready(config.minimum_venue_balance_micro_usd)
            .await?;
        let jup_ready = jupiter
            .assert_ready(config.minimum_venue_balance_micro_usd)
            .await?;
        info!(
            polymarket_usd = %format_usd(poly_ready.collateral_balance_micro_usd),
            jupiter_usd = %format_usd(jup_ready.usdc_micro),
            jupiter_sol_lamports = jup_ready.sol_lamports,
            "live readiness passed"
        );
        let mut coordinator = LiveCoordinator::load(&args.live_state)?;
        coordinator.update_cash_snapshots(
            poly_ready.collateral_balance_micro_usd,
            jup_ready.usdc_micro,
        )?;
        for disposition in coordinator
            .recover_incomplete_positions_with_limits(
                &jupiter,
                &polymarket,
                config.maximum_emergency_hedge_loss_micro_usd,
                config.maximum_slippage_bps,
            )
            .await?
        {
            warn!(?disposition, "startup recovery result");
        }
        let relayer = match PolymarketRelayerOptions::from_env() {
            Ok(options) => match PolymarketRelayer::new(options).await {
                Ok(value) => Some(value),
                Err(error) => {
                    warn!("automatic redemption disabled: {error}");
                    None
                }
            },
            Err(error) => {
                warn!("automatic redemption disabled: {error}");
                None
            }
        };
        (Some(jupiter), Some(polymarket), Some(coordinator), relayer)
    } else {
        (None, None, None, None)
    };

    writer.append(json!({
        "schemaVersion": 3,
        "type": "session_start",
        "sessionId": session_id,
        "at": now_iso(),
        "runtime": "rust",
        "mode": mode,
        "jupiterPlan": if api_key.is_some() { "developer_10_rps_shared" } else { "unauthenticated" },
        "jupiterSharedRequestIntervalMs": if api_key.is_some() { Some(DEVELOPER_REQUEST_INTERVAL_MS) } else { None },
        "entryCutoffSeconds": args.entry_cutoff_seconds,
        "maximumReferenceDifferenceUsd": null,
    })).await?;

    let mut pairs = discover_all(&gamma, &discovery, &status).await?;
    let mut daily_pairs = if args.no_daily_threshold {
        Vec::new()
    } else {
        discover_daily_runtimes(&discovery, &gamma).await
    };
    if let Some(polymarket) = polymarket_executor.as_ref() {
        for runtime in &daily_pairs {
            let (yes, no) = tokio::join!(
                polymarket.prime_token(runtime.pair.yes_token()),
                polymarket.prime_token(runtime.pair.no_token()),
            );
            yes?;
            no?;
        }
    }
    let mut daily_discovered_at_ms = unix_ms();
    if let Some(polymarket) = polymarket_executor.as_ref() {
        for runtime in pairs.values() {
            let (up, down) = tokio::join!(
                polymarket.prime_token(runtime.pair.polymarket_up_token()),
                polymarket.prime_token(runtime.pair.polymarket_down_token()),
            );
            up?;
            down?;
        }
    }
    let mut price_stream = new_price_stream(&pairs);
    let mut polymarket_stream = new_polymarket_stream(&pairs);
    let mut sample_tick = tokio::time::interval(Duration::from_millis(args.sample_interval_ms));
    sample_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut poly_tick = tokio::time::interval(Duration::from_millis(args.polymarket_poll_ms));
    poly_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut settlement_tick = tokio::time::interval(Duration::from_secs(15));
    settlement_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut daily_tick = tokio::time::interval(Duration::from_secs(5));
    daily_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut samples = 0_u64;
    let max_samples = if args.once { 1 } else { args.max_samples };

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            update = price_stream.recv() => {
                if let Some(update) = update {
                    match update {
                        Ok(update) => {
                            for runtime in pairs.values_mut() {
                                if let Some(book) = runtime.jupiter_state.apply(update.clone())? {
                                    runtime.jupiter_book = Some(book);
                                }
                            }
                        }
                        Err(error) => warn!("Jupiter discovery stream: {error}"),
                    }
                }
            }
            update = polymarket_stream.recv() => {
                if let Some(update) = update {
                    match update {
                        Ok(update) => {
                            for runtime in pairs.values_mut() {
                                if runtime.pair.polymarket.market_id == update.market_id {
                                    runtime.polymarket_book = Some(update.book.clone());
                                }
                            }
                        }
                        Err(error) => warn!("Polymarket discovery stream: {error}"),
                    }
                }
            }
            _ = poly_tick.tick() => {
                for runtime in pairs.values_mut() {
                    let needs_fallback = runtime.polymarket_book.as_ref().is_none_or(|book| {
                        unix_ms().saturating_sub(book.received_at_ms) > config.max_polymarket_age_ms
                    });
                    if !needs_fallback {
                        continue;
                    }
                    match polymarket_data.binary_order_book(
                        &runtime.pair.polymarket.market_id,
                        runtime.pair.polymarket_up_token(),
                        runtime.pair.polymarket_down_token(),
                    ).await {
                        Ok(book) => runtime.polymarket_book = Some(book),
                        Err(error) => warn!(duration = runtime.pair.duration.label(), "Polymarket book: {error}"),
                    }
                }
            }
            _ = settlement_tick.tick(), if live => {
                if let Some(coordinator) = coordinator.as_mut() {
                    if let (Some(jupiter), Some(polymarket)) =
                        (jupiter_executor.as_ref(), polymarket_executor.as_ref())
                    {
                        match coordinator
                            .recover_incomplete_positions_with_limits(
                                jupiter,
                                polymarket,
                                config.maximum_emergency_hedge_loss_micro_usd,
                                config.maximum_slippage_bps,
                            )
                            .await
                        {
                            Ok(dispositions) => {
                                for disposition in dispositions {
                                    warn!(?disposition, "periodic recovery result");
                                }
                            }
                            Err(error) => warn!("periodic recovery failed: {error}"),
                        }
                    }
                    if let Err(error) = coordinator.mark_expired_positions_awaiting_resolution(unix_ms()) {
                        warn!("could not mark expired live positions: {error}");
                    }
                    if let Some(jupiter) = jupiter_executor.as_ref() {
                        attempt_settlements(
                            coordinator,
                            relayer.as_ref(),
                            polymarket_executor.as_ref(),
                            &gamma,
                            jupiter,
                            config.jupiter_fill_timeout,
                        ).await;
                    }
                }
            }
            _ = daily_tick.tick(), if !args.no_daily_threshold => {
                let now = unix_ms();
                if now.saturating_sub(daily_discovered_at_ms) >= 300_000 {
                    daily_pairs = discover_daily_runtimes(&discovery, &gamma).await;
                    daily_discovered_at_ms = now;
                    if let Some(polymarket) = polymarket_executor.as_ref() {
                        for runtime in &daily_pairs {
                            let (yes, no) = tokio::join!(
                                polymarket.prime_token(runtime.pair.yes_token()),
                                polymarket.prime_token(runtime.pair.no_token()),
                            );
                            yes?;
                            no?;
                        }
                    }
                }
                for runtime in &mut daily_pairs {
                    match refresh_daily_books(&mut runtime.pair, &discovery, &polymarket_data).await {
                        Ok((poly_book, jup_book)) => {
                            let screened_poly = haircut_polymarket_book(&poly_book, config.polymarket_depth_haircut_bps);
                            let evaluated = evaluate_cross_venue_routes(
                                &screened_poly,
                                &jup_book,
                                &all_complementary_cross_venue_routes(),
                            )?;
                            let best = evaluated.first();
                            let signature = best.map(candidate_signature);
                            if signature != runtime.last_candidate_signature {
                                runtime.last_candidate_signature = signature;
                                if let Some(best) = best {
                                    writer.append(daily_candidate_record(&session_id, &runtime.pair, best)).await?;
                                    if best.is_fee_adjusted_candidate {
                                        info!(
                                            market_id = runtime.pair.polymarket.market_id,
                                            route = %route_label(&best.route),
                                            edge_per_contract = %format_usd(best.effective_edge_micro_usd_per_contract),
                                            "daily threshold candidate"
                                        );
                                    }
                                }
                            }
                            if live && now >= runtime.entry_preflight_after_ms && runtime.pair.close_ms - now > config.entry_cutoff_ms {
                                if let (Some(jupiter), Some(polymarket), Some(coordinator), Some(best)) = (
                                    jupiter_executor.as_ref(), polymarket_executor.as_ref(), coordinator.as_mut(), best,
                                ) {
                                    if coordinator.state().positions.len() < config.maximum_open_positions
                                        && coordinator.entry_blocker().is_none()
                                        && !coordinator.state().completed_pairs.contains(&runtime.pair.key)
                                        && !coordinator.state().positions.iter().any(|position| position.pair.key == runtime.pair.key)
                                    {
                                        runtime.entry_preflight_after_ms = now.saturating_add(250);
                                        match try_daily_live_entry(
                                            runtime,
                                            best,
                                            jupiter,
                                            polymarket,
                                            &polymarket_data,
                                            coordinator,
                                            &config,
                                        ).await {
                                            Ok(Some(disposition)) => {
                                                runtime.last_preflight_error = None;
                                                let (poly_cash, jup_cash) = tokio::join!(
                                                    polymarket.collateral_balance_micro_usd(),
                                                    jupiter.usdc_balance(),
                                                );
                                                if let (Ok(poly_cash), Ok(jup_cash)) = (poly_cash, jup_cash) {
                                                    coordinator.update_cash_snapshots(poly_cash, jup_cash)?;
                                                }
                                                writer.append(json!({
                                                    "schemaVersion": 3,
                                                    "type": "daily_live_entry_result",
                                                    "at": now_iso(),
                                                    "pairKey": runtime.pair.key,
                                                    "result": format!("{disposition:?}"),
                                                })).await?;
                                            }
                                            Ok(None) => runtime.last_preflight_error = None,
                                            Err(error) => {
                                                let message = format!("{error:#}");
                                                if runtime.last_preflight_error.as_deref() != Some(&message) {
                                                    warn!(market_id = runtime.pair.polymarket.market_id, "daily entry preflight: {message}");
                                                    writer.append(json!({
                                                        "schemaVersion": 3,
                                                        "type": "execution_error",
                                                        "at": now_iso(),
                                                        "stage": "daily_entry_preflight",
                                                        "code": classify_execution_error(&message),
                                                        "pairKey": runtime.pair.key,
                                                        "message": message,
                                                    })).await?;
                                                    runtime.last_preflight_error = Some(message);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Err(error) => warn!(market_id = runtime.pair.polymarket.market_id, "daily book refresh: {error:#}"),
                    }
                }
            }
            _ = sample_tick.tick() => {
                let now = unix_ms();
                if pairs.values().any(|runtime| now >= runtime.pair.end_ms) {
                    pairs = discover_all(&gamma, &discovery, &status).await?;
                    if let Some(polymarket) = polymarket_executor.as_ref() {
                        for runtime in pairs.values() {
                            let (up, down) = tokio::join!(
                                polymarket.prime_token(runtime.pair.polymarket_up_token()),
                                polymarket.prime_token(runtime.pair.polymarket_down_token()),
                            );
                            up?;
                            down?;
                        }
                    }
                    price_stream = new_price_stream(&pairs);
                    polymarket_stream = new_polymarket_stream(&pairs);
                    continue;
                }
                for runtime in pairs.values_mut() {
                    let Some(poly_book) = runtime.polymarket_book.as_ref() else { continue; };
                    let Some(jup_book) = runtime.jupiter_book.as_ref() else { continue; };
                    samples = samples.saturating_add(1);
                    let poly_age = now.saturating_sub(poly_book.received_at_ms);
                    let jup_age = now.saturating_sub(jup_book.received_at_ms);
                    let stale = poly_age > config.max_polymarket_age_ms || jup_age > config.max_jupiter_age_ms;
                    let screened_poly = haircut_polymarket_book(poly_book, config.polymarket_depth_haircut_bps);
                    let evaluated = evaluate_cross_venue_routes(
                        &screened_poly,
                        jup_book,
                        &all_complementary_cross_venue_routes(),
                    )?;
                    let best = evaluated.first();
                    update_duration_status(&status, runtime, best, stale, poly_age, jup_age).await;
                    let signature = best.map(candidate_signature);
                    if signature != runtime.last_candidate_signature {
                        runtime.last_candidate_signature = signature;
                        if let Some(best) = best {
                            writer.append(candidate_record(&session_id, &runtime.pair, best, poly_age, jup_age, stale)).await?;
                            if best.is_fee_adjusted_candidate {
                                info!(
                                    duration = runtime.pair.duration.label(),
                                    route = %route_label(&best.route),
                                    edge_per_contract = %format_usd(best.effective_edge_micro_usd_per_contract),
                                    common_contracts = %format_contracts(best.common_depth_contracts_micro),
                                    poly_age_ms = poly_age,
                                    jup_age_ms = jup_age,
                                    "candidate"
                                );
                            }
                        }
                    }
                    if live
                        && !stale
                        && now >= runtime.entry_preflight_after_ms
                        && runtime.pair.end_ms - now > config.entry_cutoff_ms
                    {
                        if let (Some(jupiter), Some(polymarket), Some(coordinator), Some(best)) = (
                            jupiter_executor.as_ref(), polymarket_executor.as_ref(), coordinator.as_mut(), best,
                        ) {
                            if coordinator.state().positions.len() < config.maximum_open_positions
                                && coordinator.entry_blocker().is_none()
                                && !coordinator.state().completed_pairs.contains(&runtime.pair.key())
                                && !coordinator.state().positions.iter().any(|position| position.pair.key == runtime.pair.key())
                            {
                                // Keep retries responsive while bounding build
                                // churn to four candidate preflights per second.
                                runtime.entry_preflight_after_ms = now.saturating_add(250);
                                match try_live_entry(runtime, best, jupiter, polymarket, &polymarket_data, coordinator, &config).await {
                                    Ok(Some(disposition)) => {
                                        runtime.last_preflight_error = None;
                                        let (poly_cash, jup_cash) = tokio::join!(
                                            polymarket.collateral_balance_micro_usd(),
                                            jupiter.usdc_balance(),
                                        );
                                        if let (Ok(poly_cash), Ok(jup_cash)) = (poly_cash, jup_cash) {
                                            coordinator.update_cash_snapshots(poly_cash, jup_cash)?;
                                        }
                                        status.event(event_for_disposition(runtime.pair.duration.label(), &disposition)).await;
                                        writer.append(json!({
                                            "schemaVersion": 3,
                                            "type": "live_entry_result",
                                            "at": now_iso(),
                                            "pairKey": runtime.pair.key(),
                                            "result": format!("{disposition:?}"),
                                        })).await?;
                                    }
                                    Ok(None) => {
                                        runtime.last_preflight_error = None;
                                    }
                                    Err(error) => {
                                        let message = format!("{error:#}");
                                        if runtime.last_preflight_error.as_deref() != Some(&message) {
                                            warn!(duration = runtime.pair.duration.label(), "entry preflight: {message}");
                                            status.event(error_event(runtime.pair.duration.label(), "ENTRY_PREFLIGHT", &message)).await;
                                            writer.append(json!({
                                                "schemaVersion": 3,
                                                "type": "execution_error",
                                                "at": now_iso(),
                                                "stage": "short_window_entry_preflight",
                                                "code": classify_execution_error(&message),
                                                "pairKey": runtime.pair.key(),
                                                "polymarketAgeMs": poly_age,
                                                "jupiterAgeMs": jup_age,
                                                "message": message,
                                            })).await?;
                                            runtime.last_preflight_error = Some(message);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(coordinator) = coordinator.as_ref() {
                    update_live_status(&status, coordinator).await;
                }
                if max_samples > 0 && samples >= max_samples { break; }
            }
        }
    }
    status.stop().await;
    writer
        .append(json!({
            "schemaVersion": 3,
            "type": "session_stop",
            "sessionId": session_id,
            "at": now_iso(),
            "samples": samples,
        }))
        .await?;
    Ok(())
}

async fn discover_all(
    gamma: &PolymarketGammaClient,
    jupiter: &JupiterClient,
    status: &StatusStore,
) -> Result<HashMap<DurationKind, RuntimePair>> {
    loop {
        let now = unix_ms();
        match tokio::try_join!(
            discover_pair(DurationKind::FiveMinutes, now, gamma, jupiter),
            discover_pair(DurationKind::FifteenMinutes, now, gamma, jupiter),
        ) {
            Ok((five, fifteen)) => {
                let mut pairs = HashMap::new();
                for pair in [five, fifteen] {
                    status
                        .update_duration(pair.duration.label(), |entry| {
                            entry.phase = "monitoring".to_owned();
                            entry.message =
                                "Rust feeds connected; evaluating both complementary routes."
                                    .to_owned();
                            entry.start = Some(iso_ms(pair.start_ms));
                            entry.end = Some(iso_ms(pair.end_ms));
                            entry.next_boundary = Some(iso_ms(pair.end_ms));
                            entry.started_mid_round = now > pair.start_ms + 2_500;
                            entry.pair = Some(PairStatus {
                                polymarket_slug: pair.polymarket_slug.clone(),
                                polymarket_market_id: pair.polymarket.market_id.clone(),
                                jupiter_event_id: pair.jupiter_event_id.clone(),
                                jupiter_up_market_id: pair.jupiter_up.market_id.clone(),
                                jupiter_down_market_id: pair.jupiter_down.market_id.clone(),
                            });
                        })
                        .await;
                    let jupiter_state = JupiterPriceBookState::new(
                        pair.jupiter_up.market_id.clone(),
                        pair.jupiter_down.market_id.clone(),
                        50_000_000,
                    )?;
                    pairs.insert(
                        pair.duration,
                        RuntimePair {
                            pair,
                            jupiter_state,
                            jupiter_book: None,
                            polymarket_book: None,
                            last_candidate_signature: None,
                            entry_preflight_after_ms: 0,
                            last_preflight_error: None,
                        },
                    );
                }
                return Ok(pairs);
            }
            Err(error) => {
                // `anyhow::Error::to_string()` prints only the outermost context.
                // Include the full source chain so an HTTP 401 cannot be hidden
                // behind the discovery context and retried forever.
                let error_chain = format!("{error:#}");
                if error_chain.contains("HTTP 401")
                    || error_chain.to_ascii_lowercase().contains("unauthorized")
                {
                    return Err(error).context(
                        "Jupiter rejected JUPITER_API_KEY; create/enable a Developer key with Prediction product permission in the Jupiter portal",
                    );
                }
                warn!("market discovery retry: {error:#}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

async fn discover_daily_runtimes(
    jupiter: &JupiterClient,
    gamma: &PolymarketGammaClient,
) -> Vec<DailyRuntime> {
    match discover_daily_threshold_pairs(jupiter, gamma, unix_ms()).await {
        Ok(pairs) => {
            info!(
                count = pairs.len(),
                "daily Bitcoin-threshold mirrors discovered"
            );
            pairs
                .into_iter()
                .map(|pair| DailyRuntime {
                    pair,
                    last_candidate_signature: None,
                    entry_preflight_after_ms: 0,
                    last_preflight_error: None,
                })
                .collect()
        }
        Err(error) => {
            warn!("daily threshold discovery retry: {error:#}");
            Vec::new()
        }
    }
}

fn new_price_stream(
    pairs: &HashMap<DurationKind, RuntimePair>,
) -> tokio::sync::mpsc::Receiver<
    Result<jupol_jupiter::JupiterPriceUpdate, jupol_jupiter::JupiterError>,
> {
    let ids = pairs
        .values()
        .flat_map(|runtime| runtime.jupiter_state.market_ids())
        .collect();
    spawn_price_stream(ids, env_optional("JUPITER_PREDICTION_PRICE_WEBSOCKET_URL"))
}

fn new_polymarket_stream(
    pairs: &HashMap<DurationKind, RuntimePair>,
) -> tokio::sync::mpsc::Receiver<
    Result<jupol_polymarket::PolymarketStreamUpdate, jupol_polymarket::PolymarketError>,
> {
    let markets = pairs
        .values()
        .map(|runtime| PolymarketStreamMarket {
            market_id: runtime.pair.polymarket.market_id.clone(),
            yes_token_id: runtime.pair.polymarket_up_token().to_owned(),
            no_token_id: runtime.pair.polymarket_down_token().to_owned(),
        })
        .collect();
    spawn_market_stream(markets, env_optional("POLYMARKET_MARKET_WS_URL"))
}

async fn try_live_entry(
    runtime: &RuntimePair,
    screened_best: &EvaluatedCrossVenueRoute,
    jupiter: &JupiterHybridExecutor,
    polymarket: &PolymarketExecutor,
    polymarket_data: &PolymarketMarketData,
    coordinator: &mut LiveCoordinator,
    config: &EngineConfig,
) -> Result<Option<EntryDisposition>> {
    let (poly_cash, jup_usdc) = tokio::join!(
        polymarket.collateral_balance_micro_usd(),
        jupiter.usdc_balance(),
    );
    let poly_cash = poly_cash?;
    let jup_usdc = jup_usdc?;
    let proposal = match evaluate_short_window_entry(
        Some(screened_best),
        poly_cash,
        jup_usdc,
        &config.strategy,
    )? {
        EntryEvaluation::Eligible(proposal) => proposal,
        EntryEvaluation::Rejected(_) => return Ok(None),
    };
    let jupiter_market = match proposal.route.jupiter_outcome {
        ShortWindowOutcome::Up => &runtime.pair.jupiter_up,
        ShortWindowOutcome::Down => &runtime.pair.jupiter_down,
    };
    let token_id = match proposal.route.polymarket_outcome {
        ShortWindowOutcome::Up => runtime.pair.polymarket_up_token(),
        ShortWindowOutcome::Down => runtime.pair.polymarket_down_token(),
    };
    let native_before = if let Some(mint) = jupiter_market.outcome_mint.as_deref() {
        Some(capture_entry_balances(polymarket, jupiter, token_id, Some(mint), "", true).await?)
    } else {
        None
    };
    // Obtain both authoritative inputs in parallel. Fetching the CLOB book
    // after Jupiter's executable build previously consumed most of its 500 ms
    // freshness window before either leg reached submission.
    let (build, fresh_poly) = tokio::join!(
        async {
            let build = jupiter
                .prepare_buy(
                    &jupiter_market.market_id,
                    true,
                    proposal.jupiter.gross_micro_usd,
                    jupiter_market.outcome_mint.as_deref(),
                )
                .await
                .context("fresh Jupiter build failed")?;
            Ok::<_, anyhow::Error>((build, unix_ms()))
        },
        polymarket_data.binary_order_book(
            &runtime.pair.polymarket.market_id,
            runtime.pair.polymarket_up_token(),
            runtime.pair.polymarket_down_token(),
        ),
    );
    let (build, build_received_at_ms) = build?;
    let fresh_poly = fresh_poly?;
    let before = match native_before {
        Some(snapshot) => snapshot,
        None => {
            capture_entry_balances(
                polymarket,
                jupiter,
                token_id,
                None,
                &build.order.position_pubkey,
                true,
            )
            .await?
        }
    };
    let poly_levels = match proposal.route.polymarket_outcome {
        ShortWindowOutcome::Up => &fresh_poly.yes.asks,
        ShortWindowOutcome::Down => &fresh_poly.no.asks,
    };
    let jupiter_all_in = build
        .order
        .order_cost_micro_usd
        .checked_add(build.order.estimated_total_fee_micro_usd)
        .ok_or_else(|| anyhow!("Jupiter exact cost overflow"))?;
    let Some(selection) = select_precision_safe_polymarket_buy(
        poly_levels,
        build.order.new_contracts_micro,
        jupiter_all_in,
        poly_cash,
        &config.strategy,
        config.maximum_slippage_bps,
    )?
    else {
        return Ok(None);
    };
    let jupiter_submission = jupiter.prepare_submission(build)?;
    let polymarket_order = polymarket
        .prepare_buy_fok(
            token_id,
            selection.limit_price_micro_usd,
            selection.contracts_micro,
        )
        .await?;
    let build_age = unix_ms().saturating_sub(build_received_at_ms);
    if build_age.saturating_add(JUPITER_CRITICAL_SLOT_BUDGET_MS)
        > config.maximum_jupiter_submit_quote_age_ms
    {
        bail!(
            "fresh Jupiter build cannot reach the 10-RPS critical slot in time: age={build_age}ms slotBudget={JUPITER_CRITICAL_SLOT_BUDGET_MS}ms limit={}ms",
            config.maximum_jupiter_submit_quote_age_ms
        );
    }
    let pair = live_pair_identity(&runtime.pair, proposal.route, token_id, jupiter_market);
    let request = LiveEntryRequest {
        position_id: format!("live-{}", Uuid::new_v4()),
        pair,
        jupiter: jupiter_submission,
        polymarket: polymarket_order,
        polymarket_token_id: token_id.to_owned(),
        jupiter_outcome_mint: jupiter_market.outcome_mint.clone(),
        before,
        maximum_repair_loss_micro_usd: config.maximum_emergency_hedge_loss_micro_usd,
        maximum_repair_slippage_bps: config.maximum_slippage_bps,
        minimum_post_fill_profit_micro_usd: config.strategy.minimum_entry_edge_total_micro_usd,
        maximum_post_fill_mismatch_micro: 10_000,
        fill_timeout: config.jupiter_fill_timeout,
        diagnostic_test_entry: false,
    };
    Ok(Some(
        coordinator
            .execute_entry(request, jupiter, polymarket)
            .await?,
    ))
}

async fn try_daily_live_entry(
    runtime: &DailyRuntime,
    screened_best: &EvaluatedCrossVenueRoute,
    jupiter: &JupiterHybridExecutor,
    polymarket: &PolymarketExecutor,
    polymarket_data: &PolymarketMarketData,
    coordinator: &mut LiveCoordinator,
    config: &EngineConfig,
) -> Result<Option<EntryDisposition>> {
    let (poly_cash, jup_usdc) = tokio::join!(
        polymarket.collateral_balance_micro_usd(),
        jupiter.usdc_balance(),
    );
    let poly_cash = poly_cash?;
    let jup_usdc = jup_usdc?;
    let mut strategy = config.strategy;
    strategy.jupiter_minimum_gross_order_micro_usd = strategy
        .jupiter_minimum_gross_order_micro_usd
        .max(PREDICTION_MINIMUM_BUY_MICRO_USD);
    let proposal =
        match evaluate_short_window_entry(Some(screened_best), poly_cash, jup_usdc, &strategy)? {
            EntryEvaluation::Eligible(proposal) => proposal,
            EntryEvaluation::Rejected(_) => return Ok(None),
        };
    let is_yes = proposal.route.jupiter_outcome == ShortWindowOutcome::Up;
    let (build, fresh_poly) = tokio::join!(
        async {
            let build = jupiter
                .prepare_buy(
                    &runtime.pair.jupiter.market_id,
                    is_yes,
                    proposal.jupiter.gross_micro_usd,
                    None,
                )
                .await
                .context("fresh daily Jupiter build failed")?;
            Ok::<_, anyhow::Error>((build, unix_ms()))
        },
        polymarket_data.binary_order_book(
            &runtime.pair.polymarket.market_id,
            runtime.pair.yes_token(),
            runtime.pair.no_token(),
        ),
    );
    let (build, build_received_at_ms) = build?;
    let fresh_poly = fresh_poly?;
    let (token_id, levels) = match proposal.route.polymarket_outcome {
        ShortWindowOutcome::Up => (runtime.pair.yes_token(), &fresh_poly.yes.asks),
        ShortWindowOutcome::Down => (runtime.pair.no_token(), &fresh_poly.no.asks),
    };
    let before = capture_entry_balances(
        polymarket,
        jupiter,
        token_id,
        None,
        &build.order.position_pubkey,
        true,
    )
    .await?;
    let jupiter_all_in = build
        .order
        .order_cost_micro_usd
        .checked_add(build.order.estimated_total_fee_micro_usd)
        .ok_or_else(|| anyhow!("daily Jupiter exact cost overflow"))?;
    let Some(selection) = select_precision_safe_polymarket_buy(
        levels,
        build.order.new_contracts_micro,
        jupiter_all_in,
        poly_cash,
        &strategy,
        config.maximum_slippage_bps,
    )?
    else {
        return Ok(None);
    };
    let jupiter_submission = jupiter.prepare_submission(build)?;
    let polymarket_order = polymarket
        .prepare_buy_fok(
            token_id,
            selection.limit_price_micro_usd,
            selection.contracts_micro,
        )
        .await?;
    let build_age = unix_ms().saturating_sub(build_received_at_ms);
    if build_age.saturating_add(JUPITER_CRITICAL_SLOT_BUDGET_MS)
        > config.maximum_jupiter_submit_quote_age_ms
    {
        bail!(
            "fresh daily Jupiter build cannot reach the 10-RPS critical slot in time: age={build_age}ms slotBudget={JUPITER_CRITICAL_SLOT_BUDGET_MS}ms limit={}ms",
            config.maximum_jupiter_submit_quote_age_ms
        );
    }
    let request = LiveEntryRequest {
        position_id: format!("live-{}", Uuid::new_v4()),
        pair: LivePairIdentity {
            key: runtime.pair.key.clone(),
            duration: "daily".to_owned(),
            start_ms: runtime.pair.polymarket.open_time_ms.unwrap_or(0),
            end_ms: runtime.pair.close_ms,
            polymarket_market_id: runtime.pair.polymarket.market_id.clone(),
            polymarket_slug: runtime.pair.polymarket_slug.clone(),
            polymarket_token_id: token_id.to_owned(),
            polymarket_outcome: outcome(proposal.route.polymarket_outcome),
            jupiter_market_id: runtime.pair.jupiter.market_id.clone(),
            jupiter_outcome_mint: None,
            jupiter_outcome: outcome(proposal.route.jupiter_outcome),
        },
        jupiter: jupiter_submission,
        polymarket: polymarket_order,
        polymarket_token_id: token_id.to_owned(),
        jupiter_outcome_mint: None,
        before,
        maximum_repair_loss_micro_usd: config.maximum_emergency_hedge_loss_micro_usd,
        maximum_repair_slippage_bps: config.maximum_slippage_bps,
        minimum_post_fill_profit_micro_usd: config.strategy.minimum_entry_edge_total_micro_usd,
        maximum_post_fill_mismatch_micro: 10_000,
        fill_timeout: config.jupiter_fill_timeout,
        diagnostic_test_entry: false,
    };
    Ok(Some(
        coordinator
            .execute_entry(request, jupiter, polymarket)
            .await?,
    ))
}

fn live_pair_identity(
    pair: &CrossVenuePair,
    route: CrossVenueShortWindowRoute,
    token_id: &str,
    jupiter_market: &jupol_domain::types::VenueMarket,
) -> LivePairIdentity {
    LivePairIdentity {
        key: pair.key(),
        duration: pair.duration.label().to_owned(),
        start_ms: pair.start_ms,
        end_ms: pair.end_ms,
        polymarket_market_id: pair.polymarket.market_id.clone(),
        polymarket_slug: pair.polymarket_slug.clone(),
        polymarket_token_id: token_id.to_owned(),
        polymarket_outcome: outcome(route.polymarket_outcome),
        jupiter_market_id: jupiter_market.market_id.clone(),
        jupiter_outcome_mint: jupiter_market.outcome_mint.clone(),
        jupiter_outcome: outcome(route.jupiter_outcome),
    }
}

const fn outcome(value: ShortWindowOutcome) -> Outcome {
    match value {
        ShortWindowOutcome::Up => Outcome::Up,
        ShortWindowOutcome::Down => Outcome::Down,
    }
}

async fn readiness(args: ReadinessArgs) -> Result<()> {
    let minimum = parse_usd(&args.minimum_venue_balance_usd)?;
    if env_optional("POLYMARKET_RELAYER_API_KEY").is_some()
        || env_optional("POLYMARKET_RELAYER_API_KEY_ADDRESS").is_some()
    {
        let _relayer = PolymarketRelayer::new(PolymarketRelayerOptions::from_env()?).await?;
        println!("Polymarket relayer wallet derivation is valid");
    }
    let polymarket = PolymarketExecutor::new(PolymarketOptions::from_env()?).await?;
    let poly = polymarket.assert_ready(minimum).await?;
    println!(
        "Polymarket ready: collateral=${}, minimum allowance=${}",
        format_usd(poly.collateral_balance_micro_usd),
        format_usd(poly.minimum_allowance_micro_usd)
    );
    if !args.polymarket_only {
        let scheduler =
            JupiterRequestScheduler::new(Duration::from_millis(DEVELOPER_REQUEST_INTERVAL_MS));
        let (jupiter, _) = live_components(Some(scheduler), true).await?;
        let balances = jupiter.assert_ready(minimum).await?;
        println!(
            "Jupiter ready: owner={}, USDC=${}, SOL={} lamports; Developer key bucket=10 RPS shared",
            jupiter.owner_pubkey(),
            format_usd(balances.usdc_micro),
            balances.sol_lamports
        );
    }
    Ok(())
}

async fn recover(args: RecoveryArgs) -> Result<()> {
    let scheduler =
        JupiterRequestScheduler::new(Duration::from_millis(DEVELOPER_REQUEST_INTERVAL_MS));
    let (jupiter, polymarket) = live_components(Some(scheduler), true).await?;
    let mut coordinator = LiveCoordinator::load(&args.live_state)?;
    for result in coordinator
        .recover_incomplete_positions_with_limits(
            &jupiter,
            &polymarket,
            parse_usd(&args.maximum_repair_loss_usd)?,
            args.maximum_slippage_bps,
        )
        .await?
    {
        println!("{result:?}");
    }
    Ok(())
}

async fn setup_approvals() -> Result<()> {
    let relayer = PolymarketRelayer::new(PolymarketRelayerOptions::from_env()?).await?;
    for hash in relayer.setup_trading_approvals().await? {
        println!("approval confirmed: {hash}");
    }
    Ok(())
}

async fn redeem(args: RedeemArgs) -> Result<()> {
    let relayer = PolymarketRelayer::new(PolymarketRelayerOptions::from_env()?).await?;
    let gamma_url = env_optional("POLYMARKET_GAMMA_URL");
    let gamma = PolymarketGammaClient::new(gamma_url.as_deref())?;
    let polymarket = PolymarketExecutor::new(PolymarketOptions::from_env()?).await?;
    let mut coordinator = LiveCoordinator::load(&args.live_state)?;
    let positions = coordinator
        .state()
        .positions
        .iter()
        .filter(|position| {
            args.market_id
                .as_ref()
                .is_none_or(|market_id| position.pair.polymarket_market_id == *market_id)
        })
        .map(|position| {
            (
                position.pair.key.clone(),
                position.pair.polymarket_market_id.clone(),
                position.pair.polymarket_token_id.clone(),
                position.pair.polymarket_outcome.clone(),
                position.polymarket_contracts_micro,
                position.polymarket_settled,
                position.polymarket_settlement_transaction_signature.clone(),
                position.polymarket_redemption_collateral_before_micro_usd,
            )
        })
        .collect::<Vec<_>>();
    if positions.is_empty() {
        if let Some(id) = args.market_id {
            bail!(
                "market {id} is not present in {}; refusing an untracked redemption that cannot update P&L",
                args.live_state.display()
            );
        }
        println!("No markets in durable state to redeem.");
        return Ok(());
    }
    let timeout = Duration::from_millis(args.timeout_ms.max(1_000));
    for (
        pair_key,
        market_id,
        token_id,
        held_outcome,
        contracts,
        settled,
        pending_hash,
        pending_before,
    ) in positions
    {
        if settled {
            println!("market {market_id} is already settled in durable state");
            continue;
        }
        let resolved = gamma
            .resolved_outcome_by_market_id(&market_id)
            .await?
            .ok_or_else(|| anyhow!("market {market_id} is not resolved"))?;
        let won = match held_outcome {
            Outcome::Up => matches!(resolved.as_str(), "UP" | "YES"),
            Outcome::Down => matches!(resolved.as_str(), "DOWN" | "NO"),
        };
        if !won || contracts <= 10_000 {
            coordinator.record_polymarket_settlement(&pair_key, false, None, 0)?;
            println!("market {market_id} resolved against the held outcome; recorded $0 payout");
            continue;
        }
        let (hash, collateral_before, expected_payout) =
            if let (Some(hash), Some(before)) = (pending_hash, pending_before) {
                (hash, before, contracts)
            } else {
                let expected_payout =
                    refresh_redeemable_polymarket_contracts(&polymarket, &token_id, contracts)
                        .await
                        .map_err(|reason| anyhow!(reason))?;
                let collateral_before = polymarket.collateral_balance_micro_usd().await?;
                let metadata = gamma.settlement_metadata(&market_id).await?;
                let hash = relayer.redeem(&metadata).await?;
                coordinator.record_polymarket_redemption_submission(
                    &pair_key,
                    hash.clone(),
                    collateral_before,
                )?;
                println!("market {market_id} redemption confirmed: {hash}");
                (hash, collateral_before, expected_payout)
            };
        let payout = verify_polymarket_redemption_credit(
            &polymarket,
            Some(&relayer),
            &hash,
            collateral_before,
            expected_payout,
            timeout,
        )
        .await
        .map_err(|error| {
            if error.zero_payout {
                let _ = coordinator
                    .invalidate_polymarket_redemption_submission(&pair_key, &error.message);
            }
            anyhow!(error.message)
        })?;
        coordinator.record_polymarket_settlement(&pair_key, true, Some(hash), payout)?;
        println!(
            "market {market_id} wallet credit verified: ${}",
            format_usd(payout)
        );
    }
    Ok(())
}

fn print_state(path: &Path) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&jupol_state::load_live_state(path)?)?
    );
    Ok(())
}

async fn live_components(
    scheduler: Option<JupiterRequestScheduler>,
    allow_subminimum_forecast_swap: bool,
) -> Result<(JupiterHybridExecutor, PolymarketExecutor)> {
    let api_key = env_required("JUPITER_API_KEY")?;
    let rpc = env_required("SOLANA_RPC_URL")?;
    let private_key = env_required("JUPITER_SOLANA_PRIVATE_KEY")?;
    let prediction_client = JupiterClient::new(JupiterClientOptions {
        base_url: env_optional("JUPITER_PREDICTION_URL")
            .unwrap_or_else(|| "https://api.jup.ag/prediction/v1".to_owned()),
        api_key: Some(api_key.clone()),
        minimum_request_interval: Some(Duration::ZERO),
        request_scheduler: scheduler.clone(),
        request_priority: RequestPriority::Critical,
    })?;
    let swap_client = JupiterSwapClient::new(SwapClientOptions {
        base_url: env_optional("JUPITER_SWAP_URL")
            .unwrap_or_else(|| "https://api.jup.ag/swap/v2".to_owned()),
        api_key: Some(api_key),
        minimum_request_interval: Some(Duration::ZERO),
        request_scheduler: scheduler,
        request_priority: RequestPriority::Critical,
    })?;
    let prediction = JupiterPredictionExecutor::new(prediction_client, &rpc, &private_key)?;
    let forecast = JupiterForecastSwapExecutor::new(swap_client, &rpc, &private_key)?;
    let jupiter = JupiterHybridExecutor {
        prediction,
        forecast,
        prediction_minimum_buy_micro_usd: PREDICTION_MINIMUM_BUY_MICRO_USD,
        allow_subminimum_forecast_swap,
    };
    jupiter.validate()?;
    Ok((
        jupiter,
        PolymarketExecutor::new(PolymarketOptions::from_env()?).await?,
    ))
}

fn validate_run_args(args: &RunArgs, live: bool) -> Result<()> {
    if !(25..=2_500).contains(&args.sample_interval_ms) {
        bail!("--sample-interval-ms must be 25..2500");
    }
    if args.polymarket_poll_ms < 100 {
        bail!("--polymarket-poll-ms must be at least 100");
    }
    if args.entry_cutoff_seconds < 30 {
        bail!("--entry-cutoff-seconds cannot be below the required 30 seconds");
    }
    if args.maximum_jupiter_submit_quote_age_ms <= JUPITER_CRITICAL_SLOT_BUDGET_MS {
        bail!(
            "--maximum-jupiter-submit-quote-age-ms must exceed the {JUPITER_CRITICAL_SLOT_BUDGET_MS}ms critical-slot budget required by the shared 10-RPS scheduler"
        );
    }
    if !(1..=500).contains(&args.maximum_slippage_bps) {
        bail!("--maximum-slippage-bps must be 1..500");
    }
    if args.polymarket_depth_haircut_bps > 5_000 {
        bail!("--polymarket-depth-haircut-bps must be <=5000");
    }
    if live && args.no_web {
        bail!("live mode cannot disable the status/single-instance server");
    }
    Ok(())
}

fn engine_config(args: &RunArgs) -> Result<EngineConfig> {
    let minimum_venue_balance = parse_usd(&args.minimum_venue_balance_usd)?;
    let allocation = parse_usd(&args.max_venue_allocation_usd)?;
    if allocation <= 0 || allocation > minimum_venue_balance {
        bail!("max venue allocation must be positive and <= minimum venue balance");
    }
    let jupiter_minimum = parse_usd(&args.jupiter_minimum_order_usd)?;
    if jupiter_minimum < PREDICTION_MINIMUM_BUY_MICRO_USD && args.disable_sub_five_jupiter_swap {
        bail!("sub-$5 orders require native Forecast Swap V2");
    }
    Ok(EngineConfig {
        strategy: ShortWindowStrategyConfig {
            polymarket_maximum_allocation_micro_usd: allocation,
            jupiter_maximum_allocation_micro_usd: allocation,
            jupiter_minimum_gross_order_micro_usd: jupiter_minimum,
            polymarket_minimum_gross_order_micro_usd: parse_usd(
                &args.polymarket_minimum_order_usd,
            )?,
            polymarket_minimum_contracts_micro: 5_000_000,
            minimum_entry_edge_micro_usd_per_contract: parse_usd(&args.minimum_entry_edge_usd)?,
            minimum_entry_edge_total_micro_usd: parse_usd(&args.minimum_entry_profit_usd)?,
            minimum_exit_profit_micro_usd: parse_usd("0.10")?,
        },
        minimum_venue_balance_micro_usd: minimum_venue_balance,
        maximum_jupiter_submit_quote_age_ms: args.maximum_jupiter_submit_quote_age_ms,
        entry_cutoff_ms: args.entry_cutoff_seconds.saturating_mul(1_000),
        max_polymarket_age_ms: args.max_polymarket_age_ms,
        max_jupiter_age_ms: args.max_jupiter_age_ms,
        maximum_slippage_bps: args.maximum_slippage_bps,
        polymarket_depth_haircut_bps: args.polymarket_depth_haircut_bps,
        maximum_emergency_hedge_loss_micro_usd: parse_usd(&args.maximum_emergency_hedge_loss_usd)?,
        jupiter_fill_timeout: Duration::from_millis(args.jupiter_fill_timeout_ms),
        maximum_open_positions: args.maximum_open_positions,
    })
}

fn haircut_polymarket_book(book: &BinaryOrderBook, haircut_bps: u32) -> BinaryOrderBook {
    let mut result = book.clone();
    let retained = Micro::from(10_000_u32.saturating_sub(haircut_bps));
    for level in result.yes.asks.iter_mut().chain(result.no.asks.iter_mut()) {
        level.contracts_micro = level.contracts_micro.saturating_mul(retained) / 10_000;
    }
    result
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PrecisionSafePolymarketBuy {
    contracts_micro: Micro,
    limit_price_micro_usd: Micro,
}

fn select_precision_safe_polymarket_buy(
    levels: &[BookLevel],
    requested_contracts_micro: Micro,
    jupiter_all_in_micro_usd: Micro,
    polymarket_cash_micro_usd: Micro,
    strategy: &ShortWindowStrategyConfig,
    slippage_bps: u32,
) -> Result<Option<PrecisionSafePolymarketBuy>> {
    let requested = requested_contracts_micro - requested_contracts_micro.rem_euclid(10_000);
    if requested < strategy.polymarket_minimum_contracts_micro {
        return Ok(None);
    }
    let Some(requested_quote) = quote_buy_across_levels(levels, requested, false)? else {
        return Ok(None);
    };
    let minimum_limit = ((requested_quote.limit_price_micro_usd + 9_999) / 10_000) * 10_000;
    let maximum_limit = buy_limit(requested_quote.limit_price_micro_usd, slippage_bps)?;
    let budget = polymarket_cash_micro_usd.min(strategy.polymarket_maximum_allocation_micro_usd);
    let mut best: Option<(PrecisionSafePolymarketBuy, Micro)> = None;
    let mut limit = minimum_limit;
    while limit <= maximum_limit {
        let contracts = normalize_fok_contracts_for_price(limit, requested);
        if contracts >= strategy.polymarket_minimum_contracts_micro {
            let mismatch = requested.saturating_sub(contracts);
            let mismatch_bps = mismatch
                .checked_mul(10_000)
                .and_then(|value| value.checked_div(requested))
                .ok_or_else(|| anyhow!("Polymarket precision mismatch overflow"))?;
            if mismatch_bps <= MAXIMUM_PRECISION_SIZE_MISMATCH_BPS
                && quote_buy_across_levels(levels, contracts, false)?
                    .is_some_and(|quote| quote.limit_price_micro_usd <= limit)
            {
                let gross = limit
                    .checked_mul(contracts)
                    .and_then(|value| value.checked_div(ONE_CONTRACT_MICRO))
                    .ok_or_else(|| anyhow!("Polymarket precision-safe gross overflow"))?;
                let fee = polymarket_crypto_taker_fee_per_contract_micro_usd(limit)?
                    .checked_mul(contracts)
                    .and_then(|value| value.checked_add(ONE_CONTRACT_MICRO / 2))
                    .and_then(|value| value.checked_div(ONE_CONTRACT_MICRO))
                    .ok_or_else(|| anyhow!("Polymarket precision-safe fee overflow"))?;
                let polymarket_all_in = gross
                    .checked_add(fee)
                    .ok_or_else(|| anyhow!("Polymarket precision-safe cost overflow"))?;
                let total_all_in = polymarket_all_in
                    .checked_add(jupiter_all_in_micro_usd)
                    .ok_or_else(|| anyhow!("precision-safe entry cost overflow"))?;
                let edge = contracts
                    .checked_sub(total_all_in)
                    .ok_or_else(|| anyhow!("precision-safe entry edge overflow"))?;
                let edge_per_contract = edge
                    .checked_mul(ONE_CONTRACT_MICRO)
                    .and_then(|value| value.checked_div(contracts))
                    .ok_or_else(|| anyhow!("precision-safe edge-per-contract overflow"))?;
                if gross >= strategy.polymarket_minimum_gross_order_micro_usd
                    && polymarket_all_in <= budget
                    && edge >= strategy.minimum_entry_edge_total_micro_usd
                    && edge_per_contract >= strategy.minimum_entry_edge_micro_usd_per_contract
                    && best.as_ref().is_none_or(|(current, current_cost)| {
                        contracts > current.contracts_micro
                            || (contracts == current.contracts_micro
                                && polymarket_all_in < *current_cost)
                    })
                {
                    best = Some((
                        PrecisionSafePolymarketBuy {
                            contracts_micro: contracts,
                            limit_price_micro_usd: limit,
                        },
                        polymarket_all_in,
                    ));
                }
            }
        }
        limit = limit.saturating_add(10_000);
    }
    Ok(best.map(|(selection, _)| selection))
}

fn buy_limit(price: Micro, slippage_bps: u32) -> Result<Micro> {
    let numerator = price
        .checked_mul(Micro::from(10_000_u32.saturating_add(slippage_bps)))
        .ok_or_else(|| anyhow!("limit price overflow"))?;
    let slipped = (numerator + 9_999) / 10_000;
    Ok((((slipped + 9_999) / 10_000) * 10_000).min(ONE_USD_MICRO - 10_000))
}

fn route_label(route: &CrossVenueShortWindowRoute) -> String {
    format!(
        "BUY Poly {} + Jup {}",
        outcome_label(route.polymarket_outcome),
        outcome_label(route.jupiter_outcome)
    )
}

const fn outcome_label(outcome: ShortWindowOutcome) -> &'static str {
    match outcome {
        ShortWindowOutcome::Up => "UP",
        ShortWindowOutcome::Down => "DOWN",
    }
}

fn candidate_signature(route: &EvaluatedCrossVenueRoute) -> String {
    format!(
        "{}:{}:{}:{}",
        route_label(&route.route),
        route.polymarket_ask.price_micro_usd,
        route.jupiter_ask.price_micro_usd,
        route.common_depth_contracts_micro
    )
}

fn candidate_record(
    session_id: &str,
    pair: &CrossVenuePair,
    best: &EvaluatedCrossVenueRoute,
    poly_age_ms: i64,
    jupiter_age_ms: i64,
    stale: bool,
) -> serde_json::Value {
    json!({
        "schemaVersion": 3, "type": "candidate", "sessionId": session_id, "at": now_iso(),
        "pairKey": pair.key(), "duration": pair.duration.label(), "route": route_label(&best.route),
        "polymarketAskUsd": format_usd(best.polymarket_ask.price_micro_usd),
        "jupiterAskUsd": format_usd(best.jupiter_ask.price_micro_usd),
        "allInUsdPerContract": format_usd(best.effective_all_in_micro_usd_per_contract),
        "edgeUsdPerContract": format_usd(best.effective_edge_micro_usd_per_contract),
        "commonContracts": format_contracts(best.common_depth_contracts_micro),
        "feeAdjustedCandidate": best.is_fee_adjusted_candidate, "stale": stale,
        "polymarketAgeMs": poly_age_ms, "jupiterAgeMs": jupiter_age_ms,
    })
}

fn daily_candidate_record(
    session_id: &str,
    pair: &DailyThresholdPair,
    best: &EvaluatedCrossVenueRoute,
) -> serde_json::Value {
    json!({
        "schemaVersion": 3,
        "type": "daily_threshold_candidate",
        "sessionId": session_id,
        "at": now_iso(),
        "pairKey": pair.key,
        "close": iso_ms(pair.close_ms),
        "polymarketMarketId": pair.polymarket.market_id,
        "jupiterMarketId": pair.jupiter.market_id,
        "route": route_label(&best.route),
        "polymarketAskUsd": format_usd(best.polymarket_ask.price_micro_usd),
        "jupiterAskUsd": format_usd(best.jupiter_ask.price_micro_usd),
        "allInUsdPerContract": format_usd(best.effective_all_in_micro_usd_per_contract),
        "edgeUsdPerContract": format_usd(best.effective_edge_micro_usd_per_contract),
        "commonContracts": format_contracts(best.common_depth_contracts_micro),
        "feeAdjustedCandidate": best.is_fee_adjusted_candidate,
    })
}

async fn update_duration_status(
    store: &StatusStore,
    runtime: &RuntimePair,
    best: Option<&EvaluatedCrossVenueRoute>,
    stale: bool,
    poly_age_ms: i64,
    jup_age_ms: i64,
) {
    let poly = runtime
        .polymarket_book
        .as_ref()
        .map(|book| book_status(book, poly_age_ms, stale));
    let jup = runtime
        .jupiter_book
        .as_ref()
        .map(|book| book_status(book, jup_age_ms, stale));
    let route = best.map(|route| RouteStatus {
        label: route_label(&route.route),
        all_in_usd_per_contract: format_usd(route.effective_all_in_micro_usd_per_contract),
        edge_usd_per_contract: format_usd(route.effective_edge_micro_usd_per_contract),
        common_contracts: format_contracts(route.common_depth_contracts_micro),
        fee_adjusted_candidate: route.is_fee_adjusted_candidate,
        stale,
    });
    store
        .update_duration(runtime.pair.duration.label(), |entry| {
            entry.books.polymarket = poly;
            entry.books.jupiter = jup;
            entry.best_route = route;
            entry.samples = entry.samples.saturating_add(1);
            if best.is_some_and(|value| value.is_fee_adjusted_candidate) && !stale {
                entry.opportunities = entry.opportunities.saturating_add(1);
            }
        })
        .await;
}

fn book_status(book: &BinaryOrderBook, age_ms: i64, stale: bool) -> BookStatus {
    BookStatus {
        up: book.yes.asks.first().map(|level| BestAskStatus {
            price_usd: format_usd(level.price_micro_usd),
            contracts: format_contracts(level.contracts_micro),
            received_at: iso_ms(book.received_at_ms),
        }),
        down: book.no.asks.first().map(|level| BestAskStatus {
            price_usd: format_usd(level.price_micro_usd),
            contracts: format_contracts(level.contracts_micro),
            received_at: iso_ms(book.received_at_ms),
        }),
        received_at: iso_ms(book.received_at_ms),
        age_ms,
        stale,
    }
}

async fn update_live_status(store: &StatusStore, coordinator: &LiveCoordinator) {
    let state = coordinator.state();
    let positions = state.positions.iter().map(position_status).collect();
    store
        .update_strategy(|strategy| {
            strategy.halted = state.halted;
            strategy.halt_reason = state.halt_reason.clone();
            strategy.entry_quarantine_reason = coordinator.entry_blocker();
            strategy.polymarket_cash_usd = state
                .polymarket_cash_micro_usd
                .map_or_else(|| "0".to_owned(), format_usd);
            strategy.jupiter_cash_usd = state
                .jupiter_cash_micro_usd
                .map_or_else(|| "0".to_owned(), format_usd);
            strategy.realized_profit_usd = format_usd(state.realized_profit_micro_usd);
            strategy.open_positions = state.positions.len();
            strategy.settled_positions = state.settled_positions.len();
            strategy.awaiting_resolution = state
                .positions
                .iter()
                .filter(|position| {
                    matches!(
                        position.phase,
                        jupol_state::LivePositionPhase::AwaitingResolution
                    )
                })
                .count();
            strategy.positions = positions;
            strategy.wallet_balances.polymarket_collateral_usd =
                state.polymarket_cash_micro_usd.map(format_usd);
            strategy.wallet_balances.jupiter_usdc_usd =
                state.jupiter_cash_micro_usd.map(format_usd);
            strategy.wallet_balances.observed_at = Some(now_iso());
            strategy.wallet_balances.error = None;
        })
        .await;
}

fn position_status(position: &LivePosition) -> serde_json::Value {
    let total_cost = position
        .polymarket_entry_cost_micro_usd
        .saturating_add(position.jupiter_entry_cost_micro_usd);
    let aligned = position
        .polymarket_contracts_micro
        .min(position.jupiter_contracts_micro);
    let skew = (position.polymarket_contracts_micro - position.jupiter_contracts_micro).abs();
    let phase = serde_json::to_value(&position.phase)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned());
    let (action, reason, maximum_loss, skew_bps) =
        position.post_fill_risk_plan.as_ref().map_or_else(
            || {
                (
                    "manual_reconciliation",
                    "No verified post-fill plan is available.".to_owned(),
                    total_cost,
                    None,
                )
            },
            |plan| {
                (
                    match plan.action {
                        PostFillAction::HoldOrExitNormally => "hold_or_exit_normally",
                        PostFillAction::QuoteRepair => "quote_repair",
                        PostFillAction::ManualReconciliation => "manual_reconciliation",
                    },
                    plan.reason.clone(),
                    plan.maximum_modeled_loss_micro_usd,
                    plan.venue_size_mismatch_bps,
                )
            },
        );
    let hedge_status = match position.phase {
        LivePositionPhase::RecoveryPlanning => "recovery_planning",
        LivePositionPhase::ExposureError => "exposure_error",
        _ if skew <= 10_000 => "perfect",
        _ => "bounded_residual",
    };
    json!({
        "id": position.id,
        "pairKey": position.pair.key,
        "duration": position.pair.duration,
        "start": iso_ms(position.pair.start_ms),
        "end": iso_ms(position.pair.end_ms),
        "polymarketSlug": position.pair.polymarket_slug,
        "polymarketMarketId": position.pair.polymarket_market_id,
        "jupiterMarketId": position.pair.jupiter_market_id,
        "phase": phase,
        "polymarketOutcome": match position.pair.polymarket_outcome { Outcome::Up => "UP", Outcome::Down => "DOWN" },
        "jupiterOutcome": match position.pair.jupiter_outcome { Outcome::Up => "UP", Outcome::Down => "DOWN" },
        "polymarketContracts": format_contracts(position.polymarket_contracts_micro),
        "jupiterContracts": format_contracts(position.jupiter_contracts_micro),
        "jupiterQuotedContracts": position.jupiter_quoted_contracts_micro.map(format_contracts),
        "polymarketCostUsd": format_usd(position.polymarket_entry_cost_micro_usd),
        "jupiterCostUsd": format_usd(position.jupiter_entry_cost_micro_usd),
        "totalCostUsd": format_usd(total_cost),
        "minimumAlignedPnlUsd": format_usd(aligned.saturating_sub(total_cost)),
        "polymarketWinPnlUsd": format_usd(scenario_pnl(position, &ResolutionScenarioCode::PolymarketOnlyWin, position.polymarket_contracts_micro.saturating_sub(total_cost))),
        "jupiterWinPnlUsd": format_usd(scenario_pnl(position, &ResolutionScenarioCode::JupiterOnlyWin, position.jupiter_contracts_micro.saturating_sub(total_cost))),
        "bothWinPnlUsd": format_usd(scenario_pnl(position, &ResolutionScenarioCode::BothWin, position.polymarket_contracts_micro.saturating_add(position.jupiter_contracts_micro).saturating_sub(total_cost))),
        "bothLosePnlUsd": format_usd(scenario_pnl(position, &ResolutionScenarioCode::BothLose, total_cost.saturating_neg())),
        "maximumModeledLossUsd": format_usd(maximum_loss),
        "postFillAction": action,
        "postFillReason": reason,
        "contractSkew": format_contracts(skew),
        "contractSkewBps": skew_bps.map(|value| value.to_string()),
        "hedgeStatus": hedge_status,
        "isHedged": position.polymarket_contracts_micro > 0 && position.jupiter_contracts_micro > 0 && skew <= 10_000,
        "polymarketSettled": position.polymarket_settled,
        "jupiterSettled": position.jupiter_settled,
        "jupiterRentReclaimed": position.jupiter_rent_reclaimed,
        "jupiterRentReclaimedSol": format_sol_lamports(position.jupiter_rent_reclaimed_lamports),
        "realizedProfitUsd": format_usd(position.realized_profit_micro_usd),
        "enteredAt": iso_ms(position.entered_at_ms),
        "polymarketEntrySubmissionResult": position.polymarket_entry_submission_result,
        "jupiterEntrySubmissionResult": position.jupiter_entry_submission_result,
        "lastError": position.last_error,
        "settlementError": position.settlement_error,
    })
}

fn scenario_pnl(position: &LivePosition, code: &ResolutionScenarioCode, fallback: Micro) -> Micro {
    position
        .post_fill_risk_plan
        .as_ref()
        .and_then(|plan| {
            plan.scenarios
                .iter()
                .find(|scenario| scenario.code == *code)
        })
        .map_or(fallback, |scenario| scenario.pnl_micro_usd)
}

fn format_sol_lamports(lamports: Micro) -> String {
    let sign = if lamports < 0 { "-" } else { "" };
    let absolute = lamports.abs();
    let whole = absolute / 1_000_000_000;
    let fractional = absolute % 1_000_000_000;
    format!("{sign}{whole}.{fractional:09}")
}

async fn attempt_settlements(
    coordinator: &mut LiveCoordinator,
    relayer: Option<&PolymarketRelayer>,
    polymarket: Option<&PolymarketExecutor>,
    gamma: &PolymarketGammaClient,
    jupiter: &JupiterHybridExecutor,
    claim_timeout: Duration,
) {
    let positions = coordinator
        .state()
        .positions
        .iter()
        .filter(|position| {
            position.post_fill_risk_plan.is_some()
                && !position.polymarket_settled
                && unix_ms() >= position.pair.end_ms
        })
        .map(|position| {
            (
                position.pair.key.clone(),
                position.pair.polymarket_market_id.clone(),
                position.pair.polymarket_slug.clone(),
                position.pair.polymarket_token_id.clone(),
                position.pair.polymarket_outcome.clone(),
                position.polymarket_contracts_micro,
                position.polymarket_settlement_transaction_signature.clone(),
                position.polymarket_redemption_collateral_before_micro_usd,
            )
        })
        .collect::<Vec<_>>();
    for (
        pair_key,
        market_id,
        _slug,
        token_id,
        held_outcome,
        contracts,
        pending_hash,
        pending_collateral_before,
    ) in positions
    {
        let resolved = match gamma.resolved_outcome_by_market_id(&market_id).await {
            Ok(Some(outcome)) => outcome,
            Ok(None) => continue,
            Err(error) => {
                let reason = format!("Polymarket resolution retry: {error}");
                let _ = coordinator.record_settlement_error(&pair_key, &reason);
                warn!(market_id, "{reason}");
                continue;
            }
        };
        let won = match held_outcome {
            Outcome::Up => matches!(resolved.as_str(), "UP" | "YES"),
            Outcome::Down => matches!(resolved.as_str(), "DOWN" | "NO"),
        };
        if !won || contracts <= 10_000 {
            if let Err(error) = coordinator.record_polymarket_settlement(&pair_key, false, None, 0)
            {
                warn!(market_id, "could not persist losing settlement: {error}");
            }
            continue;
        }
        let Some(polymarket) = polymarket else {
            let reason =
                "automatic redemption cannot verify collateral without the Polymarket executor";
            let _ = coordinator.record_settlement_error(&pair_key, reason);
            continue;
        };
        if let (Some(hash), Some(collateral_before)) = (pending_hash, pending_collateral_before) {
            match verify_polymarket_redemption_credit(
                polymarket,
                relayer,
                &hash,
                collateral_before,
                contracts,
                claim_timeout,
            )
            .await
            {
                Ok(payout) => {
                    if let Err(error) = coordinator.record_polymarket_settlement(
                        &pair_key,
                        true,
                        Some(hash),
                        payout,
                    ) {
                        warn!(market_id, "could not persist verified redemption: {error}");
                    }
                }
                Err(error) => {
                    if error.zero_payout {
                        let _ = coordinator
                            .invalidate_polymarket_redemption_submission(&pair_key, &error.message);
                    } else {
                        let _ = coordinator.record_settlement_error(&pair_key, &error.message);
                    }
                    warn!(market_id, "{}", error.message);
                }
            }
            continue;
        }
        let Some(relayer) = relayer else {
            let reason =
                "automatic redemption is disabled because relayer credentials are unavailable";
            let _ = coordinator.record_settlement_error(&pair_key, reason);
            continue;
        };
        let redeemable_contracts =
            match refresh_redeemable_polymarket_contracts(polymarket, &token_id, contracts).await {
                Ok(contracts) => contracts,
                Err(reason) => {
                    let _ = coordinator.record_settlement_error(&pair_key, &reason);
                    warn!(market_id, "{reason}");
                    continue;
                }
            };
        let collateral_before = match polymarket.collateral_balance_micro_usd().await {
            Ok(balance) => balance,
            Err(error) => {
                let reason = format!("pre-redemption collateral snapshot retry: {error}");
                let _ = coordinator.record_settlement_error(&pair_key, &reason);
                warn!(market_id, "{reason}");
                continue;
            }
        };
        match gamma.settlement_metadata(&market_id).await {
            Ok(metadata) if metadata.closed => match relayer.redeem(&metadata).await {
                Ok(hash) => {
                    info!(
                        market_id,
                        transaction_hash = hash,
                        "automatic Polymarket redemption confirmed"
                    );
                    if let Err(error) = coordinator.record_polymarket_redemption_submission(
                        &pair_key,
                        hash.clone(),
                        collateral_before,
                    ) {
                        warn!(
                            market_id,
                            "redemption confirmed but pending state persistence failed: {error}"
                        );
                    }
                    match verify_polymarket_redemption_credit(
                        polymarket,
                        Some(relayer),
                        &hash,
                        collateral_before,
                        redeemable_contracts,
                        claim_timeout,
                    )
                    .await
                    {
                        Ok(payout) => {
                            if let Err(error) = coordinator.record_polymarket_settlement(
                                &pair_key,
                                true,
                                Some(hash),
                                payout,
                            ) {
                                warn!(
                                    market_id,
                                    "redemption verified but state persistence failed: {error}"
                                );
                            }
                        }
                        Err(error) => {
                            if error.zero_payout {
                                let _ = coordinator.invalidate_polymarket_redemption_submission(
                                    &pair_key,
                                    &error.message,
                                );
                            } else {
                                let _ =
                                    coordinator.record_settlement_error(&pair_key, &error.message);
                            }
                            warn!(market_id, "{}", error.message);
                        }
                    }
                }
                Err(error) => {
                    let reason = format!("automatic redemption retry: {error}");
                    let _ = coordinator.record_settlement_error(&pair_key, &reason);
                    warn!(market_id, "{reason}");
                }
            },
            Ok(_) => {}
            Err(error) => {
                let reason = format!("settlement metadata retry: {error}");
                let _ = coordinator.record_settlement_error(&pair_key, &reason);
                warn!(market_id, "{reason}");
            }
        }
    }

    let jupiter_positions = coordinator
        .state()
        .positions
        .iter()
        .filter(|position| {
            position.post_fill_risk_plan.is_some()
                && !position.jupiter_settled
                && unix_ms() >= position.pair.end_ms
        })
        .map(|position| {
            (
                position.pair.key.clone(),
                position.pair.jupiter_market_id.clone(),
                position.jupiter_position_pubkey.clone(),
                position.jupiter_contracts_micro,
            )
        })
        .collect::<Vec<_>>();
    for (pair_key, market_id, position_pubkey, contracts) in jupiter_positions {
        let won = match jupiter.did_selected_market_win(&market_id).await {
            Ok(Some(won)) => won,
            Ok(None) => continue,
            Err(error) => {
                let reason = format!("Jupiter resolution retry: {error}");
                let _ = coordinator.record_settlement_error(&pair_key, &reason);
                warn!(market_id, "{reason}");
                continue;
            }
        };
        if !won || contracts <= 10_000 {
            if let Err(error) = coordinator.record_jupiter_settlement(&pair_key, false, None, 0) {
                warn!(
                    market_id,
                    "could not persist losing Jupiter settlement: {error}"
                );
            }
            continue;
        }
        match jupiter
            .claim_position(&position_pubkey, contracts, claim_timeout)
            .await
        {
            Ok(claim) => {
                info!(
                    market_id,
                    transaction_signature = claim.transaction_signature,
                    payout_micro_usd = claim.payout_micro_usd.to_string(),
                    "Jupiter settlement verified"
                );
                if let Err(error) = coordinator.record_jupiter_settlement(
                    &pair_key,
                    true,
                    Some(claim.transaction_signature),
                    claim.payout_micro_usd,
                ) {
                    warn!(
                        market_id,
                        "Jupiter claim confirmed but state persistence failed: {error}"
                    );
                }
            }
            Err(error) => {
                let reason = format!("Jupiter claim/auto-settlement retry: {error}");
                let _ = coordinator.record_settlement_error(&pair_key, &reason);
                warn!(market_id, "{reason}");
            }
        }
    }
    let rent_positions = coordinator
        .state()
        .positions
        .iter()
        .filter(|position| {
            position.post_fill_risk_plan.is_some()
                && position.jupiter_settled
                && !position.jupiter_rent_reclaimed
        })
        .map(|position| {
            (
                position.pair.key.clone(),
                position.jupiter_position_pubkey.clone(),
            )
        })
        .collect::<Vec<_>>();
    for (pair_key, position_pubkey) in rent_positions {
        match jupiter
            .reclaim_position_rent(&position_pubkey, claim_timeout)
            .await
        {
            Ok(reclaim) => {
                if let Err(error) = coordinator.record_jupiter_rent_reclaim(
                    &pair_key,
                    reclaim.transaction_signatures,
                    reclaim.reclaimed_lamports,
                ) {
                    warn!(
                        pair_key,
                        "rent reclaimed but state persistence failed: {error}"
                    );
                }
            }
            Err(error) => {
                let reason = format!("Jupiter rent-reclaim retry: {error}");
                let _ = coordinator.record_settlement_error(&pair_key, &reason);
                warn!(pair_key, "{reason}");
            }
        }
    }
    if let Err(error) = coordinator.finalize_fully_settled_positions() {
        warn!("final settlement accounting retry: {error}");
    }
}

async fn refresh_redeemable_polymarket_contracts(
    polymarket: &PolymarketExecutor,
    token_id: &str,
    recorded_contracts: Micro,
) -> std::result::Result<Micro, String> {
    let observed = polymarket
        .refresh_conditional_balance_micro(token_id)
        .await
        .map_err(|error| format!("pre-redemption token balance retry: {error}"))?;
    validate_redeemable_polymarket_contracts(recorded_contracts, observed)
}

fn validate_redeemable_polymarket_contracts(
    recorded_contracts: Micro,
    observed_contracts: Micro,
) -> std::result::Result<Micro, String> {
    const CONTRACT_TOLERANCE_MICRO: Micro = 10_000;
    if observed_contracts <= CONTRACT_TOLERANCE_MICRO {
        return Err(format!(
            "redemption blocked: durable state records {recorded_contracts} Polymarket contracts but the wallet owns only {observed_contracts}; the position was likely sold/repaired without complete state reconciliation, so a zero-value redemption and unverifiable P&L are refused"
        ));
    }
    if (observed_contracts - recorded_contracts).abs() > CONTRACT_TOLERANCE_MICRO {
        return Err(format!(
            "redemption blocked: durable state records {recorded_contracts} Polymarket contracts but the wallet owns {observed_contracts}; reconcile the missing repair/sale before settlement"
        ));
    }
    Ok(observed_contracts)
}

async fn observe_polymarket_redemption_credit(
    polymarket: &PolymarketExecutor,
    collateral_before: Micro,
    expected_payout: Micro,
    timeout: Duration,
) -> std::result::Result<Micro, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let tolerance = 10_000.max(expected_payout / 1_000);
    loop {
        let last_observation = match polymarket.refresh_collateral_balance_micro_usd().await {
            Ok(collateral_after) => {
                let payout = collateral_after.saturating_sub(collateral_before);
                if payout > 0 && (payout - expected_payout).abs() <= tolerance {
                    return Ok(payout);
                }
                format!(
                    "expected {expected_payout}, collateral before {collateral_before}, after {collateral_after}, delta {payout}"
                )
            }
            Err(error) => format!("collateral refresh failed: {error}"),
        };
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "confirmed Polymarket redemption has no matching verified wallet credit yet: {last_observation}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

struct PolymarketRedemptionObservationError {
    zero_payout: bool,
    message: String,
}

async fn verify_polymarket_redemption_credit(
    polymarket: &PolymarketExecutor,
    relayer: Option<&PolymarketRelayer>,
    transaction_hash: &str,
    collateral_before: Micro,
    expected_payout: Micro,
    timeout: Duration,
) -> std::result::Result<Micro, PolymarketRedemptionObservationError> {
    let balance_error = match observe_polymarket_redemption_credit(
        polymarket,
        collateral_before,
        expected_payout,
        timeout,
    )
    .await
    {
        Ok(payout) => return Ok(payout),
        Err(error) => error,
    };
    let Some(relayer) = relayer else {
        return Err(PolymarketRedemptionObservationError {
            zero_payout: false,
            message: balance_error,
        });
    };
    match relayer
        .verified_redemption_receipt_credit(transaction_hash)
        .await
    {
        Ok(Some(0)) => Err(PolymarketRedemptionObservationError {
            zero_payout: true,
            message: format!(
                "redemption {transaction_hash} confirmed on Polygon with a zero CTF payout; the durable position was stale or already unwound, so the pending redemption was invalidated: {balance_error}"
            ),
        }),
        Ok(Some(payout)) => {
            let tolerance = 10_000.max(expected_payout / 1_000);
            if (payout - expected_payout).abs() <= tolerance {
                Ok(payout)
            } else {
                Err(PolymarketRedemptionObservationError {
                    zero_payout: false,
                    message: format!(
                        "redemption {transaction_hash} credited {payout} pUSD on-chain, outside expected {expected_payout} ± {tolerance}: {balance_error}"
                    ),
                })
            }
        }
        Ok(None) => Err(PolymarketRedemptionObservationError {
            zero_payout: false,
            message: format!(
                "redemption receipt {transaction_hash} is not available yet: {balance_error}"
            ),
        }),
        Err(error) => Err(PolymarketRedemptionObservationError {
            zero_payout: false,
            message: format!(
                "could not verify redemption receipt {transaction_hash}: {error}; {balance_error}"
            ),
        }),
    }
}

fn event_for_disposition(duration: &str, disposition: &EntryDisposition) -> StatusEvent {
    let (level, kind) = match disposition {
        EntryDisposition::Opened { .. } => ("success", "LIVE_ENTRY_OPENED"),
        EntryDisposition::ZeroExposure { .. } => ("info", "LIVE_ENTRY_ZERO_EXPOSURE"),
        EntryDisposition::RecoveryPending { .. } => ("error", "LIVE_ENTRY_RECOVERY"),
    };
    StatusEvent {
        id: String::new(),
        timestamp: String::new(),
        kind: kind.to_owned(),
        level: level.to_owned(),
        duration: Some(duration.to_owned()),
        code: Some(kind.to_owned()),
        message: format!("{disposition:?}"),
        details: None,
    }
}

fn error_event(duration: &str, code: &str, message: &str) -> StatusEvent {
    StatusEvent {
        id: String::new(),
        timestamp: String::new(),
        kind: "execution_error".to_owned(),
        level: "error".to_owned(),
        duration: Some(duration.to_owned()),
        code: Some(code.to_owned()),
        message: message.to_owned(),
        details: None,
    }
}

fn classify_execution_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("expired") || lower.contains("age=") {
        "JUPITER_BUILD_EXPIRED"
    } else if lower.contains("minimum") || lower.contains("min size") {
        "VENUE_MINIMUM_REJECTED"
    } else if lower.contains("precision") || lower.contains("decimal") {
        "POLYMARKET_PRECISION_REJECTED"
    } else if lower.contains("401") || lower.contains("unauthorized") {
        "API_UNAUTHORIZED"
    } else if lower.contains("429") || lower.contains("rate limit") {
        "API_RATE_LIMITED"
    } else if lower.contains("simulation") {
        "SOLANA_SIMULATION_FAILED"
    } else if lower.contains("ambiguous") {
        "AMBIGUOUS_SUBMISSION"
    } else if lower.contains("balance") || lower.contains("allowance") {
        "BALANCE_OR_ALLOWANCE"
    } else {
        "ENTRY_PREFLIGHT_FAILED"
    }
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn env_required(name: &str) -> Result<String> {
    env_optional(name).ok_or_else(|| anyhow!("missing required environment variable {name}"))
}

fn unix_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod execution_tests {
    use super::*;

    fn strategy() -> ShortWindowStrategyConfig {
        ShortWindowStrategyConfig {
            polymarket_maximum_allocation_micro_usd: 100_000_000,
            jupiter_maximum_allocation_micro_usd: 100_000_000,
            jupiter_minimum_gross_order_micro_usd: 1,
            polymarket_minimum_gross_order_micro_usd: 100_000,
            polymarket_minimum_contracts_micro: 10_000,
            minimum_entry_edge_micro_usd_per_contract: 1,
            minimum_entry_edge_total_micro_usd: 1,
            minimum_exit_profit_micro_usd: 1,
        }
    }

    #[test]
    fn preflight_selects_a_cent_compatible_polymarket_quantity() {
        let selection = select_precision_safe_polymarket_buy(
            &[BookLevel::new(340_000, 100_000_000)],
            14_110_000,
            6_000_000,
            100_000_000,
            &strategy(),
            0,
        )
        .unwrap()
        .unwrap();
        assert_eq!(selection.contracts_micro, 14_000_000);
        assert_eq!(selection.limit_price_micro_usd, 340_000);
    }

    #[test]
    fn preflight_rejects_precision_truncation_over_five_percent() {
        let selection = select_precision_safe_polymarket_buy(
            &[BookLevel::new(330_000, 100_000_000)],
            1_500_000,
            100_000,
            100_000_000,
            &strategy(),
            0,
        )
        .unwrap();
        assert_eq!(selection, None);
    }

    #[test]
    fn redemption_refuses_stale_or_mismatched_contract_state() {
        assert!(validate_redeemable_polymarket_contracts(5_000_000, 0).is_err());
        assert!(validate_redeemable_polymarket_contracts(5_000_000, 4_000_000).is_err());
        assert_eq!(
            validate_redeemable_polymarket_contracts(5_000_000, 5_005_000)
                .expect("one contract-step tolerance"),
            5_005_000
        );
    }
}
