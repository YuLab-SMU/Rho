//! Additive ApplicationStore tables; native Agent tasks and science journal are untouched.
use crate::ApplicationStore;
use rho_application::*;
use rho_contract::*;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};
pub(crate) mod payload_budget;

fn error(error: impl ToString) -> ApplicationError {
    ApplicationError::Storage(error.to_string())
}
fn encode(value: &impl Serialize) -> Result<String, ApplicationError> {
    serde_json::to_string(value).map_err(error)
}
fn decode<T: DeserializeOwned>(value: String) -> Result<T, ApplicationError> {
    serde_json::from_str(&value).map_err(error)
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS component_agent_conversations (
      project TEXT NOT NULL, principal TEXT NOT NULL, conversation_id TEXT NOT NULL,
      version INTEGER NOT NULL, active_run_id TEXT, updated_at INTEGER NOT NULL,
      value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal,conversation_id));
    CREATE TABLE IF NOT EXISTS component_agent_runs (
      project TEXT NOT NULL, principal TEXT NOT NULL, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      request_id TEXT NOT NULL, request_digest TEXT NOT NULL, host_incarnation TEXT NOT NULL,
      state TEXT NOT NULL, event_cursor INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
      PRIMARY KEY(project,principal,run_id), UNIQUE(project,principal,request_id));
    CREATE INDEX IF NOT EXISTS component_agent_task_order ON component_agent_conversations(project,principal,json_extract(value,'$.created_at_ms') DESC,conversation_id DESC);
    CREATE INDEX IF NOT EXISTS component_agent_active ON component_agent_runs(host_incarnation,state);
    CREATE INDEX IF NOT EXISTS component_agent_history ON component_agent_runs(project,principal,conversation_id,json_extract(value,'$.run.created_at_ms') DESC,run_id DESC);
    CREATE TABLE IF NOT EXISTS component_agent_tools (
      project TEXT NOT NULL, principal TEXT NOT NULL, run_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
      model_call INTEGER NOT NULL, tool_call_id TEXT NOT NULL, action_digest TEXT NOT NULL, mutation INTEGER NOT NULL,
      value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal,receipt_id),
      UNIQUE(project,principal,run_id,model_call,tool_call_id));
    CREATE INDEX IF NOT EXISTS component_agent_tool_run ON component_agent_tools(project,principal,run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS component_agent_mutation_once ON component_agent_tools(project,principal,run_id,action_digest) WHERE mutation=1;
    CREATE TABLE IF NOT EXISTS component_agent_events (
      event_order INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, principal TEXT NOT NULL,
      conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, bytes INTEGER NOT NULL,
      value TEXT NOT NULL CHECK(json_valid(value)), UNIQUE(project,principal,run_id,sequence));
    CREATE INDEX IF NOT EXISTS component_agent_event_run ON component_agent_events(project,principal,run_id,sequence);
    CREATE INDEX IF NOT EXISTS component_agent_event_conversation ON component_agent_events(project,principal,conversation_id,event_order);
    CREATE TABLE IF NOT EXISTS component_agent_settings (
      project TEXT NOT NULL, principal TEXT NOT NULL, version INTEGER NOT NULL,
      value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal));
    CREATE TABLE IF NOT EXISTS component_model_diagnostics (
      project TEXT NOT NULL, principal TEXT NOT NULL, request_id TEXT NOT NULL,
      version INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal,request_id));")
      .map_err(|e|e.to_string())?;
    payload_budget::initialize(connection)
}

impl ComponentAgentRepository for ApplicationStore {
    fn component_assets(&self, scope: &ApplicationScope, conversation: &str) -> Result<Vec<AgentAsset>, ApplicationError> {
        crate::agent_assets::list(self, &scope.into(), crate::agent_assets::AssetOwner::Component(conversation)).map_err(Into::into)
    }
    fn component_asset(&self, scope: &ApplicationScope, conversation: &str, asset: &str) -> Result<(AgentAsset, Vec<u8>), ApplicationError> {
        crate::agent_assets::read(self, &scope.into(), crate::agent_assets::AssetOwner::Component(conversation), asset).map_err(Into::into)
    }
    fn put_component_asset(&self, scope: &ApplicationScope, conversation: &str, asset: &AgentAsset, bytes: &[u8]) -> Result<(), ApplicationError> {
        crate::agent_assets::put(self, &scope.into(), crate::agent_assets::AssetOwner::Component(conversation), asset, bytes).map_err(Into::into)
    }

    fn component_diagnostic(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<ComponentModelDiagnostic>, ApplicationError> {
        let c = self.0.lock().map_err(error)?;
        let value:Option<String>=c.query_row("SELECT value FROM component_model_diagnostics WHERE project=?1 AND principal=?2 AND request_id=?3",params![s.project,s.principal,id],|r|r.get(0)).optional().map_err(error)?;
        value.map(decode).transpose()
    }
    fn component_diagnostics(
        &self,
        s: &ApplicationScope,
    ) -> Result<Vec<ComponentModelDiagnostic>, ApplicationError> {
        let c = self.0.lock().map_err(error)?;
        let mut query=c.prepare("SELECT value FROM component_model_diagnostics WHERE project=?1 AND principal=?2 ORDER BY updated_at DESC,request_id DESC LIMIT 64").map_err(error)?;
        query
            .query_map(params![s.project, s.principal], |r| r.get::<_, String>(0))
            .map_err(error)?
            .map(|r| decode(r.map_err(error)?))
            .collect()
    }
    fn write_component_diagnostic(
        &self,
        s: &ApplicationScope,
        expected: Option<u64>,
        diagnostic: &ComponentModelDiagnostic,
    ) -> Result<(), ApplicationError> {
        let mut c = self.0.lock().map_err(error)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let before = payload_budget::charged_bytes(&tx, &s.project)?;
        if encode(diagnostic)?.len() > MAX_COMPONENT_DIAGNOSTIC_RECORD_BYTES {
            return Err(ApplicationError::Budget(
                "Model diagnostic payload is too large".into(),
            ));
        }
        let previous:Option<String>=tx.query_row("SELECT value FROM component_model_diagnostics WHERE project=?1 AND principal=?2 AND request_id=?3",params![s.project,s.principal,diagnostic.request_id],|r|r.get(0)).optional().map_err(error)?;
        let previous = previous
            .map(decode::<ComponentModelDiagnostic>)
            .transpose()?;
        if previous.as_ref().map(|d| d.version) != expected
            || diagnostic.version
                != expected
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or(ApplicationError::Conflict)?
        {
            return Err(ApplicationError::Conflict);
        }
        if let Some(previous) = &previous {
            if previous.connection_digest != diagnostic.connection_digest
                || previous.kind != diagnostic.kind
                || previous.window != diagnostic.window
            {
                return Err(ApplicationError::RequestConflict);
            }
        } else {
            let count:usize=tx.query_row("SELECT COUNT(*) FROM component_model_diagnostics WHERE project=?1 AND principal=?2",params![s.project,s.principal],|r|r.get(0)).map_err(error)?;
            if count >= 4096 {
                return Err(ApplicationError::Budget(
                    "Model diagnostic record limit reached".into(),
                ));
            }
        }
        tx.execute("INSERT INTO component_model_diagnostics VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(project,principal,request_id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at,value=excluded.value",params![s.project,s.principal,diagnostic.request_id,diagnostic.version,diagnostic.updated_at_ms,encode(diagnostic)?]).map_err(error)?;
        payload_budget::enforce(&tx, &s.project, before)?;
        tx.commit().map_err(error)
    }
    fn component_conversation(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<ComponentAgentConversation>, ApplicationError> {
        let c = self.0.lock().map_err(error)?;
        let row:Option<String>=c.query_row("SELECT value FROM component_agent_conversations WHERE project=?1 AND principal=?2 AND conversation_id=?3",params![s.project,s.principal,id],|r|r.get(0)).optional().map_err(error)?;
        row.map(decode).transpose()
    }
    fn component_conversations(
        &self,
        s: &ApplicationScope,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ComponentAgentConversation>, ApplicationError> {
        if !(1..=128).contains(&limit) {
            return Err(ApplicationError::InvalidInput(
                "Conversation page limit must be 1–128".into(),
            ));
        }
        let c = self.0.lock().map_err(error)?;
        let mut q=c.prepare("SELECT value FROM component_agent_conversations WHERE project=?1 AND principal=?2 AND (?3 IS NULL OR conversation_id>?3) ORDER BY conversation_id LIMIT ?4").map_err(error)?;
        q.query_map(params![s.project, s.principal, after, limit], |r| {
            r.get::<_, String>(0)
        })
        .map_err(error)?
        .map(|r| decode(r.map_err(error)?))
        .collect()
    }
    fn component_run(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredComponentRun>, ApplicationError> {
        let c = self.0.lock().map_err(error)?;
        let row:Option<String>=c.query_row("SELECT value FROM component_agent_runs WHERE project=?1 AND principal=?2 AND run_id=?3",params![s.project,s.principal,id],|r|r.get(0)).optional().map_err(error)?;
        row.map(decode).transpose()
    }
    fn component_run_by_request(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredComponentRun>, ApplicationError> {
        let c = self.0.lock().map_err(error)?;
        let row:Option<String>=c.query_row("SELECT value FROM component_agent_runs WHERE project=?1 AND principal=?2 AND request_id=?3",params![s.project,s.principal,id],|r|r.get(0)).optional().map_err(error)?;
        row.map(decode).transpose()
    }
    fn component_run_history(
        &self,
        scope: &ApplicationScope,
        conversation: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<(ComponentAgentRunSummary, String)>, ApplicationError> {
        if !(1..=32).contains(&limit) || conversation.len() > 160 || before.is_some_and(|id| id.len() > 160) {
            return Err(ApplicationError::InvalidInput("Invalid run history page".into()));
        }
        let connection = self.0.lock().map_err(error)?;
        let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM component_agent_conversations WHERE project=?1 AND principal=?2 AND conversation_id=?3)",
            params![scope.project, scope.principal, conversation], |row| row.get(0)).map_err(error)?;
        if !exists { return Err(ApplicationError::NotFound); }
        let boundary: Option<i64> = if let Some(id) = before {
            Some(connection.query_row("SELECT json_extract(value,'$.run.created_at_ms') FROM component_agent_runs WHERE project=?1 AND principal=?2 AND conversation_id=?3 AND run_id=?4",
                params![scope.project, scope.principal, conversation, id], |row| row.get(0)).optional().map_err(error)?.ok_or(ApplicationError::NotFound)?)
        } else { None };
        let mut query = connection.prepare("SELECT json_object(
            'run_id',run_id,'request_id',request_id,'conversation_id',conversation_id,
            'profile',json_extract(value,'$.run.profile'),'state',state,
            'text_excerpt',substr(json_extract(value,'$.run.request.text'),1,240),
            'created_at_ms',json_extract(value,'$.run.created_at_ms'),
            'updated_at_ms',json_extract(value,'$.run.updated_at_ms'),
            'reason',json_extract(value,'$.run.reason'),
            'continuation_run_id',json_extract(value,'$.run.request.continuation.run_id')),host_incarnation
            FROM component_agent_runs WHERE project=?1 AND principal=?2 AND conversation_id=?3
            AND (?4 IS NULL OR (json_extract(value,'$.run.created_at_ms'),run_id)<(?5,?4))
            ORDER BY json_extract(value,'$.run.created_at_ms') DESC,run_id DESC LIMIT ?6").map_err(error)?;
        query.query_map(params![scope.project, scope.principal, conversation, before, boundary, limit], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(error)?.map(|row| {
                let (value, incarnation) = row.map_err(error)?;
                Ok((decode(value)?, incarnation))
            }).collect()
    }
    fn component_tools(
        &self,
        s: &ApplicationScope,
        run: &str,
    ) -> Result<Vec<StoredComponentTool>, ApplicationError> {
        let c = self.0.lock().map_err(error)?;
        let mut q=c.prepare("SELECT value FROM component_agent_tools WHERE project=?1 AND principal=?2 AND run_id=?3 ORDER BY model_call,receipt_id LIMIT 17").map_err(error)?;
        let tools: Vec<_> = q
            .query_map(params![s.project, s.principal, run], |r| {
                r.get::<_, String>(0)
            })
            .map_err(error)?
            .map(|r| decode(r.map_err(error)?))
            .collect::<Result<_, _>>()?;
        if tools.len() > 16 {
            return Err(ApplicationError::Budget(
                "Stored tool receipt count exceeds run limit".into(),
            ));
        }
        Ok(tools)
    }
    fn component_events(
        &self,
        s: &ApplicationScope,
        run: &str,
        after: u64,
        limit: usize,
    ) -> Result<ComponentAgentEventPage, ApplicationError> {
        if !(1..=128).contains(&limit) {
            return Err(ApplicationError::InvalidInput(
                "Event page limit must be 1–128".into(),
            ));
        }
        let c = self.0.lock().map_err(error)?;
        let cursor:u64=c.query_row("SELECT event_cursor FROM component_agent_runs WHERE project=?1 AND principal=?2 AND run_id=?3",params![s.project,s.principal,run],|r|r.get(0)).optional().map_err(error)?.ok_or(ApplicationError::NotFound)?;
        let mut q=c.prepare("SELECT value FROM component_agent_events WHERE project=?1 AND principal=?2 AND run_id=?3 AND sequence>?4 ORDER BY sequence LIMIT ?5").map_err(error)?;
        let events: Vec<ComponentAgentEvent> = q
            .query_map(params![s.project, s.principal, run, after, limit], |r| {
                r.get::<_, String>(0)
            })
            .map_err(error)?
            .map(|r| decode(r.map_err(error)?))
            .collect::<Result<_, _>>()?;
        let history_gap = events
            .first()
            .map_or(cursor > after, |e| e.sequence > after.saturating_add(1));
        let cursor = events.last().map_or(cursor, |e| e.sequence);
        Ok(ComponentAgentEventPage {
            events,
            cursor,
            history_gap,
        })
    }
    fn component_settings(
        &self,
        s: &ApplicationScope,
    ) -> Result<ComponentModelSettings, ApplicationError> {
        let c = self.0.lock().map_err(error)?;
        let row: Option<String> = c
            .query_row(
                "SELECT value FROM component_agent_settings WHERE project=?1 AND principal=?2",
                params![s.project, s.principal],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        row.map(decode).transpose().map(|v| {
            v.unwrap_or(ComponentModelSettings {
                version: 0,
                enabled: false,
                connection: None,
            })
        })
    }
    fn write_component_settings(
        &self,
        s: &ApplicationScope,
        expected: u64,
        settings: &ComponentModelSettings,
    ) -> Result<(), ApplicationError> {
        let mut c = self.0.lock().map_err(error)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let before = payload_budget::charged_bytes(&tx, &s.project)?;
        if encode(settings)?.len() > MAX_COMPONENT_SETTINGS_RECORD_BYTES {
            return Err(ApplicationError::Budget(
                "Model settings payload is too large".into(),
            ));
        }
        let version: Option<u64> = tx
            .query_row(
                "SELECT version FROM component_agent_settings WHERE project=?1 AND principal=?2",
                params![s.project, s.principal],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        if version.unwrap_or(0) != expected
            || settings.version != expected.checked_add(1).ok_or(ApplicationError::Conflict)?
        {
            return Err(ApplicationError::Conflict);
        }
        tx.execute("INSERT INTO component_agent_settings VALUES(?1,?2,?3,?4) ON CONFLICT(project,principal) DO UPDATE SET version=excluded.version,value=excluded.value",params![s.project,s.principal,settings.version,encode(settings)?]).map_err(error)?;
        payload_budget::enforce(&tx, &s.project, before)?;
        tx.commit().map_err(error)
    }
    fn commit_component(
        &self,
        s: &ApplicationScope,
        write: ComponentWrite<'_>,
    ) -> Result<(), ApplicationError> {
        let mut c = self.0.lock().map_err(error)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let before = payload_budget::charged_bytes(&tx, &s.project)?;
        let conversation = write.conversation;
        if encode(conversation)?.len() > MAX_COMPONENT_CONVERSATION_RECORD_BYTES {
            return Err(ApplicationError::Budget(
                "Conversation payload is too large".into(),
            ));
        }
        let version:Option<u64>=tx.query_row("SELECT version FROM component_agent_conversations WHERE project=?1 AND principal=?2 AND conversation_id=?3",params![s.project,s.principal,conversation.conversation_id],|r|r.get(0)).optional().map_err(error)?;
        if version != write.expected_version
            || conversation.version
                != version
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or(ApplicationError::Conflict)?
        {
            return Err(ApplicationError::Conflict);
        }
        if version.is_none() {
            let count:usize=tx.query_row("SELECT COUNT(*) FROM component_agent_conversations WHERE project=?1 AND principal=?2",params![s.project,s.principal],|r|r.get(0)).map_err(error)?;
            if count >= MAX_COMPONENT_CONVERSATIONS {
                return Err(ApplicationError::Budget(
                    "Conversation count exceeded".into(),
                ));
            }
        }
        if let Some(run) = write.run {
            if encode(run)?.len() > MAX_COMPONENT_RUN_RECORD_BYTES {
                return Err(ApplicationError::Budget("Run payload is too large".into()));
            }
            if run.run.request.conversation_id != conversation.conversation_id {
                return Err(ApplicationError::Conflict);
            }
            let previous:Option<String>=tx.query_row("SELECT value FROM component_agent_runs WHERE project=?1 AND principal=?2 AND run_id=?3",params![s.project,s.principal,run.run.run_id],|r|r.get(0)).optional().map_err(error)?;
            let previous = previous.map(decode::<StoredComponentRun>).transpose()?;
            if let Some(previous) = &previous
                && (previous.request_digest != run.request_digest
                    || previous.run.request.request_id != run.run.request.request_id)
            {
                return Err(ApplicationError::RequestConflict);
            }
            if previous.is_none() {
                let count:usize=tx.query_row("SELECT COUNT(*) FROM component_agent_runs WHERE host_incarnation=?1 AND state IN ('queued','running','waiting_for_r','needs_input','stopping')",params![run.host_incarnation],|r|r.get(0)).map_err(error)?;
                if count >= MAX_COMPONENT_QUEUED_RUNS {
                    return Err(ApplicationError::Budget(
                        "Component run queue is full".into(),
                    ));
                }
                let count:usize=tx.query_row("SELECT COUNT(*) FROM component_agent_runs WHERE project=?1 AND principal=?2",params![s.project,s.principal],|r|r.get(0)).map_err(error)?;
                if count >= 8192 {
                    return Err(ApplicationError::Budget(
                        "Component run record limit exceeded".into(),
                    ));
                }
            }
            if run.run.state == ComponentAgentRunState::Running
                && previous
                    .as_ref()
                    .is_none_or(|p| p.run.state == ComponentAgentRunState::Queued)
            {
                let count:usize=tx.query_row("SELECT COUNT(*) FROM component_agent_runs WHERE host_incarnation=?1 AND state IN ('running','waiting_for_r','needs_input','stopping')",params![run.host_incarnation],|r|r.get(0)).map_err(error)?;
                if count >= MAX_COMPONENT_RUNNING_RUNS {
                    return Err(ApplicationError::Budget(
                        "Component running slots are full".into(),
                    ));
                }
            }
            let state = encode(&run.run.state)?;
            tx.execute("INSERT INTO component_agent_runs VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(project,principal,run_id) DO UPDATE SET state=excluded.state,event_cursor=excluded.event_cursor,value=excluded.value",params![s.project,s.principal,run.run.run_id,conversation.conversation_id,run.run.request.request_id,run.request_digest,run.host_incarnation,state.trim_matches('"'),run.run.event_cursor,encode(run)?]).map_err(error)?;
        }
        for tool in write.tools {
            if write
                .run
                .is_none_or(|run| run.run.run_id != tool.receipt.run_id)
            {
                return Err(ApplicationError::Conflict);
            }
            let value = encode(tool)?;
            if tool.calls.is_empty()
                || tool.calls.len() > 16
                || tool.calls[0].model_call != tool.receipt.model_call
                || tool.calls[0].tool_call_id != tool.receipt.tool_call_id
            {
                return Err(ApplicationError::Conflict);
            }
            if value.len() > MAX_COMPONENT_TOOL_RECORD_BYTES {
                return Err(ApplicationError::Budget(
                    "Tool receipt exceeds storage limit".into(),
                ));
            }
            let old:Option<String>=tx.query_row("SELECT value FROM component_agent_tools WHERE project=?1 AND principal=?2 AND receipt_id=?3",params![s.project,s.principal,tool.receipt.receipt_id],|r|r.get(0)).optional().map_err(error)?;
            if let Some(old) = old {
                let old: StoredComponentTool = decode(old)?;
                if old.receipt.run_id != tool.receipt.run_id
                    || old.receipt.action_digest != tool.receipt.action_digest
                    || old.receipt.client_request_id != tool.receipt.client_request_id
                    || !tool.calls.starts_with(&old.calls)
                    || encode(&old.action)? != encode(&tool.action)?
                {
                    return Err(ApplicationError::RequestConflict);
                }
            }
            tx.execute("INSERT INTO component_agent_tools VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(project,principal,receipt_id) DO UPDATE SET value=excluded.value",params![s.project,s.principal,tool.receipt.run_id,tool.receipt.receipt_id,tool.receipt.model_call,tool.receipt.tool_call_id,tool.receipt.action_digest,tool.receipt.mutation,value]).map_err(error)?;
        }
        for event in write.events {
            if write.run.is_none_or(|run| {
                run.run.run_id != event.run_id || event.sequence > run.run.event_cursor
            }) {
                return Err(ApplicationError::Conflict);
            }
            let value = encode(event)?;
            if value.len() > 16 * 1024 {
                return Err(ApplicationError::Budget("Event exceeds 16 KiB".into()));
            }
            tx.execute("INSERT INTO component_agent_events(project,principal,conversation_id,run_id,sequence,bytes,value) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![s.project,s.principal,conversation.conversation_id,event.run_id,event.sequence,value.len(),value]).map_err(error)?;
        }
        tx.execute("INSERT INTO component_agent_conversations VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(project,principal,conversation_id) DO UPDATE SET version=excluded.version,active_run_id=excluded.active_run_id,updated_at=excluded.updated_at,value=excluded.value",params![s.project,s.principal,conversation.conversation_id,conversation.version,conversation.active_run_id,conversation.updated_at_ms,encode(conversation)?]).map_err(error)?;
        loop {
            let (count,bytes):(usize,usize)=tx.query_row("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM component_agent_events WHERE project=?1 AND principal=?2 AND conversation_id=?3",params![s.project,s.principal,conversation.conversation_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(error)?;
            if count <= MAX_COMPONENT_EVENTS && bytes <= MAX_COMPONENT_EVENT_BYTES {
                break;
            }
            tx.execute("DELETE FROM component_agent_events WHERE event_order=(SELECT MIN(event_order) FROM component_agent_events WHERE project=?1 AND principal=?2 AND conversation_id=?3)",params![s.project,s.principal,conversation.conversation_id]).map_err(error)?;
        }
        payload_budget::enforce(&tx, &s.project, before)?;
        tx.commit().map_err(error)
    }
}
