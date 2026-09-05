use rho_next_contract::{CapabilityRef, Invocation, OperationStatus};
use rho_next_host::{ArkConfig, NextHost};
use serde_json::json;
use std::{path::PathBuf, sync::Arc, time::Duration};

fn request(id: &str, code: &str) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        arguments: json!({"code":code}),
        preconditions: Vec::new(),
    }
}

#[tokio::test]
#[ignore = "requires RHO_NEXT_ARK and RHO_NEXT_R_HOME pointing to a real local R installation"]
async fn real_r_preserves_session_reports_errors_and_observes_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let config = ArkConfig {
        executable: PathBuf::from(std::env::var_os("RHO_NEXT_ARK").expect("RHO_NEXT_ARK required")),
        r_home: PathBuf::from(
            std::env::var_os("RHO_NEXT_R_HOME").expect("RHO_NEXT_R_HOME required"),
        ),
        project_root: directory.path().to_path_buf(),
        data_root: directory.path().join("runtime"),
        execution_timeout: Duration::from_secs(30),
    };
    let host = Arc::new(
        NextHost::open_ark(directory.path().join("next.sqlite"), config)
            .await
            .unwrap(),
    );
    let context = NextHost::local_context();
    let first = host
        .invoke(
            &context,
            request(
                "create",
                "x <- 41; cat('hello from R\n'); warning('an observed warning'); x",
            ),
        )
        .await
        .unwrap();
    assert_eq!(first.status, OperationStatus::Succeeded, "{first:?}");
    assert_eq!(first.output.as_ref().unwrap()["value"], json!(41));
    assert!(
        first.output.as_ref().unwrap()["stdout"]
            .as_str()
            .unwrap()
            .contains("hello from R")
    );
    assert_eq!(
        first.output.as_ref().unwrap()["conditions"][0]["kind"],
        json!("warning")
    );
    let second = host
        .invoke(&context, request("use", "x + 1"))
        .await
        .unwrap();
    assert_eq!(second.output.as_ref().unwrap()["value"], json!(42));
    assert_eq!(first.operation.target, second.operation.target);
    let repeated = host
        .invoke(&context, request("use", "x + 1"))
        .await
        .unwrap();
    assert_eq!(repeated, second);
    let failed = host
        .invoke(
            &context,
            request("partial-error", "x <- 99; stop('actual R error')"),
        )
        .await
        .unwrap();
    assert_eq!(failed.status, OperationStatus::Failed, "{failed:?}");
    assert!(failed.error.as_ref().unwrap().contains("actual R error"));
    let retained = host
        .invoke(&context, request("retained", "x"))
        .await
        .unwrap();
    assert_eq!(
        retained.output.as_ref().unwrap()["value"],
        json!(99),
        "R error does not roll back side effects"
    );

    let ready = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = ready.local_addr().unwrap().port();
    let long_code = format!(
        "con <- socketConnection('127.0.0.1', port={port}, open='w'); writeLines('started', con); close(con); Sys.sleep(20); 777"
    );
    let running_host = host.clone();
    let task_code = long_code.clone();
    let task = tokio::spawn(async move {
        running_host
            .invoke(&NextHost::local_context(), request("long", &task_code))
            .await
    });
    // Wait for a signal from the actual R process, not a timer or a status guess.
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), ready.accept())
        .await
        .unwrap()
        .unwrap();
    let mut signal = [0; 7];
    tokio::io::AsyncReadExt::read_exact(&mut socket, &mut signal)
        .await
        .unwrap();
    assert_eq!(&signal, b"started");
    let live = host
        .invoke(&context, request("long", &long_code))
        .await
        .unwrap();
    assert_eq!(live.status, OperationStatus::Running);
    let cancellation = host
        .request_cancellation(&context, &live.operation.operation_id)
        .await
        .unwrap();
    assert!(cancellation.accepted);
    let cancelled = tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        cancelled.status,
        OperationStatus::Cancelled,
        "{cancelled:?}"
    );
    let after = host
        .invoke(&context, request("after-cancel", "x + 1"))
        .await
        .unwrap();
    assert_eq!(after.output.as_ref().unwrap()["value"], json!(100));
    let dead = host
        .invoke(&context, request("quit", "quit(save = 'no')"))
        .await
        .unwrap();
    assert_eq!(dead.status, OperationStatus::Uncertain, "{dead:?}");
    assert!(dead.recovery.is_some());
    assert_eq!(
        host.invoke(&context, request("quit", "quit(save = 'no')"))
            .await
            .unwrap(),
        dead
    );
}
