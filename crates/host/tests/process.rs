#![cfg(unix)]

use rho_contract::{
    CapabilityRef, Invocation, OperationId, OperationStatus, QueryRequest, QueryStatus,
};
use rho_host::NextHost;
use serde_json::json;
use std::{
    io::{Read, Write},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    net::TcpListener,
};

#[tokio::test]
async fn real_process_shares_project_lane_and_cancellation_commits_owner_outcome() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let host = Arc::new(
        NextHost::open_project(directory.path().join("state.sqlite"), &project)
            .await
            .unwrap(),
    );
    let context = NextHost::local_context();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let request = Invocation {
        client_request_id: "cancel-process".into(),
        capability: CapabilityRef::new("process.run_local", 1).unwrap(),
        arguments: json!({"program":std::env::current_exe().unwrap(),"args":["--exact","child_fixture","--nocapture","--skip",format!("rho-child@{}", listener.local_addr().unwrap())]}),
        preconditions: vec![],
    };
    let mut denied = context.clone();
    denied.scopes.remove("process.run_local");
    assert!(host.invoke(&denied, request.clone()).await.is_err());
    assert!(host.outbox(&context, 0, 100).await.unwrap().is_empty());
    let owned = host.clone();
    let input = request.clone();
    let task = tokio::spawn(async move {
        owned
            .invoke(&NextHost::local_context(), input)
            .await
            .unwrap()
    });
    let (socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut socket = BufReader::new(socket);
    let mut id = String::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut id))
        .await
        .unwrap()
        .unwrap();
    let id = OperationId::new(id.trim()).unwrap();
    assert_eq!(
        host.get_operation(&context, &id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Running
    );
    let snapshot = host
        .query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("project.snapshot", 1).unwrap(),
                arguments: json!({}),
            },
        )
        .await
        .unwrap();
    assert_eq!(snapshot.status, QueryStatus::Busy);
    let cleanup = Invocation {
        client_request_id: "cannot-reconcile-live".into(),
        capability: CapabilityRef::new("process.reconcile", 1).unwrap(),
        arguments: json!({"operation_id":id}),
        preconditions: vec![],
    };
    let denied_cleanup =
        tokio::time::timeout(Duration::from_secs(2), host.invoke(&context, cleanup))
            .await
            .expect("reconciliation waited behind a live source")
            .unwrap();
    assert_eq!(denied_cleanup.status, OperationStatus::Failed);
    assert!(denied_cleanup.error.unwrap().contains("terminal"));
    assert_eq!(
        host.get_operation(&context, &id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Running
    );
    assert!(
        host.request_cancellation(&context, &id)
            .await
            .unwrap()
            .accepted
    );
    let result = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status, OperationStatus::Cancelled, "{result:?}");
    assert_eq!(result.output.as_ref().unwrap()["termination"], "cancelled");
    assert_eq!(result.operation.operation_id, id);
    assert_eq!(
        host.get_operation(&context, &id).await.unwrap().unwrap(),
        result
    );
    assert_eq!(host.invoke(&context, request).await.unwrap(), result);
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut rest))
        .await
        .unwrap()
        .unwrap();
    assert!(rest.is_empty());
}

#[test]
fn child_fixture() {
    let Some(address) =
        std::env::args().find_map(|arg| arg.strip_prefix("rho-child@").map(str::to_owned))
    else {
        return;
    };
    let mut socket = std::net::TcpStream::connect(address).unwrap();
    writeln!(socket, "{}", std::env::var("RHO_OPERATION_ID").unwrap()).unwrap();
    let _ = socket.read(&mut [0]);
    std::process::exit(0);
}
