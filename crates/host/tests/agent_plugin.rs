//! Real generic-Host acceptance of an independently built ordinary Agent package.
//! This target has no Agent backend dependency and never compiles package source.
use rho_contract::*;
use rho_host::NextHost;
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::path::PathBuf;

async fn query(host: &NextHost, cap: &str, arguments: Value) -> Value {
    host.query_snapshot(
        &NextHost::local_context(),
        QueryRequest {
            capability: CapabilityRef::new(cap, 1).unwrap(),
            arguments,
        },
    )
    .await
    .unwrap()
    .data
    .unwrap()
}
async fn invoke(host: &NextHost, request: &str, cap: &str, arguments: Value) -> OperationRecord {
    host.invoke(
        &NextHost::local_context(),
        Invocation {
            client_request_id: request.into(),
            capability: CapabilityRef::new(cap, 1).unwrap(),
            arguments,
            preconditions: vec![],
        },
    )
    .await
    .unwrap()
}
async fn succeeded(host: &NextHost, request: &str, cap: &str, arguments: Value) -> OperationRecord {
    let record = invoke(host, request, cap, arguments).await;
    assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
    record
}
async fn binding(host: &NextHost, instance: &Value, cap: &str) -> Value {
    query(
        host,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":cap,"version":1}}),
    )
    .await
}

#[tokio::test]
#[ignore = "requires an independently built package; run scripts/test-agent-plugin.mjs"]
async fn ordinary_agent_metadata_uses_generic_host_scopes_isolated_storage_and_original_journal() {
    let package =
        PathBuf::from(std::env::var_os("RHO_AGENT_PLUGIN_PACKAGE").expect("independent package"));
    assert!(!package.starts_with(
        std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).unwrap()
    ));
    let archive = snapshot_directory(&package, None, &backend_target()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let db = directory.path().join("host.sqlite");
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    // Public metadata must cover every declared native management grant. This is
    // read-only and occurs before any Agent backend activation or model startup.
    for grant in &archive.revision.manifest.optional_requires {
        let name = grant.capability.id.as_str();
        if [
            "host.",
            "plugins.",
            "windows.",
            "views.",
            "scenarios.",
            "operation.",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
        {
            let observed: rho_plugin_protocol::HostCapabilityContract = serde_json::from_value(
                query(
                    &host,
                    "host.core_contract",
                    json!({"capability":grant.capability}),
                )
                .await,
            )
            .unwrap();
            assert_eq!(observed.capability, grant.capability);
            assert!(
                matches!(
                    observed.kind,
                    rho_plugin_protocol::CapabilityKind::Query
                        | rho_plugin_protocol::CapabilityKind::Operation
                ),
                "{name}"
            );
            assert!(observed.required_scopes.is_subset(&grant.scopes), "{name}");
            assert!(
                grant.scopes.is_subset(&NextHost::local_context().scopes),
                "{name}"
            );
        }
    }
    let active = succeeded(&host, "activate", "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"agent","configuration":{}})).await;
    let first = active.output.unwrap()["instance"]["identity"].clone();
    let key_store = binding(&host, &first, "agent.model.key.store").await;
    let key_receipt = binding(&host, &first, "agent.model.key.receipt").await;
    let secret = "fixture-only-key-752de101";
    let key_request =
        json!({"binding":key_store,"arguments":{"request_id":"original-key","value":secret}});
    let control = || {
        HostRequest::Control(ControlRequest {
            capability: CapabilityRef::new("agent.model.key.store", 1).unwrap(),
            arguments: key_request.clone(),
        })
    };
    let journal_counts = || {
        let connection = rusqlite::Connection::open(&db).unwrap();
        [
            "operations",
            "operation_events",
            "domain_facts",
            "outbox",
            "operation_commit_candidates",
            "operation_uncommitted_evidence",
        ]
        .map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        })
    };
    let counts_before = journal_counts();
    let original_key = host
        .dispatch(&NextHost::local_context(), control())
        .await
        .unwrap();
    assert_eq!(original_key["kind"], "local_file");
    assert!(!original_key.to_string().contains(secret));
    assert_eq!(
        host.dispatch(&NextHost::local_context(), control())
            .await
            .unwrap(),
        original_key
    );
    assert_eq!(
        query(
            &host,
            "agent.model.key.receipt",
            json!({"binding":key_receipt,"arguments":{"request_id":"original-key"}})
        )
        .await,
        json!({"credential":original_key,"available":true})
    );
    // A wrong port cannot accidentally place key input into an Operation journal.
    assert!(
        host.invoke(
            &NextHost::local_context(),
            Invocation {
                client_request_id: "wrong-key-port".into(),
                capability: CapabilityRef::new("agent.model.key.store", 1).unwrap(),
                arguments: key_request.clone(),
                preconditions: vec![],
            }
        )
        .await
        .is_err()
    );
    assert!(
        host.query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("agent.model.key.store", 1).unwrap(),
                arguments: key_request.clone(),
            }
        )
        .await
        .is_err()
    );
    let mut key_weak = NextHost::local_context();
    key_weak.scopes.remove("application.control");
    assert!(host.dispatch(&key_weak, control()).await.is_err());
    let mut key_foreign = NextHost::local_context();
    key_foreign.caller.id = "other-key-principal".into();
    assert!(host.dispatch(&key_foreign, control()).await.is_err());
    assert_eq!(journal_counts(), counts_before);
    assert!(
        !serde_json::to_string(
            &host
                .outbox(&NextHost::local_context(), 0, 100)
                .await
                .unwrap()
        )
        .unwrap()
        .contains(secret)
    );
    let settings = binding(&host, &first, "agent.model.settings").await;
    let before = query(
        &host,
        "agent.model.settings",
        json!({"binding":settings,"arguments":{}}),
    )
    .await;
    let configure = binding(&host, &first, "agent.model.configure").await;
    let request = json!({"binding":configure,"arguments":{"version":before["version"],"enabled":false,"connection":null}});
    let saved = succeeded(
        &host,
        "configure-original",
        "agent.model.configure",
        request.clone(),
    )
    .await;
    let repeat = succeeded(
        &host,
        "configure-original",
        "agent.model.configure",
        request.clone(),
    )
    .await;
    assert_eq!(saved.operation.operation_id, repeat.operation.operation_id);
    assert_eq!(saved.output, repeat.output);
    let stale = invoke(&host, "configure-stale", "agent.model.configure", request).await;
    assert_eq!(stale.status, OperationStatus::Failed);
    assert_eq!(
        query(
            &host,
            "agent.model.settings",
            json!({"binding":settings,"arguments":{}})
        )
        .await,
        saved.output.unwrap()
    );
    let list = binding(&host, &first, "agent.tasks").await;
    assert_eq!(
        query(
            &host,
            "agent.tasks",
            json!({"binding":list,"arguments":{"limit":20}})
        )
        .await["tasks"],
        json!([])
    );
    let create = binding(&host, &first, "agent.model.create").await;
    let arguments =
        json!({"binding":create,"arguments":{"conversation_id":"task-one","profile":"project"}});
    let created = succeeded(
        &host,
        "create-original",
        "agent.model.create",
        arguments.clone(),
    )
    .await;
    let repeated = succeeded(&host, "create-original", "agent.model.create", arguments).await;
    assert_eq!(
        created.operation.operation_id,
        repeated.operation.operation_id
    );
    assert_eq!(created.output, repeated.output);
    let draft = binding(&host, &first, "agent.model.draft").await;
    let arguments = json!({"binding":draft,"arguments":{"conversation_id":"task-one","draft_version":1,"content":{"text":"研究🙂 retained draft","context":[],"assets":[]},"grant":null}});
    let saved = succeeded(
        &host,
        "save-original",
        "agent.model.draft",
        arguments.clone(),
    )
    .await;
    assert_eq!(saved.output.as_ref().unwrap()["draft_version"], 2);
    let replay = succeeded(
        &host,
        "save-original",
        "agent.model.draft",
        arguments.clone(),
    )
    .await;
    assert_eq!(replay.operation.operation_id, saved.operation.operation_id);
    assert_eq!(replay.output, saved.output);
    let stale = invoke(&host, "stale-new-request", "agent.model.draft", arguments).await;
    assert_eq!(stale.status, OperationStatus::Failed);
    let read = binding(&host, &first, "agent.model.conversation").await;
    let before = query(
        &host,
        "agent.model.conversation",
        json!({"binding":read,"arguments":{"conversation_id":"task-one"}}),
    )
    .await;
    assert_eq!(before["draft_version"], 2);
    assert_eq!(before["draft"], "研究🙂 retained draft");
    let mut weak = NextHost::local_context();
    weak.scopes.remove("application.read");
    assert!(
        host.query_snapshot(
            &weak,
            QueryRequest {
                capability: CapabilityRef::new("agent.tasks", 1).unwrap(),
                arguments: json!({"binding":list,"arguments":{"limit":20}})
            }
        )
        .await
        .is_err()
    );
    let mut foreign = NextHost::local_context();
    foreign.caller.id = "other-principal".into();
    assert!(
        host.query_snapshot(
            &foreign,
            QueryRequest {
                capability: CapabilityRef::new("agent.tasks", 1).unwrap(),
                arguments: json!({"binding":list,"arguments":{"limit":20}})
            }
        )
        .await
        .is_err()
    );
    let second = succeeded(&host, "second-instance", "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"agent-two","configuration":{}})).await.output.unwrap()["instance"]["identity"].clone();
    let second_list = binding(&host, &second, "agent.tasks").await;
    let second_receipt = binding(&host, &second, "agent.model.key.receipt").await;
    let absent = host.query_snapshot(&NextHost::local_context(), QueryRequest {
        capability: CapabilityRef::new("agent.model.key.receipt", 1).unwrap(),
        arguments: json!({"binding":second_receipt,"arguments":{"request_id":"original-key"}}),
    }).await.unwrap();
    assert_eq!(absent.completeness, ObservationCompleteness::Partial);
    assert_eq!(
        absent.data.unwrap(),
        json!({"credential":null,"available":false})
    );
    assert_eq!(
        query(
            &host,
            "agent.tasks",
            json!({"binding":second_list,"arguments":{"limit":20}})
        )
        .await["tasks"],
        json!([])
    );
    assert_eq!(
        query(
            &host,
            "agent.tasks",
            json!({"binding":list,"arguments":{"limit":20}})
        )
        .await["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Completed journal entries and native settlement acknowledgement are
    // separate. Release only after both accepted execution leases have retired.
    for instance in [&first, &second] {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let observed = query(&host, "plugins.instance", json!({"instance":instance})).await;
                if observed["retained_calls"] == 0 && observed["pending_messages"] == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    succeeded(
        &host,
        "release-first",
        "plugins.release",
        json!({"instance":first}),
    )
    .await;
    succeeded(
        &host,
        "release-second",
        "plugins.release",
        json!({"instance":second}),
    )
    .await;
    succeeded(
        &host,
        "remove-agent",
        "plugins.remove",
        json!({"revision":archive.revision.id}),
    )
    .await;
    let retained = host
        .get_operation(&NextHost::local_context(), &saved.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.status, OperationStatus::Succeeded);
    assert_eq!(retained.output, saved.output);
    assert_eq!(
        query(&host, "plugins.list", json!({"limit":20})).await["items"],
        json!([])
    );
    host.drain().await;
    drop(host);
    assert!(!root.join(".Rhistory").exists());
}

#[tokio::test]
#[ignore = "requires an independently built package; run scripts/test-agent-plugin.mjs"]
async fn ordinary_agent_retains_model_test_operation_until_explicit_stop_and_never_replays() {
    assert_model_retention(false).await;
}

#[tokio::test]
#[ignore = "requires an independently built package; run scripts/test-agent-plugin.mjs"]
async fn ordinary_agent_retains_model_task_operation_and_stops_only_its_original_loop() {
    assert_model_retention(true).await;
}

async fn assert_model_retention(model_task: bool) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[derive(Clone)]
    struct Provider {
        model_task: bool,
        entered: Arc<tokio::sync::Notify>,
        count: Arc<AtomicUsize>,
    }
    async fn held(
        axum::extract::State(provider): axum::extract::State<Provider>,
        headers: axum::http::HeaderMap,
        axum::Json(body): axum::Json<Value>,
    ) -> axum::http::StatusCode {
        assert_eq!(
            headers["authorization"],
            "Bearer native-diagnostic-fixture-key"
        );
        if provider.model_task {
            assert!(body["tools"].as_array().is_none_or(Vec::is_empty));
            assert!(
                body["messages"]
                    .to_string()
                    .contains("Explain this analysis")
            );
        } else {
            assert_eq!(body["tools"].as_array().unwrap().len(), 1);
            assert_eq!(body["tools"][0]["function"]["name"], "component_verify");
        }
        provider.count.fetch_add(1, Ordering::SeqCst);
        provider.entered.notify_one();
        std::future::pending().await
    }
    let provider = Provider {
        model_task,
        entered: Arc::default(),
        count: Arc::default(),
    };
    let app = axum::Router::new()
        .route("/v1/chat/completions", axum::routing::post(held))
        .with_state(provider.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider_task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let package = PathBuf::from(std::env::var_os("RHO_AGENT_PLUGIN_PACKAGE").unwrap());
    let archive = snapshot_directory(&package, None, &backend_target()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let db = directory.path().join("host.sqlite");
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    let first = succeeded(&host, "activate", "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"agent-model","configuration":{}})).await.output.unwrap()["instance"]["identity"].clone();
    let store = binding(&host, &first, "agent.model.key.store").await;
    let key = host.dispatch(&NextHost::local_context(), HostRequest::Control(ControlRequest {
        capability: CapabilityRef::new("agent.model.key.store", 1).unwrap(),
        arguments: json!({"binding":store,"arguments":{"request_id":"test-key","value":"native-diagnostic-fixture-key"}}),
    })).await.unwrap();
    let configure = binding(&host, &first, "agent.model.configure").await;
    succeeded(&host, "configure", "agent.model.configure", json!({"binding":configure,"arguments":{
        "version":0,"enabled":true,"connection":{"protocol":"openai_completions","base_url":url,"model":"fixture","credential":key}
    }})).await;
    let (run_cap, read_cap, stop_cap, arguments, query_arguments) = if model_task {
        let create = binding(&host, &first, "agent.model.create").await;
        let task = succeeded(&host, "create-task", "agent.model.create", json!({"binding":create,"arguments":{"conversation_id":"model-task","profile":"project"}})).await.output.unwrap();
        (
            "agent.model.run",
            "agent.model.run.request",
            "agent.model.run.stop",
            json!({"request_id":"original-model-task","conversation_id":"model-task","conversation_version":task["version"],"model_settings_version":1,"text":"Explain this analysis"}),
            json!({"request_id":"original-model-task"}),
        )
    } else {
        (
            "agent.model.test",
            "agent.model.diagnostic",
            "agent.model.test.stop",
            json!({"request_id":"original-diagnostic","model_settings_version":1,"kind":"connection"}),
            json!({"request_id":"original-diagnostic"}),
        )
    };
    let test = binding(&host, &first, run_cap).await;
    let diagnostic = binding(&host, &first, read_cap).await;
    let stop = binding(&host, &first, stop_cap).await;
    let request = json!({"binding":test,"arguments":arguments});
    let native = invoke(&host, "original-native-test", run_cap, request.clone());
    let inspect_and_stop = async {
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            provider.entered.notified(),
        )
        .await
        .unwrap();
        let observed = query(
            &host,
            read_cap,
            json!({"binding":diagnostic,"arguments":query_arguments}),
        )
        .await;
        assert_eq!(observed["state"], "running");
        let instance = query(&host, "plugins.instance", json!({"instance":first})).await;
        assert!(instance["retained_calls"].as_u64().unwrap() >= 1);
        let stop_arguments = if model_task {
            json!({"run_id":observed["run_id"]})
        } else {
            json!({"request_id":"original-diagnostic","expected_version":observed["version"]})
        };
        succeeded(
            &host,
            "stop-original",
            stop_cap,
            json!({"binding":stop,"arguments":stop_arguments}),
        )
        .await;
    };
    let (original, ()) = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        tokio::join!(native, inspect_and_stop)
    })
    .await
    .unwrap();
    assert_eq!(original.status, OperationStatus::Succeeded, "{original:?}");
    let expected_state = if model_task { "stopped" } else { "interrupted" };
    assert_eq!(original.output.as_ref().unwrap()["state"], expected_state);
    let repeated = succeeded(&host, "new-native-observation", run_cap, request).await;
    assert_eq!(repeated.output.as_ref().unwrap()["state"], expected_state);
    if model_task {
        assert_eq!(
            original.output.as_ref().unwrap()["run_id"],
            repeated.output.as_ref().unwrap()["run_id"]
        );
    }
    assert_eq!(provider.count.load(Ordering::SeqCst), 1);
    assert!(
        !serde_json::to_string(
            &host
                .outbox(&NextHost::local_context(), 0, 100)
                .await
                .unwrap()
        )
        .unwrap()
        .contains("native-diagnostic-fixture-key")
    );
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let observed = query(&host, "plugins.instance", json!({"instance":first})).await;
            if observed["retained_calls"] == 0 && observed["pending_messages"] == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    succeeded(
        &host,
        "release",
        "plugins.release",
        json!({"instance":first}),
    )
    .await;
    succeeded(
        &host,
        "remove",
        "plugins.remove",
        json!({"revision":archive.revision.id}),
    )
    .await;
    assert_eq!(
        host.get_operation(&NextHost::local_context(), &original.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .output,
        original.output
    );
    host.drain().await;
    provider_task.abort();
    let _ = provider_task.await;
}

#[tokio::test]
#[ignore = "requires an independently built package; run scripts/test-agent-plugin.mjs"]
async fn ordinary_native_tasks_isolate_uploads_and_never_journal_attachment_bytes() {
    let package =
        PathBuf::from(std::env::var_os("RHO_AGENT_PLUGIN_PACKAGE").expect("independent package"));
    assert!(!package.starts_with(
        std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).unwrap()
    ));
    let archive = snapshot_directory(&package, None, &backend_target()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let db = directory.path().join("host.sqlite");
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    let first = succeeded(&host, "native-activate", "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"native-agent","configuration":{}})).await.output.unwrap()["instance"]["identity"].clone();
    let command = binding(&host, &first, "agent.native.command").await;
    let create_id = uuid::Uuid::new_v4().to_string();
    let input = json!({"binding":command,"arguments":{"request_id":create_id,"command":{"kind":"create","provider":"kimi","model":"fixture-not-opened","effort":null}}});
    let original = succeeded(
        &host,
        "native-create",
        "agent.native.command",
        input.clone(),
    )
    .await;
    let repeated = succeeded(&host, "native-create", "agent.native.command", input).await;
    assert_eq!(
        original.operation.operation_id,
        repeated.operation.operation_id
    );
    assert_eq!(original.output, repeated.output);
    let created = original.output.as_ref().unwrap();
    let task = created["detail"]["summary"]["task"]["task_id"].clone();
    let control = json!({"task_id":task,"generation":created["detail"]["summary"]["attachment"]["generation"]});
    let read = binding(&host, &first, "agent.native.task").await;
    let upload = binding(&host, &first, "agent.native.assets.upload").await;
    let receipt = binding(&host, &first, "agent.native.receipt").await;
    let upload_id = uuid::Uuid::new_v4().to_string();
    // Bytes are deliberately unique, so accidental journal persistence is visible.
    let bytes = "TmF0aXZlIHVwbG9hZCBqb3VybmFsIGV4Y2x1c2lvbiAwNmY0OTY=";
    let arguments = json!({"binding":upload,"arguments":{"request_id":upload_id,"control":control,"name":"notes.txt","mime_type":"text/plain","data":bytes}});
    let upload_request = || {
        HostRequest::Control(ControlRequest {
            capability: CapabilityRef::new("agent.native.assets.upload", 1).unwrap(),
            arguments: arguments.clone(),
        })
    };
    let counts = || {
        let connection = rusqlite::Connection::open(&db).unwrap();
        [
            "operations",
            "operation_events",
            "domain_facts",
            "outbox",
            "operation_commit_candidates",
            "operation_uncommitted_evidence",
        ]
        .map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        })
    };
    // Wait for the preceding Operation's settlement before comparing journals.
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let state = query(&host, "plugins.instance", json!({"instance":first})).await;
            if state["retained_calls"] == 0 && state["pending_messages"] == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let before = counts();
    let uploaded = host
        .dispatch(&NextHost::local_context(), upload_request())
        .await
        .unwrap();
    assert_eq!(uploaded["receipt"]["status"], "succeeded");
    assert_eq!(uploaded["detail"]["assets"].as_array().unwrap().len(), 1);
    assert_eq!(
        host.dispatch(&NextHost::local_context(), upload_request())
            .await
            .unwrap(),
        uploaded
    );
    let observed = query(
        &host,
        "agent.native.receipt",
        json!({"binding":receipt,"arguments":{"request_id":upload_id}}),
    )
    .await;
    assert_eq!(observed, uploaded["receipt"]);
    assert!(!uploaded.to_string().contains(bytes));
    assert_eq!(counts(), before);
    let mut weak = NextHost::local_context();
    weak.scopes.remove("application.control");
    assert!(host.dispatch(&weak, upload_request()).await.is_err());
    let mut foreign = NextHost::local_context();
    foreign.caller.id = "foreign-native-principal".into();
    assert!(host.dispatch(&foreign, upload_request()).await.is_err());
    assert!(
        host.invoke(
            &NextHost::local_context(),
            Invocation {
                client_request_id: "wrong-upload-port".into(),
                capability: CapabilityRef::new("agent.native.assets.upload", 1).unwrap(),
                arguments: arguments.clone(),
                preconditions: vec![]
            }
        )
        .await
        .is_err()
    );
    assert!(host.invoke(&NextHost::local_context(), Invocation { client_request_id:"binary-command".into(), capability:CapabilityRef::new("agent.native.command",1).unwrap(), arguments:json!({"binding":command,"arguments":{"request_id":uuid::Uuid::new_v4().to_string(),"command":{"kind":"add_asset","control":control,"name":"notes.txt","mime_type":"text/plain","data":bytes}}}), preconditions:vec![] }).await.is_err());
    assert_eq!(counts(), before);
    assert!(
        !serde_json::to_string(
            &host
                .outbox(&NextHost::local_context(), 0, 100)
                .await
                .unwrap()
        )
        .unwrap()
        .contains(bytes)
    );
    let saved = succeeded(&host,"native-save","agent.native.command",json!({"binding":command,"arguments":{"request_id":uuid::Uuid::new_v4().to_string(),"command":{"kind":"save_draft","control":control,"version":uploaded["detail"]["draft"]["version"],"content":{"text":"保留草稿 🙂","context":[],"assets":[uploaded["detail"]["assets"][0]["asset_id"]]}}}})).await;
    let current = query(
        &host,
        "agent.native.task",
        json!({"binding":read,"arguments":{"task_id":task}}),
    )
    .await;
    assert_eq!(current, saved.output.as_ref().unwrap()["detail"]);
    assert_eq!(current["draft"]["content"]["text"], "保留草稿 🙂");
    assert_eq!(current["assets"].as_array().unwrap().len(), 1);
    let second = succeeded(&host,"native-second","plugins.activate",json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"native-agent-two","configuration":{}})).await.output.unwrap()["instance"]["identity"].clone();
    let second_list = binding(&host, &second, "agent.tasks").await;
    assert_eq!(
        query(
            &host,
            "agent.tasks",
            json!({"binding":second_list,"arguments":{"limit":20}})
        )
        .await["tasks"],
        json!([])
    );
    let second_read = binding(&host, &second, "agent.native.task").await;
    assert!(
        host.query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("agent.native.task", 1).unwrap(),
                arguments: json!({"binding":second_read,"arguments":{"task_id":task}})
            }
        )
        .await
        .is_err()
    );
    let second_receipt = binding(&host, &second, "agent.native.receipt").await;
    assert!(
        host.query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("agent.native.receipt", 1).unwrap(),
                arguments: json!({"binding":second_receipt,"arguments":{"request_id":upload_id}})
            }
        )
        .await
        .is_err()
    );
    for (index, instance) in [&first, &second].into_iter().enumerate() {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let state = query(&host, "plugins.instance", json!({"instance":instance})).await;
                if state["retained_calls"] == 0 && state["pending_messages"] == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        succeeded(
            &host,
            &format!("native-release-{index}"),
            "plugins.release",
            json!({"instance":instance}),
        )
        .await;
    }
    succeeded(
        &host,
        "native-remove",
        "plugins.remove",
        json!({"revision":archive.revision.id}),
    )
    .await;
    let retained = host
        .get_operation(&NextHost::local_context(), &original.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.output, original.output);
    assert_eq!(retained.status, OperationStatus::Succeeded);
    host.drain().await;
    assert!(!root.join(".Rhistory").exists());
}

#[path = "fixtures/agent_assets.rs"]
mod resource_assets;
#[path = "fixtures/plugins.rs"]
mod resource_provider;
