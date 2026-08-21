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

pub(crate) fn create_plugin_permission_schema(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS plugin_permission_requests (
            request_id TEXT PRIMARY KEY,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 128),
            plugin_version TEXT NOT NULL CHECK (length(plugin_version) BETWEEN 1 AND 128),
            package_digest TEXT NOT NULL CHECK (
                length(package_digest) = 64 AND
                package_digest = lower(package_digest) AND
                package_digest NOT GLOB '*[^0-9a-f]*'
            ),
            runtime_kind TEXT NOT NULL CHECK (runtime_kind = 'wasm'),
            permission TEXT NOT NULL CHECK (
                permission IN ('project.fs.read', 'workspace.r.inspect', 'network.fetch')
            ),
            constraints_json TEXT NOT NULL CHECK (
                json_valid(constraints_json) AND
                length(CAST(constraints_json AS BLOB)) BETWEEN 2 AND 65536
            ),
            constraints_digest TEXT NOT NULL CHECK (
                length(constraints_digest) = 64 AND
                constraints_digest = lower(constraints_digest) AND
                constraints_digest NOT GLOB '*[^0-9a-f]*'
            ),
            purpose_text TEXT CHECK (
                purpose_text IS NULL OR
                length(CAST(purpose_text AS BLOB)) <= 2048
            ),
            status TEXT NOT NULL CHECK (
                status IN ('pending', 'granted', 'denied', 'cancelled', 'stale')
            ),
            requested_at TEXT NOT NULL,
            resolved_at TEXT,
            decision TEXT CHECK (
                decision IS NULL OR decision IN ('deny', 'allow_once', 'allow_project')
            ),
            grant_source TEXT CHECK (
                grant_source IS NULL OR grant_source IN ('allow_once', 'project')
            ),
            reason_code TEXT CHECK (
                reason_code IS NULL OR length(CAST(reason_code AS BLOB)) <= 256
            ),
            expected_project_revision INTEGER NOT NULL CHECK (expected_project_revision >= 0),
            UNIQUE(request_id, project_root),
            CHECK (
                (status = 'pending' AND resolved_at IS NULL AND decision IS NULL AND grant_source IS NULL) OR
                (status = 'granted' AND resolved_at IS NOT NULL AND decision IN ('allow_once', 'allow_project') AND grant_source IS NOT NULL) OR
                (status = 'denied' AND resolved_at IS NOT NULL AND decision = 'deny' AND grant_source IS NULL) OR
                (status IN ('cancelled', 'stale') AND resolved_at IS NOT NULL AND decision IS NULL AND grant_source IS NULL)
            )
        );

        CREATE TABLE IF NOT EXISTS plugin_permission_grants (
            grant_id TEXT PRIMARY KEY,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 128),
            plugin_version TEXT NOT NULL CHECK (length(plugin_version) BETWEEN 1 AND 128),
            package_digest TEXT NOT NULL CHECK (
                length(package_digest) = 64 AND
                package_digest = lower(package_digest) AND
                package_digest NOT GLOB '*[^0-9a-f]*'
            ),
            runtime_kind TEXT NOT NULL CHECK (runtime_kind = 'wasm'),
            permission TEXT NOT NULL CHECK (
                permission IN ('project.fs.read', 'workspace.r.inspect', 'network.fetch')
            ),
            constraints_json TEXT NOT NULL CHECK (
                json_valid(constraints_json) AND
                length(CAST(constraints_json AS BLOB)) BETWEEN 2 AND 65536
            ),
            constraints_digest TEXT NOT NULL CHECK (
                length(constraints_digest) = 64 AND
                constraints_digest = lower(constraints_digest) AND
                constraints_digest NOT GLOB '*[^0-9a-f]*'
            ),
            grant_source TEXT NOT NULL CHECK (grant_source IN ('allow_once', 'project')),
            policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            revoked_at TEXT,
            consumed_at TEXT,
            status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
            originating_request_id TEXT NOT NULL,
            UNIQUE(grant_id, project_root),
            UNIQUE(originating_request_id),
            FOREIGN KEY(originating_request_id, project_root)
                REFERENCES plugin_permission_requests(request_id, project_root)
                ON DELETE RESTRICT,
            CHECK (
                (status = 'active' AND revoked_at IS NULL AND consumed_at IS NULL) OR
                (status = 'consumed' AND consumed_at IS NOT NULL AND revoked_at IS NULL) OR
                (status = 'revoked' AND revoked_at IS NOT NULL AND consumed_at IS NULL) OR
                (status = 'expired' AND revoked_at IS NULL AND consumed_at IS NULL)
            )
        );

        CREATE TABLE IF NOT EXISTS plugin_permission_events (
            event_id TEXT PRIMARY KEY,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 128),
            package_digest TEXT NOT NULL CHECK (
                length(package_digest) = 64 AND
                package_digest = lower(package_digest) AND
                package_digest NOT GLOB '*[^0-9a-f]*'
            ),
            request_id TEXT,
            grant_id TEXT,
            event_type TEXT NOT NULL CHECK (
                event_type IN (
                    'request_created', 'request_granted', 'request_denied',
                    'request_cancelled', 'request_stale', 'grant_consumed',
                    'grant_revoked', 'grant_expired', 'recovery_cancelled',
                    'handle_minted', 'call_admitted', 'call_denied',
                    'call_completed', 'call_failed', 'call_cancelled',
                    'completion_uncertain'
                )
            ),
            status TEXT NOT NULL CHECK (
                status IN ('pending', 'completed', 'failed', 'cancelled', 'stale')
            ),
            reason_code TEXT CHECK (
                reason_code IS NULL OR length(CAST(reason_code AS BLOB)) <= 256
            ),
            details_json TEXT NOT NULL DEFAULT '{}' CHECK (
                json_valid(details_json) AND
                length(CAST(details_json AS BLOB)) <= 8192
            ),
            created_at TEXT NOT NULL,
            FOREIGN KEY(request_id, project_root)
                REFERENCES plugin_permission_requests(request_id, project_root)
                ON DELETE RESTRICT,
            FOREIGN KEY(grant_id, project_root)
                REFERENCES plugin_permission_grants(grant_id, project_root)
                ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_plugin_permission_requests_project_status
            ON plugin_permission_requests(project_root, status, requested_at DESC);
        CREATE INDEX IF NOT EXISTS idx_plugin_permission_requests_plugin_digest
            ON plugin_permission_requests(project_root, plugin_id, package_digest, requested_at DESC);
        CREATE INDEX IF NOT EXISTS idx_plugin_permission_grants_project_status
            ON plugin_permission_grants(project_root, status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_plugin_permission_grants_plugin_digest
            ON plugin_permission_grants(project_root, plugin_id, package_digest, permission);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_permission_grants_active_identity
            ON plugin_permission_grants(
                project_root, plugin_id, package_digest, runtime_kind, permission,
                constraints_digest, grant_source, policy_revision
            ) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_plugin_permission_events_project_created
            ON plugin_permission_events(project_root, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_plugin_permission_events_request
            ON plugin_permission_events(request_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_plugin_permission_events_grant
            ON plugin_permission_events(grant_id, created_at);
        ",
    )?;
    Ok(())
}

pub(crate) fn assert_plugin_permission_schema(connection: &Connection) -> Result<(), StoreError> {
    for table in [
        "plugin_permission_requests",
        "plugin_permission_grants",
        "plugin_permission_events",
    ] {
        assert_table_exists(connection, table)?;
        assert_not_null_project_identity(connection, table)?;
    }
    for index in [
        "idx_plugin_permission_requests_project_status",
        "idx_plugin_permission_requests_plugin_digest",
        "idx_plugin_permission_grants_project_status",
        "idx_plugin_permission_grants_plugin_digest",
        "idx_plugin_permission_grants_active_identity",
        "idx_plugin_permission_events_project_created",
        "idx_plugin_permission_events_request",
        "idx_plugin_permission_events_grant",
    ] {
        assert_index_exists(connection, index)?;
    }
    assert_table_sql_contains(
        connection,
        "plugin_permission_requests",
        &[
            "runtime_kindtextnotnullcheck(runtime_kind='wasm')",
            "statusin('pending','granted','denied','cancelled','stale')",
            "permissionin('project.fs.read','workspace.r.inspect','network.fetch')",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "plugin_permission_grants",
        &[
            "statusin('active','consumed','revoked','expired')",
            "grant_sourcein('allow_once','project')",
            "foreignkey(originating_request_id,project_root)referencesplugin_permission_requests",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "plugin_permission_events",
        &[
            "'request_created'",
            "'grant_revoked'",
            "'call_admitted'",
            "'completion_uncertain'",
            "foreignkey(grant_id,project_root)referencesplugin_permission_grants",
        ],
    )?;
    for table in [
        "plugin_permission_requests",
        "plugin_permission_grants",
        "plugin_permission_events",
    ] {
        for forbidden in [
            "handle_id",
            "handle_digest",
            "host_instance_id",
            "activation_generation",
            "workspace_id",
        ] {
            assert_column_absent(connection, table, forbidden)?;
        }
    }

    let mismatched_grants: i64 = connection.query_row(
        "SELECT COUNT(*)
         FROM plugin_permission_grants AS grant_record
         JOIN plugin_permission_requests AS request_record
           ON request_record.request_id = grant_record.originating_request_id
         WHERE request_record.project_root <> grant_record.project_root
            OR request_record.plugin_id <> grant_record.plugin_id
            OR request_record.plugin_version <> grant_record.plugin_version
            OR request_record.package_digest <> grant_record.package_digest
            OR request_record.runtime_kind <> grant_record.runtime_kind
            OR request_record.permission <> grant_record.permission
            OR request_record.constraints_digest <> grant_record.constraints_digest
            OR request_record.status <> 'granted'",
        [],
        |row| row.get(0),
    )?;
    let mismatched_events: i64 = connection.query_row(
        "SELECT COUNT(*)
         FROM plugin_permission_events AS event_record
         LEFT JOIN plugin_permission_requests AS request_record
           ON request_record.request_id = event_record.request_id
         LEFT JOIN plugin_permission_grants AS grant_record
           ON grant_record.grant_id = event_record.grant_id
         WHERE (event_record.request_id IS NOT NULL AND (
                   request_record.request_id IS NULL
                OR request_record.project_root <> event_record.project_root
                OR request_record.plugin_id <> event_record.plugin_id
                OR request_record.package_digest <> event_record.package_digest
               ))
            OR (event_record.grant_id IS NOT NULL AND (
                   grant_record.grant_id IS NULL
                OR grant_record.project_root <> event_record.project_root
                OR grant_record.plugin_id <> event_record.plugin_id
                OR grant_record.package_digest <> event_record.package_digest
               ))",
        [],
        |row| row.get(0),
    )?;
    if mismatched_grants != 0 || mismatched_events != 0 {
        return Err(StoreError::MigrationRejected {
            message: "plugin permission identity mapping is not project/digest scoped".to_string(),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts {
                    rejected: mismatched_grants + mismatched_events,
                    ..MigrationRecordCounts::default()
                },
                "invalid_plugin_permission_identity",
            ),
        });
    }
    let foreign_key_failures: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_check
         WHERE \"table\" IN (
            'plugin_permission_requests',
            'plugin_permission_grants',
            'plugin_permission_events'
         )",
        [],
        |row| row.get(0),
    )?;
    if foreign_key_failures != 0 {
        return Err(StoreError::MigrationRejected {
            message: "plugin permission foreign keys are inconsistent".to_string(),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts {
                    rejected: foreign_key_failures,
                    ..MigrationRecordCounts::default()
                },
                "invalid_plugin_permission_foreign_key",
            ),
        });
    }
    Ok(())
}

pub(crate) fn create_plugin_lifecycle_schema(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspace_plugin_states (
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 128),
            directory_name TEXT NOT NULL CHECK (
                length(directory_name) BETWEEN 1 AND 128 AND
                instr(directory_name, '/') = 0 AND instr(directory_name, char(92)) = 0
            ),
            plugin_version TEXT NOT NULL CHECK (length(plugin_version) BETWEEN 1 AND 128),
            accepted_digest TEXT CHECK (
                accepted_digest IS NULL OR (
                    length(accepted_digest) = 64 AND
                    accepted_digest = lower(accepted_digest) AND
                    accepted_digest NOT GLOB '*[^0-9a-f]*'
                )
            ),
            pending_digest TEXT CHECK (
                pending_digest IS NULL OR (
                    length(pending_digest) = 64 AND
                    pending_digest = lower(pending_digest) AND
                    pending_digest NOT GLOB '*[^0-9a-f]*'
                )
            ),
            rollback_digest TEXT CHECK (
                rollback_digest IS NULL OR (
                    length(rollback_digest) = 64 AND
                    rollback_digest = lower(rollback_digest) AND
                    rollback_digest NOT GLOB '*[^0-9a-f]*'
                )
            ),
            runtime_kind TEXT NOT NULL CHECK (runtime_kind = 'wasm'),
            desired_state TEXT NOT NULL CHECK (
                desired_state IN ('disabled', 'enabled', 'uninstalled')
            ),
            observed_state TEXT NOT NULL CHECK (
                observed_state IN (
                    'discovered', 'disabled', 'resolving', 'activating', 'active',
                    'quiescing', 'disposing', 'stopped', 'crashed', 'update_pending',
                    'rollback_pending', 'uninstalled', 'blocked'
                )
            ),
            last_activation_generation INTEGER NOT NULL DEFAULT 0
                CHECK (last_activation_generation >= 0),
            last_host_session_id TEXT CHECK (
                last_host_session_id IS NULL OR length(last_host_session_id) BETWEEN 1 AND 128
            ),
            transition_id TEXT CHECK (
                transition_id IS NULL OR length(transition_id) BETWEEN 1 AND 128
            ),
            last_error_code TEXT CHECK (
                last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128
            ),
            enabled_at TEXT,
            disabled_at TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(project_root, plugin_id)
        );

        CREATE TABLE IF NOT EXISTS workspace_plugin_transitions (
            transition_id TEXT PRIMARY KEY CHECK (length(transition_id) BETWEEN 1 AND 128),
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 128),
            kind TEXT NOT NULL CHECK (
                kind IN (
                    'enable', 'disable', 'uninstall', 'retry', 'upgrade', 'rollback',
                    'project_teardown', 'shutdown'
                )
            ),
            expected_old_digest TEXT CHECK (
                expected_old_digest IS NULL OR (
                    length(expected_old_digest) = 64 AND
                    expected_old_digest = lower(expected_old_digest) AND
                    expected_old_digest NOT GLOB '*[^0-9a-f]*'
                )
            ),
            candidate_digest TEXT CHECK (
                candidate_digest IS NULL OR (
                    length(candidate_digest) = 64 AND
                    candidate_digest = lower(candidate_digest) AND
                    candidate_digest NOT GLOB '*[^0-9a-f]*'
                )
            ),
            rollback_digest TEXT CHECK (
                rollback_digest IS NULL OR (
                    length(rollback_digest) = 64 AND
                    rollback_digest = lower(rollback_digest) AND
                    rollback_digest NOT GLOB '*[^0-9a-f]*'
                )
            ),
            phase TEXT NOT NULL CHECK (length(phase) BETWEEN 1 AND 64),
            status TEXT NOT NULL CHECK (
                status IN (
                    'pending', 'running', 'completed', 'failed', 'cancelled',
                    'completion_uncertain'
                )
            ),
            requested_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            reason_code TEXT CHECK (
                reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128
            ),
            backup_path_key TEXT CHECK (
                backup_path_key IS NULL OR (
                    length(backup_path_key) BETWEEN 1 AND 128 AND
                    instr(backup_path_key, '/') = 0 AND
                    instr(backup_path_key, char(92)) = 0 AND
                    instr(backup_path_key, ':') = 0
                )
            ),
            UNIQUE(transition_id, project_root, plugin_id),
            FOREIGN KEY(project_root, plugin_id)
                REFERENCES workspace_plugin_states(project_root, plugin_id)
                ON DELETE RESTRICT,
            CHECK (
                (status IN ('pending', 'running', 'completion_uncertain') AND completed_at IS NULL) OR
                (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
            )
        );

        CREATE TABLE IF NOT EXISTS workspace_plugin_lifecycle_events (
            event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 128),
            transition_id TEXT,
            package_digest TEXT CHECK (
                package_digest IS NULL OR (
                    length(package_digest) = 64 AND
                    package_digest = lower(package_digest) AND
                    package_digest NOT GLOB '*[^0-9a-f]*'
                )
            ),
            event_type TEXT NOT NULL CHECK (
                event_type IN (
                    'discovery', 'user_requested', 'preflight', 'grant_state',
                    'activation', 'routing_published', 'call_drain', 'call_cancelled',
                    'handles_revoked', 'contributions_disposed', 'host_disposed',
                    'host_quarantined', 'package_backed_up', 'pointer_cas',
                    'rollback', 'recovery', 'transition_completed', 'transition_failed'
                )
            ),
            status TEXT NOT NULL CHECK (
                status IN ('pending', 'completed', 'failed', 'cancelled', 'stale', 'uncertain')
            ),
            phase TEXT NOT NULL CHECK (length(phase) BETWEEN 1 AND 64),
            reason_code TEXT CHECK (
                reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128
            ),
            details_json TEXT NOT NULL DEFAULT '{}' CHECK (
                json_valid(details_json) AND length(CAST(details_json AS BLOB)) <= 8192
            ),
            created_at TEXT NOT NULL,
            FOREIGN KEY(project_root, plugin_id)
                REFERENCES workspace_plugin_states(project_root, plugin_id)
                ON DELETE RESTRICT,
            FOREIGN KEY(transition_id, project_root, plugin_id)
                REFERENCES workspace_plugin_transitions(transition_id, project_root, plugin_id)
                ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS workspace_plugin_package_tombstones (
            tombstone_id TEXT PRIMARY KEY CHECK (length(tombstone_id) BETWEEN 1 AND 128),
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 128),
            package_digest TEXT NOT NULL CHECK (
                length(package_digest) = 64 AND
                package_digest = lower(package_digest) AND
                package_digest NOT GLOB '*[^0-9a-f]*'
            ),
            backup_path_key TEXT NOT NULL UNIQUE CHECK (
                length(backup_path_key) BETWEEN 1 AND 128 AND
                instr(backup_path_key, '/') = 0 AND
                instr(backup_path_key, char(92)) = 0 AND
                instr(backup_path_key, ':') = 0
            ),
            original_directory_name TEXT NOT NULL CHECK (
                length(original_directory_name) BETWEEN 1 AND 128 AND
                instr(original_directory_name, '/') = 0 AND
                instr(original_directory_name, char(92)) = 0
            ),
            moved_at TEXT NOT NULL,
            deleted_at TEXT,
            restored_at TEXT,
            retention_class TEXT NOT NULL CHECK (
                retention_class IN ('recoverable', 'expired', 'purge_pending')
            ),
            reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
            FOREIGN KEY(project_root, plugin_id)
                REFERENCES workspace_plugin_states(project_root, plugin_id)
                ON DELETE RESTRICT,
            CHECK (deleted_at IS NULL OR restored_at IS NULL)
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_plugin_states_project_desired
            ON workspace_plugin_states(project_root, desired_state, observed_state, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workspace_plugin_states_plugin_digest
            ON workspace_plugin_states(project_root, plugin_id, accepted_digest, pending_digest);
        CREATE INDEX IF NOT EXISTS idx_workspace_plugin_transitions_project_status
            ON workspace_plugin_transitions(project_root, status, requested_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workspace_plugin_transitions_plugin_updated
            ON workspace_plugin_transitions(project_root, plugin_id, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_plugin_transitions_one_active
            ON workspace_plugin_transitions(project_root, plugin_id)
            WHERE status IN ('pending', 'running', 'completion_uncertain');
        CREATE INDEX IF NOT EXISTS idx_workspace_plugin_lifecycle_events_project_created
            ON workspace_plugin_lifecycle_events(project_root, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workspace_plugin_lifecycle_events_transition
            ON workspace_plugin_lifecycle_events(transition_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_workspace_plugin_tombstones_project_retention
            ON workspace_plugin_package_tombstones(project_root, retention_class, moved_at DESC);
        ",
    )?;
    Ok(())
}

pub(crate) fn assert_plugin_lifecycle_schema(connection: &Connection) -> Result<(), StoreError> {
    for table in [
        "workspace_plugin_states",
        "workspace_plugin_transitions",
        "workspace_plugin_lifecycle_events",
        "workspace_plugin_package_tombstones",
    ] {
        assert_table_exists(connection, table)?;
        assert_not_null_project_identity(connection, table)?;
    }
    for index in [
        "idx_workspace_plugin_states_project_desired",
        "idx_workspace_plugin_states_plugin_digest",
        "idx_workspace_plugin_transitions_project_status",
        "idx_workspace_plugin_transitions_plugin_updated",
        "idx_workspace_plugin_transitions_one_active",
        "idx_workspace_plugin_lifecycle_events_project_created",
        "idx_workspace_plugin_lifecycle_events_transition",
        "idx_workspace_plugin_tombstones_project_retention",
    ] {
        assert_index_exists(connection, index)?;
    }
    assert_table_sql_contains(
        connection,
        "workspace_plugin_states",
        &[
            "desired_statein('disabled','enabled','uninstalled')",
            "'update_pending'",
            "last_activation_generationintegernotnulldefault0",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "workspace_plugin_transitions",
        &[
            "'project_teardown'",
            "'completion_uncertain'",
            "foreignkey(project_root,plugin_id)referencesworkspace_plugin_states",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "workspace_plugin_lifecycle_events",
        &["'routing_published'", "'host_quarantined'", "'pointer_cas'"],
    )?;
    assert_table_sql_contains(
        connection,
        "workspace_plugin_package_tombstones",
        &[
            "retention_classin('recoverable','expired','purge_pending')",
            "backup_path_keytextnotnullunique",
        ],
    )?;
    for table in [
        "workspace_plugin_states",
        "workspace_plugin_transitions",
        "workspace_plugin_lifecycle_events",
        "workspace_plugin_package_tombstones",
    ] {
        for forbidden in [
            "handle_id",
            "handle_digest",
            "credential",
            "payload_json",
            "wasm_memory",
        ] {
            assert_column_absent(connection, table, forbidden)?;
        }
    }
    let malformed_states: i64 = connection.query_row(
        "SELECT COUNT(*) FROM workspace_plugin_states
         WHERE desired_state NOT IN ('disabled', 'enabled', 'uninstalled')
            OR observed_state NOT IN (
                'discovered', 'disabled', 'resolving', 'activating', 'active',
                'quiescing', 'disposing', 'stopped', 'crashed', 'update_pending',
                'rollback_pending', 'uninstalled', 'blocked'
            )
            OR runtime_kind <> 'wasm'
            OR last_activation_generation < 0
            OR (accepted_digest IS NOT NULL AND (
                length(accepted_digest) <> 64 OR accepted_digest <> lower(accepted_digest)
                OR accepted_digest GLOB '*[^0-9a-f]*'
            ))
            OR (pending_digest IS NOT NULL AND (
                length(pending_digest) <> 64 OR pending_digest <> lower(pending_digest)
                OR pending_digest GLOB '*[^0-9a-f]*'
            ))
            OR (rollback_digest IS NOT NULL AND (
                length(rollback_digest) <> 64 OR rollback_digest <> lower(rollback_digest)
                OR rollback_digest GLOB '*[^0-9a-f]*'
            ))",
        [],
        |row| row.get(0),
    )?;
    let malformed_transitions: i64 = connection.query_row(
        "SELECT COUNT(*) FROM workspace_plugin_transitions
         WHERE kind NOT IN (
                'enable', 'disable', 'uninstall', 'retry', 'upgrade', 'rollback',
                'project_teardown', 'shutdown'
            )
            OR phase NOT IN (
                'requested', 'preflight', 'backup_prepared', 'grants_ready',
                'candidate_activated', 'routing_closed', 'calls_drained',
                'handles_revoked', 'contributions_disposed', 'host_disposed',
                'package_moved', 'pointer_swapped', 'durable_committed', 'completed'
            )
            OR status NOT IN (
                'pending', 'running', 'completed', 'failed', 'cancelled',
                'completion_uncertain'
            )
            OR (
                status IN ('pending', 'running', 'completion_uncertain')
                AND completed_at IS NOT NULL
            )
            OR (
                status IN ('completed', 'failed', 'cancelled')
                AND completed_at IS NULL
            )",
        [],
        |row| row.get(0),
    )?;
    let malformed_events: i64 = connection.query_row(
        "SELECT COUNT(*) FROM workspace_plugin_lifecycle_events
         WHERE event_type NOT IN (
                'discovery', 'user_requested', 'preflight', 'grant_state',
                'activation', 'routing_published', 'call_drain', 'call_cancelled',
                'handles_revoked', 'contributions_disposed', 'host_disposed',
                'host_quarantined', 'package_backed_up', 'pointer_cas',
                'rollback', 'recovery', 'transition_completed', 'transition_failed'
            )
            OR status NOT IN (
                'pending', 'completed', 'failed', 'cancelled', 'stale', 'uncertain'
            )
            OR phase NOT IN (
                'requested', 'preflight', 'backup_prepared', 'grants_ready',
                'candidate_activated', 'routing_closed', 'calls_drained',
                'handles_revoked', 'contributions_disposed', 'host_disposed',
                'package_moved', 'pointer_swapped', 'durable_committed', 'completed'
            )
            OR CASE
                WHEN json_valid(details_json) THEN json_type(details_json) <> 'object'
                ELSE 1
            END
            OR length(CAST(details_json AS BLOB)) > 8192",
        [],
        |row| row.get(0),
    )?;
    let malformed_tombstones: i64 = connection.query_row(
        "SELECT COUNT(*) FROM workspace_plugin_package_tombstones
         WHERE retention_class NOT IN ('recoverable', 'expired', 'purge_pending')
            OR length(package_digest) <> 64
            OR package_digest <> lower(package_digest)
            OR package_digest GLOB '*[^0-9a-f]*'
            OR length(backup_path_key) NOT BETWEEN 1 AND 128
            OR instr(backup_path_key, '/') <> 0
            OR instr(backup_path_key, char(92)) <> 0
            OR instr(backup_path_key, ':') <> 0
            OR length(original_directory_name) NOT BETWEEN 1 AND 128
            OR instr(original_directory_name, '/') <> 0
            OR instr(original_directory_name, char(92)) <> 0
            OR (deleted_at IS NOT NULL AND restored_at IS NOT NULL)",
        [],
        |row| row.get(0),
    )?;
    let malformed_total =
        malformed_states + malformed_transitions + malformed_events + malformed_tombstones;
    if malformed_total != 0 {
        return Err(StoreError::MigrationRejected {
            message: "workspace plugin lifecycle rows contain malformed state".to_string(),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts {
                    rejected: malformed_total,
                    ..MigrationRecordCounts::default()
                },
                "invalid_plugin_lifecycle_state",
            ),
        });
    }
    let foreign_key_failures: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_check
         WHERE \"table\" IN (
            'workspace_plugin_states', 'workspace_plugin_transitions',
            'workspace_plugin_lifecycle_events', 'workspace_plugin_package_tombstones'
         )",
        [],
        |row| row.get(0),
    )?;
    if foreign_key_failures != 0 {
        return Err(StoreError::MigrationRejected {
            message: "workspace plugin lifecycle foreign keys are inconsistent".to_string(),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts {
                    rejected: foreign_key_failures,
                    ..MigrationRecordCounts::default()
                },
                "invalid_plugin_lifecycle_foreign_key",
            ),
        });
    }
    Ok(())
}

fn assert_table_sql_contains(
    connection: &Connection,
    table_name: &str,
    markers: &[&str],
) -> Result<(), StoreError> {
    let sql = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table_name],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    if markers.iter().all(|marker| sql.contains(marker)) {
        Ok(())
    } else {
        let lifecycle = table_name.starts_with("workspace_plugin_");
        Err(StoreError::MigrationRejected {
            message: format!("{table_name} constraints are not current"),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts::default(),
                if lifecycle {
                    "invalid_plugin_lifecycle_schema"
                } else {
                    "invalid_plugin_permission_schema"
                },
            ),
        })
    }
}

fn assert_table_exists(connection: &Connection, table_name: &str) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table_name],
            |_row| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(StoreError::MigrationRejected {
            message: format!("required table {table_name} is missing"),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts::default(),
                "invalid_current_schema",
            ),
        })
    }
}

fn assert_column_absent(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<(), StoreError> {
    let pragma = format!("PRAGMA table_info({table_name})");
    let mut statement = connection.prepare(&pragma)?;
    let present = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column_name);
    if present {
        let lifecycle = table_name.starts_with("workspace_plugin_");
        Err(StoreError::MigrationRejected {
            message: format!(
                "{table_name}.{column_name} must not persist live plugin authority or secrets"
            ),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts::default(),
                if lifecycle {
                    "invalid_plugin_lifecycle_authority"
                } else {
                    "invalid_plugin_permission_authority"
                },
            ),
        })
    } else {
        Ok(())
    }
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
