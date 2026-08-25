//! Cross-venue live-entry and recovery state machine.
//!
//! Submission is persisted before either venue is called. Results are then
//! classified from authoritative fills/balances into the four possible states:
//! neither leg, both legs, Polymarket only, or Jupiter only. Unequal quantities
//! are retained when both intended single-winner P&Ls meet the configured
//! floor. Otherwise bounded repair uses Polymarket because submitting a second
//! Jupiter request could double-fill an ambiguous first request.

#![allow(clippy::missing_errors_doc)]
#![allow(clippy::too_many_arguments, clippy::too_many_lines)]

use std::cmp::{max, min};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use jupol_domain::Micro;
use jupol_domain::fixed::ONE_USD_MICRO;
use jupol_domain::short_window::polymarket_crypto_taker_fee_per_contract_micro_usd;
use jupol_jupiter::{
    JupiterError, JupiterHybridExecutor, PreparedJupiterSubmission, SubmittedJupiterOrder,
    forecast_swap_position_id,
};
use jupol_polymarket::{
    PolymarketError, PolymarketExecutor, PolymarketFill, PreparedFokOrder,
    normalize_fok_contracts_for_price,
};
use jupol_state::{
    LivePairIdentity, LivePosition, LivePositionPhase, LiveTraderState, PostFillAction,
    PostFillRiskPlan, ResolutionScenario, ResolutionScenarioCode, StateError, load_live_state,
    save_live_state,
};

#[derive(Debug)]
pub enum LiveError {
    State(StateError),
    Jupiter(JupiterError),
    Polymarket(PolymarketError),
    InvalidRequest(String),
    Recovery(String),
}

impl fmt::Display for LiveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::State(error) => error.fmt(formatter),
            Self::Jupiter(error) => error.fmt(formatter),
            Self::Polymarket(error) => error.fmt(formatter),
            Self::InvalidRequest(message) => write!(formatter, "Invalid live request: {message}"),
            Self::Recovery(message) => write!(formatter, "Automatic recovery: {message}"),
        }
    }
}

impl std::error::Error for LiveError {}

impl From<StateError> for LiveError {
    fn from(error: StateError) -> Self {
        Self::State(error)
    }
}

impl From<JupiterError> for LiveError {
    fn from(error: JupiterError) -> Self {
        Self::Jupiter(error)
    }
}

impl From<PolymarketError> for LiveError {
    fn from(error: PolymarketError) -> Self {
        Self::Polymarket(error)
    }
}

pub struct LiveEntryRequest {
    pub position_id: String,
    pub pair: LivePairIdentity,
    pub jupiter: PreparedJupiterSubmission,
    pub polymarket: PreparedFokOrder,
    pub polymarket_token_id: String,
    pub jupiter_outcome_mint: Option<String>,
    pub before: EntryBalanceSnapshot,
    pub maximum_repair_loss_micro_usd: Micro,
    pub maximum_repair_slippage_bps: u32,
    pub minimum_post_fill_profit_micro_usd: Micro,
    pub fill_timeout: Duration,
    pub diagnostic_test_entry: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EntryDisposition {
    Opened { position_id: String, repaired: bool },
    ZeroExposure { position_id: String },
    RecoveryPending { position_id: String, reason: String },
}

pub struct LiveCoordinator {
    state_path: PathBuf,
    state: LiveTraderState,
    _lock_file: File,
}

impl LiveCoordinator {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, LiveError> {
        let state_path = path.into();
        if let Some(parent) = state_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                LiveError::Recovery(format!("could not create state directory: {error}"))
            })?;
        }
        let lock_path = state_lock_path(&state_path);
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let lock_file = options.open(&lock_path).map_err(|error| {
            LiveError::Recovery(format!(
                "could not open state lock {}: {error}",
                lock_path.display()
            ))
        })?;
        lock_file.try_lock().map_err(|error| {
            LiveError::Recovery(format!(
                "state {} is already managed by another live/recovery process: {error}",
                state_path.display()
            ))
        })?;
        let mut state = load_live_state(&state_path)?;
        if migrate_live_state(&mut state) {
            state.sequence = state.sequence.saturating_add(1);
            save_live_state(&state_path, &state)?;
        }
        Ok(Self {
            state_path,
            state,
            _lock_file: lock_file,
        })
    }

    #[must_use]
    pub const fn state(&self) -> &LiveTraderState {
        &self.state
    }

    /// Returns the reason new entries are quarantined while an existing
    /// position needs reconciliation. This is intentionally separate from the
    /// operator-controlled global halt flag: settlement/recovery can continue.
    #[must_use]
    pub fn entry_blocker(&self) -> Option<String> {
        portfolio_entry_blocker(&self.state)
    }

    #[must_use]
    pub fn state_path(&self) -> &Path {
        &self.state_path
    }

    pub async fn execute_entry(
        &mut self,
        request: LiveEntryRequest,
        jupiter: &JupiterHybridExecutor,
        polymarket: &PolymarketExecutor,
    ) -> Result<EntryDisposition, LiveError> {
        validate_entry_request(&request)?;
        if self.state.halted {
            return Err(LiveError::InvalidRequest(format!(
                "trading is halted: {}",
                self.state
                    .halt_reason
                    .as_deref()
                    .unwrap_or("no reason recorded")
            )));
        }
        if let Some(reason) = self.entry_blocker() {
            return Err(LiveError::InvalidRequest(format!(
                "new entries are quarantined: {reason}"
            )));
        }
        if self.state.positions.iter().any(|position| {
            position.id == request.position_id || position.pair.key == request.pair.key
        }) {
            return Err(LiveError::InvalidRequest(
                "position or pair already exists in durable state".to_owned(),
            ));
        }

        let jupiter_build = request.jupiter.build.clone();
        let before = request.before;

        let placeholder = placeholder_position(&request, &jupiter_build);
        self.state.positions.push(placeholder);
        self.bump_and_save()?;

        let (polymarket_result, jupiter_result) = tokio::join!(
            polymarket.submit_fok(request.polymarket),
            jupiter.submit_prepared_and_wait(request.jupiter, request.fill_timeout),
        );
        self.record_entry_submission_results(
            &request.position_id,
            &polymarket_result_label(&polymarket_result),
            &jupiter_result_label(&jupiter_result),
        )?;

        let observation = capture_entry_balances_with_retry(
            polymarket,
            jupiter,
            &request.polymarket_token_id,
            request.jupiter_outcome_mint.as_deref(),
            jupiter_build.order.position_pubkey.as_str(),
            false,
            3,
        )
        .await;
        let after = match observation {
            Ok(values) => values,
            Err(error) => {
                let reason = format!(
                    "venue submissions returned Poly={} Jup={}, but post-submit balances could not be observed: {error}",
                    result_label(&polymarket_result),
                    result_label(&jupiter_result),
                );
                self.mark_recovery_pending(&request.position_id, &reason)?;
                return Ok(EntryDisposition::RecoveryPending {
                    position_id: request.position_id,
                    reason,
                });
            }
        };

        let reported_polymarket = polymarket_result
            .as_ref()
            .map_or(0, |fill| fill.filled_contracts_micro);
        let reported_jupiter = jupiter_result
            .as_ref()
            .map_or(0, |fill| fill.status.filled_contracts_micro);
        let observed_polymarket =
            positive_delta(before.polymarket_contracts, after.polymarket_contracts);
        let observed_jupiter = positive_delta(before.jupiter_contracts, after.jupiter_contracts);
        let swap_v2_execution = jupiter_build.execution_endpoint == "/swap/v2/execute";
        let polymarket_contracts = authoritative_quantity(
            observed_polymarket,
            reported_polymarket,
            polymarket_result.is_ok(),
            false,
        );
        let jupiter_contracts = authoritative_quantity(
            observed_jupiter,
            reported_jupiter,
            jupiter_result.is_ok(),
            swap_v2_execution,
        );

        if polymarket_contracts == 0 && jupiter_contracts == 0 {
            if submission_is_ambiguous(&polymarket_result, &jupiter_result) {
                let reason = combined_error_reason(&polymarket_result, &jupiter_result);
                self.mark_zero_observation_pending(&request.position_id, &reason)?;
                return Ok(EntryDisposition::RecoveryPending {
                    position_id: request.position_id,
                    reason,
                });
            }
            self.state
                .positions
                .retain(|position| position.id != request.position_id);
            self.state.completed_pairs.push(request.pair.key);
            self.bump_and_save()?;
            return Ok(EntryDisposition::ZeroExposure {
                position_id: request.position_id,
            });
        }

        let mut final_polymarket = polymarket_contracts;
        let final_jupiter = jupiter_contracts;
        let observed_polymarket_cost = positive_delta(
            after.polymarket_collateral_micro_usd,
            before.polymarket_collateral_micro_usd,
        );
        let mut polymarket_cost = if observed_polymarket_cost > 0 {
            observed_polymarket_cost
        } else {
            polymarket_result
                .as_ref()
                .map_or(0, |fill| fill.gross_micro_usd)
        };
        let observed_jupiter_cost =
            positive_delta(after.jupiter_usdc_micro, before.jupiter_usdc_micro);
        let reported_jupiter_cost = jupiter_result
            .as_ref()
            .map_or(0, |fill| fill.status.size_micro_usd);
        let jupiter_cost = if swap_v2_execution && jupiter_result.is_ok() {
            reported_jupiter_cost
        } else if observed_jupiter_cost > 0 {
            observed_jupiter_cost
        } else {
            reported_jupiter_cost
        };
        if final_polymarket > 0 && polymarket_cost <= 0 {
            let reason = format!(
                "observed {final_polymarket} Polymarket contracts but could not reconcile the collateral debit"
            );
            self.finalize_observed_position(
                &request.position_id,
                final_polymarket,
                final_jupiter,
                0,
                jupiter_cost,
                polymarket_result.as_ref().ok(),
                jupiter_result.as_ref().ok(),
                LivePositionPhase::RecoveryPlanning,
                Some(reason.clone()),
            )?;
            return Ok(EntryDisposition::RecoveryPending {
                position_id: request.position_id,
                reason,
            });
        }
        if final_jupiter > 0 && jupiter_cost <= 0 {
            let reason = format!(
                "observed {final_jupiter} Jupiter contracts but could not reconcile the USDC debit"
            );
            self.finalize_observed_position(
                &request.position_id,
                final_polymarket,
                final_jupiter,
                polymarket_cost,
                0,
                polymarket_result.as_ref().ok(),
                jupiter_result.as_ref().ok(),
                LivePositionPhase::RecoveryPlanning,
                Some(reason.clone()),
            )?;
            return Ok(EntryDisposition::RecoveryPending {
                position_id: request.position_id,
                reason,
            });
        }
        if final_polymarket != final_jupiter
            && submission_is_ambiguous(&polymarket_result, &jupiter_result)
        {
            let reason = format!(
                "observed Poly={final_polymarket} Jup={final_jupiter}, but a venue submission remains ambiguous; repair is deferred to avoid racing a latent fill"
            );
            self.finalize_observed_position(
                &request.position_id,
                final_polymarket,
                final_jupiter,
                polymarket_cost,
                jupiter_cost,
                polymarket_result.as_ref().ok(),
                jupiter_result.as_ref().ok(),
                LivePositionPhase::RecoveryPlanning,
                Some(reason.clone()),
            )?;
            return Ok(EntryDisposition::RecoveryPending {
                position_id: request.position_id,
                reason,
            });
        }

        // A quantity difference is not itself exposure that needs repair. The
        // held outcomes are complementary for the intended strategy, so keep
        // any extra contracts whenever either single-winner payout covers the
        // complete actual cost plus the configured post-fill floor.
        let initial_total_cost = polymarket_cost
            .checked_add(jupiter_cost)
            .ok_or_else(|| LiveError::Recovery("post-fill cost overflow".to_owned()))?;
        let initial_risk_plan = build_risk_plan_with_minimum(
            final_polymarket,
            final_jupiter,
            initial_total_cost,
            request.minimum_post_fill_profit_micro_usd,
        );
        if post_fill_is_acceptable(
            &initial_risk_plan,
            request.minimum_post_fill_profit_micro_usd,
        ) {
            self.finalize_observed_position(
                &request.position_id,
                final_polymarket,
                final_jupiter,
                polymarket_cost,
                jupiter_cost,
                polymarket_result.as_ref().ok(),
                jupiter_result.as_ref().ok(),
                LivePositionPhase::Open,
                None,
            )?;
            return Ok(EntryDisposition::Opened {
                position_id: request.position_id,
                repaired: false,
            });
        }

        let mut repaired = false;
        let target = final_jupiter;
        if final_polymarket != target {
            match repair_polymarket_to_target(
                polymarket,
                &request.polymarket_token_id,
                final_polymarket,
                target,
                polymarket_cost,
                jupiter_cost,
                request.maximum_repair_loss_micro_usd,
                request.maximum_repair_slippage_bps,
            )
            .await
            {
                Ok(repair) => {
                    repaired = true;
                    let modeled_contracts = repair.final_contracts_micro;
                    let modeled_cost = polymarket_cost
                        .checked_add(repair.additional_cost_micro_usd)
                        .and_then(|value| value.checked_sub(repair.proceeds_micro_usd))
                        .ok_or_else(|| {
                            LiveError::Recovery("repair accounting overflow".to_owned())
                        })?;
                    match capture_polymarket_state_with_retry(
                        polymarket,
                        &request.polymarket_token_id,
                        3,
                    )
                    .await
                    {
                        Ok((owned_contracts, collateral)) => {
                            final_polymarket =
                                positive_delta(before.polymarket_contracts, owned_contracts);
                            polymarket_cost =
                                positive_delta(collateral, before.polymarket_collateral_micro_usd);
                        }
                        Err(error) => {
                            let reason = format!(
                                "repair reported Poly={modeled_contracts}, but authoritative post-repair balances could not be captured: {error}"
                            );
                            self.finalize_observed_position(
                                &request.position_id,
                                modeled_contracts,
                                final_jupiter,
                                modeled_cost,
                                jupiter_cost,
                                polymarket_result.as_ref().ok(),
                                jupiter_result.as_ref().ok(),
                                LivePositionPhase::RecoveryPlanning,
                                Some(reason.clone()),
                            )?;
                            return Ok(EntryDisposition::RecoveryPending {
                                position_id: request.position_id,
                                reason,
                            });
                        }
                    }
                }
                Err(error) => {
                    let recaptured = capture_polymarket_state_with_retry(
                        polymarket,
                        &request.polymarket_token_id,
                        3,
                    )
                    .await;
                    let recapture_note = match recaptured {
                        Ok((owned_contracts, collateral)) => {
                            final_polymarket =
                                positive_delta(before.polymarket_contracts, owned_contracts);
                            polymarket_cost =
                                positive_delta(collateral, before.polymarket_collateral_micro_usd);
                            format!(
                                "authoritative post-repair Poly={final_polymarket} collateralDebit={polymarket_cost}"
                            )
                        }
                        Err(ref recapture_error) => {
                            format!("post-repair recapture also failed: {recapture_error}")
                        }
                    };
                    let reason = format!(
                        "observed Poly={final_polymarket} Jup={final_jupiter}; submissions Poly={} Jup={}; repair failed: {error}; {recapture_note}",
                        result_label(&polymarket_result),
                        result_label(&jupiter_result),
                    );
                    self.finalize_observed_position(
                        &request.position_id,
                        final_polymarket,
                        final_jupiter,
                        polymarket_cost,
                        jupiter_cost,
                        polymarket_result.as_ref().ok(),
                        jupiter_result.as_ref().ok(),
                        LivePositionPhase::RecoveryPlanning,
                        Some(reason.clone()),
                    )?;
                    return Ok(EntryDisposition::RecoveryPending {
                        position_id: request.position_id,
                        reason,
                    });
                }
            }
        }

        let total_cost = polymarket_cost
            .checked_add(jupiter_cost)
            .ok_or_else(|| LiveError::Recovery("post-fill cost overflow".to_owned()))?;
        let risk_plan = build_risk_plan_with_minimum(
            final_polymarket,
            final_jupiter,
            total_cost,
            request.minimum_post_fill_profit_micro_usd,
        );
        let acceptable =
            post_fill_is_acceptable(&risk_plan, request.minimum_post_fill_profit_micro_usd);
        let phase = if acceptable {
            LivePositionPhase::Open
        } else {
            LivePositionPhase::RecoveryPlanning
        };
        let reason = (!acceptable).then(|| {
            format!(
                "post-fill safety gate rejected entry: Poly={final_polymarket} Jup={final_jupiter} mismatch={} floor={} requiredFloor={} action={:?}",
                risk_plan.venue_size_mismatch_micro,
                risk_plan.intended_single_winner_floor_micro_usd,
                request.minimum_post_fill_profit_micro_usd,
                risk_plan.action,
            )
        });
        self.finalize_observed_position(
            &request.position_id,
            final_polymarket,
            final_jupiter,
            polymarket_cost,
            jupiter_cost,
            polymarket_result.as_ref().ok(),
            jupiter_result.as_ref().ok(),
            phase.clone(),
            reason.clone(),
        )?;
        if phase == LivePositionPhase::Open {
            Ok(EntryDisposition::Opened {
                position_id: request.position_id,
                repaired,
            })
        } else {
            Ok(EntryDisposition::RecoveryPending {
                position_id: request.position_id,
                reason: reason.unwrap_or_else(|| "complementary exposure not restored".to_owned()),
            })
        }
    }

    pub async fn recover_incomplete_positions(
        &mut self,
        jupiter: &JupiterHybridExecutor,
        polymarket: &PolymarketExecutor,
    ) -> Result<Vec<EntryDisposition>, LiveError> {
        self.recover_incomplete_positions_with_limits(jupiter, polymarket, ONE_USD_MICRO, 100)
            .await
    }

    pub async fn recover_incomplete_positions_with_limits(
        &mut self,
        jupiter: &JupiterHybridExecutor,
        polymarket: &PolymarketExecutor,
        maximum_repair_loss_micro_usd: Micro,
        maximum_repair_slippage_bps: u32,
    ) -> Result<Vec<EntryDisposition>, LiveError> {
        let ids = self
            .state
            .positions
            .iter()
            .filter(|position| {
                matches!(
                    position.phase,
                    LivePositionPhase::JupiterPrepared
                        | LivePositionPhase::JupiterPending
                        | LivePositionPhase::PolymarketHedging
                        | LivePositionPhase::LegsSubmitting
                        | LivePositionPhase::RecoveryPlanning
                        | LivePositionPhase::ExposureError
                )
            })
            .map(|position| position.id.clone())
            .collect::<Vec<_>>();
        let mut dispositions = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(position) = self
                .state
                .positions
                .iter()
                .find(|position| position.id == id)
                .cloned()
            else {
                continue;
            };
            if position.pair.end_ms <= unix_timestamp_ms() && has_recorded_exposure(&position) {
                let reason = "pair has ended with durable recorded exposure; repair and zero-exposure deletion are disabled while settlement is reconciled";
                let current = self
                    .state
                    .positions
                    .iter_mut()
                    .find(|candidate| candidate.id == id)
                    .ok_or_else(|| {
                        LiveError::Recovery(format!("position {id} disappeared during recovery"))
                    })?;
                current.phase = LivePositionPhase::AwaitingResolution;
                self.bump_and_save()?;
                dispositions.push(EntryDisposition::RecoveryPending {
                    position_id: id,
                    reason: reason.to_owned(),
                });
                continue;
            }
            if let Some(order_pubkey) = position.jupiter_order_pubkey.as_deref() {
                match jupiter.get_order_status(order_pubkey).await {
                    Ok(status) if status.status == "pending" => {
                        let reason = format!(
                            "Jupiter keeper order {order_pubkey} is still pending; no repair may race a latent fill"
                        );
                        self.mark_recovery_pending(&id, &reason)?;
                        dispositions.push(EntryDisposition::RecoveryPending {
                            position_id: id,
                            reason,
                        });
                        continue;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let reason = format!(
                            "could not prove Jupiter keeper order {order_pubkey} terminal before recovery: {error}"
                        );
                        self.mark_recovery_pending(&id, &reason)?;
                        dispositions.push(EntryDisposition::RecoveryPending {
                            position_id: id,
                            reason,
                        });
                        continue;
                    }
                }
            }
            let poly = polymarket
                .refresh_conditional_balance_micro(&position.pair.polymarket_token_id)
                .await;
            let jup = jupiter
                .get_position(&position.jupiter_position_pubkey)
                .await;
            let jup = match jup {
                Ok(value) => Ok(value.contracts_micro),
                Err(JupiterError::Http(error))
                    if error.status().is_some_and(|status| status.as_u16() == 404) =>
                {
                    Ok(0)
                }
                Err(error) => Err(error),
            };
            match (poly, jup) {
                (Ok(poly), Ok(jup))
                    if poly == 0
                        && jup == 0
                        && !has_recorded_exposure(&position)
                        && zero_observation_is_mature(
                            position.entry_zero_exposure_proof.as_deref(),
                            unix_timestamp_ms(),
                            if position.jupiter_position_pubkey.starts_with("swap-v2:")
                                && position.entry_zero_exposure_proof.as_deref().is_some_and(
                                    |proof| proof.starts_with("first_zero_observation_ms:"),
                                )
                            {
                                90_000
                            } else {
                                2_000
                            },
                        ) =>
                {
                    self.state.positions.retain(|candidate| candidate.id != id);
                    self.state.completed_pairs.push(position.pair.key);
                    self.bump_and_save()?;
                    dispositions.push(EntryDisposition::ZeroExposure { position_id: id });
                }
                (Ok(0), Ok(0)) => {
                    let reason = if has_recorded_exposure(&position) {
                        "current zero balances conflict with durable fill/cost evidence; preserve the position and reconcile settlement, unwind transactions, and cash"
                    } else {
                        "first repeated zero-balance observation recorded; a later pass must confirm it"
                    };
                    if has_recorded_exposure(&position) {
                        self.mark_recovery_pending(&id, reason)?;
                    } else {
                        self.mark_zero_observation_pending(&id, reason)?;
                    }
                    dispositions.push(EntryDisposition::RecoveryPending {
                        position_id: id,
                        reason: reason.to_owned(),
                    });
                }
                (Ok(poly), Ok(jup))
                    if position.jupiter_position_pubkey.starts_with("swap-v2:")
                        && position
                            .last_error
                            .as_deref()
                            .is_some_and(|reason| reason.contains("ambiguous"))
                        && unix_timestamp_ms().saturating_sub(position.entered_at_ms) < 90_000 =>
                {
                    let reason = format!(
                        "ambiguous Swap V2 submission remains inside its 90-second latent-fill window; observed Poly={poly} Jup={jup} and deferred repair"
                    );
                    self.mark_recovery_pending(&id, &reason)?;
                    dispositions.push(EntryDisposition::RecoveryPending {
                        position_id: id,
                        reason,
                    });
                }
                (Ok(poly), Ok(jup))
                    if (poly > 0 && position.polymarket_entry_cost_micro_usd <= 0)
                        || (jup > 0 && position.jupiter_entry_cost_micro_usd <= 0) =>
                {
                    let reason = format!(
                        "startup observed Poly={poly} Jup={jup}, but one or more actual cash debits are unknown; automatic repair is unsafe"
                    );
                    self.mark_recovery_pending(&id, &reason)?;
                    dispositions.push(EntryDisposition::RecoveryPending {
                        position_id: id,
                        reason,
                    });
                }
                (Ok(poly), Ok(jup))
                    if poly > 0
                        && jup > 0
                        && post_fill_is_acceptable(
                            &build_risk_plan_with_minimum(
                                poly,
                                jup,
                                position
                                    .polymarket_entry_cost_micro_usd
                                    .saturating_add(position.jupiter_entry_cost_micro_usd),
                                position.minimum_post_fill_profit_micro_usd,
                            ),
                            position.minimum_post_fill_profit_micro_usd,
                        ) =>
                {
                    self.finalize_observed_position(
                        &id,
                        poly,
                        jup,
                        position.polymarket_entry_cost_micro_usd,
                        position.jupiter_entry_cost_micro_usd,
                        None,
                        None,
                        LivePositionPhase::Open,
                        None,
                    )?;
                    dispositions.push(EntryDisposition::Opened {
                        position_id: id,
                        repaired: false,
                    });
                }
                (Ok(poly), Ok(jup)) if poly == jup && poly > 0 => {
                    let plan = build_risk_plan_with_minimum(
                        poly,
                        jup,
                        position
                            .polymarket_entry_cost_micro_usd
                            .saturating_add(position.jupiter_entry_cost_micro_usd),
                        position.minimum_post_fill_profit_micro_usd,
                    );
                    let acceptable =
                        post_fill_is_acceptable(&plan, position.minimum_post_fill_profit_micro_usd);
                    self.finalize_observed_position(
                        &id,
                        poly,
                        jup,
                        position.polymarket_entry_cost_micro_usd,
                        position.jupiter_entry_cost_micro_usd,
                        None,
                        None,
                        if acceptable {
                            LivePositionPhase::Open
                        } else {
                            LivePositionPhase::RecoveryPlanning
                        },
                        (!acceptable).then(|| {
                            format!(
                                "startup safety gate rejected matched quantities: floor={} mismatch={}",
                                plan.intended_single_winner_floor_micro_usd,
                                plan.venue_size_mismatch_micro
                            )
                        }),
                    )?;
                    dispositions.push(if acceptable {
                        EntryDisposition::Opened {
                            position_id: id,
                            repaired: false,
                        }
                    } else {
                        EntryDisposition::RecoveryPending {
                            position_id: id,
                            reason: "matched quantities have a negative single-winner floor"
                                .to_owned(),
                        }
                    });
                }
                (Ok(poly), Ok(jup)) if poly != jup => {
                    match repair_polymarket_to_target(
                        polymarket,
                        &position.pair.polymarket_token_id,
                        poly,
                        jup,
                        position.polymarket_entry_cost_micro_usd,
                        position.jupiter_entry_cost_micro_usd,
                        maximum_repair_loss_micro_usd,
                        maximum_repair_slippage_bps,
                    )
                    .await
                    {
                        Ok(repair) => {
                            let recaptured_poly = polymarket
                                .refresh_conditional_balance_micro(
                                    &position.pair.polymarket_token_id,
                                )
                                .await
                                .unwrap_or(repair.final_contracts_micro);
                            let repaired_cost = position
                                .polymarket_entry_cost_micro_usd
                                .saturating_add(repair.additional_cost_micro_usd)
                                .saturating_sub(repair.proceeds_micro_usd);
                            let plan = build_risk_plan_with_minimum(
                                recaptured_poly,
                                jup,
                                repaired_cost.saturating_add(position.jupiter_entry_cost_micro_usd),
                                position.minimum_post_fill_profit_micro_usd,
                            );
                            let acceptable = post_fill_is_acceptable(
                                &plan,
                                position.minimum_post_fill_profit_micro_usd,
                            );
                            let reason = (!acceptable).then(|| {
                                format!(
                                    "startup post-repair safety gate rejected position: Poly={recaptured_poly} Jup={jup} floor={} mismatch={}",
                                    plan.intended_single_winner_floor_micro_usd,
                                    plan.venue_size_mismatch_micro,
                                )
                            });
                            self.finalize_observed_position(
                                &id,
                                recaptured_poly,
                                jup,
                                repaired_cost,
                                position.jupiter_entry_cost_micro_usd,
                                None,
                                None,
                                if acceptable {
                                    LivePositionPhase::Open
                                } else {
                                    LivePositionPhase::RecoveryPlanning
                                },
                                reason.clone(),
                            )?;
                            dispositions.push(if acceptable {
                                EntryDisposition::Opened {
                                    position_id: id,
                                    repaired: true,
                                }
                            } else {
                                EntryDisposition::RecoveryPending {
                                    position_id: id,
                                    reason: reason.unwrap_or_else(|| {
                                        "startup repair did not produce a safe arb".to_owned()
                                    }),
                                }
                            });
                        }
                        Err(error) => {
                            let recaptured_poly = polymarket
                                .refresh_conditional_balance_micro(
                                    &position.pair.polymarket_token_id,
                                )
                                .await
                                .unwrap_or(poly);
                            let reason = format!(
                                "startup observed Poly={poly} Jup={jup}; bounded repair failed: {error}; authoritative post-repair Poly={recaptured_poly}"
                            );
                            self.finalize_observed_position(
                                &id,
                                recaptured_poly,
                                jup,
                                position.polymarket_entry_cost_micro_usd,
                                position.jupiter_entry_cost_micro_usd,
                                None,
                                None,
                                LivePositionPhase::RecoveryPlanning,
                                Some(reason.clone()),
                            )?;
                            dispositions.push(EntryDisposition::RecoveryPending {
                                position_id: id,
                                reason,
                            });
                        }
                    }
                }
                (poly, jup) => {
                    let reason = format!(
                        "startup reconciliation unresolved: Poly={}; Jup={}",
                        result_value(poly),
                        result_value(jup),
                    );
                    self.mark_recovery_pending(&id, &reason)?;
                    dispositions.push(EntryDisposition::RecoveryPending {
                        position_id: id,
                        reason,
                    });
                }
            }
        }
        Ok(dispositions)
    }

    pub fn mark_expired_positions_awaiting_resolution(
        &mut self,
        now_ms: i64,
    ) -> Result<usize, LiveError> {
        let mut changed = 0_usize;
        for position in &mut self.state.positions {
            if position.pair.end_ms <= now_ms
                && (matches!(position.phase, LivePositionPhase::Open)
                    || has_recorded_exposure(position))
                && !matches!(position.phase, LivePositionPhase::AwaitingResolution)
            {
                position.phase = LivePositionPhase::AwaitingResolution;
                changed = changed.saturating_add(1);
            }
        }
        if changed > 0 {
            self.bump_and_save()?;
        }
        Ok(changed)
    }

    pub fn update_cash_snapshots(
        &mut self,
        polymarket_micro_usd: Micro,
        jupiter_micro_usd: Micro,
    ) -> Result<(), LiveError> {
        let polymarket_micro_usd = polymarket_micro_usd.max(0);
        let jupiter_micro_usd = jupiter_micro_usd.max(0);
        if self.state.polymarket_cash_micro_usd == Some(polymarket_micro_usd)
            && self.state.jupiter_cash_micro_usd == Some(jupiter_micro_usd)
        {
            return Ok(());
        }
        self.state.polymarket_cash_micro_usd = Some(polymarket_micro_usd);
        self.state.jupiter_cash_micro_usd = Some(jupiter_micro_usd);
        self.bump_and_save()
    }

    pub fn record_polymarket_settlement(
        &mut self,
        pair_key: &str,
        won: bool,
        transaction_hash: Option<String>,
        payout_micro_usd: Micro,
    ) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.pair.key == pair_key)
            .ok_or_else(|| LiveError::InvalidRequest(format!("pair {pair_key} disappeared")))?;
        if position.polymarket_settled {
            return Ok(());
        }
        if won && payout_micro_usd <= 0 {
            return Err(LiveError::Recovery(
                "winning Polymarket settlement has no positive verified payout".to_owned(),
            ));
        }
        position.polymarket_settled = true;
        position.polymarket_settlement_payout_micro_usd = if won { payout_micro_usd } else { 0 };
        position.polymarket_settlement_transaction_signature = transaction_hash;
        position.polymarket_redemption_collateral_before_micro_usd = None;
        position.settlement_error = None;
        self.bump_and_save()
    }

    pub fn record_polymarket_redemption_submission(
        &mut self,
        pair_key: &str,
        transaction_hash: String,
        collateral_before_micro_usd: Micro,
    ) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.pair.key == pair_key)
            .ok_or_else(|| LiveError::InvalidRequest(format!("pair {pair_key} disappeared")))?;
        if position.polymarket_settled {
            return Ok(());
        }
        position.polymarket_settlement_transaction_signature = Some(transaction_hash);
        position.polymarket_redemption_collateral_before_micro_usd =
            Some(collateral_before_micro_usd.max(0));
        position.settlement_error = None;
        self.bump_and_save()
    }

    pub fn invalidate_polymarket_redemption_submission(
        &mut self,
        pair_key: &str,
        reason: &str,
    ) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.pair.key == pair_key)
            .ok_or_else(|| LiveError::InvalidRequest(format!("pair {pair_key} disappeared")))?;
        if position.polymarket_settled {
            return Ok(());
        }
        position.polymarket_settlement_transaction_signature = None;
        position.polymarket_redemption_collateral_before_micro_usd = None;
        position.settlement_error = Some(reason.to_owned());
        self.bump_and_save()
    }

    pub fn record_jupiter_settlement(
        &mut self,
        pair_key: &str,
        won: bool,
        transaction_signature: Option<String>,
        payout_micro_usd: Micro,
    ) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.pair.key == pair_key)
            .ok_or_else(|| LiveError::InvalidRequest(format!("pair {pair_key} disappeared")))?;
        if position.jupiter_settled {
            return Ok(());
        }
        if won && payout_micro_usd <= 0 {
            return Err(LiveError::Recovery(
                "winning Jupiter settlement has no positive verified payout".to_owned(),
            ));
        }
        position.jupiter_settled = true;
        position.jupiter_settlement_payout_micro_usd = if won { payout_micro_usd } else { 0 };
        position.jupiter_settlement_transaction_signature = transaction_signature;
        position.settlement_error = None;
        self.bump_and_save()
    }

    pub fn record_jupiter_rent_reclaim(
        &mut self,
        pair_key: &str,
        signatures: Vec<String>,
        reclaimed_lamports: u64,
    ) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.pair.key == pair_key)
            .ok_or_else(|| LiveError::InvalidRequest(format!("pair {pair_key} disappeared")))?;
        position.jupiter_rent_reclaimed = true;
        position.jupiter_rent_reclaim_transaction_signatures = signatures;
        position.jupiter_rent_reclaimed_lamports = Micro::from(reclaimed_lamports);
        position.settlement_error = None;
        self.bump_and_save()
    }

    pub fn finalize_fully_settled_positions(&mut self) -> Result<usize, LiveError> {
        let completed = self
            .state
            .positions
            .iter()
            .filter(|position| {
                position.polymarket_settled
                    && position.jupiter_settled
                    && position.jupiter_rent_reclaimed
            })
            .map(|position| position.id.clone())
            .collect::<Vec<_>>();
        if completed.is_empty() {
            return Ok(0);
        }
        for id in &completed {
            let position = self
                .state
                .positions
                .iter()
                .find(|position| &position.id == id)
                .cloned()
                .ok_or_else(|| LiveError::Recovery("settled position disappeared".to_owned()))?;
            let realized = position
                .polymarket_settlement_payout_micro_usd
                .checked_add(position.jupiter_settlement_payout_micro_usd)
                .and_then(|payout| payout.checked_sub(position.remaining_entry_cost_micro_usd))
                .ok_or_else(|| LiveError::Recovery("settlement accounting overflow".to_owned()))?;
            self.state.realized_profit_micro_usd = self
                .state
                .realized_profit_micro_usd
                .checked_add(realized)
                .ok_or_else(|| LiveError::Recovery("realized P&L overflow".to_owned()))?;
            if !self.state.completed_pairs.contains(&position.pair.key) {
                self.state.completed_pairs.push(position.pair.key.clone());
            }
            let mut archived = position;
            archived.realized_profit_micro_usd = realized;
            if !self
                .state
                .settled_positions
                .iter()
                .any(|candidate| candidate.id == archived.id)
            {
                self.state.settled_positions.push(archived);
            }
        }
        self.state
            .positions
            .retain(|position| !completed.contains(&position.id));
        self.bump_and_save()?;
        Ok(completed.len())
    }

    pub fn record_settlement_error(
        &mut self,
        pair_key: &str,
        reason: &str,
    ) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.pair.key == pair_key)
            .ok_or_else(|| LiveError::InvalidRequest(format!("pair {pair_key} disappeared")))?;
        if position.settlement_error.as_deref() == Some(reason) {
            return Ok(());
        }
        position.settlement_error = Some(reason.to_owned());
        self.bump_and_save()
    }

    fn finalize_observed_position(
        &mut self,
        id: &str,
        polymarket_contracts_micro: Micro,
        jupiter_contracts_micro: Micro,
        polymarket_cost_micro_usd: Micro,
        jupiter_cost_micro_usd: Micro,
        polymarket_fill: Option<&PolymarketFill>,
        jupiter_fill: Option<&SubmittedJupiterOrder>,
        phase: LivePositionPhase,
        error: Option<String>,
    ) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.id == id)
            .ok_or_else(|| LiveError::InvalidRequest(format!("position {id} disappeared")))?;
        position.phase = phase;
        position.polymarket_contracts_micro = polymarket_contracts_micro;
        position.jupiter_contracts_micro = jupiter_contracts_micro;
        position.polymarket_entry_cost_micro_usd = polymarket_cost_micro_usd;
        position.jupiter_entry_cost_micro_usd = jupiter_cost_micro_usd;
        position.remaining_entry_cost_micro_usd = polymarket_cost_micro_usd
            .checked_add(jupiter_cost_micro_usd)
            .ok_or_else(|| LiveError::Recovery("entry accounting overflow".to_owned()))?;
        position.original_contracts_micro =
            min(polymarket_contracts_micro, jupiter_contracts_micro);
        position.jupiter_order_pubkey = jupiter_fill
            .and_then(|fill| fill.status.order_pubkey.clone())
            .or_else(|| position.jupiter_order_pubkey.clone());
        position.jupiter_execution_reconciliation_source = jupiter_fill
            .map(|fill| {
                if fill.status.order_pubkey.is_none() {
                    "swap_v2_execute_totals".to_owned()
                } else {
                    "venue_status_and_balance_deltas".to_owned()
                }
            })
            .or_else(|| position.jupiter_execution_reconciliation_source.clone());
        position.last_error = error;
        position.post_fill_risk_plan = Some(build_risk_plan_with_minimum(
            polymarket_contracts_micro,
            jupiter_contracts_micro,
            position.remaining_entry_cost_micro_usd,
            position.minimum_post_fill_profit_micro_usd,
        ));
        position.entry_submission_skew_ms = polymarket_fill
            .zip(jupiter_fill)
            .map(|(poly, jup)| (poly.submitted_at_ms - jup.submission_started_at_ms).abs());
        if let Some(fill) = polymarket_fill {
            for hash in &fill.transaction_hashes {
                if !position.polymarket_entry_transaction_hashes.contains(hash) {
                    position
                        .polymarket_entry_transaction_hashes
                        .push(hash.clone());
                }
            }
        }
        if let Some(fill) = jupiter_fill {
            position.jupiter_entry_transaction_signature = Some(fill.transaction_signature.clone());
        }
        self.bump_and_save()
    }

    fn mark_recovery_pending(&mut self, id: &str, reason: &str) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.id == id)
            .ok_or_else(|| LiveError::InvalidRequest(format!("position {id} disappeared")))?;
        position.phase = LivePositionPhase::RecoveryPlanning;
        position.last_error = Some(reason.to_owned());
        self.bump_and_save()
    }

    fn record_entry_submission_results(
        &mut self,
        id: &str,
        polymarket_result: &str,
        jupiter_result: &str,
    ) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.id == id)
            .ok_or_else(|| LiveError::InvalidRequest(format!("position {id} disappeared")))?;
        position.polymarket_entry_submission_result = Some(polymarket_result.to_owned());
        position.jupiter_entry_submission_result = Some(jupiter_result.to_owned());
        self.bump_and_save()
    }

    fn mark_zero_observation_pending(&mut self, id: &str, reason: &str) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.id == id)
            .ok_or_else(|| LiveError::InvalidRequest(format!("position {id} disappeared")))?;
        position.phase = LivePositionPhase::RecoveryPlanning;
        position.last_error = Some(reason.to_owned());
        if !has_recorded_exposure(position) && position.entry_zero_exposure_proof.is_none() {
            position.entry_zero_exposure_proof =
                Some(format!("first_zero_observation_ms:{}", unix_timestamp_ms()));
        }
        self.bump_and_save()
    }

    fn bump_and_save(&mut self) -> Result<(), LiveError> {
        self.state.sequence = self.state.sequence.saturating_add(1);
        save_live_state(&self.state_path, &self.state)?;
        Ok(())
    }
}

fn migrate_live_state(state: &mut LiveTraderState) -> bool {
    let mut changed = false;
    for position in &mut state.positions {
        // Older Rust builds accidentally stored a Polymarket entry transaction
        // in the redemption field. A real pending redemption always also has
        // its pre-redemption collateral snapshot.
        if !position.polymarket_settled
            && position
                .polymarket_settlement_transaction_signature
                .is_some()
            && position
                .polymarket_redemption_collateral_before_micro_usd
                .is_none()
        {
            if let Some(hash) = position.polymarket_settlement_transaction_signature.take()
                && !position.polymarket_entry_transaction_hashes.contains(&hash)
            {
                position.polymarket_entry_transaction_hashes.push(hash);
            }
            changed = true;
        }

        // Prediction's atomic BISON execution returns a build-time position
        // identity, but custody and settlement are the owned outcome token.
        // Persist the synthetic token identity used by the hybrid executor and
        // retain the raw build identity only as entry audit metadata.
        if position.jupiter_order_pubkey.is_none()
            && position.jupiter_execution_reconciliation_source.as_deref()
                == Some("onchain_token_deltas")
            && !position.jupiter_position_pubkey.starts_with("swap-v2:")
            && let Some(outcome_mint) = position.pair.jupiter_outcome_mint.as_deref()
        {
            if position.jupiter_entry_position_pubkey.is_none() {
                position.jupiter_entry_position_pubkey =
                    Some(position.jupiter_position_pubkey.clone());
            }
            position.jupiter_position_pubkey =
                forecast_swap_position_id(&position.pair.jupiter_market_id, outcome_mint);
            position.jupiter_rent_reclaimed = false;
            changed = true;
        }

        // Migrate plans created by the exact-quantity policy. A residual is
        // now informational when both intended single-winner payouts cover the
        // complete recorded cost, so old QuoteRepair plans must not keep the
        // portfolio quarantined after an upgrade.
        if position.post_fill_risk_plan.is_some() {
            let updated = build_risk_plan_with_minimum(
                position.polymarket_contracts_micro,
                position.jupiter_contracts_micro,
                position.remaining_entry_cost_micro_usd,
                position.minimum_post_fill_profit_micro_usd,
            );
            let obsolete_quantity_repair = position
                .post_fill_risk_plan
                .as_ref()
                .is_some_and(|plan| plan.action == PostFillAction::QuoteRepair)
                && updated.action == PostFillAction::HoldOrExitNormally;
            if position.post_fill_risk_plan.as_ref() != Some(&updated) {
                position.post_fill_risk_plan = Some(updated);
                changed = true;
            }
            if obsolete_quantity_repair
                && position
                    .last_error
                    .as_deref()
                    .is_some_and(|error| error.contains("repair") || error.contains("safety gate"))
            {
                position.last_error = None;
                changed = true;
            }
        }
    }
    changed
}

fn has_recorded_exposure(position: &LivePosition) -> bool {
    position.post_fill_risk_plan.is_some()
        && (position.polymarket_contracts_micro > 0
            || position.jupiter_contracts_micro > 0
            || position.polymarket_entry_cost_micro_usd > 0
            || position.jupiter_entry_cost_micro_usd > 0)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RepairResult {
    final_contracts_micro: Micro,
    additional_cost_micro_usd: Micro,
    proceeds_micro_usd: Micro,
}

async fn repair_polymarket_to_target(
    polymarket: &PolymarketExecutor,
    token_id: &str,
    current: Micro,
    target: Micro,
    polymarket_cost: Micro,
    jupiter_cost: Micro,
    configured_maximum_loss: Micro,
    slippage_bps: u32,
) -> Result<RepairResult, LiveError> {
    let (best_bid, best_ask) = polymarket.best_bid_ask_micro_usd(token_id).await?;
    let effective_maximum_loss = max(configured_maximum_loss, polymarket_cost.max(jupiter_cost));
    if current < target {
        let requested_missing = floor_contract_step(target - current);
        if requested_missing <= 0 {
            return Ok(RepairResult {
                final_contracts_micro: current,
                additional_cost_micro_usd: 0,
                proceeds_micro_usd: 0,
            });
        }
        let ask =
            best_ask.ok_or_else(|| LiveError::Recovery("repair BUY has no ask".to_owned()))?;
        let limit = align_price_up(apply_buy_slippage(ask, slippage_bps)?);
        let missing = normalize_fok_contracts_for_price(limit, requested_missing);
        if missing <= 0 {
            return Err(LiveError::Recovery(format!(
                "repair BUY quantity {requested_missing} has no precision-valid size at limit {limit}"
            )));
        }
        let estimated_cost = multiply_price_quantity(limit, missing)?;
        let modeled_loss = polymarket_cost
            .checked_add(jupiter_cost)
            .and_then(|cost| cost.checked_add(estimated_cost))
            .and_then(|cost| min(target, current + missing).checked_sub(cost))
            .and_then(Micro::checked_neg)
            .unwrap_or(Micro::MAX)
            .max(0);
        if modeled_loss > effective_maximum_loss {
            return Err(LiveError::Recovery(format!(
                "repair BUY modeled loss {modeled_loss} exceeds bound {effective_maximum_loss}"
            )));
        }
        let prepared = polymarket.prepare_buy_fok(token_id, limit, missing).await?;
        let fill = polymarket.submit_fok(prepared).await?;
        Ok(RepairResult {
            final_contracts_micro: current + fill.filled_contracts_micro,
            additional_cost_micro_usd: fill.gross_micro_usd,
            proceeds_micro_usd: 0,
        })
    } else {
        let requested_excess = floor_contract_step(current - target);
        if requested_excess <= 0 {
            return Ok(RepairResult {
                final_contracts_micro: current,
                additional_cost_micro_usd: 0,
                proceeds_micro_usd: 0,
            });
        }
        let bid =
            best_bid.ok_or_else(|| LiveError::Recovery("repair SELL has no bid".to_owned()))?;
        let limit = align_price_down(apply_sell_slippage(bid, slippage_bps)?);
        let excess = normalize_fok_contracts_for_price(limit, requested_excess);
        if excess <= 0 {
            return Err(LiveError::Recovery(format!(
                "repair SELL quantity {requested_excess} has no precision-valid size at limit {limit}"
            )));
        }
        let gross_proceeds = multiply_price_quantity(limit, excess)?;
        let fee = polymarket_taker_fee_total(limit, excess)?;
        let net_proceeds = gross_proceeds.saturating_sub(fee);
        let remaining_contracts = current.saturating_sub(excess);
        let remaining_matched_payout = min(remaining_contracts, target);
        let modeled_loss = modeled_sell_repair_loss(
            polymarket_cost,
            jupiter_cost,
            net_proceeds,
            remaining_matched_payout,
        )?;
        if modeled_loss > effective_maximum_loss {
            return Err(LiveError::Recovery(format!(
                "repair SELL modeled loss {modeled_loss} exceeds bound {effective_maximum_loss} (net proceeds {net_proceeds}, remaining matched payout {remaining_matched_payout})"
            )));
        }
        // The loss bound must be proven before signing or submitting. Checking
        // it after the FOK would turn a rejected recovery plan into an
        // unrecorded real balance change.
        let prepared = polymarket.prepare_sell_fok(token_id, limit, excess).await?;
        let fill = polymarket.submit_fok(prepared).await?;
        Ok(RepairResult {
            final_contracts_micro: current - fill.filled_contracts_micro,
            additional_cost_micro_usd: 0,
            proceeds_micro_usd: fill.gross_micro_usd,
        })
    }
}

fn placeholder_position(
    request: &LiveEntryRequest,
    build: &jupol_jupiter::PredictionOrderBuild,
) -> LivePosition {
    let jupiter_position_pubkey = if build.execution_model.as_deref() == Some("atomic_swap") {
        build
            .outcome_mint
            .as_deref()
            .or(request.jupiter_outcome_mint.as_deref())
            .map_or_else(
                || build.order.position_pubkey.clone(),
                |mint| forecast_swap_position_id(&build.order.market_id, mint),
            )
    } else {
        build.order.position_pubkey.clone()
    };
    LivePosition {
        id: request.position_id.clone(),
        pair: request.pair.clone(),
        phase: LivePositionPhase::LegsSubmitting,
        entered_at_ms: unix_timestamp_ms(),
        jupiter_order_pubkey: build.order.order_pubkey.clone(),
        jupiter_position_pubkey,
        jupiter_entry_position_pubkey: Some(build.order.position_pubkey.clone()),
        jupiter_quoted_contracts_micro: Some(build.order.contracts_micro),
        jupiter_execution_reconciliation_source: None,
        jupiter_contracts_micro: 0,
        polymarket_contracts_micro: 0,
        jupiter_entry_cost_micro_usd: 0,
        polymarket_entry_cost_micro_usd: 0,
        remaining_entry_cost_micro_usd: 0,
        minimum_post_fill_profit_micro_usd: request.minimum_post_fill_profit_micro_usd,
        original_contracts_micro: 0,
        realized_profit_micro_usd: 0,
        polymarket_settled: false,
        jupiter_settled: false,
        polymarket_settlement_payout_micro_usd: 0,
        jupiter_settlement_payout_micro_usd: 0,
        polymarket_entry_transaction_hashes: Vec::new(),
        jupiter_entry_transaction_signature: None,
        polymarket_entry_submission_result: None,
        jupiter_entry_submission_result: None,
        polymarket_settlement_transaction_signature: None,
        polymarket_redemption_collateral_before_micro_usd: None,
        jupiter_settlement_transaction_signature: None,
        jupiter_rent_reclaimed: request.jupiter_outcome_mint.is_none(),
        jupiter_rent_reclaimed_lamports: 0,
        jupiter_rent_reclaim_transaction_signatures: Vec::new(),
        entry_submission_skew_ms: None,
        exit_submission_skew_ms: None,
        diagnostic_test_entry: request.diagnostic_test_entry,
        entry_zero_exposure_proof: None,
        post_fill_risk_plan: None,
        last_error: None,
        settlement_error: None,
    }
}

#[must_use]
pub fn build_risk_plan(
    polymarket_contracts_micro: Micro,
    jupiter_contracts_micro: Micro,
    total_cost_micro_usd: Micro,
) -> PostFillRiskPlan {
    build_risk_plan_with_minimum(
        polymarket_contracts_micro,
        jupiter_contracts_micro,
        total_cost_micro_usd,
        0,
    )
}

fn build_risk_plan_with_minimum(
    polymarket_contracts_micro: Micro,
    jupiter_contracts_micro: Micro,
    total_cost_micro_usd: Micro,
    minimum_profit_micro_usd: Micro,
) -> PostFillRiskPlan {
    let scenarios = vec![
        scenario(
            ResolutionScenarioCode::PolymarketOnlyWin,
            true,
            false,
            polymarket_contracts_micro,
            total_cost_micro_usd,
            "Only the Polymarket condition resolves in favor of the held outcome.",
        ),
        scenario(
            ResolutionScenarioCode::JupiterOnlyWin,
            false,
            true,
            jupiter_contracts_micro,
            total_cost_micro_usd,
            "Only the Jupiter condition resolves in favor of the held outcome.",
        ),
        scenario(
            ResolutionScenarioCode::BothWin,
            true,
            true,
            polymarket_contracts_micro.saturating_add(jupiter_contracts_micro),
            total_cost_micro_usd,
            "Oracle/rule basis makes both held outcomes winners.",
        ),
        scenario(
            ResolutionScenarioCode::BothLose,
            false,
            false,
            0,
            total_cost_micro_usd,
            "Oracle/rule basis makes both held outcomes losers.",
        ),
    ];
    let mismatch = (polymarket_contracts_micro - jupiter_contracts_micro).abs();
    let denominator = max(polymarket_contracts_micro, jupiter_contracts_micro);
    let mismatch_bps = (denominator > 0).then(|| mismatch.saturating_mul(10_000) / denominator);
    let maximum_modeled_loss_micro_usd = scenarios
        .iter()
        .map(|scenario| scenario.pnl_micro_usd)
        .min()
        .unwrap_or(0)
        .saturating_neg();
    let intended_floor = min(polymarket_contracts_micro, jupiter_contracts_micro)
        .saturating_sub(total_cost_micro_usd);
    let required_floor = minimum_profit_micro_usd.max(1);
    let (action, reason) = if polymarket_contracts_micro == 0 || jupiter_contracts_micro == 0 {
        (
            PostFillAction::ManualReconciliation,
            "One venue has no observed fill; preserve identities and continue recovery.".to_owned(),
        )
    } else if intended_floor < required_floor {
        (
            PostFillAction::QuoteRepair,
            format!(
                "At least one intended single-winner payout misses the required profit floor {minimum_profit_micro_usd}."
            ),
        )
    } else {
        (
            PostFillAction::HoldOrExitNormally,
            format!(
                "Both intended single-winner payouts meet the required profit floor {minimum_profit_micro_usd}; any quantity residual is retained as outcome-specific upside."
            ),
        )
    };
    PostFillRiskPlan {
        action,
        reason,
        scenarios,
        intended_single_winner_floor_micro_usd: intended_floor,
        maximum_modeled_loss_micro_usd,
        venue_size_mismatch_micro: mismatch,
        venue_size_mismatch_bps: mismatch_bps,
    }
}

fn scenario(
    code: ResolutionScenarioCode,
    polymarket_won: bool,
    jupiter_won: bool,
    payout_micro_usd: Micro,
    cost_micro_usd: Micro,
    rationale: &str,
) -> ResolutionScenario {
    ResolutionScenario {
        code,
        polymarket_won,
        jupiter_won,
        payout_micro_usd,
        pnl_micro_usd: payout_micro_usd.saturating_sub(cost_micro_usd),
        rationale: rationale.to_owned(),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EntryBalanceSnapshot {
    pub polymarket_contracts: Micro,
    pub polymarket_collateral_micro_usd: Micro,
    pub jupiter_contracts: Micro,
    pub jupiter_usdc_micro: Micro,
}

pub async fn capture_entry_balances(
    polymarket: &PolymarketExecutor,
    jupiter: &JupiterHybridExecutor,
    polymarket_token_id: &str,
    jupiter_outcome_mint: Option<&str>,
    jupiter_position_pubkey: &str,
    before_submission: bool,
) -> Result<EntryBalanceSnapshot, LiveError> {
    let poly_future = polymarket.refresh_conditional_balance_micro(polymarket_token_id);
    let collateral_future = polymarket.collateral_balance_micro_usd();
    // Entry reconciliation needs USDC only. Avoid an unrelated getBalance RPC
    // call on every capture; that extra call was a major source of Helius 429s.
    let jupiter_usdc_future = jupiter.usdc_balance();
    if let Some(mint) = jupiter_outcome_mint {
        let (poly, collateral, jup, jupiter_usdc) = tokio::join!(
            poly_future,
            collateral_future,
            jupiter.token_balance(mint),
            jupiter_usdc_future
        );
        Ok(EntryBalanceSnapshot {
            polymarket_contracts: poly?,
            polymarket_collateral_micro_usd: collateral?,
            jupiter_contracts: jup?,
            jupiter_usdc_micro: jupiter_usdc?,
        })
    } else {
        let (poly, collateral, jup, jupiter_usdc) = tokio::join!(
            poly_future,
            collateral_future,
            jupiter.get_position(jupiter_position_pubkey),
            jupiter_usdc_future
        );
        let jupiter_contracts = match jup {
            Ok(position) => position.contracts_micro,
            Err(JupiterError::Http(error))
                if before_submission
                    && error.status().is_some_and(|status| status.as_u16() == 404) =>
            {
                // A standard Prediction position does not exist until its first
                // fill. Only a definitive pre-submit 404 is equivalent to zero;
                // every post-submit observation error remains reconciliation work.
                0
            }
            Err(error) => return Err(error.into()),
        };
        Ok(EntryBalanceSnapshot {
            polymarket_contracts: poly?,
            polymarket_collateral_micro_usd: collateral?,
            jupiter_contracts,
            jupiter_usdc_micro: jupiter_usdc?,
        })
    }
}

async fn capture_entry_balances_with_retry(
    polymarket: &PolymarketExecutor,
    jupiter: &JupiterHybridExecutor,
    polymarket_token_id: &str,
    jupiter_outcome_mint: Option<&str>,
    jupiter_position_pubkey: &str,
    before_submission: bool,
    attempts: u32,
) -> Result<EntryBalanceSnapshot, LiveError> {
    let attempts = attempts.max(1);
    let mut last_error = None;
    for attempt in 0..attempts {
        match capture_entry_balances(
            polymarket,
            jupiter,
            polymarket_token_id,
            jupiter_outcome_mint,
            jupiter_position_pubkey,
            before_submission,
        )
        .await
        {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(150_u64 << attempt.min(2))).await;
        }
    }
    Err(last_error.unwrap_or_else(|| {
        LiveError::Recovery("balance capture exhausted without an error".to_owned())
    }))
}

async fn capture_polymarket_state_with_retry(
    polymarket: &PolymarketExecutor,
    token_id: &str,
    attempts: u32,
) -> Result<(Micro, Micro), LiveError> {
    let attempts = attempts.max(1);
    let mut last_error = None;
    for attempt in 0..attempts {
        let (contracts, collateral) = tokio::join!(
            polymarket.refresh_conditional_balance_micro(token_id),
            polymarket.collateral_balance_micro_usd(),
        );
        match (contracts, collateral) {
            (Ok(contracts), Ok(collateral)) => return Ok((contracts, collateral)),
            (contracts, collateral) => {
                last_error = Some(LiveError::Recovery(format!(
                    "Polymarket recapture failed: contracts={} collateral={}",
                    result_value(contracts),
                    result_value(collateral),
                )));
            }
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(150_u64 << attempt.min(2))).await;
        }
    }
    Err(last_error.unwrap_or_else(|| {
        LiveError::Recovery("Polymarket recapture exhausted without an error".to_owned())
    }))
}

fn validate_entry_request(request: &LiveEntryRequest) -> Result<(), LiveError> {
    if request.position_id.is_empty()
        || request.pair.key.is_empty()
        || request.polymarket_token_id.is_empty()
    {
        return Err(LiveError::InvalidRequest(
            "position, pair, and token identities are required".to_owned(),
        ));
    }
    if request.maximum_repair_slippage_bps > 5_000 {
        return Err(LiveError::InvalidRequest(
            "repair slippage cannot exceed 5000 bps".to_owned(),
        ));
    }
    if request.minimum_post_fill_profit_micro_usd < 0 {
        return Err(LiveError::InvalidRequest(
            "post-fill profit floor cannot be negative".to_owned(),
        ));
    }
    Ok(())
}

fn post_fill_is_acceptable(plan: &PostFillRiskPlan, minimum_profit_micro_usd: Micro) -> bool {
    plan.action == PostFillAction::HoldOrExitNormally
        && plan.intended_single_winner_floor_micro_usd >= minimum_profit_micro_usd
}

fn portfolio_entry_blocker(state: &LiveTraderState) -> Option<String> {
    state.positions.iter().find_map(|position| {
        if matches!(
            position.phase,
            LivePositionPhase::JupiterPrepared
                | LivePositionPhase::JupiterPending
                | LivePositionPhase::PolymarketHedging
                | LivePositionPhase::LegsSubmitting
                | LivePositionPhase::RecoveryPlanning
                | LivePositionPhase::ExposureError
        ) {
            return Some(format!(
                "position {} is in {:?}",
                position.id, position.phase
            ));
        }
        if let Some(error) = position.settlement_error.as_deref() {
            return Some(format!(
                "position {} has unresolved settlement error: {error}",
                position.id
            ));
        }
        let Some(plan) = position.post_fill_risk_plan.as_ref() else {
            return Some(format!(
                "position {} has no verified post-fill risk plan",
                position.id
            ));
        };
        if position.polymarket_contracts_micro <= 0 || position.jupiter_contracts_micro <= 0 {
            return Some(format!(
                "position {} has one-sided exposure Poly={} Jup={}",
                position.id, position.polymarket_contracts_micro, position.jupiter_contracts_micro,
            ));
        }
        if plan.action != PostFillAction::HoldOrExitNormally
            || plan.intended_single_winner_floor_micro_usd <= 0
        {
            return Some(format!(
                "position {} does not have two positive intended single-winner outcomes: action={:?} floor={} mismatch={}",
                position.id,
                plan.action,
                plan.intended_single_winner_floor_micro_usd,
                plan.venue_size_mismatch_micro,
            ));
        }
        None
    })
}

fn submission_is_ambiguous(
    polymarket: &Result<PolymarketFill, PolymarketError>,
    jupiter: &Result<SubmittedJupiterOrder, JupiterError>,
) -> bool {
    matches!(polymarket, Err(PolymarketError::AmbiguousSubmission(_)))
        || matches!(jupiter, Err(JupiterError::AmbiguousExecution(_)))
}

fn combined_error_reason(
    polymarket: &Result<PolymarketFill, PolymarketError>,
    jupiter: &Result<SubmittedJupiterOrder, JupiterError>,
) -> String {
    format!(
        "zero observed balances but submission identity is ambiguous: Poly={}; Jup={}",
        result_label(polymarket),
        result_label(jupiter)
    )
}

fn result_label<T, E: fmt::Display>(result: &Result<T, E>) -> String {
    result
        .as_ref()
        .map_or_else(|error| format!("error({error})"), |_| "success".to_owned())
}

fn polymarket_result_label(result: &Result<PolymarketFill, PolymarketError>) -> String {
    result.as_ref().map_or_else(
        |error| format!("error({error})"),
        |fill| {
            format!(
                "success(contracts={} gross={} submittedAtMs={} tx={})",
                fill.filled_contracts_micro,
                fill.gross_micro_usd,
                fill.submitted_at_ms,
                if fill.transaction_hashes.is_empty() {
                    "none".to_owned()
                } else {
                    fill.transaction_hashes.join(",")
                }
            )
        },
    )
}

fn jupiter_result_label(result: &Result<SubmittedJupiterOrder, JupiterError>) -> String {
    result.as_ref().map_or_else(
        |error| format!("error({error})"),
        |fill| {
            format!(
                "success(signature={} status={} contracts={} cost={} submittedAtMs={})",
                fill.transaction_signature,
                fill.status.status,
                fill.status.filled_contracts_micro,
                fill.status.size_micro_usd,
                fill.submission_started_at_ms,
            )
        },
    )
}

fn result_value<E: fmt::Display>(result: Result<Micro, E>) -> String {
    result.map_or_else(|error| format!("error({error})"), |value| value.to_string())
}

fn authoritative_quantity(
    observed: Micro,
    reported: Micro,
    submission_succeeded: bool,
    prefer_reported: bool,
) -> Micro {
    if prefer_reported && submission_succeeded {
        reported.max(0)
    } else if observed > 0 {
        observed
    } else if submission_succeeded {
        reported.max(0)
    } else {
        0
    }
}

fn positive_delta(before: Micro, after: Micro) -> Micro {
    after.saturating_sub(before).max(0)
}

fn state_lock_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(".lock");
    PathBuf::from(value)
}

fn zero_observation_is_mature(proof: Option<&str>, now_ms: i64, minimum_age_ms: i64) -> bool {
    const PREFIX: &str = "first_zero_observation_ms:";
    let Some(proof) = proof else { return false };
    let Some(timestamp) = proof.strip_prefix(PREFIX) else {
        // Legacy TypeScript proofs such as a killed FOK before Jupiter
        // submission were already definitive rather than first observations.
        return true;
    };
    timestamp
        .parse::<i64>()
        .ok()
        .is_some_and(|observed_at| now_ms.saturating_sub(observed_at) >= minimum_age_ms)
}

const fn floor_contract_step(value: Micro) -> Micro {
    value - value.rem_euclid(10_000)
}

fn multiply_price_quantity(price: Micro, quantity: Micro) -> Result<Micro, LiveError> {
    price
        .checked_mul(quantity)
        .and_then(|value| value.checked_div(ONE_USD_MICRO))
        .ok_or_else(|| LiveError::Recovery("price/quantity calculation overflow".to_owned()))
}

fn polymarket_taker_fee_total(price: Micro, quantity: Micro) -> Result<Micro, LiveError> {
    polymarket_crypto_taker_fee_per_contract_micro_usd(price)
        .map_err(|error| {
            LiveError::Recovery(format!("Polymarket fee calculation failed: {error}"))
        })?
        .checked_mul(quantity)
        .and_then(|value| value.checked_add(ONE_USD_MICRO / 2))
        .and_then(|value| value.checked_div(ONE_USD_MICRO))
        .ok_or_else(|| LiveError::Recovery("Polymarket fee calculation overflow".to_owned()))
}

fn modeled_sell_repair_loss(
    polymarket_cost: Micro,
    jupiter_cost: Micro,
    net_proceeds: Micro,
    remaining_matched_payout: Micro,
) -> Result<Micro, LiveError> {
    let total_cost = polymarket_cost
        .checked_add(jupiter_cost)
        .ok_or_else(|| LiveError::Recovery("repair SELL modeled-loss overflow".to_owned()))?;
    Ok(total_cost
        .saturating_sub(net_proceeds)
        .saturating_sub(remaining_matched_payout))
}

fn apply_buy_slippage(price: Micro, bps: u32) -> Result<Micro, LiveError> {
    price
        .checked_mul(10_000 + Micro::from(bps))
        .and_then(|value| value.checked_add(9_999))
        .and_then(|value| value.checked_div(10_000))
        .map(|value| value.min(990_000))
        .ok_or_else(|| LiveError::Recovery("BUY slippage calculation overflow".to_owned()))
}

fn apply_sell_slippage(price: Micro, bps: u32) -> Result<Micro, LiveError> {
    price
        .checked_mul(10_000 - Micro::from(bps))
        .and_then(|value| value.checked_div(10_000))
        .map(|value| value.max(10_000))
        .ok_or_else(|| LiveError::Recovery("SELL slippage calculation overflow".to_owned()))
}

const fn align_price_up(price: Micro) -> Micro {
    ((price + 9_999) / 10_000) * 10_000
}

const fn align_price_down(price: Micro) -> Micro {
    (price / 10_000) * 10_000
}

fn unix_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_position() -> LivePosition {
        LivePosition {
            id: "live-test".to_owned(),
            pair: LivePairIdentity {
                key: "5m:test".to_owned(),
                duration: "5m".to_owned(),
                start_ms: 1_000,
                end_ms: 2_000,
                polymarket_market_id: "poly-market".to_owned(),
                polymarket_slug: "poly-slug".to_owned(),
                polymarket_token_id: "poly-token".to_owned(),
                polymarket_outcome: jupol_state::Outcome::Down,
                jupiter_market_id: "BISON-market".to_owned(),
                jupiter_outcome_mint: Some("outcome-mint".to_owned()),
                jupiter_outcome: jupol_state::Outcome::Up,
            },
            phase: LivePositionPhase::RecoveryPlanning,
            entered_at_ms: 1_500,
            jupiter_order_pubkey: None,
            jupiter_position_pubkey: "raw-build-position".to_owned(),
            jupiter_entry_position_pubkey: Some("raw-build-position".to_owned()),
            jupiter_quoted_contracts_micro: Some(10_000_000),
            jupiter_execution_reconciliation_source: Some("onchain_token_deltas".to_owned()),
            jupiter_contracts_micro: 10_000_000,
            polymarket_contracts_micro: 0,
            jupiter_entry_cost_micro_usd: 4_000_000,
            polymarket_entry_cost_micro_usd: 0,
            remaining_entry_cost_micro_usd: 4_000_000,
            minimum_post_fill_profit_micro_usd: 0,
            original_contracts_micro: 0,
            realized_profit_micro_usd: 0,
            polymarket_settled: false,
            jupiter_settled: false,
            polymarket_settlement_payout_micro_usd: 0,
            jupiter_settlement_payout_micro_usd: 0,
            polymarket_entry_transaction_hashes: Vec::new(),
            jupiter_entry_transaction_signature: None,
            polymarket_entry_submission_result: None,
            jupiter_entry_submission_result: None,
            polymarket_settlement_transaction_signature: Some("entry-hash".to_owned()),
            polymarket_redemption_collateral_before_micro_usd: None,
            jupiter_settlement_transaction_signature: None,
            jupiter_rent_reclaimed: true,
            jupiter_rent_reclaimed_lamports: 0,
            jupiter_rent_reclaim_transaction_signatures: Vec::new(),
            entry_submission_skew_ms: None,
            exit_submission_skew_ms: None,
            diagnostic_test_entry: false,
            entry_zero_exposure_proof: None,
            post_fill_risk_plan: Some(build_risk_plan(0, 10_000_000, 4_000_000)),
            last_error: None,
            settlement_error: None,
        }
    }

    #[test]
    fn risk_plan_models_all_four_resolution_states() {
        let plan = build_risk_plan(10_000_000, 9_500_000, 8_000_000);
        assert_eq!(plan.scenarios.len(), 4);
        assert_eq!(plan.action, PostFillAction::HoldOrExitNormally);
        assert_eq!(plan.intended_single_winner_floor_micro_usd, 1_500_000);
        assert!(
            plan.scenarios
                .iter()
                .any(|scenario| scenario.code == ResolutionScenarioCode::BothLose)
        );
    }

    #[test]
    fn exact_quantities_are_holdable() {
        let plan = build_risk_plan(12_340_000, 12_340_000, 11_000_000);
        assert_eq!(plan.action, PostFillAction::HoldOrExitNormally);
        assert_eq!(plan.venue_size_mismatch_micro, 0);
    }

    #[test]
    fn post_fill_gate_uses_both_single_winner_pnls_not_exact_size() {
        let safe = build_risk_plan(10_000_000, 10_005_000, 9_800_000);
        assert!(post_fill_is_acceptable(&safe, 100_000));

        let negative = build_risk_plan(10_000_000, 10_000_000, 10_100_000);
        assert!(!post_fill_is_acceptable(&negative, 0));

        let mismatched = build_risk_plan(10_000_000, 10_020_000, 9_000_000);
        assert!(post_fill_is_acceptable(&mismatched, 100_000));

        let below_configured_floor = build_risk_plan(14_150_000, 14_101_204, 14_061_324);
        assert!(post_fill_is_acceptable(&below_configured_floor, 0));
        assert!(!post_fill_is_acceptable(&below_configured_floor, 100_000));
    }

    #[test]
    fn portfolio_quarantines_only_unhealthy_positions() {
        let mut state = LiveTraderState::default();
        let mut position = test_position();
        position.phase = LivePositionPhase::Open;
        position.polymarket_contracts_micro = 10_000_000;
        position.jupiter_contracts_micro = 10_000_000;
        position.polymarket_entry_cost_micro_usd = 5_000_000;
        position.jupiter_entry_cost_micro_usd = 4_800_000;
        position.remaining_entry_cost_micro_usd = 9_800_000;
        position.post_fill_risk_plan = Some(build_risk_plan(10_000_000, 10_000_000, 9_800_000));
        state.positions.push(position.clone());
        assert_eq!(portfolio_entry_blocker(&state), None);

        position.jupiter_contracts_micro = 10_500_000;
        position.post_fill_risk_plan = Some(build_risk_plan(10_000_000, 10_500_000, 9_800_000));
        state.positions[0] = position.clone();
        assert_eq!(portfolio_entry_blocker(&state), None);

        position.jupiter_contracts_micro = 0;
        position.post_fill_risk_plan = Some(build_risk_plan(10_000_000, 0, 5_000_000));
        state.positions[0] = position;
        assert!(
            portfolio_entry_blocker(&state)
                .expect("one-sided exposure blocks entry")
                .contains("one-sided")
        );
    }

    #[test]
    fn repair_prices_are_aligned_to_a_safe_common_tick() {
        assert_eq!(align_price_up(523_001), 530_000);
        assert_eq!(align_price_down(523_001), 520_000);
    }

    #[test]
    fn swap_v2_execute_totals_override_lagging_balance_observations() {
        assert_eq!(
            authoritative_quantity(4_900_000, 5_250_000, true, true),
            5_250_000
        );
        assert_eq!(
            authoritative_quantity(4_900_000, 5_250_000, true, false),
            4_900_000
        );
    }

    #[test]
    fn durable_state_has_a_process_lock() {
        let unique = format!(
            "jupol-live-lock-{}-{}",
            std::process::id(),
            unix_timestamp_ms()
        );
        let directory = std::env::temp_dir().join(unique);
        let path = directory.join("state.json");
        let first = LiveCoordinator::load(&path).expect("first coordinator lock");
        let error = LiveCoordinator::load(&path)
            .err()
            .expect("second coordinator must fail");
        assert!(error.to_string().contains("already managed"));
        drop(first);
        let second = LiveCoordinator::load(&path).expect("lock releases on drop");
        drop(second);
        fs::remove_dir_all(directory).expect("remove test-owned directory");
    }

    #[test]
    fn zero_exposure_requires_a_delayed_second_observation() {
        assert!(!zero_observation_is_mature(
            Some("first_zero_observation_ms:1000"),
            2_999,
            2_000,
        ));
        assert!(zero_observation_is_mature(
            Some("first_zero_observation_ms:1000"),
            3_000,
            2_000,
        ));
        assert!(zero_observation_is_mature(
            Some("polymarket_fok_killed_before_jupiter_submission"),
            0,
            90_000,
        ));
    }

    #[test]
    fn migrates_atomic_execution_identity_and_misfiled_entry_hash() {
        let mut state = LiveTraderState::default();
        state.positions.push(test_position());
        assert!(migrate_live_state(&mut state));
        let position = &state.positions[0];
        assert_eq!(
            position.jupiter_position_pubkey,
            "swap-v2:BISON-market:outcome-mint"
        );
        assert_eq!(
            position.polymarket_entry_transaction_hashes,
            vec!["entry-hash"]
        );
        assert_eq!(position.polymarket_settlement_transaction_signature, None);
        assert!(!position.jupiter_rent_reclaimed);
        assert!(!migrate_live_state(&mut state));
    }

    #[test]
    fn migrates_profitable_residual_out_of_quote_repair() {
        let mut position = test_position();
        position.polymarket_contracts_micro = 14_150_000;
        position.jupiter_contracts_micro = 14_101_204;
        position.polymarket_entry_cost_micro_usd = 1_200_410;
        position.jupiter_entry_cost_micro_usd = 12_860_914;
        position.remaining_entry_cost_micro_usd = 14_061_324;
        let mut legacy_plan = build_risk_plan(14_150_000, 14_101_204, 14_061_324);
        legacy_plan.action = PostFillAction::QuoteRepair;
        legacy_plan.reason = "legacy exact-quantity policy".to_owned();
        position.post_fill_risk_plan = Some(legacy_plan);
        position.last_error = Some("bounded repair failed: precision residual".to_owned());
        let mut state = LiveTraderState::default();
        state.positions.push(position);

        assert!(migrate_live_state(&mut state));
        let plan = state.positions[0]
            .post_fill_risk_plan
            .as_ref()
            .expect("migrated plan");
        assert_eq!(plan.action, PostFillAction::HoldOrExitNormally);
        assert_eq!(plan.intended_single_winner_floor_micro_usd, 39_880);
        assert_eq!(state.positions[0].last_error, None);
    }

    #[test]
    fn known_exposure_cannot_be_treated_as_zero_after_expiry() {
        let position = test_position();
        assert!(has_recorded_exposure(&position));
    }

    #[test]
    fn known_exposure_never_acquires_a_zero_exposure_proof() {
        let unique = format!(
            "jupol-live-zero-proof-{}-{}",
            std::process::id(),
            unix_timestamp_ms()
        );
        let directory = std::env::temp_dir().join(unique);
        let path = directory.join("state.json");
        let mut coordinator = LiveCoordinator::load(&path).expect("coordinator");
        coordinator.state.positions.push(test_position());
        coordinator
            .mark_zero_observation_pending("live-test", "zero")
            .expect("persist zero observation");
        assert_eq!(
            coordinator.state.positions[0].entry_zero_exposure_proof,
            None
        );
        drop(coordinator);
        fs::remove_dir_all(directory).expect("remove test-owned directory");
    }

    #[test]
    fn fully_settled_positions_move_to_the_audit_ledger() {
        let unique = format!(
            "jupol-live-settled-ledger-{}-{}",
            std::process::id(),
            unix_timestamp_ms()
        );
        let directory = std::env::temp_dir().join(unique);
        let path = directory.join("state.json");
        let mut coordinator = LiveCoordinator::load(&path).expect("coordinator");
        let mut position = test_position();
        position.phase = LivePositionPhase::AwaitingResolution;
        position.polymarket_settled = true;
        position.jupiter_settled = true;
        position.jupiter_rent_reclaimed = true;
        position.polymarket_settlement_payout_micro_usd = 5_000_000;
        position.jupiter_settlement_payout_micro_usd = 0;
        position.remaining_entry_cost_micro_usd = 4_000_000;
        coordinator.state.positions.push(position);

        assert_eq!(
            coordinator
                .finalize_fully_settled_positions()
                .expect("finalize"),
            1
        );
        assert!(coordinator.state.positions.is_empty());
        assert_eq!(coordinator.state.settled_positions.len(), 1);
        assert_eq!(coordinator.state.realized_profit_micro_usd, 1_000_000);
        assert_eq!(
            coordinator.state.settled_positions[0].realized_profit_micro_usd,
            1_000_000
        );
        drop(coordinator);
        fs::remove_dir_all(directory).expect("remove test-owned directory");
    }

    #[test]
    fn poly_only_unwind_loss_uses_entry_cost_minus_net_sale_proceeds() {
        let quantity = 5_000_000;
        let entry_cost = 1_050_000;
        let limit = 190_000;
        let gross = multiply_price_quantity(limit, quantity).unwrap();
        let fee = polymarket_taker_fee_total(limit, quantity).unwrap();
        let modeled_loss =
            modeled_sell_repair_loss(entry_cost, 0, gross.saturating_sub(fee), 0).unwrap();
        assert!(modeled_loss <= 200_000);
        assert_ne!(
            modeled_loss,
            multiply_price_quantity(ONE_USD_MICRO - limit, quantity).unwrap()
        );
    }
}
