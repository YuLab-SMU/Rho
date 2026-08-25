use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlotArtifactDraft {
    pub plot_id: String,
    pub run_id: String,
    pub project_root: Option<String>,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    pub document_version: Option<i64>,
    pub workspace_id: Option<String>,
    pub state_revision: Option<i64>,
    pub project_revision: Option<i64>,
    pub media_type: String,
    pub payload_json: String,
    pub provenance_complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PlotArtifactSummary {
    pub plot_id: String,
    pub run_id: String,
    pub project_root: Option<String>,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    #[specta(type = Option<i32>)]
    pub document_version: Option<i64>,
    pub workspace_id: Option<String>,
    #[specta(type = Option<i32>)]
    pub state_revision: Option<i64>,
    #[specta(type = Option<i32>)]
    pub project_revision: Option<i64>,
    pub media_type: String,
    pub payload_json: String,
    pub provenance_complete: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRecordDraft {
    pub artifact_id: String,
    pub artifact_kind: String,
    pub run_id: Option<String>,
    pub project_root: String,
    pub output_path: String,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    pub document_version: Option<i64>,
    pub workspace_id: Option<String>,
    pub state_revision: Option<i64>,
    pub project_revision: Option<i64>,
    pub media_type: String,
    pub metadata_json: String,
    pub provenance_complete: bool,
    pub incomplete_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ArtifactRecordSummary {
    pub artifact_id: String,
    pub artifact_kind: String,
    pub run_id: Option<String>,
    pub project_root: String,
    pub output_path: String,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    #[specta(type = Option<i32>)]
    pub document_version: Option<i64>,
    pub workspace_id: Option<String>,
    #[specta(type = Option<i32>)]
    pub state_revision: Option<i64>,
    #[specta(type = Option<i32>)]
    pub project_revision: Option<i64>,
    pub media_type: String,
    pub metadata_json: String,
    pub provenance_complete: bool,
    pub incomplete_reason: Option<String>,
    pub created_at: String,
}

pub(crate) fn decode_artifact_record(row: &Row<'_>) -> rusqlite::Result<ArtifactRecordSummary> {
    Ok(ArtifactRecordSummary {
        artifact_id: row.get(0)?,
        artifact_kind: row.get(1)?,
        run_id: row.get(2)?,
        project_root: row.get(3)?,
        output_path: row.get(4)?,
        source_path: row.get(5)?,
        execution_mode: row.get(6)?,
        document_version: row.get(7)?,
        workspace_id: row.get(8)?,
        state_revision: row.get(9)?,
        project_revision: row.get(10)?,
        media_type: row.get(11)?,
        metadata_json: row.get(12)?,
        provenance_complete: row.get::<_, i64>(13)? != 0,
        incomplete_reason: row.get(14)?,
        created_at: row.get(15)?,
    })
}
