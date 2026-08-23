//! Allocation-light, exact fixed-point domain logic for Jupol.
//!
//! Financial values use signed 128-bit micro-units. Public calculations are
//! checked so malformed venue data fails closed instead of wrapping in release
//! builds.

#![allow(clippy::missing_errors_doc)]

pub mod fixed;
pub mod short_window;
pub mod strategy;
pub mod types;

pub type Micro = i128;
