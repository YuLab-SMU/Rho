//! Ordinary Files backend. Only public contracts, SDK and package-owned science.
#![forbid(unsafe_code)]
pub mod manifest;
pub mod owner;
pub mod server;

#[cfg(test)]
mod tests;
