use std::fs;

use rho_store::{
    SEMANTIC_SCHEMA_FINGERPRINT, SemanticOpenStatus, SemanticStore, SemanticStoreError,
    development_reset_semantic_db,
};

fn insert_event(store: &SemanticStore, event_id: &str, seq: i64) {
    store
        .connection()
        .execute(
            "INSERT INTO events(
            event_id, stream_id, stream_seq, schema_version, event_type, priority, channel,
            actor_kind, actor_id, correlation_id, trace_id, sensitivity, payload_json, event_json,
            payload_bytes, occurred_at_ms, committed_at_ms
        ) VALUES (?1, 'stream_main', ?2, 1, 'session_changed', 'p1', 'semantic_durable',
                  'system', 'system', 'correlation_main', 'trace_main', 'project_internal',
                  '{}', '{\"schema_version\":1}', 2, 100, 100)",
            rusqlite::params![event_id, seq],
        )
        .unwrap();
}

#[test]
fn schema_fresh_create_and_reopen_use_current_baseline() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("app-data/rho-semantic.sqlite3");

    let (store, created) = SemanticStore::open_app_local(temp.path(), &db_path).unwrap();
    assert_eq!(created.status, SemanticOpenStatus::Created);
    assert_eq!(created.fingerprint, SEMANTIC_SCHEMA_FINGERPRINT);
    assert!(store.schema_sql().unwrap().contains("CREATE TABLE events"));
    drop(store);

    let (_store, opened) = SemanticStore::open_app_local(temp.path(), &db_path).unwrap();
    assert_eq!(opened.status, SemanticOpenStatus::Opened);
    assert_eq!(opened.fingerprint, SEMANTIC_SCHEMA_FINGERPRINT);
}

#[test]
fn schema_events_have_unique_stream_sequence_and_foreign_keys() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("app/rho-semantic.sqlite3");
    let (store, _outcome) = SemanticStore::open_app_local(temp.path(), &db_path).unwrap();

    insert_event(&store, "event_1", 1);
    let duplicate_seq = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        insert_event(&store, "event_2", 1);
    }));
    assert!(duplicate_seq.is_err());

    let fk_error = store.connection().execute(
        "INSERT INTO sessions(session_id, current_state, created_event_id) VALUES ('session_1', 'open', 'missing_event')",
        [],
    );
    assert!(fk_error.is_err());
}

#[test]
fn schema_rejects_invalid_fingerprint_without_legacy_migration() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("app/rho-semantic.sqlite3");
    let (store, _outcome) = SemanticStore::open_app_local(temp.path(), &db_path).unwrap();
    store
        .connection()
        .execute(
            "UPDATE semantic_metadata SET value = 'old-schema' WHERE key = 'schema_fingerprint'",
            [],
        )
        .unwrap();
    drop(store);

    let result = SemanticStore::open_app_local(temp.path(), &db_path);
    assert!(matches!(
        result,
        Err(SemanticStoreError::InvalidSchema { actual, .. }) if actual == "old-schema"
    ));
}

#[test]
fn schema_allows_concurrent_readers_with_single_wal_writer() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("app/rho-semantic.sqlite3");
    let (writer, _outcome) = SemanticStore::open_app_local(temp.path(), &db_path).unwrap();
    insert_event(&writer, "event_committed", 1);
    let (reader, _outcome) = SemanticStore::open_app_local(temp.path(), &db_path).unwrap();

    writer
        .connection()
        .execute_batch("BEGIN IMMEDIATE;")
        .unwrap();
    writer.connection().execute(
        "INSERT INTO events(
            event_id, stream_id, stream_seq, schema_version, event_type, priority, channel,
            actor_kind, actor_id, correlation_id, trace_id, sensitivity, payload_json, event_json,
            payload_bytes, occurred_at_ms, committed_at_ms
        ) VALUES ('event_uncommitted', 'stream_main', 2, 1, 'session_changed', 'p1', 'semantic_durable',
                  'system', 'system', 'correlation_main', 'trace_main', 'project_internal', '{}', '{\"schema_version\":1}', 2, 100, 100)",
        [],
    ).unwrap();

    let count: i64 = reader
        .connection()
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    writer.connection().execute_batch("COMMIT;").unwrap();
}

#[test]
fn schema_sql_contains_no_legacy_provider_or_secret_storage_fields() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("app/rho-semantic.sqlite3");
    let (store, _outcome) = SemanticStore::open_app_local(temp.path(), &db_path).unwrap();
    let sql = store.schema_sql().unwrap().to_lowercase();

    for forbidden in [
        "acp",
        "ask_plan_act",
        "plaintext_secret",
        "token_delta",
        "legacy",
        "mutable_path_only_artifact",
    ] {
        assert!(
            !sql.contains(forbidden),
            "forbidden schema term leaked: {forbidden}"
        );
    }
    assert!(sql.contains("relation_kind text not null check (relation_kind in ('temporal', 'causal', 'operational', 'scientific'))"));
    assert!(sql.contains("digest text not null check"));
}

#[test]
fn schema_rejects_network_or_non_app_local_database_paths() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside_db = outside.path().join("rho-semantic.sqlite3");
    assert!(matches!(
        SemanticStore::open_app_local(temp.path(), &outside_db),
        Err(SemanticStoreError::OutsideAppRoot)
    ));

    let network_path = std::path::Path::new("//server/share/rho-semantic.sqlite3");
    assert!(matches!(
        SemanticStore::open_app_local(temp.path(), network_path),
        Err(SemanticStoreError::NetworkPlacement)
    ));
}

#[test]
fn schema_development_reset_only_removes_database_wal_and_shm_files() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("app/rho-semantic.sqlite3");
    let project_file = temp.path().join("project/data.csv");
    let cas_blob = temp.path().join("app/cas/sha256/cc");
    fs::create_dir_all(project_file.parent().unwrap()).unwrap();
    fs::create_dir_all(cas_blob.parent().unwrap()).unwrap();
    fs::write(&project_file, "project").unwrap();
    fs::write(&cas_blob, "blob").unwrap();

    let (store, _outcome) = SemanticStore::open_app_local(temp.path(), &db_path).unwrap();
    insert_event(&store, "event_1", 1);
    drop(store);
    fs::write(format!("{}-wal", db_path.display()), "wal").unwrap();
    fs::write(format!("{}-shm", db_path.display()), "shm").unwrap();

    let removed = development_reset_semantic_db(temp.path(), &db_path).unwrap();
    assert_eq!(removed.len(), 3);
    assert!(!db_path.exists());
    assert!(project_file.exists());
    assert!(cas_blob.exists());
}
