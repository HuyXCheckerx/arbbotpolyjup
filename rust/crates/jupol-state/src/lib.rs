//! TypeScript-compatible durable live-trading state.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use jupol_domain::Micro;
use serde::{Deserialize, Serialize};

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Outcome {
    Up,
    Down,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePairIdentity {
    pub key: String,
    pub duration: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub polymarket_market_id: String,
    pub polymarket_slug: String,
    pub polymarket_token_id: String,
    pub polymarket_outcome: Outcome,
    pub jupiter_market_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jupiter_outcome_mint: Option<String>,
    pub jupiter_outcome: Outcome,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LivePositionPhase {
    JupiterPrepared,
    JupiterPending,
    PolymarketHedging,
    LegsSubmitting,
    Open,
    ExitingJupiter,
    ExitingPolymarket,
    RecoveryPlanning,
    AwaitingResolution,
    ExposureError,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionScenarioCode {
    PolymarketOnlyWin,
    JupiterOnlyWin,
    BothWin,
    BothLose,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionScenario {
    pub code: ResolutionScenarioCode,
    pub polymarket_won: bool,
    pub jupiter_won: bool,
    #[serde(with = "micro_n")]
    pub payout_micro_usd: Micro,
    #[serde(with = "micro_n")]
    pub pnl_micro_usd: Micro,
    pub rationale: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostFillAction {
    HoldOrExitNormally,
    QuoteRepair,
    ManualReconciliation,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFillRiskPlan {
    pub action: PostFillAction,
    pub reason: String,
    pub scenarios: Vec<ResolutionScenario>,
    #[serde(with = "micro_n")]
    pub intended_single_winner_floor_micro_usd: Micro,
    #[serde(with = "micro_n")]
    pub maximum_modeled_loss_micro_usd: Micro,
    #[serde(with = "micro_n")]
    pub venue_size_mismatch_micro: Micro,
    #[serde(default, with = "optional_micro_n")]
    pub venue_size_mismatch_bps: Option<Micro>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)]
pub struct LivePosition {
    pub id: String,
    pub pair: LivePairIdentity,
    pub phase: LivePositionPhase,
    pub entered_at_ms: i64,
    pub jupiter_order_pubkey: Option<String>,
    pub jupiter_position_pubkey: String,
    #[serde(default)]
    pub jupiter_entry_position_pubkey: Option<String>,
    #[serde(default, with = "optional_micro_n")]
    pub jupiter_quoted_contracts_micro: Option<Micro>,
    #[serde(default)]
    pub jupiter_execution_reconciliation_source: Option<String>,
    #[serde(with = "micro_n")]
    pub jupiter_contracts_micro: Micro,
    #[serde(with = "micro_n")]
    pub polymarket_contracts_micro: Micro,
    #[serde(with = "micro_n")]
    pub jupiter_entry_cost_micro_usd: Micro,
    #[serde(with = "micro_n")]
    pub polymarket_entry_cost_micro_usd: Micro,
    #[serde(with = "micro_n")]
    pub remaining_entry_cost_micro_usd: Micro,
    #[serde(with = "micro_n")]
    pub original_contracts_micro: Micro,
    #[serde(with = "micro_n")]
    pub realized_profit_micro_usd: Micro,
    pub polymarket_settled: bool,
    pub jupiter_settled: bool,
    #[serde(with = "micro_n")]
    pub polymarket_settlement_payout_micro_usd: Micro,
    #[serde(with = "micro_n")]
    pub jupiter_settlement_payout_micro_usd: Micro,
    #[serde(default)]
    pub polymarket_settlement_transaction_signature: Option<String>,
    #[serde(default, with = "optional_micro_n")]
    pub polymarket_redemption_collateral_before_micro_usd: Option<Micro>,
    #[serde(default)]
    pub jupiter_settlement_transaction_signature: Option<String>,
    #[serde(default)]
    pub jupiter_rent_reclaimed: bool,
    #[serde(default, with = "micro_n")]
    pub jupiter_rent_reclaimed_lamports: Micro,
    #[serde(default)]
    pub jupiter_rent_reclaim_transaction_signatures: Vec<String>,
    pub entry_submission_skew_ms: Option<i64>,
    pub exit_submission_skew_ms: Option<i64>,
    pub diagnostic_test_entry: bool,
    #[serde(default)]
    pub entry_zero_exposure_proof: Option<String>,
    #[serde(default)]
    pub post_fill_risk_plan: Option<PostFillRiskPlan>,
    pub last_error: Option<String>,
    #[serde(default)]
    pub settlement_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTraderState {
    pub schema_version: u32,
    #[serde(default)]
    pub accounting_version: Option<u32>,
    #[serde(default, with = "optional_micro_n")]
    pub legacy_unverified_realized_profit_micro_usd: Option<Micro>,
    pub sequence: u64,
    pub halted: bool,
    pub halt_reason: Option<String>,
    #[serde(with = "micro_n")]
    pub realized_profit_micro_usd: Micro,
    #[serde(default, with = "optional_micro_n")]
    pub polymarket_cash_micro_usd: Option<Micro>,
    #[serde(default, with = "optional_micro_n")]
    pub jupiter_cash_micro_usd: Option<Micro>,
    pub forced_entry_submission_attempted: bool,
    pub completed_pairs: Vec<String>,
    pub positions: Vec<LivePosition>,
}

impl Default for LiveTraderState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            accounting_version: Some(2),
            legacy_unverified_realized_profit_micro_usd: None,
            sequence: 0,
            halted: false,
            halt_reason: None,
            realized_profit_micro_usd: 0,
            polymarket_cash_micro_usd: None,
            jupiter_cash_micro_usd: None,
            forced_entry_submission_attempted: false,
            completed_pairs: Vec::new(),
            positions: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum StateError {
    Io(io::Error),
    Json(serde_json::Error),
    UnsupportedSchema(u32),
}

impl fmt::Display for StateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Live-state I/O failed: {error}"),
            Self::Json(error) => write!(formatter, "Live-state JSON is invalid: {error}"),
            Self::UnsupportedSchema(version) => {
                write!(formatter, "Unsupported live-state schema version {version}")
            }
        }
    }
}

impl std::error::Error for StateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::UnsupportedSchema(_) => None,
        }
    }
}

impl From<io::Error> for StateError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for StateError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// Loads schema-v1 state, or returns an empty state when the file is absent.
///
/// # Errors
///
/// Fails on I/O errors, malformed JSON, invalid micro-unit strings, or a
/// non-v1 schema.
pub fn load_live_state(path: &Path) -> Result<LiveTraderState, StateError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LiveTraderState::default());
        }
        Err(error) => return Err(StateError::Io(error)),
    };
    let state: LiveTraderState = serde_json::from_reader(BufReader::new(file))?;
    if state.schema_version != 1 {
        return Err(StateError::UnsupportedSchema(state.schema_version));
    }
    Ok(state)
}

/// Writes state to a sibling temporary file, flushes it, then atomically
/// renames it into place. This matches the existing TypeScript durability
/// contract and never mutates a valid destination before serialization ends.
///
/// # Errors
///
/// Fails when directory creation, serialization, flushing, or replacement
/// fails. The previous state remains intact when serialization fails.
pub fn save_live_state(path: &Path, state: &LiveTraderState) -> Result<(), StateError> {
    if state.schema_version != 1 {
        return Err(StateError::UnsupportedSchema(state.schema_version));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = temporary_path(path);
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let file = options.open(&temporary)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, state)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    value.push(format!(".tmp.{}.{sequence}", std::process::id()));
    PathBuf::from(value)
}

mod micro_n {
    use std::fmt;

    use jupol_domain::Micro;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &Micro, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&format!("{value}n"))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Micro, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let digits = value
            .strip_suffix('n')
            .ok_or_else(|| serde::de::Error::custom("micro-unit value must end in n"))?;
        if digits.is_empty()
            || digits == "-"
            || digits
                .strip_prefix('-')
                .unwrap_or(digits)
                .bytes()
                .any(|byte| !byte.is_ascii_digit())
        {
            return Err(serde::de::Error::custom(format_args!(
                "invalid micro-unit value {value}"
            )));
        }
        digits.parse::<Micro>().map_err(|error| {
            serde::de::Error::custom(MicroParseError {
                value: &value,
                error,
            })
        })
    }

    struct MicroParseError<'a> {
        value: &'a str,
        error: std::num::ParseIntError,
    }

    impl fmt::Display for MicroParseError<'_> {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(
                formatter,
                "invalid micro-unit value {}: {}",
                self.value, self.error
            )
        }
    }
}

mod optional_micro_n {
    use jupol_domain::Micro;
    use serde::{Deserialize, Deserializer, Serializer};

    // Serde's `with` module contract requires `&Option<T>` here.
    #[allow(clippy::ref_option)]
    pub fn serialize<S>(value: &Option<Micro>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(value) => serializer.serialize_some(&format!("{value}n")),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Micro>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Option::<String>::deserialize(deserializer)?;
        value
            .map(|value| {
                let digits = value
                    .strip_suffix('n')
                    .ok_or_else(|| serde::de::Error::custom("micro-unit value must end in n"))?;
                digits.parse::<Micro>().map_err(serde::de::Error::custom)
            })
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_writes_typescript_bigint_state() {
        let input = r#"{
          "schemaVersion": 1,
          "sequence": 57,
          "halted": false,
          "haltReason": null,
          "realizedProfitMicroUsd": "5791n",
          "polymarketCashMicroUsd": "114495224n",
          "jupiterCashMicroUsd": "64457758n",
          "forcedEntrySubmissionAttempted": false,
          "completedPairs": ["5m:1787500200000"],
          "positions": []
        }"#;
        let state: LiveTraderState = serde_json::from_str(input).expect("valid TypeScript state");
        assert_eq!(state.realized_profit_micro_usd, 5_791);
        assert_eq!(state.polymarket_cash_micro_usd, Some(114_495_224));
        let output = serde_json::to_string(&state).expect("serialize state");
        assert!(output.contains(r#""realizedProfitMicroUsd":"5791n""#));
    }

    #[test]
    fn missing_file_returns_empty_state() {
        let unique = format!(
            "jupol-state-{}-{}-absent.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        assert_eq!(
            load_live_state(&path).expect("empty state"),
            LiveTraderState::default()
        );
    }

    #[test]
    fn atomically_replaces_an_existing_state_file() {
        let unique = format!(
            "jupol-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        let path = directory.join("state.json");
        let first = LiveTraderState::default();
        save_live_state(&path, &first).expect("first state save");
        let mut second = first;
        second.sequence = 2;
        second.realized_profit_micro_usd = 12_345;
        save_live_state(&path, &second).expect("replacement state save");
        assert_eq!(load_live_state(&path).expect("replacement load"), second);
        fs::remove_dir_all(directory).expect("remove test-owned directory");
    }

    #[test]
    fn temporary_state_paths_do_not_collide() {
        let path = Path::new("logs/state.json");
        let first = temporary_path(path);
        let second = temporary_path(path);
        assert_ne!(first, second);
        assert_eq!(first.parent(), path.parent());
        assert_eq!(second.parent(), path.parent());
    }
}
