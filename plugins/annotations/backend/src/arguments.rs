use rho_annotation_api::*;
use rho_plugin_sdk::protocol::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WriteRequest {
    pub request_id: String,
    pub command: WriteCommand,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WriteCommand {
    Freeze {
        reference: ContextReference,
        inclusion: Value,
        anchor: TextAnchor,
    },
    Create {
        evidence_id: String,
        note: String,
        #[serde(default)]
        labels: Vec<String>,
        #[serde(default)]
        marks: Vec<AnnotationMark>,
        #[serde(default)]
        continued_from: Option<AnnotationRevisionRef>,
    },
    Update {
        expected: AnnotationRevisionRef,
        note: String,
        #[serde(default)]
        labels: Vec<String>,
        #[serde(default)]
        marks: Vec<AnnotationMark>,
    },
    Delete {
        expected: AnnotationRevisionRef,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReadRequest {
    List {
        #[serde(default)]
        source_id: Option<String>,
        #[serde(default)]
        after: Option<String>,
        limit: u32,
        #[serde(default)]
        include_deleted: bool,
    },
    Read {
        annotation: AnnotationRevisionRef,
    },
    Evidence {
        evidence_id: String,
    },
    Receipt {
        request_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

/// A component contributes a reference, never scientific or Agent authority.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AnnotationViewConfiguration {
    #[serde(default)]
    pub source_request: Option<AnnotationSourceRequest>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AnnotationSourceRequest {
    pub request_id: String,
    pub source: AnnotationComponentSource,
    pub return_view: ViewInstanceId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AnnotationComponentSource {
    pub reference: ContextReference,
    pub title: String,
    pub inclusion: Value,
    pub preview: CapabilityKey,
    #[serde(default)]
    pub anchor: Option<TextAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TextAnchor {
    WholeItem,
    Structured { path: Vec<String>, row: Option<u64>, column: Option<String>, topic: Option<String> },
    CapturedView {
        capture: AnnotationCaptureRef,
    },
    TextQuote {
        quote: String,
        start: u64,
        end: u64,
        unit: AnnotationCharacterUnit,
    },
}
impl From<TextAnchor> for AnnotationAnchor {
    fn from(value: TextAnchor) -> Self {
        match value {
            TextAnchor::WholeItem => Self::WholeItem,
            TextAnchor::Structured { path, row, column, topic } => Self::Structured { path, row, column, topic },
            TextAnchor::CapturedView { capture } => Self::CapturedView { capture },
            TextAnchor::TextQuote {
                quote,
                start,
                end,
                unit,
            } => Self::TextQuote {
                quote,
                start,
                end,
                unit,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CaptureImport {
    pub request_id: String,
    pub reference: ResourceReference,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CaptureRead {
    pub capture: AnnotationCaptureRef,
    pub offset: u64,
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CaptureChunk {
    pub capture: AnnotationCaptureRef,
    pub offset: u64,
    pub base64: String,
    pub next: Option<u64>,
}

/// Browser pixels are ephemeral input, never Operation arguments or scientific media.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CaptureUpload {
    pub request_id: String,
    pub reference: ContextReference,
    pub inclusion: Value,
    #[schemars(length(min = 1, max = 786432))]
    pub base64: String,
}
