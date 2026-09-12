#![forbid(unsafe_code)]
//! Optional component assistant engine boundary. Scientific owners never depend on Rig.
//! Rig drives inference and tools; Application and Host retain admission and facts.
mod runner;
pub use runner::RigComponentEngine;
