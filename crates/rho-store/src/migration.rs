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

pub(crate) fn current_schema_sql() -> &'static str {
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
    CREATE TABLE environment_desired_revisions (
        revision_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        environment_id TEXT NOT NULL CHECK (environment_id <> ''),
        canonical_json TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE environment_realization_revisions (
        revision_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        environment_id TEXT NOT NULL CHECK (environment_id <> ''),
        canonical_json TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE environment_plan_reviews (
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        plan_id TEXT NOT NULL CHECK (plan_id <> ''),
        environment_id TEXT NOT NULL CHECK (environment_id <> ''),
        canonical_plan_json TEXT NOT NULL CHECK (json_valid(canonical_plan_json)),
        status TEXT NOT NULL CHECK (
            status IN ('materialized', 'approved', 'rejected', 'dispatched', 'expired', 'superseded')
        ),
        approval_lease_id TEXT,
        operation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_root, plan_id),
        CHECK (
            (status = 'materialized' AND approval_lease_id IS NULL AND operation_id IS NULL) OR
            (status IN ('approved', 'dispatched') AND approval_lease_id IS NOT NULL AND operation_id IS NOT NULL) OR
            (status IN ('rejected', 'expired', 'superseded'))
        )
    );
    CREATE TABLE environment_operation_receipts (
        receipt_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        environment_id TEXT NOT NULL CHECK (environment_id <> ''),
        plan_id TEXT NOT NULL CHECK (plan_id <> ''),
        outcome TEXT NOT NULL CHECK (
            outcome IN ('succeeded', 'failed', 'cancelled', 'uncertain', 'reconcile_required')
        ),
        canonical_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
    );
    CREATE TABLE environment_operation_journal (
        operation_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        environment_id TEXT NOT NULL CHECK (environment_id <> ''),
        plan_id TEXT NOT NULL CHECK (plan_id <> ''),
        canonical_plan_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
            status IN ('prepared', 'running', 'verifying', 'succeeded', 'failed',
                       'cancelled', 'uncertain', 'reconcile_required')
        ),
        next_checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE environment_operation_checkpoints (
        operation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        name TEXT NOT NULL CHECK (name <> ''),
        digest TEXT,
        reached_at TEXT NOT NULL,
        PRIMARY KEY(operation_id, sequence),
        FOREIGN KEY(operation_id) REFERENCES environment_operation_journal(operation_id)
            ON DELETE CASCADE
    );
    CREATE TABLE environment_incidents (
        incident_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        environment_id TEXT NOT NULL CHECK (environment_id <> ''),
        kind TEXT NOT NULL CHECK (kind <> ''),
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        canonical_json TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        resolved_at TEXT
    );
    CREATE TABLE workspace_environment_bindings (
        project_root TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL CHECK (environment_id <> ''),
        desired_revision TEXT NOT NULL CHECK (desired_revision <> ''),
        realization_revision TEXT NOT NULL CHECK (realization_revision <> ''),
        receipt_id TEXT NOT NULL CHECK (receipt_id <> ''),
        receipt_digest TEXT NOT NULL CHECK (receipt_digest <> ''),
        updated_at TEXT NOT NULL
    );
    CREATE TABLE authority_receipt_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_root TEXT NOT NULL CHECK (project_root <> ''),
        authority_kind TEXT NOT NULL CHECK (
            authority_kind IN ('run', 'artifact', 'approval', 'environment_snapshot', 'agent_turn')
        ),
        authority_id TEXT NOT NULL CHECK (authority_id <> ''),
        changed_at TEXT NOT NULL
    );
    CREATE TRIGGER authority_run_insert AFTER INSERT ON runs BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'run', NEW.run_id, NEW.started_at);
    END;
    CREATE TRIGGER authority_run_update AFTER UPDATE ON runs BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'run', NEW.run_id, COALESCE(NEW.finished_at, NEW.started_at));
    END;
    CREATE TRIGGER authority_artifact_insert AFTER INSERT ON artifact_records BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'artifact', NEW.artifact_id, NEW.created_at);
    END;
    CREATE TRIGGER authority_artifact_update AFTER UPDATE ON artifact_records BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'artifact', NEW.artifact_id, NEW.created_at);
    END;
    CREATE TRIGGER authority_approval_insert AFTER INSERT ON approval_requests BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'approval', NEW.request_id, NEW.requested_at);
    END;
    CREATE TRIGGER authority_approval_update AFTER UPDATE ON approval_requests BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'approval', NEW.request_id, COALESCE(NEW.responded_at, NEW.requested_at));
    END;
    CREATE TRIGGER authority_environment_insert AFTER INSERT ON environment_snapshots BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'environment_snapshot', NEW.snapshot_id, NEW.last_captured_at);
    END;
    CREATE TRIGGER authority_environment_update AFTER UPDATE ON environment_snapshots BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'environment_snapshot', NEW.snapshot_id, NEW.last_captured_at);
    END;
    CREATE TRIGGER authority_agent_turn_insert AFTER INSERT ON agent_turns BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'agent_turn', NEW.turn_id, NEW.started_at);
    END;
    CREATE TRIGGER authority_agent_turn_update AFTER UPDATE ON agent_turns BEGIN
        INSERT INTO authority_receipt_log(project_root, authority_kind, authority_id, changed_at)
        VALUES(NEW.project_root, 'agent_turn', NEW.turn_id, COALESCE(NEW.finished_at, NEW.started_at));
    END;
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
    CREATE INDEX idx_environment_desired_project_created
        ON environment_desired_revisions(project_root, created_at DESC);
    CREATE INDEX idx_environment_realization_project_created
        ON environment_realization_revisions(project_root, created_at DESC);
    CREATE INDEX idx_environment_plan_reviews_project_status
        ON environment_plan_reviews(project_root, status, updated_at DESC);
    CREATE INDEX idx_environment_receipts_project_recorded
        ON environment_operation_receipts(project_root, recorded_at DESC);
    CREATE INDEX idx_environment_journal_project_updated
        ON environment_operation_journal(project_root, updated_at DESC);
    CREATE UNIQUE INDEX idx_environment_journal_project_plan
        ON environment_operation_journal(project_root, plan_id);
    CREATE INDEX idx_environment_incidents_project_status
        ON environment_incidents(project_root, status, detected_at DESC);
    CREATE INDEX idx_runs_project_started
        ON runs(project_root, started_at DESC);
    CREATE INDEX idx_agent_turns_project_started
        ON agent_turns(project_root, started_at DESC);
    CREATE INDEX idx_approval_requests_project_status
        ON approval_requests(project_root, status, requested_at DESC);
    CREATE INDEX idx_authority_receipt_log_project_seq
        ON authority_receipt_log(project_root, seq);
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

pub(crate) fn assert_table_exists(
    connection: &Connection,
    table_name: &str,
) -> Result<(), StoreError> {
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

pub(crate) fn assert_table_absent(
    connection: &Connection,
    table_name: &str,
) -> Result<(), StoreError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table_name],
            |_row| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        Ok(())
    } else {
        Err(StoreError::MigrationRejected {
            message: format!("retired table {table_name} is still present"),
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

pub(crate) fn create_runtime_output_schema(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(
        "
        CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_id_project
            ON runs(run_id, project_root);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_id_project
            ON agent_turns(turn_id, project_root);

        CREATE TABLE IF NOT EXISTS runtime_executions (
            execution_id TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 128),
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            run_id TEXT,
            runtime_provider_id TEXT NOT NULL CHECK (
                length(runtime_provider_id) BETWEEN 1 AND 128
            ),
            runtime_instance_id TEXT NOT NULL CHECK (
                length(runtime_instance_id) BETWEEN 1 AND 128
            ),
            runtime_activation_generation INTEGER NOT NULL CHECK (
                runtime_activation_generation > 0
            ),
            console_instance_id TEXT NOT NULL CHECK (
                length(console_instance_id) BETWEEN 1 AND 128
            ),
            workspace_id TEXT CHECK (
                workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 128
            ),
            source_path TEXT,
            execution_mode TEXT CHECK (
                execution_mode IS NULL OR length(execution_mode) BETWEEN 1 AND 64
            ),
            document_version INTEGER CHECK (
                document_version IS NULL OR document_version >= 0
            ),
            submitted_code TEXT NOT NULL CHECK (
                length(CAST(submitted_code AS BLOB)) BETWEEN 1 AND 1048576
            ),
            status TEXT NOT NULL CHECK (
                status IN ('admitted', 'running', 'completed', 'failed', 'interrupted')
            ),
            terminal_reason TEXT CHECK (
                terminal_reason IS NULL OR
                length(CAST(terminal_reason AS BLOB)) <= 2048
            ),
            output_state TEXT NOT NULL CHECK (
                output_state IN ('collecting', 'complete', 'partial', 'unavailable', 'pruned')
            ),
            last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
            output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
            started_at TEXT NOT NULL,
            finished_at TEXT,
            PRIMARY KEY(execution_id, project_root),
            FOREIGN KEY(run_id, project_root)
                REFERENCES runs(run_id, project_root) ON DELETE RESTRICT,
            CHECK (
                (status IN ('admitted', 'running') AND finished_at IS NULL AND
                    output_state IN ('collecting', 'partial')) OR
                (status IN ('completed', 'failed', 'interrupted') AND
                    finished_at IS NOT NULL AND output_state <> 'collecting')
            )
        );

        CREATE TABLE IF NOT EXISTS runtime_output_chunks (
            execution_id TEXT NOT NULL,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            sequence INTEGER NOT NULL CHECK (sequence > 0),
            producer_sequence INTEGER NOT NULL CHECK (producer_sequence >= 0),
            projection_slot INTEGER NOT NULL DEFAULT 0 CHECK (projection_slot >= 0),
            source_kind TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
            presentation_kind TEXT NOT NULL CHECK (
                presentation_kind IN (
                    'stdout', 'value', 'message', 'warning', 'error', 'status',
                    'display_ref'
                )
            ),
            media_type TEXT CHECK (
                media_type IS NULL OR length(media_type) BETWEEN 1 AND 255
            ),
            storage_kind TEXT NOT NULL CHECK (
                storage_kind IN ('inline_text', 'inline_json', 'record_ref', 'tombstone')
            ),
            text_payload TEXT,
            json_payload TEXT,
            reference_kind TEXT CHECK (
                reference_kind IS NULL OR reference_kind IN ('plot', 'artifact')
            ),
            reference_id TEXT CHECK (
                reference_id IS NULL OR length(reference_id) BETWEEN 1 AND 128
            ),
            payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
            payload_sha256 TEXT NOT NULL CHECK (
                length(payload_sha256) = 64 AND
                payload_sha256 = lower(payload_sha256) AND
                payload_sha256 NOT GLOB '*[^0-9a-f]*'
            ),
            created_at TEXT NOT NULL,
            PRIMARY KEY(execution_id, project_root, sequence),
            UNIQUE(execution_id, project_root, producer_sequence, projection_slot),
            FOREIGN KEY(execution_id, project_root)
                REFERENCES runtime_executions(execution_id, project_root)
                ON DELETE CASCADE,
            CHECK (
                (storage_kind = 'inline_text' AND text_payload IS NOT NULL AND
                    length(CAST(text_payload AS BLOB)) = payload_bytes AND
                    payload_bytes <= 65536 AND
                    json_payload IS NULL AND reference_kind IS NULL AND
                    reference_id IS NULL) OR
                (storage_kind = 'inline_json' AND text_payload IS NULL AND
                    json_payload IS NOT NULL AND json_valid(json_payload) AND
                    length(CAST(json_payload AS BLOB)) = payload_bytes AND
                    payload_bytes <= 65536 AND
                    reference_kind IS NULL AND reference_id IS NULL) OR
                (storage_kind = 'record_ref' AND text_payload IS NULL AND
                    json_payload IS NULL AND reference_kind IS NOT NULL AND
                    reference_id IS NOT NULL) OR
                (storage_kind = 'tombstone' AND text_payload IS NULL AND
                    json_payload IS NOT NULL AND json_valid(json_payload) AND
                    length(CAST(json_payload AS BLOB)) = payload_bytes AND
                    payload_bytes <= 65536 AND
                    reference_kind IS NULL AND reference_id IS NULL)
            )
        );

        CREATE TABLE IF NOT EXISTS agent_turn_context_items (
            context_item_id TEXT PRIMARY KEY CHECK (
                length(context_item_id) BETWEEN 1 AND 128
            ),
            turn_id TEXT NOT NULL,
            project_root TEXT NOT NULL CHECK (project_root <> ''),
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            source_kind TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
            source_id TEXT CHECK (
                source_id IS NULL OR length(CAST(source_id AS BLOB)) <= 512
            ),
            source_revision TEXT CHECK (
                source_revision IS NULL OR
                length(CAST(source_revision AS BLOB)) <= 512
            ),
            source_sha256 TEXT NOT NULL CHECK (
                length(source_sha256) = 64 AND
                source_sha256 = lower(source_sha256) AND
                source_sha256 NOT GLOB '*[^0-9a-f]*'
            ),
            trust_class TEXT NOT NULL CHECK (length(trust_class) BETWEEN 1 AND 64),
            capacity_source TEXT NOT NULL CHECK (
                capacity_source IN ('catalog', 'user', 'conservative')
            ),
            original_bytes INTEGER NOT NULL CHECK (original_bytes >= 0),
            included_bytes INTEGER NOT NULL CHECK (
                included_bytes >= 0 AND included_bytes <= original_bytes
            ),
            estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
            disposition TEXT NOT NULL CHECK (
                disposition IN (
                    'complete', 'projected', 'truncated', 'omitted',
                    'unavailable', 'rejected'
                )
            ),
            reason_code TEXT CHECK (
                reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128
            ),
            UNIQUE(turn_id, ordinal),
            FOREIGN KEY(turn_id, project_root)
                REFERENCES agent_turns(turn_id, project_root) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS project_runtime_output_policies (
            project_root TEXT NOT NULL PRIMARY KEY CHECK (project_root <> ''),
            revision INTEGER NOT NULL CHECK (revision >= 0),
            max_runtime_output_bytes_per_execution INTEGER CHECK (
                max_runtime_output_bytes_per_execution IS NULL OR
                max_runtime_output_bytes_per_execution >= 0
            ),
            runtime_output_project_warning_bytes INTEGER CHECK (
                runtime_output_project_warning_bytes IS NULL OR
                runtime_output_project_warning_bytes >= 0
            ),
            max_runtime_execution_rows INTEGER CHECK (
                max_runtime_execution_rows IS NULL OR max_runtime_execution_rows > 0
            ),
            auto_prune_enabled INTEGER NOT NULL DEFAULT 0 CHECK (
                auto_prune_enabled = 0
            ),
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_executions_project_started
            ON runtime_executions(project_root, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runtime_executions_console_started
            ON runtime_executions(project_root, console_instance_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runtime_executions_workspace_started
            ON runtime_executions(project_root, workspace_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runtime_output_project_execution_sequence
            ON runtime_output_chunks(project_root, execution_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_agent_turn_context_project_turn
            ON agent_turn_context_items(project_root, turn_id, ordinal);
        ",
    )?;
    Ok(())
}

pub(crate) fn assert_runtime_output_schema(connection: &Connection) -> Result<(), StoreError> {
    for table in [
        "runtime_executions",
        "runtime_output_chunks",
        "agent_turn_context_items",
        "project_runtime_output_policies",
    ] {
        assert_table_exists(connection, table)?;
        assert_not_null_project_identity(connection, table)?;
    }
    for index in [
        "idx_runs_id_project",
        "idx_agent_turns_id_project",
        "idx_runtime_executions_project_started",
        "idx_runtime_executions_console_started",
        "idx_runtime_executions_workspace_started",
        "idx_runtime_output_project_execution_sequence",
        "idx_agent_turn_context_project_turn",
    ] {
        assert_index_exists(connection, index)?;
    }
    assert_table_sql_contains(
        connection,
        "runtime_executions",
        &[
            "statusin('admitted','running','completed','failed','interrupted')",
            "output_statein('collecting','complete','partial','unavailable','pruned')",
            "length(cast(submitted_codeasblob))between1and1048576",
            "foreignkey(run_id,project_root)referencesruns(run_id,project_root)",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "project_runtime_output_policies",
        &[
            "revisionintegernotnullcheck(revision>=0)",
            "auto_prune_enabledintegernotnulldefault0check(auto_prune_enabled=0)",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "runtime_output_chunks",
        &[
            "storage_kindin('inline_text','inline_json','record_ref','tombstone')",
            "unique(execution_id,project_root,producer_sequence,projection_slot)",
            "foreignkey(execution_id,project_root)referencesruntime_executions",
        ],
    )?;
    assert_table_sql_contains(
        connection,
        "agent_turn_context_items",
        &[
            "included_bytes<=original_bytes",
            "capacity_sourcein('catalog','user','conservative')",
            "foreignkey(turn_id,project_root)referencesagent_turns(turn_id,project_root)",
        ],
    )?;

    let foreign_key_failures: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_foreign_key_check
         WHERE \"table\" IN (
            'runtime_executions', 'runtime_output_chunks', 'agent_turn_context_items',
            'project_runtime_output_policies'
         )",
        [],
        |row| row.get(0),
    )?;
    if foreign_key_failures != 0 {
        return Err(StoreError::MigrationRejected {
            message: "Runtime output or Agent context foreign keys are inconsistent".to_string(),
            outcome: MigrationOutcome::rejected(
                Some(SCHEMA_VERSION),
                None,
                MigrationRecordCounts {
                    rejected: foreign_key_failures,
                    ..MigrationRecordCounts::default()
                },
                "invalid_runtime_output_foreign_key",
            ),
        });
    }
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
