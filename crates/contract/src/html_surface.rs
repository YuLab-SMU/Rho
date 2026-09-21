//! Interactive HTML outputs keep their producing run identity. A view token lets
//! an isolated frame fetch one retained artifact without the Studio bearer.
use crate::MediaReference;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HtmlSurfaceType {
    StaticHtml,
    HtmlWidget,
    Shiny,
    Help,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HtmlSurfaceState {
    Live,
    Saved,
    Disconnected,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HtmlSurfaceRef {
    pub surface_id: String,
    pub surface_type: HtmlSurfaceType,
    pub state: HtmlSurfaceState,
    /// The retained artifact produced by the original run.
    pub reference: MediaReference,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct HtmlViewTokenRequest {
    pub project_root: String,
    pub reference: MediaReference,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct HtmlViewToken {
    pub surface: HtmlSurfaceRef,
    /// Relative Workbench path that serves the isolated document.
    pub path: String,
    pub expires_at_ms: u64,
}
