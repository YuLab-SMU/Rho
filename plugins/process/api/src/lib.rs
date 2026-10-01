//! Public bounded process reports.
#![forbid(unsafe_code)]
mod local;
mod plugin;
pub use local::*;
pub use plugin::*;
pub use rho_plugin_protocol::{OutputCapture, ProcessReport, ProcessTermination};
