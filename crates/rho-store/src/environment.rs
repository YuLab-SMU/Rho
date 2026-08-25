use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentSnapshotDraft {
    pub snapshot_id: String,
    pub project_root: String,
    pub canonical_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentSnapshotRecord {
    pub snapshot_id: String,
    pub project_root: String,
    pub canonical_json: String,
    pub first_captured_at: String,
    pub last_captured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentOperationRequestDraft {
    pub request_id: String,
    pub turn_id: Option<String>,
    pub source: String,
    pub request_name: String,
    pub project_root: String,
    pub arguments_json: String,
    pub preview_json: String,
    pub preview_sha256: String,
    pub workspace_id: String,
    pub state_revision: i64,
    pub project_revision: i64,
    pub before_snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentOperationDecisionRecord {
    pub decision: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentOperationFinish {
    pub request_id: String,
    pub status: String,
    pub run_id: Option<String>,
    pub terminal_outcome: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EnvironmentOperationRequestSummary {
    pub request_id: String,
    pub turn_id: Option<String>,
    pub source: String,
    pub request_name: String,
    pub status: String,
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub project_root: String,
    pub arguments_json: String,
    pub preview_json: String,
    pub preview_sha256: String,
    pub workspace_id: Option<String>,
    #[specta(type = Option<i32>)]
    pub state_revision: Option<i64>,
    #[specta(type = Option<i32>)]
    pub project_revision: Option<i64>,
    pub before_snapshot_id: Option<String>,
    pub run_id: Option<String>,
    pub requested_at: String,
    pub responded_at: Option<String>,
    pub completed_at: Option<String>,
    pub terminal_outcome: Option<String>,
}

pub(crate) fn decode_environment_operation_request(
    row: &Row<'_>,
) -> rusqlite::Result<EnvironmentOperationRequestSummary> {
    Ok(EnvironmentOperationRequestSummary {
        request_id: row.get(0)?,
        turn_id: row.get(1)?,
        source: row.get(2)?,
        request_name: row.get(3)?,
        status: row.get(4)?,
        decision: row.get(5)?,
        reason: row.get(6)?,
        project_root: row.get(7)?,
        arguments_json: row.get(8)?,
        preview_json: row.get(9)?,
        preview_sha256: row.get(10)?,
        workspace_id: row.get(11)?,
        state_revision: row.get(12)?,
        project_revision: row.get(13)?,
        before_snapshot_id: row.get(14)?,
        run_id: row.get(15)?,
        requested_at: row.get(16)?,
        responded_at: row.get(17)?,
        completed_at: row.get(18)?,
        terminal_outcome: row.get(19)?,
    })
}
