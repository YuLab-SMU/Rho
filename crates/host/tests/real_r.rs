use rho_contract::{CapabilityRef, Invocation, OperationStatus, QueryRequest, QueryStatus};
use rho_host::{ArkConfig, NextHost};
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
#[ignore = "requires real Ark/R with lintr and styler; run scripts/test-real-r.mjs"]
async fn real_r_tools_use_native_libraries_and_the_shared_operation_path() {
    let directory = tempfile::tempdir().unwrap();
    let host = NextHost::open_ark(
        directory.path().join("tools.sqlite"),
        ArkConfig {
            executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK required")),
            r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME required")),
            project_root: directory.path().into(),
            data_root: directory.path().join("runtime"),
            execution_timeout: Duration::from_secs(30),
            library_path: None,
        },
    )
    .await
    .unwrap();
    let context = NextHost::local_context();
    let tool = |id: &str, capability: &str, arguments| Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments,
        preconditions: Vec::new(),
    };
    let help_request = tool("help", "workspace.help", json!({"topic":"mean"}));
    let mut denied = context.clone();
    denied.scopes.clear();
    assert!(host.invoke(&denied, help_request.clone()).await.is_err());
    let help = host.invoke(&context, help_request.clone()).await.unwrap();
    assert_eq!(help.status, OperationStatus::Succeeded, "{help:?}");
    assert_eq!(help.output.as_ref().unwrap()["value"]["found"], true);
    assert!(
        help.output.as_ref().unwrap()["value"]["text"]
            .as_str()
            .unwrap()
            .contains("Arithmetic Mean")
    );
    assert_eq!(host.invoke(&context, help_request).await.unwrap(), help);
    assert_eq!(
        host.get_operation(&context, &help.operation.operation_id)
            .await
            .unwrap()
            .unwrap(),
        help
    );
    let lint = host
        .invoke(
            &context,
            tool(
                "lint",
                "workspace.lint",
                json!({"code":"tool_value=1", "limit":1}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(lint.status, OperationStatus::Succeeded, "{lint:?}");
    assert_eq!(
        lint.output.as_ref().unwrap()["value"]["diagnostics"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(lint.output.as_ref().unwrap()["value"]["truncated"], true);
    let formatted = host
        .invoke(
            &context,
            tool("format", "workspace.format", json!({"code":"tool_value=1"})),
        )
        .await
        .unwrap();
    assert_eq!(
        formatted.status,
        OperationStatus::Succeeded,
        "{formatted:?}"
    );
    assert_eq!(
        formatted.output.as_ref().unwrap()["value"]["code"],
        "tool_value <- 1"
    );
    assert_eq!(formatted.operation.target, help.operation.target);
    let absent = host
        .query_snapshot(
            &context,
            query("workspace.inspect_object", json!({"name":"tool_value"})),
        )
        .await
        .unwrap();
    assert_eq!(absent.data.as_ref().unwrap()["kind"], "missing");
    let broken = host
        .invoke(
            &context,
            tool("syntax", "workspace.format", json!({"code":"x <- ("})),
        )
        .await
        .unwrap();
    assert_eq!(broken.status, OperationStatus::Failed, "{broken:?}");
    assert!(broken.error.is_some());
    assert!(
        host.invoke(
            &context,
            tool(
                "config",
                "workspace.lint",
                json!({"code":"1", "config":"evil.R"})
            )
        )
        .await
        .is_err()
    );
    let mut stale = tool("stale-tool", "workspace.help", json!({"topic":"mean"}));
    stale.preconditions.push(rho_contract::Precondition {
        kind: "workspace.session".into(),
        subject: "active".into(),
        expected: json!("stale-session"),
    });
    let refused = host.invoke(&context, stale).await.unwrap();
    assert_eq!(refused.status, OperationStatus::Failed);
    assert!(
        refused
            .error
            .as_ref()
            .unwrap()
            .contains("precondition failed")
    );
}

#[tokio::test]
#[ignore = "requires RHO_ARK and RHO_R_HOME pointing to a real local R installation"]
async fn real_r_preserves_session_reports_errors_and_observes_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let config = ArkConfig {
        executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK required")),
        r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME required")),
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
    resume_console(&host, "after-error").await;
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
    resume_console(&host, "after-interrupt").await;
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
        executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK required")),
        r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME required")),
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

async fn resume_console(host: &NextHost, id: &str) {
    let context = NextHost::local_context();
    let state = host
        .query_snapshot(
            &context,
            rho_contract::QueryRequest {
                capability: CapabilityRef::new("workspace.console_state", 1).unwrap(),
                arguments: json!({}),
            },
        )
        .await
        .unwrap()
        .data
        .unwrap();
    if !state["pause"].is_null() {
        let result=host.invoke(&context,Invocation{client_request_id:format!("resume-{id}"),capability:CapabilityRef::new("workspace.resume_queue",1).unwrap(),arguments:json!({"session_id":state["session_id"],"pause_id":state["pause"]["id"]}),preconditions:vec![]}).await.unwrap();
        assert_eq!(result.status, OperationStatus::Succeeded);
    }
}

#[tokio::test]
#[ignore = "requires real Ark/R; run scripts/test-real-r.mjs"]
async fn real_console_prints_each_expression_and_answers_native_stdin_once() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("console.sqlite");
    let host = NextHost::open_ark(
        &database,
        ArkConfig {
            executable: PathBuf::from(std::env::var_os("RHO_ARK").unwrap()),
            r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").unwrap()),
            project_root: directory.path().into(),
            data_root: directory.path().join("runtime"),
            execution_timeout: Duration::from_secs(5),
            library_path: None,
        },
    )
    .await
    .unwrap();
    let context = NextHost::local_context();
    let mut printed = request(
        "console-print",
        "1+1; message('message-sequence'); warning('warning-sequence'); 2+2; plot(1:3)",
    );
    printed.arguments["output_mode"] = json!("console");
    let record = host.invoke(&context, printed).await.unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded);
    let output = record.output.as_ref().unwrap();
    assert!(output["stdout"].as_str().unwrap().contains("[1] 2"));
    assert!(output["stdout"].as_str().unwrap().contains("[1] 4"));
    assert!(
        output["stderr"]
            .as_str()
            .unwrap()
            .contains("message-sequence")
    );
    assert!(
        output["stderr"]
            .as_str()
            .unwrap()
            .contains("warning-sequence")
    );
    assert!(output["value"].is_null());
    let media = host
        .query_snapshot(
            &context,
            query(
                "workspace.list_outputs",
                json!({"operation_id":record.operation.operation_id,"limit":100}),
            ),
        )
        .await
        .unwrap();
    let reference: rho_contract::MediaReference =
        serde_json::from_value(media.data.unwrap()["media"][0]["reference"].clone()).unwrap();
    let complete = host
        .query_snapshot(
            &context,
            query("workspace.check_code", json!({"code":"mean("})),
        )
        .await
        .unwrap();
    assert_eq!(complete.data.unwrap()["status"], "incomplete");
    let mut input = request(
        "input-once",
        "answer <- readline('Country: '); cat('answer=',answer,'\\n',sep='')",
    );
    input.arguments["output_mode"] = json!("console");
    let accepted = host.invoke_accepted(&context, input).await.unwrap();
    let pending = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let state = host
                .query_snapshot(&context, query("workspace.console_state", json!({})))
                .await
                .unwrap()
                .data
                .unwrap();
            if !state["input"].is_null() {
                break state["input"].clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let response = |session: String| {
        rho_contract::HostRequest::RespondInput(rho_contract::RespondInput {
            session_id: session,
            operation_id: accepted.operation.operation_id.clone(),
            request_id: pending["request_id"].as_str().unwrap().into(),
            reply_id: "answer-once".into(),
            value: "China".into(),
        })
    };
    assert!(
        host.dispatch(&context, response("wrong-session".into()))
            .await
            .is_err()
    );
    host.dispatch(
        &context,
        response(pending["session_id"].as_str().unwrap().into()),
    )
    .await
    .unwrap();
    assert!(
        host.dispatch(
            &context,
            response(pending["session_id"].as_str().unwrap().into())
        )
        .await
        .is_err()
    );
    host.drain().await;
    let answered = host
        .get_operation(&context, &accepted.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(answered.status, OperationStatus::Succeeded);
    assert!(
        answered.output.unwrap()["stdout"]
            .as_str()
            .unwrap()
            .contains("answer=China")
    );
    drop(host);
    // Saved originals remain readable with a project-only Host; no R launch is needed.
    let offline = NextHost::open_project(&database, directory.path())
        .await
        .unwrap();
    assert!(
        !offline
            .capabilities()
            .iter()
            .any(|c| c.capability.id == "workspace.run_r")
    );
    let bytes = offline
        .query_snapshot(
            &context,
            query(
                "workspace.read_output",
                json!({"reference":reference,"offset":0,"limit_bytes":65536}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(bytes.status, QueryStatus::Ready);
    assert!(!bytes.data.unwrap()["bytes"].as_array().unwrap().is_empty());
}

#[tokio::test]
#[ignore = "requires real Ark/R; run scripts/test-real-r.mjs"]
async fn host_shutdown_interrupts_unanswerable_stdin_without_abandoning_the_commit() {
    let directory = tempfile::tempdir().unwrap();
    let host = NextHost::open_ark(
        directory.path().join("stdin-close.sqlite"),
        ArkConfig {
            executable: PathBuf::from(std::env::var_os("RHO_ARK").unwrap()),
            r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").unwrap()),
            project_root: directory.path().into(),
            data_root: directory.path().join("runtime"),
            execution_timeout: Duration::from_secs(5),
            library_path: None,
        },
    )
    .await
    .unwrap();
    let context = NextHost::local_context();
    let accepted = host
        .invoke_accepted(
            &context,
            request(
                "closing-input",
                "Sys.sleep(0.1); readline('No client remains: ')",
            ),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), host.drain())
        .await
        .unwrap();
    let ended = host
        .get_operation(&context, &accepted.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ended.status, OperationStatus::Cancelled, "{ended:?}");
}
