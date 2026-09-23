//! Public, language-neutral plugin contracts. No scientific owner or Host dependency.
#![forbid(unsafe_code)]

mod identity;
mod manifest;
mod management;
pub use management::*;
mod runtime;
mod resources;
pub use resources::*;
mod scenario;
mod visual;

pub use identity::*;
pub use manifest::*;
pub use runtime::*;
pub use scenario::*;
pub use visual::*;

/// Breaking changes require a different protocol, never a source-based bypass.
pub const PLUGIN_PROTOCOL_VERSION: u32 = 1;
pub const MAX_CONTROL_BYTES: usize = 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_PACKAGE_FILES: usize = 8192;
pub const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_VISUAL_NODES: usize = 4096;

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
#[error("invalid plugin contract: {0}")]
pub struct ProtocolError(pub String);

pub(crate) fn require(condition: bool, message: impl Into<String>) -> Result<(), ProtocolError> {
    if condition {
        Ok(())
    } else {
        Err(ProtocolError(message.into()))
    }
}

pub(crate) fn bounded_text(text: &str, max: usize, field: &str) -> Result<(), ProtocolError> {
    require(
        !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control),
        format!("{field} must contain 1–{max} bytes without control characters"),
    )
}
