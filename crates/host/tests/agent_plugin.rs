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
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[derive(Clone)]
    struct Provider {
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
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        assert_eq!(body["tools"][0]["function"]["name"], "component_verify");
        provider.count.fetch_add(1, Ordering::SeqCst);
        provider.entered.notify_one();
        std::future::pending().await
    }
    let provider = Provider {
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
    let test = binding(&host, &first, "agent.model.test").await;
    let diagnostic = binding(&host, &first, "agent.model.diagnostic").await;
    let stop = binding(&host, &first, "agent.model.test.stop").await;
    let request = json!({"binding":test,"arguments":{"request_id":"original-diagnostic","model_settings_version":1,"kind":"connection"}});
    let native = invoke(
        &host,
        "original-native-test",
        "agent.model.test",
        request.clone(),
    );
    let inspect_and_stop = async {
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            provider.entered.notified(),
        )
        .await
        .unwrap();
        let observed = query(
            &host,
            "agent.model.diagnostic",
            json!({"binding":diagnostic,"arguments":{"request_id":"original-diagnostic"}}),
        )
        .await;
        assert_eq!(observed["state"], "running");
        let instance = query(&host, "plugins.instance", json!({"instance":first})).await;
        assert!(instance["retained_calls"].as_u64().unwrap() >= 1);
        succeeded(&host, "stop-original", "agent.model.test.stop", json!({"binding":stop,"arguments":{"request_id":"original-diagnostic","expected_version":observed["version"]}})).await;
    };
    let (original, ()) = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        tokio::join!(native, inspect_and_stop)
    })
    .await
    .unwrap();
    assert_eq!(original.status, OperationStatus::Succeeded, "{original:?}");
    assert_eq!(original.output.as_ref().unwrap()["state"], "interrupted");
    let repeated = succeeded(&host, "new-native-observation", "agent.model.test", request).await;
    assert_eq!(repeated.output.as_ref().unwrap()["state"], "interrupted");
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
