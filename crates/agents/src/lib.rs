#![forbid(unsafe_code)]
//! Optional component assistant engine boundary. Scientific owners never depend on Rig.
//! Rig drives inference and tools; Application and Host retain admission and facts.
mod runner;
mod diagnostics;
mod permissions;
pub use permissions::{action_permission, task_intent_spec};
pub use runner::RigComponentEngine;
