//! Cross-venue live-entry and recovery state machine.
//!
//! Submission is persisted before either venue is called. Results are then
//! classified from authoritative fills/balances into the four possible states:
//! neither leg, both legs, Polymarket only, or Jupiter only. Quantity mismatch
//! is repaired on Polymarket because submitting a second Jupiter request could
//! double-fill an ambiguous first request.

#![allow(clippy::missing_errors_doc)]
#![allow(clippy::too_many_arguments, clippy::too_many_lines)]

use std::cmp::{max, min};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use jupol_domain::Micro;
use jupol_domain::fixed::ONE_USD_MICRO;
use jupol_jupiter::{
    JupiterError, JupiterHybridExecutor, PreparedJupiterSubmission, SubmittedJupiterOrder,
};
use jupol_polymarket::{PolymarketError, PolymarketExecutor, PolymarketFill, PreparedFokOrder};
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
        let state = load_live_state(&state_path)?;
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

        let observation = capture_entry_balances(
            polymarket,
            jupiter,
            &request.polymarket_token_id,
            request.jupiter_outcome_mint.as_deref(),
            jupiter_build.order.position_pubkey.as_str(),
            false,
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
        let polymarket_contracts = authoritative_quantity(
            observed_polymarket,
            reported_polymarket,
            polymarket_result.is_ok(),
        );
        let jupiter_contracts =
            authoritative_quantity(observed_jupiter, reported_jupiter, jupiter_result.is_ok());

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
            positive_delta(before.jupiter_usdc_micro, after.jupiter_usdc_micro);
        let jupiter_cost = if observed_jupiter_cost > 0 {
            observed_jupiter_cost
        } else {
            jupiter_result
                .as_ref()
                .map_or(0, |fill| fill.status.size_micro_usd)
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
                    final_polymarket = repair.final_contracts_micro;
                    polymarket_cost = polymarket_cost
                        .checked_add(repair.additional_cost_micro_usd)
                        .and_then(|value| value.checked_sub(repair.proceeds_micro_usd))
                        .ok_or_else(|| {
                            LiveError::Recovery("repair accounting overflow".to_owned())
                        })?;
                }
                Err(error) => {
                    let reason = format!(
                        "observed Poly={final_polymarket} Jup={final_jupiter}; repair failed: {error}"
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

        let phase = if final_polymarket > 0 && final_jupiter > 0 {
            LivePositionPhase::Open
        } else {
            LivePositionPhase::RecoveryPlanning
        };
        let reason = (phase == LivePositionPhase::RecoveryPlanning).then(|| {
            format!(
                "repair completed without a complementary pair: Poly={final_polymarket} Jup={final_jupiter}"
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
                    let reason = "first repeated zero-balance observation recorded; a later pass must confirm it";
                    self.mark_zero_observation_pending(&id, reason)?;
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
                (Ok(poly), Ok(jup)) if poly == jup && poly > 0 => {
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
                        Ok(repair) if repair.final_contracts_micro == jup && jup > 0 => {
                            self.finalize_observed_position(
                                &id,
                                repair.final_contracts_micro,
                                jup,
                                position
                                    .polymarket_entry_cost_micro_usd
                                    .saturating_add(repair.additional_cost_micro_usd)
                                    .saturating_sub(repair.proceeds_micro_usd),
                                position.jupiter_entry_cost_micro_usd,
                                None,
                                None,
                                LivePositionPhase::Open,
                                None,
                            )?;
                            dispositions.push(EntryDisposition::Opened {
                                position_id: id,
                                repaired: true,
                            });
                        }
                        Ok(repair) if repair.final_contracts_micro == 0 && jup == 0 => {
                            self.state.positions.retain(|candidate| candidate.id != id);
                            self.state.completed_pairs.push(position.pair.key);
                            self.bump_and_save()?;
                            dispositions.push(EntryDisposition::ZeroExposure { position_id: id });
                        }
                        Ok(repair) => {
                            let reason = format!(
                                "startup repair remained mismatched: Poly={} Jup={jup}",
                                repair.final_contracts_micro
                            );
                            self.mark_recovery_pending(&id, &reason)?;
                            dispositions.push(EntryDisposition::RecoveryPending {
                                position_id: id,
                                reason,
                            });
                        }
                        Err(error) => {
                            let reason = format!(
                                "startup observed Poly={poly} Jup={jup}; bounded repair failed: {error}"
                            );
                            self.mark_recovery_pending(&id, &reason)?;
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
            if position.pair.end_ms <= now_ms && matches!(position.phase, LivePositionPhase::Open) {
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
            .map(|_| "onchain_token_deltas".to_owned())
            .or_else(|| position.jupiter_execution_reconciliation_source.clone());
        position.last_error = error;
        position.post_fill_risk_plan = Some(build_risk_plan(
            polymarket_contracts_micro,
            jupiter_contracts_micro,
            position.remaining_entry_cost_micro_usd,
        ));
        position.entry_submission_skew_ms = polymarket_fill
            .zip(jupiter_fill)
            .map(|(poly, jup)| (poly.submitted_at_ms - jup.submission_started_at_ms).abs());
        if let Some(fill) = polymarket_fill
            && let Some(hash) = fill.transaction_hashes.first()
        {
            position.polymarket_settlement_transaction_signature = Some(hash.clone());
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

    fn mark_zero_observation_pending(&mut self, id: &str, reason: &str) -> Result<(), LiveError> {
        let position = self
            .state
            .positions
            .iter_mut()
            .find(|position| position.id == id)
            .ok_or_else(|| LiveError::InvalidRequest(format!("position {id} disappeared")))?;
        position.phase = LivePositionPhase::RecoveryPlanning;
        position.last_error = Some(reason.to_owned());
        if position.entry_zero_exposure_proof.is_none() {
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
        let missing = floor_contract_step(target - current);
        if missing <= 0 {
            return Ok(RepairResult {
                final_contracts_micro: current,
                additional_cost_micro_usd: 0,
                proceeds_micro_usd: 0,
            });
        }
        let ask =
            best_ask.ok_or_else(|| LiveError::Recovery("repair BUY has no ask".to_owned()))?;
        let limit = align_price_up(apply_buy_slippage(ask, slippage_bps)?);
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
        let excess = floor_contract_step(current - target);
        if excess <= 0 {
            return Ok(RepairResult {
                final_contracts_micro: current,
                additional_cost_micro_usd: 0,
                proceeds_micro_usd: 0,
            });
        }
        let bid =
            best_bid.ok_or_else(|| LiveError::Recovery("repair SELL has no bid".to_owned()))?;
        let limit = align_price_down(apply_sell_slippage(bid, slippage_bps)?);
        let unwind_loss = multiply_price_quantity(ONE_USD_MICRO - limit, excess)?;
        if unwind_loss > effective_maximum_loss {
            return Err(LiveError::Recovery(format!(
                "repair SELL modeled loss {unwind_loss} exceeds bound {effective_maximum_loss}"
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
    LivePosition {
        id: request.position_id.clone(),
        pair: request.pair.clone(),
        phase: LivePositionPhase::LegsSubmitting,
        entered_at_ms: unix_timestamp_ms(),
        jupiter_order_pubkey: build.order.order_pubkey.clone(),
        jupiter_position_pubkey: build.order.position_pubkey.clone(),
        jupiter_entry_position_pubkey: Some(build.order.position_pubkey.clone()),
        jupiter_quoted_contracts_micro: Some(build.order.new_contracts_micro),
        jupiter_execution_reconciliation_source: None,
        jupiter_contracts_micro: 0,
        polymarket_contracts_micro: 0,
        jupiter_entry_cost_micro_usd: 0,
        polymarket_entry_cost_micro_usd: 0,
        remaining_entry_cost_micro_usd: 0,
        original_contracts_micro: 0,
        realized_profit_micro_usd: 0,
        polymarket_settled: false,
        jupiter_settled: false,
        polymarket_settlement_payout_micro_usd: 0,
        jupiter_settlement_payout_micro_usd: 0,
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
    let (action, reason) = if polymarket_contracts_micro == 0 || jupiter_contracts_micro == 0 {
        (
            PostFillAction::ManualReconciliation,
            "One venue has no observed fill; preserve identities and continue recovery.".to_owned(),
        )
    } else if mismatch > 10_000 {
        (
            PostFillAction::QuoteRepair,
            "Venue quantities differ by more than the 0.01-contract execution step.".to_owned(),
        )
    } else {
        (
            PostFillAction::HoldOrExitNormally,
            "Both venue fills are observed and quantity-matched.".to_owned(),
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
    let jupiter_wallet_future = jupiter.wallet_balances();
    if let Some(mint) = jupiter_outcome_mint {
        let (poly, collateral, jup, jupiter_wallet) = tokio::join!(
            poly_future,
            collateral_future,
            jupiter.token_balance(mint),
            jupiter_wallet_future
        );
        Ok(EntryBalanceSnapshot {
            polymarket_contracts: poly?,
            polymarket_collateral_micro_usd: collateral?,
            jupiter_contracts: jup?,
            jupiter_usdc_micro: jupiter_wallet?.usdc_micro,
        })
    } else {
        let (poly, collateral, jup, jupiter_wallet) = tokio::join!(
            poly_future,
            collateral_future,
            jupiter.get_position(jupiter_position_pubkey),
            jupiter_wallet_future
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
            jupiter_usdc_micro: jupiter_wallet?.usdc_micro,
        })
    }
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
    Ok(())
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

fn result_value<E: fmt::Display>(result: Result<Micro, E>) -> String {
    result.map_or_else(|error| format!("error({error})"), |value| value.to_string())
}

fn authoritative_quantity(observed: Micro, reported: Micro, submission_succeeded: bool) -> Micro {
    if observed > 0 {
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

    #[test]
    fn risk_plan_models_all_four_resolution_states() {
        let plan = build_risk_plan(10_000_000, 9_500_000, 8_000_000);
        assert_eq!(plan.scenarios.len(), 4);
        assert_eq!(plan.action, PostFillAction::QuoteRepair);
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
    fn repair_prices_are_aligned_to_a_safe_common_tick() {
        assert_eq!(align_price_up(523_001), 530_000);
        assert_eq!(align_price_down(523_001), 520_000);
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
}
