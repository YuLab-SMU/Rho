use rho_protocol::*;
use rho_store::{AppendCrashPoint, SemanticAppendError, SemanticStore};

fn actor() -> Actor {
    Actor {
        kind: ActorKind::System,
        id: "system".to_string(),
    }
}

fn revision_event(event_id: &str, seq: u64, after: u64) -> SemanticEvent {
    let transition = RevisionTransition {
        before: RevisionStamp {
            workspace_id: WorkspaceId::new("workspace_crash").unwrap(),
            kernel_instance_id: KernelInstanceId::new("kernel_crash").unwrap(),
            state_revision: StateRevision(after.saturating_sub(1)),
            project_revision: ProjectRevision(4),
        },
        after: RevisionStamp {
            workspace_id: WorkspaceId::new("workspace_crash").unwrap(),
            kernel_instance_id: KernelInstanceId::new("kernel_crash").unwrap(),
            state_revision: StateRevision(after),
            project_revision: ProjectRevision(4),
        },
    };
    SemanticEvent::new(
        EventEnvelopeMetadata::new(
            EventId::new(event_id).unwrap(),
            StreamId::new("stream_crash").unwrap(),
            StreamSeq(seq),
            actor(),
            CorrelationId::new("correlation_crash").unwrap(),
            TraceId::new("trace_crash").unwrap(),
        )
        .with_revision_transition(&transition),
        SemanticEventPayload::RevisionAdvanced { transition },
    )
    .unwrap()
}

fn open_store() -> (tempfile::TempDir, SemanticStore) {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/rho-semantic.sqlite3");
    let (store, _outcome) = SemanticStore::open_app_local(temp.path(), &db).unwrap();
    (temp, store)
}

#[test]
fn crash_before_transaction_leaves_before_state() {
    let (_temp, mut store) = open_store();
    let event = revision_event("event_crash_1", 0, 1);
    assert!(matches!(
        store.append_semantic_event_with_crash(
            StreamSeq(0),
            &event,
            Some(AppendCrashPoint::BeforeTransaction),
        ),
        Err(SemanticAppendError::CrashInjected(
            AppendCrashPoint::BeforeTransaction
        ))
    ));
    assert!(store.projection_snapshot().unwrap().is_empty());
}

#[test]
fn crash_after_event_insert_rolls_back_event_and_projection_together() {
    let (_temp, mut store) = open_store();
    let event = revision_event("event_crash_1", 0, 1);
    assert!(matches!(
        store.append_semantic_event_with_crash(
            StreamSeq(0),
            &event,
            Some(AppendCrashPoint::AfterEventInsert),
        ),
        Err(SemanticAppendError::CrashInjected(
            AppendCrashPoint::AfterEventInsert
        ))
    ));
    let count: i64 = store
        .connection()
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert!(store.projection_snapshot().unwrap().is_empty());
}

#[test]
fn crash_after_projection_update_rolls_back_split_state() {
    let (_temp, mut store) = open_store();
    let event = revision_event("event_crash_1", 0, 1);
    assert!(matches!(
        store.append_semantic_event_with_crash(
            StreamSeq(0),
            &event,
            Some(AppendCrashPoint::AfterProjectionUpdate),
        ),
        Err(SemanticAppendError::CrashInjected(
            AppendCrashPoint::AfterProjectionUpdate
        ))
    ));
    let count: i64 = store
        .connection()
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert!(
        store
            .current_projection_value("workspace_revision")
            .unwrap()
            .is_none()
    );
}

#[test]
fn crash_after_commit_leaves_complete_after_state() {
    let (_temp, mut store) = open_store();
    let event = revision_event("event_crash_1", 0, 1);
    assert!(matches!(
        store.append_semantic_event_with_crash(
            StreamSeq(0),
            &event,
            Some(AppendCrashPoint::AfterCommit),
        ),
        Err(SemanticAppendError::CrashInjected(
            AppendCrashPoint::AfterCommit
        ))
    ));
    let projection = store
        .current_projection_value("workspace_revision")
        .unwrap()
        .unwrap();
    assert_eq!(projection["state_revision"], 1);
    let count: i64 = store
        .connection()
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn crash_stream_sequence_mismatch_rejects_without_projection_effect() {
    let (_temp, mut store) = open_store();
    let event = revision_event("event_crash_1", 1, 1);
    assert!(matches!(
        store.append_semantic_event_with_crash(StreamSeq(0), &event, None),
        Err(SemanticAppendError::EventSequenceMismatch { .. })
    ));
    assert!(store.projection_snapshot().unwrap().is_empty());
}
