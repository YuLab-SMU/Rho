use std::path::PathBuf;

use rho_protocol::AuthorityContractError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GraphError {
    #[error("LadybugDB error: {0}")]
    Ladybug(#[from] lbug::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("authority contract error: {0}")]
    Authority(#[from] AuthorityContractError),
    #[error("evidence graph validation error: {0}")]
    Validation(String),
    #[error("evidence graph admission rejected: {0}")]
    Admission(String),
    #[error("evidence graph record belongs to another project")]
    ProjectMismatch,
    #[error("evidence graph record was not found: {0}")]
    NotFound(String),
    #[error("evidence graph revision is stale: expected {expected}, actual {actual}")]
    StaleRevision { expected: u64, actual: u64 },
    #[error(
        "evidence graph authority cursor is stale: feed {feed_id}, expected {expected}, actual {actual}"
    )]
    StaleAuthorityCursor {
        feed_id: String,
        expected: u64,
        actual: u64,
    },
    #[error("evidence graph authority reference is not currently resolvable: {0}")]
    UnresolvedAuthorityRef(String),
    #[error("evidence graph is unavailable ({code}): {message}")]
    Unavailable { code: String, message: String },
    #[error("evidence graph {field} exceeds limit {limit}")]
    LimitExceeded { field: &'static str, limit: usize },
    #[error("evidence graph path is not contained in the project: {0}")]
    UnsafePath(PathBuf),
    #[error("evidence graph schema reset required: found {found:?}, required {required}")]
    SchemaResetRequired { found: Option<i64>, required: i64 },
    #[error("evidence graph project identity mismatch")]
    DatabaseProjectMismatch,
    #[error("evidence graph record state does not allow this operation: {0}")]
    InvalidState(String),
    #[error("evidence graph transaction invariant failed: {0}")]
    Invariant(String),
}
