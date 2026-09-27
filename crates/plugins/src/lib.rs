//! Package and instance ownership. Does not start a scientific runtime when read.
#![forbid(unsafe_code)]

mod package;
mod repository;
mod backend;
mod runtime;
mod instance_records;
mod operations;
mod resources;
pub use resources::*;
#[cfg(unix)]
mod resource_channel;
mod views;
mod view_close;
mod window_layout;
mod scenarios;
pub use scenarios::scenario_digest;
mod drafts;
mod draft_service;
pub use views::PluginViewAsset;
mod service;
mod service_handlers;
pub use service::*;
pub use package::*;
pub use repository::*;
pub use runtime::*;
pub use operations::*;

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
    #[error("plugin instance is unavailable: {0}")]
    Unavailable(String),
    #[error(transparent)]
    Transport(#[from] rho_plugin_sdk::SdkError),
    #[error("plugin response violates its contract: {message}")]
    InvalidResponse { message: String, response: Box<rho_plugin_protocol::RpcBody> },
}

pub(crate) fn ensure(condition: bool, message: impl Into<String>) -> Result<(), PluginError> {
    if condition {
        Ok(())
    } else {
        Err(PluginError::Invalid(message.into()))
    }
}
