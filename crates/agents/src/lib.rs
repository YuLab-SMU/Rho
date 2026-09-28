#![forbid(unsafe_code)]
//! Transitional adapters from existing task owners to the public Agent engine.
//! Model behavior and provider code live in the Agent package.
mod bridge;
mod permissions;
pub use permissions::{action_permission, task_intent_spec};
pub use bridge::RigComponentEngine;
