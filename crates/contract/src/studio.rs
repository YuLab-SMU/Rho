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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RSelection {
    pub executable: String,
    pub ark: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RProbe {
    pub selection: RSelection,
    pub r_home: Option<String>,
    pub version: Option<String>,
    pub architecture: Option<String>,
    pub jsonlite: bool,
    pub rlang: bool,
    pub ark_available: bool,
    pub usable: bool,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RConfiguration {
    pub source: String,
    pub current: Option<RProbe>,
    pub candidates: Vec<RSelection>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplyRConfiguration {
    pub selection: RSelection,
    pub end_session: bool,
}
