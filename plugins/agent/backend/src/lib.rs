#![forbid(unsafe_code)]
//! Ordinary Agent process composition. Metadata uses the same public task owner
//! and Agent store; the transport holds no scientific database or global UI state.
pub mod arguments;
pub mod manifest;
mod metadata;
pub mod server;

mod diagnostics;
mod handoffs;
mod model_assets;
mod run_recovery;
mod runs;

pub mod native_arguments;
mod native_context;
mod context_images;
mod native_controller;
mod native_core_grants;
mod native_grants;
mod native_host_result;
mod native_host_selection;
mod native_result;
mod native_selection;
mod native_tasks;
mod native_tool_observation;
mod native_tools;
mod native_uploads;
mod tools;
