//! Package and instance ownership. Does not start a scientific runtime when read.
#![forbid(unsafe_code)]

mod package;
mod repository;
pub use package::*;
pub use repository::*;

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error(transparent)]
    Contract(#[from] rho_plugin_protocol::ProtocolError),
    #[error("plugin package is invalid: {0}")]
    Invalid(String),
    #[error("plugin storage: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin metadata: {0}")]
    Json(#[from] serde_json::Error),
    #[error("plugin catalog: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("plugin revision is not installed: {0}")]
    Missing(String),
    #[error("plugin revision is still referenced: {0:?}")]
    Referenced(Vec<String>),
    #[error("plugin state changed; refresh before retrying")]
    Conflict,
}

pub(crate) fn ensure(condition: bool, message: impl Into<String>) -> Result<(), PluginError> {
    if condition {
        Ok(())
    } else {
        Err(PluginError::Invalid(message.into()))
    }
}
