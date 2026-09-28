use super::*;

async fn quiet(host: &NextHost, instance: &Value) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let state = query(host, "plugins.instance", json!({"instance":instance})).await;
            if state["retained_calls"] == 0 && state["pending_messages"] == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
#[ignore = "requires an independently built package; run scripts/test-agent-plugin.mjs"]
async fn ordinary_agent_imports_full_resource_under_native_grants_without_journaling_or_replay() {
    let package =
        PathBuf::from(std::env::var_os("RHO_AGENT_PLUGIN_PACKAGE").expect("independent package"));
    assert!(!package.starts_with(
        std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).unwrap()
    ));
    let agent = snapshot_directory(&package, None, &backend_target()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let db = directory.path().join("host.sqlite");
    let source = resource_provider::package(&directory.path().join("source"), "1", false);
    {
        let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
        repository.import(&agent).unwrap();
        repository.import(&source).unwrap();
    }
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    let source_instance = succeeded(&host,"source-activate","plugins.activate",json!({"revision":source.revision.id,"artifact":source.artifacts[0].id,"target":backend_target(),"alias":"source","configuration":{}})).await.output.unwrap()["instance"]["identity"].clone();
    let source_binding = binding(&host, &source_instance, "fixture.read").await;
    // The separate Python backend writes actual bytes over its native data channel.
    let reference = query(
        &host,
        "fixture.read",
        json!({"binding":source_binding,"arguments":{"action":"resource_put","bytes":8*1024*1024}}),
    )
    .await["reference"]
        .clone();
    assert_eq!(reference["owner"], source_instance);
    assert_eq!(reference["bytes"], 8 * 1024 * 1024);
    quiet(&host, &source_instance).await;
    succeeded(
        &host,
        "source-release",
        "plugins.release",
        json!({"instance":source_instance}),
    )
    .await;
    let first = succeeded(&host,"agent-activate","plugins.activate",json!({"revision":agent.revision.id,"artifact":agent.artifacts[0].id,"target":backend_target(),"alias":"agent","configuration":{},"optional_capabilities":[{"id":"resources.read","version":1}]})).await.output.unwrap()["instance"]["identity"].clone();
    let command = binding(&host, &first, "agent.native.command").await;
    let created=succeeded(&host,"create-task","agent.native.command",json!({"binding":command,"arguments":{"request_id":uuid::Uuid::new_v4().to_string(),"command":{"kind":"create","provider":"kimi","model":"fixture-not-opened","effort":null}}})).await.output.unwrap();
    let input = json!({"request_id":uuid::Uuid::new_v4().to_string(),"control":{"task_id":created["detail"]["summary"]["task"]["task_id"],"generation":created["detail"]["summary"]["attachment"]["generation"]},"name":"完整附件.bin","reference":reference});
    let import = binding(&host, &first, "agent.native.assets.import").await;
    let dispatch = |arguments: Value| {
        HostRequest::Control(ControlRequest {
            capability: CapabilityRef::new("agent.native.assets.import", 1).unwrap(),
            arguments: json!({"binding":import,"arguments":arguments}),
        })
    };
    quiet(&host, &first).await;
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
    let before = counts();
    let uploaded = host
        .dispatch(&NextHost::local_context(), dispatch(input.clone()))
        .await
        .unwrap();
    assert_eq!(uploaded["receipt"]["status"], "succeeded");
    let assets = uploaded["detail"]["assets"].as_array().unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0]["bytes"], reference["bytes"]);
    assert_eq!(
        format!("sha256:{}", assets[0]["sha256"].as_str().unwrap()),
        reference["digest"].as_str().unwrap()
    );
    assert_eq!(assets[0]["asset_id"], input["request_id"]);
    assert_eq!(
        host.dispatch(&NextHost::local_context(), dispatch(input.clone()))
            .await
            .unwrap(),
        uploaded
    );
    for scope in ["application.control", "resources.read"] {
        let mut weak = NextHost::local_context();
        weak.scopes.remove(scope);
        assert!(host.dispatch(&weak, dispatch(input.clone())).await.is_err());
    }
    let mut foreign = NextHost::local_context();
    foreign.caller.id = "another-principal".into();
    assert!(
        host.dispatch(&foreign, dispatch(input.clone()))
            .await
            .is_err()
    );
    for field in ["digest", "resource"] {
        let mut changed = input.clone();
        changed["request_id"] = uuid::Uuid::new_v4().to_string().into();
        changed["reference"][field] = if field == "digest" {
            format!("sha256:{}", "0".repeat(64))
        } else {
            "nonexistent-resource".into()
        }
        .into();
        assert!(
            host.dispatch(&NextHost::local_context(), dispatch(changed))
                .await
                .is_err()
        );
    }
    let mut changed = input.clone();
    changed["name"] = "replacement.bin".into();
    assert!(
        host.dispatch(&NextHost::local_context(), dispatch(changed))
            .await
            .is_err()
    );
    assert_eq!(
        counts(),
        before,
        "Attachment data and read observations must not create Operations"
    );
    let task=query(&host,"agent.native.task",json!({"binding":binding(&host,&first,"agent.native.task").await,"arguments":{"task_id":input["control"]["task_id"]}})).await;
    assert_eq!(task["assets"], uploaded["detail"]["assets"]);
    assert!(task["summary"]["task"]["native_session_id"].is_null());
    assert_eq!(
        query(
            &host,
            "plugins.instance",
            json!({"instance":source_instance})
        )
        .await["instance"]["state"],
        "released"
    );
    quiet(&host, &first).await;
    succeeded(
        &host,
        "agent-release",
        "plugins.release",
        json!({"instance":first}),
    )
    .await;
    host.drain().await;
}
