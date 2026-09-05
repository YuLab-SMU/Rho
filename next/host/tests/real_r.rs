use rho_next_contract::{CapabilityRef, Invocation, OperationStatus, QueryRequest, QueryStatus};
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

fn query(id: &str, arguments: serde_json::Value) -> QueryRequest {
    QueryRequest {
        capability: CapabilityRef::new(id, 1).unwrap(),
        arguments,
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
        library_path: None,
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
    let events_before_busy = host.outbox(&context, 0, 1000).await.unwrap();
    let busy = tokio::time::timeout(
        Duration::from_millis(250),
        host.query_snapshot(&context, query("workspace.snapshot", json!({}))),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(busy.status, QueryStatus::Busy);
    let project_busy = host
        .query_snapshot(&context, query("project.snapshot", json!({})))
        .await
        .unwrap();
    assert_eq!(
        project_busy.status,
        QueryStatus::Busy,
        "R and Project must share the same write lane"
    );
    assert!(busy.data.is_none());
    assert_eq!(
        host.outbox(&context, 0, 1000).await.unwrap(),
        events_before_busy
    );
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
    let write_file = host
        .invoke(
            &context,
            request("file", "writeLines('before', 'analysis.R')"),
        )
        .await
        .unwrap();
    assert_eq!(write_file.status, OperationStatus::Succeeded);
    let project_patch = Invocation {
        client_request_id: "project-patch".into(),
        capability: CapabilityRef::new("project.apply_patch", 1).unwrap(),
        arguments: json!({"patch":"diff --git a/analysis.R b/analysis.R\n--- a/analysis.R\n+++ b/analysis.R\n@@ -1 +1 @@\n-before\n+after\n"}),
        preconditions: Vec::new(),
    };
    let patched = host.invoke(&context, project_patch).await.unwrap();
    assert_eq!(patched.status, OperationStatus::Succeeded, "{patched:?}");
    let read_from_r = host
        .invoke(
            &context,
            request("r-sees-project-change", "readLines('analysis.R')"),
        )
        .await
        .unwrap();
    assert_eq!(
        read_from_r.output.as_ref().unwrap()["value"],
        json!("after")
    );
    let dead = host
        .invoke(&context, request("quit", "quit(save = 'no')"))
        .await
        .unwrap();
    assert_eq!(dead.status, OperationStatus::Uncertain, "{dead:?}");
    assert!(dead.recovery.is_some());
    let unavailable = host
        .query_snapshot(&context, query("workspace.snapshot", json!({})))
        .await
        .unwrap();
    assert_eq!(unavailable.status, QueryStatus::Unavailable);
    assert_eq!(
        host.invoke(&context, request("quit", "quit(save = 'no')"))
            .await
            .unwrap(),
        dead
    );
}

#[tokio::test]
#[ignore = "requires real Ark/R with rlang for non-forcing binding inspection"]
async fn real_workspace_queries_are_bounded_and_do_not_force_bindings_or_record_operations() {
    let directory = tempfile::tempdir().unwrap();
    let config = ArkConfig {
        executable: PathBuf::from(std::env::var_os("RHO_NEXT_ARK").expect("RHO_NEXT_ARK required")),
        r_home: PathBuf::from(
            std::env::var_os("RHO_NEXT_R_HOME").expect("RHO_NEXT_R_HOME required"),
        ),
        project_root: directory.path().into(),
        data_root: directory.path().join("runtime"),
        execution_timeout: Duration::from_secs(30),
        library_path: None,
    };
    let host = NextHost::open_ark(directory.path().join("next.sqlite"), config)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let created = host
        .invoke(
            &context,
            request(
                "bindings",
                r#"
        stopifnot(requireNamespace("rlang", quietly = TRUE))
        hits <- 0L
        delayedAssign("lazy_value", { hits <<- hits + 1L; 123 })
        makeActiveBinding("active_value", function() { hits <<- hits + 1L; 456 }, .GlobalEnv)
        length.trap <- function(x) { hits <<- hits + 1L; stop("length must not run") }
        print.trap <- function(x) { hits <<- hits + 1L; stop("print must not run") }
        object <- structure(list(x = 1), class = "trap")
        numbers <- 1:100
        table <- data.frame(a = 1:5, b = letters[1:5])
        text_table <- data.frame(text = paste(rep("a", 600), collapse = ""))
        invisible(NULL)
    "#,
            ),
        )
        .await
        .unwrap();
    assert_eq!(created.status, OperationStatus::Succeeded, "{created:?}");
    let history = host.outbox(&context, 0, 1000).await.unwrap();
    let snapshot = host
        .query_snapshot(&context, query("workspace.snapshot", json!({"limit":200})))
        .await
        .unwrap();
    assert_eq!(snapshot.status, QueryStatus::Ready, "{snapshot:?}");
    assert_eq!(snapshot.target, created.operation.target);
    assert_eq!(snapshot.source, "ark/rho.bridge");
    assert!(snapshot.observed_at_ms > 0);
    let objects = snapshot.data.as_ref().unwrap()["objects"]
        .as_array()
        .unwrap();
    assert!(objects.iter().any(|object| object["name"] == "numbers"));
    for (name, expected_kind) in [
        ("lazy_value", "promise"),
        ("active_value", "active_binding"),
        ("absent", "missing"),
    ] {
        let result = host
            .query_snapshot(
                &context,
                query("workspace.inspect_object", json!({"name":name})),
            )
            .await
            .unwrap();
        assert_eq!(result.status, QueryStatus::Ready, "{result:?}");
        assert_eq!(result.data.as_ref().unwrap()["kind"], json!(expected_kind));
        assert_eq!(result.data.as_ref().unwrap()["preview"], json!(null));
    }
    let object = host
        .query_snapshot(
            &context,
            query("workspace.inspect_object", json!({"name":"object"})),
        )
        .await
        .unwrap();
    assert_eq!(object.data.as_ref().unwrap()["classes"], json!(["trap"]));
    let numbers = host
        .query_snapshot(
            &context,
            query(
                "workspace.inspect_object",
                json!({"name":"numbers","max_items":3}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(numbers.data.as_ref().unwrap()["preview"], json!([1, 2, 3]));
    assert_eq!(numbers.data.as_ref().unwrap()["truncated"], json!(true));
    let table = host
        .query_snapshot(
            &context,
            query(
                "workspace.inspect_object",
                json!({"name":"table","max_items":2}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(table.data.as_ref().unwrap()["dimensions"], json!([5, 2]));
    assert_eq!(
        table.data.as_ref().unwrap()["preview"][0]["values"],
        json!([1, 2])
    );
    let clipped = host
        .query_snapshot(
            &context,
            query("workspace.inspect_object", json!({"name":"text_table"})),
        )
        .await
        .unwrap();
    assert_eq!(
        clipped.data.as_ref().unwrap()["preview"][0]["values"][0]
            .as_str()
            .unwrap()
            .len(),
        512
    );
    assert_eq!(clipped.data.as_ref().unwrap()["truncated"], json!(true));
    let bounded = host
        .query_snapshot(&context, query("workspace.snapshot", json!({"limit":2})))
        .await
        .unwrap();
    assert_eq!(
        bounded.data.as_ref().unwrap()["objects"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(bounded.data.as_ref().unwrap()["truncated"], json!(true));
    assert!(
        host.query_snapshot(&context, query("workspace.snapshot", json!({"limit":201})))
            .await
            .is_err()
    );
    assert!(
        host.query_snapshot(
            &context,
            query("workspace.snapshot", json!({"expected_session":"stale"}))
        )
        .await
        .is_err()
    );
    assert_eq!(host.outbox(&context, 0, 1000).await.unwrap(), history);
    let proof = host
        .invoke(&context, request("no-side-effects", "hits"))
        .await
        .unwrap();
    assert_eq!(proof.output.as_ref().unwrap()["value"], json!(0));
}
