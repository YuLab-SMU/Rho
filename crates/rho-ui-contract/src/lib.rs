//! Pure, implementation-library-independent contracts for the Rho Surface Runtime.
//!
//! This crate owns bounded serializable shapes and pure state transitions only.
//! It intentionally has no Tauri, DOM, Store, filesystem, process, network,
//! Workspace R, Agent, credential, or plugin-execution authority.

#![forbid(unsafe_code)]

pub mod agent_ux;
pub mod check;
pub mod command;
pub mod context;
pub mod fixture;
pub mod jobs;
pub mod layout;
pub mod profile;
pub mod provider_capabilities;
pub mod resource;
pub mod runtime;
pub mod snapshot;
pub mod surface;
pub mod validation;
pub mod vibe;
pub mod workbench;
pub mod workbench_vnext;

pub use agent_ux::*;
pub use check::*;
pub use command::*;
pub use context::*;
pub use fixture::*;
pub use jobs::*;
pub use layout::*;
pub use profile::*;
pub use provider_capabilities::*;
pub use resource::*;
pub use runtime::*;
pub use snapshot::*;
pub use surface::*;
pub use validation::*;
pub use vibe::*;
pub use workbench::*;
pub use workbench_vnext::*;

pub const RSR_CONTRACT_MAJOR: u16 = 1;
