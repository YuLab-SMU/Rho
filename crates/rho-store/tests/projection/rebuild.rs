use rho_protocol::*;
use rho_store::{AppendOutcome, ProjectionRebuildError, SemanticStore};

fn actor() -> Actor {
    Actor {
        kind: ActorKind::System,
        id: "system".to_string(),
    }
}

fn base_metadata(event_id: &str, seq: u64) -> EventEnvelopeMetadata {
    EventEnvelopeMetadata::new(
        EventId::new(event_id).unwrap(),
        StreamId::new("stream_projection").unwrap(),
        StreamSeq(seq),
        actor(),
        CorrelationId::new("correlation_projection").unwrap(),
        TraceId::new("trace_projection").unwrap(),
    )
}

fn transition(before: u64, after: u64) -> RevisionTransition {
    RevisionTransition {
        before: RevisionStamp {
            workspace_id: WorkspaceId::new("workspace_projection").unwrap(),
            kernel_instance_id: KernelInstanceId::new("kernel_projection").unwrap(),
            state_revision: StateRevision(before),
            project_revision: ProjectRevision(7),
        },
        after: RevisionStamp {
            workspace_id: WorkspaceId::new("workspace_projection").unwrap(),
            kernel_instance_id: KernelInstanceId::new("kernel_projection").unwrap(),
            state_revision: StateRevision(after),
            project_revision: ProjectRevision(7),
        },
    }
}

fn revision_event(event_id: &str, seq: u64, before: u64, after: u64) -> SemanticEvent {
    let transition = transition(before, after);
    SemanticEvent::new(
        base_metadata(event_id, seq).with_revision_transition(&transition),
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
fn projection_append_updates_query_path_without_replay() {
    let (_temp, mut store) = open_store();
    let event = revision_event("event_projection_1", 0, 0, 1);

    let outcome = store.append_semantic_event(StreamSeq(0), &event).unwrap();
    assert_eq!(
        outcome,
        AppendOutcome::Appended {
            event_id: "event_projection_1".to_string(),
            stream_seq: StreamSeq(0),
        }
    );
    let projection = store
        .current_projection_value("workspace_revision")
        .unwrap()
        .expect("projection exists without replay");
    assert_eq!(projection["state_revision"], 1);
}

#[test]
fn projection_rebuild_is_semantically_equal_to_incremental_projection() {
    let (_temp, mut store) = open_store();
    store
        .append_semantic_event(StreamSeq(0), &revision_event("event_projection_1", 0, 0, 1))
        .unwrap();
    store
        .append_semantic_event(StreamSeq(1), &revision_event("event_projection_2", 1, 1, 2))
        .unwrap();

    let before = store.projection_snapshot().unwrap();
    let rebuilt = store.rebuild_projection().unwrap();
    assert_eq!(before, rebuilt);
    assert_eq!(rebuilt["workspace_revision"]["state_revision"], 2);
}

#[test]
fn projection_duplicate_operation_does_not_repeat_projection_effect() {
    let (_temp, mut store) = open_store();
    let mut first = revision_event("event_projection_1", 0, 0, 1);
    first.metadata.operation_id = Some(OperationId::new("operation_projection_once").unwrap());
    let mut duplicate = revision_event("event_projection_2", 1, 1, 2);
    duplicate.metadata.operation_id = first.metadata.operation_id.clone();

    store.append_semantic_event(StreamSeq(0), &first).unwrap();
    let duplicate_outcome = store
        .append_semantic_event(StreamSeq(1), &duplicate)
        .unwrap();
    assert!(matches!(
        duplicate_outcome,
        AppendOutcome::DuplicateOperation { existing_event_id, .. } if existing_event_id == "event_projection_1"
    ));
    let projection = store
        .current_projection_value("workspace_revision")
        .unwrap()
        .unwrap();
    assert_eq!(projection["state_revision"], 1);
}

#[test]
fn projection_rebuild_reports_unknown_payload_version_with_stream_and_event() {
    let (_temp, mut store) = open_store();
    store
        .append_semantic_event(StreamSeq(0), &revision_event("event_projection_1", 0, 0, 1))
        .unwrap();
    store.connection().execute(
        "UPDATE events SET event_json = json_set(event_json, '$.schema_version', 999) WHERE event_id = 'event_projection_1'",
        [],
    ).unwrap();

    assert!(matches!(
        store.rebuild_projection(),
        Err(ProjectionRebuildError::Event { event_id, stream_id, .. })
            if event_id == "event_projection_1" && stream_id == "stream_projection"
    ));
}
