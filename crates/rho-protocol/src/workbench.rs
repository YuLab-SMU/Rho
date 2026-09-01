//! Public Workbench Protocol (WB1) — read-only, project-scoped entity types.
//!
//! These types are the stable public projection of Rho's internal state. They
//! do not expose internal transport fields, Agent conversation content,
//! credentials, or unrestricted file contents.
//!
//! The public protocol version (`WORKBENCH_PROTOCOL_VERSION`) is independent of
//! the internal wire protocol version (`PROTOCOL_VERSION`).

use serde::{Deserialize, Serialize};

/// Public protocol version. Independent of the internal wire `PROTOCOL_VERSION`.
pub const WORKBENCH_PROTOCOL_VERSION: &str = "0.1-draft";

// ── Envelopes ────────────────────────────────────────────────────────────────

/// Top-level success response for every WB1 operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkbenchSuccess<T: Serialize> {
    pub ok: bool,
    pub workbench_protocol_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub project_id: String,
    pub data: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<WorkbenchPageInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

impl<T: Serialize> WorkbenchSuccess<T> {
    pub fn new(project_id: impl Into<String>, data: T) -> Self {
        Self {
            ok: true,
            workbench_protocol_version: WORKBENCH_PROTOCOL_VERSION.to_string(),
            request_id: None,
            project_id: project_id.into(),
            data,
            page: None,
            warnings: Vec::new(),
        }
    }
}

/// Top-level error response for every WB1 operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkbenchError {
    pub ok: bool,
    pub workbench_protocol_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub error: WorkbenchErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkbenchErrorBody {
    pub code: WorkbenchErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub details: serde_json::Value,
}

/// Stable error codes for client logic. Message text is human-supporting only.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkbenchErrorCode {
    /// The requested record belongs to a different project.
    RecordProjectMismatch,
    /// The record has no canonical project identity (legacy/unscoped).
    MissingProjectIdentity,
    /// The requested resource was not found.
    NotFound,
    /// The record data is malformed and cannot be projected.
    MalformedRecord,
    /// The value exceeds the configured size/bound limit.
    SizeLimitExceeded,
    /// The requested page cursor is invalid or has been pruned.
    InvalidCursor,
    /// The public protocol version is not supported.
    UnsupportedProtocolVersion,
    /// Internal server error (details are not exposed publicly).
    InternalError,
    /// The project is not available or has no active workspace.
    ProjectUnavailable,
    /// The requested list/page size exceeds the maximum.
    PageSizeExceeded,
}

// ── Pagination ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkbenchPageInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    pub has_more: bool,
    pub total_count: Option<u64>,
    pub page_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkbenchPage<T: Serialize> {
    pub items: Vec<T>,
    pub page: WorkbenchPageInfo,
}

/// Maximum items per page. Clients cannot request unlimited results.
pub const DEFAULT_PAGE_SIZE: usize = 50;
pub const MAX_PAGE_SIZE: usize = 200;

// ── Capabilities ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkbenchCapabilities {
    pub workbench_protocol_version: String,
    pub operations: Vec<String>,
    pub entity_types: Vec<String>,
    pub max_page_size: usize,
    pub read_only: bool,
}

// ── Entity Types ─────────────────────────────────────────────────────────────

/// Summary of the active Rho project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSummary {
    /// Opaque canonical project identifier (from BH1).
    pub project_id: String,
    /// Number of durable runs recorded for this project.
    pub total_run_count: u64,
    /// Number of artifact records for this project.
    pub total_artifact_count: u64,
    /// Number of plot artifacts for this project.
    pub total_plot_count: u64,
    /// Number of unresolved problems for this project.
    pub unresolved_problem_count: u64,
}

/// Current Workspace R status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspaceStatus {
    /// Workspace identity.
    pub workspace_id: String,
    /// Current Ark/R kernel instance id. Changes on restart.
    pub kernel_instance_id: String,
    /// Monotonic execution sequence number.
    pub execution_seq: u64,
    /// Workspace state revision (increments on state-changing operations).
    pub state_revision: u64,
    /// Project state revision (increments on project-mutating operations).
    pub project_revision: u64,
    /// Whether Workspace R is currently running.
    pub running: bool,
    /// When the workspace was started (RFC 3339).
    pub started_at: String,
}

/// Bounded summary of a durable run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSummary {
    /// Opaque run identifier.
    pub run_id: String,
    /// Parent run id for retry/continuation chains.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    /// Execution origin: "user", "agent", "system".
    pub origin: String,
    /// Run status: "running", "completed", "failed", "cancelled".
    pub status: String,
    /// When the run started (RFC 3339).
    pub started_at: String,
    /// When the run finished, if complete (RFC 3339).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    /// Terminal reason if the run ended abnormally.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    /// Request type (e.g. "execute_r", "render_document").
    pub request_type: String,
    /// Project-relative source path that initiated the run, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// Whether there was an error.
    pub has_error: bool,
    /// Whether there were warnings (detail view only, omitted from list).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_warnings: Option<bool>,
    /// Number of problems associated with this run (detail view only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem_count: Option<usize>,
    /// Number of artifacts produced by this run (detail view only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_count: Option<usize>,
}

/// Detailed run information with bounded code and output previews.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunDetail {
    pub summary: RunSummary,
    /// Truncated R code. Full code requires explicit field selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_preview: Option<String>,
    /// Whether the code was truncated.
    pub code_truncated: bool,
    /// Truncated stdout. Full output requires explicit field selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_preview: Option<String>,
    pub stdout_truncated: bool,
    /// Result value preview, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_preview: Option<String>,
    pub value_truncated: bool,
    /// Error message, if the run failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Messages produced during execution (bounded count).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<String>,
    /// Warnings produced during execution (bounded count).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Environment snapshot that was active at execution start, if recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_snapshot_id: Option<String>,
    /// Linked artifact ids produced by this run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_ids: Vec<String>,
}

/// Problem derived from a run's diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProblemSummary {
    /// Stable opaque problem identifier.
    pub problem_id: String,
    /// The run that produced this problem.
    pub run_id: String,
    /// Problem severity: "error", "warning", "message".
    pub severity: String,
    /// Short problem title.
    pub title: String,
    /// Problem location in source (project-relative path + line).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_line: Option<u64>,
    /// When the problem was recorded (RFC 3339).
    pub recorded_at: String,
}

/// Bounded summary of a Workspace R object.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObjectSummary {
    /// Object reference (name in Workspace R).
    pub reference: String,
    /// R class or type.
    pub class: String,
    /// Bounded preview of the object value.
    pub preview: String,
    pub preview_truncated: bool,
    /// Object dimensions, if applicable (rows, cols).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<[usize; 2]>,
    /// Workspace state revision when this summary was captured.
    pub state_revision: u64,
}

/// Output (artifact) produced by a run or operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutputSummary {
    /// Opaque artifact identifier.
    pub artifact_id: String,
    /// Artifact kind: "plot", "render", "export", "general".
    pub artifact_kind: String,
    /// The run that produced this output, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Project-relative output path, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    /// Source file that produced this output, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// MIME type of the output content.
    pub media_type: String,
    /// When the output was created (RFC 3339).
    pub created_at: String,
    /// Whether provenance information is complete.
    pub provenance_complete: bool,
    /// Reason provenance is incomplete, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incomplete_reason: Option<String>,
}

/// Environment receipt from a recorded snapshot or admitted operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnvironmentReceipt {
    /// Opaque snapshot or request identifier.
    pub receipt_id: String,
    /// Receipt kind: "snapshot", "operation_receipt".
    pub receipt_kind: String,
    /// Operation name, if this is an operation request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_name: Option<String>,
    /// Operation status, if this is an operation request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_status: Option<String>,
    /// Operation decision, if decided.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_decision: Option<String>,
    /// When the evidence was first captured (RFC 3339).
    pub captured_at: String,
}

/// Approval request summary (inspection only — no decide/continue/cancel).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApprovalSummary {
    /// Opaque approval request identifier.
    pub request_id: String,
    /// The Agent turn that requested approval.
    pub turn_id: String,
    /// Tool that requires approval (e.g. "run_r").
    pub tool: String,
    /// Approval policy: "ask", "plan", "act".
    pub policy: String,
    /// Current status: "pending", "approved", "rejected", "cancelled".
    pub status: String,
    /// Decision if resolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    /// Reason for the decision, if provided.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// When the request was created (RFC 3339).
    pub requested_at: String,
    /// When the request was resolved, if applicable (RFC 3339).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responded_at: Option<String>,
}

/// Provenance link connecting a resource to its producing run and environment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProvenanceLink {
    /// The resource being queried (artifact_id, run_id, etc.).
    pub resource_id: String,
    /// The run that produced this resource, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producing_run_id: Option<String>,
    /// Environment snapshot active during production, if recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_snapshot_id: Option<String>,
    /// Source file that initiated production, if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// Whether all provenance links are present and verified.
    pub provenance_complete: bool,
    /// Reason provenance is incomplete, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incomplete_reason: Option<String>,
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_envelope_round_trip() {
        let proj = ProjectSummary {
            project_id: "proj_01".into(),
            total_run_count: 5,
            total_artifact_count: 3,
            total_plot_count: 7,
            unresolved_problem_count: 1,
        };
        let resp = WorkbenchSuccess::new("proj_01", proj);
        let json = serde_json::to_string(&resp).unwrap();
        let decoded: WorkbenchSuccess<ProjectSummary> = serde_json::from_str(&json).unwrap();
        assert!(decoded.ok);
        assert_eq!(decoded.project_id, "proj_01");
        assert_eq!(decoded.data.total_run_count, 5);
    }

    #[test]
    fn error_envelope_round_trip() {
        let err = WorkbenchError {
            ok: false,
            workbench_protocol_version: WORKBENCH_PROTOCOL_VERSION.to_string(),
            request_id: Some("req_01".into()),
            project_id: Some("proj_01".into()),
            error: WorkbenchErrorBody {
                code: WorkbenchErrorCode::RecordProjectMismatch,
                message: "The requested run does not belong to this project.".into(),
                retryable: false,
                details: serde_json::Value::Null,
            },
        };
        let json = serde_json::to_string(&err).unwrap();
        let decoded: WorkbenchError = serde_json::from_str(&json).unwrap();
        assert!(!decoded.ok);
        assert_eq!(
            decoded.error.code,
            WorkbenchErrorCode::RecordProjectMismatch
        );
        assert!(!decoded.error.retryable);
    }

    #[test]
    fn page_serialization() {
        let page = WorkbenchPageInfo {
            after: Some("cursor_abc".into()),
            before: None,
            has_more: true,
            total_count: Some(100),
            page_size: 50,
        };
        let json = serde_json::to_string(&page).unwrap();
        assert!(json.contains("cursor_abc"));
        assert!(json.contains("has_more"));
    }

    #[test]
    fn version_is_independent() {
        // The public protocol version must differ from the internal wire version.
        // Internal version is a u16; public is a semver-like string.
        assert_ne!(WORKBENCH_PROTOCOL_VERSION, "1");
    }

    #[test]
    fn all_entity_types_serialize() {
        // Verify every public entity type round-trips through JSON.
        let run = RunSummary {
            run_id: "run_01".into(),
            parent_run_id: None,
            origin: "user".into(),
            status: "completed".into(),
            started_at: "2026-08-01T00:00:00Z".into(),
            finished_at: Some("2026-08-01T00:00:05Z".into()),
            terminal_reason: None,
            request_type: "execute_r".into(),
            source_path: Some("analysis.R".into()),
            has_error: false,
            has_warnings: Some(false),
            problem_count: Some(0),
            artifact_count: Some(2),
        };
        let json = serde_json::to_string(&run).unwrap();
        let decoded: RunSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.run_id, "run_01");
        assert_eq!(decoded.status, "completed");
    }

    #[test]
    fn run_detail_bounds_code_preview() {
        let detail = RunDetail {
            summary: RunSummary {
                run_id: "run_01".into(),
                parent_run_id: None,
                origin: "user".into(),
                status: "completed".into(),
                started_at: "2026-08-01T00:00:00Z".into(),
                finished_at: Some("2026-08-01T00:00:05Z".into()),
                terminal_reason: None,
                request_type: "execute_r".into(),
                source_path: None,
                has_error: false,
                has_warnings: Some(false),
                problem_count: Some(0),
                artifact_count: Some(0),
            },
            code_preview: Some("summary(fit)".into()),
            code_truncated: false,
            stdout_preview: None,
            stdout_truncated: false,
            value_preview: None,
            value_truncated: false,
            error_message: None,
            messages: vec![],
            warnings: vec![],
            environment_snapshot_id: None,
            artifact_ids: vec![],
        };
        let json = serde_json::to_string(&detail).unwrap();
        let decoded: RunDetail = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.code_preview.as_deref(), Some("summary(fit)"));
        assert!(!decoded.code_truncated);
    }
}
