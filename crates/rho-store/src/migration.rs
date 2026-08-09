use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};

use super::{MigrationOutcome, MigrationRecordCounts, SCHEMA_VERSION, StoreError};

pub(crate) fn database_is_empty(connection: &Connection) -> Result<bool, StoreError> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    Ok(count == 0)
}

pub(crate) fn read_schema_version(connection: &Connection) -> Result<Option<i64>, StoreError> {
    let has_metadata = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
            [],
            |_row| Ok(()),
        )
        .optional()?
        .is_some();
    if !has_metadata {
        return Ok(None);
    }
    Ok(connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse().ok()))
}

pub(crate) fn set_schema_version(connection: &Connection, version: i64) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO metadata(key, value) VALUES('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [version.to_string()],
    )?;
    Ok(())
}

pub(crate) fn v8_schema_sql() -> &'static str {
    "
    CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
    );
    CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        parent_run_id TEXT,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        origin TEXT NOT NULL DEFAULT 'system',
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        terminal_reason TEXT,
        request_type TEXT NOT NULL DEFAULT 'workspace.execute',
        operation_class TEXT NOT NULL DEFAULT 'probe',
        code TEXT NOT NULL DEFAULT '',
        arguments_json TEXT NOT NULL DEFAULT '{}',
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
        messages_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        error_call TEXT,
        traceback_json TEXT NOT NULL DEFAULT '[]',
        error_start_line INTEGER,
        error_start_column INTEGER,
        error_end_line INTEGER,
        error_end_column INTEGER,
        error_range_kind TEXT CHECK (
            error_range_kind IS NULL OR
            error_range_kind IN ('r_expression', 'r_parse_token')
        ),
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        environment_snapshot_id TEXT,
        environment_snapshot_id_after TEXT
    );
    CREATE TABLE workspace_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        payload TEXT NOT NULL
    );
    CREATE TABLE agent_turns (
        turn_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
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
    CREATE TABLE agent_conversations (
        conversation_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        legacy_unthreaded INTEGER NOT NULL DEFAULT 0
            CHECK (legacy_unthreaded IN (0, 1))
    );
    CREATE TABLE agent_conversation_turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        retry_of_turn_id TEXT,
        terminal_reason TEXT,
        FOREIGN KEY(turn_id) REFERENCES agent_turns(turn_id) ON DELETE CASCADE,
        FOREIGN KEY(conversation_id) REFERENCES agent_conversations(conversation_id)
            ON DELETE RESTRICT,
        FOREIGN KEY(retry_of_turn_id) REFERENCES agent_turns(turn_id)
            ON DELETE SET NULL
    );
    CREATE TABLE agent_turn_events (
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
    CREATE TABLE approval_requests (
        request_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
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
        project_root TEXT NOT NULL CHECK (project_root <> ''),
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
    CREATE TABLE artifact_records (
        artifact_id TEXT PRIMARY KEY,
        artifact_kind TEXT NOT NULL,
        run_id TEXT,
        project_root TEXT NOT NULL,
        output_path TEXT NOT NULL,
        source_path TEXT,
        execution_mode TEXT,
        document_version INTEGER,
        workspace_id TEXT,
        state_revision INTEGER,
        project_revision INTEGER,
        media_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        provenance_complete INTEGER NOT NULL DEFAULT 1,
        incomplete_reason TEXT,
        created_at TEXT NOT NULL
    );
    CREATE TABLE environment_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        first_captured_at TEXT NOT NULL,
        last_captured_at TEXT NOT NULL
    );
    CREATE TABLE environment_operation_requests (
        request_id TEXT PRIMARY KEY,
        turn_id TEXT,
        source TEXT NOT NULL,
        request_name TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT,
        reason TEXT,
        project_root TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        preview_sha256 TEXT NOT NULL,
        workspace_id TEXT,
        state_revision INTEGER,
        project_revision INTEGER,
        before_snapshot_id TEXT,
        run_id TEXT,
        requested_at TEXT NOT NULL,
        responded_at TEXT,
        completed_at TEXT,
        terminal_outcome TEXT,
        FOREIGN KEY(turn_id) REFERENCES agent_turns(turn_id) ON DELETE SET NULL
    );
    CREATE INDEX idx_agent_turns_started_at
        ON agent_turns(started_at DESC);
    CREATE INDEX idx_agent_conversations_project_updated
        ON agent_conversations(project_root, updated_at DESC);
    CREATE INDEX idx_agent_conversation_turns_conversation
        ON agent_conversation_turns(conversation_id, turn_id);
    CREATE INDEX idx_agent_turn_events_turn_id
        ON agent_turn_events(turn_id, id);
    CREATE INDEX idx_approval_requests_turn_id
        ON approval_requests(turn_id, requested_at DESC);
    CREATE INDEX idx_approval_requests_status
        ON approval_requests(status, requested_at DESC);
    CREATE INDEX idx_plot_artifacts_created_at
        ON plot_artifacts(created_at DESC);
    CREATE INDEX idx_plot_artifacts_run_id
        ON plot_artifacts(run_id, created_at DESC);
    CREATE INDEX idx_plot_artifacts_project_created
        ON plot_artifacts(project_root, created_at DESC);
    CREATE INDEX idx_artifact_records_created_at
        ON artifact_records(created_at DESC);
    CREATE INDEX idx_artifact_records_run_id
        ON artifact_records(run_id, created_at DESC);
    CREATE INDEX idx_artifact_records_project
        ON artifact_records(project_root, created_at DESC);
    CREATE INDEX idx_environment_snapshots_project_root
        ON environment_snapshots(project_root, last_captured_at DESC);
    CREATE INDEX idx_environment_operation_requests_status
        ON environment_operation_requests(status, requested_at DESC);
    CREATE INDEX idx_environment_operation_requests_turn_id
        ON environment_operation_requests(turn_id, requested_at DESC);
    CREATE INDEX idx_environment_operation_requests_project
        ON environment_operation_requests(project_root, requested_at DESC);
    CREATE INDEX idx_runs_project_started
        ON runs(project_root, started_at DESC);
    CREATE INDEX idx_agent_turns_project_started
        ON agent_turns(project_root, started_at DESC);
    CREATE INDEX idx_approval_requests_project_status
        ON approval_requests(project_root, status, requested_at DESC);
    CREATE TABLE evidence_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        doi TEXT,
        run_id TEXT,
        artifact_id TEXT,
        citation_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_evidence_entries_project
        ON evidence_entries(project_root, created_at DESC);
    CREATE TABLE evidence_claims (
        claim_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('source_range', 'artifact')),
        source_path TEXT,
        start_line INTEGER,
        start_column INTEGER,
        end_line INTEGER,
        end_column INTEGER,
        source_sha256 TEXT,
        source_excerpt TEXT,
        artifact_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
            (anchor_kind = 'source_range' AND source_path IS NOT NULL AND artifact_id IS NULL) OR
            (anchor_kind = 'artifact' AND artifact_id IS NOT NULL AND source_path IS NULL)
        )
    );
    CREATE TABLE claim_evidence_links (
        claim_id TEXT NOT NULL,
        evidence_id INTEGER NOT NULL,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        created_at TEXT NOT NULL,
        PRIMARY KEY(claim_id, evidence_id),
        FOREIGN KEY(claim_id) REFERENCES evidence_claims(claim_id) ON DELETE CASCADE,
        FOREIGN KEY(evidence_id) REFERENCES evidence_entries(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_evidence_claims_project
        ON evidence_claims(project_root, created_at DESC);
    CREATE INDEX idx_claim_evidence_links_project
        ON claim_evidence_links(project_root, claim_id);
    "
}

pub(crate) fn create_claim_review_schema(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<(), StoreError> {
    transaction.execute_batch(
        "
        CREATE TABLE evidence_claims (
            claim_id TEXT PRIMARY KEY,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            kind TEXT NOT NULL,
            summary TEXT NOT NULL,
            anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('source_range', 'artifact')),
            source_path TEXT,
            start_line INTEGER,
            start_column INTEGER,
            end_line INTEGER,
            end_column INTEGER,
            source_sha256 TEXT,
            source_excerpt TEXT,
            artifact_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (
                (anchor_kind = 'source_range' AND source_path IS NOT NULL AND artifact_id IS NULL) OR
                (anchor_kind = 'artifact' AND artifact_id IS NOT NULL AND source_path IS NULL)
            )
        );
        CREATE TABLE claim_evidence_links (
            claim_id TEXT NOT NULL,
            evidence_id INTEGER NOT NULL,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            created_at TEXT NOT NULL,
            PRIMARY KEY(claim_id, evidence_id),
            FOREIGN KEY(claim_id) REFERENCES evidence_claims(claim_id) ON DELETE CASCADE,
            FOREIGN KEY(evidence_id) REFERENCES evidence_entries(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_evidence_claims_project
            ON evidence_claims(project_root, created_at DESC);
        CREATE INDEX idx_claim_evidence_links_project
            ON claim_evidence_links(project_root, claim_id);
        ",
    )?;
    Ok(())
}

pub(crate) fn create_agent_conversation_schema(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<(), StoreError> {
    transaction.execute_batch(
        "
        CREATE TABLE agent_conversations (
            conversation_id TEXT PRIMARY KEY,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT,
            legacy_unthreaded INTEGER NOT NULL DEFAULT 0
                CHECK (legacy_unthreaded IN (0, 1))
        );
        CREATE TABLE agent_conversation_turns (
            turn_id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            retry_of_turn_id TEXT,
            terminal_reason TEXT,
            FOREIGN KEY(turn_id) REFERENCES agent_turns(turn_id) ON DELETE CASCADE,
            FOREIGN KEY(conversation_id) REFERENCES agent_conversations(conversation_id)
                ON DELETE RESTRICT,
            FOREIGN KEY(retry_of_turn_id) REFERENCES agent_turns(turn_id)
                ON DELETE SET NULL
        );
        CREATE INDEX idx_agent_conversations_project_updated
            ON agent_conversations(project_root, updated_at DESC);
        CREATE INDEX idx_agent_conversation_turns_conversation
            ON agent_conversation_turns(conversation_id, turn_id);

        INSERT INTO agent_conversations(
            conversation_id, project_root, title, created_at, updated_at,
            archived_at, legacy_unthreaded
        )
        SELECT
            'legacy_' || lower(hex(CAST(project_root AS BLOB))),
            project_root,
            'Legacy project history',
            MIN(started_at),
            MAX(COALESCE(finished_at, started_at)),
            NULL,
            1
        FROM agent_turns
        GROUP BY project_root;

        INSERT INTO agent_conversation_turns(
            turn_id, conversation_id, retry_of_turn_id, terminal_reason
        )
        SELECT
            turn_id,
            'legacy_' || lower(hex(CAST(project_root AS BLOB))),
            NULL,
            CASE
                WHEN status = 'interrupted' THEN 'legacy_interrupted'
                WHEN status = 'failed' THEN 'agent_failure'
                ELSE NULL
            END
        FROM agent_turns;
        ",
    )?;
    Ok(())
}

pub(crate) fn assert_agent_conversation_schema(connection: &Connection) -> Result<(), StoreError> {
    for table in ["agent_conversations", "agent_conversation_turns"] {
        let exists = connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |_row| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Err(StoreError::MigrationRejected {
                message: format!("required table {table} is missing"),
                outcome: MigrationOutcome::rejected(
                    Some(SCHEMA_VERSION),
                    None,
                    MigrationRecordCounts::default(),
                    "invalid_conversation_schema",
                ),
            });
        }
    }

    assert_not_null_project_identity(connection, "agent_conversations")?;
    assert_index_exists(connection, "idx_agent_conversations_project_updated")?;
    assert_index_exists(connection, "idx_agent_conversation_turns_conversation")?;

    let turn_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM agent_turns", [], |row| row.get(0))?;
    let mapping_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM agent_conversation_turns", [], |row| {
            row.get(0)
        })?;
    let mismatched_project_count: i64 = connection.query_row(
        "SELECT COUNT(*)
         FROM agent_conversation_turns AS link
         JOIN agent_turns AS turn ON turn.turn_id = link.turn_id
         JOIN agent_conversations AS conversation
           ON conversation.conversation_id = link.conversation_id
         WHERE turn.project_root <> conversation.project_root",
        [],
        |row| row.get(0),
    )?;
    let foreign_key_failure_count: i64 = {
        let mut statement =
            connection.prepare("PRAGMA foreign_key_check(agent_conversation_turns)")?;
        statement.query_map([], |_row| Ok(()))?.count() as i64
    };

    if turn_count != mapping_count
        || mismatched_project_count != 0
        || foreign_key_failure_count != 0
    {
        return Err(StoreError::MigrationRejected {
            message: format!(
                "Agent Conversation mapping is inconsistent: turns={turn_count}, mappings={mapping_count}, project_mismatches={mismatched_project_count}, foreign_key_failures={foreign_key_failure_count}"
            ),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts {
                    rejected: (turn_count - mapping_count).abs()
                        + mismatched_project_count
                        + foreign_key_failure_count,
                    ..MigrationRecordCounts::default()
                },
                "invalid_conversation_mapping",
            ),
        });
    }
    Ok(())
}

pub(crate) fn create_pre_migration_backup(
    connection: &Connection,
    path: &Path,
    schema_version: i64,
) -> Result<Option<PathBuf>, StoreError> {
    if path.as_os_str().is_empty() || path == Path::new(":memory:") {
        return Ok(None);
    }
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return Ok(None);
    };
    let backup_path = path.with_file_name(format!("{file_name}.schema-v{schema_version}.bak"));
    if backup_path.exists() {
        std::fs::remove_file(&backup_path)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    }
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    let escaped = backup_path.to_string_lossy().replace('\'', "''");
    connection.execute_batch(&format!("VACUUM INTO '{escaped}'"))?;
    Ok(Some(backup_path))
}

pub(crate) fn v7_record_counts(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<MigrationRecordCounts, StoreError> {
    let mut counts = MigrationRecordCounts::default();
    for table in ["runs", "agent_turns", "approval_requests", "plot_artifacts"] {
        counts += table_project_identity_counts(transaction, table)?;
    }
    Ok(counts)
}

fn table_project_identity_counts(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
) -> Result<MigrationRecordCounts, StoreError> {
    let sql = format!(
        "SELECT
            COALESCE(SUM(CASE WHEN project_root IS NOT NULL AND TRIM(project_root) <> '' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN project_root IS NULL THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN project_root IS NOT NULL AND TRIM(project_root) = '' THEN 1 ELSE 0 END), 0)
         FROM {table}"
    );
    transaction
        .query_row(&sql, [], |row| {
            Ok(MigrationRecordCounts {
                scoped: row.get(0)?,
                legacy_unscoped: row.get(1)?,
                rejected: row.get(2)?,
            })
        })
        .map_err(StoreError::from)
}

pub(crate) fn rebuild_runs_v8(transaction: &rusqlite::Transaction<'_>) -> Result<(), StoreError> {
    transaction.execute_batch(
        "
        ALTER TABLE runs RENAME TO runs_v7;
        CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            parent_run_id TEXT,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            origin TEXT NOT NULL DEFAULT 'system',
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            terminal_reason TEXT,
            request_type TEXT NOT NULL DEFAULT 'workspace.execute',
            operation_class TEXT NOT NULL DEFAULT 'probe',
            code TEXT NOT NULL DEFAULT '',
            arguments_json TEXT NOT NULL DEFAULT '{}',
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
            messages_json TEXT NOT NULL DEFAULT '[]',
            warnings_json TEXT NOT NULL DEFAULT '[]',
            error_message TEXT,
            error_call TEXT,
            traceback_json TEXT NOT NULL DEFAULT '[]',
            error_start_line INTEGER,
            error_start_column INTEGER,
            error_end_line INTEGER,
            error_end_column INTEGER,
            error_range_kind TEXT CHECK (
                error_range_kind IS NULL OR
                error_range_kind IN ('r_expression', 'r_parse_token')
            ),
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            environment_snapshot_id TEXT,
            environment_snapshot_id_after TEXT
        );
        INSERT INTO runs(
            run_id, parent_run_id, project_root, origin, status, started_at, finished_at,
            terminal_reason, request_type, operation_class, code, arguments_json, source_path,
            execution_mode, document_version, workspace_id, state_revision_before,
            project_revision_before, state_revision_after, project_revision_after, stdout,
            value_text, messages_json, warnings_json, error_message, error_call,
            traceback_json, cancel_requested, environment_snapshot_id,
            environment_snapshot_id_after
        )
        SELECT
            run_id,
            parent_run_id,
            COALESCE(project_root, 'legacy_unscoped'),
            origin,
            status,
            started_at,
            finished_at,
            terminal_reason,
            request_type,
            operation_class,
            code,
            arguments_json,
            source_path,
            execution_mode,
            document_version,
            workspace_id,
            state_revision_before,
            project_revision_before,
            state_revision_after,
            project_revision_after,
            stdout,
            value_text,
            messages_json,
            warnings_json,
            error_message,
            error_call,
            traceback_json,
            cancel_requested,
            environment_snapshot_id,
            environment_snapshot_id_after
        FROM runs_v7;
        DROP TABLE runs_v7;
        ",
    )?;
    Ok(())
}

pub(crate) fn rebuild_agent_turns_v8(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<(), StoreError> {
    transaction.execute_batch(
        "
        ALTER TABLE agent_turns RENAME TO agent_turns_v7;
        CREATE TABLE agent_turns (
            turn_id TEXT PRIMARY KEY,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
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
        INSERT INTO agent_turns(
            turn_id, project_root, mode, prompt, prompt_preview, model, status, started_at,
            finished_at, workspace_id_before, state_revision_before, project_revision_before,
            workspace_id_after, state_revision_after, project_revision_after, final_message,
            error_message
        )
        SELECT
            turn_id,
            COALESCE(project_root, 'legacy_unscoped'),
            mode,
            prompt,
            prompt_preview,
            model,
            status,
            started_at,
            finished_at,
            workspace_id_before,
            state_revision_before,
            project_revision_before,
            workspace_id_after,
            state_revision_after,
            project_revision_after,
            final_message,
            error_message
        FROM agent_turns_v7;
        ",
    )?;
    Ok(())
}

pub(crate) fn rebuild_approval_requests_v8(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<(), StoreError> {
    transaction.execute_batch(
        "
        ALTER TABLE approval_requests RENAME TO approval_requests_v7;
        CREATE TABLE approval_requests (
            request_id TEXT PRIMARY KEY,
            turn_id TEXT NOT NULL,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
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
        INSERT INTO approval_requests(
            request_id, turn_id, project_root, tool, policy, status, decision, reason,
            arguments_json, code, workspace_id, state_revision, project_revision, requested_at,
            responded_at, continuation_outcome
        )
        SELECT
            request_id,
            turn_id,
            COALESCE(project_root, 'legacy_unscoped'),
            tool,
            policy,
            status,
            decision,
            reason,
            arguments_json,
            code,
            workspace_id,
            state_revision,
            project_revision,
            requested_at,
            responded_at,
            continuation_outcome
        FROM approval_requests_v7;
        DROP TABLE approval_requests_v7;
        DROP TABLE agent_turns_v7;
        ",
    )?;
    Ok(())
}

pub(crate) fn rebuild_plot_artifacts_v8(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<(), StoreError> {
    transaction.execute_batch(
        "
        ALTER TABLE plot_artifacts RENAME TO plot_artifacts_v7;
        CREATE TABLE plot_artifacts (
            plot_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
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
        INSERT INTO plot_artifacts(
            plot_id, run_id, project_root, source_path, execution_mode, document_version,
            workspace_id, state_revision, project_revision, media_type, payload_json,
            provenance_complete, created_at
        )
        SELECT
            plot_id,
            run_id,
            COALESCE(project_root, 'legacy_unscoped'),
            source_path,
            execution_mode,
            document_version,
            workspace_id,
            state_revision,
            project_revision,
            media_type,
            payload_json,
            provenance_complete,
            created_at
        FROM plot_artifacts_v7;
        DROP TABLE plot_artifacts_v7;
        ",
    )?;
    Ok(())
}

pub(crate) fn assert_not_null_project_identity(
    connection: &Connection,
    table: &str,
) -> Result<(), StoreError> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&pragma)?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows {
        let (name, declared_type, not_null) = row?;
        if name == "project_root" {
            if declared_type.eq_ignore_ascii_case("TEXT") && not_null == 1 {
                return Ok(());
            }
            return Err(StoreError::MigrationRejected {
                message: format!("{table}.project_root must be TEXT NOT NULL"),
                outcome: MigrationOutcome::rejected(
                    Some(SCHEMA_VERSION),
                    None,
                    MigrationRecordCounts::default(),
                    "invalid_v8_schema",
                ),
            });
        }
    }
    Err(StoreError::MigrationRejected {
        message: format!("{table}.project_root column is missing"),
        outcome: MigrationOutcome::rejected(
            Some(SCHEMA_VERSION),
            None,
            MigrationRecordCounts::default(),
            "invalid_v8_schema",
        ),
    })
}

pub(crate) fn assert_index_exists(
    connection: &Connection,
    index_name: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1",
            [index_name],
            |_row| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(StoreError::MigrationRejected {
            message: format!("required index {index_name} is missing"),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts::default(),
                "invalid_v8_schema",
            ),
        })
    }
}

pub(crate) fn add_run_error_range_columns(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<(), StoreError> {
    transaction.execute_batch(
        "ALTER TABLE runs ADD COLUMN error_start_line INTEGER;
         ALTER TABLE runs ADD COLUMN error_start_column INTEGER;
         ALTER TABLE runs ADD COLUMN error_end_line INTEGER;
         ALTER TABLE runs ADD COLUMN error_end_column INTEGER;
         ALTER TABLE runs ADD COLUMN error_range_kind TEXT CHECK (
             error_range_kind IS NULL OR
             error_range_kind IN ('r_expression', 'r_parse_token')
         );",
    )?;
    Ok(())
}

pub(crate) fn rebuild_runs_error_range_kind_v11(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<(), StoreError> {
    transaction.execute_batch(
        "DROP INDEX IF EXISTS idx_runs_project_started;
         ALTER TABLE runs RENAME TO runs_v10;
         CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            parent_run_id TEXT,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            origin TEXT NOT NULL DEFAULT 'system',
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            terminal_reason TEXT,
            request_type TEXT NOT NULL DEFAULT 'workspace.execute',
            operation_class TEXT NOT NULL DEFAULT 'probe',
            code TEXT NOT NULL DEFAULT '',
            arguments_json TEXT NOT NULL DEFAULT '{}',
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
            messages_json TEXT NOT NULL DEFAULT '[]',
            warnings_json TEXT NOT NULL DEFAULT '[]',
            error_message TEXT,
            error_call TEXT,
            traceback_json TEXT NOT NULL DEFAULT '[]',
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            environment_snapshot_id TEXT,
            environment_snapshot_id_after TEXT,
            error_start_line INTEGER,
            error_start_column INTEGER,
            error_end_line INTEGER,
            error_end_column INTEGER,
            error_range_kind TEXT CHECK (
                error_range_kind IS NULL OR
                error_range_kind IN ('r_expression', 'r_parse_token')
            )
         );
         INSERT INTO runs(
            run_id, parent_run_id, project_root, origin, status, started_at,
            finished_at, terminal_reason, request_type, operation_class, code,
            arguments_json, source_path, execution_mode, document_version,
            workspace_id, state_revision_before, project_revision_before,
            state_revision_after, project_revision_after, stdout, value_text,
            messages_json, warnings_json, error_message, error_call,
            traceback_json, cancel_requested, environment_snapshot_id,
            environment_snapshot_id_after, error_start_line,
            error_start_column, error_end_line, error_end_column,
            error_range_kind
         )
         SELECT
            run_id, parent_run_id, project_root, origin, status, started_at,
            finished_at, terminal_reason, request_type, operation_class, code,
            arguments_json, source_path, execution_mode, document_version,
            workspace_id, state_revision_before, project_revision_before,
            state_revision_after, project_revision_after, stdout, value_text,
            messages_json, warnings_json, error_message, error_call,
            traceback_json, cancel_requested, environment_snapshot_id,
            environment_snapshot_id_after, error_start_line,
            error_start_column, error_end_line, error_end_column,
            error_range_kind
         FROM runs_v10;
         DROP TABLE runs_v10;
         CREATE INDEX idx_runs_project_started
            ON runs(project_root, started_at DESC);",
    )?;
    Ok(())
}

pub(crate) fn assert_runs_error_range_kind_constraint(
    connection: &Connection,
) -> Result<(), StoreError> {
    let sql = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let compact = sql
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    if compact.contains("error_range_kindin('r_expression','r_parse_token')") {
        Ok(())
    } else {
        Err(StoreError::MigrationRejected {
            message: "runs.error_range_kind constraint is not current".to_string(),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts::default(),
                "invalid_current_schema",
            ),
        })
    }
}

pub(crate) fn assert_column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<(), StoreError> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&pragma)?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column);
    if exists {
        Ok(())
    } else {
        Err(StoreError::MigrationRejected {
            message: format!("{table}.{column} column is missing"),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts::default(),
                "invalid_current_schema",
            ),
        })
    }
}
