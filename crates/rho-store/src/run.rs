use rusqlite::Row;
use serde::{Deserialize, Serialize};

use super::{decode_string_list, sqlite_function_error};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDraft {
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub project_root: String,
    pub origin: String,
    pub request_type: String,
    pub operation_class: String,
    pub code: String,
    pub arguments_json: String,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    pub document_version: Option<i64>,
    pub workspace_id: String,
    pub state_revision_before: i64,
    pub project_revision_before: i64,
    pub environment_snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunFinish {
    pub run_id: String,
    pub status: String,
    pub terminal_reason: Option<String>,
    pub workspace_id: Option<String>,
    pub state_revision_after: Option<i64>,
    pub project_revision_after: Option<i64>,
    pub stdout: Option<String>,
    pub value_text: Option<String>,
    pub messages: Vec<String>,
    pub warnings: Vec<String>,
    pub error_message: Option<String>,
    pub error_call: Option<String>,
    pub traceback: Vec<String>,
    pub environment_snapshot_id_after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RunSummary {
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub project_root: String,
    pub origin: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub terminal_reason: Option<String>,
    pub request_type: String,
    pub operation_class: String,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    #[specta(type = Option<i32>)]
    pub document_version: Option<i64>,
    pub workspace_id: Option<String>,
    #[specta(type = Option<i32>)]
    pub state_revision_before: Option<i64>,
    #[specta(type = Option<i32>)]
    pub project_revision_before: Option<i64>,
    #[specta(type = Option<i32>)]
    pub state_revision_after: Option<i64>,
    #[specta(type = Option<i32>)]
    pub project_revision_after: Option<i64>,
    pub environment_snapshot_id: Option<String>,
    pub environment_snapshot_id_after: Option<String>,
    pub code_preview: String,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunErrorRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub range_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProblemSummary {
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub project_root: String,
    pub origin: String,
    pub status: String,
    pub message: String,
    pub call: Option<String>,
    pub traceback: Vec<String>,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    #[specta(type = Option<i32>)]
    pub document_version: Option<i64>,
    #[specta(type = Option<i32>)]
    pub line_number: Option<u32>,
    #[specta(type = Option<i32>)]
    pub column_number: Option<u32>,
    #[specta(type = Option<i32>)]
    pub end_line_number: Option<u32>,
    #[specta(type = Option<i32>)]
    pub end_column_number: Option<u32>,
    pub range_kind: Option<String>,
    pub workspace_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDetail {
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub project_root: String,
    pub origin: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub terminal_reason: Option<String>,
    pub request_type: String,
    pub operation_class: String,
    pub code: String,
    pub arguments_json: String,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    pub document_version: Option<i64>,
    pub workspace_id: Option<String>,
    pub state_revision_before: Option<i64>,
    pub project_revision_before: Option<i64>,
    pub state_revision_after: Option<i64>,
    pub project_revision_after: Option<i64>,
    pub environment_snapshot_id: Option<String>,
    pub environment_snapshot_id_after: Option<String>,
    pub stdout: Option<String>,
    pub value_text: Option<String>,
    pub messages: Vec<String>,
    pub warnings: Vec<String>,
    pub error_message: Option<String>,
    pub error_call: Option<String>,
    pub traceback: Vec<String>,
}

pub(crate) fn decode_run_detail(row: &Row<'_>) -> rusqlite::Result<RunDetail> {
    let messages: String = row.get(24)?;
    let warnings: String = row.get(25)?;
    let traceback: String = row.get(28)?;
    Ok(RunDetail {
        run_id: row.get(0)?,
        parent_run_id: row.get(1)?,
        project_root: row.get(2)?,
        origin: row.get(3)?,
        status: row.get(4)?,
        started_at: row.get(5)?,
        finished_at: row.get(6)?,
        terminal_reason: row.get(7)?,
        request_type: row.get(8)?,
        operation_class: row.get(9)?,
        code: row.get(10)?,
        arguments_json: row.get(11)?,
        source_path: row.get(12)?,
        execution_mode: row.get(13)?,
        document_version: row.get(14)?,
        workspace_id: row.get(15)?,
        state_revision_before: row.get(16)?,
        project_revision_before: row.get(17)?,
        state_revision_after: row.get(18)?,
        project_revision_after: row.get(19)?,
        environment_snapshot_id: row.get(20)?,
        environment_snapshot_id_after: row.get(21)?,
        stdout: row.get(22)?,
        value_text: row.get(23)?,
        messages: decode_string_list(&messages).map_err(sqlite_function_error)?,
        warnings: decode_string_list(&warnings).map_err(sqlite_function_error)?,
        error_message: row.get(26)?,
        error_call: row.get(27)?,
        traceback: decode_string_list(&traceback).map_err(sqlite_function_error)?,
    })
}
