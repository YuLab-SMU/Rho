use std::path::{Path, PathBuf};

use chrono::Utc;
use rho_protocol::{Envelope, WorkspaceIdentity};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub(crate) const SCHEMA_VERSION: i64 = 12;
const DEFAULT_LIMIT: usize = 50;
const MAX_AGENT_LIST_LIMIT: usize = 100;
const MAX_DIAGNOSTIC_LINE: u32 = 10_000_000;
const MAX_DIAGNOSTIC_COLUMN: u32 = 1_000_000;
#[cfg(test)]
pub(crate) const LEGACY_UNSCOPED: &str = "legacy_unscoped";

mod agent;
mod artifact;
mod audit;
mod compare;
mod environment;
mod evidence;
mod migration;
mod project;
mod run;
mod workbench;

pub use agent::{
    AgentConversationDraft, AgentConversationSummary, AgentConversationTurn, AgentTurnDetail,
    AgentTurnDraft, AgentTurnEvent, AgentTurnEventDraft, AgentTurnFinish, AgentTurnSummary,
    ApprovalDecisionRecord, ApprovalRequestDraft, ApprovalRequestSummary,
};
pub use artifact::{
    ArtifactRecordDraft, ArtifactRecordSummary, PlotArtifactDraft, PlotArtifactSummary,
};
pub use audit::*;
pub use compare::{
    CompareField, CompareFieldEntry, CompareRunsResponse, CompareSection, CompareSummary,
};
pub use environment::{
    EnvironmentOperationDecisionRecord, EnvironmentOperationFinish,
    EnvironmentOperationRequestDraft, EnvironmentOperationRequestSummary, EnvironmentSnapshotDraft,
    EnvironmentSnapshotRecord,
};
pub use evidence::{
    ClaimReviewStatus, EvidenceClaim, EvidenceClaimDraft, EvidenceClaimReview, EvidenceEntry,
    EvidenceEntryDraft,
};
pub use project::{
    PlotPayloadPruneResult, ProjectRetentionSummary, RetentionPolicy, RetentionScopeSummary,
};
pub use run::{ProblemSummary, RunDetail, RunDraft, RunErrorRange, RunFinish, RunSummary};

pub fn normalize_project_root(root: &str) -> String {
    let normalized = root.replace('\\', "/");
    if normalized.ends_with(":/") {
        return normalized;
    }
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() && normalized.starts_with('/') {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn validate_run_error_range(range: &RunErrorRange) -> Result<(), StoreError> {
    let ordered = range.end_line > range.start_line
        || (range.end_line == range.start_line && range.end_column > range.start_column);
    if range.start_line == 0
        || range.start_column == 0
        || range.end_line == 0
        || range.end_column == 0
        || range.start_line > MAX_DIAGNOSTIC_LINE
        || range.end_line > MAX_DIAGNOSTIC_LINE
        || range.start_column > MAX_DIAGNOSTIC_COLUMN
        || range.end_column > MAX_DIAGNOSTIC_COLUMN
        || !ordered
        || !matches!(range.range_kind.as_str(), "r_expression" | "r_parse_token")
    {
        return Err(StoreError::Validation(
            "run error range is incomplete, out of bounds, or unsupported".to_string(),
        ));
    }
    Ok(())
}

fn decode_problem_error_range(
    start_line: Option<i64>,
    start_column: Option<i64>,
    end_line: Option<i64>,
    end_column: Option<i64>,
    range_kind: Option<String>,
) -> Option<RunErrorRange> {
    let range = RunErrorRange {
        start_line: u32::try_from(start_line?).ok()?,
        start_column: u32::try_from(start_column?).ok()?,
        end_line: u32::try_from(end_line?).ok()?,
        end_column: u32::try_from(end_column?).ok()?,
        range_kind: range_kind?,
    };
    validate_run_error_range(&range).ok()?;
    Some(range)
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("migration rejected: {message}")]
    MigrationRejected {
        message: String,
        outcome: MigrationOutcome,
    },
}

impl StoreError {
    pub fn migration_outcome(&self) -> Option<&MigrationOutcome> {
        match self {
            Self::MigrationRejected { outcome, .. } => Some(outcome),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStatus {
    OpenedCurrent,
    BootstrappedCurrent,
    Migrated,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MigrationOutcome {
    pub status: MigrationStatus,
    pub from_schema_version: Option<i64>,
    pub to_schema_version: Option<i64>,
    pub backup_path: Option<String>,
    pub scoped_count: i64,
    pub legacy_unscoped_count: i64,
    pub rejected_count: i64,
    pub reason_code: Option<String>,
}

impl MigrationOutcome {
    fn opened_current() -> Self {
        Self {
            status: MigrationStatus::OpenedCurrent,
            from_schema_version: Some(SCHEMA_VERSION),
            to_schema_version: Some(SCHEMA_VERSION),
            backup_path: None,
            scoped_count: 0,
            legacy_unscoped_count: 0,
            rejected_count: 0,
            reason_code: None,
        }
    }

    fn bootstrapped_current() -> Self {
        Self {
            status: MigrationStatus::BootstrappedCurrent,
            from_schema_version: None,
            to_schema_version: Some(SCHEMA_VERSION),
            backup_path: None,
            scoped_count: 0,
            legacy_unscoped_count: 0,
            rejected_count: 0,
            reason_code: None,
        }
    }

    fn migrated(
        from_schema_version: i64,
        backup_path: Option<String>,
        counts: MigrationRecordCounts,
    ) -> Self {
        Self {
            status: MigrationStatus::Migrated,
            from_schema_version: Some(from_schema_version),
            to_schema_version: Some(SCHEMA_VERSION),
            backup_path,
            scoped_count: counts.scoped,
            legacy_unscoped_count: counts.legacy_unscoped,
            rejected_count: counts.rejected,
            reason_code: None,
        }
    }

    pub(crate) fn rejected(
        from_schema_version: Option<i64>,
        backup_path: Option<String>,
        counts: MigrationRecordCounts,
        reason_code: &'static str,
    ) -> Self {
        Self {
            status: MigrationStatus::Rejected,
            from_schema_version,
            to_schema_version: None,
            backup_path,
            scoped_count: counts.scoped,
            legacy_unscoped_count: counts.legacy_unscoped,
            rejected_count: counts.rejected,
            reason_code: Some(reason_code.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct MigrationRecordCounts {
    pub(crate) scoped: i64,
    pub(crate) legacy_unscoped: i64,
    pub(crate) rejected: i64,
}

impl std::ops::AddAssign for MigrationRecordCounts {
    fn add_assign(&mut self, rhs: Self) {
        self.scoped += rhs.scoped;
        self.legacy_unscoped += rhs.legacy_unscoped;
        self.rejected += rhs.rejected;
    }
}

#[derive(Default)]
struct StoreOpenOptions {
    #[cfg(test)]
    inject_v7_failure_before_commit: bool,
    #[cfg(test)]
    inject_v8_failure_before_commit: bool,
    #[cfg(test)]
    inject_v9_failure_before_commit: bool,
    #[cfg(test)]
    inject_v10_failure_before_commit: bool,
    #[cfg(test)]
    inject_v11_failure_before_commit: bool,
}

#[derive(Debug)]
pub struct Store {
    connection: Connection,
    migration_outcome: MigrationOutcome,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::open_with_options(path.as_ref(), StoreOpenOptions::default())
    }

    fn open_with_options(path: &Path, options: StoreOpenOptions) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut store = Self {
            connection,
            migration_outcome: MigrationOutcome::opened_current(),
        };
        store.migrate(path, &options)?;
        Ok(store)
    }

    fn migrate(&mut self, path: &Path, options: &StoreOpenOptions) -> Result<(), StoreError> {
        if migration::database_is_empty(&self.connection)? {
            self.connection.execute_batch(migration::v8_schema_sql())?;
            self.set_schema_version(SCHEMA_VERSION)?;
            self.assert_current_schema()?;
            self.migration_outcome = MigrationOutcome::bootstrapped_current();
            return Ok(());
        }

        let current = migration::read_schema_version(&self.connection)?;
        match current {
            Some(SCHEMA_VERSION) => {
                self.assert_current_schema()?;
                self.migration_outcome = MigrationOutcome::opened_current();
            }
            Some(7) => {
                let backup_path =
                    migration::create_pre_migration_backup(&self.connection, path, 7)?;
                let outcome = self.migrate_v7_to_v8(backup_path, options)?;
                self.migration_outcome = outcome;
            }
            Some(8) => {
                let backup_path =
                    migration::create_pre_migration_backup(&self.connection, path, 8)?;
                let outcome = self.migrate_v8_to_v9(backup_path, options)?;
                self.migration_outcome = outcome;
            }
            Some(9) => {
                let backup_path =
                    migration::create_pre_migration_backup(&self.connection, path, 9)?;
                let outcome = self.migrate_v9_to_v11(backup_path, options)?;
                self.migration_outcome = outcome;
            }
            Some(10) => {
                let backup_path =
                    migration::create_pre_migration_backup(&self.connection, path, 10)?;
                let outcome = self.migrate_v10_to_v11(backup_path, options)?;
                self.migration_outcome = outcome;
            }
            Some(11) => {
                let backup_path =
                    migration::create_pre_migration_backup(&self.connection, path, 11)?;
                let outcome = self.migrate_v11_to_v12(backup_path, options)?;
                self.migration_outcome = outcome;
            }
            Some(other) => {
                return Err(StoreError::MigrationRejected {
                    message: format!("unsupported schema version {other}"),
                    outcome: MigrationOutcome::rejected(
                        Some(other),
                        None,
                        MigrationRecordCounts::default(),
                        "unsupported_schema_version",
                    ),
                });
            }
            None => {
                return Err(StoreError::MigrationRejected {
                    message: "missing schema version metadata".to_string(),
                    outcome: MigrationOutcome::rejected(
                        None,
                        None,
                        MigrationRecordCounts::default(),
                        "missing_schema_version",
                    ),
                });
            }
        }
        Ok(())
    }

    pub fn migration_outcome(&self) -> &MigrationOutcome {
        &self.migration_outcome
    }

    fn migrate_v7_to_v8(
        &mut self,
        backup_path: Option<PathBuf>,
        _options: &StoreOpenOptions,
    ) -> Result<MigrationOutcome, StoreError> {
        let _backup_path_string = backup_path
            .as_ref()
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        let transaction = self.connection.transaction()?;
        let counts = migration::v7_record_counts(&transaction)?;
        if counts.rejected > 0 {
            return Err(StoreError::MigrationRejected {
                message: "malformed project identity metadata".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(7),
                    _backup_path_string,
                    counts,
                    "malformed_project_identity",
                ),
            });
        }

        migration::rebuild_runs_v8(&transaction)?;
        migration::rebuild_agent_turns_v8(&transaction)?;
        migration::rebuild_approval_requests_v8(&transaction)?;
        migration::rebuild_plot_artifacts_v8(&transaction)?;
        migration::create_claim_review_schema(&transaction)?;
        migration::create_agent_conversation_schema(&transaction)?;
        transaction.execute_batch(
            "
            CREATE INDEX IF NOT EXISTS idx_runs_project_started
                ON runs(project_root, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_turns_project_started
                ON agent_turns(project_root, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_approval_requests_project_status
                ON approval_requests(project_root, status, requested_at DESC);
            CREATE INDEX IF NOT EXISTS idx_plot_artifacts_project_created
                ON plot_artifacts(project_root, created_at DESC);
            ",
        )?;
        transaction.execute(
            "INSERT INTO metadata(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;

        #[cfg(test)]
        if _options.inject_v7_failure_before_commit {
            return Err(StoreError::MigrationRejected {
                message: "injected migration failure".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(7),
                    _backup_path_string,
                    counts,
                    "injected_failure",
                ),
            });
        }

        transaction.commit()?;
        self.assert_current_schema()?;
        Ok(MigrationOutcome::migrated(
            7,
            backup_path
                .as_ref()
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            counts,
        ))
    }

    fn migrate_v8_to_v9(
        &mut self,
        backup_path: Option<PathBuf>,
        _options: &StoreOpenOptions,
    ) -> Result<MigrationOutcome, StoreError> {
        let _backup_path_string = backup_path
            .as_ref()
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        let transaction = self.connection.transaction()?;
        migration::create_claim_review_schema(&transaction)?;
        migration::add_run_error_range_columns(&transaction)?;
        migration::create_agent_conversation_schema(&transaction)?;
        transaction.execute(
            "INSERT INTO metadata(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        #[cfg(test)]
        if _options.inject_v8_failure_before_commit {
            return Err(StoreError::MigrationRejected {
                message: "injected v8 migration failure".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(8),
                    _backup_path_string,
                    MigrationRecordCounts::default(),
                    "injected_failure",
                ),
            });
        }
        transaction.commit()?;
        self.assert_current_schema()?;
        Ok(MigrationOutcome::migrated(
            8,
            backup_path
                .as_ref()
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            MigrationRecordCounts::default(),
        ))
    }

    fn migrate_v9_to_v11(
        &mut self,
        backup_path: Option<PathBuf>,
        _options: &StoreOpenOptions,
    ) -> Result<MigrationOutcome, StoreError> {
        let _backup_path_string = backup_path
            .as_ref()
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        let transaction = self.connection.transaction()?;
        migration::add_run_error_range_columns(&transaction)?;
        migration::create_agent_conversation_schema(&transaction)?;
        transaction.execute(
            "INSERT INTO metadata(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        #[cfg(test)]
        if _options.inject_v9_failure_before_commit {
            return Err(StoreError::MigrationRejected {
                message: "injected v9 migration failure".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(9),
                    _backup_path_string,
                    MigrationRecordCounts::default(),
                    "injected_failure",
                ),
            });
        }
        transaction.commit()?;
        self.assert_current_schema()?;
        Ok(MigrationOutcome::migrated(
            9,
            backup_path
                .as_ref()
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            MigrationRecordCounts::default(),
        ))
    }

    fn migrate_v10_to_v11(
        &mut self,
        backup_path: Option<PathBuf>,
        _options: &StoreOpenOptions,
    ) -> Result<MigrationOutcome, StoreError> {
        let backup_path_string = backup_path
            .as_ref()
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        let transaction = self.connection.transaction()?;
        let invalid_kind_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM runs
             WHERE error_range_kind IS NOT NULL
               AND error_range_kind <> 'r_expression'",
            [],
            |row| row.get(0),
        )?;
        if invalid_kind_count > 0 {
            return Err(StoreError::MigrationRejected {
                message: "schema v10 contains an unsupported run error range kind".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(10),
                    backup_path_string,
                    MigrationRecordCounts {
                        rejected: invalid_kind_count,
                        ..MigrationRecordCounts::default()
                    },
                    "invalid_v10_range_kind",
                ),
            });
        }
        let before_count: i64 =
            transaction.query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))?;
        migration::rebuild_runs_error_range_kind_v11(&transaction)?;
        migration::create_agent_conversation_schema(&transaction)?;
        let after_count: i64 =
            transaction.query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))?;
        if before_count != after_count {
            return Err(StoreError::MigrationRejected {
                message: "schema v10 run copy count changed during migration".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(10),
                    backup_path_string,
                    MigrationRecordCounts {
                        rejected: before_count.saturating_sub(after_count).abs(),
                        ..MigrationRecordCounts::default()
                    },
                    "v10_copy_mismatch",
                ),
            });
        }
        transaction.execute(
            "INSERT INTO metadata(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        if migration::assert_runs_error_range_kind_constraint(&transaction).is_err()
            || migration::assert_index_exists(&transaction, "idx_runs_project_started").is_err()
        {
            return Err(StoreError::MigrationRejected {
                message: "schema v11 run table assertion failed".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(10),
                    backup_path_string,
                    MigrationRecordCounts::default(),
                    "invalid_v11_runs_schema",
                ),
            });
        }
        #[cfg(test)]
        if _options.inject_v10_failure_before_commit {
            return Err(StoreError::MigrationRejected {
                message: "injected v10 migration failure".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(10),
                    backup_path_string,
                    MigrationRecordCounts::default(),
                    "injected_failure",
                ),
            });
        }
        transaction.commit()?;
        self.assert_current_schema()?;
        Ok(MigrationOutcome::migrated(
            10,
            backup_path
                .as_ref()
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            MigrationRecordCounts::default(),
        ))
    }

    fn migrate_v11_to_v12(
        &mut self,
        backup_path: Option<PathBuf>,
        _options: &StoreOpenOptions,
    ) -> Result<MigrationOutcome, StoreError> {
        let backup_path_string = backup_path
            .as_ref()
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        let transaction = self.connection.transaction()?;
        let before_count: i64 =
            transaction.query_row("SELECT COUNT(*) FROM agent_turns", [], |row| row.get(0))?;
        let malformed_project_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM agent_turns
             WHERE project_root IS NULL OR TRIM(project_root) = ''",
            [],
            |row| row.get(0),
        )?;
        if malformed_project_count > 0 {
            return Err(StoreError::MigrationRejected {
                message: "schema v11 contains malformed Agent project identity".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(11),
                    backup_path_string,
                    MigrationRecordCounts {
                        rejected: malformed_project_count,
                        ..MigrationRecordCounts::default()
                    },
                    "malformed_v11_agent_identity",
                ),
            });
        }
        migration::create_agent_conversation_schema(&transaction)?;
        let mapping_count: i64 =
            transaction.query_row("SELECT COUNT(*) FROM agent_conversation_turns", [], |row| {
                row.get(0)
            })?;
        if before_count != mapping_count {
            return Err(StoreError::MigrationRejected {
                message: "schema v11 Agent turn mapping count changed during migration".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(11),
                    backup_path_string,
                    MigrationRecordCounts {
                        rejected: (before_count - mapping_count).abs(),
                        ..MigrationRecordCounts::default()
                    },
                    "v11_conversation_copy_mismatch",
                ),
            });
        }
        transaction.execute(
            "INSERT INTO metadata(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        #[cfg(test)]
        if _options.inject_v11_failure_before_commit {
            return Err(StoreError::MigrationRejected {
                message: "injected v11 migration failure".to_string(),
                outcome: MigrationOutcome::rejected(
                    Some(11),
                    backup_path_string,
                    MigrationRecordCounts::default(),
                    "injected_failure",
                ),
            });
        }
        transaction.commit()?;
        self.assert_current_schema()?;
        Ok(MigrationOutcome::migrated(
            11,
            backup_path
                .as_ref()
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            MigrationRecordCounts::default(),
        ))
    }

    fn set_schema_version(&self, version: i64) -> Result<(), StoreError> {
        migration::set_schema_version(&self.connection, version)?;
        Ok(())
    }

    fn assert_current_schema(&self) -> Result<(), StoreError> {
        migration::assert_not_null_project_identity(&self.connection, "runs")?;
        migration::assert_not_null_project_identity(&self.connection, "agent_turns")?;
        migration::assert_not_null_project_identity(&self.connection, "approval_requests")?;
        migration::assert_not_null_project_identity(&self.connection, "plot_artifacts")?;
        migration::assert_index_exists(&self.connection, "idx_runs_project_started")?;
        migration::assert_index_exists(&self.connection, "idx_agent_turns_project_started")?;
        migration::assert_index_exists(&self.connection, "idx_approval_requests_project_status")?;
        migration::assert_index_exists(&self.connection, "idx_plot_artifacts_project_created")?;
        migration::assert_not_null_project_identity(&self.connection, "evidence_claims")?;
        migration::assert_not_null_project_identity(&self.connection, "claim_evidence_links")?;
        migration::assert_index_exists(&self.connection, "idx_evidence_claims_project")?;
        migration::assert_index_exists(&self.connection, "idx_claim_evidence_links_project")?;
        for column in [
            "error_start_line",
            "error_start_column",
            "error_end_line",
            "error_end_column",
            "error_range_kind",
        ] {
            migration::assert_column_exists(&self.connection, "runs", column)?;
        }
        migration::assert_runs_error_range_kind_constraint(&self.connection)?;
        migration::assert_agent_conversation_schema(&self.connection)?;
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
                run_id, parent_run_id, project_root, origin, status, started_at, request_type,
                operation_class, code, arguments_json, source_path, execution_mode,
                document_version, workspace_id, state_revision_before,
                project_revision_before, cancel_requested, environment_snapshot_id
             ) VALUES(
                ?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16
             )",
            params![
                draft.run_id,
                draft.parent_run_id,
                draft.project_root,
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
                draft.environment_snapshot_id,
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
        self.finish_run_with_error_range(result, None)
    }

    pub fn finish_run_with_error_range(
        &mut self,
        result: &RunFinish,
        error_range: Option<&RunErrorRange>,
    ) -> Result<(), StoreError> {
        if let Some(range) = error_range {
            validate_run_error_range(range)?;
        }
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
                 environment_snapshot_id_after = COALESCE(?15, environment_snapshot_id_after),
                 error_start_line = ?16,
                 error_start_column = ?17,
                 error_end_line = ?18,
                 error_end_column = ?19,
                 error_range_kind = ?20,
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
                result.environment_snapshot_id_after,
                error_range.map(|range| range.start_line),
                error_range.map(|range| range.start_column),
                error_range.map(|range| range.end_line),
                error_range.map(|range| range.end_column),
                error_range.map(|range| range.range_kind.as_str()),
            ],
        )?;
        Ok(())
    }

    pub fn request_cancel(&mut self, project_root: &str, run_id: &str) -> Result<bool, StoreError> {
        let changed = self.connection.execute(
            "UPDATE runs
             SET cancel_requested = 1,
                 terminal_reason = 'cancel_requested'
             WHERE project_root = ?1 AND run_id = ?2
               AND status IN ('queued', 'running', 'waiting')",
            params![project_root, run_id],
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

    pub fn latest_active_run_id(&self, project_root: &str) -> Result<Option<String>, StoreError> {
        self.connection
            .query_row(
                "SELECT run_id FROM runs
                 WHERE project_root = ?1
                   AND status IN ('queued', 'running', 'waiting')
                 ORDER BY started_at DESC
                 LIMIT 1",
                [project_root],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_runs(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<RunSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                run_id, parent_run_id, project_root, origin, status, started_at, finished_at,
                terminal_reason, request_type, operation_class, code, source_path,
                execution_mode, document_version, workspace_id,
                state_revision_before, project_revision_before,
                state_revision_after, project_revision_after,
                environment_snapshot_id, environment_snapshot_id_after, error_message
             FROM runs
             WHERE project_root = ?1
             ORDER BY started_at DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![project_root, limit.unwrap_or(DEFAULT_LIMIT) as i64],
            |row| {
                let code: String = row.get(10)?;
                Ok(RunSummary {
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
                    source_path: row.get(11)?,
                    execution_mode: row.get(12)?,
                    document_version: row.get(13)?,
                    workspace_id: row.get(14)?,
                    state_revision_before: row.get(15)?,
                    project_revision_before: row.get(16)?,
                    state_revision_after: row.get(17)?,
                    project_revision_after: row.get(18)?,
                    environment_snapshot_id: row.get(19)?,
                    environment_snapshot_id_after: row.get(20)?,
                    code_preview: code_preview(&code),
                    error_message: row.get(21)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_problems(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<ProblemSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                run_id, parent_run_id, project_root, origin, status, error_message, error_call,
                traceback_json, source_path, execution_mode, document_version,
                workspace_id, started_at, finished_at,
                error_start_line, error_start_column, error_end_line, error_end_column,
                error_range_kind
             FROM runs
             WHERE project_root = ?1 AND error_message IS NOT NULL
             ORDER BY started_at DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![project_root, limit.unwrap_or(DEFAULT_LIMIT) as i64],
            |row| {
                let traceback: String = row.get(7)?;
                let range = decode_problem_error_range(
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                    row.get(18)?,
                );
                Ok(ProblemSummary {
                    run_id: row.get(0)?,
                    parent_run_id: row.get(1)?,
                    project_root: row.get(2)?,
                    origin: row.get(3)?,
                    status: row.get(4)?,
                    message: row.get(5)?,
                    call: row.get(6)?,
                    traceback: decode_string_list(&traceback).map_err(sqlite_function_error)?,
                    source_path: row.get(8)?,
                    execution_mode: row.get(9)?,
                    document_version: row.get(10)?,
                    line_number: range.as_ref().map(|value| value.start_line),
                    column_number: range.as_ref().map(|value| value.start_column),
                    end_line_number: range.as_ref().map(|value| value.end_line),
                    end_column_number: range.as_ref().map(|value| value.end_column),
                    range_kind: range.as_ref().map(|value| value.range_kind.clone()),
                    workspace_id: row.get(11)?,
                    started_at: row.get(12)?,
                    finished_at: row.get(13)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_run_detail(
        &self,
        project_root: &str,
        run_id: &str,
    ) -> Result<Option<RunDetail>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    run_id, parent_run_id, project_root, origin, status, started_at, finished_at,
                    terminal_reason, request_type, operation_class, code, arguments_json,
                    source_path, execution_mode, document_version, workspace_id,
                    state_revision_before, project_revision_before,
                    state_revision_after, project_revision_after,
                    environment_snapshot_id, environment_snapshot_id_after,
                    stdout, value_text, messages_json, warnings_json,
                    error_message, error_call, traceback_json
                 FROM runs
                 WHERE project_root = ?1 AND run_id = ?2",
                params![project_root, run_id],
                run::decode_run_detail,
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

    pub fn create_agent_conversation(
        &mut self,
        draft: &AgentConversationDraft,
    ) -> Result<AgentConversationSummary, StoreError> {
        let conversation_id = draft.conversation_id.trim();
        let project_root = normalize_project_root(&draft.project_root);
        let title = draft.title.trim();
        if conversation_id.is_empty() || project_root.is_empty() {
            return Err(StoreError::Validation(
                "Agent Conversation identity and project root are required".to_string(),
            ));
        }
        if title.is_empty() || title.chars().count() > 240 {
            return Err(StoreError::Validation(
                "Agent Conversation title must contain 1 to 240 characters".to_string(),
            ));
        }
        let timestamp = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO agent_conversations(
                conversation_id, project_root, title, created_at, updated_at,
                archived_at, legacy_unthreaded
             ) VALUES(?1, ?2, ?3, ?4, ?4, NULL, ?5)",
            params![
                conversation_id,
                project_root,
                title,
                timestamp,
                i64::from(draft.legacy_unthreaded),
            ],
        )?;
        self.get_agent_conversation(&project_root, conversation_id)?
            .ok_or_else(|| {
                StoreError::Validation(
                    "new Agent Conversation could not be reloaded after persistence".to_string(),
                )
            })
    }

    pub fn create_agent_turn(&mut self, draft: &AgentTurnDraft) -> Result<(), StoreError> {
        let conversation_id = format!("conversation_{}", draft.turn_id);
        self.create_agent_turn_with_conversation(
            &AgentConversationDraft {
                conversation_id,
                project_root: draft.project_root.clone(),
                title: text_preview(&draft.prompt, 120),
                legacy_unthreaded: false,
            },
            draft,
        )
    }

    pub fn create_agent_turn_with_conversation(
        &mut self,
        conversation: &AgentConversationDraft,
        draft: &AgentTurnDraft,
    ) -> Result<(), StoreError> {
        let conversation_id = conversation.conversation_id.trim();
        let conversation_project_root = normalize_project_root(&conversation.project_root);
        let turn_project_root = normalize_project_root(&draft.project_root);
        let title = conversation.title.trim();
        if conversation_id.is_empty()
            || conversation_project_root.is_empty()
            || turn_project_root.is_empty()
        {
            return Err(StoreError::Validation(
                "Agent Conversation identity and project root are required".to_string(),
            ));
        }
        if conversation_project_root != turn_project_root {
            return Err(StoreError::Validation(
                "Agent Conversation and first turn must belong to the same project".to_string(),
            ));
        }
        if title.is_empty() || title.chars().count() > 240 {
            return Err(StoreError::Validation(
                "Agent Conversation title must contain 1 to 240 characters".to_string(),
            ));
        }
        if conversation.legacy_unthreaded {
            return Err(StoreError::Validation(
                "Legacy project history cannot be created with a new turn".to_string(),
            ));
        }

        let timestamp = Utc::now().to_rfc3339();
        let prompt_preview = text_preview(&draft.prompt, 120);
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO agent_conversations(
                conversation_id, project_root, title, created_at, updated_at,
                archived_at, legacy_unthreaded
             ) VALUES(?1, ?2, ?3, ?4, ?4, NULL, 0)",
            params![conversation_id, conversation_project_root, title, timestamp],
        )?;
        transaction.execute(
            "INSERT INTO agent_turns(
                turn_id, project_root, mode, prompt, prompt_preview, model, status, started_at,
                workspace_id_before, state_revision_before, project_revision_before
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10
             )",
            params![
                draft.turn_id,
                turn_project_root,
                draft.mode,
                draft.prompt,
                prompt_preview,
                draft.model,
                timestamp,
                draft.workspace_id,
                draft.state_revision_before,
                draft.project_revision_before,
            ],
        )?;
        transaction.execute(
            "INSERT INTO agent_conversation_turns(
                turn_id, conversation_id, retry_of_turn_id, terminal_reason
             ) VALUES(?1, ?2, NULL, NULL)",
            params![draft.turn_id, conversation_id],
        )?;
        transaction.execute(
            "UPDATE agent_conversations
             SET title = CASE WHEN title = 'New conversation' THEN ?2 ELSE title END
             WHERE conversation_id = ?1",
            params![conversation_id, prompt_preview],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn create_agent_turn_in_conversation(
        &mut self,
        conversation_id: &str,
        retry_of_turn_id: Option<&str>,
        draft: &AgentTurnDraft,
    ) -> Result<(), StoreError> {
        let conversation_id = conversation_id.trim();
        let project_root = normalize_project_root(&draft.project_root);
        if conversation_id.is_empty() || project_root.is_empty() {
            return Err(StoreError::Validation(
                "Agent Conversation identity and project root are required".to_string(),
            ));
        }
        let transaction = self.connection.transaction()?;
        let conversation = transaction
            .query_row(
                "SELECT project_root, archived_at, legacy_unthreaded,
                    (SELECT COUNT(*) FROM agent_conversation_turns
                     WHERE conversation_id = agent_conversations.conversation_id)
                 FROM agent_conversations
                 WHERE conversation_id = ?1",
                [conversation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((conversation_project, archived_at, legacy_unthreaded, turn_count)) = conversation
        else {
            return Err(StoreError::Validation(
                "Agent Conversation was not found".to_string(),
            ));
        };
        if conversation_project != project_root {
            return Err(StoreError::Validation(
                "Agent Conversation belongs to a different project".to_string(),
            ));
        }
        if archived_at.is_some() {
            return Err(StoreError::Validation(
                "Archived Agent Conversation cannot accept a new turn".to_string(),
            ));
        }
        if legacy_unthreaded != 0 {
            return Err(StoreError::Validation(
                "Legacy project history is read-only; start a new conversation".to_string(),
            ));
        }
        let nonterminal_count: i64 = transaction.query_row(
            "SELECT COUNT(*)
             FROM agent_conversation_turns AS link
             JOIN agent_turns AS turn ON turn.turn_id = link.turn_id
             WHERE link.conversation_id = ?1
               AND turn.status IN ('running', 'waiting')",
            [conversation_id],
            |row| row.get(0),
        )?;
        if nonterminal_count > 0 {
            return Err(StoreError::Validation(
                "Agent Conversation already has a running turn".to_string(),
            ));
        }
        if let Some(retry_turn_id) = retry_of_turn_id {
            let retry_belongs: bool = transaction
                .query_row(
                    "SELECT 1 FROM agent_conversation_turns
                     WHERE turn_id = ?1 AND conversation_id = ?2",
                    params![retry_turn_id, conversation_id],
                    |_row| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if !retry_belongs {
                return Err(StoreError::Validation(
                    "Retry source does not belong to the Agent Conversation".to_string(),
                ));
            }
        }

        let timestamp = Utc::now().to_rfc3339();
        let prompt_preview = text_preview(&draft.prompt, 120);
        transaction.execute(
            "INSERT INTO agent_turns(
                turn_id, project_root, mode, prompt, prompt_preview, model, status, started_at,
                workspace_id_before, state_revision_before, project_revision_before
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10
             )",
            params![
                draft.turn_id,
                project_root,
                draft.mode,
                draft.prompt,
                prompt_preview,
                draft.model,
                timestamp,
                draft.workspace_id,
                draft.state_revision_before,
                draft.project_revision_before,
            ],
        )?;
        transaction.execute(
            "INSERT INTO agent_conversation_turns(
                turn_id, conversation_id, retry_of_turn_id, terminal_reason
             ) VALUES(?1, ?2, ?3, NULL)",
            params![draft.turn_id, conversation_id, retry_of_turn_id],
        )?;
        transaction.execute(
            "UPDATE agent_conversations
             SET title = CASE WHEN ?3 = 0 AND title = 'New conversation' THEN ?2 ELSE title END,
                 updated_at = ?4
             WHERE conversation_id = ?1",
            params![conversation_id, prompt_preview, turn_count, timestamp],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn update_agent_turn_status(
        &mut self,
        turn_id: &str,
        status: &str,
    ) -> Result<usize, StoreError> {
        let timestamp = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE agent_turns
             SET status = ?2
             WHERE turn_id = ?1",
            params![turn_id, status],
        )?;
        if changed == 1 {
            let conversation_changed = transaction.execute(
                "UPDATE agent_conversations
                 SET updated_at = ?2
                 WHERE conversation_id = (
                    SELECT conversation_id FROM agent_conversation_turns WHERE turn_id = ?1
                 )",
                params![turn_id, timestamp],
            )?;
            if conversation_changed != 1 {
                return Err(StoreError::Validation(
                    "Agent turn was not mapped to a Conversation while updating status".to_string(),
                ));
            }
        }
        transaction.commit()?;
        Ok(changed)
    }

    pub fn finish_agent_turn(&mut self, result: &AgentTurnFinish) -> Result<(), StoreError> {
        let timestamp = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute(
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
                timestamp,
                result.workspace_id_after,
                result.state_revision_after,
                result.project_revision_after,
                result.final_message,
                result.error_message,
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::Validation(
                "Agent turn was not found while finishing it".to_string(),
            ));
        }
        let mapping_changed = transaction.execute(
            "UPDATE agent_conversation_turns
             SET terminal_reason = ?2
             WHERE turn_id = ?1",
            params![result.turn_id, result.terminal_reason],
        )?;
        if mapping_changed != 1 {
            return Err(StoreError::Validation(
                "Agent turn was not mapped to a Conversation while finishing it".to_string(),
            ));
        }
        let conversation_changed = transaction.execute(
            "UPDATE agent_conversations
             SET updated_at = ?2
             WHERE conversation_id = (
                SELECT conversation_id FROM agent_conversation_turns WHERE turn_id = ?1
             )",
            params![result.turn_id, timestamp],
        )?;
        if conversation_changed != 1 {
            return Err(StoreError::Validation(
                "Agent Conversation was not found while finishing its turn".to_string(),
            ));
        }
        transaction.commit()?;
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
                request_id, turn_id, project_root, tool, policy, status, arguments_json, code,
                workspace_id, state_revision, project_revision, requested_at
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, 'waiting', ?6, ?7, ?8, ?9, ?10, ?11
             )",
            params![
                draft.request_id,
                draft.turn_id,
                draft.project_root,
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
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<AgentTurnSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                agent_turns.turn_id, link.conversation_id, project_root, mode, status,
                started_at, finished_at, prompt_preview, model,
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
                ) AS pending_request_id,
                link.retry_of_turn_id,
                link.terminal_reason
             FROM agent_turns
             JOIN agent_conversation_turns AS link ON link.turn_id = agent_turns.turn_id
             WHERE project_root = ?1
             ORDER BY started_at DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![
                normalize_project_root(project_root),
                limit
                    .unwrap_or(DEFAULT_LIMIT)
                    .clamp(1, MAX_AGENT_LIST_LIMIT) as i64
            ],
            agent::decode_agent_turn_summary,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_agent_turns_for_conversation(
        &self,
        project_root: &str,
        conversation_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<AgentTurnSummary>, StoreError> {
        let conversation_id = conversation_id.trim();
        if conversation_id.is_empty() {
            return Err(StoreError::Validation(
                "Agent Conversation identity is required".to_string(),
            ));
        }
        let mut statement = self.connection.prepare(
            "SELECT
                agent_turns.turn_id, link.conversation_id, agent_turns.project_root,
                mode, status, started_at, finished_at, prompt_preview, model,
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
                ) AS pending_request_id,
                link.retry_of_turn_id,
                link.terminal_reason
             FROM agent_turns
             JOIN agent_conversation_turns AS link ON link.turn_id = agent_turns.turn_id
             JOIN agent_conversations AS conversation
               ON conversation.conversation_id = link.conversation_id
             WHERE agent_turns.project_root = ?1
               AND conversation.project_root = ?1
               AND link.conversation_id = ?2
             ORDER BY started_at DESC
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                normalize_project_root(project_root),
                conversation_id,
                limit
                    .unwrap_or(DEFAULT_LIMIT)
                    .clamp(1, MAX_AGENT_LIST_LIMIT) as i64,
            ],
            agent::decode_agent_turn_summary,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn list_agent_conversations(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<AgentConversationSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                conversation.conversation_id,
                conversation.project_root,
                conversation.title,
                conversation.created_at,
                conversation.updated_at,
                conversation.archived_at,
                conversation.legacy_unthreaded,
                (SELECT COUNT(*) FROM agent_conversation_turns AS count_link
                 WHERE count_link.conversation_id = conversation.conversation_id) AS turn_count,
                COALESCE(latest_turn.status, 'empty') AS status,
                latest_turn.turn_id,
                latest_turn.mode,
                latest_turn.prompt_preview,
                latest_link.terminal_reason,
                (
                    SELECT request_id
                    FROM approval_requests
                    WHERE approval_requests.turn_id = latest_turn.turn_id
                      AND status = 'waiting'
                    ORDER BY requested_at DESC
                    LIMIT 1
                ) AS pending_request_id
             FROM agent_conversations AS conversation
             LEFT JOIN agent_conversation_turns AS latest_link
               ON latest_link.turn_id = (
                    SELECT candidate_link.turn_id
                    FROM agent_conversation_turns AS candidate_link
                    JOIN agent_turns AS candidate_turn
                      ON candidate_turn.turn_id = candidate_link.turn_id
                    WHERE candidate_link.conversation_id = conversation.conversation_id
                    ORDER BY candidate_turn.started_at DESC, candidate_turn.rowid DESC
                    LIMIT 1
               )
             LEFT JOIN agent_turns AS latest_turn
               ON latest_turn.turn_id = latest_link.turn_id
             WHERE conversation.project_root = ?1
               AND conversation.archived_at IS NULL
             ORDER BY conversation.updated_at DESC, conversation.rowid DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![
                normalize_project_root(project_root),
                limit
                    .unwrap_or(DEFAULT_LIMIT)
                    .clamp(1, MAX_AGENT_LIST_LIMIT) as i64,
            ],
            |row| {
                Ok(AgentConversationSummary {
                    conversation_id: row.get(0)?,
                    project_root: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    archived_at: row.get(5)?,
                    legacy_unthreaded: row.get::<_, i64>(6)? != 0,
                    turn_count: row.get(7)?,
                    status: row.get(8)?,
                    latest_turn_id: row.get(9)?,
                    latest_mode: row.get(10)?,
                    latest_prompt_preview: row.get(11)?,
                    terminal_reason: row.get(12)?,
                    pending_request_id: row.get(13)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_agent_conversation(
        &self,
        project_root: &str,
        conversation_id: &str,
    ) -> Result<Option<AgentConversationSummary>, StoreError> {
        let conversation_id = conversation_id.trim();
        if conversation_id.is_empty() {
            return Err(StoreError::Validation(
                "Agent Conversation identity is required".to_string(),
            ));
        }
        self.connection
            .query_row(
                "SELECT
                    conversation.conversation_id,
                    conversation.project_root,
                    conversation.title,
                    conversation.created_at,
                    conversation.updated_at,
                    conversation.archived_at,
                    conversation.legacy_unthreaded,
                    (SELECT COUNT(*) FROM agent_conversation_turns AS count_link
                     WHERE count_link.conversation_id = conversation.conversation_id),
                    COALESCE(latest_turn.status, 'empty'),
                    latest_turn.turn_id,
                    latest_turn.mode,
                    latest_turn.prompt_preview,
                    latest_link.terminal_reason,
                    (
                        SELECT request_id FROM approval_requests
                        WHERE approval_requests.turn_id = latest_turn.turn_id
                          AND status = 'waiting'
                        ORDER BY requested_at DESC LIMIT 1
                    )
                 FROM agent_conversations AS conversation
                 LEFT JOIN agent_conversation_turns AS latest_link
                   ON latest_link.turn_id = (
                        SELECT candidate_link.turn_id
                        FROM agent_conversation_turns AS candidate_link
                        JOIN agent_turns AS candidate_turn
                          ON candidate_turn.turn_id = candidate_link.turn_id
                        WHERE candidate_link.conversation_id = conversation.conversation_id
                        ORDER BY candidate_turn.started_at DESC, candidate_turn.rowid DESC
                        LIMIT 1
                   )
                 LEFT JOIN agent_turns AS latest_turn
                   ON latest_turn.turn_id = latest_link.turn_id
                 WHERE conversation.project_root = ?1
                   AND conversation.conversation_id = ?2",
                params![normalize_project_root(project_root), conversation_id],
                |row| {
                    Ok(AgentConversationSummary {
                        conversation_id: row.get(0)?,
                        project_root: row.get(1)?,
                        title: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        archived_at: row.get(5)?,
                        legacy_unthreaded: row.get::<_, i64>(6)? != 0,
                        turn_count: row.get(7)?,
                        status: row.get(8)?,
                        latest_turn_id: row.get(9)?,
                        latest_mode: row.get(10)?,
                        latest_prompt_preview: row.get(11)?,
                        terminal_reason: row.get(12)?,
                        pending_request_id: row.get(13)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn agent_conversation_id_for_turn(
        &self,
        project_root: &str,
        turn_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let turn_id = turn_id.trim();
        if turn_id.is_empty() {
            return Err(StoreError::Validation(
                "Agent turn identity is required".to_string(),
            ));
        }
        self.connection
            .query_row(
                "SELECT link.conversation_id
                 FROM agent_conversation_turns AS link
                 JOIN agent_turns AS turn ON turn.turn_id = link.turn_id
                 JOIN agent_conversations AS conversation
                   ON conversation.conversation_id = link.conversation_id
                 WHERE turn.turn_id = ?1
                   AND turn.project_root = ?2
                   AND conversation.project_root = ?2",
                params![turn_id, normalize_project_root(project_root)],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn delete_agent_conversation(
        &mut self,
        project_root: &str,
        conversation_id: &str,
    ) -> Result<usize, StoreError> {
        let project_root = normalize_project_root(project_root);
        let conversation_id = conversation_id.trim();
        if project_root.is_empty() || conversation_id.is_empty() {
            return Err(StoreError::Validation(
                "Agent Conversation identity and project root are required".to_string(),
            ));
        }
        let transaction = self.connection.transaction()?;
        let nonterminal_count: i64 = transaction.query_row(
            "SELECT COUNT(*)
             FROM agent_conversation_turns AS link
             JOIN agent_turns AS turn ON turn.turn_id = link.turn_id
             JOIN agent_conversations AS conversation
               ON conversation.conversation_id = link.conversation_id
             WHERE link.conversation_id = ?1
               AND turn.project_root = ?2
               AND conversation.project_root = ?2
               AND turn.status IN ('running', 'waiting')",
            params![conversation_id, project_root],
            |row| row.get(0),
        )?;
        if nonterminal_count > 0 {
            return Err(StoreError::Validation(
                "A running Agent Conversation cannot be deleted".to_string(),
            ));
        }
        let deleted_turns = transaction.execute(
            "DELETE FROM agent_turns
             WHERE project_root = ?1
               AND turn_id IN (
                    SELECT turn_id FROM agent_conversation_turns
                    WHERE conversation_id = ?2
               )",
            params![project_root, conversation_id],
        )?;
        let deleted_conversations = transaction.execute(
            "DELETE FROM agent_conversations
             WHERE project_root = ?1 AND conversation_id = ?2",
            params![project_root, conversation_id],
        )?;
        if deleted_conversations != 1 {
            return Err(StoreError::Validation(
                "Agent Conversation was not found in the active project".to_string(),
            ));
        }
        transaction.commit()?;
        Ok(deleted_turns)
    }

    pub fn recent_agent_conversation(
        &self,
        project_root: &str,
        conversation_id: &str,
        exclude_turn_id: &str,
        limit: usize,
    ) -> Result<Vec<AgentConversationTurn>, StoreError> {
        let conversation_id = conversation_id.trim();
        let exclude_turn_id = exclude_turn_id.trim();
        if conversation_id.is_empty() || exclude_turn_id.is_empty() {
            return Err(StoreError::Validation(
                "Agent Conversation and turn identities are required".to_string(),
            ));
        }
        let mut statement = self.connection.prepare(
            "SELECT
                agent_turns.turn_id, mode, status, prompt, final_message, error_message, started_at
             FROM agent_turns
             JOIN agent_conversation_turns AS link ON link.turn_id = agent_turns.turn_id
             JOIN agent_conversations AS conversation
               ON conversation.conversation_id = link.conversation_id
             WHERE agent_turns.project_root = ?1
               AND conversation.project_root = ?1
               AND link.conversation_id = ?2
               AND agent_turns.turn_id != ?3
               AND status IN ('completed', 'failed')
             ORDER BY started_at DESC, agent_turns.rowid DESC
             LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![
                normalize_project_root(project_root),
                conversation_id,
                exclude_turn_id,
                limit.clamp(1, 4) as i64,
            ],
            |row| {
                Ok(AgentConversationTurn {
                    turn_id: row.get(0)?,
                    mode: row.get(1)?,
                    status: row.get(2)?,
                    prompt: row.get(3)?,
                    final_message: row.get(4)?,
                    error_message: row.get(5)?,
                    started_at: row.get(6)?,
                })
            },
        )?;
        let mut turns = rows.collect::<Result<Vec<_>, _>>()?;
        turns.reverse();
        Ok(turns)
    }

    pub fn list_approval_requests(
        &self,
        project_root: &str,
        limit: Option<usize>,
        status: Option<&str>,
    ) -> Result<Vec<ApprovalRequestSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                request_id, turn_id, project_root, tool, policy, status, decision, reason,
                arguments_json, code, workspace_id, state_revision, project_revision,
                requested_at, responded_at, continuation_outcome
             FROM approval_requests
             WHERE project_root = ?1 AND (?3 IS NULL OR status = ?3)
             ORDER BY requested_at DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![
                normalize_project_root(project_root),
                limit.unwrap_or(DEFAULT_LIMIT) as i64,
                status
            ],
            agent::decode_approval_request,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_agent_turn_detail(
        &self,
        project_root: &str,
        turn_id: &str,
    ) -> Result<Option<AgentTurnDetail>, StoreError> {
        let project_root = normalize_project_root(project_root);
        let turn = self
            .connection
            .query_row(
                "SELECT
                    agent_turns.turn_id, link.conversation_id, agent_turns.project_root,
                    mode, status, started_at, finished_at, prompt_preview, model,
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
                    ) AS pending_request_id,
                    link.retry_of_turn_id,
                    link.terminal_reason
                 FROM agent_turns
                 JOIN agent_conversation_turns AS link ON link.turn_id = agent_turns.turn_id
                 JOIN agent_conversations AS conversation
                   ON conversation.conversation_id = link.conversation_id
                 WHERE agent_turns.project_root = ?1
                   AND conversation.project_root = ?1
                   AND agent_turns.turn_id = ?2",
                params![&project_root, turn_id],
                agent::decode_agent_turn_summary,
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
        let event_rows = event_statement.query_map([turn_id], agent::decode_agent_turn_event)?;
        let events = event_rows.collect::<Result<Vec<_>, _>>()?;

        let mut approval_statement = self.connection.prepare(
            "SELECT
                request_id, turn_id, project_root, tool, policy, status, decision, reason,
                arguments_json, code, workspace_id, state_revision, project_revision,
                requested_at, responded_at, continuation_outcome
             FROM approval_requests
             WHERE project_root = ?1 AND turn_id = ?2
             ORDER BY requested_at DESC",
        )?;
        let approval_rows = approval_statement.query_map(
            params![&project_root, turn_id],
            agent::decode_approval_request,
        )?;
        let approvals = approval_rows.collect::<Result<Vec<_>, _>>()?;

        Ok(Some(AgentTurnDetail {
            turn,
            events,
            approvals,
        }))
    }

    pub fn recover_incomplete_agent_turns(&mut self) -> Result<usize, StoreError> {
        let timestamp = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE agent_turns
             SET status = 'interrupted',
                 finished_at = ?1,
                 error_message = COALESCE(error_message, 'Agent turn interrupted by desktop restart')
             WHERE status IN ('running', 'waiting')",
            [&timestamp],
        )?;
        transaction.execute(
            "UPDATE agent_conversation_turns
             SET terminal_reason = COALESCE(terminal_reason, 'desktop_restart')
             WHERE turn_id IN (
                SELECT turn_id FROM agent_turns
                WHERE status = 'interrupted' AND finished_at = ?1
             )",
            [&timestamp],
        )?;
        transaction.execute(
            "UPDATE agent_conversations
             SET updated_at = ?1
             WHERE conversation_id IN (
                SELECT link.conversation_id
                FROM agent_conversation_turns AS link
                JOIN agent_turns AS turn ON turn.turn_id = link.turn_id
                WHERE turn.status = 'interrupted' AND turn.finished_at = ?1
             )",
            [&timestamp],
        )?;
        transaction.commit()?;
        Ok(changed)
    }

    pub fn clear_agent_history(&mut self, project_root: &str) -> Result<usize, StoreError> {
        let project_root = normalize_project_root(project_root);
        if project_root.is_empty() {
            return Err(StoreError::Validation(
                "project root is required to clear Agent history".to_string(),
            ));
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM approval_requests WHERE project_root = ?1",
            [&project_root],
        )?;
        transaction.execute(
            "DELETE FROM agent_turn_events
             WHERE turn_id IN (SELECT turn_id FROM agent_turns WHERE project_root = ?1)",
            [&project_root],
        )?;
        let deleted = transaction.execute(
            "DELETE FROM agent_turns WHERE project_root = ?1",
            [&project_root],
        )?;
        transaction.execute(
            "DELETE FROM agent_conversations WHERE project_root = ?1",
            [&project_root],
        )?;
        transaction.commit()?;
        Ok(deleted)
    }

    pub fn recover_incomplete_approvals(&mut self) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE approval_requests
             SET status = 'interrupted',
                 decision = COALESCE(decision, 'cancel'),
                 reason = COALESCE(reason, 'Approval interrupted by desktop restart'),
                 continuation_outcome = COALESCE(continuation_outcome, 'desktop_restart'),
                 responded_at = COALESCE(responded_at, ?1)
             WHERE status = 'waiting'",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(changed)
    }

    pub fn interrupt_agent_approvals(
        &mut self,
        turn_id: &str,
        reason: &str,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE approval_requests
             SET status = 'interrupted',
                 decision = COALESCE(decision, 'cancel'),
                 reason = COALESCE(reason, ?2),
                 continuation_outcome = COALESCE(continuation_outcome, 'user_cancelled'),
                 responded_at = COALESCE(responded_at, ?3)
             WHERE turn_id = ?1 AND status = 'waiting'",
            params![turn_id, reason, Utc::now().to_rfc3339()],
        )?;
        Ok(changed)
    }

    pub fn recover_incomplete_environment_operations(&mut self) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE environment_operation_requests
             SET status = CASE
                    WHEN status = 'requested' THEN 'stale'
                    ELSE 'interrupted'
                 END,
                 decision = COALESCE(decision, 'cancel'),
                 reason = COALESCE(reason, 'Environment operation interrupted by desktop restart'),
                 completed_at = COALESCE(completed_at, ?1),
                 terminal_outcome = COALESCE(terminal_outcome, 'desktop_restart')
             WHERE status IN ('requested', 'approved', 'running')",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(changed)
    }

    pub fn create_plot_artifact(&mut self, draft: &PlotArtifactDraft) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO plot_artifacts(
                plot_id, run_id, project_root, source_path, execution_mode, document_version,
                workspace_id, state_revision, project_revision, media_type, payload_json,
                provenance_complete, created_at
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
             )",
            params![
                draft.plot_id,
                draft.run_id,
                draft.project_root,
                draft.source_path,
                draft.execution_mode,
                draft.document_version,
                draft.workspace_id,
                draft.state_revision,
                draft.project_revision,
                draft.media_type,
                draft.payload_json,
                if draft.provenance_complete { 1 } else { 0 },
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn create_artifact_record(
        &mut self,
        draft: &ArtifactRecordDraft,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO artifact_records(
                artifact_id, artifact_kind, run_id, project_root, output_path, source_path,
                execution_mode, document_version, workspace_id, state_revision,
                project_revision, media_type, metadata_json, provenance_complete,
                incomplete_reason, created_at
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
             )",
            params![
                draft.artifact_id,
                draft.artifact_kind,
                draft.run_id,
                draft.project_root,
                draft.output_path,
                draft.source_path,
                draft.execution_mode,
                draft.document_version,
                draft.workspace_id,
                draft.state_revision,
                draft.project_revision,
                draft.media_type,
                draft.metadata_json,
                if draft.provenance_complete { 1 } else { 0 },
                draft.incomplete_reason,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn record_environment_snapshot(
        &mut self,
        draft: &EnvironmentSnapshotDraft,
    ) -> Result<(), StoreError> {
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO environment_snapshots(
                snapshot_id, project_root, canonical_json, first_captured_at, last_captured_at
             ) VALUES(
                ?1, ?2, ?3, ?4, ?4
             )
             ON CONFLICT(snapshot_id) DO UPDATE SET
                last_captured_at = excluded.last_captured_at",
            params![
                draft.snapshot_id,
                draft.project_root,
                draft.canonical_json,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn get_environment_snapshot(
        &self,
        snapshot_id: &str,
    ) -> Result<Option<EnvironmentSnapshotRecord>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    snapshot_id, project_root, canonical_json, first_captured_at, last_captured_at
                 FROM environment_snapshots
                 WHERE snapshot_id = ?1",
                [snapshot_id],
                |row| {
                    Ok(EnvironmentSnapshotRecord {
                        snapshot_id: row.get(0)?,
                        project_root: row.get(1)?,
                        canonical_json: row.get(2)?,
                        first_captured_at: row.get(3)?,
                        last_captured_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn create_environment_operation_request(
        &mut self,
        draft: &EnvironmentOperationRequestDraft,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO environment_operation_requests(
                request_id, turn_id, source, request_name, status, decision, reason,
                project_root, arguments_json, preview_json, preview_sha256, workspace_id,
                state_revision, project_revision, before_snapshot_id, run_id, requested_at,
                responded_at, completed_at, terminal_outcome
             ) VALUES(
                ?1, ?2, ?3, ?4, 'requested', NULL, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                NULL, ?13, NULL, NULL, NULL
             )",
            params![
                draft.request_id,
                draft.turn_id,
                draft.source,
                draft.request_name,
                draft.project_root,
                draft.arguments_json,
                draft.preview_json,
                draft.preview_sha256,
                draft.workspace_id,
                draft.state_revision,
                draft.project_revision,
                draft.before_snapshot_id,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn decide_environment_operation_request(
        &mut self,
        request_id: &str,
        record: &EnvironmentOperationDecisionRecord,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE environment_operation_requests
             SET status = ?2,
                 decision = ?3,
                 reason = ?4,
                 responded_at = ?5
             WHERE request_id = ?1",
            params![
                request_id,
                record.status,
                record.decision,
                record.reason,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(changed)
    }

    pub fn start_environment_operation_request(
        &mut self,
        request_id: &str,
        run_id: Option<&str>,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE environment_operation_requests
             SET status = 'running',
                 run_id = ?2
             WHERE request_id = ?1",
            params![request_id, run_id],
        )?;
        Ok(changed)
    }

    pub fn claim_environment_operation_request(
        &mut self,
        project_root: &str,
        request_name: &str,
        request_id: &str,
        run_id: &str,
    ) -> Result<bool, StoreError> {
        let changed = self.connection.execute(
            "UPDATE environment_operation_requests
             SET status = 'running', run_id = ?4
             WHERE project_root = ?1 AND request_name = ?2 AND request_id = ?3
               AND status = 'approved' AND run_id IS NULL",
            params![project_root, request_name, request_id, run_id],
        )?;
        Ok(changed == 1)
    }

    pub fn finish_environment_operation_request(
        &mut self,
        finish: &EnvironmentOperationFinish,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE environment_operation_requests
             SET status = ?2,
                 run_id = COALESCE(?3, run_id),
                 terminal_outcome = ?4,
                 reason = COALESCE(?5, reason),
                 completed_at = ?6
             WHERE request_id = ?1",
            params![
                finish.request_id,
                finish.status,
                finish.run_id,
                finish.terminal_outcome,
                finish.reason,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(changed)
    }

    pub fn get_environment_operation_request(
        &self,
        project_root: &str,
        request_id: &str,
    ) -> Result<Option<EnvironmentOperationRequestSummary>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    request_id, turn_id, source, request_name, status, decision, reason,
                    project_root, arguments_json, preview_json, preview_sha256, workspace_id,
                    state_revision, project_revision, before_snapshot_id, run_id, requested_at,
                    responded_at, completed_at, terminal_outcome
                 FROM environment_operation_requests
                 WHERE project_root = ?1 AND request_id = ?2",
                params![project_root, request_id],
                environment::decode_environment_operation_request,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_environment_operation_requests(
        &self,
        project_root: &str,
        limit: Option<usize>,
        status: Option<&str>,
    ) -> Result<Vec<EnvironmentOperationRequestSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                request_id, turn_id, source, request_name, status, decision, reason,
                project_root, arguments_json, preview_json, preview_sha256, workspace_id,
                state_revision, project_revision, before_snapshot_id, run_id, requested_at,
                responded_at, completed_at, terminal_outcome
             FROM environment_operation_requests
             WHERE project_root = ?1 AND (?3 IS NULL OR status = ?3)
             ORDER BY requested_at DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![project_root, limit.unwrap_or(DEFAULT_LIMIT) as i64, status],
            environment::decode_environment_operation_request,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn set_project_root(&mut self, root: Option<&str>) -> Result<(), StoreError> {
        let normalized = root.map(normalize_project_root).unwrap_or_default();
        self.connection.execute(
            "INSERT INTO metadata(key, value) VALUES('active_project_root', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [normalized],
        )?;
        Ok(())
    }

    pub fn active_project_root(&self) -> Result<Option<String>, StoreError> {
        self.connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'active_project_root'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|value| value.filter(|value| !value.is_empty()))
            .map_err(StoreError::from)
    }

    pub fn list_plot_artifacts(
        &self,
        limit: Option<usize>,
        project_root: Option<&str>,
        workspace_id: Option<&str>,
        session_only: bool,
    ) -> Result<Vec<PlotArtifactSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                plot_id, run_id, project_root, source_path, execution_mode, document_version,
                workspace_id, state_revision, project_revision, media_type, payload_json,
                provenance_complete, created_at
             FROM plot_artifacts
             WHERE project_root IS ?1
               AND (?2 = 0 OR workspace_id IS ?3)
             ORDER BY created_at DESC
             LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![
                project_root,
                if session_only { 1 } else { 0 },
                workspace_id,
                limit.unwrap_or(DEFAULT_LIMIT) as i64
            ],
            |row| {
                Ok(PlotArtifactSummary {
                    plot_id: row.get(0)?,
                    run_id: row.get(1)?,
                    project_root: row.get(2)?,
                    source_path: row.get(3)?,
                    execution_mode: row.get(4)?,
                    document_version: row.get(5)?,
                    workspace_id: row.get(6)?,
                    state_revision: row.get(7)?,
                    project_revision: row.get(8)?,
                    media_type: row.get(9)?,
                    payload_json: row.get(10)?,
                    provenance_complete: row.get::<_, i64>(11)? != 0,
                    created_at: row.get(12)?,
                })
            },
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn clear_plot_artifacts(
        &mut self,
        project_root: Option<&str>,
        workspace_id: Option<&str>,
        session_only: bool,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "DELETE FROM plot_artifacts
             WHERE project_root IS ?1
               AND (?2 = 0 OR workspace_id IS ?3)",
            params![project_root, if session_only { 1 } else { 0 }, workspace_id],
        )?;
        Ok(changed)
    }

    pub fn prune_plot_artifact_payloads(
        &mut self,
        project_root: Option<&str>,
        workspace_id: Option<&str>,
        session_only: bool,
    ) -> Result<PlotPayloadPruneResult, StoreError> {
        let transaction = self.connection.transaction()?;
        let updates = {
            let mut statement = transaction.prepare(
                "SELECT plot_id, media_type, payload_json
                 FROM plot_artifacts
                 WHERE project_root IS ?1
                   AND (?2 = 0 OR workspace_id IS ?3)",
            )?;
            let rows = statement.query_map(
                params![project_root, if session_only { 1 } else { 0 }, workspace_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )?;
            let mut updates = Vec::new();
            for row in rows {
                let (plot_id, media_type, payload_json) = row?;
                if plot_payload_is_pruned(&payload_json) {
                    continue;
                }
                let tombstone = build_plot_payload_tombstone(&media_type)?;
                let reclaimed_bytes = (payload_json.len() as i64 - tombstone.len() as i64).max(0);
                updates.push((plot_id, tombstone, reclaimed_bytes));
            }
            updates
        };
        for (plot_id, tombstone, _) in &updates {
            transaction.execute(
                "UPDATE plot_artifacts
                 SET payload_json = ?1
                 WHERE plot_id = ?2",
                params![tombstone, plot_id],
            )?;
        }
        transaction.commit()?;
        Ok(PlotPayloadPruneResult {
            pruned_count: updates.len() as i64,
            reclaimed_bytes: updates.iter().map(|(_, _, reclaimed)| reclaimed).sum(),
        })
    }

    pub fn get_plot_artifact(
        &self,
        project_root: &str,
        plot_id: &str,
    ) -> Result<Option<PlotArtifactSummary>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    plot_id, run_id, project_root, source_path, execution_mode, document_version,
                    workspace_id, state_revision, project_revision, media_type, payload_json,
                    provenance_complete, created_at
                 FROM plot_artifacts
                 WHERE project_root = ?1 AND plot_id = ?2",
                params![project_root, plot_id],
                |row| {
                    Ok(PlotArtifactSummary {
                        plot_id: row.get(0)?,
                        run_id: row.get(1)?,
                        project_root: row.get(2)?,
                        source_path: row.get(3)?,
                        execution_mode: row.get(4)?,
                        document_version: row.get(5)?,
                        workspace_id: row.get(6)?,
                        state_revision: row.get(7)?,
                        project_revision: row.get(8)?,
                        media_type: row.get(9)?,
                        payload_json: row.get(10)?,
                        provenance_complete: row.get::<_, i64>(11)? != 0,
                        created_at: row.get(12)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn list_artifact_records(
        &self,
        limit: Option<usize>,
        project_root: &str,
        workspace_id: Option<&str>,
        session_only: bool,
    ) -> Result<Vec<ArtifactRecordSummary>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                artifact_id, artifact_kind, run_id, project_root, output_path, source_path,
                execution_mode, document_version, workspace_id, state_revision,
                project_revision, media_type, metadata_json, provenance_complete,
                incomplete_reason, created_at
             FROM artifact_records
             WHERE project_root = ?1
               AND (?2 = 0 OR workspace_id IS ?3)
             ORDER BY created_at DESC
             LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![
                project_root,
                if session_only { 1 } else { 0 },
                workspace_id,
                limit.unwrap_or(DEFAULT_LIMIT) as i64
            ],
            artifact::decode_artifact_record,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_artifact_record(
        &self,
        project_root: &str,
        artifact_id: &str,
    ) -> Result<Option<ArtifactRecordSummary>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    artifact_id, artifact_kind, run_id, project_root, output_path, source_path,
                    execution_mode, document_version, workspace_id, state_revision,
                    project_revision, media_type, metadata_json, provenance_complete,
                    incomplete_reason, created_at
                 FROM artifact_records
                 WHERE project_root = ?1 AND artifact_id = ?2",
                params![project_root, artifact_id],
                artifact::decode_artifact_record,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn get_artifact_record_for_run(
        &self,
        project_root: &str,
        run_id: &str,
        artifact_kind: &str,
    ) -> Result<Option<ArtifactRecordSummary>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    artifact_id, artifact_kind, run_id, project_root, output_path, source_path,
                    execution_mode, document_version, workspace_id, state_revision,
                    project_revision, media_type, metadata_json, provenance_complete,
                    incomplete_reason, created_at
                 FROM artifact_records
                 WHERE project_root = ?1 AND run_id = ?2 AND artifact_kind = ?3
                 ORDER BY created_at DESC
                 LIMIT 1",
                params![project_root, run_id, artifact_kind],
                artifact::decode_artifact_record,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn clear_artifact_records(
        &mut self,
        project_root: &str,
        workspace_id: Option<&str>,
        session_only: bool,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "DELETE FROM artifact_records
             WHERE project_root = ?1
               AND (?2 = 0 OR workspace_id IS ?3)",
            params![project_root, if session_only { 1 } else { 0 }, workspace_id],
        )?;
        Ok(changed)
    }

    pub fn project_retention_summary(
        &self,
        project_root: &str,
        workspace_id: Option<&str>,
    ) -> Result<ProjectRetentionSummary, StoreError> {
        Ok(ProjectRetentionSummary {
            project_root: project_root.to_string(),
            session: self.retention_scope_summary(project_root, workspace_id, true)?,
            project: self.retention_scope_summary(project_root, workspace_id, false)?,
        })
    }

    fn retention_scope_summary(
        &self,
        project_root: &str,
        workspace_id: Option<&str>,
        session_only: bool,
    ) -> Result<RetentionScopeSummary, StoreError> {
        let (plot_history_count, plot_payload_bytes) = self.connection.query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(LENGTH(payload_json)), 0)
             FROM plot_artifacts
             WHERE project_root = ?1
               AND (?2 = 0 OR workspace_id IS ?3)",
            params![project_root, if session_only { 1 } else { 0 }, workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (artifact_record_count, artifact_metadata_bytes) = self.connection.query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(LENGTH(metadata_json)), 0)
             FROM artifact_records
             WHERE project_root = ?1
               AND (?2 = 0 OR workspace_id IS ?3)",
            params![project_root, if session_only { 1 } else { 0 }, workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(RetentionScopeSummary {
            plot_history_count,
            plot_payload_bytes,
            artifact_record_count,
            artifact_metadata_bytes,
        })
    }

    pub fn find_run_detail_for_workspace_state(
        &self,
        project_root: &str,
        workspace_id: &str,
        state_revision_after: i64,
        project_revision_after: i64,
    ) -> Result<Option<RunDetail>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    run_id, parent_run_id, project_root, origin, status, started_at, finished_at,
                    terminal_reason, request_type, operation_class, code, arguments_json,
                    source_path, execution_mode, document_version, workspace_id,
                    state_revision_before, project_revision_before, state_revision_after,
                    project_revision_after, environment_snapshot_id, environment_snapshot_id_after,
                    stdout, value_text, messages_json, warnings_json, error_message,
                    error_call, traceback_json
                 FROM runs
                 WHERE project_root = ?1
                   AND workspace_id = ?2
                   AND state_revision_after = ?3
                   AND project_revision_after <= ?4
                   AND status = 'completed'
                   AND request_type = 'workspace.execute'
                   AND finished_at IS NOT NULL
                 ORDER BY project_revision_after DESC, finished_at DESC
                 LIMIT 1",
                params![
                    project_root,
                    workspace_id,
                    state_revision_after,
                    project_revision_after
                ],
                run::decode_run_detail,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn get_approval_request(
        &self,
        project_root: &str,
        request_id: &str,
    ) -> Result<Option<ApprovalRequestSummary>, StoreError> {
        self.connection
            .query_row(
                "SELECT
                    request_id, turn_id, project_root, tool, policy, status, decision, reason,
                    arguments_json, code, workspace_id, state_revision, project_revision,
                    requested_at, responded_at, continuation_outcome
                 FROM approval_requests
                 WHERE project_root = ?1 AND request_id = ?2",
                params![project_root, request_id],
                agent::decode_approval_request,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn compare_runs(
        &self,
        project_root: &str,
        left_run_id: &str,
        right_run_id: &str,
    ) -> Result<compare::CompareRunsResponse, StoreError> {
        if left_run_id == right_run_id {
            return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
                "runs must be different".to_string(),
            )));
        }

        let left = self
            .get_run_detail(project_root, left_run_id)?
            .ok_or_else(|| StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;
        let right = self
            .get_run_detail(project_root, right_run_id)?
            .ok_or_else(|| StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows))?;

        if left.operation_class != "scientific" || right.operation_class != "scientific" {
            return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
                "only scientific execution runs can be compared".to_string(),
            )));
        }

        let left_problems = self.list_problems(project_root, Some(100))?;
        let left_problems: Vec<_> = left_problems
            .into_iter()
            .filter(|p| p.run_id == left_run_id)
            .collect();
        let right_problems = self.list_problems(project_root, Some(100))?;
        let right_problems: Vec<_> = right_problems
            .into_iter()
            .filter(|p| p.run_id == right_run_id)
            .collect();

        let left_snapshot = match &left.environment_snapshot_id {
            Some(sid) => self.get_environment_snapshot(sid)?,
            None => None,
        };
        let right_snapshot = match &right.environment_snapshot_id {
            Some(sid) => self.get_environment_snapshot(sid)?,
            None => None,
        };

        let left_artifacts = self.list_artifact_records(Some(100), project_root, None, false)?;
        let left_artifacts: Vec<_> = left_artifacts
            .into_iter()
            .filter(|a| a.run_id.as_deref() == Some(left_run_id))
            .collect();
        let right_artifacts = self.list_artifact_records(Some(100), project_root, None, false)?;
        let right_artifacts: Vec<_> = right_artifacts
            .into_iter()
            .filter(|a| a.run_id.as_deref() == Some(right_run_id))
            .collect();

        Ok(compare::CompareRunsResponse::compute(
            project_root.to_string(),
            &left,
            &right,
            &left_problems,
            &right_problems,
            &left_snapshot,
            &right_snapshot,
            &left_artifacts,
            &right_artifacts,
        ))
    }
}

fn plot_payload_is_pruned(payload_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(payload_json)
        .ok()
        .and_then(|value| value.get("rho/pruned").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

fn build_plot_payload_tombstone(media_type: &str) -> Result<String, StoreError> {
    serde_json::to_string(&serde_json::json!({
        "rho/pruned": true,
        "rho/pruned_at": Utc::now().to_rfc3339(),
        "rho/original_media_type": media_type,
        "rho/prune_reason": "manual_retention_prune"
    }))
    .map_err(StoreError::from)
}

pub(crate) fn decode_string_list(input: &str) -> Result<Vec<String>, serde_json::Error> {
    serde_json::from_str(input)
}

pub(crate) fn sqlite_function_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn code_preview(code: &str) -> String {
    let first_line = code
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
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
    use crate::migration::{
        assert_index_exists, assert_not_null_project_identity,
        assert_runs_error_range_kind_constraint, read_schema_version, set_schema_version,
    };
    use rho_protocol::{MessageKind, WorkspaceIdentity};
    use serde_json::json;
    use tempfile::TempDir;

    fn create_v7_fixture(path: &Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE runs (
                    run_id TEXT PRIMARY KEY,
                    parent_run_id TEXT,
                    project_root TEXT,
                    origin TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    terminal_reason TEXT,
                    request_type TEXT NOT NULL,
                    operation_class TEXT NOT NULL,
                    code TEXT NOT NULL,
                    arguments_json TEXT NOT NULL,
                    source_path TEXT,
                    execution_mode TEXT,
                    document_version INTEGER,
                    workspace_id TEXT,
                    state_revision_before INTEGER,
                    project_revision_before INTEGER,
                    state_revision_after INTEGER,
                    project_revision_after INTEGER,
                    stdout TEXT,
                    value_text TEXT,
                    messages_json TEXT NOT NULL,
                    warnings_json TEXT NOT NULL,
                    error_message TEXT,
                    error_call TEXT,
                    traceback_json TEXT NOT NULL,
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    environment_snapshot_id TEXT,
                    environment_snapshot_id_after TEXT
                );
                CREATE TABLE agent_turns (
                    turn_id TEXT PRIMARY KEY,
                    project_root TEXT,
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
                CREATE TABLE approval_requests (
                    request_id TEXT PRIMARY KEY,
                    turn_id TEXT NOT NULL,
                    project_root TEXT,
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
                CREATE TABLE plot_artifacts (
                    plot_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    project_root TEXT,
                    source_path TEXT,
                    execution_mode TEXT,
                    document_version INTEGER,
                    workspace_id TEXT,
                    state_revision INTEGER,
                    project_revision INTEGER,
                    media_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    provenance_complete INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                ",
            )
            .unwrap();
        set_schema_version(&connection, 7).unwrap();
        let now = Utc::now().to_rfc3339();
        connection.execute(
            "INSERT INTO runs(
                run_id, parent_run_id, project_root, origin, status, started_at, request_type,
                operation_class, code, arguments_json, source_path, execution_mode,
                document_version, workspace_id, state_revision_before, project_revision_before,
                messages_json, warnings_json, traceback_json
             ) VALUES(
                'run_scoped', NULL, 'D:/projects/A', 'user', 'queued', ?1, 'workspace.execute',
                'state_capable', 'x <- 1', '{}', 'analysis.R', 'file', 1, 'ws_a', 1, 1, '[]', '[]', '[]'
             )",
            [now.clone()],
        ).unwrap();
        connection.execute(
            "INSERT INTO runs(
                run_id, parent_run_id, project_root, origin, status, started_at, request_type,
                operation_class, code, arguments_json, source_path, execution_mode,
                document_version, workspace_id, state_revision_before, project_revision_before,
                messages_json, warnings_json, traceback_json
             ) VALUES(
                'run_legacy', NULL, NULL, 'user', 'queued', ?1, 'workspace.execute',
                'state_capable', 'x <- 2', '{}', 'analysis.R', 'file', 1, 'ws_b', 1, 1, '[]', '[]', '[]'
             )",
            [now.clone()],
        ).unwrap();
        connection.execute(
            "INSERT INTO agent_turns(
                turn_id, project_root, mode, prompt, prompt_preview, model, status, started_at
             ) VALUES(
                'turn_scoped', 'D:/projects/A', 'ask', 'scoped prompt', 'scoped prompt', 'test', 'completed', ?1
             )",
            [now.clone()],
        ).unwrap();
        connection.execute(
            "INSERT INTO agent_turns(
                turn_id, project_root, mode, prompt, prompt_preview, model, status, started_at
             ) VALUES(
                'turn_legacy', NULL, 'ask', 'legacy prompt', 'legacy prompt', 'test', 'completed', ?1
             )",
            [now.clone()],
        ).unwrap();
        connection.execute(
            "INSERT INTO approval_requests(
                request_id, turn_id, project_root, tool, policy, status, arguments_json, requested_at
             ) VALUES(
                'req_scoped', 'turn_scoped', 'D:/projects/A', 'run_r', 'required', 'pending', '{}', ?1
             )",
            [now.clone()],
        ).unwrap();
        connection.execute(
            "INSERT INTO approval_requests(
                request_id, turn_id, project_root, tool, policy, status, arguments_json, requested_at
             ) VALUES(
                'req_legacy', 'turn_legacy', NULL, 'run_r', 'required', 'pending', '{}', ?1
             )",
            [now.clone()],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO plot_artifacts(
                plot_id, run_id, project_root, media_type, payload_json, created_at
             ) VALUES(
                'plot_scoped', 'run_scoped', 'D:/projects/A', 'application/json', '{}', ?1
             )",
                [now.clone()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO plot_artifacts(
                plot_id, run_id, project_root, media_type, payload_json, created_at
             ) VALUES(
                'plot_legacy', 'run_legacy', NULL, 'application/json', '{}', ?1
             )",
                [now],
            )
            .unwrap();
    }

    fn create_nonempty_store_without_schema_version(path: &Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE placeholder (
                    id INTEGER PRIMARY KEY
                );
                INSERT INTO placeholder(id) VALUES(1);
                ",
            )
            .unwrap();
    }

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
                project_root: "D:/Rho/project".to_string(),
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
                environment_snapshot_id: Some("env_before".to_string()),
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
                environment_snapshot_id_after: Some("env_after".to_string()),
            })
            .unwrap();

        let runs = store.list_runs("D:/Rho/project", None).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "failed");
        assert_eq!(runs[0].code_preview, "stop('boom')");

        let problems = store.list_problems("D:/Rho/project", None).unwrap();
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].message, "boom");

        let detail = store
            .get_run_detail("D:/Rho/project", "run_1")
            .unwrap()
            .unwrap();
        assert_eq!(
            detail.environment_snapshot_id.as_deref(),
            Some("env_before")
        );
        assert_eq!(
            detail.environment_snapshot_id_after.as_deref(),
            Some("env_after")
        );
        assert_eq!(detail.messages, vec!["hello".to_string()]);
        assert_eq!(detail.traceback, vec!["stop(\"boom\")".to_string()]);
    }

    #[test]
    fn persists_complete_problem_ranges_and_isolates_them_by_project() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        for (run_id, project_root) in [
            ("run_range_a", "D:/projects/A"),
            ("run_range_b", "D:/projects/B"),
        ] {
            store
                .create_run(&RunDraft {
                    run_id: run_id.to_string(),
                    parent_run_id: None,
                    project_root: project_root.to_string(),
                    origin: "user".to_string(),
                    request_type: "workspace.execute".to_string(),
                    operation_class: "state_capable".to_string(),
                    code: "stop('boom')".to_string(),
                    arguments_json: "{}".to_string(),
                    source_path: Some("analysis.R".to_string()),
                    execution_mode: Some("file".to_string()),
                    document_version: Some(4),
                    workspace_id: format!("ws_{run_id}"),
                    state_revision_before: 1,
                    project_revision_before: 1,
                    environment_snapshot_id: None,
                })
                .unwrap();
            store
                .finish_run_with_error_range(
                    &RunFinish {
                        run_id: run_id.to_string(),
                        status: "failed".to_string(),
                        terminal_reason: Some("r_error".to_string()),
                        workspace_id: None,
                        state_revision_after: Some(2),
                        project_revision_after: Some(1),
                        stdout: None,
                        value_text: None,
                        messages: Vec::new(),
                        warnings: Vec::new(),
                        error_message: Some("boom".to_string()),
                        error_call: Some("stop(\"boom\")".to_string()),
                        traceback: vec!["stop(\"boom\")".to_string()],
                        environment_snapshot_id_after: None,
                    },
                    Some(&RunErrorRange {
                        start_line: if project_root.ends_with('A') { 7 } else { 70 },
                        start_column: 3,
                        end_line: if project_root.ends_with('A') { 7 } else { 70 },
                        end_column: if project_root.ends_with('A') { 4 } else { 15 },
                        range_kind: if project_root.ends_with('A') {
                            "r_parse_token".to_string()
                        } else {
                            "r_expression".to_string()
                        },
                    }),
                )
                .unwrap();
        }

        let problems_a = store.list_problems("D:/projects/A", None).unwrap();
        assert_eq!(problems_a.len(), 1);
        assert_eq!(problems_a[0].run_id, "run_range_a");
        assert_eq!(problems_a[0].line_number, Some(7));
        assert_eq!(problems_a[0].column_number, Some(3));
        assert_eq!(problems_a[0].end_line_number, Some(7));
        assert_eq!(problems_a[0].end_column_number, Some(4));
        assert_eq!(problems_a[0].range_kind.as_deref(), Some("r_parse_token"));
        let problems_b = store.list_problems("D:/projects/B", None).unwrap();
        assert_eq!(problems_b.len(), 1);
        assert_eq!(problems_b[0].run_id, "run_range_b");
        assert_eq!(problems_b[0].line_number, Some(70));
    }

    #[test]
    fn rejects_invalid_problem_ranges_and_projects_partial_history_as_unknown() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_run(&RunDraft {
                run_id: "run_invalid_range".to_string(),
                parent_run_id: None,
                project_root: "D:/projects/A".to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "state_capable".to_string(),
                code: "stop('boom')".to_string(),
                arguments_json: "{}".to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: "ws_a".to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        let finish = RunFinish {
            run_id: "run_invalid_range".to_string(),
            status: "failed".to_string(),
            terminal_reason: Some("r_error".to_string()),
            workspace_id: None,
            state_revision_after: None,
            project_revision_after: None,
            stdout: None,
            value_text: None,
            messages: Vec::new(),
            warnings: Vec::new(),
            error_message: Some("boom".to_string()),
            error_call: None,
            traceback: Vec::new(),
            environment_snapshot_id_after: None,
        };
        assert!(
            store
                .finish_run_with_error_range(
                    &finish,
                    Some(&RunErrorRange {
                        start_line: 8,
                        start_column: 4,
                        end_line: 8,
                        end_column: 4,
                        range_kind: "r_expression".to_string(),
                    }),
                )
                .is_err()
        );
        assert!(
            store
                .finish_run_with_error_range(
                    &finish,
                    Some(&RunErrorRange {
                        start_line: 8,
                        start_column: 4,
                        end_line: 8,
                        end_column: 5,
                        range_kind: "message_guess".to_string(),
                    }),
                )
                .is_err()
        );
        store
            .finish_run_with_error_range(
                &finish,
                Some(&RunErrorRange {
                    start_line: 8,
                    start_column: 4,
                    end_line: 8,
                    end_column: 12,
                    range_kind: "r_expression".to_string(),
                }),
            )
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE runs
                 SET error_end_column = NULL
                 WHERE run_id = 'run_invalid_range'",
                [],
            )
            .unwrap();
        let problem = store
            .list_problems("D:/projects/A", None)
            .unwrap()
            .remove(0);
        assert_eq!(problem.line_number, None);
        assert_eq!(problem.column_number, None);
        assert_eq!(problem.end_line_number, None);
        assert_eq!(problem.end_column_number, None);
        assert_eq!(problem.range_kind, None);
    }

    #[test]
    fn deduplicates_environment_snapshots_by_content_id() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let draft = EnvironmentSnapshotDraft {
            snapshot_id: "env_same".to_string(),
            project_root: "D:/Rho/project".to_string(),
            canonical_json: "{\"project_root\":\"D:/Rho/project\"}".to_string(),
        };

        store.record_environment_snapshot(&draft).unwrap();
        let first = store.get_environment_snapshot("env_same").unwrap().unwrap();
        store.record_environment_snapshot(&draft).unwrap();
        let second = store.get_environment_snapshot("env_same").unwrap().unwrap();

        assert_eq!(first.snapshot_id, second.snapshot_id);
        assert_eq!(first.canonical_json, second.canonical_json);
        assert_eq!(first.first_captured_at, second.first_captured_at);
    }

    #[test]
    fn persists_environment_operation_requests() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_environment_operation_request(&EnvironmentOperationRequestDraft {
                request_id: "env_req_1".to_string(),
                turn_id: None,
                source: "user".to_string(),
                request_name: "environment.snapshot".to_string(),
                project_root: "D:/Rho/project".to_string(),
                arguments_json: "{\"operation\":\"snapshot\"}".to_string(),
                preview_json: "{\"operation\":\"snapshot\",\"diff\":{\"values\":[]}}".to_string(),
                preview_sha256: "preview_hash".to_string(),
                workspace_id: "ws_test".to_string(),
                state_revision: 7,
                project_revision: 3,
                before_snapshot_id: Some("env_before".to_string()),
            })
            .unwrap();
        store
            .decide_environment_operation_request(
                "env_req_1",
                &EnvironmentOperationDecisionRecord {
                    decision: "approve".to_string(),
                    status: "approved".to_string(),
                    reason: Some("looks good".to_string()),
                },
            )
            .unwrap();
        assert!(
            store
                .claim_environment_operation_request(
                    "D:/Rho/project",
                    "environment.snapshot",
                    "env_req_1",
                    "run_env_1",
                )
                .unwrap()
        );
        assert!(
            !store
                .claim_environment_operation_request(
                    "D:/Rho/project",
                    "environment.snapshot",
                    "env_req_1",
                    "run_env_2",
                )
                .unwrap()
        );
        store
            .finish_environment_operation_request(&EnvironmentOperationFinish {
                request_id: "env_req_1".to_string(),
                status: "completed".to_string(),
                run_id: Some("run_env_1".to_string()),
                terminal_outcome: Some("lockfile_updated".to_string()),
                reason: None,
            })
            .unwrap();

        let detail = store
            .get_environment_operation_request("D:/Rho/project", "env_req_1")
            .unwrap()
            .unwrap();
        assert_eq!(detail.status, "completed");
        assert_eq!(detail.decision.as_deref(), Some("approve"));
        assert_eq!(detail.run_id.as_deref(), Some("run_env_1"));
        assert_eq!(detail.terminal_outcome.as_deref(), Some("lockfile_updated"));
        assert_eq!(detail.before_snapshot_id.as_deref(), Some("env_before"));
    }

    #[test]
    fn reconciles_approved_environment_operation_when_dispatch_fails() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_environment_operation_request(&EnvironmentOperationRequestDraft {
                request_id: "env_dispatch_error".to_string(),
                turn_id: None,
                source: "user".to_string(),
                request_name: "environment.initialize".to_string(),
                project_root: "D:/Rho/project".to_string(),
                arguments_json: "{}".to_string(),
                preview_json: "{}".to_string(),
                preview_sha256: "preview_dispatch_error".to_string(),
                workspace_id: "ws_test".to_string(),
                state_revision: 1,
                project_revision: 1,
                before_snapshot_id: None,
            })
            .unwrap();
        store
            .decide_environment_operation_request(
                "env_dispatch_error",
                &EnvironmentOperationDecisionRecord {
                    decision: "approve".to_string(),
                    status: "approved".to_string(),
                    reason: None,
                },
            )
            .unwrap();
        store
            .finish_environment_operation_request(&EnvironmentOperationFinish {
                request_id: "env_dispatch_error".to_string(),
                status: "failed".to_string(),
                run_id: None,
                terminal_outcome: Some("dispatch_error".to_string()),
                reason: Some("Workspace R was unavailable before execution started.".to_string()),
            })
            .unwrap();

        let detail = store
            .get_environment_operation_request("D:/Rho/project", "env_dispatch_error")
            .unwrap()
            .unwrap();
        assert_eq!(detail.status, "failed");
        assert_eq!(detail.terminal_outcome.as_deref(), Some("dispatch_error"));
        assert_eq!(
            detail.reason.as_deref(),
            Some("Workspace R was unavailable before execution started.")
        );
    }

    #[test]
    fn environment_package_requests_are_project_isolated() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        for (request_id, project_root, package) in [
            ("env_pkg_a", "D:/Rho/project-a", "ggplot2"),
            ("env_pkg_b", "D:/Rho/project-b", "dplyr"),
        ] {
            store
                .create_environment_operation_request(&EnvironmentOperationRequestDraft {
                    request_id: request_id.to_string(),
                    turn_id: None,
                    source: "user".to_string(),
                    request_name: "environment.package_remove".to_string(),
                    project_root: project_root.to_string(),
                    arguments_json: format!(
                        r#"{{"operation":"remove_package","package":"{package}"}}"#
                    ),
                    preview_json: format!(r#"{{"package":"{package}"}}"#),
                    preview_sha256: format!("preview_{request_id}"),
                    workspace_id: "ws_test".to_string(),
                    state_revision: 1,
                    project_revision: 1,
                    before_snapshot_id: Some(format!("before_{request_id}")),
                })
                .unwrap();
        }

        let project_a = store
            .list_environment_operation_requests("D:/Rho/project-a", Some(20), None)
            .unwrap();
        assert_eq!(project_a.len(), 1);
        assert_eq!(project_a[0].request_id, "env_pkg_a");
        assert!(
            store
                .get_environment_operation_request("D:/Rho/project-a", "env_pkg_b")
                .unwrap()
                .is_none()
        );
        assert!(
            !store
                .claim_environment_operation_request(
                    "D:/Rho/project-a",
                    "environment.package_remove",
                    "env_pkg_b",
                    "run_wrong_project",
                )
                .unwrap()
        );
    }

    #[test]
    fn persists_artifacts_and_resolves_scientific_run_past_non_state_runs() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_run(&RunDraft {
                run_id: "run_science_1".to_string(),
                parent_run_id: None,
                project_root: "D:/Rho/project".to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "state_capable".to_string(),
                code: "qc <- transform(qc, pass = reads > 1000)".to_string(),
                arguments_json: "{\"source_path\":\"analysis.R\"}".to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(4),
                workspace_id: "ws_test".to_string(),
                state_revision_before: 10,
                project_revision_before: 3,
                environment_snapshot_id: Some("env_before".to_string()),
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: "run_science_1".to_string(),
                status: "completed".to_string(),
                terminal_reason: None,
                workspace_id: Some("ws_test".to_string()),
                state_revision_after: Some(11),
                project_revision_after: Some(4),
                stdout: Some(String::new()),
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: Some("env_after".to_string()),
            })
            .unwrap();
        store
            .create_run(&RunDraft {
                run_id: "run_render_1".to_string(),
                parent_run_id: None,
                project_root: "D:/Rho/project".to_string(),
                origin: "user".to_string(),
                request_type: "workspace.render_document".to_string(),
                operation_class: "project_mutation".to_string(),
                code: "render report.Rmd".to_string(),
                arguments_json: "{\"path\":\"report.Rmd\"}".to_string(),
                source_path: Some("report.Rmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(2),
                workspace_id: "ws_test".to_string(),
                state_revision_before: 11,
                project_revision_before: 4,
                environment_snapshot_id: Some("env_after".to_string()),
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: "run_render_1".to_string(),
                status: "completed".to_string(),
                terminal_reason: None,
                workspace_id: Some("ws_test".to_string()),
                state_revision_after: Some(11),
                project_revision_after: Some(5),
                stdout: Some(String::new()),
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: Some("env_after".to_string()),
            })
            .unwrap();
        store
            .create_run(&RunDraft {
                run_id: "run_viewer_probe_1".to_string(),
                parent_run_id: None,
                project_root: "D:/Rho/project".to_string(),
                origin: "system".to_string(),
                request_type: "workspace.read_data_view".to_string(),
                operation_class: "probe".to_string(),
                code: "read qc page".to_string(),
                arguments_json: "{\"object_name\":\"qc\"}".to_string(),
                source_path: None,
                execution_mode: None,
                document_version: None,
                workspace_id: "ws_test".to_string(),
                state_revision_before: 11,
                project_revision_before: 5,
                environment_snapshot_id: None,
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: "run_viewer_probe_1".to_string(),
                status: "completed".to_string(),
                terminal_reason: None,
                workspace_id: Some("ws_test".to_string()),
                state_revision_after: Some(11),
                project_revision_after: Some(5),
                stdout: Some(String::new()),
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: None,
            })
            .unwrap();
        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: "artifact_1".to_string(),
                artifact_kind: "render_output".to_string(),
                run_id: Some("run_render_1".to_string()),
                project_root: "D:/Rho/project".to_string(),
                output_path: "reports/qc.html".to_string(),
                source_path: Some("reports/qc.Rmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(4),
                workspace_id: Some("ws_test".to_string()),
                state_revision: Some(11),
                project_revision: Some(4),
                media_type: "text/html".to_string(),
                metadata_json: "{\"tool\":\"rmarkdown\"}".to_string(),
                provenance_complete: true,
                incomplete_reason: None,
            })
            .unwrap();

        let listed = store
            .list_artifact_records(Some(10), "D:/Rho/project", Some("ws_test"), true)
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].artifact_kind, "render_output");
        let detail = store
            .get_artifact_record("D:/Rho/project", "artifact_1")
            .unwrap()
            .unwrap();
        assert_eq!(detail.output_path, "reports/qc.html");
        let producing_artifact = store
            .get_artifact_record_for_run("D:/Rho/project", "run_render_1", "render_output")
            .unwrap()
            .unwrap();
        assert_eq!(producing_artifact.artifact_id, "artifact_1");
        assert!(
            store
                .get_artifact_record_for_run(
                    "D:/Rho/other-project",
                    "run_render_1",
                    "render_output",
                )
                .unwrap()
                .is_none()
        );
        let run = store
            .find_run_detail_for_workspace_state("D:/Rho/project", "ws_test", 11, 5)
            .unwrap()
            .unwrap();
        assert_eq!(run.run_id, "run_science_1");
        assert_eq!(run.source_path.as_deref(), Some("analysis.R"));
    }

    #[test]
    fn summarizes_retention_by_project_and_session_scope() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let session_plot_payload = "{\"image/png\":\"abc\"}".to_string();
        let project_plot_payload = "{\"image/png\":\"abcdef\"}".to_string();
        let other_project_plot_payload = "{\"image/png\":\"z\"}".to_string();
        let session_artifact_metadata = "{\"tool\":\"session\"}".to_string();
        let project_artifact_metadata = "{\"tool\":\"project\"}".to_string();
        let other_project_artifact_metadata = "{\"tool\":\"other\"}".to_string();

        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_session".to_string(),
                run_id: "run_session".to_string(),
                project_root: Some("D:/Rho/project-a".to_string()),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some("ws_session".to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                payload_json: session_plot_payload.clone(),
                provenance_complete: true,
            })
            .unwrap();
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_project".to_string(),
                run_id: "run_project".to_string(),
                project_root: Some("D:/Rho/project-a".to_string()),
                source_path: Some("report.Rmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(2),
                workspace_id: Some("ws_other".to_string()),
                state_revision: Some(2),
                project_revision: Some(2),
                media_type: "image/png".to_string(),
                payload_json: project_plot_payload.clone(),
                provenance_complete: true,
            })
            .unwrap();
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_other_project".to_string(),
                run_id: "run_other_project".to_string(),
                project_root: Some("D:/Rho/project-b".to_string()),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some("ws_session".to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                payload_json: other_project_plot_payload.clone(),
                provenance_complete: true,
            })
            .unwrap();
        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: "artifact_session".to_string(),
                artifact_kind: "plot_export".to_string(),
                run_id: Some("run_session".to_string()),
                project_root: "D:/Rho/project-a".to_string(),
                output_path: "artifacts/session.png".to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some("ws_session".to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                metadata_json: session_artifact_metadata.clone(),
                provenance_complete: true,
                incomplete_reason: None,
            })
            .unwrap();
        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: "artifact_project".to_string(),
                artifact_kind: "render_output".to_string(),
                run_id: Some("run_project".to_string()),
                project_root: "D:/Rho/project-a".to_string(),
                output_path: "reports/project.html".to_string(),
                source_path: Some("report.Rmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(2),
                workspace_id: Some("ws_other".to_string()),
                state_revision: Some(2),
                project_revision: Some(2),
                media_type: "text/html".to_string(),
                metadata_json: project_artifact_metadata.clone(),
                provenance_complete: true,
                incomplete_reason: None,
            })
            .unwrap();
        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: "artifact_other_project".to_string(),
                artifact_kind: "render_output".to_string(),
                run_id: Some("run_other_project".to_string()),
                project_root: "D:/Rho/project-b".to_string(),
                output_path: "reports/other.html".to_string(),
                source_path: Some("report.Rmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(3),
                workspace_id: Some("ws_session".to_string()),
                state_revision: Some(3),
                project_revision: Some(3),
                media_type: "text/html".to_string(),
                metadata_json: other_project_artifact_metadata.clone(),
                provenance_complete: true,
                incomplete_reason: None,
            })
            .unwrap();

        let summary = store
            .project_retention_summary("D:/Rho/project-a", Some("ws_session"))
            .unwrap();
        assert_eq!(summary.project_root, "D:/Rho/project-a");
        assert_eq!(summary.session.plot_history_count, 1);
        assert_eq!(
            summary.session.plot_payload_bytes,
            session_plot_payload.len() as i64
        );
        assert_eq!(summary.session.artifact_record_count, 1);
        assert_eq!(
            summary.session.artifact_metadata_bytes,
            session_artifact_metadata.len() as i64
        );
        assert_eq!(summary.project.plot_history_count, 2);
        assert_eq!(
            summary.project.plot_payload_bytes,
            (session_plot_payload.len() + project_plot_payload.len()) as i64
        );
        assert_eq!(summary.project.artifact_record_count, 2);
        assert_eq!(
            summary.project.artifact_metadata_bytes,
            (session_artifact_metadata.len() + project_artifact_metadata.len()) as i64
        );
    }

    #[test]
    fn prunes_plot_payloads_with_project_and_session_tombstones() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let session_payload = format!("{{\"image/png\":\"{}\"}}", "a".repeat(512));
        let project_payload = format!("{{\"image/png\":\"{}\"}}", "b".repeat(768));
        let other_project_payload = format!("{{\"image/png\":\"{}\"}}", "z".repeat(128));

        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_session".to_string(),
                run_id: "run_session".to_string(),
                project_root: Some("D:/Rho/project-a".to_string()),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some("ws_session".to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                payload_json: session_payload.clone(),
                provenance_complete: true,
            })
            .unwrap();
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_project".to_string(),
                run_id: "run_project".to_string(),
                project_root: Some("D:/Rho/project-a".to_string()),
                source_path: Some("report.Rmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(2),
                workspace_id: Some("ws_other".to_string()),
                state_revision: Some(2),
                project_revision: Some(2),
                media_type: "image/png".to_string(),
                payload_json: project_payload.clone(),
                provenance_complete: true,
            })
            .unwrap();
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_other_project".to_string(),
                run_id: "run_other_project".to_string(),
                project_root: Some("D:/Rho/project-b".to_string()),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some("ws_session".to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                payload_json: other_project_payload.clone(),
                provenance_complete: true,
            })
            .unwrap();

        let before = store
            .project_retention_summary("D:/Rho/project-a", Some("ws_session"))
            .unwrap();
        let result = store
            .prune_plot_artifact_payloads(Some("D:/Rho/project-a"), Some("ws_session"), true)
            .unwrap();
        assert_eq!(result.pruned_count, 1);
        assert!(result.reclaimed_bytes > 0);

        let session_plot = store
            .get_plot_artifact("D:/Rho/project-a", "plot_session")
            .unwrap()
            .unwrap();
        assert!(plot_payload_is_pruned(&session_plot.payload_json));

        let project_plot = store
            .get_plot_artifact("D:/Rho/project-a", "plot_project")
            .unwrap()
            .unwrap();
        assert_eq!(project_plot.payload_json, project_payload);

        let other_project_plot = store
            .get_plot_artifact("D:/Rho/project-b", "plot_other_project")
            .unwrap()
            .unwrap();
        assert_eq!(other_project_plot.payload_json, other_project_payload);

        let after = store
            .project_retention_summary("D:/Rho/project-a", Some("ws_session"))
            .unwrap();
        assert_eq!(
            after.session.plot_history_count,
            before.session.plot_history_count
        );
        assert!(after.session.plot_payload_bytes < before.session.plot_payload_bytes);
        assert_eq!(
            after.project.plot_history_count,
            before.project.plot_history_count
        );
        assert!(after.project.plot_payload_bytes < before.project.plot_payload_bytes);

        let second = store
            .prune_plot_artifact_payloads(Some("D:/Rho/project-a"), Some("ws_session"), true)
            .unwrap();
        assert_eq!(second.pruned_count, 0);
        assert_eq!(second.reclaimed_bytes, 0);
    }

    #[test]
    fn recovers_active_runs() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_run(&RunDraft {
                run_id: "run_1".to_string(),
                parent_run_id: None,
                project_root: "D:/Rho/project".to_string(),
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
                environment_snapshot_id: None,
            })
            .unwrap();
        store.update_run_status("run_1", "running", None).unwrap();
        assert_eq!(store.recover_incomplete_runs().unwrap(), 1);
        assert_eq!(store.recover_incomplete_runs().unwrap(), 0);
        let detail = store
            .get_run_detail("D:/Rho/project", "run_1")
            .unwrap()
            .unwrap();
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
                project_root: "D:/Rho/project".to_string(),
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
                project_root: "D:/Rho/project".to_string(),
                tool: "run_r".to_string(),
                policy: "required".to_string(),
                arguments_json: "{\"code\":\"summary(qc)\"}".to_string(),
                code: Some("summary(qc)".to_string()),
                workspace_id: "ws_test".to_string(),
                state_revision: 3,
                project_revision: 1,
            })
            .unwrap();

        let turns = store.list_agent_turns("D:/Rho/project", None).unwrap();
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
                terminal_reason: None,
                workspace_id_after: Some("ws_test".to_string()),
                state_revision_after: Some(4),
                project_revision_after: Some(1),
                final_message: Some("已完成".to_string()),
                error_message: None,
            })
            .unwrap();

        let detail = store
            .get_agent_turn_detail("D:\\Rho\\project\\", "turn_1")
            .unwrap()
            .unwrap();
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
    fn returns_bounded_recent_agent_conversation_without_the_current_turn() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_agent_conversation(&AgentConversationDraft {
                conversation_id: "conversation_plot".to_string(),
                project_root: "D:/Rho/project".to_string(),
                title: "Plot analysis".to_string(),
                legacy_unthreaded: false,
            })
            .unwrap();
        for (turn_id, prompt) in [
            ("turn_plot", "用 iris 数据集画图，并按 species 上色。"),
            ("turn_retry", "再试一下"),
        ] {
            store
                .create_agent_turn_in_conversation(
                    "conversation_plot",
                    None,
                    &AgentTurnDraft {
                        turn_id: turn_id.to_string(),
                        project_root: "D:/Rho/project".to_string(),
                        mode: "act".to_string(),
                        prompt: prompt.to_string(),
                        model: "test".to_string(),
                        workspace_id: "ws_test".to_string(),
                        state_revision_before: 1,
                        project_revision_before: 0,
                    },
                )
                .unwrap();
            if turn_id == "turn_plot" {
                store
                    .finish_agent_turn(&AgentTurnFinish {
                        turn_id: "turn_plot".to_string(),
                        status: "failed".to_string(),
                        terminal_reason: Some("agent_failure".to_string()),
                        workspace_id_after: Some("ws_test".to_string()),
                        state_revision_after: Some(1),
                        project_revision_after: Some(0),
                        final_message: None,
                        error_message: Some("provider network unavailable".to_string()),
                    })
                    .unwrap();
            }
        }

        let history = store
            .recent_agent_conversation("D:/Rho/project", "conversation_plot", "turn_retry", 4)
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].turn_id, "turn_plot");
        assert_eq!(history[0].prompt, "用 iris 数据集画图，并按 species 上色。");
        assert_eq!(history[0].status, "failed");
        assert_eq!(
            history[0].error_message.as_deref(),
            Some("provider network unavailable")
        );
    }

    #[test]
    fn isolates_agent_conversations_and_enforces_one_active_turn_per_conversation() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        for (conversation_id, project_root) in [
            ("conversation_a", "D:/Rho/project"),
            ("conversation_b", "D:/Rho/project"),
            ("conversation_other", "D:/Rho/other"),
        ] {
            store
                .create_agent_conversation(&AgentConversationDraft {
                    conversation_id: conversation_id.to_string(),
                    project_root: project_root.to_string(),
                    title: "New conversation".to_string(),
                    legacy_unthreaded: false,
                })
                .unwrap();
        }

        store
            .create_agent_turn_in_conversation(
                "conversation_a",
                None,
                &AgentTurnDraft {
                    turn_id: "turn_a1".to_string(),
                    project_root: "D:/Rho/project".to_string(),
                    mode: "ask".to_string(),
                    prompt: "Explain project A".to_string(),
                    model: "test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 0,
                },
            )
            .unwrap();
        let competing = store
            .create_agent_turn_in_conversation(
                "conversation_a",
                None,
                &AgentTurnDraft {
                    turn_id: "turn_a_competing".to_string(),
                    project_root: "D:/Rho/project".to_string(),
                    mode: "plan".to_string(),
                    prompt: "Compete with A".to_string(),
                    model: "test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 0,
                },
            )
            .unwrap_err();
        assert!(matches!(
            competing,
            StoreError::Validation(message)
                if message == "Agent Conversation already has a running turn"
        ));

        store
            .create_agent_turn_in_conversation(
                "conversation_b",
                None,
                &AgentTurnDraft {
                    turn_id: "turn_b1".to_string(),
                    project_root: "D:/Rho/project".to_string(),
                    mode: "ask".to_string(),
                    prompt: "Explain project B".to_string(),
                    model: "test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 0,
                },
            )
            .unwrap();
        let cross_project = store
            .create_agent_turn_in_conversation(
                "conversation_other",
                None,
                &AgentTurnDraft {
                    turn_id: "turn_wrong_project".to_string(),
                    project_root: "D:/Rho/project".to_string(),
                    mode: "ask".to_string(),
                    prompt: "Wrong project".to_string(),
                    model: "test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 0,
                },
            )
            .unwrap_err();
        assert!(matches!(
            cross_project,
            StoreError::Validation(message)
                if message == "Agent Conversation belongs to a different project"
        ));

        for turn_id in ["turn_a1", "turn_b1"] {
            store
                .finish_agent_turn(&AgentTurnFinish {
                    turn_id: turn_id.to_string(),
                    status: "completed".to_string(),
                    terminal_reason: None,
                    workspace_id_after: Some("ws_test".to_string()),
                    state_revision_after: Some(1),
                    project_revision_after: Some(0),
                    final_message: Some(format!("answer for {turn_id}")),
                    error_message: None,
                })
                .unwrap();
        }

        let conversations = store
            .list_agent_conversations("D:/Rho/project", None)
            .unwrap();
        assert_eq!(conversations.len(), 2);
        let conversation_a = conversations
            .iter()
            .find(|conversation| conversation.conversation_id == "conversation_a")
            .unwrap();
        assert_eq!(conversation_a.title, "Explain project A");
        assert_eq!(conversation_a.turn_count, 1);
        assert_eq!(conversation_a.status, "completed");
        assert_eq!(conversation_a.latest_turn_id.as_deref(), Some("turn_a1"));

        assert_eq!(
            store
                .recent_agent_conversation("D:/Rho/project", "conversation_a", "turn_future", 4,)
                .unwrap()
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn_a1"]
        );
        assert_eq!(
            store
                .recent_agent_conversation("D:/Rho/project", "conversation_b", "turn_future", 4,)
                .unwrap()
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn_b1"]
        );
        assert!(
            store
                .get_agent_turn_detail("D:/Rho/project", "turn_a_competing")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rolls_back_new_conversation_when_first_turn_persistence_fails() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let existing_turn = AgentTurnDraft {
            turn_id: "duplicate_turn".to_string(),
            project_root: "D:/Rho/project".to_string(),
            mode: "ask".to_string(),
            prompt: "Existing turn".to_string(),
            model: "test".to_string(),
            workspace_id: "ws_test".to_string(),
            state_revision_before: 1,
            project_revision_before: 0,
        };
        store.create_agent_turn(&existing_turn).unwrap();

        let error = store
            .create_agent_turn_with_conversation(
                &AgentConversationDraft {
                    conversation_id: "conversation_must_roll_back".to_string(),
                    project_root: "D:/Rho/project".to_string(),
                    title: "New conversation".to_string(),
                    legacy_unthreaded: false,
                },
                &AgentTurnDraft {
                    prompt: "Conflicting turn".to_string(),
                    ..existing_turn
                },
            )
            .unwrap_err();
        assert!(matches!(error, StoreError::Sqlite(_)));
        assert!(
            store
                .get_agent_conversation("D:/Rho/project", "conversation_must_roll_back")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .list_agent_conversations("D:/Rho/project", None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn deletes_only_a_terminal_agent_conversation_and_cascades_its_records() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        for conversation_id in ["conversation_delete", "conversation_keep"] {
            store
                .create_agent_conversation(&AgentConversationDraft {
                    conversation_id: conversation_id.to_string(),
                    project_root: "D:/Rho/project".to_string(),
                    title: "New conversation".to_string(),
                    legacy_unthreaded: false,
                })
                .unwrap();
        }
        for (conversation_id, turn_id) in [
            ("conversation_delete", "turn_delete"),
            ("conversation_keep", "turn_keep"),
        ] {
            store
                .create_agent_turn_in_conversation(
                    conversation_id,
                    None,
                    &AgentTurnDraft {
                        turn_id: turn_id.to_string(),
                        project_root: "D:/Rho/project".to_string(),
                        mode: "ask".to_string(),
                        prompt: format!("Prompt for {turn_id}"),
                        model: "test".to_string(),
                        workspace_id: "ws_test".to_string(),
                        state_revision_before: 1,
                        project_revision_before: 0,
                    },
                )
                .unwrap();
        }
        store
            .append_agent_turn_event(&AgentTurnEventDraft {
                turn_id: "turn_delete".to_string(),
                event_type: "agent.user_prompt".to_string(),
                title: "You".to_string(),
                body: Some("Prompt for turn_delete".to_string()),
                status: "completed".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: "{}".to_string(),
            })
            .unwrap();
        store
            .create_approval_request(&ApprovalRequestDraft {
                request_id: "req_delete".to_string(),
                turn_id: "turn_delete".to_string(),
                project_root: "D:/Rho/project".to_string(),
                tool: "run_r".to_string(),
                policy: "required".to_string(),
                arguments_json: "{\"code\":\"x <- 1\"}".to_string(),
                code: Some("x <- 1".to_string()),
                workspace_id: "ws_test".to_string(),
                state_revision: 1,
                project_revision: 0,
            })
            .unwrap();

        let active_delete = store
            .delete_agent_conversation("D:/Rho/project", "conversation_delete")
            .unwrap_err();
        assert!(matches!(
            active_delete,
            StoreError::Validation(message)
                if message == "A running Agent Conversation cannot be deleted"
        ));
        for turn_id in ["turn_delete", "turn_keep"] {
            store
                .finish_agent_turn(&AgentTurnFinish {
                    turn_id: turn_id.to_string(),
                    status: "completed".to_string(),
                    terminal_reason: None,
                    workspace_id_after: Some("ws_test".to_string()),
                    state_revision_after: Some(1),
                    project_revision_after: Some(0),
                    final_message: Some("done".to_string()),
                    error_message: None,
                })
                .unwrap();
        }

        assert_eq!(
            store
                .delete_agent_conversation("D:/Rho/project", "conversation_delete")
                .unwrap(),
            1
        );
        assert!(
            store
                .get_agent_conversation("D:/Rho/project", "conversation_delete")
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .get_agent_turn_detail("D:/Rho/project", "turn_delete")
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .get_approval_request("D:/Rho/project", "req_delete")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .list_agent_turns_for_conversation("D:/Rho/project", "conversation_keep", None,)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn recovers_incomplete_agent_turns() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: "turn_1".to_string(),
                project_root: "D:/Rho/project".to_string(),
                mode: "act".to_string(),
                prompt: "run something".to_string(),
                model: "test".to_string(),
                workspace_id: "ws_test".to_string(),
                state_revision_before: 1,
                project_revision_before: 0,
            })
            .unwrap();
        store.update_agent_turn_status("turn_1", "waiting").unwrap();
        store
            .create_approval_request(&ApprovalRequestDraft {
                request_id: "req_1".to_string(),
                turn_id: "turn_1".to_string(),
                project_root: "D:/Rho/project".to_string(),
                tool: "run_r".to_string(),
                policy: "required".to_string(),
                arguments_json: "{\"code\":\"x <- 1\"}".to_string(),
                code: Some("x <- 1".to_string()),
                workspace_id: "ws_test".to_string(),
                state_revision: 1,
                project_revision: 0,
            })
            .unwrap();
        assert_eq!(store.recover_incomplete_agent_turns().unwrap(), 1);
        assert_eq!(store.recover_incomplete_approvals().unwrap(), 1);
        let detail = store
            .get_agent_turn_detail("D:/Rho/project", "turn_1")
            .unwrap()
            .unwrap();
        assert_eq!(detail.turn.status, "interrupted");
        assert!(detail.turn.error_message.is_some());
        assert_eq!(detail.approvals[0].status, "interrupted");
    }

    #[test]
    fn interrupts_waiting_approvals_for_a_cancelled_agent_turn() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: "turn_cancel".to_string(),
                project_root: "D:/Rho/project".to_string(),
                mode: "act".to_string(),
                prompt: "run something".to_string(),
                model: "test".to_string(),
                workspace_id: "ws_test".to_string(),
                state_revision_before: 1,
                project_revision_before: 0,
            })
            .unwrap();
        store
            .create_approval_request(&ApprovalRequestDraft {
                request_id: "req_cancel".to_string(),
                turn_id: "turn_cancel".to_string(),
                project_root: "D:/Rho/project".to_string(),
                tool: "run_r".to_string(),
                policy: "required".to_string(),
                arguments_json: "{\"code\":\"x <- 1\"}".to_string(),
                code: Some("x <- 1".to_string()),
                workspace_id: "ws_test".to_string(),
                state_revision: 1,
                project_revision: 0,
            })
            .unwrap();

        assert_eq!(
            store
                .interrupt_agent_approvals("turn_cancel", "Cancelled by user")
                .unwrap(),
            1
        );
        let detail = store
            .get_agent_turn_detail("D:/Rho/project", "turn_cancel")
            .unwrap()
            .unwrap();
        assert_eq!(detail.approvals[0].status, "interrupted");
        assert_eq!(detail.approvals[0].decision.as_deref(), Some("cancel"));
        assert_eq!(
            detail.approvals[0].reason.as_deref(),
            Some("Cancelled by user")
        );
        assert_eq!(
            detail.approvals[0].continuation_outcome.as_deref(),
            Some("user_cancelled")
        );
    }

    #[test]
    fn isolates_project_owned_history_and_excludes_legacy_unscoped_records() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        for (project_root, suffix) in [("D:/projects/A", "a"), ("D:/projects/B", "b")] {
            store
                .create_run(&RunDraft {
                    run_id: format!("run_{suffix}"),
                    parent_run_id: None,
                    project_root: project_root.to_string(),
                    origin: "user".to_string(),
                    request_type: "workspace.execute".to_string(),
                    operation_class: "state_capable".to_string(),
                    code: "stop('same failure')".to_string(),
                    arguments_json: "{\"source_path\":\"analysis.R\"}".to_string(),
                    source_path: Some("analysis.R".to_string()),
                    execution_mode: Some("file".to_string()),
                    document_version: Some(1),
                    workspace_id: format!("ws_{suffix}"),
                    state_revision_before: 1,
                    project_revision_before: 1,
                    environment_snapshot_id: None,
                })
                .unwrap();
            store
                .finish_run(&RunFinish {
                    run_id: format!("run_{suffix}"),
                    status: "failed".to_string(),
                    terminal_reason: Some("r_error".to_string()),
                    workspace_id: Some(format!("ws_{suffix}")),
                    state_revision_after: Some(2),
                    project_revision_after: Some(1),
                    stdout: None,
                    value_text: None,
                    messages: Vec::new(),
                    warnings: Vec::new(),
                    error_message: Some(format!("failure {suffix}")),
                    error_call: None,
                    traceback: Vec::new(),
                    environment_snapshot_id_after: None,
                })
                .unwrap();
            store
                .create_agent_turn(&AgentTurnDraft {
                    turn_id: format!("turn_{suffix}"),
                    project_root: project_root.to_string(),
                    mode: "act".to_string(),
                    prompt: format!("project {suffix} prompt"),
                    model: "test".to_string(),
                    workspace_id: format!("ws_{suffix}"),
                    state_revision_before: 2,
                    project_revision_before: 1,
                })
                .unwrap();
            store
                .create_approval_request(&ApprovalRequestDraft {
                    request_id: format!("req_{suffix}"),
                    turn_id: format!("turn_{suffix}"),
                    project_root: project_root.to_string(),
                    tool: "run_r".to_string(),
                    policy: "required".to_string(),
                    arguments_json: "{\"code\":\"x <- 1\"}".to_string(),
                    code: Some("x <- 1".to_string()),
                    workspace_id: format!("ws_{suffix}"),
                    state_revision: 2,
                    project_revision: 1,
                })
                .unwrap();
        }

        store
            .connection
            .execute(
                "INSERT INTO runs(run_id, project_root, status, started_at)
                 VALUES('run_legacy', ?1, 'failed', ?2)",
                params![LEGACY_UNSCOPED, Utc::now().to_rfc3339()],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO agent_turns(
                    turn_id, project_root, mode, prompt, prompt_preview, model, status, started_at
                 ) VALUES('turn_legacy', ?1, 'ask', 'legacy prompt', 'legacy prompt', 'test', 'completed', ?2)",
                params![LEGACY_UNSCOPED, Utc::now().to_rfc3339()],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO approval_requests(
                    request_id, turn_id, project_root, tool, policy, status, arguments_json, requested_at
                 ) VALUES('req_legacy', 'turn_legacy', ?1, 'run_r', 'required', 'pending', '{}', ?2)",
                params![LEGACY_UNSCOPED, Utc::now().to_rfc3339()],
            )
            .unwrap();

        let runs_a = store.list_runs("D:/projects/A", None).unwrap();
        assert_eq!(runs_a.len(), 1);
        assert_eq!(runs_a[0].run_id, "run_a");
        assert_eq!(store.list_problems("D:/projects/A", None).unwrap().len(), 1);
        assert!(
            store
                .get_run_detail("D:/projects/A", "run_b")
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .get_run_detail("D:/projects/A", "run_legacy")
                .unwrap()
                .is_none()
        );
        assert_eq!(store.latest_active_run_id("D:/projects/A").unwrap(), None);
        assert!(!store.request_cancel("D:/projects/A", "run_b").unwrap());

        let turns_a = store.list_agent_turns("D:/projects/A", None).unwrap();
        assert_eq!(turns_a.len(), 1);
        assert_eq!(turns_a[0].turn_id, "turn_a");
        assert_eq!(
            store
                .recent_agent_conversation(
                    "D:/projects/A",
                    "conversation_turn_a",
                    "turn_current",
                    8,
                )
                .unwrap()
                .iter()
                .map(|turn| turn.turn_id.as_str())
                .collect::<Vec<_>>(),
            Vec::<&str>::new()
        );
        assert!(
            store
                .get_agent_turn_detail("D:/projects/A", "turn_b")
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .get_agent_turn_detail("D:/projects/A", "turn_legacy")
                .unwrap()
                .is_none()
        );
        let approvals_a = store
            .list_approval_requests("D:/projects/A", None, None)
            .unwrap();
        assert_eq!(approvals_a.len(), 1);
        assert_eq!(approvals_a[0].request_id, "req_a");
        assert!(
            store
                .get_approval_request("D:/projects/A", "req_b")
                .unwrap()
                .is_none()
        );

        assert_eq!(store.clear_agent_history("D:/projects/A").unwrap(), 1);
        assert!(
            store
                .list_agent_turns("D:/projects/A", None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store.list_agent_turns("D:/projects/B", None).unwrap().len(),
            1
        );
        assert!(
            store
                .list_approval_requests("D:/projects/B", None, None)
                .unwrap()
                .iter()
                .any(|approval| approval.request_id == "req_b")
        );
    }

    #[test]
    fn bootstraps_empty_store_to_v12_and_reopens_idempotently() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");

        let store = Store::open(&database).unwrap();
        assert_eq!(
            store.migration_outcome(),
            &MigrationOutcome::bootstrapped_current()
        );
        drop(store);

        let reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened.migration_outcome(),
            &MigrationOutcome::opened_current()
        );
    }

    #[test]
    fn migrates_v7_to_v12_and_marks_legacy_unscoped_records() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v7_fixture(&database);

        let store = Store::open(&database).unwrap();
        assert_eq!(store.migration_outcome().status, MigrationStatus::Migrated);
        assert_eq!(store.migration_outcome().from_schema_version, Some(7));
        assert_eq!(store.migration_outcome().to_schema_version, Some(12));
        assert_eq!(store.migration_outcome().scoped_count, 4);
        assert_eq!(store.migration_outcome().legacy_unscoped_count, 4);
        assert_eq!(store.migration_outcome().rejected_count, 0);
        assert!(
            store
                .migration_outcome()
                .backup_path
                .as_deref()
                .unwrap()
                .ends_with("rho.sqlite.schema-v7.bak")
        );
        assert_eq!(store.list_runs("D:/projects/A", None).unwrap().len(), 1);
        assert_eq!(
            store.list_agent_turns("D:/projects/A", None).unwrap().len(),
            1
        );
        assert_eq!(
            store
                .list_approval_requests("D:/projects/A", None, None)
                .unwrap()
                .len(),
            1
        );
        let legacy_runs: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM runs WHERE project_root = ?1",
                [LEGACY_UNSCOPED],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_runs, 1);
        assert_not_null_project_identity(&store.connection, "runs").unwrap();
        assert_not_null_project_identity(&store.connection, "agent_turns").unwrap();
        assert_not_null_project_identity(&store.connection, "approval_requests").unwrap();
        assert_not_null_project_identity(&store.connection, "plot_artifacts").unwrap();
        assert_index_exists(&store.connection, "idx_plot_artifacts_project_created").unwrap();
    }

    #[test]
    fn rejects_blank_project_identity_in_v7_fixture() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v7_fixture(&database);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "UPDATE runs SET project_root = '' WHERE run_id = 'run_legacy'",
                [],
            )
            .unwrap();
        drop(connection);

        let error = Store::open(&database).unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(
            outcome.reason_code.as_deref(),
            Some("malformed_project_identity")
        );
        assert_eq!(outcome.rejected_count, 1);
        assert!(Path::new(outcome.backup_path.as_deref().unwrap()).exists());

        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(7));
        let blank_count: i64 = verification
            .query_row(
                "SELECT COUNT(*) FROM runs WHERE project_root = ''",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(blank_count, 1);
    }

    #[test]
    fn rejects_unsupported_nonempty_schema_version() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_nonempty_store_without_schema_version(&database);
        let connection = Connection::open(&database).unwrap();
        set_schema_version(&connection, 6).unwrap();
        drop(connection);

        let error = Store::open(&database).unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(
            outcome.reason_code.as_deref(),
            Some("unsupported_schema_version")
        );
        assert_eq!(outcome.from_schema_version, Some(6));
    }

    #[test]
    fn rolls_back_v7_migration_after_injected_failure_and_preserves_backup() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v7_fixture(&database);

        let error = Store::open_with_options(
            &database,
            StoreOpenOptions {
                inject_v7_failure_before_commit: true,
                ..Default::default()
            },
        )
        .unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.reason_code.as_deref(), Some("injected_failure"));
        assert!(Path::new(outcome.backup_path.as_deref().unwrap()).exists());

        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(7));
        let legacy_null_runs: i64 = verification
            .query_row(
                "SELECT COUNT(*) FROM runs WHERE project_root IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_null_runs, 1);
    }

    fn create_v8_fixture(path: &Path) {
        let store = Store::open(path).unwrap();
        drop(store);
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE runs DROP COLUMN error_start_line;
                 ALTER TABLE runs DROP COLUMN error_start_column;
                 ALTER TABLE runs DROP COLUMN error_end_line;
                 ALTER TABLE runs DROP COLUMN error_end_column;
                 ALTER TABLE runs DROP COLUMN error_range_kind;
                 DROP TABLE claim_evidence_links;
                 DROP TABLE evidence_claims;
                 DROP INDEX IF EXISTS idx_claim_evidence_links_project;
                 DROP INDEX IF EXISTS idx_evidence_claims_project;
                 DROP INDEX IF EXISTS idx_agent_conversation_turns_conversation;
                 DROP INDEX IF EXISTS idx_agent_conversations_project_updated;
                 DROP TABLE agent_conversation_turns;
                 DROP TABLE agent_conversations;",
            )
            .unwrap();
        set_schema_version(&connection, 8).unwrap();
    }

    #[test]
    fn migrates_v8_to_v12_with_backup_and_reopens() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v8_fixture(&database);

        let store = Store::open(&database).unwrap();
        assert_eq!(store.migration_outcome().status, MigrationStatus::Migrated);
        assert_eq!(store.migration_outcome().from_schema_version, Some(8));
        assert_eq!(store.migration_outcome().to_schema_version, Some(12));
        assert!(Path::new(store.migration_outcome().backup_path.as_deref().unwrap()).exists());
        assert_index_exists(&store.connection, "idx_evidence_claims_project").unwrap();
        drop(store);

        let reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened.migration_outcome(),
            &MigrationOutcome::opened_current()
        );
    }

    #[test]
    fn rolls_back_v8_migration_after_injected_failure_and_recovers() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v8_fixture(&database);

        let error = Store::open_with_options(
            &database,
            StoreOpenOptions {
                inject_v8_failure_before_commit: true,
                ..Default::default()
            },
        )
        .unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.reason_code.as_deref(), Some("injected_failure"));
        assert!(Path::new(outcome.backup_path.as_deref().unwrap()).exists());
        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(8));
        assert!(
            verification
                .prepare("SELECT * FROM evidence_claims")
                .is_err()
        );
        drop(verification);

        let recovered = Store::open(&database).unwrap();
        assert_eq!(recovered.migration_outcome().to_schema_version, Some(12));
    }

    fn create_v9_fixture(path: &Path) {
        let store = Store::open(path).unwrap();
        drop(store);
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE runs DROP COLUMN error_start_line;
                 ALTER TABLE runs DROP COLUMN error_start_column;
                 ALTER TABLE runs DROP COLUMN error_end_line;
                 ALTER TABLE runs DROP COLUMN error_end_column;
                 ALTER TABLE runs DROP COLUMN error_range_kind;
                 DROP INDEX IF EXISTS idx_agent_conversation_turns_conversation;
                 DROP INDEX IF EXISTS idx_agent_conversations_project_updated;
                 DROP TABLE agent_conversation_turns;
                 DROP TABLE agent_conversations;",
            )
            .unwrap();
        set_schema_version(&connection, 9).unwrap();
    }

    #[test]
    fn migrates_v9_to_v12_without_guessing_historical_ranges_and_reopens() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v9_fixture(&database);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "INSERT INTO runs(
                    run_id, project_root, origin, status, started_at, request_type,
                    operation_class, code, arguments_json, source_path,
                    messages_json, warnings_json, traceback_json, error_message
                 ) VALUES(
                    'historical_problem', 'D:/projects/A', 'user', 'failed', ?1,
                    'workspace.execute', 'state_capable', 'stop(\"old\")', '{}',
                    'analysis.R', '[]', '[]', '[]', 'old failure'
                 )",
                [Utc::now().to_rfc3339()],
            )
            .unwrap();
        drop(connection);

        let store = Store::open(&database).unwrap();
        assert_eq!(store.migration_outcome().status, MigrationStatus::Migrated);
        assert_eq!(store.migration_outcome().from_schema_version, Some(9));
        assert_eq!(store.migration_outcome().to_schema_version, Some(12));
        assert!(
            store
                .migration_outcome()
                .backup_path
                .as_deref()
                .unwrap()
                .ends_with("rho.sqlite.schema-v9.bak")
        );
        let problem = store
            .list_problems("D:/projects/A", None)
            .unwrap()
            .remove(0);
        assert_eq!(problem.line_number, None);
        assert_eq!(problem.range_kind, None);
        drop(store);

        let reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened.migration_outcome(),
            &MigrationOutcome::opened_current()
        );
    }

    #[test]
    fn rolls_back_v9_migration_after_injected_failure_and_recovers() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v9_fixture(&database);

        let error = Store::open_with_options(
            &database,
            StoreOpenOptions {
                inject_v9_failure_before_commit: true,
                ..Default::default()
            },
        )
        .unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.reason_code.as_deref(), Some("injected_failure"));
        assert!(Path::new(outcome.backup_path.as_deref().unwrap()).exists());
        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(9));
        assert!(
            verification
                .prepare("SELECT error_start_line FROM runs")
                .is_err()
        );
        drop(verification);

        let recovered = Store::open(&database).unwrap();
        assert_eq!(recovered.migration_outcome().to_schema_version, Some(12));
    }

    fn create_v10_fixture(path: &Path) {
        create_v9_fixture(path);
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE runs ADD COLUMN error_start_line INTEGER;
                 ALTER TABLE runs ADD COLUMN error_start_column INTEGER;
                 ALTER TABLE runs ADD COLUMN error_end_line INTEGER;
                 ALTER TABLE runs ADD COLUMN error_end_column INTEGER;
                 ALTER TABLE runs ADD COLUMN error_range_kind TEXT CHECK (
                     error_range_kind IS NULL OR error_range_kind = 'r_expression'
                 );",
            )
            .unwrap();
        set_schema_version(&connection, 10).unwrap();
    }

    #[test]
    fn migrates_v10_to_v12_preserving_expression_ranges_without_parse_backfill() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v10_fixture(&database);
        let connection = Connection::open(&database).unwrap();
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO runs(
                    run_id, project_root, origin, status, started_at, request_type,
                    operation_class, code, arguments_json, source_path,
                    messages_json, warnings_json, traceback_json, error_message,
                    error_start_line, error_start_column, error_end_line,
                    error_end_column, error_range_kind
                 ) VALUES(
                    'expression_problem', 'D:/projects/A', 'user', 'failed', ?1,
                    'workspace.execute', 'state_capable', 'stop(\"old\")', '{}',
                    'analysis.R', '[]', '[]', '[]', 'old failure', 7, 3, 7, 14,
                    'r_expression'
                 )",
                [now.clone()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runs(
                    run_id, project_root, origin, status, started_at, request_type,
                    operation_class, code, arguments_json, source_path,
                    messages_json, warnings_json, traceback_json, error_message
                 ) VALUES(
                    'historical_parse_problem', 'D:/projects/A', 'user', 'failed', ?1,
                    'workspace.execute', 'state_capable', 'value <- (', '{}',
                    'analysis.R', '[]', '[]', '[]', '<text>:1:10: unexpected end'
                 )",
                [now],
            )
            .unwrap();
        drop(connection);

        let store = Store::open(&database).unwrap();
        assert_eq!(store.migration_outcome().status, MigrationStatus::Migrated);
        assert_eq!(store.migration_outcome().from_schema_version, Some(10));
        assert_eq!(store.migration_outcome().to_schema_version, Some(12));
        assert!(
            store
                .migration_outcome()
                .backup_path
                .as_deref()
                .unwrap()
                .ends_with("rho.sqlite.schema-v10.bak")
        );
        let problems = store.list_problems("D:/projects/A", None).unwrap();
        let expression = problems
            .iter()
            .find(|problem| problem.run_id == "expression_problem")
            .unwrap();
        assert_eq!(expression.line_number, Some(7));
        assert_eq!(expression.column_number, Some(3));
        assert_eq!(expression.end_column_number, Some(14));
        assert_eq!(expression.range_kind.as_deref(), Some("r_expression"));
        let historical_parse = problems
            .iter()
            .find(|problem| problem.run_id == "historical_parse_problem")
            .unwrap();
        assert_eq!(historical_parse.line_number, None);
        assert_eq!(historical_parse.range_kind, None);
        assert_index_exists(&store.connection, "idx_runs_project_started").unwrap();
        assert_runs_error_range_kind_constraint(&store.connection).unwrap();
        let legacy_table_count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'runs_v10'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy_table_count, 0);
        assert!(
            store
                .connection
                .execute(
                    "UPDATE runs SET error_range_kind = 'message_guess'
                 WHERE run_id = 'expression_problem'",
                    [],
                )
                .is_err()
        );
        drop(store);

        let reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened.migration_outcome(),
            &MigrationOutcome::opened_current()
        );
    }

    #[test]
    fn rolls_back_v10_migration_after_injected_failure_and_recovers() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v10_fixture(&database);

        let error = Store::open_with_options(
            &database,
            StoreOpenOptions {
                inject_v10_failure_before_commit: true,
                ..Default::default()
            },
        )
        .unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.from_schema_version, Some(10));
        assert_eq!(outcome.reason_code.as_deref(), Some("injected_failure"));
        assert!(
            outcome
                .backup_path
                .as_deref()
                .unwrap()
                .ends_with("rho.sqlite.schema-v10.bak")
        );
        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(10));
        let schema_sql: String = verification
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!schema_sql.contains("r_parse_token"));
        drop(verification);

        let recovered = Store::open(&database).unwrap();
        assert_eq!(recovered.migration_outcome().to_schema_version, Some(12));
        assert_runs_error_range_kind_constraint(&recovered.connection).unwrap();
    }

    #[test]
    fn rejects_unknown_v10_range_kind_without_laundering_it() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v10_fixture(&database);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "PRAGMA ignore_check_constraints = ON;
                 INSERT INTO runs(
                    run_id, project_root, origin, status, started_at, request_type,
                    operation_class, code, arguments_json, source_path,
                    messages_json, warnings_json, traceback_json, error_message,
                    error_start_line, error_start_column, error_end_line,
                    error_end_column, error_range_kind
                 ) VALUES(
                    'unknown_kind', 'D:/projects/A', 'user', 'failed',
                    '2026-08-08T00:00:00Z', 'workspace.execute', 'state_capable',
                    'x', '{}', 'analysis.R', '[]', '[]', '[]', 'failure',
                    1, 1, 1, 2, 'message_guess'
                 );
                 PRAGMA ignore_check_constraints = OFF;",
            )
            .unwrap();
        drop(connection);

        let error = Store::open(&database).unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.from_schema_version, Some(10));
        assert_eq!(
            outcome.reason_code.as_deref(),
            Some("invalid_v10_range_kind")
        );
        assert_eq!(outcome.rejected_count, 1);
        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(10));
        let retained: String = verification
            .query_row(
                "SELECT error_range_kind FROM runs WHERE run_id = 'unknown_kind'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, "message_guess");
    }

    fn create_v11_fixture(path: &Path) {
        let mut store = Store::open(path).unwrap();
        for (turn_id, project_root, status) in [
            ("legacy_turn_a1", "D:/projects/A", "failed"),
            ("legacy_turn_a2", "D:/projects/A", "interrupted"),
            ("legacy_turn_b1", "D:/projects/B", "completed"),
        ] {
            store
                .create_agent_turn(&AgentTurnDraft {
                    turn_id: turn_id.to_string(),
                    project_root: project_root.to_string(),
                    mode: "ask".to_string(),
                    prompt: format!("Historical prompt for {turn_id}"),
                    model: "test".to_string(),
                    workspace_id: format!("ws_{turn_id}"),
                    state_revision_before: 1,
                    project_revision_before: 0,
                })
                .unwrap();
            store
                .finish_agent_turn(&AgentTurnFinish {
                    turn_id: turn_id.to_string(),
                    status: status.to_string(),
                    terminal_reason: Some(format!("old_reason_{status}")),
                    workspace_id_after: Some(format!("ws_{turn_id}")),
                    state_revision_after: Some(1),
                    project_revision_after: Some(0),
                    final_message: (status == "completed").then(|| "done".to_string()),
                    error_message: (status != "completed").then(|| status.to_string()),
                })
                .unwrap();
        }
        drop(store);

        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "DROP INDEX IF EXISTS idx_agent_conversation_turns_conversation;
                 DROP INDEX IF EXISTS idx_agent_conversations_project_updated;
                 DROP TABLE agent_conversation_turns;
                 DROP TABLE agent_conversations;",
            )
            .unwrap();
        set_schema_version(&connection, 11).unwrap();
    }

    #[test]
    fn migrates_v11_agent_turns_into_read_only_project_conversations() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v11_fixture(&database);

        let mut store = Store::open(&database).unwrap();
        assert_eq!(store.migration_outcome().status, MigrationStatus::Migrated);
        assert_eq!(store.migration_outcome().from_schema_version, Some(11));
        assert_eq!(store.migration_outcome().to_schema_version, Some(12));
        assert!(
            store
                .migration_outcome()
                .backup_path
                .as_deref()
                .unwrap()
                .ends_with("rho.sqlite.schema-v11.bak")
        );

        let conversations_a = store
            .list_agent_conversations("D:/projects/A", None)
            .unwrap();
        assert_eq!(conversations_a.len(), 1);
        let legacy_a = &conversations_a[0];
        assert_eq!(legacy_a.title, "Legacy project history");
        assert!(legacy_a.legacy_unthreaded);
        assert_eq!(legacy_a.turn_count, 2);
        assert_eq!(
            store
                .list_agent_turns_for_conversation(
                    "D:/projects/A",
                    &legacy_a.conversation_id,
                    None,
                )
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .list_agent_conversations("D:/projects/B", None)
                .unwrap()[0]
                .turn_count,
            1
        );
        let legacy_write = store
            .create_agent_turn_in_conversation(
                &legacy_a.conversation_id,
                None,
                &AgentTurnDraft {
                    turn_id: "new_turn_in_legacy".to_string(),
                    project_root: "D:/projects/A".to_string(),
                    mode: "ask".to_string(),
                    prompt: "Do not append".to_string(),
                    model: "test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 0,
                },
            )
            .unwrap_err();
        assert!(matches!(
            legacy_write,
            StoreError::Validation(message)
                if message == "Legacy project history is read-only; start a new conversation"
        ));
        drop(store);

        let reopened = Store::open(&database).unwrap();
        assert_eq!(
            reopened.migration_outcome(),
            &MigrationOutcome::opened_current()
        );
    }

    #[test]
    fn rolls_back_v11_conversation_migration_after_injected_failure_and_recovers() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v11_fixture(&database);

        let error = Store::open_with_options(
            &database,
            StoreOpenOptions {
                inject_v11_failure_before_commit: true,
                ..Default::default()
            },
        )
        .unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.from_schema_version, Some(11));
        assert_eq!(outcome.reason_code.as_deref(), Some("injected_failure"));
        assert!(Path::new(outcome.backup_path.as_deref().unwrap()).exists());

        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(11));
        assert_eq!(
            verification
                .query_row("SELECT COUNT(*) FROM agent_turns", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            3
        );
        assert!(
            verification
                .prepare("SELECT * FROM agent_conversations")
                .is_err()
        );
        drop(verification);

        let recovered = Store::open(&database).unwrap();
        assert_eq!(recovered.migration_outcome().to_schema_version, Some(12));
        assert_eq!(
            recovered
                .list_agent_conversations("D:/projects/A", None)
                .unwrap()[0]
                .turn_count,
            2
        );
    }

    #[test]
    fn rejects_malformed_v11_agent_project_identity_without_advancing_schema() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        create_v11_fixture(&database);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "PRAGMA ignore_check_constraints = ON;
                 UPDATE agent_turns
                 SET project_root = ''
                 WHERE turn_id = 'legacy_turn_a1';
                 PRAGMA ignore_check_constraints = OFF;",
            )
            .unwrap();
        drop(connection);

        let error = Store::open(&database).unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.from_schema_version, Some(11));
        assert_eq!(
            outcome.reason_code.as_deref(),
            Some("malformed_v11_agent_identity")
        );
        assert_eq!(outcome.rejected_count, 1);
        assert!(Path::new(outcome.backup_path.as_deref().unwrap()).exists());

        let verification = Connection::open(&database).unwrap();
        assert_eq!(read_schema_version(&verification).unwrap(), Some(11));
        assert!(
            verification
                .prepare("SELECT * FROM agent_conversations")
                .is_err()
        );
        assert_eq!(
            verification
                .query_row(
                    "SELECT project_root FROM agent_turns WHERE turn_id = 'legacy_turn_a1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            ""
        );
    }

    #[test]
    fn rejects_current_schema_with_a_cross_project_conversation_mapping() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        for (conversation_id, project_root) in [
            ("conversation_a", "D:/projects/A"),
            ("conversation_b", "D:/projects/B"),
        ] {
            store
                .create_agent_conversation(&AgentConversationDraft {
                    conversation_id: conversation_id.to_string(),
                    project_root: project_root.to_string(),
                    title: "Conversation".to_string(),
                    legacy_unthreaded: false,
                })
                .unwrap();
        }
        store
            .create_agent_turn_in_conversation(
                "conversation_a",
                None,
                &AgentTurnDraft {
                    turn_id: "turn_a".to_string(),
                    project_root: "D:/projects/A".to_string(),
                    mode: "ask".to_string(),
                    prompt: "Project A prompt".to_string(),
                    model: "test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 0,
                },
            )
            .unwrap();
        drop(store);

        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "UPDATE agent_conversation_turns
                 SET conversation_id = 'conversation_b'
                 WHERE turn_id = 'turn_a'",
                [],
            )
            .unwrap();
        drop(connection);

        let error = Store::open(&database).unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.from_schema_version, Some(12));
        assert_eq!(
            outcome.reason_code.as_deref(),
            Some("invalid_conversation_mapping")
        );
        assert_eq!(outcome.rejected_count, 1);
    }

    #[test]
    fn normalizes_active_project_root_for_windows_queries() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store.set_project_root(Some("D:\\projects\\A\\")).unwrap();

        assert_eq!(
            store.active_project_root().unwrap().as_deref(),
            Some("D:/projects/A")
        );
        store.set_project_root(Some("C:\\")).unwrap();
        assert_eq!(store.active_project_root().unwrap().as_deref(), Some("C:/"));
        store.set_project_root(Some("\\\\?\\C:\\")).unwrap();
        assert_eq!(
            store.active_project_root().unwrap().as_deref(),
            Some("//?/C:/")
        );
    }
}
