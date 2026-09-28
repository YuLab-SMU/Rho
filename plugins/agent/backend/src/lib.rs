#![forbid(unsafe_code)]
//! Ordinary Agent process composition. Metadata uses the same public task owner
//! and Agent store; the transport holds no scientific database or global UI state.
pub mod arguments;
pub mod manifest;
mod metadata;
pub mod server;

mod diagnostics;
