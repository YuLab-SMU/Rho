#[path = "fixtures/plugins.rs"]
mod fixture;
use rho_contract::*;
use rho_host::NextHost;
use rho_plugin_protocol::{PluginArchive, PluginViewConnection, PluginViewMessage};
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn package(path: &Path, version: &str, requirement: Value) -> PluginArchive {
    fixture::package(path, version, false);
    let file = path.join("plugin.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    manifest["requires"] = json!([requirement]);
    manifest["source"]["files"]
        .as_array_mut()
        .unwrap()
        .push(json!("index.html"));
    manifest["views"] = json!([{"id":"view","title":"Combined view","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}]);
    fs::write(
        path.join("index.html"),
        "<!doctype html><h1>Combined view</h1>",
    )
    .unwrap();
    fs::copy(path.join("index.html"), path.join("dist/index.html")).unwrap();
    fs::write(file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    snapshot_directory(path, None, &backend_target()).unwrap()
}
fn invoke(id: &str, cap: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(cap, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}
async fn read(host: &NextHost, cap: &str, arguments: Value) -> Value {
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

#[tokio::test]
async fn combined_package_can_declare_its_own_exact_grant_without_early_publication_or_escalation()
{
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    let db = temp.path().join("state.sqlite");
    let grant = json!({"capability":{"id":"fixture.read","version":1},"scopes":["plugins.read"]});
    let good = package(&temp.path().join("good"), "good", grant.clone());
    let weak = package(
        &temp.path().join("weak"),
        "weak",
        json!({"capability":{"id":"fixture.read","version":1},"scopes":[]}),
    );
    let missing = package(
        &temp.path().join("missing"),
        "missing",
        json!({"capability":{"id":"fixture.read","version":2},"scopes":["plugins.read"]}),
    );
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    for archive in [&good, &weak, &missing] {
        repo.import(archive).unwrap();
    }
    drop(repo);
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    let context = NextHost::local_context();
    let activation = |archive: &PluginArchive, label: &str, mode: &str| {
        invoke(
            label,
            "plugins.activate",
            json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":label,"configuration":{"label":label,"mode":mode}}),
        )
    };
    for (archive, label) in [(&weak, "weak"), (&missing, "missing")] {
        assert!(
            host.invoke(&context, activation(archive, label, "normal"))
                .await
                .is_err()
        );
        assert!(
            !host
                .capabilities()
                .iter()
                .any(|cap| cap.capability.id == "fixture.read")
        );
    }
    let mut denied = context.clone();
    denied.scopes.remove("plugins.read");
    assert!(
        host.invoke(&denied, activation(&good, "denied", "normal"))
            .await
            .is_err()
    );
    let failed = host
        .invoke(&context, activation(&good, "failed", "init_fail"))
        .await
        .unwrap();
    assert_ne!(failed.status, OperationStatus::Succeeded);
    assert!(
        !host
            .capabilities()
            .iter()
            .any(|cap| cap.capability.id == "fixture.read")
    );
    let active = host
        .invoke(&context, activation(&good, "combined", "normal"))
        .await
        .unwrap();
    assert_eq!(active.status, OperationStatus::Succeeded, "{active:?}");
    let instance = active.output.unwrap()["instance"]["identity"].clone();
    let opened=host.invoke(&context,invoke("open","views.open",json!({"instance":instance,"contribution":"view","window":"window-one","configuration":{},"state":{}}))).await.unwrap();
    assert_eq!(opened.status, OperationStatus::Succeeded, "{opened:?}");
    let view = opened.output.unwrap();
    let connection: PluginViewConnection =
        serde_json::from_value(read(&host, "views.connection", json!({"view":view["view"]})).await)
            .unwrap();
    let binding = read(
        &host,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":"fixture.read","version":1}}),
    )
    .await;
    let message = |sequence, cap: &str| {
        serde_json::from_value::<PluginViewMessage>(json!({"protocol_version":1,"connection":connection.connection,"view":view["view"],"sequence":sequence,"request":format!("self-{sequence}"),"body":{"type":"query","capability":{"id":cap,"version":1},"arguments":{"binding":binding,"arguments":{}}}})).unwrap()
    };
    let result = host
        .dispatch_plugin_view(
            &context,
            "window-one",
            &connection.call_token,
            message(1, "fixture.read"),
        )
        .await
        .unwrap();
    assert_eq!(result["data"]["instance"], instance["instance"]);
    assert_eq!(result["data"]["label"], "combined");
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-one",
            &connection.call_token,
            message(2, "fixture.run")
        )
        .await
        .is_err(),
        "own contributions do not create undeclared grants"
    );
    let closed=host.invoke(&context,invoke("close","views.close",json!({"view":view["view"],"mode":{"kind":"retain_acknowledged","expected_version":0}}))).await.unwrap();
    assert_eq!(closed.status, OperationStatus::Succeeded, "{closed:?}");
    let released = host
        .invoke(
            &context,
            invoke("release", "plugins.release", json!({"instance":instance})),
        )
        .await
        .unwrap();
    assert_eq!(released.status, OperationStatus::Succeeded, "{released:?}");
    host.drain().await;
}
