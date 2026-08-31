use std::time::{Duration, Instant};

use rho_protocol::*;
use rho_store::*;
use rusqlite::Connection;

fn event(label: &str, seq: u64, operation: Option<&str>) -> SemanticEvent {
    let mut metadata = EventEnvelopeMetadata::new(
        EventId::new(format!("event_fault_{label}")).unwrap(),
        StreamId::new("stream_fault").unwrap(),
        StreamSeq(seq),
        Actor {
            kind: ActorKind::System,
            id: "system".to_string(),
        },
        CorrelationId::new("correlation_fault").unwrap(),
        TraceId::new("trace_fault").unwrap(),
    );
    metadata.operation_id = operation.map(|value| OperationId::new(value).unwrap());
    SemanticEvent::new(
        metadata,
        SemanticEventPayload::RecoveryRecorded {
            object: format!("object_{label}"),
            known_truth: "bounded recovery truth".to_string(),
        },
    )
    .unwrap()
}

fn open() -> (tempfile::TempDir, SemanticStore) {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/semantic.sqlite3");
    let (store, _) = SemanticStore::open_app_local(temp.path(), &db).unwrap();
    (temp, store)
}

#[test]
fn fault_transaction_matrix_never_splits_event_and_projection_or_claims_success() {
    for point in [
        AppendCrashPoint::BeforeTransaction,
        AppendCrashPoint::AfterEventInsert,
        AppendCrashPoint::AfterProjectionUpdate,
        AppendCrashPoint::AfterCommit,
    ] {
        let (_temp, mut store) = open();
        let result = store.append_semantic_event_with_crash(
            StreamSeq(0),
            &event("matrix", 0, Some("operation_fault_matrix")),
            Some(point),
        );
        assert!(matches!(result, Err(SemanticAppendError::CrashInjected(p)) if p == point));
        let events: i64 = store
            .connection()
            .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
            .unwrap();
        let projections: i64 = store
            .connection()
            .query_row("SELECT count(*) FROM current_projection", [], |row| {
                row.get(0)
            })
            .unwrap();
        if point == AppendCrashPoint::AfterCommit {
            assert_eq!((events, projections), (1, 1));
        } else {
            assert_eq!((events, projections), (0, 0));
        }
    }
}

#[test]
fn fault_database_busy_full_and_readonly_leave_no_false_event_or_projection() {
    // Busy writer.
    let (_temp, mut store) = open();
    store
        .connection()
        .busy_timeout(Duration::from_millis(5))
        .unwrap();
    let blocker = Connection::open(store.path()).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(
        store
            .append_semantic_event(StreamSeq(0), &event("busy", 0, None))
            .is_err()
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        store
            .connection()
            .query_row("SELECT count(*) FROM events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );

    // Disk-full-like SQLite abort at the authoritative insert point.
    store
        .connection()
        .execute_batch(
            "CREATE TRIGGER fault_database_full BEFORE INSERT ON events
             BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;",
        )
        .unwrap();
    assert!(
        store
            .append_semantic_event(StreamSeq(0), &event("full", 0, None))
            .is_err()
    );
    store
        .connection()
        .execute_batch("DROP TRIGGER fault_database_full")
        .unwrap();

    // Permission/read-only-like connection policy.
    store
        .connection()
        .pragma_update(None, "query_only", "ON")
        .unwrap();
    assert!(
        store
            .append_semantic_event(StreamSeq(0), &event("readonly", 0, None))
            .is_err()
    );
    store
        .connection()
        .pragma_update(None, "query_only", "OFF")
        .unwrap();
    assert!(store.projection_snapshot().unwrap().is_empty());
}

#[test]
fn fault_duplicate_recovery_is_idempotent_and_never_duplicates_terminal_effect() {
    let (_temp, mut store) = open();
    let first = event("dedupe_one", 0, Some("operation_fault_dedupe"));
    store.append_semantic_event(StreamSeq(0), &first).unwrap();
    let duplicate = event("dedupe_two", 1, Some("operation_fault_dedupe"));
    assert!(matches!(
        store.append_semantic_event(StreamSeq(1), &duplicate).unwrap(),
        AppendOutcome::DuplicateOperation { existing_event_id, .. }
            if existing_event_id == first.metadata.event_id.as_str()
    ));
    assert_eq!(
        store
            .connection()
            .query_row("SELECT count(*) FROM events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn fault_startup_verifier_classifies_healthy_projection_rebuild_and_corruption_actions() {
    let (_temp, store) = open();
    assert_eq!(
        verify_semantic_store(&store).class,
        StoreHealthClass::Healthy
    );
    store
        .connection()
        .pragma_update(None, "foreign_keys", "OFF")
        .unwrap();
    store
        .connection()
        .execute(
            "INSERT INTO current_projection(key, value_json, source_event_id)
             VALUES ('fault_orphan_projection', '{}', 'event_missing')",
            [],
        )
        .unwrap();
    store
        .connection()
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    let report = verify_semantic_store(&store);
    assert_eq!(report.class, StoreHealthClass::ProjectionRebuildRequired);
    assert!(report.safe_action.contains("rebuild"));
    assert!(
        !serde_json::to_string(&report)
            .unwrap()
            .contains("CANARY_SENSITIVE_PAYLOAD")
    );
}

#[test]
fn fault_corrupt_database_blocks_only_affected_store_with_bounded_diagnostic() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/corrupt.sqlite3");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    std::fs::write(&db, b"CANARY_SENSITIVE_PAYLOAD not a database").unwrap();
    let error = match SemanticStore::open_app_local(temp.path(), &db) {
        Ok(_) => panic!("corrupt store must not open"),
        Err(error) => error,
    };
    let diagnostic = error.to_string();
    assert!(!diagnostic.contains("CANARY_SENSITIVE_PAYLOAD"));
    assert!(temp.path().exists(), "other project roots remain untouched");
}

#[test]
fn fault_large_projection_rebuild_is_bounded_and_semantically_equal() {
    let (_temp, mut store) = open();
    for seq in 0..1000_u64 {
        store
            .append_semantic_event(StreamSeq(seq), &event(&format!("large_{seq}"), seq, None))
            .unwrap();
    }
    let expected = store.projection_snapshot().unwrap();
    let started = Instant::now();
    let rebuilt = store.rebuild_projection().unwrap();
    assert_eq!(rebuilt, expected);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(
        verify_semantic_store(&store).class,
        StoreHealthClass::Healthy
    );
}
