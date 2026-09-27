use base64::{Engine, engine::general_purpose::STANDARD};
use rho_contract::*;
use rho_host::{NextHost, OperationError};
use rho_plugin_protocol::{PluginViewConnection, PluginViewMessage};
use rho_plugins::{PluginRepository, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn package(path: &Path) -> rho_plugin_protocol::PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    fs::write(
        path.join("main.js"),
        "document.body.textContent = 'Editing';",
    )
    .unwrap();
    fs::write(path.join("BUILD.md"), "Supply an explicit toolchain.").unwrap();
    fs::write(path.join("deps.lock"), "No dependencies").unwrap();
    fs::write(
        path.join("dist/index.html"),
        "<!doctype html><title>Independent source editor</title>",
    )
    .unwrap();
    let requires: Vec<_> = ["plugins.source_tree","plugins.read_source","plugins.branches","plugins.check_source","plugins.checkpoint"].into_iter()
        .map(|id|json!({"capability":{"id":id,"version":1},"scopes":[if id=="plugins.checkpoint" {"plugins.write"} else {"plugins.read"}]})).collect();
    fs::write(path.join("plugin.json"),serde_json::to_vec(&json!({
        "protocol_version":1,"id":"example.editor","name":"Independent editor","version":"1","description":"Source development fixture","license":"MIT",
        "source":{"files":["main.js"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},"dependencies":{},"requires":requires,
        "views":[{"id":"editor","title":"Source editor","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}],
        "capabilities":[],"contexts":[],"backend":null,"configuration_schema":{"type":"object"},"default_configuration":{}
    })).unwrap()).unwrap();
    snapshot_directory(path, None, "ui-web").unwrap()
}
async fn query(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    arguments: Value,
) -> Result<Value, OperationError> {
    Ok(host
        .query_snapshot(
            context,
            QueryRequest {
                capability: CapabilityRef::new(id, 1).unwrap(),
                arguments,
            },
        )
        .await?
        .data
        .unwrap())
}
fn invocation(request: &str, id: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: request.into(),
        capability: CapabilityRef::new(id, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}

#[tokio::test]
async fn source_ports_validate_without_effects_and_preserve_original_checkpoint_identity() {
    let temp = tempfile::tempdir().unwrap();
    let package = package(&temp.path().join("package"));
    let db = temp.path().join("records.sqlite");
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&package).unwrap();
    let branch = repo
        .create_branch(&package.revision.id, "Public editing")
        .unwrap();
    let host = NextHost::open_project(&db, temp.path()).await.unwrap();
    let context = NextHost::local_context();
    let input = json!({"branch":branch,"expected_head":package.revision.id,"changes":{"main.js":{"kind":"put","content_base64":STANDARD.encode("const text = '继续编辑';"),"executable":false}}});
    let before = host.outbox(&context, 0, 100).await.unwrap();
    let listing = json!({"revision":package.revision.id,"after":null,"limit":2});
    assert_eq!(
        query(&host, &context, "plugins.source_tree", listing.clone())
            .await
            .unwrap()["files"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
    let source = json!({"revision":package.revision.id,"path":"main.js","offset":0,"limit":65536});
    let original = query(&host, &context, "plugins.read_source", source.clone())
        .await
        .unwrap();
    assert_eq!(
        STANDARD
            .decode(original["content_base64"].as_str().unwrap())
            .unwrap(),
        fs::read(temp.path().join("package/main.js")).unwrap()
    );
    let proposed = query(&host, &context, "plugins.check_source", input.clone())
        .await
        .unwrap();
    assert!(
        repo.revision(&serde_json::from_value(proposed["revision"].clone()).unwrap())
            .is_err()
    );
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.branches",
            json!({"plugin":package.revision.manifest.id,"after":null,"limit":10})
        )
        .await
        .unwrap()["branches"][0]["origin"],
        json!(package.revision.id)
    );
    assert_eq!(host.outbox(&context, 0, 100).await.unwrap(), before);
    assert!(
        query(&host, &context, "plugins.instances", json!({"limit":10}))
            .await
            .unwrap()["instances"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let mut denied = context.clone();
    denied.scopes.remove("plugins.read");
    for (id, args) in [
        ("plugins.source_tree", listing),
        ("plugins.read_source", source),
        ("plugins.check_source", input.clone()),
        (
            "plugins.branches",
            json!({"plugin":package.revision.manifest.id,"limit":10}),
        ),
    ] {
        assert!(query(&host, &denied, id, args).await.is_err(), "{id}");
    }
    denied = context.clone();
    denied.scopes.remove("plugins.write");
    assert!(
        host.invoke(
            &denied,
            invocation("denied", "plugins.checkpoint", input.clone())
        )
        .await
        .is_err()
    );
    let mut invalid = input.clone();
    invalid["changes"]["plugin.json"] =
        json!({"kind":"put","content_base64":STANDARD.encode("{broken"),"executable":false});
    assert!(matches!(
        host.invoke(
            &context,
            invocation("invalid", "plugins.checkpoint", invalid)
        )
        .await,
        Err(OperationError::InvalidInput(_))
    ));
    for field in ["artifact", "project", "principal"] {
        let mut spoof = input.clone();
        spoof[field] = json!("forged");
        assert!(
            host.invoke(&context, invocation(field, "plugins.checkpoint", spoof))
                .await
                .is_err()
        );
    }
    let first = host
        .invoke(
            &context,
            invocation("save", "plugins.checkpoint", input.clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        first.status,
        OperationStatus::Succeeded,
        "{:?}",
        first.error
    );
    assert_eq!(first.output.as_ref().unwrap(), &proposed);
    assert_eq!(
        first.operation.admission.as_ref().unwrap().owner_context["source_checkpoint"],
        proposed
    );
    assert!(matches!(
        host.invoke(
            &context,
            invocation("stale", "plugins.checkpoint", input.clone())
        )
        .await,
        Err(OperationError::ContentChanged(_))
    ));
    let repeated = host
        .invoke(
            &context,
            invocation("save", "plugins.checkpoint", input.clone()),
        )
        .await
        .unwrap();
    assert_eq!(json!(first), json!(repeated));
    let mut different = input.clone();
    different["changes"]["main.js"]["content_base64"] = json!(STANDARD.encode("different"));
    assert!(
        host.invoke(
            &context,
            invocation("save", "plugins.checkpoint", different)
        )
        .await
        .is_err()
    );
    assert_eq!(repo.export(&package.revision.id).unwrap(), package);
    let mut next = input;
    next["expected_head"] = proposed["revision"].clone();
    let (left, right) = tokio::join!(
        host.invoke(
            &context,
            invocation("left", "plugins.checkpoint", next.clone())
        ),
        host.invoke(&context, invocation("right", "plugins.checkpoint", next))
    );
    let results = [left, right];
    assert_eq!(
        results
            .iter()
            .filter(|r| r
                .as_ref()
                .is_ok_and(|r| r.status == OperationStatus::Succeeded))
            .count(),
        1
    );
    assert!(results.iter().any(|r| {
        matches!(r, Err(OperationError::ContentChanged(_)))
            || r.as_ref()
                .is_ok_and(|r| r.status == OperationStatus::Failed)
    }));
    assert_eq!(repo.list_page(None, 100).unwrap().total, 3);
    let current = repo.branch_head(&branch).unwrap();
    let fault_input = json!({"branch":branch,"expected_head":current,"changes":{"main.js":{"kind":"put","content_base64":STANDARD.encode("after forced write failure"),"executable":false}}});
    let catalog = rusqlite::Connection::open(repo.root().join("catalog-v1.sqlite3")).unwrap();
    catalog.execute_batch("CREATE TRIGGER fail_source_ref BEFORE INSERT ON revision_refs WHEN NEW.owner_kind='branch' BEGIN SELECT RAISE(FAIL,'source fixture write failure'); END;").unwrap();
    let failed = host
        .invoke(
            &context,
            invocation("write-fails", "plugins.checkpoint", fault_input.clone()),
        )
        .await
        .unwrap();
    assert_eq!(failed.status, OperationStatus::Uncertain);
    assert_eq!(repo.branch_head(&branch).unwrap(), current);
    assert_eq!(repo.list_page(None, 100).unwrap().total, 3);
    catalog
        .execute_batch("DROP TRIGGER fail_source_ref")
        .unwrap();
    let repeated = host
        .invoke(
            &context,
            invocation("write-fails", "plugins.checkpoint", fault_input),
        )
        .await
        .unwrap();
    assert_eq!(json!(repeated), json!(failed));
    assert_eq!(repo.branch_head(&branch).unwrap(), current);
}

#[tokio::test]
async fn ordinary_view_edits_through_declared_ports_without_manager_privilege() {
    let temp = tempfile::tempdir().unwrap();
    let package = package(&temp.path().join("package"));
    let db = temp.path().join("records.sqlite");
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&package).unwrap();
    let branch = repo
        .create_branch(&package.revision.id, "View editing")
        .unwrap();
    let host = NextHost::open_project(&db, temp.path()).await.unwrap();
    let context = NextHost::local_context();
    let activated = host.invoke(&context,invocation("activate","plugins.activate",json!({"revision":package.revision.id,"artifact":package.artifacts[0].id,"target":"ui-web","alias":"editor","configuration":{}}))).await.unwrap();
    assert_eq!(
        activated.status,
        OperationStatus::Succeeded,
        "{:?}",
        activated.error
    );
    let opened = host.invoke(&context,invocation("open","views.open",json!({"instance":activated.output.unwrap()["instance"]["identity"],"contribution":"editor","window":"editing-window","configuration":{},"state":{}}))).await.unwrap();
    let view = opened.output.unwrap()["view"].clone();
    let connection: PluginViewConnection = serde_json::from_value(
        query(&host, &context, "views.connection", json!({"view":view}))
            .await
            .unwrap(),
    )
    .unwrap();
    let message = |sequence, body: Value| {
        serde_json::from_value::<PluginViewMessage>(json!({"protocol_version":1,"connection":connection.connection,"view":view,"sequence":sequence,"request":format!("message-{sequence}"),"body":body})).unwrap()
    };
    let read = json!({"type":"query","capability":{"id":"plugins.read_source","version":1},"arguments":{"revision":package.revision.id,"path":"main.js","offset":0,"limit":10}});
    assert!(
        host.dispatch_plugin_view(
            &context,
            "editing-window",
            &connection.call_token,
            message(1, read.clone())
        )
        .await
        .is_ok()
    );
    let mut revoked = context.clone();
    revoked.scopes.remove("plugins.read");
    assert!(
        host.dispatch_plugin_view(
            &revoked,
            "editing-window",
            &connection.call_token,
            message(2, read.clone())
        )
        .await
        .is_err()
    );
    assert!(
        host.dispatch_plugin_view(
            &context,
            "another-window",
            &connection.call_token,
            message(3, read)
        )
        .await
        .is_err()
    );
    assert!(host.dispatch_plugin_view(&context,"editing-window",&connection.call_token,message(3,json!({"type":"query","capability":{"id":"plugins.list","version":1},"arguments":{"limit":10}}))).await.is_err());
    let save = json!({"type":"invoke","request_id":"source-checkpoint","capability":{"id":"plugins.checkpoint","version":1},"preconditions":[],"arguments":{
        "branch":branch,"expected_head":package.revision.id,"changes":{"main.js":{"kind":"put","content_base64":STANDARD.encode("const text = 'from ordinary view';"),"executable":false}}}});
    let accepted = host
        .dispatch_plugin_view(
            &context,
            "editing-window",
            &connection.call_token,
            message(4, save.clone()),
        )
        .await
        .unwrap();
    let id = OperationId::new(accepted["operation"]["operation_id"].as_str().unwrap()).unwrap();
    let completed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
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
    let replay = host
        .dispatch_plugin_view(
            &context,
            "editing-window",
            &connection.call_token,
            message(5, save),
        )
        .await
        .unwrap();
    assert_eq!(replay["operation"]["operation_id"], json!(id));
    assert_eq!(repo.list_page(None, 100).unwrap().total, 2);
    assert!(
        repo.inspect(&repo.branch_head(&branch).unwrap())
            .unwrap()
            .artifacts
            .is_empty()
    );
}
