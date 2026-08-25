//! Minimal pooled Solana JSON-RPC and transaction-signing support used by the
//! live Jupiter path. Keeping RPC transport here avoids pulling Agave's full
//! validator client into the trading binary.

#![allow(clippy::missing_errors_doc)]

use std::fmt;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use jupol_http::{HttpClient, HttpClientOptions, HttpError};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use solana_instruction::{AccountMeta, Instruction};
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signature};
use solana_sdk::signer::Signer as _;
use solana_sdk::transaction::{Transaction, VersionedTransaction};

#[derive(Debug)]
pub enum SolanaError {
    Http(HttpError),
    Rpc {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    InvalidResponse(String),
    InvalidPrivateKey(String),
    TransactionDecode(String),
    MissingRequiredSigner(String),
    TransactionFailed(Value),
    ConfirmationTimeout(String),
}

impl fmt::Display for SolanaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(error) => error.fmt(formatter),
            Self::Rpc { code, message, .. } => write!(formatter, "Solana RPC {code}: {message}"),
            Self::InvalidResponse(message) => {
                write!(formatter, "Invalid Solana RPC response: {message}")
            }
            Self::InvalidPrivateKey(message) => {
                write!(formatter, "Invalid Solana private key: {message}")
            }
            Self::TransactionDecode(message) => {
                write!(formatter, "Solana transaction decode failed: {message}")
            }
            Self::MissingRequiredSigner(value) => {
                write!(formatter, "Transaction requires unavailable signer {value}")
            }
            Self::TransactionFailed(error) => {
                write!(formatter, "Solana transaction failed: {error}")
            }
            Self::ConfirmationTimeout(signature) => {
                write!(formatter, "Solana confirmation timed out for {signature}")
            }
        }
    }
}

impl std::error::Error for SolanaError {}

impl From<HttpError> for SolanaError {
    fn from(value: HttpError) -> Self {
        Self::Http(value)
    }
}

#[derive(Clone)]
pub struct SolanaRpc {
    url: String,
    http: HttpClient,
    request_id: Arc<AtomicU64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalletBalances {
    pub sol_lamports: u64,
    pub usdc_micro: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenBalanceDelta {
    pub mint: String,
    pub before: i128,
    pub after: i128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnedTokenAccount {
    pub pubkey: String,
    pub amount: i128,
    pub program_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddressSignature {
    pub signature: String,
    pub slot: u64,
}

impl SolanaRpc {
    pub fn new(url: impl Into<String>) -> Result<Self, SolanaError> {
        let url = url.into();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(SolanaError::InvalidResponse(
                "RPC URL must be HTTP(S)".to_owned(),
            ));
        }
        Ok(Self {
            url,
            http: HttpClient::new(&HttpClientOptions {
                timeout: Duration::from_secs(15),
                retries: 1,
                ..HttpClientOptions::default()
            })?,
            request_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub async fn get_balance(&self, owner: &Pubkey) -> Result<u64, SolanaError> {
        let result: Value = self
            .rpc(
                "getBalance",
                json!([owner.to_string(), { "commitment": "confirmed" }]),
            )
            .await?;
        result.get("value").and_then(Value::as_u64).ok_or_else(|| {
            SolanaError::InvalidResponse("getBalance has no integer value".to_owned())
        })
    }

    pub async fn get_token_balance(&self, owner: &Pubkey, mint: &str) -> Result<i128, SolanaError> {
        let result: Value = self
            .rpc(
                "getTokenAccountsByOwner",
                json!([
                    owner.to_string(),
                    { "mint": mint },
                    { "encoding": "jsonParsed", "commitment": "confirmed" }
                ]),
            )
            .await?;
        let accounts = result
            .get("value")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                SolanaError::InvalidResponse("token-account response has no value array".to_owned())
            })?;
        accounts.iter().try_fold(0_i128, |total, account| {
            let amount = account
                .pointer("/account/data/parsed/info/tokenAmount/amount")
                .and_then(Value::as_str)
                .unwrap_or("0")
                .parse::<i128>()
                .map_err(|error| {
                    SolanaError::InvalidResponse(format!("invalid token balance: {error}"))
                })?;
            total
                .checked_add(amount)
                .ok_or_else(|| SolanaError::InvalidResponse("token balance overflow".to_owned()))
        })
    }

    pub async fn get_token_accounts(
        &self,
        owner: &Pubkey,
        mint: &str,
    ) -> Result<Vec<OwnedTokenAccount>, SolanaError> {
        let result: Value = self
            .rpc(
                "getTokenAccountsByOwner",
                json!([
                    owner.to_string(),
                    { "mint": mint },
                    { "encoding": "jsonParsed", "commitment": "confirmed" }
                ]),
            )
            .await?;
        result
            .get("value")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                SolanaError::InvalidResponse("token-account response has no value array".to_owned())
            })?
            .iter()
            .map(|account| {
                let parsed_owner = account
                    .pointer("/account/data/parsed/info/owner")
                    .and_then(Value::as_str);
                if parsed_owner != Some(owner.to_string().as_str()) {
                    return Err(SolanaError::InvalidResponse(
                        "token account has an unexpected owner".to_owned(),
                    ));
                }
                Ok(OwnedTokenAccount {
                    pubkey: account
                        .get("pubkey")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    amount: account
                        .pointer("/account/data/parsed/info/tokenAmount/amount")
                        .and_then(Value::as_str)
                        .unwrap_or("0")
                        .parse::<i128>()
                        .map_err(|error| {
                            SolanaError::InvalidResponse(format!("invalid token balance: {error}"))
                        })?,
                    program_id: account
                        .pointer("/account/owner")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                })
            })
            .collect()
    }

    pub async fn get_signatures_for_address(
        &self,
        address: &str,
        limit: usize,
    ) -> Result<Vec<AddressSignature>, SolanaError> {
        let result: Value = self
            .rpc(
                "getSignaturesForAddress",
                json!([address, { "limit": limit.min(1_000), "commitment": "confirmed" }]),
            )
            .await?;
        Ok(result
            .as_array()
            .into_iter()
            .flatten()
            .filter(|record| record.get("err").is_none_or(Value::is_null))
            .filter_map(|record| {
                Some(AddressSignature {
                    signature: record.get("signature")?.as_str()?.to_owned(),
                    slot: record.get("slot")?.as_u64()?,
                })
            })
            .collect())
    }

    pub async fn wallet_balances(
        &self,
        owner: &Pubkey,
        usdc_mint: &str,
    ) -> Result<WalletBalances, SolanaError> {
        let (sol_lamports, usdc_micro) = tokio::try_join!(
            self.get_balance(owner),
            self.get_token_balance(owner, usdc_mint),
        )?;
        Ok(WalletBalances {
            sol_lamports,
            usdc_micro,
        })
    }

    pub async fn simulate_transaction(&self, signed_base64: &str) -> Result<(), SolanaError> {
        let result: Value = self
            .rpc(
                "simulateTransaction",
                json!([signed_base64, {
                    "encoding": "base64",
                    "commitment": "confirmed",
                    "sigVerify": true,
                    "replaceRecentBlockhash": false
                }]),
            )
            .await?;
        if let Some(error) = result
            .pointer("/value/err")
            .filter(|value| !value.is_null())
        {
            return Err(SolanaError::TransactionFailed(error.clone()));
        }
        Ok(())
    }

    pub async fn send_transaction(&self, signed_base64: &str) -> Result<String, SolanaError> {
        self.send_transaction_with_options(signed_base64, false, 3)
            .await
    }

    pub async fn send_transaction_with_options(
        &self,
        signed_base64: &str,
        skip_preflight: bool,
        max_retries: usize,
    ) -> Result<String, SolanaError> {
        self.rpc(
            "sendTransaction",
            json!([signed_base64, {
                "encoding": "base64",
                "skipPreflight": skip_preflight,
                "preflightCommitment": if skip_preflight { "processed" } else { "confirmed" },
                "maxRetries": max_retries
            }]),
        )
        .await
    }

    pub async fn close_empty_token_account(
        &self,
        account: &OwnedTokenAccount,
        owner: &Keypair,
        timeout: Duration,
    ) -> Result<(String, u64), SolanaError> {
        if account.amount != 0 {
            return Err(SolanaError::InvalidResponse(format!(
                "cannot close non-empty token account {}",
                account.pubkey
            )));
        }
        let account_pubkey = Pubkey::from_str(&account.pubkey)
            .map_err(|error| SolanaError::InvalidResponse(error.to_string()))?;
        let program_id = Pubkey::from_str(&account.program_id)
            .map_err(|error| SolanaError::InvalidResponse(error.to_string()))?;
        let reclaimed_lamports = self.get_balance(&account_pubkey).await?;
        let latest: Value = self
            .rpc("getLatestBlockhash", json!([{ "commitment": "confirmed" }]))
            .await?;
        let blockhash_text = latest
            .pointer("/value/blockhash")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                SolanaError::InvalidResponse("latest blockhash is missing".to_owned())
            })?;
        let blockhash = Hash::from_str(blockhash_text)
            .map_err(|error| SolanaError::InvalidResponse(error.to_string()))?;
        // SPL Token and Token-2022 both use instruction discriminator 9 for
        // CloseAccount(account, destination, authority).
        let instruction = Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(account_pubkey, false),
                AccountMeta::new(owner.pubkey(), false),
                AccountMeta::new_readonly(owner.pubkey(), true),
            ],
            data: vec![9],
        };
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&owner.pubkey()),
            &[owner],
            blockhash,
        );
        let bytes = bincode::serialize(&transaction)
            .map_err(|error| SolanaError::TransactionDecode(error.to_string()))?;
        let signature = self.send_transaction(&BASE64.encode(bytes)).await?;
        self.confirm_transaction(&signature, timeout).await?;
        Ok((signature, reclaimed_lamports))
    }

    pub async fn confirm_transaction(
        &self,
        signature: &str,
        timeout: Duration,
    ) -> Result<(), SolanaError> {
        let deadline = Instant::now() + timeout;
        loop {
            let result: Value = self
                .rpc(
                    "getSignatureStatuses",
                    json!([[signature], { "searchTransactionHistory": true }]),
                )
                .await?;
            if let Some(status) = result
                .get("value")
                .and_then(Value::as_array)
                .and_then(|values| values.first())
                .filter(|value| !value.is_null())
            {
                if let Some(error) = status.get("err").filter(|value| !value.is_null()) {
                    return Err(SolanaError::TransactionFailed(error.clone()));
                }
                let confirmation = status
                    .get("confirmationStatus")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if confirmation == "confirmed" || confirmation == "finalized" {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return Err(SolanaError::ConfirmationTimeout(signature.to_owned()));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub async fn get_transaction(&self, signature: &str) -> Result<Option<Value>, SolanaError> {
        self.rpc(
            "getTransaction",
            json!([signature, {
                "commitment": "confirmed",
                "encoding": "jsonParsed",
                "maxSupportedTransactionVersion": 0
            }]),
        )
        .await
    }

    pub async fn wait_for_token_deltas(
        &self,
        signature: &str,
        owner: &Pubkey,
        mints: &[&str],
        timeout: Duration,
    ) -> Result<Vec<TokenBalanceDelta>, SolanaError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(transaction) = self.get_transaction(signature).await? {
                if let Some(error) = transaction
                    .pointer("/meta/err")
                    .filter(|value| !value.is_null())
                {
                    return Err(SolanaError::TransactionFailed(error.clone()));
                }
                if transaction.get("meta").is_some() {
                    return parse_token_deltas(&transaction, &owner.to_string(), mints);
                }
            }
            if Instant::now() >= deadline {
                return Err(SolanaError::ConfirmationTimeout(signature.to_owned()));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn rpc<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<T, SolanaError> {
        let id = self.request_id.fetch_add(1, Ordering::Relaxed);
        let response: RpcEnvelope<T> = self
            .http
            .post_json(
                &self.url,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params,
                }),
            )
            .await?;
        if let Some(error) = response.error {
            return Err(SolanaError::Rpc {
                code: error.code,
                message: error.message,
                data: error.data,
            });
        }
        response.result.ok_or_else(|| {
            SolanaError::InvalidResponse(format!("{method} returned neither result nor error"))
        })
    }
}

#[derive(Deserialize)]
struct RpcEnvelope<T> {
    result: Option<T>,
    error: Option<RpcResponseError>,
}

#[derive(Deserialize)]
struct RpcResponseError {
    code: i64,
    message: String,
    data: Option<Value>,
}

pub fn parse_keypair(value: &str) -> Result<Keypair, SolanaError> {
    let trimmed = value.trim();
    let bytes = if trimmed.starts_with('[') {
        serde_json::from_str::<Vec<u8>>(trimmed)
            .map_err(|error| SolanaError::InvalidPrivateKey(error.to_string()))?
    } else {
        bs58::decode(trimmed)
            .into_vec()
            .map_err(|error| SolanaError::InvalidPrivateKey(error.to_string()))?
    };
    if bytes.len() == 32 {
        let secret: [u8; 32] = bytes.try_into().map_err(|value: Vec<u8>| {
            SolanaError::InvalidPrivateKey(format!("invalid {}-byte seed", value.len()))
        })?;
        return Ok(Keypair::new_from_array(secret));
    }
    if bytes.len() != 64 {
        return Err(SolanaError::InvalidPrivateKey(format!(
            "expected a 32-byte seed or 64-byte keypair, received {}",
            bytes.len()
        )));
    }
    Keypair::try_from(bytes.as_slice())
        .map_err(|error| SolanaError::InvalidPrivateKey(error.to_string()))
}

pub fn sign_versioned_transaction(
    transaction_base64: &str,
    keypair: &Keypair,
) -> Result<String, SolanaError> {
    let bytes = BASE64
        .decode(transaction_base64)
        .map_err(|error| SolanaError::TransactionDecode(error.to_string()))?;
    let mut transaction: VersionedTransaction = bincode::deserialize(&bytes)
        .map_err(|error| SolanaError::TransactionDecode(error.to_string()))?;
    let message = transaction.message.serialize();
    let required = usize::from(transaction.message.header().num_required_signatures);
    let signer_index = transaction
        .message
        .static_account_keys()
        .iter()
        .take(required)
        .position(|pubkey| *pubkey == keypair.pubkey())
        .ok_or_else(|| SolanaError::MissingRequiredSigner(keypair.pubkey().to_string()))?;
    if transaction.signatures.len() < required {
        transaction
            .signatures
            .resize(required, Signature::default());
    }
    transaction.signatures[signer_index] = keypair.sign_message(&message);
    let signed = bincode::serialize(&transaction)
        .map_err(|error| SolanaError::TransactionDecode(error.to_string()))?;
    Ok(BASE64.encode(signed))
}

pub fn parse_token_deltas(
    transaction: &Value,
    owner: &str,
    mints: &[&str],
) -> Result<Vec<TokenBalanceDelta>, SolanaError> {
    let pre = transaction
        .pointer("/meta/preTokenBalances")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let post = transaction
        .pointer("/meta/postTokenBalances")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    mints
        .iter()
        .map(|mint| {
            let indexes = pre
                .iter()
                .chain(post)
                .filter(|balance| {
                    balance.get("mint").and_then(Value::as_str) == Some(*mint)
                        && balance.get("owner").and_then(Value::as_str) == Some(owner)
                })
                .filter_map(|balance| balance.get("accountIndex").and_then(Value::as_u64))
                .collect::<Vec<_>>();
            let sum = |balances: &[Value]| -> Result<i128, SolanaError> {
                balances.iter().try_fold(0_i128, |total, balance| {
                    if balance.get("mint").and_then(Value::as_str) != Some(*mint) {
                        return Ok(total);
                    }
                    let index = balance.get("accountIndex").and_then(Value::as_u64);
                    let belongs_to_owner = balance.get("owner").and_then(Value::as_str)
                        == Some(owner)
                        || index.is_some_and(|value| indexes.contains(&value));
                    if !belongs_to_owner {
                        return Ok(total);
                    }
                    let amount = balance
                        .pointer("/uiTokenAmount/amount")
                        .and_then(Value::as_str)
                        .unwrap_or("0")
                        .parse::<i128>()
                        .map_err(|error| SolanaError::InvalidResponse(error.to_string()))?;
                    total.checked_add(amount).ok_or_else(|| {
                        SolanaError::InvalidResponse("token delta overflow".to_owned())
                    })
                })
            };
            Ok(TokenBalanceDelta {
                mint: (*mint).to_owned(),
                before: sum(pre)?,
                after: sum(post)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_private_keys() {
        assert!(parse_keypair("[1,2,3]").is_err());
    }

    #[test]
    fn reconciles_owned_token_account_deltas() {
        let transaction = json!({
            "meta": {
                "preTokenBalances": [{
                    "accountIndex": 2,
                    "mint": "mint",
                    "owner": "owner",
                    "uiTokenAmount": { "amount": "10" }
                }],
                "postTokenBalances": [{
                    "accountIndex": 2,
                    "mint": "mint",
                    "uiTokenAmount": { "amount": "25" }
                }]
            }
        });
        let deltas = parse_token_deltas(&transaction, "owner", &["mint"]).expect("valid deltas");
        assert_eq!(deltas[0].before, 10);
        assert_eq!(deltas[0].after, 25);
    }
}
