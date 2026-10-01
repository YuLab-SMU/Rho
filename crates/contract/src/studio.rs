use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Host preferences and drafts are separate from scientific Operations.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationState {
    pub key: String,
    pub version: Option<String>,
    pub value: serde_json::Value,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadApplicationState {
    pub project_root: Option<String>,
    pub key: String,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct WriteApplicationState {
    pub project_root: Option<String>,
    pub state: ApplicationState,
}
