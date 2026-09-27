use super::*;
use rho_plugin_protocol::PluginArchive;
use rho_plugins::{PluginRepository, repository_path, snapshot_directory};
use std::{fs, path::Path, time::Duration};

fn invoke(id: &str, capability: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}
async fn run(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    capability: &str,
    arguments: Value,
) -> Value {
    let result = host
        .invoke(context, invoke(id, capability, arguments))
        .await
        .unwrap();
    assert_eq!(
        result.status,
        OperationStatus::Succeeded,
        "{id}: {:?}",
        result.error
    );
    result.output.unwrap()
}
fn ui_package(path: &Path, version: &str, dependency: Option<&PluginArchive>) -> PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    fs::write(
        path.join("index.html"),
        "<!doctype html><h1>Scenario fixture</h1>",
    )
    .unwrap();
    fs::copy(path.join("index.html"), path.join("dist/index.html")).unwrap();
    fs::write(path.join("BUILD.md"), "Copy index.html to dist/index.html").unwrap();
    fs::write(path.join("deps.lock"), "No dependencies").unwrap();
    let mut manifest = json!({"protocol_version":1,"id":"example.scene-view","name":"Scene view","version":version,
        "description":"Public scene fixture","license":"MIT",
        "source":{"files":["index.html"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},
        "dependencies":{},"requires":[
            {"capability":{"id":"scenarios.apply","version":1},"scopes":["plugins.run"]},
            {"capability":{"id":"scenarios.prepare","version":1},"scopes":["plugins.run"]},
            {"capability":{"id":"windows.scenario","version":1},"scopes":["plugins.run"]},
            {"capability":{"id":"windows.resolve","version":1},"scopes":["plugins.run"]}],
        "optional_requires":[{"capability":{"id":"plugins.list","version":1},"scopes":["plugins.read"]}],
        "views":[{"id":"document","title":"Document","entrypoint":"dist/index.html",
            "state_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},
            "configuration_schema":{"type":"object","additionalProperties":false},"resource_kinds":["application/octet-stream"]}],
        "capabilities":[],"contexts":[],"backend":null,"configuration_schema":{"type":"object","additionalProperties":false},"default_configuration":{}});
    if let Some(dependency) = dependency {
        manifest["dependencies"] = json!({"engine":{"plugin":dependency.revision.manifest.id,"revision":dependency.revision.id}});
    }
    fs::write(
        path.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    snapshot_directory(path, None, "ui-web").unwrap()
}
fn instance(archive: &PluginArchive, config: Value, dependencies: Value) -> Value {
    json!({"plugin":archive.revision.manifest.id,"revision":archive.revision.id,"artifact":archive.artifacts[0].id,
        "configuration":config,"dependencies":dependencies})
}
fn scene(archive: &PluginArchive, name: &str) -> Value {
    json!({"scenario":name,"expected_head":null,"name":name,
        "instances":{"editor":instance(archive,json!({}),json!({}))},"providers":[],
        "layout":{"kind":"tabs","id":"main","selected":"document","views":[{"id":"document","instance":"editor",
            "contribution":"document","configuration":{},"state":{"text":"checkpoint"},"state_revision":archive.revision.id,"resource":null}]}})
}
async fn activate(
    host: &NextHost,
    context: &CallContext,
    archive: &PluginArchive,
    alias: &str,
    configuration: Value,
) -> Value {
    run(host, context, &format!("activate-{alias}"), "plugins.activate", json!({"revision":archive.revision.id,
        "artifact":archive.artifacts[0].id,"target":archive.artifacts[0].target,"alias":alias,"configuration":configuration})).await["instance"]["identity"].clone()
}
async fn open(
    host: &NextHost,
    context: &CallContext,
    owner: &Value,
    id: &str,
    window: &str,
) -> Value {
    run(
        host,
        context,
        id,
        "views.open",
        json!({"instance":owner,"contribution":"document","window":window,
        "configuration":{},"state":{"text":"live 中文"}}),
    )
    .await["view"]
        .clone()
}

#[tokio::test]
async fn application_is_atomic_scoped_and_preserves_live_views_and_original_replay() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("records.sqlite");
    let archive = ui_package(&temp.path().join("ui"), "1", None);
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_project(&db, temp.path()).await.unwrap();
    let context = NextHost::local_context();
    let owner = activate(&host, &context, &archive, "editor", json!({})).await;
    let view = open(&host, &context, &owner, "open", "a").await;
    let other_view = open(&host, &context, &owner, "open-other", "b").await;
    let definition = scene(&archive, "analysis");
    let revision = run(
        &host,
        &context,
        "save",
        "scenarios.checkpoint",
        definition.clone(),
    )
    .await["id"]
        .clone();
    let args = json!({"window":"a","revision":revision,"expected_layout_version":0,"instances":{"editor":owner},"views":{"document":view}});
    let initial = query(&host, &context, "windows.scenario", json!({"window":"a"}))
        .await
        .unwrap();
    assert!(initial["scenario"].is_null());
    let outbox = host.outbox(&context, 0, 100).await.unwrap();
    let prepared = query(&host, &context, "scenarios.prepare", args.clone())
        .await
        .unwrap();
    assert_eq!(prepared["layout"]["version"], 1);
    assert_eq!(
        query(&host, &context, "windows.scenario", json!({"window":"a"}))
            .await
            .unwrap(),
        initial
    );
    assert_eq!(host.outbox(&context, 0, 100).await.unwrap(), outbox);
    let saved = run(&host, &context, "apply", "scenarios.apply", args.clone()).await;
    assert_eq!(saved, prepared);
    assert_eq!(
        query(&host, &context, "windows.scenario", json!({"window":"a"}))
            .await
            .unwrap(),
        saved
    );
    let connection = query(&host, &context, "views.connection", json!({"view":view}))
        .await
        .unwrap();
    let empty = run(&host,&context,"save-empty","scenarios.checkpoint",json!({"scenario":"empty","expected_head":null,"name":"Empty","instances":{},"providers":[],"layout":{"kind":"empty"}})).await["id"].clone();
    let empty_args = json!({"window":"a","revision":empty,"expected_layout_version":1,"instances":{},"views":{}});
    let switched = run(&host, &context, "empty", "scenarios.apply", empty_args).await;
    assert_eq!(switched["layout"]["layout"], json!({"kind":"empty"}));
    assert_eq!(
        run(&host, &context, "apply", "scenarios.apply", args.clone()).await,
        saved
    );
    assert_eq!(
        query(&host, &context, "windows.scenario", json!({"window":"a"}))
            .await
            .unwrap(),
        switched
    );
    run(
        &host,
        &context,
        "draft",
        "views.update",
        json!({"view":view,"expected_version":0,"state":{"text":"later draft α"}}),
    )
    .await;
    let mut restore = args.clone();
    restore["expected_layout_version"] = json!(2);
    let catalog =
        rusqlite::Connection::open(repository_path(&db).join("catalog-v1.sqlite3")).unwrap();
    assert_eq!(
        catalog
            .query_row("SELECT count(*) FROM plugin_views", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    // Failure on the second write must also roll back the first (layout) write.
    catalog.execute_batch("CREATE TRIGGER reject_scene BEFORE INSERT ON plugin_window_scenarios BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    let failed = host
        .invoke(
            &context,
            invoke("failed", "scenarios.apply", restore.clone()),
        )
        .await
        .unwrap();
    assert_ne!(failed.status, OperationStatus::Succeeded);
    assert_eq!(
        query(&host, &context, "windows.scenario", json!({"window":"a"}))
            .await
            .unwrap(),
        switched
    );
    catalog.execute_batch("DROP TRIGGER reject_scene;").unwrap();
    let before = host.outbox(&context, 0, 100).await.unwrap();
    for (name, bad) in [
        ("extra-alias", {
            let mut a = restore.clone();
            a["instances"]["extra"] = owner.clone();
            a
        }),
        ("extra-view", {
            let mut a = restore.clone();
            a["views"]["extra"] = view.clone();
            a
        }),
        ("wrong-view", {
            let mut a = restore.clone();
            a["views"]["document"] = other_view.clone();
            a
        }),
        ("missing-view", {
            let mut a = restore.clone();
            a["views"] = json!({});
            a
        }),
        ("forged-revision", {
            let mut a = restore.clone();
            a["instances"]["editor"]["revision"] = json!(format!("sha256:{}", "f".repeat(64)));
            a
        }),
        ("stale", args.clone()),
    ] {
        assert!(
            query(&host, &context, "scenarios.prepare", bad.clone())
                .await
                .is_err(),
            "{name}"
        );
        assert!(
            host.invoke(&context, invoke(name, "scenarios.apply", bad))
                .await
                .is_err(),
            "{name}"
        );
    }
    assert_eq!(host.outbox(&context, 0, 100).await.unwrap(), before);
    let mut stranger = context.clone();
    stranger.caller.id = "other".into();
    assert!(
        host.invoke(
            &stranger,
            invoke("stranger", "scenarios.apply", restore.clone())
        )
        .await
        .is_err()
    );
    let mut denied = context.clone();
    denied.scopes.remove("plugins.run");
    assert!(
        host.invoke(
            &denied,
            invoke("denied", "scenarios.apply", restore.clone())
        )
        .await
        .is_err()
    );
    // A public view grant works only inside the original containing window.
    let foreign = json!({"window":"b","revision":empty,"expected_layout_version":0,"instances":{},"views":{}});
    let message = |sequence, arguments| {
        serde_json::from_value::<rho_plugin_protocol::PluginViewMessage>(json!({"protocol_version":1,
        "connection":connection["connection"],"view":view,"sequence":sequence,"request":format!("request-{sequence}"),
        "body":{"type":"invoke","request_id":format!("request-{sequence}"),"capability":{"id":"scenarios.apply","version":1},"arguments":arguments,"preconditions":[]}})).unwrap()
    };
    assert!(
        host.dispatch_plugin_view(
            &context,
            "a",
            connection["call_token"].as_str().unwrap(),
            message(1, foreign)
        )
        .await
        .is_err()
    );
    let admitted = host
        .dispatch_plugin_view(
            &context,
            "a",
            connection["call_token"].as_str().unwrap(),
            message(2, restore.clone()),
        )
        .await
        .unwrap();
    let id = OperationId::new(admitted["operation"]["operation_id"].as_str().unwrap()).unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let record = host.get_operation(&context, &id).await.unwrap().unwrap();
            if record.status.is_terminal() {
                break record;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        completed.status,
        OperationStatus::Succeeded,
        "{:?}",
        completed.error
    );
    let restored = completed.output.unwrap();
    assert_eq!(restored["layout"]["version"], 3);
    assert_eq!(
        query(&host, &context, "views.inspect", json!({"view":view}))
            .await
            .unwrap()["state"]["text"],
        "later draft α"
    );
    assert_eq!(
        query(&host, &context, "views.connection", json!({"view":view}))
            .await
            .unwrap()["connection"],
        connection["connection"]
    );
    assert_eq!(
        query(&host, &context, "windows.layout", json!({"window":"b"}))
            .await
            .unwrap()["version"],
        0
    );
    // A prepared read does not reserve the window: concurrent applies have one winner.
    restore["expected_layout_version"] = json!(3);
    let (a, b) = tokio::join!(
        host.invoke(
            &context,
            invoke("race-a", "scenarios.apply", restore.clone())
        ),
        host.invoke(&context, invoke("race-b", "scenarios.apply", restore))
    );
    assert_eq!(
        [a, b]
            .iter()
            .filter(|r| r
                .as_ref()
                .is_ok_and(|r| r.status == OperationStatus::Succeeded))
            .count(),
        1
    );
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.instance",
            json!({"instance":owner})
        )
        .await
        .unwrap()["instance"]["state"],
        "active"
    );
    run(
        &host,
        &context,
        "close",
        "views.close",
        json!({"view":view,"mode":{"kind":"retain_acknowledged","expected_version":1}}),
    )
    .await;
    let retained = query(&host, &context, "windows.scenario", json!({"window":"a"}))
        .await
        .unwrap();
    let mut closed_args = args.clone();
    closed_args["expected_layout_version"] = retained["layout"]["version"].clone();
    assert!(
        query(&host, &context, "scenarios.prepare", closed_args)
            .await
            .is_err()
    );
    host.drain().await;
    let observed: rho_plugin_protocol::WindowScenarioSnapshot =
        serde_json::from_value(retained.clone()).unwrap();
    let reopened = PluginRepository::open(&repository_path(&db))
        .unwrap()
        .window_scenario(
            &observed.layout.project,
            &observed.layout.principal,
            &observed.layout.window,
        )
        .unwrap();
    assert_eq!(json!(reopened), retained);
}

#[tokio::test]
async fn switching_revisions_keeps_accepted_work_bound_and_rejects_invalid_preparation() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("records.sqlite");
    let old = fixture::package(&temp.path().join("old"), "old", false);
    let new = fixture::package(&temp.path().join("new"), "new", false);
    let ui = ui_package(&temp.path().join("ui"), "1", Some(&old));
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    for archive in [&old, &new, &ui] {
        repo.import(archive).unwrap();
    }
    drop(repo);
    let host = NextHost::open_project(&db, temp.path()).await.unwrap();
    let context = NextHost::local_context();
    let old_id = activate(&host, &context, &old, "old", json!({"label":"old"})).await;
    let new_id = activate(&host, &context, &new, "new", json!({"label":"new"})).await;
    let ui_id = activate(&host, &context, &ui, "ui", json!({})).await;
    let resource_binding = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"instance":old_id,
        "capability":{"id":"fixture.run","version":1}}),
    )
    .await
    .unwrap();
    let resource = run(
        &host,
        &context,
        "resource",
        "fixture.run",
        json!({"binding":resource_binding,
        "arguments":{"action":"resource_commit","bytes":8}}),
    )
    .await["reference"]
        .clone();
    let view_args = json!({"instance":ui_id,"contribution":"document","window":"science",
        "configuration":{},"state":{"text":"live 中文"},"resource":resource});
    let view = run(&host, &context, "open", "views.open", view_args.clone()).await["view"].clone();
    let mut forged = view_args.clone();
    forged["resource"]["digest"] = json!(format!("sha256:{}", "f".repeat(64)));
    assert!(
        host.invoke(&context, invoke("forged-resource", "views.open", forged))
            .await
            .is_err()
    );
    assert_eq!(
        query(&host, &context, "views.connection", json!({"view":view}))
            .await
            .unwrap()["view"]["resource"],
        resource
    );
    let mut definition = scene(&ui, "science");
    definition["layout"]["views"][0]["resource"] = resource;
    definition["instances"]["editor"]["dependencies"] = json!({"engine":"engine"});
    definition["instances"]["engine"] = instance(&old, json!({"label":"old"}), json!({}));
    definition["providers"] = json!([{"capability":{"id":"fixture.run","version":1},"instance":"engine","target":"original-session"}]);
    let revision = run(
        &host,
        &context,
        "save",
        "scenarios.checkpoint",
        definition.clone(),
    )
    .await["id"]
        .clone();
    let args = json!({"window":"science","revision":revision,"expected_layout_version":0,"instances":{"engine":old_id,"editor":ui_id},"views":{"document":view}});
    run(&host, &context, "apply", "scenarios.apply", args.clone()).await;
    let binding = query(
        &host,
        &context,
        "windows.resolve",
        json!({"window":"science","capability":{"id":"fixture.run","version":1}}),
    )
    .await
    .unwrap();
    assert_eq!(binding["provider"], old_id);
    assert_eq!(binding["target"], "original-session");
    let reader = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"instance":old_id,"capability":{"id":"fixture.read","version":1}}),
    )
    .await
    .unwrap();
    let original = invoke(
        "held-science",
        "fixture.run",
        json!({"binding":binding,"arguments":{"action":"hold"}}),
    );
    let accepted: OperationRecord = serde_json::from_value(
        host.dispatch(
            &context,
            HostRequest::Invoke(InvokeRequest {
                invocation: original.clone(),
                return_after_acceptance: Some(true),
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if query(
                &host,
                &context,
                "fixture.read",
                json!({"binding":reader,"arguments":{"action":"pending_count"}}),
            )
            .await
            .unwrap()["operations"]
                == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let next = json!({"scenario":"next","expected_head":null,"name":"Next","instances":{"engine":instance(&new,json!({"label":"new"}),json!({}))},
        "providers":[{"capability":{"id":"fixture.run","version":1},"instance":"engine","target":"new-session"}],"layout":{"kind":"empty"}});
    let next_revision =
        run(&host, &context, "save-next", "scenarios.checkpoint", next).await["id"].clone();
    run(&host,&context,"apply-next","scenarios.apply",json!({"window":"science","revision":next_revision,"expected_layout_version":1,"instances":{"engine":new_id},"views":{}})).await;
    assert_eq!(
        query(
            &host,
            &context,
            "windows.resolve",
            json!({"window":"science","capability":{"id":"fixture.run","version":1}})
        )
        .await
        .unwrap()["provider"],
        new_id
    );
    let pending = host
        .get_operation(&context, &accepted.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert!(!pending.status.is_terminal() && !pending.cancellation_requested);
    assert_eq!(pending.operation.normalized_arguments["binding"], binding);
    let mut restore = args.clone();
    restore["expected_layout_version"] = json!(2);
    for (label, change) in [
        (
            "grants",
            json!({"capability":{"id":"plugins.list","version":1}}),
        ),
        ("dependency", json!({})),
        ("config", json!({})),
        ("state", json!({})),
        ("provider", json!({})),
    ] {
        let mut bad = definition.clone();
        bad["scenario"] = json!(label);
        match label {
            "grants" => {
                bad["instances"]["editor"]["optional_capabilities"] = json!([change["capability"]])
            }
            "dependency" => bad["instances"]["editor"]["dependencies"] = json!({}),
            "config" => bad["instances"]["engine"]["configuration"] = json!({"label":"different"}),
            "state" => bad["layout"]["views"][0]["state"] = json!({"text":42}),
            "provider" => bad["providers"][0]["capability"]["id"] = json!("absent.capability"),
            _ => unreachable!(),
        }
        let id = run(
            &host,
            &context,
            &format!("save-{label}"),
            "scenarios.checkpoint",
            bad,
        )
        .await["id"]
            .clone();
        let mut bad_args = restore.clone();
        bad_args["revision"] = id;
        assert!(
            query(&host, &context, "scenarios.prepare", bad_args.clone())
                .await
                .is_err(),
            "{label}"
        );
        assert!(
            host.invoke(&context, invoke(label, "scenarios.apply", bad_args))
                .await
                .is_err(),
            "{label}"
        );
    }
    run(
        &host,
        &context,
        "restore",
        "scenarios.apply",
        restore.clone(),
    )
    .await;
    assert_eq!(
        query(&host, &context, "views.inspect", json!({"view":view}))
            .await
            .unwrap()["state"]["text"],
        "live 中文"
    );
    query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":reader,"arguments":{"action":"finish"}}),
    )
    .await
    .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let record = host
                .get_operation(&context, &accepted.operation.operation_id)
                .await
                .unwrap()
                .unwrap();
            if record.status.is_terminal() {
                break record;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completed.status, OperationStatus::Succeeded);
    assert_eq!(completed.output.as_ref().unwrap()["label"], "old");
    assert_eq!(
        host.invoke(&context, original)
            .await
            .unwrap()
            .operation
            .operation_id,
        completed.operation.operation_id
    );
    // Explicit release leaves the selected identity inspectable and never routes
    // through the other still-active provider.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = query(
                &host,
                &context,
                "fixture.read",
                json!({"binding":reader,"arguments":{"action":"settlement_state"}}),
            )
            .await
            .unwrap();
            if state["settlements"][completed.operation.operation_id.as_str()].is_object() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    run(
        &host,
        &context,
        "release-old",
        "plugins.release",
        json!({"instance":old_id}),
    )
    .await;
    assert!(
        query(
            &host,
            &context,
            "windows.resolve",
            json!({"window":"science","capability":{"id":"fixture.run","version":1}})
        )
        .await
        .is_err()
    );
    assert_eq!(
        query(
            &host,
            &context,
            "windows.scenario",
            json!({"window":"science"})
        )
        .await
        .unwrap()["scenario"]["instances"]["engine"],
        old_id
    );
    restore["expected_layout_version"] = json!(3);
    assert!(
        host.invoke(
            &context,
            invoke("released-apply", "scenarios.apply", restore)
        )
        .await
        .is_err()
    );
    host.drain().await;
}
