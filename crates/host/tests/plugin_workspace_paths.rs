#[path = "fixtures/plugins.rs"]
mod fixture;
use rho_contract::*;
use rho_host::NextHost;
use rho_plugin_protocol::WorkspacePaths;
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::fs;

async fn query(
    host: &NextHost,
    context: &CallContext,
    capability: &str,
    arguments: Value,
) -> Result<QuerySnapshot, rho_host::OperationError> {
    host.query_snapshot(
        context,
        QueryRequest {
            capability: CapabilityRef::new(capability, 1).unwrap(),
            arguments,
        },
    )
    .await
}

#[tokio::test]
async fn host_boundaries_are_scoped_immutable_metadata_and_public_reverse_calls() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let project = project.canonicalize().unwrap();
    let db = project.join("records.sqlite");
    let path = temp.path().join("backend");
    fixture::package(&path, "paths", false);
    // The external fixture uses only its declared public reverse query. Keep the
    // old initialization wire shape to cover already-built revision coexistence.
    for file in ["backend.py", "dist/backend"] {
        let file = path.join(file);
        fs::write(
            &file,
            fs::read_to_string(&file)
                .unwrap()
                .replace("\"plugins.list\"", "\"workspace.paths\""),
        )
        .unwrap();
    }
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(path.join("plugin.json")).unwrap()).unwrap();
    manifest["requires"][0] =
        json!({"capability":{"id":"workspace.paths","version":1},"scopes":["project.read"]});
    fs::write(
        path.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let archive = snapshot_directory(&path, None, &backend_target()).unwrap();
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&db, &project)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let response = query(&host, &context, "workspace.paths", json!({}))
        .await
        .unwrap();
    assert_eq!(response.status, QueryStatus::Ready);
    let paths: WorkspacePaths = serde_json::from_value(response.data.unwrap()).unwrap();
    assert_eq!(paths.project_root, project.to_str().unwrap());
    for protected in [
        db.clone(),
        repository_path(&db),
        db.with_extension("studio.sqlite"),
        project.join("records.sqlite-wal"),
        project.join("records.sqlite.host.lock"),
        project.join(".rho/next-host.lock"),
    ] {
        assert!(
            paths
                .protected_paths
                .contains(&protected.to_string_lossy().into_owned()),
            "missing {protected:?}"
        );
    }
    let mut denied = context.clone();
    denied.scopes.remove("project.read");
    assert!(
        query(&host, &denied, "workspace.paths", json!({}))
            .await
            .is_err()
    );
    for arguments in [
        json!({"project_root":"/other"}),
        json!({"protected_paths":[]}),
    ] {
        assert!(
            query(&host, &context, "workspace.paths", arguments)
                .await
                .is_err()
        );
    }
    let record = host.invoke(&context, Invocation {
        client_request_id: "activate-files-metadata".into(), capability: CapabilityRef::new("plugins.activate",1).unwrap(),
        arguments: json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"paths","configuration":{"protected_paths":[]}}), preconditions: vec![],
    }).await.unwrap();
    assert_eq!(
        record.status,
        OperationStatus::Succeeded,
        "{:?}",
        record.error
    );
    let instance = record.output.unwrap()["instance"]["identity"].clone();
    let binding = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":"fixture.read","version":1}}),
    )
    .await
    .unwrap()
    .data
    .unwrap();
    let delegated = query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":binding,"arguments":{"action":"delegate"}}),
    )
    .await
    .unwrap()
    .data
    .unwrap();
    assert_eq!(
        delegated["delegated"]["result"]["data"],
        json!(paths),
        "{delegated}"
    );
    let environment = query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":binding,"arguments":{"action":"environment"}}),
    )
    .await
    .unwrap()
    .data
    .unwrap();
    let environment = environment["environment"].as_object().unwrap();
    assert_eq!(environment.len(), 2);
    assert!(environment.contains_key("project_root") && environment.contains_key("data_root"));
    let released = host
        .invoke(
            &context,
            Invocation {
                client_request_id: "release-files-metadata".into(),
                capability: CapabilityRef::new("plugins.release", 1).unwrap(),
                arguments: json!({"instance":instance}),
                preconditions: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        released.status,
        OperationStatus::Succeeded,
        "{:?}",
        released.error
    );
}
