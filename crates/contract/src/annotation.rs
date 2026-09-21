//! Version-bound application notes. Source status is observed separately from note revisions.
use crate::{AgentContextSelection, ApplicationWindowRef, CallerIdentity, ComponentAgentSession};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const MAX_ANNOTATION_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_ANNOTATION_LABELS: usize = 8;
pub const MAX_ANNOTATION_MARKS: usize = 256;
pub const MAX_ANNOTATION_REVISION_BYTES: usize = 64 * 1024;
pub const MAX_ANNOTATION_EVIDENCE_BYTES: usize = 128 * 1024;
pub const MAX_ANNOTATION_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PROJECT_ANNOTATION_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ANNOTATION_PAGE: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationSourceOwner {
    Editor,
    Help,
    Console,
    File,
    Object,
    Package,
    Plot,
    HtmlViewer,
    Agent,
    Workspace,
}

/// The owner-issued content identity retained when an annotation is frozen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationSourceRef {
    pub owner: AnnotationSourceOwner,
    /// Owner-native lineage identity, independent of the observed version.
    pub source_id: String,
    /// Owner-native content version (hash, revision, observation or session identity).
    pub source_version: String,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationCharacterUnit {
    Utf8,
    Utf16,
    UnicodeScalar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum AnnotationAnchor {
    WholeItem,
    TextQuote {
        quote: String,
        start: u64,
        end: u64,
        unit: AnnotationCharacterUnit,
    },
    Structured {
        path: Vec<String>,
        row: Option<u64>,
        column: Option<String>,
        topic: Option<String>,
    },
    CapturedView {
        capture: AnnotationCaptureRef,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum AnnotationMark {
    Pen { points: Vec<NormalizedPoint> },
    Rectangle { x: f64, y: f64, width: f64, height: f64 },
    Arrow { from: NormalizedPoint, to: NormalizedPoint },
    Text { x: f64, y: f64, text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct NormalizedPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationStatus {
    Current,
    Historical,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationAvailability {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationRevisionRef {
    pub annotation_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationCaptureRef {
    pub capture_id: String,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
    pub byte_size: u64,
    /// True only when these are the owner's original static media bytes.
    pub original_media: bool,
}

/// Owner evidence frozen when selecting or drawing begins. It never changes afterwards.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AnnotationEvidence {
    pub evidence_id: String,
    pub source: AnnotationSourceRef,
    /// The exact owner-issued reference used to observe the source again.
    pub selection: AgentContextSelection,
    pub session: Option<ComponentAgentSession>,
    pub anchor: AnnotationAnchor,
    /// Only the selected bounded excerpt, never a backup of an entire object.
    pub fragment: Value,
    pub observed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AnnotationRevision {
    pub annotation: AnnotationRevisionRef,
    pub author: CallerIdentity,
    pub note: String,
    pub labels: Vec<String>,
    pub evidence_id: String,
    pub marks: Vec<AnnotationMark>,
    pub continued_from: Option<AnnotationRevisionRef>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub deleted: bool,
}

/// A list row carries the frozen source identity so history can group by version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AnnotationListItem {
    pub revision: AnnotationRevision,
    pub source: AnnotationSourceRef,
    pub anchor: AnnotationAnchor,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AnnotationPreview {
    pub revision: AnnotationRevision,
    pub evidence: AnnotationEvidence,
    pub status: AnnotationStatus,
    pub availability: AnnotationAvailability,
    /// The owner's current version when it could be observed; absent means unknown.
    pub current_version: Option<String>,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationsQuery {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub query: AnnotationQuery,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AnnotationQuery {
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
    /// Read plus the owner's current status; may observe the source.
    Preview {
        annotation: AnnotationRevisionRef,
        #[serde(default)]
        session: Option<ComponentAgentSession>,
    },
    Evidence {
        evidence_id: String,
    },
    CommandStatus {
        request_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AnnotationQueryResult {
    List {
        items: Vec<AnnotationListItem>,
        next_after: Option<String>,
    },
    Read {
        revision: AnnotationRevision,
        evidence: AnnotationEvidence,
    },
    Preview {
        preview: AnnotationPreview,
    },
    Evidence {
        evidence: AnnotationEvidence,
    },
    CommandStatus {
        receipt: Option<AnnotationCommandReceipt>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AnnotationsCommand {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub command: AnnotationCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AnnotationCommand {
    /// Freeze owner evidence when selecting/drawing begins, before Save.
    Freeze {
        selection: AgentContextSelection,
        #[serde(default)]
        session: Option<ComponentAgentSession>,
        anchor: AnnotationAnchor,
    },
    /// Store a captured view. The reply carries the capture reference for an anchor.
    Capture {
        mime_type: String,
        width: u32,
        height: u32,
        base64: String,
        original_media: bool,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AnnotationCommandOutcome {
    Evidence { evidence_id: String },
    Capture { capture: AnnotationCaptureRef },
    Annotation { annotation: AnnotationRevisionRef },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct AnnotationCommandReceipt {
    pub request_id: String,
    pub outcome: AnnotationCommandOutcome,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadAnnotationCapture {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub capture_id: String,
}
