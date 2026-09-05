use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use rho_next_contract::{CapabilityRef, Invocation, Operation, OperationStatus, Precondition};
use rho_next_host::{DeterministicWorkspaceRuntime, NextHost};
use rho_next_operation::{OperationError, SystemClock, UuidOperationIdGenerator};
use rho_next_sqlite::SqliteOperationJournal;
use rho_next_workspace::{
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
    use rho_next_contract::{QueryRequest, QueryStatus};
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
            outcome: rho_next_contract::OperationOutcome::Succeeded,
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
    let record = writer
        .invoke(&context, invocation("persisted"))
        .await
        .unwrap();
    assert_eq!(
        reader
            .get_operation(&context, &record.operation.operation_id)
            .await
            .unwrap(),
        Some(record)
    );
}
