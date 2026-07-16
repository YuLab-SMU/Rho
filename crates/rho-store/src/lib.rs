use std::path::Path;

use chrono::Utc;
use rho_protocol::{Envelope, WorkspaceIdentity};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 3;
const DEFAULT_LIMIT: usize = 50;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported schema version: {0}")]
    SchemaVersion(i64),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDraft {
    pub run_id: String,
    pub parent_run_id: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub origin: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub terminal_reason: Option<String>,
    pub request_type: String,
    pub operation_class: String,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    pub document_version: Option<i64>,
    pub workspace_id: Option<String>,
    pub state_revision_before: Option<i64>,
    pub project_revision_before: Option<i64>,
    pub state_revision_after: Option<i64>,
    pub project_revision_after: Option<i64>,
    pub code_preview: String,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProblemSummary {
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub origin: String,
    pub status: String,
    pub message: String,
    pub call: Option<String>,
    pub traceback: Vec<String>,
    pub source_path: Option<String>,
    pub execution_mode: Option<String>,
    pub document_version: Option<i64>,
    pub workspace_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDetail {
    pub run_id: String,
    pub parent_run_id: Option<String>,
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
    pub stdout: Option<String>,
    pub value_text: Option<String>,
    pub messages: Vec<String>,
    pub warnings: Vec<String>,
    pub error_message: Option<String>,
    pub error_call: Option<String>,
    pub traceback: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnDraft {
    pub turn_id: String,
    pub mode: String,
    pub prompt: String,
    pub model: String,
    pub workspace_id: String,
    pub state_revision_before: i64,
    pub project_revision_before: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnFinish {
    pub turn_id: String,
    pub status: String,
    pub workspace_id_after: Option<String>,
    pub state_revision_after: Option<i64>,
    pub project_revision_after: Option<i64>,
    pub final_message: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnSummary {
    pub turn_id: String,
    pub mode: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub prompt_preview: String,
    pub model: String,
    pub workspace_id_before: Option<String>,
    pub state_revision_before: Option<i64>,
    pub project_revision_before: Option<i64>,
    pub workspace_id_after: Option<String>,
    pub state_revision_after: Option<i64>,
    pub project_revision_after: Option<i64>,
    pub final_message: Option<String>,
    pub error_message: Option<String>,
    pub pending_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnEventDraft {
    pub turn_id: String,
    pub event_type: String,
    pub title: String,
    pub body: Option<String>,
    pub status: String,
    pub tool: Option<String>,
    pub request_id: Option<String>,
    pub code: Option<String>,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnEvent {
    pub id: i64,
    pub turn_id: String,
    pub timestamp: String,
    pub event_type: String,
    pub title: String,
    pub body: Option<String>,
    pub status: String,
    pub tool: Option<String>,
    pub request_id: Option<String>,
    pub code: Option<String>,
    pub details_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequestDraft {
    pub request_id: String,
    pub turn_id: String,
    pub tool: String,
    pub policy: String,
    pub arguments_json: String,
    pub code: Option<String>,
    pub workspace_id: String,
    pub state_revision: i64,
    pub project_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalDecisionRecord {
    pub decision: String,
    pub status: String,
    pub reason: Option<String>,
    pub continuation_outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequestSummary {
    pub request_id: String,
    pub turn_id: String,
    pub tool: String,
    pub policy: String,
    pub status: String,
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub arguments_json: String,
    pub code: Option<String>,
    pub workspace_id: Option<String>,
    pub state_revision: Option<i64>,
    pub project_revision: Option<i64>,
    pub requested_at: String,
    pub responded_at: Option<String>,
    pub continuation_outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnDetail {
    pub turn: AgentTurnSummary,
    pub events: Vec<AgentTurnEvent>,
    pub approvals: Vec<ApprovalRequestSummary>,
}

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<(), StoreError> {
        self.connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                timestamp TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                terminal_reason TEXT
            );
            CREATE TABLE IF NOT EXISTS workspace_identity (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_turns (
                turn_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                prompt TEXT NOT NULL,
                prompt_preview TEXT NOT NULL,
                model TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                workspace_id_before TEXT,
                state_revision_before INTEGER,
                project_revision_before INTEGER,
                workspace_id_after TEXT,
                state_revision_after INTEGER,
                project_revision_after INTEGER,
                final_message TEXT,
                error_message TEXT
            );
            CREATE TABLE IF NOT EXISTS agent_turn_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                event_type TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                status TEXT NOT NULL,
                tool TEXT,
                request_id TEXT,
                code TEXT,
                details_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(turn_id) REFERENCES agent_turns(turn_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS approval_requests (
                request_id TEXT PRIMARY KEY,
                turn_id TEXT NOT NULL,
                tool TEXT NOT NULL,
                policy TEXT NOT NULL,
                status TEXT NOT NULL,
                decision TEXT,
                reason TEXT,
                arguments_json TEXT NOT NULL,
                code TEXT,
                workspace_id TEXT,
                state_revision INTEGER,
                project_revision INTEGER,
                requested_at TEXT NOT NULL,
                responded_at TEXT,
                continuation_outcome TEXT,
                FOREIGN KEY(turn_id) REFERENCES agent_turns(turn_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_agent_turns_started_at
                ON agent_turns(started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_turn_events_turn_id
                ON agent_turn_events(turn_id, id);
            CREATE INDEX IF NOT EXISTS idx_approval_requests_turn_id
                ON approval_requests(turn_id, requested_at DESC);
            CREATE INDEX IF NOT EXISTS idx_approval_requests_status
                ON approval_requests(status, requested_at DESC);
            ",
        )?;

        let current: Option<i64> = self
            .connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| value.parse().ok());

        match current {
            None | Some(1) | Some(2) | Some(SCHEMA_VERSION) => {}
            Some(other) => return Err(StoreError::SchemaVersion(other)),
        }

        ensure_column(&self.connection, "runs", "parent_run_id", "TEXT")?;
        ensure_column(
            &self.connection,
            "runs",
            "origin",
            "TEXT NOT NULL DEFAULT 'system'",
        )?;
        ensure_column(
            &self.connection,
            "runs",
            "request_type",
            "TEXT NOT NULL DEFAULT 'workspace.execute'",
        )?;
        ensure_column(
            &self.connection,
            "runs",
            "operation_class",
            "TEXT NOT NULL DEFAULT 'probe'",
        )?;
        ensure_column(&self.connection, "runs", "code", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(
            &self.connection,
            "runs",
            "arguments_json",
            "TEXT NOT NULL DEFAULT '{}'",
        )?;
        ensure_column(&self.connection, "runs", "source_path", "TEXT")?;
        ensure_column(&self.connection, "runs", "execution_mode", "TEXT")?;
        ensure_column(&self.connection, "runs", "document_version", "INTEGER")?;
        ensure_column(&self.connection, "runs", "workspace_id", "TEXT")?;
        ensure_column(&self.connection, "runs", "state_revision_before", "INTEGER")?;
        ensure_column(&self.connection, "runs", "project_revision_before", "INTEGER")?;
        ensure_column(&self.connection, "runs", "state_revision_after", "INTEGER")?;
        ensure_column(&self.connection, "runs", "project_revision_after", "INTEGER")?;
        ensure_column(&self.connection, "runs", "stdout", "TEXT")?;
        ensure_column(&self.connection, "runs", "value_text", "TEXT")?;
        ensure_column(
            &self.connection,
            "runs",
            "messages_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(
            &self.connection,
            "runs",
            "warnings_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(&self.connection, "runs", "error_message", "TEXT")?;
        ensure_column(&self.connection, "runs", "error_call", "TEXT")?;
        ensure_column(
            &self.connection,
            "runs",
            "traceback_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(
            &self.connection,
            "runs",
            "cancel_requested",
            "INTEGER NOT NULL DEFAULT 0",
        )?;

        self.connection.execute(
            "INSERT INTO metadata(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }

    pub fn append_event(&mut self, event: &Envelope) -> Result<i64, StoreError> {
        let payload = serde_json::to_string(&event.payload)?;
        let kind = serde_json::to_string(&event.kind)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO events(event_id, timestamp, kind, payload) VALUES(?1, ?2, ?3, ?4)",
            params![event.id, event.timestamp, kind, payload],
        )?;
        let seq = transaction.last_insert_rowid();
        transaction.commit()?;
        Ok(seq)
    }

    pub fn save_identity(&mut self, identity: &WorkspaceIdentity) -> Result<(), StoreError> {
        let payload = serde_json::to_string(identity)?;
        self.connection.execute(
            "INSERT INTO workspace_identity(singleton, payload) VALUES(1, ?1)
             ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload",
            [payload],
        )?;
        Ok(())
    }

    pub fn load_identity(&self) -> Result<Option<WorkspaceIdentity>, StoreError> {
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT payload FROM workspace_identity WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        payload
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(StoreError::from)
    }

    pub fn event_count(&self) -> Result<u64, StoreError> {
        self.connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .map_err(StoreError::from)
    }

    pub fn create_run(&mut self, draft: &RunDraft) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO runs(
                run_id, parent_run_id, origin, status, started_at, request_type,
                operation_class, code, arguments_json, source_path, execution_mode,
                document_version, workspace_id, state_revision_before,
                project_revision_before, cancel_requested
             ) VALUES(
                ?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0
             )",
            params![
                draft.run_id,
                draft.parent_run_id,
                draft.origin,
                Utc::now().to_rfc3339(),
                draft.request_type,
                draft.operation_class,
                draft.code,
                draft.arguments_json,
                draft.source_path,
                draft.execution_mode,
                draft.document_version,
                draft.workspace_id,
                draft.state_revision_before,
                draft.project_revision_before,
            ],
        )?;
        Ok(())
    }

    pub fn update_run_status(
        &mut self,
        run_id: &str,
        status: &str,
        terminal_reason: Option<&str>,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE runs
             SET status = ?2,
                 terminal_reason = COALESCE(?3, terminal_reason)
             WHERE run_id = ?1",
            params![run_id, status, terminal_reason],
        )?;
        Ok(changed)
    }

    pub fn finish_run(&mut self, result: &RunFinish) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE runs
             SET status = ?2,
                 finished_at = ?3,
                 terminal_reason = ?4,
                 workspace_id = COALESCE(?5, workspace_id),
                 state_revision_after = ?6,
                 project_revision_after = ?7,
                 stdout = ?8,
                 value_text = ?9,
                 messages_json = ?10,
                 warnings_json = ?11,
                 error_message = ?12,
                 error_call = ?13,
                 traceback_json = ?14,
                 cancel_requested = 0
             WHERE run_id = ?1",
            params![
                result.run_id,
                result.status,
                Utc::now().to_rfc3339(),
                result.terminal_reason,
                result.workspace_id,
                result.state_revision_after,
                result.project_revision_after,
                result.stdout,
                result.value_text,
                serde_json::to_string(&result.messages)?,
                serde_json::to_string(&result.warnings)?,
                result.error_message,
                result.error_call,
                serde_json::to_string(&result.traceback)?,
            ],
        )?;
        Ok(())
    }

    pub fn request_cancel(&mut self, run_id: &str) -> Result<bool, StoreError> {
        let changed = self.connection.execute(
            "UPDATE runs
             SET cancel_requested = 1,
                 terminal_reason = 'cancel_requested'
             WHERE run_id = ?1 AND status IN ('queued', 'running', 'waiting')",
            [run_id],
        )?;
        Ok(changed > 0)
    }

    pub fn cancel_requested(&self, run_id: &str) -> Result<bool, StoreError> {
        let requested = self.connection.query_row(
            "SELECT cancel_requested FROM runs WHERE run_id = ?1",
            [run_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(requested != 0)
    }

    pub fn latest_active_run_id(&self) -> Result<Option<String>, StoreError> {
        self.connection
            .query_row(
                "SELECT run_id FROM runs
                 WHERE status IN ('queued', 'running', 'waiting')
                 ORDER BY started_at DESC
                 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_runs(&self, limit: Option<usize>) -> Result<Vec<RunSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                run_id, parent_run_id, origin, status, started_at, finished_at,
                terminal_reason, request_type, operation_class, code, source_path,
                execution_mode, document_version, workspace_id,
                state_revision_before, project_revision_before,
                state_revision_after, project_revision_after, error_message
             FROM runs
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.unwrap_or(DEFAULT_LIMIT) as i64], |row| {
            let code: String = row.get(9)?;
            Ok(RunSummary {
                run_id: row.get(0)?,
                parent_run_id: row.get(1)?,
                origin: row.get(2)?,
                status: row.get(3)?,
                started_at: row.get(4)?,
                finished_at: row.get(5)?,
                terminal_reason: row.get(6)?,
                request_type: row.get(7)?,
                operation_class: row.get(8)?,
                source_path: row.get(10)?,
                execution_mode: row.get(11)?,
                document_version: row.get(12)?,
                workspace_id: row.get(13)?,
                state_revision_before: row.get(14)?,
                project_revision_before: row.get(15)?,
                state_revision_after: row.get(16)?,
                project_revision_after: row.get(17)?,
                code_preview: code_preview(&code),
                error_message: row.get(18)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn list_problems(&self, limit: Option<usize>) -> Result<Vec<ProblemSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                run_id, parent_run_id, origin, status, error_message, error_call,
                traceback_json, source_path, execution_mode, document_version,
                workspace_id, started_at, finished_at
             FROM runs
             WHERE error_message IS NOT NULL
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.unwrap_or(DEFAULT_LIMIT) as i64], |row| {
            let traceback: String = row.get(6)?;
            Ok(ProblemSummary {
                run_id: row.get(0)?,
                parent_run_id: row.get(1)?,
                origin: row.get(2)?,
                status: row.get(3)?,
                message: row.get(4)?,
                call: row.get(5)?,
                traceback: decode_string_list(&traceback).map_err(sqlite_function_error)?,
                source_path: row.get(7)?,
                execution_mode: row.get(8)?,
                document_version: row.get(9)?,
                workspace_id: row.get(10)?,
                started_at: row.get(11)?,
                finished_at: row.get(12)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn get_run_detail(&self, run_id: &str) -> Result<Option<RunDetail>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    run_id, parent_run_id, origin, status, started_at, finished_at,
                    terminal_reason, request_type, operation_class, code, arguments_json,
                    source_path, execution_mode, document_version, workspace_id,
                    state_revision_before, project_revision_before,
                    state_revision_after, project_revision_after,
                    stdout, value_text, messages_json, warnings_json,
                    error_message, error_call, traceback_json
                 FROM runs
                 WHERE run_id = ?1",
                [run_id],
                decode_run_detail,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn recover_incomplete_runs(&mut self) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE runs
             SET status = 'interrupted',
                 finished_at = ?1,
                 terminal_reason = CASE
                    WHEN cancel_requested != 0 THEN 'cancelled_during_restart'
                    ELSE 'broker_restart'
                 END,
                 cancel_requested = 0
             WHERE status IN ('queued', 'running', 'waiting')",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(changed)
    }

    pub fn create_agent_turn(&mut self, draft: &AgentTurnDraft) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO agent_turns(
                turn_id, mode, prompt, prompt_preview, model, status, started_at,
                workspace_id_before, state_revision_before, project_revision_before
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7, ?8, ?9
             )",
            params![
                draft.turn_id,
                draft.mode,
                draft.prompt,
                text_preview(&draft.prompt, 120),
                draft.model,
                Utc::now().to_rfc3339(),
                draft.workspace_id,
                draft.state_revision_before,
                draft.project_revision_before,
            ],
        )?;
        Ok(())
    }

    pub fn update_agent_turn_status(
        &mut self,
        turn_id: &str,
        status: &str,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE agent_turns
             SET status = ?2
             WHERE turn_id = ?1",
            params![turn_id, status],
        )?;
        Ok(changed)
    }

    pub fn finish_agent_turn(&mut self, result: &AgentTurnFinish) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE agent_turns
             SET status = ?2,
                 finished_at = ?3,
                 workspace_id_after = COALESCE(?4, workspace_id_after),
                 state_revision_after = ?5,
                 project_revision_after = ?6,
                 final_message = ?7,
                 error_message = ?8
             WHERE turn_id = ?1",
            params![
                result.turn_id,
                result.status,
                Utc::now().to_rfc3339(),
                result.workspace_id_after,
                result.state_revision_after,
                result.project_revision_after,
                result.final_message,
                result.error_message,
            ],
        )?;
        Ok(())
    }

    pub fn append_agent_turn_event(
        &mut self,
        event: &AgentTurnEventDraft,
    ) -> Result<i64, StoreError> {
        self.connection.execute(
            "INSERT INTO agent_turn_events(
                turn_id, timestamp, event_type, title, body, status, tool, request_id, code, details_json
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
             )",
            params![
                event.turn_id,
                Utc::now().to_rfc3339(),
                event.event_type,
                event.title,
                event.body,
                event.status,
                event.tool,
                event.request_id,
                event.code,
                event.details_json,
            ],
        )?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn create_approval_request(
        &mut self,
        draft: &ApprovalRequestDraft,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO approval_requests(
                request_id, turn_id, tool, policy, status, arguments_json, code,
                workspace_id, state_revision, project_revision, requested_at
             ) VALUES(
                ?1, ?2, ?3, ?4, 'waiting', ?5, ?6, ?7, ?8, ?9, ?10
             )",
            params![
                draft.request_id,
                draft.turn_id,
                draft.tool,
                draft.policy,
                draft.arguments_json,
                draft.code,
                draft.workspace_id,
                draft.state_revision,
                draft.project_revision,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn resolve_approval_request(
        &mut self,
        request_id: &str,
        decision: &ApprovalDecisionRecord,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE approval_requests
             SET status = ?2,
                 decision = ?3,
                 reason = ?4,
                 continuation_outcome = ?5,
                 responded_at = ?6
             WHERE request_id = ?1",
            params![
                request_id,
                decision.status,
                decision.decision,
                decision.reason,
                decision.continuation_outcome,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(changed)
    }

    pub fn list_agent_turns(
        &self,
        limit: Option<usize>,
    ) -> Result<Vec<AgentTurnSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                turn_id, mode, status, started_at, finished_at, prompt_preview, model,
                workspace_id_before, state_revision_before, project_revision_before,
                workspace_id_after, state_revision_after, project_revision_after,
                final_message, error_message,
                (
                    SELECT request_id
                    FROM approval_requests
                    WHERE approval_requests.turn_id = agent_turns.turn_id
                      AND status = 'waiting'
                    ORDER BY requested_at DESC
                    LIMIT 1
                ) AS pending_request_id
             FROM agent_turns
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.unwrap_or(DEFAULT_LIMIT) as i64], |row| {
            Ok(AgentTurnSummary {
                turn_id: row.get(0)?,
                mode: row.get(1)?,
                status: row.get(2)?,
                started_at: row.get(3)?,
                finished_at: row.get(4)?,
                prompt_preview: row.get(5)?,
                model: row.get(6)?,
                workspace_id_before: row.get(7)?,
                state_revision_before: row.get(8)?,
                project_revision_before: row.get(9)?,
                workspace_id_after: row.get(10)?,
                state_revision_after: row.get(11)?,
                project_revision_after: row.get(12)?,
                final_message: row.get(13)?,
                error_message: row.get(14)?,
                pending_request_id: row.get(15)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn list_approval_requests(
        &self,
        limit: Option<usize>,
        status: Option<&str>,
    ) -> Result<Vec<ApprovalRequestSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                request_id, turn_id, tool, policy, status, decision, reason,
                arguments_json, code, workspace_id, state_revision, project_revision,
                requested_at, responded_at, continuation_outcome
             FROM approval_requests
             WHERE (?2 IS NULL OR status = ?2)
             ORDER BY requested_at DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(
            params![limit.unwrap_or(DEFAULT_LIMIT) as i64, status],
            decode_approval_request,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn get_agent_turn_detail(
        &self,
        turn_id: &str,
    ) -> Result<Option<AgentTurnDetail>, StoreError> {
        let turn = self
            .connection
            .query_row(
                "SELECT
                    turn_id, mode, status, started_at, finished_at, prompt_preview, model,
                    workspace_id_before, state_revision_before, project_revision_before,
                    workspace_id_after, state_revision_after, project_revision_after,
                    final_message, error_message,
                    (
                        SELECT request_id
                        FROM approval_requests
                        WHERE approval_requests.turn_id = agent_turns.turn_id
                          AND status = 'waiting'
                        ORDER BY requested_at DESC
                        LIMIT 1
                    ) AS pending_request_id
                 FROM agent_turns
                 WHERE turn_id = ?1",
                [turn_id],
                decode_agent_turn_summary,
            )
            .optional()?;
        let Some(turn) = turn else {
            return Ok(None);
        };
        let mut event_statement = self.connection.prepare(
            "SELECT
                id, turn_id, timestamp, event_type, title, body, status, tool, request_id, code, details_json
             FROM agent_turn_events
             WHERE turn_id = ?1
             ORDER BY id ASC",
        )?;
        let event_rows = event_statement.query_map([turn_id], decode_agent_turn_event)?;
        let events = event_rows.collect::<Result<Vec<_>, _>>()?;

        let mut approval_statement = self.connection.prepare(
            "SELECT
                request_id, turn_id, tool, policy, status, decision, reason,
                arguments_json, code, workspace_id, state_revision, project_revision,
                requested_at, responded_at, continuation_outcome
             FROM approval_requests
             WHERE turn_id = ?1
             ORDER BY requested_at DESC",
        )?;
        let approval_rows = approval_statement.query_map([turn_id], decode_approval_request)?;
        let approvals = approval_rows.collect::<Result<Vec<_>, _>>()?;

        Ok(Some(AgentTurnDetail {
            turn,
            events,
            approvals,
        }))
    }

    pub fn recover_incomplete_agent_turns(&mut self) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE agent_turns
             SET status = 'interrupted',
                 finished_at = ?1,
                 error_message = COALESCE(error_message, 'Agent turn interrupted by desktop restart')
             WHERE status IN ('running', 'waiting')",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(changed)
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), StoreError> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&pragma)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let columns = rows.collect::<Result<Vec<_>, _>>()?;
    if columns.iter().any(|value| value == column) {
        return Ok(());
    }
    connection.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )?;
    Ok(())
}

fn decode_run_detail(row: &Row<'_>) -> rusqlite::Result<RunDetail> {
    let messages: String = row.get(21)?;
    let warnings: String = row.get(22)?;
    let traceback: String = row.get(25)?;
    Ok(RunDetail {
        run_id: row.get(0)?,
        parent_run_id: row.get(1)?,
        origin: row.get(2)?,
        status: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        terminal_reason: row.get(6)?,
        request_type: row.get(7)?,
        operation_class: row.get(8)?,
        code: row.get(9)?,
        arguments_json: row.get(10)?,
        source_path: row.get(11)?,
        execution_mode: row.get(12)?,
        document_version: row.get(13)?,
        workspace_id: row.get(14)?,
        state_revision_before: row.get(15)?,
        project_revision_before: row.get(16)?,
        state_revision_after: row.get(17)?,
        project_revision_after: row.get(18)?,
        stdout: row.get(19)?,
        value_text: row.get(20)?,
        messages: decode_string_list(&messages).map_err(sqlite_function_error)?,
        warnings: decode_string_list(&warnings).map_err(sqlite_function_error)?,
        error_message: row.get(23)?,
        error_call: row.get(24)?,
        traceback: decode_string_list(&traceback).map_err(sqlite_function_error)?,
    })
}

fn decode_agent_turn_summary(row: &Row<'_>) -> rusqlite::Result<AgentTurnSummary> {
    Ok(AgentTurnSummary {
        turn_id: row.get(0)?,
        mode: row.get(1)?,
        status: row.get(2)?,
        started_at: row.get(3)?,
        finished_at: row.get(4)?,
        prompt_preview: row.get(5)?,
        model: row.get(6)?,
        workspace_id_before: row.get(7)?,
        state_revision_before: row.get(8)?,
        project_revision_before: row.get(9)?,
        workspace_id_after: row.get(10)?,
        state_revision_after: row.get(11)?,
        project_revision_after: row.get(12)?,
        final_message: row.get(13)?,
        error_message: row.get(14)?,
        pending_request_id: row.get(15)?,
    })
}

fn decode_agent_turn_event(row: &Row<'_>) -> rusqlite::Result<AgentTurnEvent> {
    Ok(AgentTurnEvent {
        id: row.get(0)?,
        turn_id: row.get(1)?,
        timestamp: row.get(2)?,
        event_type: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        status: row.get(6)?,
        tool: row.get(7)?,
        request_id: row.get(8)?,
        code: row.get(9)?,
        details_json: row.get(10)?,
    })
}

fn decode_approval_request(row: &Row<'_>) -> rusqlite::Result<ApprovalRequestSummary> {
    Ok(ApprovalRequestSummary {
        request_id: row.get(0)?,
        turn_id: row.get(1)?,
        tool: row.get(2)?,
        policy: row.get(3)?,
        status: row.get(4)?,
        decision: row.get(5)?,
        reason: row.get(6)?,
        arguments_json: row.get(7)?,
        code: row.get(8)?,
        workspace_id: row.get(9)?,
        state_revision: row.get(10)?,
        project_revision: row.get(11)?,
        requested_at: row.get(12)?,
        responded_at: row.get(13)?,
        continuation_outcome: row.get(14)?,
    })
}

fn decode_string_list(input: &str) -> Result<Vec<String>, serde_json::Error> {
    serde_json::from_str(input)
}

fn sqlite_function_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(error),
    )
}

fn code_preview(code: &str) -> String {
    let first_line = code.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
    let trimmed = first_line.trim();
    let mut preview = trimmed.chars().take(80).collect::<String>();
    if trimmed.chars().count() > 80 {
        preview.push('…');
    }
    if preview.is_empty() {
        "<empty>".to_string()
    } else {
        preview
    }
}

fn text_preview(text: &str, limit: usize) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim();
    let mut preview = trimmed.chars().take(limit).collect::<String>();
    if trimmed.chars().count() > limit {
        preview.push('…');
    }
    if preview.is_empty() {
        "<empty>".to_string()
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_protocol::{MessageKind, WorkspaceIdentity};
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn persists_identity_and_events() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let identity = WorkspaceIdentity::new("ws_test");
        store.save_identity(&identity).unwrap();
        assert_eq!(store.load_identity().unwrap(), Some(identity));

        let event = Envelope::new(MessageKind::Event, json!({"kind": "test"}));
        assert_eq!(store.append_event(&event).unwrap(), 1);
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn persists_run_summaries_and_problems() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_run(&RunDraft {
                run_id: "run_1".to_string(),
                parent_run_id: None,
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "state_capable".to_string(),
                code: "stop('boom')".to_string(),
                arguments_json: "{\"code\":\"stop('boom')\"}".to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("selection".to_string()),
                document_version: Some(7),
                workspace_id: "ws_test".to_string(),
                state_revision_before: 1,
                project_revision_before: 0,
            })
            .unwrap();
        store.update_run_status("run_1", "running", None).unwrap();
        store
            .finish_run(&RunFinish {
                run_id: "run_1".to_string(),
                status: "failed".to_string(),
                terminal_reason: Some("r_error".to_string()),
                workspace_id: Some("ws_test".to_string()),
                state_revision_after: Some(2),
                project_revision_after: Some(0),
                stdout: Some(String::new()),
                value_text: None,
                messages: vec!["hello".to_string()],
                warnings: vec!["careful".to_string()],
                error_message: Some("boom".to_string()),
                error_call: Some("stop(\"boom\")".to_string()),
                traceback: vec!["stop(\"boom\")".to_string()],
            })
            .unwrap();

        let runs = store.list_runs(None).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "failed");
        assert_eq!(runs[0].code_preview, "stop('boom')");

        let problems = store.list_problems(None).unwrap();
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].message, "boom");

        let detail = store.get_run_detail("run_1").unwrap().unwrap();
        assert_eq!(detail.messages, vec!["hello".to_string()]);
        assert_eq!(detail.traceback, vec!["stop(\"boom\")".to_string()]);
    }

    #[test]
    fn recovers_active_runs() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_run(&RunDraft {
                run_id: "run_1".to_string(),
                parent_run_id: None,
                origin: "system".to_string(),
                request_type: "workspace.snapshot".to_string(),
                operation_class: "probe".to_string(),
                code: "snapshot".to_string(),
                arguments_json: "{}".to_string(),
                source_path: None,
                execution_mode: None,
                document_version: None,
                workspace_id: "ws_test".to_string(),
                state_revision_before: 0,
                project_revision_before: 0,
            })
            .unwrap();
        store.update_run_status("run_1", "running", None).unwrap();
        assert_eq!(store.recover_incomplete_runs().unwrap(), 1);
        assert_eq!(store.recover_incomplete_runs().unwrap(), 0);
        let detail = store.get_run_detail("run_1").unwrap().unwrap();
        assert_eq!(detail.status, "interrupted");
        assert_eq!(detail.terminal_reason.as_deref(), Some("broker_restart"));
    }

    #[test]
    fn persists_agent_turns_and_approval_requests() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: "turn_1".to_string(),
                mode: "act".to_string(),
                prompt: "请汇总 qc".to_string(),
                model: "deepseek:deepseek-v4-flash".to_string(),
                workspace_id: "ws_test".to_string(),
                state_revision_before: 3,
                project_revision_before: 1,
            })
            .unwrap();
        store
            .append_agent_turn_event(&AgentTurnEventDraft {
                turn_id: "turn_1".to_string(),
                event_type: "agent.user_prompt".to_string(),
                title: "You".to_string(),
                body: Some("请汇总 qc".to_string()),
                status: "completed".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: "{}".to_string(),
            })
            .unwrap();
        store
            .create_approval_request(&ApprovalRequestDraft {
                request_id: "req_1".to_string(),
                turn_id: "turn_1".to_string(),
                tool: "run_r".to_string(),
                policy: "required".to_string(),
                arguments_json: "{\"code\":\"summary(qc)\"}".to_string(),
                code: Some("summary(qc)".to_string()),
                workspace_id: "ws_test".to_string(),
                state_revision: 3,
                project_revision: 1,
            })
            .unwrap();

        let turns = store.list_agent_turns(None).unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].pending_request_id.as_deref(), Some("req_1"));

        store
            .resolve_approval_request(
                "req_1",
                &ApprovalDecisionRecord {
                    decision: "approve".to_string(),
                    status: "approved".to_string(),
                    reason: None,
                    continuation_outcome: Some("execute".to_string()),
                },
            )
            .unwrap();
        store
            .finish_agent_turn(&AgentTurnFinish {
                turn_id: "turn_1".to_string(),
                status: "completed".to_string(),
                workspace_id_after: Some("ws_test".to_string()),
                state_revision_after: Some(4),
                project_revision_after: Some(1),
                final_message: Some("已完成".to_string()),
                error_message: None,
            })
            .unwrap();

        let detail = store.get_agent_turn_detail("turn_1").unwrap().unwrap();
        assert_eq!(detail.turn.status, "completed");
        assert_eq!(detail.events.len(), 1);
        assert_eq!(detail.approvals.len(), 1);
        assert_eq!(detail.approvals[0].status, "approved");
        assert_eq!(
            detail.approvals[0].continuation_outcome.as_deref(),
            Some("execute")
        );
    }

    #[test]
    fn recovers_incomplete_agent_turns() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: "turn_1".to_string(),
                mode: "act".to_string(),
                prompt: "run something".to_string(),
                model: "test".to_string(),
                workspace_id: "ws_test".to_string(),
                state_revision_before: 1,
                project_revision_before: 0,
            })
            .unwrap();
        store.update_agent_turn_status("turn_1", "waiting").unwrap();
        assert_eq!(store.recover_incomplete_agent_turns().unwrap(), 1);
        let detail = store.get_agent_turn_detail("turn_1").unwrap().unwrap();
        assert_eq!(detail.turn.status, "interrupted");
        assert!(detail.turn.error_message.is_some());
    }
}
