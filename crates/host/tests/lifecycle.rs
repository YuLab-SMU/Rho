use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use rho_contract::{CapabilityRef, Invocation, Operation, OperationStatus, Precondition};
use rho_host::{DeterministicWorkspaceRuntime, NextHost};
use rho_operation::{OperationError, SystemClock, UuidOperationIdGenerator};
use rho_sqlite::SqliteOperationJournal;
use rho_workspace::{
    RunRArguments, WorkspaceRuntime, WorkspaceRuntimeError, WorkspaceRuntimeReport,
};
use serde_json::json;
use tokio::sync::Notify;

fn invocation(id: &str) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        arguments: json!({"code": "x <- 1"}),
        preconditions: Vec::new(),
    }
}

async fn host(runtime: Arc<dyn WorkspaceRuntime>) -> NextHost {
    NextHost::with_components(
        Arc::new(SqliteOperationJournal::open_in_memory().unwrap()),
        runtime,
        Arc::new(SystemClock),
        Arc::new(UuidOperationIdGenerator),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn invocation_retry_and_all_persisted_references_share_one_operation() {
    let runtime = Arc::new(DeterministicWorkspaceRuntime::default());
    let host = host(runtime.clone()).await;
    let context = NextHost::local_context();
    let first = host.invoke(&context, invocation("same")).await.unwrap();
    let repeated = host.invoke(&context, invocation("same")).await.unwrap();
    assert_eq!(first, repeated);
    assert_eq!(runtime.execution_count(), 1);
    assert_eq!(first.status, OperationStatus::Succeeded);
    let id = &first.operation.operation_id;
    let events = host.events(&context, id).await.unwrap();
    assert!(events.iter().all(|event| &event.operation_id == id));
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "operation.terminal")
            .count(),
        1
    );
    let outbox = host.outbox(&context, 0, 100).await.unwrap();
    assert_eq!(events.len(), outbox.len());
    assert!(outbox.iter().all(|message| &message.operation_id == id));
    let facts = host.facts_for_operation(&context, id).await.unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(&facts[0].source_operation_id, id);
    assert_eq!(facts[0].value["operation_id"], json!(id));
    // Full output has exactly one authority location.
    assert!(facts[0].value.get("result").is_none());

    let mut conflicting = invocation("same");
    conflicting.arguments = json!({"code": "x <- 2"});
    assert_eq!(
        host.invoke(&context, conflicting).await.unwrap_err(),
        OperationError::IdempotencyConflict
    );
    assert_eq!(runtime.execution_count(), 1);
}

#[tokio::test]
async fn actors_share_owner_truth_without_crossing_principals_or_idempotency() {
    use rho_contract::{CallerIdentity, CallerKind};
    let runtime = Arc::new(DeterministicWorkspaceRuntime::default());
    let host = host(runtime.clone()).await;
    let human = NextHost::local_context();
    let human_record = host.invoke(&human, invocation("human-once")).await.unwrap();
    let mut explicit_human = human.clone();
    explicit_human.principal = Some(human.caller.clone());
    assert_eq!(
        host.invoke(&explicit_human, invocation("human-once"))
            .await
            .unwrap(),
        human_record
    );
    let mut agent = human.clone();
    agent.principal = Some(human.caller.clone());
    agent.caller = CallerIdentity {
        kind: CallerKind::Agent,
        id: "test-mcp".into(),
    };
    let record = host.invoke(&agent, invocation("agent-once")).await.unwrap();
    assert_eq!(record.operation.caller, agent.caller);
    assert_eq!(record.operation.principal(), human.principal());
    let id = &record.operation.operation_id;
    assert_eq!(
        host.get_operation(&human, id).await.unwrap().unwrap(),
        record
    );
    assert_eq!(
        host.outbox(&human, 0, 100).await.unwrap(),
        host.outbox(&agent, 0, 100).await.unwrap()
    );
    let mut read_only = human.clone();
    read_only.scopes.clear();
    assert!(matches!(
        host.request_cancellation(&read_only, id).await,
        Err(OperationError::AccessDenied { .. })
    ));
    let mut outsider = agent.clone();
    outsider.principal = Some(CallerIdentity {
        kind: CallerKind::Human,
        id: "other-account".into(),
    });
    assert!(host.get_operation(&outsider, id).await.unwrap().is_none());
    assert!(host.outbox(&outsider, 0, 100).await.unwrap().is_empty());
    assert_eq!(
        host.invoke(&outsider, invocation("agent-once"))
            .await
            .unwrap_err(),
        OperationError::IdempotencyConflict
    );
    assert_eq!(runtime.execution_count(), 2);
}

#[tokio::test]
async fn bad_input_scope_and_stale_session_do_not_execute() {
    let runtime = Arc::new(DeterministicWorkspaceRuntime::default());
    let host = host(runtime.clone()).await;
    let mut context = NextHost::local_context();
    context.scopes.clear();
    assert!(matches!(
        host.invoke(&context, invocation("scope")).await,
        Err(OperationError::AccessDenied { .. })
    ));
    context = NextHost::local_context();
    let mut request = invocation("input");
    request.arguments = json!({"code": "x", "undeclared": 1});
    assert!(host.invoke(&context, request).await.is_err());
    assert!(host.outbox(&context, 0, 100).await.unwrap().is_empty());
    let mut stale = invocation("stale");
    stale.preconditions.push(Precondition {
        kind: "workspace.session".into(),
        subject: "active".into(),
        expected: json!("old-session"),
    });
    let failed = host.invoke(&context, stale).await.unwrap();
    assert_eq!(failed.status, OperationStatus::Failed);
    assert_eq!(runtime.execution_count(), 0);
}

#[tokio::test]
async fn query_scopes_and_input_validation_share_the_registry_without_operation_admission() {
    use rho_contract::{QueryRequest, QueryStatus};
    let host = host(Arc::new(DeterministicWorkspaceRuntime::default())).await;
    let mut context = NextHost::local_context();
    let query = QueryRequest {
        capability: CapabilityRef::new("workspace.snapshot", 1).unwrap(),
        arguments: json!({}),
    };
    context.scopes.remove("workspace.read");
    assert!(matches!(
        host.query_snapshot(&context, query.clone()).await,
        Err(OperationError::AccessDenied { .. })
    ));
    context = NextHost::local_context();
    let reply = host.query_snapshot(&context, query.clone()).await.unwrap();
    assert_eq!(
        reply.status,
        QueryStatus::Unavailable,
        "a fake runtime must not manufacture live R observations"
    );
    let mut invalid = query;
    invalid.arguments = json!({"limit":0});
    assert!(host.query_snapshot(&context, invalid).await.is_err());
    assert!(host.outbox(&context, 0, 100).await.unwrap().is_empty());
}

#[tokio::test]
async fn read_paths_and_cancellation_cannot_cross_caller_identity() {
    let host = host(Arc::new(DeterministicWorkspaceRuntime::default())).await;
    let context = NextHost::local_context();
    let own = host.invoke(&context, invocation("own")).await.unwrap();
    let mut other = context.clone();
    other.caller.id = "another-user".into();
    let id = &own.operation.operation_id;
    assert!(host.get_operation(&other, id).await.unwrap().is_none());
    assert!(host.events(&other, id).await.is_err());
    assert!(host.facts_for_operation(&other, id).await.is_err());
    assert!(host.request_cancellation(&other, id).await.is_err());
    assert!(host.outbox(&other, 0, 100).await.unwrap().is_empty());
}

struct WaitingRuntime {
    started: Notify,
    release: Notify,
    calls: AtomicUsize,
}

#[async_trait]
impl WorkspaceRuntime for WaitingRuntime {
    fn session_id(&self) -> &str {
        "waiting-session"
    }
    async fn execute(
        &self,
        _: &Operation,
        _: &RunRArguments,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        self.release.notified().await;
        Ok(WorkspaceRuntimeReport {
            session_id: self.session_id().into(),
            value: json!(42),
            stdout: String::new(),
            stderr: String::new(),
            conditions: Vec::new(),
            output_references: Vec::new(),
            effect_observations: Vec::new(),
            outcome: rho_contract::OperationOutcome::Succeeded,
            error: None,
        })
    }
}

#[tokio::test]
async fn concurrent_retry_never_double_executes_and_cancel_is_only_a_request() {
    let runtime = Arc::new(WaitingRuntime {
        started: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let host = Arc::new(host(runtime.clone()).await);
    let task_host = host.clone();
    let task = tokio::spawn(async move {
        task_host
            .invoke(&NextHost::local_context(), invocation("in-flight"))
            .await
    });
    runtime.started.notified().await;
    let context = NextHost::local_context();
    let retry = host
        .invoke(&context, invocation("in-flight"))
        .await
        .unwrap();
    assert_eq!(retry.status, OperationStatus::Running);
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 1);
    let cancellation = host
        .request_cancellation(&context, &retry.operation.operation_id)
        .await
        .unwrap();
    assert!(cancellation.accepted);
    assert_eq!(cancellation.operation.status, OperationStatus::Running);
    runtime.release.notify_one();
    let finished = task.await.unwrap().unwrap();
    // This runtime completes before acknowledging cancellation; truth remains success.
    assert_eq!(finished.status, OperationStatus::Succeeded);
    assert!(finished.cancellation_requested);
}

struct LostReportRuntime;

#[tokio::test]
async fn dropping_response_waiter_keeps_host_execution_and_commit_alive() {
    let runtime = Arc::new(WaitingRuntime {
        started: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let host = Arc::new(host(runtime.clone()).await);
    let first_host = host.clone();
    let waiter = tokio::spawn(async move {
        first_host
            .invoke(&NextHost::local_context(), invocation("detached"))
            .await
    });
    runtime.started.notified().await;
    let context = NextHost::local_context();
    let live = host.invoke(&context, invocation("detached")).await.unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    assert_eq!(
        host.invoke(&context, invocation("detached"))
            .await
            .unwrap()
            .status,
        OperationStatus::Running
    );
    runtime.release.notify_one();

    // The second execution can enter the same workspace lane only after the first
    // handler returns; on this current-thread runtime the synchronous commit follows.
    let second_host = host.clone();
    let second = tokio::spawn(async move {
        second_host
            .invoke(&NextHost::local_context(), invocation("following"))
            .await
    });
    runtime.started.notified().await;
    let saved = host
        .get_operation(&context, &live.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.status, OperationStatus::Succeeded);
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 2);
    runtime.release.notify_one();
    assert_eq!(
        second.await.unwrap().unwrap().status,
        OperationStatus::Succeeded
    );
}

#[async_trait]
impl WorkspaceRuntime for LostReportRuntime {
    fn session_id(&self) -> &str {
        "lost-report-session"
    }
    async fn execute(
        &self,
        _: &Operation,
        _: &RunRArguments,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        Err(WorkspaceRuntimeError::after_possible_effect(
            "result transport lost",
            None,
        ))
    }
}

#[tokio::test]
async fn lost_runtime_report_is_durably_uncertain_and_never_reexecuted_on_retry() {
    let host = host(Arc::new(LostReportRuntime)).await;
    let context = NextHost::local_context();
    let uncertain = host.invoke(&context, invocation("lost")).await.unwrap();
    assert_eq!(uncertain.status, OperationStatus::Uncertain);
    assert!(uncertain.recovery.is_some());
    assert_eq!(
        host.invoke(&context, invocation("lost")).await.unwrap(),
        uncertain
    );
}

#[tokio::test]
async fn second_host_cannot_recover_live_writer_and_reader_does_not_mutate() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("next.sqlite");
    let writer = NextHost::open_demo(&path).await.unwrap();
    assert!(matches!(
        NextHost::open_demo(&path).await,
        Err(OperationError::HostBusy)
    ));
    let reader = NextHost::open_read_only(&path).unwrap();
    assert!(reader.recovered_on_open().is_empty());
    let context = NextHost::local_context();
    let mut record = writer
        .invoke(&context, invocation("persisted"))
        .await
        .unwrap();
    let mut observed = reader
        .get_operation(&context, &record.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    let reads = observed.next_reads.take().unwrap();
    assert_eq!(reads.len(), 1);
    assert_eq!(reads[0].capability.id, "operation.get");
    assert_eq!(
        reads[0].arguments["operation_id"],
        record.operation.operation_id.as_str()
    );
    assert!(
        record
            .next_reads
            .take()
            .unwrap()
            .iter()
            .any(|read| read.capability.id == "workspace.output_events")
    );
    assert_eq!(observed, record);
}

async fn console_state(host: &NextHost) -> rho_contract::ConsoleState {
    let result = host
        .query_snapshot(
            &NextHost::local_context(),
            rho_contract::QueryRequest {
                capability: CapabilityRef::new("workspace.console_state", 1).unwrap(),
                arguments: json!({}),
            },
        )
        .await
        .unwrap();
    serde_json::from_value(result.data.unwrap()).unwrap()
}
#[tokio::test]
async fn accepted_queue_is_fifo_and_pending_cancellation_never_executes() {
    let runtime = Arc::new(WaitingRuntime {
        started: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let host = host(runtime.clone()).await;
    let context = NextHost::local_context();
    let first = host
        .invoke_accepted(&context, invocation("queue-first"))
        .await
        .unwrap();
    runtime.started.notified().await;
    let second = host
        .invoke_accepted(&context, invocation("queue-second"))
        .await
        .unwrap();
    let third = host
        .invoke_accepted(&context, invocation("queue-third"))
        .await
        .unwrap();
    assert_eq!(second.status, OperationStatus::Accepted);
    assert_eq!(
        host.get_operation(&context, &second.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Accepted
    );
    let state = console_state(&host).await;
    assert_eq!(
        state
            .pending
            .iter()
            .map(|r| r.operation_id.clone())
            .collect::<Vec<_>>(),
        vec![
            second.operation.operation_id.clone(),
            third.operation.operation_id.clone()
        ]
    );
    let retry = host
        .invoke_accepted(&context, invocation("queue-second"))
        .await
        .unwrap();
    assert_eq!(retry.operation.operation_id, second.operation.operation_id);
    assert!(
        host.dispatch(
            &context,
            rho_contract::HostRequest::RequestCancellation {
                operation_id: first.operation.operation_id.clone(),
                only_if_pending: Some(true)
            }
        )
        .await
        .is_err()
    );
    host.dispatch(
        &context,
        rho_contract::HostRequest::RequestCancellation {
            operation_id: second.operation.operation_id.clone(),
            only_if_pending: Some(true),
        },
    )
    .await
    .unwrap();
    runtime.release.notify_one();
    // Shutdown cancels remaining pending work even if a failure paused the queue.
    tokio::time::timeout(std::time::Duration::from_secs(2), host.drain())
        .await
        .unwrap();
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        host.get_operation(&context, &second.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Cancelled
    );
}
#[tokio::test]
async fn queue_pause_is_bound_to_its_observed_identity_and_queries_hide_other_principals() {
    let runtime = Arc::new(WaitingRuntime {
        started: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let host = host(runtime.clone()).await;
    let context = NextHost::local_context();
    let mut pause = invocation("pause");
    pause.capability = CapabilityRef::new("workspace.pause_queue", 1).unwrap();
    pause.arguments = json!({"session_id":"waiting-session","pause_id":null});
    host.invoke(&context, pause).await.unwrap();
    let queued = host
        .invoke_accepted(&context, invocation("paused-run"))
        .await
        .unwrap();
    let state = console_state(&host).await;
    assert_eq!(state.pending.len(), 1);
    assert!(state.current.is_none());
    let mut outsider = context.clone();
    outsider.caller.id = "other".into();
    let observed = host
        .query_snapshot(
            &outsider,
            rho_contract::QueryRequest {
                capability: CapabilityRef::new("workspace.console_state", 1).unwrap(),
                arguments: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(observed.data.unwrap()["pending"], json!([]));
    let mut resume = invocation("stale-resume");
    resume.capability = CapabilityRef::new("workspace.resume_queue", 1).unwrap();
    resume.arguments = json!({"session_id":"waiting-session","pause_id":"stale"});
    assert_eq!(
        host.invoke(&context, resume.clone()).await.unwrap().status,
        OperationStatus::Failed
    );
    resume.client_request_id = "valid-resume".into();
    resume.arguments["pause_id"] = json!(state.pause.unwrap().id);
    assert_eq!(
        host.invoke(&context, resume).await.unwrap().status,
        OperationStatus::Succeeded
    );
    runtime.started.notified().await;
    runtime.release.notify_one();
    host.drain().await;
    assert_eq!(
        host.get_operation(&context, &queued.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Succeeded
    );
}

#[tokio::test]
async fn failed_final_commit_pauses_pending_runs_without_releasing_them_to_r() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("commit.sqlite");
    let runtime = Arc::new(WaitingRuntime {
        started: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let host = NextHost::with_components(
        Arc::new(SqliteOperationJournal::open(&database).unwrap()),
        runtime.clone(),
        Arc::new(SystemClock),
        Arc::new(UuidOperationIdGenerator),
    )
    .await
    .unwrap();
    let context = NextHost::local_context();
    let first = host
        .invoke_accepted(&context, invocation("commit-fails"))
        .await
        .unwrap();
    runtime.started.notified().await;
    let second = host
        .invoke_accepted(&context, invocation("commit-pending"))
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_result BEFORE UPDATE OF status ON operations WHEN NEW.client_request_id = 'commit-fails' AND NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'fixture final commit failed'); END;").unwrap();
    runtime.release.notify_one();
    let paused = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let state = console_state(&host).await;
            if state.pause.is_some() {
                break state;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(paused.pause.unwrap().reason.contains("commit"));
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        host.get_operation(&context, &first.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Running
    );
    assert_eq!(
        host.get_operation(&context, &second.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Accepted
    );
    host.drain().await;
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn normal_shutdown_drains_unpaused_accepted_r_work_in_order() {
    let runtime = Arc::new(WaitingRuntime {
        started: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let host = Arc::new(host(runtime.clone()).await);
    let context = NextHost::local_context();
    host.invoke_accepted(&context, invocation("drain-first"))
        .await
        .unwrap();
    runtime.started.notified().await;
    let second = host
        .invoke_accepted(&context, invocation("drain-second"))
        .await
        .unwrap();
    let draining = host.clone();
    let task = tokio::spawn(async move {
        draining.drain().await;
    });
    runtime.release.notify_one();
    runtime.started.notified().await;
    runtime.release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        host.get_operation(&context, &second.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Succeeded
    );
}
