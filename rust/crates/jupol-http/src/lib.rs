//! Shared keep-alive HTTP client with bounded retries and rate-limit handling.

use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;

#[derive(Clone, Debug)]
pub struct HttpClientOptions {
    pub timeout: Duration,
    pub retries: u32,
    pub default_headers: HashMap<String, String>,
}

impl Default for HttpClientOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
            retries: 2,
            default_headers: HashMap::new(),
        }
    }
}

#[derive(Debug)]
pub enum HttpError {
    Build(reqwest::Error),
    Transport {
        url: String,
        source: reqwest::Error,
    },
    Response {
        status: StatusCode,
        url: String,
        body: String,
        rate_limit_reset_ms: Option<u64>,
        retry_delay_ms: Option<u64>,
    },
    InvalidJson {
        url: String,
        source: serde_json::Error,
    },
    InvalidHeader {
        name: String,
        value: String,
    },
}

impl HttpError {
    #[must_use]
    pub const fn status(&self) -> Option<StatusCode> {
        match self {
            Self::Response { status, .. } => Some(*status),
            _ => None,
        }
    }

    #[must_use]
    pub const fn retry_delay_ms(&self) -> Option<u64> {
        match self {
            Self::Response { retry_delay_ms, .. } => *retry_delay_ms,
            _ => None,
        }
    }
}

impl fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Build(error) => write!(formatter, "HTTP client construction failed: {error}"),
            Self::Transport { url, source } => {
                write!(formatter, "HTTP request failed for {url}: {source}")
            }
            Self::Response {
                status, url, body, ..
            } => {
                let preview: String = body.chars().take(300).collect();
                write!(formatter, "HTTP {} for {url}: {preview}", status.as_u16())
            }
            Self::InvalidJson { url, source } => {
                write!(formatter, "Invalid JSON from {url}: {source}")
            }
            Self::InvalidHeader { name, value } => {
                write!(formatter, "Invalid HTTP header {name}: {value}")
            }
        }
    }
}

impl std::error::Error for HttpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Build(error) => Some(error),
            Self::Transport { source, .. } => Some(source),
            Self::InvalidJson { source, .. } => Some(source),
            Self::Response { .. } | Self::InvalidHeader { .. } => None,
        }
    }
}

#[derive(Clone)]
pub struct HttpClient {
    client: reqwest::Client,
    retries: u32,
    default_headers: HeaderMap,
}

impl HttpClient {
    /// Builds a pooled HTTP/1.1 and HTTP/2 client.
    ///
    /// # Errors
    ///
    /// Returns an error for malformed default headers or TLS/client setup.
    pub fn new(options: &HttpClientOptions) -> Result<Self, HttpError> {
        let mut default_headers = HeaderMap::with_capacity(options.default_headers.len());
        for (name, value) in &options.default_headers {
            let header_name =
                HeaderName::try_from(name.as_str()).map_err(|_| HttpError::InvalidHeader {
                    name: name.clone(),
                    value: value.clone(),
                })?;
            let header_value =
                HeaderValue::try_from(value.as_str()).map_err(|_| HttpError::InvalidHeader {
                    name: name.clone(),
                    value: value.clone(),
                })?;
            default_headers.insert(header_name, header_value);
        }
        let client = reqwest::Client::builder()
            .timeout(options.timeout)
            .tcp_nodelay(true)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .map_err(HttpError::Build)?;
        Ok(Self {
            client,
            retries: options.retries,
            default_headers,
        })
    }

    /// Sends a GET request and decodes its JSON response.
    ///
    /// # Errors
    ///
    /// Returns request, response-status, or JSON-decoding failures after the
    /// configured retries are exhausted.
    pub async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T, HttpError> {
        self.request_json::<(), T>(Method::GET, url, None).await
    }

    /// Sends a JSON POST request and decodes its JSON response.
    ///
    /// # Errors
    ///
    /// Returns request, response-status, or JSON-decoding failures after the
    /// configured retries are exhausted.
    pub async fn post_json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        url: &str,
        body: &B,
    ) -> Result<T, HttpError> {
        self.request_json(Method::POST, url, Some(body)).await
    }

    /// Sends a JSON DELETE request and decodes its JSON response.
    ///
    /// # Errors
    ///
    /// Returns request, response-status, or JSON-decoding failures after the
    /// configured retries are exhausted.
    pub async fn delete_json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        url: &str,
        body: &B,
    ) -> Result<T, HttpError> {
        self.request_json(Method::DELETE, url, Some(body)).await
    }

    async fn request_json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        method: Method,
        url: &str,
        body: Option<&B>,
    ) -> Result<T, HttpError> {
        let mut attempt = 0_u32;
        loop {
            let mut request = self
                .client
                .request(method.clone(), url)
                .headers(self.default_headers.clone());
            if let Some(body) = body {
                request = request.json(body);
            }
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    let headers = response.headers().clone();
                    let text = response
                        .text()
                        .await
                        .map_err(|source| HttpError::Transport {
                            url: url.to_owned(),
                            source,
                        })?;
                    if status.is_success() {
                        return serde_json::from_str(&text).map_err(|source| {
                            HttpError::InvalidJson {
                                url: url.to_owned(),
                                source,
                            }
                        });
                    }
                    let error = response_error(status, url, text, &headers);
                    if !is_retryable_status(status) || attempt == self.retries {
                        return Err(error);
                    }
                    let delay = retry_delay(&error, attempt);
                    tokio::time::sleep(delay).await;
                }
                Err(source) => {
                    let error = HttpError::Transport {
                        url: url.to_owned(),
                        source,
                    };
                    if attempt == self.retries {
                        return Err(error);
                    }
                    tokio::time::sleep(exponential_delay(attempt)).await;
                }
            }
            attempt = attempt.saturating_add(1);
        }
    }
}

fn response_error(status: StatusCode, url: &str, body: String, headers: &HeaderMap) -> HttpError {
    let now_ms = unix_timestamp_ms();
    HttpError::Response {
        status,
        url: url.to_owned(),
        body,
        rate_limit_reset_ms: parse_rate_limit_reset_timestamp_ms(headers),
        retry_delay_ms: parse_rate_limit_delay_ms(headers, now_ms),
    }
}

#[must_use]
pub fn parse_rate_limit_reset_timestamp_ms(headers: &HeaderMap) -> Option<u64> {
    let reset = headers.get("x-ratelimit-reset")?.to_str().ok()?;
    decimal_seconds_to_millis(reset)
}

#[must_use]
pub fn parse_rate_limit_delay_ms(headers: &HeaderMap, now_ms: u64) -> Option<u64> {
    if let Some(reset) = parse_rate_limit_reset_timestamp_ms(headers) {
        return Some(reset.saturating_sub(now_ms));
    }
    let value = headers.get("retry-after")?.to_str().ok()?;
    // The live APIs currently return delta seconds. HTTP-date handling stays
    // fail-closed to the exponential retry when an unrecognized date arrives.
    decimal_seconds_to_millis(value)
}

fn decimal_seconds_to_millis(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return None;
    }
    let (whole, fraction) = trimmed.split_once('.').unwrap_or((trimmed, ""));
    if !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let whole_ms = whole.parse::<u64>().ok()?.checked_mul(1_000)?;
    let mut fraction_ms = 0_u64;
    for (index, byte) in fraction.bytes().take(3).enumerate() {
        let digit = u64::from(byte - b'0');
        fraction_ms += digit * [100, 10, 1][index];
    }
    whole_ms.checked_add(fraction_ms)
}

const fn is_retryable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 425 | 429 | 500..=599)
}

fn retry_delay(error: &HttpError, attempt: u32) -> Duration {
    if error.status() == Some(StatusCode::TOO_MANY_REQUESTS)
        && let Some(delay) = error.retry_delay_ms()
    {
        return Duration::from_millis(delay.saturating_add(50).min(60_000));
    }
    exponential_delay(attempt)
}

fn exponential_delay(attempt: u32) -> Duration {
    Duration::from_millis(200_u64.saturating_mul(1_u64.checked_shl(attempt).unwrap_or(u64::MAX)))
}

fn unix_timestamp_ms() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rate_limit_reset_and_retry_after_without_floats() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-ratelimit-reset",
            HeaderValue::from_static("1787510000.125"),
        );
        assert_eq!(
            parse_rate_limit_reset_timestamp_ms(&headers),
            Some(1_787_510_000_125)
        );
        assert_eq!(
            parse_rate_limit_delay_ms(&headers, 1_787_510_000_000),
            Some(125)
        );

        headers.remove("x-ratelimit-reset");
        headers.insert("retry-after", HeaderValue::from_static("2.5"));
        assert_eq!(parse_rate_limit_delay_ms(&headers, 0), Some(2_500));
    }

    #[test]
    fn rejects_invalid_delay_values() {
        for value in ["", "-1", "NaN", "1.2.3"] {
            assert_eq!(decimal_seconds_to_millis(value), None);
        }
    }
}
