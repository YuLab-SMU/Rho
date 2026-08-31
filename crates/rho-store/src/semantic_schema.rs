use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

pub const SEMANTIC_SCHEMA_VERSION: i64 = 1;
pub const SEMANTIC_SCHEMA_FINGERPRINT: &str = "rho.semantic.baseline.v1.p4-03.2026-08-30";
pub const MAX_SEMANTIC_PAYLOAD_BYTES: i64 = 512 * 1024;

const BASELINE_SQL: &str = r#"
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS semantic_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY NOT NULL,
  stream_id TEXT NOT NULL,
  stream_seq INTEGER NOT NULL CHECK (stream_seq >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'message_completed', 'plan_replaced', 'plan_step_transition',
    'capability_requested', 'session_changed', 'turn_completed', 'turn_failed',
    'policy_decision_recorded', 'execution_state_changed', 'revision_advanced',
    'artifact_committed', 'recovery_recorded', 'security_violation'
  )),
  priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
  channel TEXT NOT NULL CHECK (channel = 'semantic_durable'),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  workspace_id TEXT,
  kernel_instance_id TEXT,
  session_id TEXT,
  run_id TEXT,
  turn_id TEXT,
  tool_call_id TEXT,
  execution_id TEXT,
  job_id TEXT,
  operation_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  trace_id TEXT NOT NULL,
  state_revision_before INTEGER CHECK (state_revision_before IS NULL OR state_revision_before >= 0),
  state_revision_after INTEGER CHECK (state_revision_after IS NULL OR state_revision_after >= 0),
  project_revision_before INTEGER CHECK (project_revision_before IS NULL OR project_revision_before >= 0),
  project_revision_after INTEGER CHECK (project_revision_after IS NULL OR project_revision_after >= 0),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'project_internal', 'project_confidential', 'restricted_secret')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 0 AND 524288),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms >= occurred_at_ms),
  UNIQUE (stream_id, stream_seq)
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  current_state TEXT NOT NULL,
  created_event_id TEXT NOT NULL REFERENCES events(event_id)
);
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  state TEXT NOT NULL,
  goal_digest TEXT NOT NULL,
  opened_event_id TEXT NOT NULL REFERENCES events(event_id),
  terminal_event_id TEXT REFERENCES events(event_id)
);
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(turn_id),
  state TEXT NOT NULL,
  replaced_by_plan_id TEXT REFERENCES plans(plan_id),
  source_event_id TEXT NOT NULL REFERENCES events(event_id)
);
CREATE TABLE IF NOT EXISTS steps (
  step_id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  state TEXT NOT NULL,
  label TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  UNIQUE (plan_id, ordinal)
);
CREATE TABLE IF NOT EXISTS tool_calls (
  tool_call_id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(turn_id),
  capability_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  expected_state_revision INTEGER,
  expected_project_revision INTEGER,
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  UNIQUE (operation_id)
);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  effect_class TEXT NOT NULL,
  destination_class TEXT NOT NULL,
  state TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  decision_event_id TEXT REFERENCES events(event_id),
  UNIQUE (operation_id, capability_id)
);
CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  state TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  terminal_event_id TEXT REFERENCES events(event_id),
  UNIQUE (operation_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  lane_id TEXT NOT NULL,
  state TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  terminal_event_id TEXT REFERENCES events(event_id)
);
CREATE TABLE IF NOT EXISTS revisions (
  workspace_id TEXT NOT NULL,
  kernel_instance_id TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  PRIMARY KEY (workspace_id, kernel_instance_id, state_revision, project_revision)
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  digest TEXT NOT NULL CHECK (digest GLOB 'sha256:[0-9a-f]*' AND length(digest) = 71),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  media_type TEXT NOT NULL,
  producer_execution_id TEXT REFERENCES executions(execution_id),
  revision_event_id TEXT NOT NULL REFERENCES events(event_id),
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  UNIQUE (digest)
);
CREATE TABLE IF NOT EXISTS edges (
  edge_id TEXT PRIMARY KEY NOT NULL,
  from_object_id TEXT NOT NULL,
  to_object_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('temporal', 'causal', 'operational', 'scientific')),
  source_event_id TEXT NOT NULL REFERENCES events(event_id)
);
CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  source_state_revision INTEGER NOT NULL CHECK (source_state_revision >= 0),
  source_project_revision INTEGER NOT NULL CHECK (source_project_revision >= 0),
  restore_strategy TEXT NOT NULL CHECK (restore_strategy IN ('exact', 'partial', 'restart_required', 'non_reversible')),
  environment_ref TEXT NOT NULL,
  code_ref TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES events(event_id)
);
CREATE TABLE IF NOT EXISTS provider_sessions (
  provider_session_id TEXT PRIMARY KEY NOT NULL,
  logical_session_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  capability_snapshot_digest TEXT NOT NULL,
  supports_resume INTEGER NOT NULL CHECK (supports_resume IN (0, 1)),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('created', 'active', 'closed', 'lost')),
  continuity_mode TEXT NOT NULL CHECK (continuity_mode IN ('exact_resume', 'new_provider_session_rehydrated', 'model_context_reset')),
  process_incarnation INTEGER NOT NULL CHECK (process_incarnation >= 0),
  source_event_id TEXT NOT NULL,
  closed_event_id TEXT,
  UNIQUE (logical_session_id, provider_id, external_session_id, process_incarnation)
);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_logical
  ON provider_sessions(logical_session_id, lifecycle);
CREATE TABLE IF NOT EXISTS current_projection (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  source_event_id TEXT NOT NULL REFERENCES events(event_id)
);
CREATE TABLE IF NOT EXISTS terminal_revision_dedupe (
  terminal_event_id TEXT PRIMARY KEY NOT NULL,
  execution_id TEXT NOT NULL,
  state_revision_after INTEGER NOT NULL CHECK (state_revision_after >= 0),
  project_revision_after INTEGER NOT NULL CHECK (project_revision_after >= 0)
);
CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);
CREATE INDEX IF NOT EXISTS idx_events_operation ON events(operation_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation_kind);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticOpenStatus {
    Created,
    Opened,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticOpenOutcome {
    pub status: SemanticOpenStatus,
    pub path: PathBuf,
    pub schema_version: i64,
    pub fingerprint: String,
}

#[derive(Debug, Error)]
pub enum SemanticStoreError {
    #[error("semantic store path is outside app-local root")]
    OutsideAppRoot,
    #[error("network database placement is not allowed")]
    NetworkPlacement,
    #[error("semantic schema fingerprint mismatch: expected {expected}, actual {actual}")]
    InvalidSchema { expected: String, actual: String },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

pub struct SemanticStore {
    pub(crate) conn: Connection,
    path: PathBuf,
}

impl SemanticStore {
    pub fn open_app_local(
        app_data_root: impl AsRef<Path>,
        db_path: impl AsRef<Path>,
    ) -> Result<(Self, SemanticOpenOutcome), SemanticStoreError> {
        let app_data_root = app_data_root.as_ref();
        let db_path = db_path.as_ref();
        ensure_app_local_path(app_data_root, db_path)?;
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let created = !db_path.exists();
        let conn = Connection::open(db_path)?;
        configure_connection(&conn)?;
        let store = Self {
            conn,
            path: db_path.to_path_buf(),
        };
        if created || !store.has_metadata_table()? {
            store.bootstrap_baseline()?;
        } else {
            store.validate_fingerprint()?;
        }
        let outcome = SemanticOpenOutcome {
            status: if created {
                SemanticOpenStatus::Created
            } else {
                SemanticOpenStatus::Opened
            },
            path: db_path.to_path_buf(),
            schema_version: SEMANTIC_SCHEMA_VERSION,
            fingerprint: SEMANTIC_SCHEMA_FINGERPRINT.to_string(),
        };
        Ok((store, outcome))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn schema_sql(&self) -> Result<String, SemanticStoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN ('table', 'index') ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut sql = String::new();
        for row in rows {
            sql.push_str(&row?);
            sql.push('\n');
        }
        Ok(sql)
    }

    fn has_metadata_table(&self) -> Result<bool, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'semantic_metadata'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
    }

    fn bootstrap_baseline(&self) -> Result<(), SemanticStoreError> {
        self.conn.execute_batch(BASELINE_SQL)?;
        self.conn
            .pragma_update(None, "user_version", SEMANTIC_SCHEMA_VERSION)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO semantic_metadata(key, value) VALUES ('schema_fingerprint', ?1)",
            params![SEMANTIC_SCHEMA_FINGERPRINT],
        )?;
        self.conn.execute(
            "INSERT OR REPLACE INTO semantic_metadata(key, value) VALUES ('schema_version', ?1)",
            params![SEMANTIC_SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }

    fn validate_fingerprint(&self) -> Result<(), SemanticStoreError> {
        let actual: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM semantic_metadata WHERE key = 'schema_fingerprint'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match actual.as_deref() {
            Some(SEMANTIC_SCHEMA_FINGERPRINT) => Ok(()),
            Some(actual) => Err(SemanticStoreError::InvalidSchema {
                expected: SEMANTIC_SCHEMA_FINGERPRINT.to_string(),
                actual: actual.to_string(),
            }),
            None => Err(SemanticStoreError::InvalidSchema {
                expected: SEMANTIC_SCHEMA_FINGERPRINT.to_string(),
                actual: "<missing>".to_string(),
            }),
        }
    }
}

pub fn development_reset_semantic_db(
    app_data_root: impl AsRef<Path>,
    db_path: impl AsRef<Path>,
) -> Result<Vec<PathBuf>, SemanticStoreError> {
    let app_data_root = app_data_root.as_ref();
    let db_path = db_path.as_ref();
    ensure_app_local_path(app_data_root, db_path)?;
    let mut removed = Vec::new();
    for candidate in [
        db_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", db_path.display())),
        PathBuf::from(format!("{}-shm", db_path.display())),
    ] {
        if candidate.exists() {
            fs::remove_file(&candidate)?;
            removed.push(candidate);
        }
    }
    Ok(removed)
}

fn configure_connection(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

fn ensure_app_local_path(app_data_root: &Path, db_path: &Path) -> Result<(), SemanticStoreError> {
    let text = db_path.to_string_lossy();
    if text.starts_with("//") || text.starts_with("\\\\") || text.starts_with("smb://") {
        return Err(SemanticStoreError::NetworkPlacement);
    }
    if !db_path.starts_with(app_data_root) {
        return Err(SemanticStoreError::OutsideAppRoot);
    }
    Ok(())
}
