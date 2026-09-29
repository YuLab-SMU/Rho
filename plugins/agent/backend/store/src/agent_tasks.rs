//! Typed Agent application storage. No writes to the scientific journal.
use crate::AgentStore;
use rho_agent_api::*;
use rho_agent_owner::{
    AgentTaskError, AgentTaskRepository, AgentTaskScope, AgentTaskWrite, MAX_AGENT_EVENT_BYTES,
    MAX_AGENT_EVENTS, MAX_AGENT_TASKS, MAX_PROJECT_AGENT_EVENT_BYTES,
    MAX_PROJECT_NATIVE_ADMISSION_BYTES, StoredAgentAssetImport, StoredAgentNativeAdmission,
    StoredAgentTask,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

fn error(e: impl std::fmt::Display) -> AgentTaskError {
    AgentTaskError::Storage(e.to_string())
}
pub(crate) fn initialize(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS agent_tasks (
        project TEXT NOT NULL, principal TEXT NOT NULL, task_id TEXT NOT NULL,
        revision TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL, event_cursor INTEGER NOT NULL DEFAULT 0,
        history_gap INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(project,principal,task_id));
      CREATE INDEX IF NOT EXISTS agent_tasks_order ON agent_tasks(project,principal,created_at DESC,task_id DESC);
      CREATE TABLE IF NOT EXISTS agent_task_drafts (
        project TEXT NOT NULL, principal TEXT NOT NULL, task_id TEXT NOT NULL,
        version INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(project,principal,task_id));
      CREATE TABLE IF NOT EXISTS agent_task_receipts (
        project TEXT NOT NULL, principal TEXT NOT NULL, request_id TEXT NOT NULL,
        task_id TEXT NOT NULL, digest TEXT NOT NULL, updated_at INTEGER NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal,request_id));
      CREATE INDEX IF NOT EXISTS agent_task_receipt_order ON agent_task_receipts(project,principal,task_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS agent_native_admissions (
        project TEXT NOT NULL, principal TEXT NOT NULL, request_id TEXT NOT NULL,
        task_id TEXT NOT NULL, native_operation TEXT NOT NULL, native_request TEXT NOT NULL,
        bytes INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(project,principal,request_id),
        UNIQUE(project,principal,native_operation), UNIQUE(project,principal,native_request));
      CREATE TABLE IF NOT EXISTS agent_asset_imports (
        project TEXT NOT NULL, principal TEXT NOT NULL, request_id TEXT NOT NULL,
        bytes INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(project,principal,request_id));
      CREATE TABLE IF NOT EXISTS agent_task_events (
        project TEXT NOT NULL, principal TEXT NOT NULL, task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, event_id TEXT NOT NULL, bytes INTEGER NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal,task_id,event_id),
        UNIQUE(project,principal,task_id,sequence));
      CREATE TABLE IF NOT EXISTS agent_task_assets (
        project TEXT NOT NULL, principal TEXT NOT NULL, task_id TEXT NOT NULL,
        asset_id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), data BLOB NOT NULL,
        PRIMARY KEY(project,principal,task_id,asset_id));")
        .map_err(|e| e.to_string())
}
fn decode_task(value: String, cursor: u64, gap: bool) -> Result<StoredAgentTask, AgentTaskError> {
    let mut task: StoredAgentTask = serde_json::from_str(&value).map_err(error)?;
    task.event_cursor = cursor;
    task.history_gap |= gap;
    Ok(task)
}
mod asset_imports;
impl AgentTaskRepository for AgentStore {
    fn put_agent_context_images(
        &self,
        scope: &AgentTaskScope,
        images: &[(rho_agent_owner::AgentContextImage, Vec<u8>)],
    ) -> Result<(), AgentTaskError> {
        self.store_context_images(scope, images)
    }
    fn agent_context_image(
        &self,
        scope: &AgentTaskScope,
        image: &rho_agent_owner::AgentContextImage,
    ) -> Result<Vec<u8>, AgentTaskError> {
        self.read_context_image(scope, image)
    }
    fn agent_asset_import(
        &self,
        scope: &AgentTaskScope,
        request: &str,
    ) -> Result<Option<StoredAgentAssetImport>, AgentTaskError> {
        asset_imports::read(self, scope, request)
    }
    fn commit_agent_asset_import(
        &self,
        scope: &AgentTaskScope,
        write: AgentTaskWrite<'_>,
        capture: &StoredAgentAssetImport,
    ) -> Result<(), AgentTaskError> {
        if write.receipts.len() != 1 {
            return Err(AgentTaskError::RequestConflict);
        }
        capture.validate(scope, &write.receipts[0])?;
        self.commit_task(scope, write, None, Some(capture))
    }

    fn agent_native_tool(
        &self,
        scope: &AgentTaskScope,
        send: &str,
        tool: &str,
    ) -> Result<Option<AgentNativeToolReceipt>, AgentTaskError> {
        crate::native_tools::read(self, scope, send, tool)
    }
    fn put_agent_native_tool(
        &self,
        scope: &AgentTaskScope,
        receipt: &AgentNativeToolReceipt,
    ) -> Result<(), AgentTaskError> {
        crate::native_tools::put(self, scope, receipt)
    }
    fn project_agent_tasks(
        &self,
        scope: &AgentTaskScope,
        archived: Option<bool>,
        before: Option<&str>,
        limit: usize,
        native_host: &str,
        component_host: &str,
        rho_live: &[String],
    ) -> Result<ProjectAgentTaskPage, AgentTaskError> {
        self.read_project_agent_tasks(
            scope,
            archived,
            before,
            limit,
            native_host,
            component_host,
            rho_live,
        )
    }
    fn agent_task(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<StoredAgentTask>, AgentTaskError> {
        let c = self.0.lock().map_err(error)?;
        let row: Option<(String, u64, bool)> = c.query_row("SELECT value,event_cursor,history_gap FROM agent_tasks WHERE project=?1 AND principal=?2 AND task_id=?3", params![scope.project,scope.principal,id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(error)?;
        row.map(|(v, c, g)| decode_task(v, c, g)).transpose()
    }
    fn agent_tasks(
        &self,
        scope: &AgentTaskScope,
        archived: Option<bool>,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<StoredAgentTask>, AgentTaskError> {
        if !(1..=128).contains(&limit) {
            return Err(AgentTaskError::InvalidInput(
                "Task page limit must be 1–128".into(),
            ));
        }
        let cursor = before
            .map(|s| {
                let (time, id) = s
                    .split_once(':')
                    .ok_or_else(|| AgentTaskError::InvalidInput("Invalid task cursor".into()))?;
                let time = time
                    .parse::<u64>()
                    .map_err(|_| AgentTaskError::InvalidInput("Invalid task cursor".into()))?;
                uuid::Uuid::parse_str(id)
                    .map_err(|_| AgentTaskError::InvalidInput("Invalid task cursor".into()))?;
                Ok::<_, AgentTaskError>((time, id))
            })
            .transpose()?;
        let c = self.0.lock().map_err(error)?;
        let mut s = c.prepare("SELECT value,event_cursor,history_gap FROM agent_tasks WHERE project=?1 AND principal=?2
            AND (?3 IS NULL OR archived=?3) AND (?4 IS NULL OR created_at < ?4 OR (created_at=?4 AND task_id < ?5))
            ORDER BY created_at DESC,task_id DESC LIMIT ?6").map_err(error)?;
        let rows = s
            .query_map(
                params![
                    scope.project,
                    scope.principal,
                    archived,
                    cursor.map(|v| v.0),
                    cursor.map(|v| v.1),
                    limit
                ],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, u64>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                },
            )
            .map_err(error)?;
        rows.map(|r| {
            let (v, c, g) = r.map_err(error)?;
            decode_task(v, c, g)
        })
        .collect()
    }
    fn agent_task_counts(
        &self,
        scope: &AgentTaskScope,
        host: &str,
    ) -> Result<(u32, u32), AgentTaskError> {
        let c = self.0.lock().map_err(error)?;
        c.query_row("SELECT COALESCE(SUM(CASE WHEN json_extract(value,'$.host_incarnation')=?3 AND json_extract(value,'$.attachment.state') IN ('connecting','resuming','running','stopping') THEN 1 ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN json_extract(value,'$.host_incarnation')=?3 THEN json_array_length(value,'$.attachment.decisions') ELSE 0 END),0)
            FROM agent_tasks WHERE project=?1 AND principal=?2", params![scope.project,scope.principal,host], |r| Ok((r.get(0)?,r.get(1)?))).map_err(error)
    }
    fn agent_draft(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<AgentTaskDraft, AgentTaskError> {
        let c = self.0.lock().map_err(error)?;
        let value: Option<String> = c.query_row("SELECT value FROM agent_task_drafts WHERE project=?1 AND principal=?2 AND task_id=?3",params![scope.project,scope.principal,id],|r|r.get(0)).optional().map_err(error)?;
        serde_json::from_str(&value.ok_or(AgentTaskError::NotFound)?).map_err(error)
    }
    fn agent_receipt(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<AgentCommandReceipt>, AgentTaskError> {
        let c = self.0.lock().map_err(error)?;
        let value: Option<String> = c.query_row("SELECT value FROM agent_task_receipts WHERE project=?1 AND principal=?2 AND request_id=?3",params![scope.project,scope.principal,id],|r|r.get(0)).optional().map_err(error)?;
        value
            .map(|s| serde_json::from_str(&s).map_err(error))
            .transpose()
    }
    fn agent_receipts(
        &self,
        scope: &AgentTaskScope,
        task: &str,
    ) -> Result<Vec<AgentCommandReceipt>, AgentTaskError> {
        let c = self.0.lock().map_err(error)?;
        let mut s=c.prepare("SELECT value FROM agent_task_receipts WHERE project=?1 AND principal=?2 AND task_id=?3 ORDER BY CASE WHEN json_extract(value,'$.status') IN ('prepared','submitted','uncertain','interrupted') THEN 0 WHEN json_extract(value,'$.command')='send' THEN 1 ELSE 2 END,updated_at DESC,request_id DESC LIMIT 128").map_err(error)?;
        let rows = s
            .query_map(params![scope.project, scope.principal, task], |r| {
                r.get::<_, String>(0)
            })
            .map_err(error)?;
        rows.map(|r| serde_json::from_str(&r.map_err(error)?).map_err(error))
            .collect()
    }
    fn agent_events(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        after: Option<u64>,
        before: Option<u64>,
        limit: usize,
    ) -> Result<AgentTaskEventPage, AgentTaskError> {
        if !(1..=100).contains(&limit) || (after.is_some() && before.is_some()) {
            return Err(AgentTaskError::InvalidInput("Invalid event page".into()));
        }
        let c = self.0.lock().map_err(error)?;
        let header: Option<(u64,bool)> = c.query_row("SELECT event_cursor,history_gap FROM agent_tasks WHERE project=?1 AND principal=?2 AND task_id=?3", params![scope.project,scope.principal,task],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(error)?;
        let (durable, gap) = header.ok_or(AgentTaskError::NotFound)?;
        let history_generation: u64=c.query_row("SELECT json_extract(value,'$.history_generation') FROM agent_tasks WHERE project=?1 AND principal=?2 AND task_id=?3",params![scope.project,scope.principal,task],|r|r.get(0)).map_err(error)?;
        let oldest: u64=c.query_row("SELECT COALESCE(MIN(sequence),0) FROM agent_task_events WHERE project=?1 AND principal=?2 AND task_id=?3", params![scope.project,scope.principal,task],|r|r.get(0)).map_err(error)?;
        let descending = before.is_some() || after.is_none();
        let order = if descending { "DESC" } else { "ASC" };
        let mut s=c.prepare(&format!("SELECT value FROM agent_task_events WHERE project=?1 AND principal=?2 AND task_id=?3 AND (?4 IS NULL OR sequence>?4) AND (?5 IS NULL OR sequence<?5) ORDER BY sequence {order} LIMIT ?6")).map_err(error)?;
        let rows = s
            .query_map(
                params![
                    scope.project,
                    scope.principal,
                    task,
                    after,
                    before,
                    limit + 1
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(error)?;
        let mut events: Vec<AgentTaskEvent> = rows
            .map(|r| serde_json::from_str(&r.map_err(error)?).map_err(error))
            .collect::<Result<_, _>>()?;
        let has_more = events.len() > limit;
        events.truncate(limit);
        let next_cursor = events
            .last()
            .map_or(after.unwrap_or(durable), |e| e.sequence);
        if descending {
            events.reverse();
        }
        Ok(AgentTaskEventPage {
            task_id: task.into(),
            history_generation,
            events,
            next_cursor,
            has_more,
            history_gap: gap || after.is_some_and(|a| a.saturating_add(1) < oldest),
            oldest_cursor: oldest,
            durable_cursor: durable,
        })
    }
    fn agent_assets(
        &self,
        scope: &AgentTaskScope,
        task: &str,
    ) -> Result<Vec<AgentAsset>, AgentTaskError> {
        crate::agent_assets::list(self, scope, crate::agent_assets::AssetOwner::Native(task))
    }
    fn agent_asset(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), AgentTaskError> {
        crate::agent_assets::read(
            self,
            scope,
            crate::agent_assets::AssetOwner::Native(task),
            asset,
        )
    }
    fn put_agent_asset(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        asset: &AgentAsset,
        bytes: &[u8],
    ) -> Result<(), AgentTaskError> {
        crate::agent_assets::put(
            self,
            scope,
            crate::agent_assets::AssetOwner::Native(task),
            asset,
            bytes,
        )
    }
    fn agent_native_admission(
        &self,
        scope: &AgentTaskScope,
        request: &str,
    ) -> Result<Option<StoredAgentNativeAdmission>, AgentTaskError> {
        let c = self.0.lock().map_err(error)?;
        let value: Option<String> = c.query_row("SELECT value FROM agent_native_admissions WHERE project=?1 AND principal=?2 AND request_id=?3", params![scope.project,scope.principal,request], |r|r.get(0)).optional().map_err(error)?;
        let Some(value) = value else {
            return Ok(None);
        };
        let capture: StoredAgentNativeAdmission = serde_json::from_str(&value).map_err(error)?;
        let receipt: String = c.query_row("SELECT value FROM agent_task_receipts WHERE project=?1 AND principal=?2 AND request_id=?3",params![scope.project,scope.principal,request],|r|r.get(0)).map_err(error)?;
        capture.validate(scope, &serde_json::from_str(&receipt).map_err(error)?)?;
        Ok(Some(capture))
    }
    fn commit_agent_native_admission(
        &self,
        scope: &AgentTaskScope,
        write: AgentTaskWrite<'_>,
        admission: &StoredAgentNativeAdmission,
    ) -> Result<(), AgentTaskError> {
        if write.receipts.len() != 1 {
            return Err(AgentTaskError::RequestConflict);
        }
        admission.validate(scope, &write.receipts[0])?;
        self.commit_task(scope, write, Some(admission), None)
    }
    fn commit_agent_task(
        &self,
        scope: &AgentTaskScope,
        write: AgentTaskWrite<'_>,
    ) -> Result<(), AgentTaskError> {
        self.commit_task(scope, write, None, None)
    }
}
impl AgentStore {
    fn commit_task(
        &self,
        scope: &AgentTaskScope,
        write: AgentTaskWrite<'_>,
        admission: Option<&StoredAgentNativeAdmission>,
        asset_import: Option<&StoredAgentAssetImport>,
    ) -> Result<(), AgentTaskError> {
        let record = write.task;
        let id = &record.task.task_id;
        if record.task.project_root != scope.project {
            return Err(AgentTaskError::NotFound);
        }
        let mut c = self.0.lock().map_err(error)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let old: Option<String> = tx
            .query_row(
                "SELECT revision FROM agent_tasks WHERE project=?1 AND principal=?2 AND task_id=?3",
                params![scope.project, scope.principal, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        if old.as_deref() != write.expected_revision {
            return Err(AgentTaskError::Conflict);
        }
        if old.is_some() {
            let generation: u64 = tx.query_row("SELECT json_extract(value,'$.history_generation') FROM agent_tasks WHERE project=?1 AND principal=?2 AND task_id=?3",params![scope.project,scope.principal,id],|r|r.get(0)).map_err(error)?;
            if record.history_generation != generation {
                if record.history_generation < generation {
                    return Err(AgentTaskError::Conflict);
                }
                tx.execute("DELETE FROM agent_task_events WHERE project=?1 AND principal=?2 AND task_id=?3",params![scope.project,scope.principal,id]).map_err(error)?;
            }
        }
        if old.is_none() {
            let count: usize = tx
                .query_row(
                    "SELECT COUNT(*) FROM agent_tasks WHERE project=?1 AND principal=?2",
                    params![scope.project, scope.principal],
                    |r| r.get(0),
                )
                .map_err(error)?;
            if count >= MAX_AGENT_TASKS {
                return Err(AgentTaskError::Budget("Project task index is full".into()));
            }
        }
        for receipt in write.receipts {
            if receipt.task_id != *id {
                return Err(AgentTaskError::NotFound);
            }
            let retained:Option<String>=tx.query_row("SELECT value FROM agent_native_admissions WHERE project=?1 AND principal=?2 AND request_id=?3",params![scope.project,scope.principal,receipt.request_id],|r|r.get(0)).optional().map_err(error)?;
            if let Some(value) = retained {
                let retained: StoredAgentNativeAdmission =
                    serde_json::from_str(&value).map_err(error)?;
                retained.validate(scope, receipt)?;
                if let Some(admission) = admission {
                    if serde_json::to_value(&retained).map_err(error)?
                        != serde_json::to_value(admission).map_err(error)?
                    {
                        return Err(AgentTaskError::RequestConflict);
                    }
                }
            } else if let Some(admission) = admission {
                let reused:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_task_receipts WHERE project=?1 AND principal=?2 AND request_id=?3) OR EXISTS(SELECT 1 FROM agent_native_admissions WHERE project=?1 AND principal=?2 AND (native_operation=?4 OR native_request=?5))",params![scope.project,scope.principal,receipt.request_id,admission.origin.operation.as_str(),admission.origin.request.as_str()],|r|r.get(0)).map_err(error)?;
                if reused {
                    return Err(AgentTaskError::RequestConflict);
                }
                let value = serde_json::to_string(admission).map_err(error)?;
                let used:usize=tx.query_row("SELECT COALESCE(SUM(bytes),0) FROM agent_native_admissions WHERE project=?1 AND principal=?2",params![scope.project,scope.principal],|r|r.get(0)).map_err(error)?;
                if used.saturating_add(value.len()) > MAX_PROJECT_NATIVE_ADMISSION_BYTES {
                    return Err(AgentTaskError::Budget(
                        "Original native command storage is full".into(),
                    ));
                }
                tx.execute("INSERT INTO agent_native_admissions(project,principal,request_id,task_id,native_operation,native_request,bytes,value) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![scope.project,scope.principal,receipt.request_id,id,admission.origin.operation.as_str(),admission.origin.request.as_str(),value.len(),value]).map_err(error)?;
            }
            asset_imports::retain(&tx, scope, receipt, asset_import)?;
            let prior:Option<String>=tx.query_row("SELECT digest FROM agent_task_receipts WHERE project=?1 AND principal=?2 AND request_id=?3",params![scope.project,scope.principal,receipt.request_id],|r|r.get(0)).optional().map_err(error)?;
            if prior.as_ref().is_some_and(|s| *s != receipt.request_digest) {
                return Err(AgentTaskError::RequestConflict);
            }
            tx.execute("INSERT INTO agent_task_receipts(project,principal,request_id,task_id,digest,updated_at,value) VALUES(?1,?2,?3,?4,?5,?6,?7)
                ON CONFLICT(project,principal,request_id) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value",params![scope.project,scope.principal,receipt.request_id,id,receipt.request_digest,receipt.updated_at_ms,serde_json::to_string(receipt).map_err(error)?]).map_err(error)?;
        }
        tx.execute("INSERT INTO agent_tasks(project,principal,task_id,revision,created_at,updated_at,archived,event_cursor,history_gap,value) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
            ON CONFLICT(project,principal,task_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,archived=excluded.archived,event_cursor=MAX(agent_tasks.event_cursor,excluded.event_cursor),history_gap=MAX(agent_tasks.history_gap,excluded.history_gap),value=excluded.value", params![scope.project,scope.principal,id,record.revision,record.task.created_at_ms,record.task.updated_at_ms,record.task.archived,record.event_cursor,record.history_gap,serde_json::to_string(record).map_err(error)?]).map_err(error)?;
        if let Some(draft) = write.draft {
            tx.execute("INSERT INTO agent_task_drafts(project,principal,task_id,version,value) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(project,principal,task_id) DO UPDATE SET version=excluded.version,value=excluded.value",params![scope.project,scope.principal,id,draft.version,serde_json::to_string(draft).map_err(error)?]).map_err(error)?;
        }
        for event in write.events {
            if event.sequence > record.event_cursor
                || event.generation != record.attachment.generation
                || record.task.native_session_id.as_deref() != Some(&event.native_session_id)
            {
                return Err(AgentTaskError::Conflict);
            }
            let value = serde_json::to_string(event).map_err(error)?;
            if value.len() > MAX_AGENT_EVENT_BYTES {
                return Err(AgentTaskError::Budget(
                    "Native observation exceeds its cache budget".into(),
                ));
            }
            tx.execute("INSERT INTO agent_task_events(project,principal,task_id,sequence,event_id,bytes,value) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(project,principal,task_id,event_id) DO UPDATE SET sequence=excluded.sequence,bytes=excluded.bytes,value=excluded.value",params![scope.project,scope.principal,id,event.sequence,event.event_id,value.len(),value]).map_err(error)?;
        }
        let mut evicted = false;
        loop {
            let (count,bytes):(usize,usize)=tx.query_row("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM agent_task_events WHERE project=?1 AND principal=?2 AND task_id=?3",params![scope.project,scope.principal,id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(error)?;
            if count <= MAX_AGENT_EVENTS && bytes <= MAX_AGENT_EVENT_BYTES {
                break;
            }
            tx.execute("DELETE FROM agent_task_events WHERE project=?1 AND principal=?2 AND task_id=?3 AND sequence=(SELECT MIN(sequence) FROM agent_task_events WHERE project=?1 AND principal=?2 AND task_id=?3)",params![scope.project,scope.principal,id]).map_err(error)?;
            evicted = true;
        }
        if evicted {
            tx.execute("UPDATE agent_tasks SET history_gap=1 WHERE project=?1 AND principal=?2 AND task_id=?3",params![scope.project,scope.principal,id]).map_err(error)?;
        }
        loop {
            let bytes:usize=tx.query_row("SELECT COALESCE(SUM(bytes),0) FROM agent_task_events WHERE project=?1 AND principal=?2",params![scope.project,scope.principal],|r|r.get(0)).map_err(error)?;
            if bytes <= MAX_PROJECT_AGENT_EVENT_BYTES {
                break;
            }
            let victim:Option<String>=tx.query_row("SELECT t.task_id FROM agent_tasks t WHERE t.project=?1 AND t.principal=?2 AND json_extract(t.value,'$.attachment.state') NOT IN ('running','waiting_for_permission','connecting','resuming','stopping') AND EXISTS(SELECT 1 FROM agent_task_events e WHERE e.project=t.project AND e.principal=t.principal AND e.task_id=t.task_id) ORDER BY t.updated_at,t.task_id LIMIT 1",params![scope.project,scope.principal],|r|r.get(0)).optional().map_err(error)?;
            let Some(victim) = victim else {
                return Err(AgentTaskError::Budget(
                    "Project observation cache is full of active tasks".into(),
                ));
            };
            tx.execute(
                "DELETE FROM agent_task_events WHERE project=?1 AND principal=?2 AND task_id=?3",
                params![scope.project, scope.principal, victim],
            )
            .map_err(error)?;
            tx.execute("UPDATE agent_tasks SET history_gap=1 WHERE project=?1 AND principal=?2 AND task_id=?3",params![scope.project,scope.principal,victim]).map_err(error)?;
        }
        tx.commit().map_err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_agent_owner::AgentTaskOwner;
    use std::sync::Arc;

    fn scope() -> AgentTaskScope {
        AgentTaskScope {
            project: "/study".into(),
            principal: "human".into(),
        }
    }
    fn window(id: &str) -> AgentControllerRef {
        AgentControllerRef {
            window_id: id.into(),
            incarnation: format!("{id}-incarnation"),
        }
    }
    fn request(window_id: &str, command: AgentTaskCommand) -> AgentTaskRequest {
        AgentTaskRequest {
            project_root: "/study".into(),
            window: window(window_id),
            request_id: uuid::Uuid::new_v4().to_string(),
            command,
        }
    }
    fn create(owner: &AgentTaskOwner) -> rho_agent_owner::AgentTaskAdmission {
        owner
            .admit(
                &scope(),
                &request(
                    "one",
                    AgentTaskCommand::Create {
                        provider: AgentProvider::Kimi,
                        model: "b-ai/glm-5.3-flash".into(),
                        effort: None,
                    },
                ),
                100,
            )
            .unwrap()
    }
    fn control(task: &StoredAgentTask) -> AgentTaskControl {
        AgentTaskControl {
            task_id: task.task.task_id.clone(),
            generation: task.attachment.generation,
        }
    }
    fn saved(
        owner: &AgentTaskOwner,
        task: &StoredAgentTask,
        version: u64,
        text: &str,
    ) -> rho_agent_owner::AgentTaskAdmission {
        owner
            .admit(
                &scope(),
                &request(
                    "one",
                    AgentTaskCommand::SaveDraft {
                        control: control(task),
                        version,
                        content: AgentDraftContent {
                            text: text.into(),
                            ..Default::default()
                        },
                    },
                ),
                110,
            )
            .unwrap()
    }
    fn setup() -> (tempfile::TempDir, Arc<AgentStore>, AgentTaskOwner) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(AgentStore::open(&dir.path().join("application.sqlite")).unwrap());
        let owner = AgentTaskOwner::new(store.clone());
        (dir, store, owner)
    }
    #[test]
    fn agent_tasks_same_model_are_distinct_and_create_is_idempotent() {
        let (_dir, store, owner) = setup();
        let req = request(
            "one",
            AgentTaskCommand::Create {
                provider: AgentProvider::Kimi,
                model: "same-model".into(),
                effort: None,
            },
        );
        let first = owner.admit(&scope(), &req, 100).unwrap();
        let again = owner.admit(&scope(), &req, 200).unwrap();
        assert!(again.repeated);
        assert_eq!(first.task.task.task_id, again.task.task.task_id);
        let second = create(&owner);
        assert_ne!(first.task.task.task_id, second.task.task.task_id);
        assert_eq!(
            store.agent_tasks(&scope(), None, None, 100).unwrap().len(),
            2
        );
        let mut altered = req;
        altered.command = AgentTaskCommand::Create {
            provider: AgentProvider::Kimi,
            model: "changed".into(),
            effort: None,
        };
        assert!(matches!(
            owner.admit(&scope(), &altered, 210),
            Err(AgentTaskError::RequestConflict)
        ));
        assert!(first.task.task.native_session_id.is_none());
    }
    #[test]
    fn agent_drafts_cas_and_takeover_fence_old_window_and_generation() {
        let (_dir, _store, owner) = setup();
        let initial = create(&owner);
        let s = saved(&owner, &initial.task, 0, "保留本地草稿");
        let stale = request(
            "one",
            AgentTaskCommand::SaveDraft {
                control: control(&s.task),
                version: 0,
                content: AgentDraftContent::default(),
            },
        );
        assert!(matches!(
            owner.admit(&scope(), &stale, 120),
            Err(AgentTaskError::Conflict)
        ));
        let takeover = owner
            .admit(
                &scope(),
                &request(
                    "two",
                    AgentTaskCommand::TakeOver {
                        control: control(&s.task),
                        stop: false,
                    },
                ),
                130,
            )
            .unwrap();
        assert_eq!(takeover.task.attachment.generation, 2);
        assert_eq!(takeover.draft.content.text, "保留本地草稿");
        let old = request(
            "one",
            AgentTaskCommand::Send {
                control: control(&s.task),
                draft_version: 1,
            },
        );
        assert!(matches!(
            owner.admit(&scope(), &old, 140),
            Err(AgentTaskError::Conflict)
        ));
        let wrong = request(
            "one",
            AgentTaskCommand::SaveDraft {
                control: control(&takeover.task),
                version: 1,
                content: AgentDraftContent::default(),
            },
        );
        assert!(owner.admit(&scope(), &wrong, 150).is_err());
        let other = AgentTaskScope {
            principal: "another principal".into(),
            ..scope()
        };
        assert!(matches!(
            owner.detail(&other, &initial.task.task.task_id),
            Err(AgentTaskError::NotFound)
        ));
    }
    #[test]
    fn agent_send_receipt_precedes_native_work_and_restart_preserves_uncertainty() {
        let (dir, _store, owner) = setup();
        let first = create(&owner);
        let s = saved(&owner, &first.task, 0, "first prompt");
        let req = request(
            "one",
            AgentTaskCommand::Send {
                control: control(&s.task),
                draft_version: 1,
            },
        );
        let sent = owner.admit(&scope(), &req, 120).unwrap();
        assert!(sent.native);
        assert_eq!(sent.receipt.status, "prepared");
        let repeated = owner.admit(&scope(), &req, 125).unwrap();
        assert!(repeated.repeated);
        assert!(!repeated.native);
        let later = saved(&owner, &sent.task, 1, "next prompt");
        assert_eq!(later.draft.version, 2);
        let reopened = AgentTaskOwner::new(Arc::new(
            AgentStore::open(&dir.path().join("application.sqlite")).unwrap(),
        ));
        let detail = reopened.detail(&scope(), &first.task.task.task_id).unwrap();
        assert_eq!(detail.summary.attachment.state, "uncertain");
        assert_eq!(detail.draft.content.text, "next prompt");
        assert!(
            detail
                .receipts
                .iter()
                .any(|r| r.request_id == req.request_id && r.status == "uncertain")
        );
        assert!(
            reopened
                .admit(
                    &scope(),
                    &request(
                        "one",
                        AgentTaskCommand::Connect {
                            control: control(&sent.task)
                        }
                    ),
                    200
                )
                .is_err()
        );
    }
    #[test]
    fn agent_observation_retention_preserves_index_draft_receipts_and_cursor() {
        let (_dir, store, owner) = setup();
        let initial = create(&owner);
        let s = saved(&owner, &initial.task, 0, "saved draft");
        let id = &s.task.task.task_id;
        owner
            .update(&scope(), id, 1, |task, _, _, events| {
                task.task.native_session_id = Some("owned-native-id".into());
                task.event_cursor = 510;
                for sequence in 1..=510 {
                    events.push(AgentTaskEvent {
                        usage: None,
                        sequence,
                        event_id: format!("e{sequence}"),
                        request_id: None,
                        generation: 1,
                        native_session_id: "owned-native-id".into(),
                        native_turn_id: None,
                        native_item_id: None,
                        kind: "message".into(),
                        role: Some("assistant".into()),
                        text: format!("message {sequence}"),
                        status: None,
                        source: "observation".into(),
                        observed_at_ms: sequence,
                    });
                }
                Ok(())
            })
            .unwrap();
        let page = store
            .agent_events(&scope(), id, Some(0), None, 100)
            .unwrap();
        assert_eq!(page.oldest_cursor, 11);
        assert_eq!(page.durable_cursor, 510);
        assert!(page.history_gap);
        assert_eq!(page.events[0].sequence, 11);
        assert!(page.has_more);
        let detail = owner.detail(&scope(), id).unwrap();
        assert_eq!(detail.draft.content.text, "saved draft");
        assert!(detail.summary.history_gap);
        assert!(
            store
                .agent_receipt(&scope(), &initial.receipt.request_id)
                .unwrap()
                .is_some()
        );
        owner
            .admit(
                &scope(),
                &request(
                    "two",
                    AgentTaskCommand::TakeOver {
                        control: control(&s.task),
                        stop: false,
                    },
                ),
                200,
            )
            .unwrap();
        assert!(matches!(
            owner.update(&scope(), id, 1, |_, _, _, _| Ok(())),
            Err(AgentTaskError::Conflict)
        ));
    }
    #[test]
    fn agent_store_cas_rolls_back_conflicting_receipts_and_draft() {
        let (_dir, store, owner) = setup();
        let initial = create(&owner);
        let old = initial.task.clone();
        saved(&owner, &old, 0, "newer content");
        let mut stale = old.clone();
        stale.revision = "stale-write".into();
        stale.task.title = "must not commit".into();
        assert!(matches!(
            store.commit_agent_task(
                &scope(),
                AgentTaskWrite {
                    expected_revision: Some(&old.revision),
                    task: &stale,
                    draft: Some(&initial.draft),
                    receipts: &[],
                    events: &[]
                }
            ),
            Err(AgentTaskError::Conflict)
        ));
        assert_eq!(
            owner
                .detail(&scope(), &old.task.task_id)
                .unwrap()
                .draft
                .content
                .text,
            "newer content"
        );
    }
}

#[cfg(test)]
#[path = "agent_tasks/native_admission_tests.rs"]
mod native_admission_tests;
