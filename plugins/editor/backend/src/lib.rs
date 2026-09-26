//! Editor-owned context interpretation. Only public SDK/draft ports are used.
#![forbid(unsafe_code)]
pub mod context;
pub mod server;

#[cfg(test)]
mod tests;
