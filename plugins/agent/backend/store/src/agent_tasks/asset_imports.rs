use super::*;
use rho_agent_owner::MAX_PROJECT_ASSET_IMPORT_BYTES;

pub(super) fn read(
    store: &AgentStore,
    scope: &AgentTaskScope,
    request: &str,
) -> Result<Option<StoredAgentAssetImport>, AgentTaskError> {
    let c = store.0.lock().map_err(error)?;
    let value: Option<String> = c.query_row("SELECT value FROM agent_asset_imports WHERE project=?1 AND principal=?2 AND request_id=?3", params![scope.project,scope.principal,request], |r|r.get(0)).optional().map_err(error)?;
    let Some(value) = value else {
        return Ok(None);
    };
    let capture: StoredAgentAssetImport = serde_json::from_str(&value).map_err(error)?;
    let receipt: String = c.query_row("SELECT value FROM agent_task_receipts WHERE project=?1 AND principal=?2 AND request_id=?3", params![scope.project,scope.principal,request],|r|r.get(0)).map_err(error)?;
    capture.validate(scope, &serde_json::from_str(&receipt).map_err(error)?)?;
    Ok(Some(capture))
}

pub(super) fn retain(
    tx: &rusqlite::Transaction<'_>,
    scope: &AgentTaskScope,
    receipt: &AgentCommandReceipt,
    capture: Option<&StoredAgentAssetImport>,
) -> Result<(), AgentTaskError> {
    let value: Option<String> = tx.query_row("SELECT value FROM agent_asset_imports WHERE project=?1 AND principal=?2 AND request_id=?3", params![scope.project,scope.principal,receipt.request_id],|r|r.get(0)).optional().map_err(error)?;
    if let Some(value) = value {
        let original: StoredAgentAssetImport = serde_json::from_str(&value).map_err(error)?;
        original.validate(scope, receipt)?;
        if capture.is_some_and(|capture| capture != &original) {
            return Err(AgentTaskError::RequestConflict);
        }
    } else if let Some(capture) = capture {
        capture.validate(scope, receipt)?;
        let reused: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_task_receipts WHERE project=?1 AND principal=?2 AND request_id=?3)", params![scope.project,scope.principal,receipt.request_id],|r|r.get(0)).map_err(error)?;
        if reused {
            return Err(AgentTaskError::RequestConflict);
        }
        let value = serde_json::to_string(capture).map_err(error)?;
        let used: usize = tx.query_row("SELECT COALESCE(SUM(bytes),0) FROM agent_asset_imports WHERE project=?1 AND principal=?2",params![scope.project,scope.principal],|r|r.get(0)).map_err(error)?;
        if used.saturating_add(value.len()) > MAX_PROJECT_ASSET_IMPORT_BYTES {
            return Err(AgentTaskError::Budget(
                "Original attachment import storage is full".into(),
            ));
        }
        tx.execute("INSERT INTO agent_asset_imports(project,principal,request_id,bytes,value) VALUES(?1,?2,?3,?4,?5)",params![scope.project,scope.principal,receipt.request_id,value.len(),value]).map_err(error)?;
    }
    Ok(())
}
