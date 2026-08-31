use rho_protocol::*;
use rho_store::{SemanticStore, TerminalRevisionOutcome, checkpoint_restore_strategy_key};

fn actor() -> Actor {
    Actor {
        kind: ActorKind::Executor,
        id: "executor".to_string(),
    }
}

fn metadata(event_id: &str, seq: u64) -> EventEnvelopeMetadata {
    EventEnvelopeMetadata::new(
        EventId::new(event_id).unwrap(),
        StreamId::new("stream_revision").unwrap(),
        StreamSeq(seq),
        actor(),
        CorrelationId::new("correlation_revision").unwrap(),
        TraceId::new("trace_revision").unwrap(),
    )
}

fn stamp(state: u64) -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_revision").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_revision").unwrap(),
        state_revision: StateRevision(state),
        project_revision: ProjectRevision(5),
    }
}

fn terminal_event(event_id: &str, seq: u64, execution_id: &ExecutionId) -> SemanticEvent {
    let mut metadata = metadata(event_id, seq);
    metadata.execution_id = Some(execution_id.clone());
    SemanticEvent::new(
        metadata,
        SemanticEventPayload::ExecutionStateChanged {
            execution_id: execution_id.clone(),
            state: "failed".to_string(),
        },
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
fn revision_failed_arbitrary_r_evaluation_advances_once_and_duplicate_terminal_does_not() {
    let (_temp, mut store) = open_store();
    let execution_id = ExecutionId::new("execution_failed_r").unwrap();
    let event = terminal_event("event_terminal_failed", 0, &execution_id);
    store.append_semantic_event(StreamSeq(0), &event).unwrap();

    let outcome = store
        .record_terminal_execution_revision(
            "event_terminal_failed",
            &execution_id,
            stamp(7),
            ExecutionTerminalOutcome::Failed,
            true,
        )
        .unwrap();
    assert!(matches!(
        outcome,
        TerminalRevisionOutcome::Advanced(RevisionTransition { after, .. })
            if after.state_revision == StateRevision(8)
    ));

    let duplicate = store
        .record_terminal_execution_revision(
            "event_terminal_failed",
            &execution_id,
            stamp(8),
            ExecutionTerminalOutcome::Failed,
            true,
        )
        .unwrap();
    assert_eq!(
        duplicate,
        TerminalRevisionOutcome::Duplicate {
            state_revision_after: StateRevision(8),
        }
    );
    let projection = store
        .current_projection_value("workspace_revision")
        .unwrap()
        .unwrap();
    assert_eq!(projection["state_revision"], 8);
}

#[test]
fn revision_uncertain_execution_advances_even_without_success_claim() {
    let (_temp, mut store) = open_store();
    let execution_id = ExecutionId::new("execution_uncertain_r").unwrap();
    let event = terminal_event("event_terminal_uncertain", 0, &execution_id);
    store.append_semantic_event(StreamSeq(0), &event).unwrap();

    let outcome = store
        .record_terminal_execution_revision(
            "event_terminal_uncertain",
            &execution_id,
            stamp(3),
            ExecutionTerminalOutcome::Uncertain,
            false,
        )
        .unwrap();
    assert!(matches!(
        outcome,
        TerminalRevisionOutcome::Advanced(RevisionTransition { after, .. })
            if after.state_revision == StateRevision(4)
    ));
}

#[test]
fn revision_checkpoint_restore_strategies_are_explicit() {
    assert_eq!(
        checkpoint_restore_strategy_key(CheckpointRestoreStrategy::Exact),
        "exact"
    );
    assert_eq!(
        checkpoint_restore_strategy_key(CheckpointRestoreStrategy::Partial),
        "partial"
    );
    assert_eq!(
        checkpoint_restore_strategy_key(CheckpointRestoreStrategy::RestartRequired),
        "restart_required",
    );
    assert_eq!(
        checkpoint_restore_strategy_key(CheckpointRestoreStrategy::NonReversible),
        "non_reversible",
    );
}

#[test]
fn revision_checkpoint_records_scope_source_revision_environment_and_code_refs() {
    let (_temp, mut store) = open_store();
    let execution_id = ExecutionId::new("execution_checkpoint").unwrap();
    let event = terminal_event("event_checkpoint_source", 0, &execution_id);
    store.append_semantic_event(StreamSeq(0), &event).unwrap();
    let checkpoint = CheckpointDescriptor {
        checkpoint_id: "checkpoint_state_1".to_string(),
        scope: "workspace_state".to_string(),
        source_revision: stamp(12),
        environment_ref: "env:renv.lock@sha256:abc".to_string(),
        code_ref: "code:analysis.R@sha256:def".to_string(),
        restore_strategy: CheckpointRestoreStrategy::Partial,
    };

    store
        .record_checkpoint_descriptor(&checkpoint, "event_checkpoint_source")
        .unwrap();
    let recorded: (String, i64, i64, String, String, String) = store.connection().query_row(
        "SELECT scope, source_state_revision, source_project_revision, restore_strategy, environment_ref, code_ref FROM checkpoints WHERE checkpoint_id = 'checkpoint_state_1'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).unwrap();
    assert_eq!(recorded.0, "workspace_state");
    assert_eq!(recorded.1, 12);
    assert_eq!(recorded.2, 5);
    assert_eq!(recorded.3, "partial");
    assert!(recorded.4.starts_with("env:"));
    assert!(recorded.5.starts_with("code:"));
}
