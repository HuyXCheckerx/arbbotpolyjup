use std::fmt;

use crate::Micro;

pub const USD_DECIMALS: u32 = 6;
pub const CONTRACT_DECIMALS: u32 = 6;
pub const ONE_USD_MICRO: Micro = 1_000_000;
pub const ONE_CONTRACT_MICRO: Micro = 1_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rounding {
    Reject,
    Down,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FixedError {
    Empty,
    Invalid(String),
    TooManyDecimalPlaces { value: String, decimals: u32 },
    Overflow,
}

impl fmt::Display for FixedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("Fixed-point value is empty"),
            Self::Invalid(value) => write!(formatter, "Invalid fixed-point value: {value}"),
            Self::TooManyDecimalPlaces { value, decimals } => {
                write!(
                    formatter,
                    "Too many decimal places for {value}; maximum is {decimals}"
                )
            }
            Self::Overflow => formatter.write_str("Fixed-point value exceeds i128 range"),
        }
    }
}

impl std::error::Error for FixedError {}

pub fn parse_usd(value: &str) -> Result<Micro, FixedError> {
    parse_fixed(value, USD_DECIMALS, Rounding::Reject)
}

pub fn parse_contracts(value: &str) -> Result<Micro, FixedError> {
    parse_fixed(value, CONTRACT_DECIMALS, Rounding::Down)
}

#[must_use]
pub fn format_usd(value: Micro) -> String {
    format_fixed(value, USD_DECIMALS)
}

#[must_use]
pub fn format_contracts(value: Micro) -> String {
    format_fixed(value, CONTRACT_DECIMALS)
}

pub fn parse_fixed(value: &str, decimals: u32, rounding: Rounding) -> Result<Micro, FixedError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(FixedError::Empty);
    }

    let (negative, unsigned) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        _ => (false, trimmed),
    };
    if unsigned.is_empty() {
        return Err(FixedError::Invalid(trimmed.to_owned()));
    }

    let mut parts = unsigned.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || whole.is_empty()
        || (unsigned.contains('.') && fraction.is_empty())
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(FixedError::Invalid(trimmed.to_owned()));
    }

    let kept_len = usize::try_from(decimals).map_err(|_| FixedError::Overflow)?;
    if fraction.len() > kept_len
        && rounding == Rounding::Reject
        && fraction.as_bytes()[kept_len..]
            .iter()
            .any(|byte| *byte != b'0')
    {
        return Err(FixedError::TooManyDecimalPlaces {
            value: trimmed.to_owned(),
            decimals,
        });
    }

    let scale = 10_i128.checked_pow(decimals).ok_or(FixedError::Overflow)?;
    let whole_value = whole.parse::<Micro>().map_err(|_| FixedError::Overflow)?;
    let kept = &fraction[..fraction.len().min(kept_len)];
    let mut fractional_value = if kept.is_empty() {
        0
    } else {
        kept.parse::<Micro>().map_err(|_| FixedError::Overflow)?
    };
    for _ in kept.len()..kept_len {
        fractional_value = fractional_value
            .checked_mul(10)
            .ok_or(FixedError::Overflow)?;
    }
    let magnitude = whole_value
        .checked_mul(scale)
        .and_then(|whole_scaled| whole_scaled.checked_add(fractional_value))
        .ok_or(FixedError::Overflow)?;
    if negative {
        magnitude.checked_neg().ok_or(FixedError::Overflow)
    } else {
        Ok(magnitude)
    }
}

#[must_use]
pub fn format_fixed(value: Micro, decimals: u32) -> String {
    let scale = 10_i128.pow(decimals);
    let negative = value.is_negative();
    let magnitude = value.unsigned_abs();
    let scale_unsigned = scale.unsigned_abs();
    let whole = magnitude / scale_unsigned;
    let fraction = magnitude % scale_unsigned;
    let sign = if negative { "-" } else { "" };
    if fraction == 0 {
        return format!("{sign}{whole}");
    }
    let width = usize::try_from(decimals).unwrap_or(0);
    let mut fraction_text = format!("{fraction:0width$}");
    while fraction_text.ends_with('0') {
        fraction_text.pop();
    }
    format!("{sign}{whole}.{fraction_text}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usd_parsing_is_exact() {
        assert_eq!(parse_usd("0.576"), Ok(576_000));
        assert_eq!(parse_usd("100000"), Ok(100_000_000_000));
        assert_eq!(format_usd(100_000_000_000), "100000");
    }

    #[test]
    fn contract_parsing_floors_sub_micro_dust() {
        assert_eq!(parse_contracts("5.1234569"), Ok(5_123_456));
        assert_eq!(format_contracts(5_123_456), "5.123456");
    }

    #[test]
    fn usd_parsing_rejects_hidden_precision() {
        assert!(matches!(
            parse_usd("0.1234567"),
            Err(FixedError::TooManyDecimalPlaces { .. })
        ));
    }

    #[test]
    fn parsing_rejects_malformed_and_overflowing_values() {
        for malformed in ["", ".1", "1.", "+1", "1.2.3", "NaN", "--1"] {
            assert!(parse_usd(malformed).is_err(), "accepted {malformed}");
        }
        assert!(parse_usd("999999999999999999999999999999999999999999").is_err());
    }
}
