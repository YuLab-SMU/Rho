//! Package and instance ownership. Does not start a scientific runtime when read.
#![forbid(unsafe_code)]

mod archive_service;
mod archives;
mod backend;
mod build;
mod build_service;
mod development;
mod instance_records;
mod instance_recovery;
mod operations;
mod package;
mod repository;
mod resources;
mod runtime;
mod test_projects;
pub use resources::*;
mod preview;
#[cfg(unix)]
mod resource_channel;
mod scenario_application;
mod scenarios;
mod view_close;
mod view_renderer;
mod views;
mod window_layout;
pub use scenarios::scenario_digest;
mod draft_service;
mod drafts;
pub use views::PluginViewAsset;
mod delegated;
mod service;
mod service_handlers;
pub use operations::*;
pub use package::*;
pub use repository::*;
pub use runtime::*;
pub use service::*;

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
    InvalidResponse {
        message: String,
        response: Box<rho_plugin_protocol::RpcBody>,
    },
}

pub(crate) fn ensure(condition: bool, message: impl Into<String>) -> Result<(), PluginError> {
    if condition {
        Ok(())
    } else {
        Err(PluginError::Invalid(message.into()))
    }
}
