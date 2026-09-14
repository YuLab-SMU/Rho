//! Transactional byte accounting, independent of scientific journal truth.
use super::*;
use rusqlite::Transaction;

pub(super) fn initialize(connection: &Connection) -> Result<(), String> {
    let existed:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='component_payload_bytes')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    let tx = connection
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS component_payload_bytes (
        project TEXT NOT NULL, kind TEXT NOT NULL, principal TEXT NOT NULL, identity TEXT NOT NULL,
        parent TEXT, state TEXT, bytes INTEGER NOT NULL CHECK(bytes>=0),
        PRIMARY KEY(project,kind,principal,identity));
        CREATE INDEX IF NOT EXISTS component_payload_parent ON component_payload_bytes(project,kind,principal,parent,state);")
        .map_err(|e|e.to_string())?;
    for (table, kind, id, parent, state) in [
        (
            "component_agent_conversations",
            "conversation",
            "conversation_id",
            "active_run_id",
            "NULL",
        ),
        ("component_agent_runs", "run", "run_id", "NULL", "state"),
        (
            "component_agent_tools",
            "tool",
            "receipt_id",
            "run_id",
            "json_extract(value,'$.receipt.phase')",
        ),
        (
            "component_agent_settings",
            "settings",
            "'settings'",
            "NULL",
            "NULL",
        ),
        (
            "component_model_diagnostics",
            "diagnostic",
            "request_id",
            "NULL",
            "json_extract(value,'$.state')",
        ),
    ] {
        let qualify = |expr: &str, prefix: &str| {
            if expr == "NULL" || expr.starts_with('\'') {
                expr.into()
            } else if expr.starts_with("json_extract(") {
                expr.replace("value,", &format!("{prefix}.value,"))
            } else {
                format!("{prefix}.{expr}")
            }
        };
        let new_id = qualify(id, "NEW");
        let old_id = qualify(id, "OLD");
        let new_parent = qualify(parent, "NEW");
        let new_state = qualify(state, "NEW");
        let insert=format!("INSERT INTO component_payload_bytes VALUES(NEW.project,'{kind}',NEW.principal,{new_id},{new_parent},{new_state},length(CAST(NEW.value AS BLOB)))
            ON CONFLICT(project,kind,principal,identity) DO UPDATE SET parent=excluded.parent,state=excluded.state,bytes=excluded.bytes;");
        tx.execute_batch(&format!(
            "CREATE TRIGGER IF NOT EXISTS {table}_payload_insert AFTER INSERT ON {table} BEGIN {insert} END;
             CREATE TRIGGER IF NOT EXISTS {table}_payload_update AFTER UPDATE ON {table} BEGIN
               DELETE FROM component_payload_bytes WHERE project=OLD.project AND kind='{kind}' AND principal=OLD.principal AND identity={old_id};
               {insert} END;
             CREATE TRIGGER IF NOT EXISTS {table}_payload_delete AFTER DELETE ON {table} BEGIN
               DELETE FROM component_payload_bytes WHERE project=OLD.project AND kind='{kind}' AND principal=OLD.principal AND identity={old_id}; END;"
        )).map_err(|e|e.to_string())?;
        if !existed {
            tx.execute_batch(&format!("INSERT OR REPLACE INTO component_payload_bytes SELECT project,'{kind}',principal,{id},{parent},{state},length(CAST(value AS BLOB)) FROM {table};")).map_err(|e|e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Active rows and unresolved tool receipts retain their bounded completion space.
/// The ledger stores sizes/identities only; raw values stay with their existing owner.
pub(crate) fn charged_bytes(
    connection: &Connection,
    project: &str,
) -> Result<u64, ApplicationError> {
    let records:u64=connection.query_row(
        "SELECT COALESCE(SUM(MAX(b.bytes,CASE
            WHEN b.kind='tool' AND b.state!='resolved' THEN ?2
            WHEN b.kind='run' AND (b.state NOT IN ('completed','failed','stopped','interrupted')
                OR EXISTS(SELECT 1 FROM component_payload_bytes t WHERE t.project=b.project AND t.principal=b.principal AND t.kind='tool' AND t.parent=b.identity AND t.state!='resolved')) THEN ?3
            WHEN b.kind='conversation' AND b.parent IS NOT NULL THEN ?4
            WHEN b.kind='diagnostic' AND b.state IN ('queued','running') THEN ?5
            WHEN b.kind='settings' THEN ?6
            ELSE b.bytes END)),0) FROM component_payload_bytes b WHERE b.project=?1",
        params![project,MAX_COMPONENT_TOOL_RECORD_BYTES,MAX_COMPONENT_RUN_RECORD_BYTES,MAX_COMPONENT_CONVERSATION_RECORD_BYTES,MAX_COMPONENT_DIAGNOSTIC_RECORD_BYTES,MAX_COMPONENT_SETTINGS_RECORD_BYTES],
        |row|row.get(0)
    ).map_err(error)?;
    let events: u64 = connection
        .query_row(
            "SELECT COALESCE(SUM(bytes),0) FROM component_agent_events WHERE project=?1",
            params![project],
            |row| row.get(0),
        )
        .map_err(error)?;
    records
        .checked_add(events)
        .ok_or_else(|| ApplicationError::Budget("Project payload size overflow".into()))
}

pub(crate) fn enforce(
    tx: &Transaction<'_>,
    project: &str,
    before: u64,
) -> Result<(), ApplicationError> {
    let limit = MAX_COMPONENT_PROJECT_PAYLOAD_BYTES as u64;
    let mut charged = charged_bytes(tx, project)?;
    if charged > limit {
        let excess = charged - limit;
        // Evict event payloads only, preferring inactive conversations. Never remove
        // requests, tool identities or native references to make room.
        tx.execute("DELETE FROM component_agent_events WHERE event_order IN (
            SELECT event_order FROM (
                SELECT e.event_order, COALESCE(SUM(e.bytes) OVER (
                    ORDER BY (c.active_run_id IS NOT NULL),e.event_order
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS earlier
                FROM component_agent_events e
                LEFT JOIN component_agent_conversations c ON c.project=e.project AND c.principal=e.principal AND c.conversation_id=e.conversation_id
                WHERE e.project=?1
            ) WHERE earlier<?2)",params![project,excess]).map_err(error)?;
        charged = charged_bytes(tx, project)?;
    }
    // An existing oversized store remains readable and may shrink or finish an
    // already-reserved receipt. It cannot admit additional payload obligations.
    if charged > limit && charged > before {
        return Err(ApplicationError::Budget("Project component payload budget is full (64 MiB including reserved receipt space); existing identities and results are retained".into()));
    }
    Ok(())
}
