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
