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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TextAnchor {
    WholeItem,
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
