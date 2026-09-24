//! Public plugin path with a native artifact built outside this checkout.
use rho_contract::*;
use rho_host::NextHost;
use rho_plugin_protocol::{InstanceRef, PluginArchive, PluginInstanceObservation};
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc, time::Duration};

#[path = "fixtures/r_queue.rs"]
mod queue;
#[path = "fixtures/r_console.rs"]
mod console;

async fn query(host: &NextHost, id: &str, args: Value) -> Value {
    host.query_snapshot(
        &NextHost::local_context(),
        QueryRequest {
            capability: CapabilityRef::new(id, 1).unwrap(),
            arguments: args,
        },
    )
    .await
    .unwrap()
    .data
    .unwrap()
}
fn invocation(id: &str, cap: &str, args: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(cap, 1).unwrap(),
        arguments: args,
        preconditions: vec![],
    }
}
async fn run(host: &NextHost, id: &str, cap: &str, args: Value) -> OperationRecord {
    let record = host
        .invoke(&NextHost::local_context(), invocation(id, cap, args))
        .await
        .unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
    record
}
async fn binding(host: &NextHost, instance: &InstanceRef, id: &str) -> Value {
    query(
        host,
        "plugins.resolve",
        json!({"capability":{"id":id,"version":1},"instance":instance}),
    )
    .await
}
async fn native_query(host: &NextHost, instance: &InstanceRef, id: &str, args: Value) -> Value {
    query(
        host,
        id,
        json!({"binding":binding(host, instance, id).await,"arguments":args}),
    )
    .await
}
async fn activate(host: &NextHost, archive: &PluginArchive, alias: &str) -> InstanceRef {
    let record = run(host, alias, "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,
        "target":backend_target(),"alias":alias,"configuration":{"ark":fs::canonicalize(std::env::var_os("RHO_ARK").unwrap()).unwrap(),
            "r_home":fs::canonicalize(std::env::var_os("RHO_R_HOME").unwrap()).unwrap(),"execution_timeout_seconds":30}})).await;
    serde_json::from_value::<PluginInstanceObservation>(record.output.unwrap())
        .unwrap()
        .instance
        .identity
}
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        assert!(!entry.file_type().unwrap().is_symlink());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

async fn answer_native_input(host: &Arc<NextHost>, instance: &InstanceRef, session: &Value) {
    let execute = binding(host, instance, "r.execute").await;
    let request = invocation(
        "native-input",
        "r.execute",
        json!({"binding":execute,
        "arguments":{"expected_session":session,"code":"answer <- readline('Native answer: '); paste0('received:', answer)"}}),
    );
    let running_host = host.clone();
    let running_request = request.clone();
    let running = tokio::spawn(async move {
        running_host
            .invoke(&NextHost::local_context(), running_request)
            .await
    });
    // Wait for the native request itself; elapsed time never authorizes an answer.
    let pending = tokio::time::timeout(Duration::from_secs(20), async {
        let mut interval = tokio::time::interval(Duration::from_millis(30));
        loop {
            interval.tick().await;
            let observed = native_query(host, instance, "r.session", json!({})).await;
            if !observed["input"].is_null() {
                break observed["input"].clone();
            }
        }
    })
    .await
    .unwrap();
    let active = host
        .invoke(&NextHost::local_context(), request)
        .await
        .unwrap();
    assert_eq!(active.status, OperationStatus::Running);
    assert_eq!(
        pending["operation_id"],
        json!(active.operation.operation_id)
    );
    assert_eq!(pending["session_id"], *session);
    let mut control_binding = binding(host, instance, "r.respond_input").await;
    control_binding["target"] = session.clone();
    let arguments = json!({"session_id":session,"operation_id":pending["operation_id"],
        "request_id":pending["request_id"],"reply_id":"native-answer","value":"中文 αβ"});
    let control = |binding: Value, args: Value| {
        HostRequest::Control(ControlRequest {
            capability: CapabilityRef::new("r.respond_input", 1).unwrap(),
            arguments: json!({"binding":binding,"arguments":args}),
        })
    };
    let mut wrong_operation = arguments.clone();
    wrong_operation["operation_id"] = json!("not-the-pending-operation");
    assert!(
        host.dispatch(
            &NextHost::local_context(),
            control(control_binding.clone(), wrong_operation)
        )
        .await
        .is_err()
    );
    let mut wrong_target = control_binding.clone();
    wrong_target["target"] = json!("another-session");
    assert!(
        host.dispatch(
            &NextHost::local_context(),
            control(wrong_target, arguments.clone())
        )
        .await
        .is_err()
    );
    let mut oversized = arguments.clone();
    oversized["value"] = json!("中".repeat(30000)); // Under character quota, over native byte quota.
    assert!(
        host.dispatch(
            &NextHost::local_context(),
            control(control_binding.clone(), oversized)
        )
        .await
        .is_err()
    );
    assert_eq!(
        native_query(host, instance, "r.session", json!({})).await["input"]["submitted"],
        false
    );
    let paused = queue::control(host, instance, session, true, Value::Null, Value::Null)
        .await
        .unwrap();
    let followup = queue::start(
        host,
        invocation(
            "queued-before-drain",
            "r.execute",
            json!({"binding":execute,
        "arguments":{"expected_session":session,"code":"paste0('continued:', answer)"}}),
        ),
    );
    let queued = queue::wait(host, instance, session, |s| {
        s["console"]["pending"].as_array().unwrap().len() == 1
    })
    .await;
    let followup_id = queued["console"]["pending"][0]["operation_id"].clone();
    let draining = host
        .invoke(
            &NextHost::local_context(),
            invocation(
                "drain-pending-input",
                "plugins.release",
                json!({"instance":instance}),
            ),
        )
        .await
        .unwrap();
    assert_ne!(draining.status, OperationStatus::Succeeded);
    assert_eq!(
        query(host, "plugins.instance", json!({"instance":instance})).await["instance"]["state"],
        "draining"
    );
    assert!(
        host.invoke(
            &NextHost::local_context(),
            invocation(
                "no-new-execution",
                "r.execute",
                json!({"binding":execute,
        "arguments":{"expected_session":session,"code":"stop('must not run')"}})
            )
        )
        .await
        .is_err()
    );
    assert_eq!(
        native_query(host, instance, "r.session", json!({})).await["input"]["request_id"],
        pending["request_id"]
    );
    assert_eq!(
        host.dispatch(
            &NextHost::local_context(),
            control(control_binding.clone(), arguments.clone())
        )
        .await
        .unwrap(),
        json!({"submitted":true})
    );
    assert!(
        host.dispatch(
            &NextHost::local_context(),
            control(control_binding, arguments)
        )
        .await
        .is_err(),
        "an accepted answer cannot be repeated"
    );
    let completed = tokio::time::timeout(Duration::from_secs(20), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        completed.operation.operation_id,
        active.operation.operation_id
    );
    assert_eq!(
        completed.status,
        OperationStatus::Succeeded,
        "{completed:?}"
    );
    assert_eq!(completed.output.unwrap()["value"], "received:中文 αβ");
    // Draining withdraws new operations; explicit controls can still resume the
    // exact already accepted queue after the native input has completed.
    assert_eq!(
        queue::console(host, instance, session).await["console"]["pause"]["id"],
        paused["console"]["pause"]["id"]
    );
    queue::resume(host, instance, session, json!([followup_id])).await;
    assert_eq!(
        queue::completed(followup).await.output.unwrap()["value"],
        "continued:中文 αβ"
    );
}

#[tokio::test]
#[ignore = "requires RHO_R_PLUGIN_PACKAGE built outside the checkout, RHO_ARK and RHO_R_HOME"]
async fn independent_r_plugin_uses_original_operations_and_retains_revision_scoped_resources() {
    let source = std::path::PathBuf::from(
        std::env::var_os("RHO_R_PLUGIN_PACKAGE").expect("RHO_R_PLUGIN_PACKAGE"),
    );
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state/state.sqlite");
    let first = snapshot_directory(&source, None, &backend_target()).unwrap();
    let second_source = temp.path().join("revision-two");
    copy_tree(&source, &second_source);
    let manifest_file = second_source.join("plugin.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_file).unwrap()).unwrap();
    manifest["version"] = json!("0.1.1");
    fs::write(manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let second = snapshot_directory(
        &second_source,
        Some(first.revision.id.clone()),
        &backend_target(),
    )
    .unwrap();
    let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
    repository.import(&first).unwrap();
    repository.import(&second).unwrap();
    let host = Arc::new(NextHost::open_project(&db, &project).await.unwrap());
    let left = activate(&host, &first, "left").await;
    let right = activate(&host, &second, "right").await;
    assert_ne!(left.revision, right.revision);
    let live_host = host.clone();
    let live_left = left.clone();
    let live_right = right.clone();
    let project_root = project.canonicalize().unwrap();
    let live_db = db.clone();
    let exercise = tokio::spawn(async move {
        let (host, left, right) = (live_host, live_left, live_right);
        assert_eq!(native_query(&host, &left, "r.session", json!({})).await["state"], "unstarted");
        console::unstarted(&host,&left).await;
        let premature = host.query_snapshot(&NextHost::local_context(), QueryRequest {
            capability: CapabilityRef::new("r.snapshot",1).unwrap(), arguments:json!({"binding":binding(&host,&left,"r.snapshot").await,"arguments":{"expected_session":"absent","limit":10}}),
        }).await;
        assert!(premature.is_err());
        assert_eq!(native_query(&host, &left, "r.session", json!({})).await["state"], "unstarted");
        let right_create=queue::paused_creation(&host,&right).await;
        let left_create = run(&host, "left-session", "r.create_session", json!({"binding":binding(&host,&left,"r.create_session").await,"arguments":{}})).await;
        let session = left_create.output.as_ref().unwrap()["session_id"].clone();
        let other_session = right_create.output.as_ref().unwrap()["session_id"].clone();
        assert_ne!(session, other_session);
        assert_eq!(left_create.output.as_ref().unwrap()["project_root"], json!(project_root));
        let bind = binding(&host, &left, "r.execute").await;
        let request = invocation("native-original", "r.execute", json!({"binding":bind,"arguments":{"expected_session":session,
            "code":"x <- 21; cat('R 插件 α\\n'); f <- tempfile(fileext='.html'); writeLines('<html><body>retained public viewer</body></html>', f); getOption('viewer')(f); plot(1:3); x * 2"}}));
        let record = host.invoke(&NextHost::local_context(), request.clone()).await.unwrap();
        assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
        let output = record.output.as_ref().unwrap();
        assert_eq!(output["operation_id"], json!(record.operation.operation_id));
        assert_eq!(output["value"], 42);
        assert!(output["stdout"].as_str().unwrap().contains("R 插件 α"));
        let resources = output["outputs"].as_array().unwrap();
        let html = resources.iter().find(|item|item["reference"]["media_type"]=="text/html").unwrap()["reference"].clone();
        assert!(resources.iter().any(|item|item["reference"]["media_type"]=="image/png"));
        assert_eq!(html["owner"], json!(left));
        for item in resources { assert_eq!(item["native"]["operation_id"], json!(record.operation.operation_id)); }
        let events = host.events(&NextHost::local_context(), &record.operation.operation_id).await.unwrap();
        assert!(events.iter().any(|event|event.kind=="effect.observed" && event.payload["kind"]=="plugin.evidence"));
        let snapshot = native_query(&host, &left, "r.snapshot", json!({"expected_session":session,"limit":100})).await;
        assert!(snapshot["data"]["objects"].as_array().unwrap().iter().any(|item|item["name"]=="x"));
        let other = native_query(&host, &right, "r.snapshot", json!({"expected_session":other_session,"limit":100})).await;
        assert!(!other["data"]["objects"].as_array().unwrap().iter().any(|item|item["name"]=="x"));
        assert!(host.invoke(&NextHost::local_context(), invocation("wrong-session","r.execute",json!({"binding":bind,"arguments":{"expected_session":other_session,"code":"x <- 999"}}))).await.is_err());
        let repeat = host.invoke(&NextHost::local_context(), request.clone()).await.unwrap();
        assert_eq!(repeat.operation.operation_id, record.operation.operation_id);
        console::exercise(&host,&left,&session,&right,&other_session).await;
        // Receive an actual native signal before cancelling; no timing guesses.
        let ready = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let code = format!("con <- socketConnection('127.0.0.1', port={}, open='w'); writeLines('started', con); close(con); Sys.sleep(20); 777",ready.local_addr().unwrap().port());
        let long = invocation("native-cancel", "r.execute", json!({"binding":bind,"arguments":{"expected_session":session,"code":code}}));
        let running_host = host.clone(); let running_request = long.clone();
        let running = tokio::spawn(async move { running_host.invoke(&NextHost::local_context(),running_request).await });
        let (mut socket,_) = tokio::time::timeout(Duration::from_secs(20),ready.accept()).await.unwrap().unwrap();
        let mut signal = [0;7]; tokio::io::AsyncReadExt::read_exact(&mut socket,&mut signal).await.unwrap();
        assert_eq!(&signal,b"started");
        let active = host.invoke(&NextHost::local_context(),long).await.unwrap();
        assert_eq!(active.status,OperationStatus::Running);
        assert!(host.request_cancellation(&NextHost::local_context(),&active.operation.operation_id).await.unwrap().accepted);
        let cancelled = tokio::time::timeout(Duration::from_secs(20),running).await.unwrap().unwrap().unwrap();
        assert_eq!(cancelled.status,OperationStatus::Cancelled,"{cancelled:?}");
        assert_eq!(native_query(&host,&left,"r.session",json!({})).await["session_id"],session);
        queue::resume(&host,&left,&session,json!([cancelled.operation.operation_id])).await;
        let failed = host.invoke(&NextHost::local_context(), invocation("native-error", "r.execute", json!({"binding":bind,
            "arguments":{"expected_session":session,"code":"x <- 99; stop('expected native error')"}}))).await.unwrap();
        assert_eq!(failed.status, OperationStatus::Failed, "{failed:?}");
        queue::resume(&host,&left,&session,json!([failed.operation.operation_id])).await;
        let after_error = run(&host,"after-native-error","r.execute",json!({"binding":bind,"arguments":{"expected_session":session,"code":"x"}})).await;
        assert_eq!(after_error.output.unwrap()["value"],99, "R errors do not roll back prior effects");
        let disconnect = invocation("native-disconnect", "r.execute", json!({"binding":bind,
            "arguments":{"expected_session":session,"code":"q(save='no')"}}));
        let uncertain = host.invoke(&NextHost::local_context(),disconnect.clone()).await.unwrap();
        assert_eq!(uncertain.status,OperationStatus::Uncertain,"{uncertain:?}");
        assert!(uncertain.recovery.is_some());
        assert_eq!(host.invoke(&NextHost::local_context(),disconnect).await.unwrap().operation.operation_id,uncertain.operation.operation_id);
        assert_eq!(native_query(&host,&left,"r.session",json!({})).await["session_id"],session, "read cannot replace a lost native session");
        assert_eq!(native_query(&host,&right,"r.session",json!({})).await["session_id"],other_session);
        queue::exercise(&host,&right,&other_session,&live_db,&project_root).await;
        queue::full_queue(&host,&right,&other_session,&project_root).await;
        answer_native_input(&host, &right, &other_session).await;
        (html,request,record)
    }).await;
    // Attempt cleanup for both owners before reporting any assertion failure.
    let mut cleanup = vec![];
    for (id, instance) in [("release-left", &left), ("release-right", &right)] {
        cleanup.push(
            host.invoke(
                &NextHost::local_context(),
                invocation(id, "plugins.release", json!({"instance":instance})),
            )
            .await,
        );
    }
    for result in cleanup {
        let record = result.unwrap();
        assert_eq!(
            record.status,
            OperationStatus::Succeeded,
            "release error={:?} recovery={:?}",
            record.error,
            record.recovery
        );
    }
    let (html, request, record) = exercise.unwrap();
    for (id, revision) in [
        ("remove-right", &second.revision.id),
        ("remove-left", &first.revision.id),
    ] {
        run(&host, id, "plugins.remove", json!({"revision":revision})).await;
    }
    let read = json!({"reference":html,"offset":0,"limit":65536});
    let retained = query(&host, "resources.read", read.clone()).await;
    use base64::{Engine, engine::general_purpose::STANDARD};
    assert!(
        String::from_utf8(
            STANDARD
                .decode(retained["base64"].as_str().unwrap())
                .unwrap()
        )
        .unwrap()
        .contains("retained public viewer")
    );
    host.drain().await;
    drop(host);
    let reopened = NextHost::open_project(&db, &project).await.unwrap();
    assert_eq!(query(&reopened, "resources.read", read).await, retained);
    let replay = reopened
        .invoke(&NextHost::local_context(), request)
        .await
        .unwrap();
    assert_eq!(replay.operation.operation_id, record.operation.operation_id);
    assert_eq!(replay.output, record.output);
    assert!(
        !reopened
            .capabilities()
            .iter()
            .any(|item| item.capability.id == "r.execute")
    );
    reopened.drain().await;
}
