use crate::AgentStore;
use rho_agent_api::*;
use rho_agent_owner::*;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

fn error(e: impl ToString) -> AgentTaskError {
    AgentTaskError::Storage(e.to_string())
}
pub(crate) fn initialize(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS agent_native_tools (
        project TEXT NOT NULL, principal TEXT NOT NULL, send_request TEXT NOT NULL,
        tool_request TEXT NOT NULL, bytes INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(project,principal,send_request,tool_request));").map_err(|e| e.to_string())
}
pub(crate) fn read(
    store: &AgentStore,
    scope: &AgentTaskScope,
    send: &str,
    tool: &str,
) -> Result<Option<AgentNativeToolReceipt>, AgentTaskError> {
    let Some(capture) = store.agent_native_admission(scope, send)? else {
        return Ok(None);
    };
    let c = store.0.lock().map_err(error)?;
    let value: Option<String> = c.query_row("SELECT value FROM agent_native_tools WHERE project=?1 AND principal=?2 AND send_request=?3 AND tool_request=?4",params![scope.project,scope.principal,send,tool],|r|r.get(0)).optional().map_err(error)?;
    value
        .map(|value| {
            let receipt = serde_json::from_str(&value).map_err(error)?;
            validate_native_tool(scope, &capture, &receipt)?;
            Ok(receipt)
        })
        .transpose()
}
pub(crate) fn put(
    store: &AgentStore,
    scope: &AgentTaskScope,
    receipt: &AgentNativeToolReceipt,
) -> Result<(), AgentTaskError> {
    let capture = store
        .agent_native_admission(scope, &receipt.invocation.send_request)?
        .ok_or(AgentTaskError::NotFound)?;
    validate_native_tool(scope, &capture, receipt)?;
    let value = serde_json::to_string(receipt).map_err(error)?;
    let input = &receipt.invocation;
    let mut c = store.0.lock().map_err(error)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let old: Option<String> = tx.query_row("SELECT value FROM agent_native_tools WHERE project=?1 AND principal=?2 AND send_request=?3 AND tool_request=?4",params![scope.project,scope.principal,input.send_request,input.tool_request],|r|r.get(0)).optional().map_err(error)?;
    if let Some(old) = &old {
        let mut original: AgentNativeToolReceipt = serde_json::from_str(old).map_err(error)?;
        if original == *receipt {
            return Ok(());
        }
        if original.phase != AgentNativeToolPhase::Prepared
            || receipt.phase == AgentNativeToolPhase::Prepared
            || receipt.updated_at_ms < original.updated_at_ms
        {
            return Err(AgentTaskError::RequestConflict);
        }
        original.phase = receipt.phase;
        original.operation = receipt.operation.clone();
        original.result = receipt.result.clone();
        original.failed = receipt.failed;
        original.error = receipt.error.clone();
        original.updated_at_ms = receipt.updated_at_ms;
        if original != *receipt {
            return Err(AgentTaskError::RequestConflict);
        }
    } else {
        if receipt.phase != AgentNativeToolPhase::Prepared {
            return Err(AgentTaskError::RequestConflict);
        }
        let count: usize = tx.query_row("SELECT COUNT(*) FROM agent_native_tools WHERE project=?1 AND principal=?2 AND send_request=?3",params![scope.project,scope.principal,input.send_request],|r|r.get(0)).map_err(error)?;
        if count >= MAX_NATIVE_TOOL_CALLS {
            return Err(AgentTaskError::Budget(
                "Original Send tool budget is exhausted".into(),
            ));
        }
    }
    let used: usize = tx.query_row("SELECT COALESCE(SUM(bytes),0) FROM agent_native_tools WHERE project=?1 AND principal=?2",params![scope.project,scope.principal],|r|r.get(0)).map_err(error)?;
    if used.saturating_sub(old.as_ref().map_or(0, String::len)) + value.len()
        > MAX_PROJECT_NATIVE_TOOL_BYTES
    {
        return Err(AgentTaskError::Budget(
            "Project native tool storage budget is exhausted".into(),
        ));
    }
    tx.execute("INSERT INTO agent_native_tools(project,principal,send_request,tool_request,bytes,value) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(project,principal,send_request,tool_request) DO UPDATE SET bytes=excluded.bytes,value=excluded.value",params![scope.project,scope.principal,input.send_request,input.tool_request,value.len(),value]).map_err(error)?;
    tx.commit().map_err(error)
}
