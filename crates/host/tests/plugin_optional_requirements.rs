use rho_contract::*;
use rho_host::NextHost;
use rho_plugin_protocol::{PluginArchive, PluginViewConnection, PluginViewMessage};
use rho_plugins::{PluginRepository, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn package(path: &Path, weak: bool) -> PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    fs::write(path.join("index.html"), "<!doctype html><p>Optional capabilities</p>").unwrap();
    fs::copy(path.join("index.html"), path.join("dist/index.html")).unwrap();
    fs::write(path.join("BUILD.md"), "Copy index.html to dist/index.html.").unwrap();
    fs::write(path.join("dependencies.lock"), "HTML only; no third-party dependencies.\n").unwrap();
    fs::write(path.join("plugin.json"), serde_json::to_vec(&json!({
        "protocol_version":1,"id":"example.optional","name":"Optional view","version":if weak {"weak"} else {"1"},
        "description":"Independent optional capability fixture","license":"MIT",
        "source":{"files":["index.html"],"lockfiles":["dependencies.lock"],"build_instructions":"BUILD.md","build":null},"dependencies":{},
        "requires":[{"capability":{"id":"operation.get","version":1},"scopes":["operation.read"]}],
        "optional_requires":[{"capability":{"id":"plugins.list","version":1},"scopes":if weak {json!([])} else {json!(["plugins.read"])}},
            {"capability":{"id":"absent.optional","version":1},"scopes":[]}],
        "views":[{"id":"view","title":"Optional view","entrypoint":"dist/index.html","state_schema":{},"configuration_schema":{},"resource_kinds":[]}],
        "capabilities":[],"contexts":[],"backend":null,"configuration_schema":{},"default_configuration":{}
    })).unwrap()).unwrap();
    snapshot_directory(path, None, "ui-web").unwrap()
}
fn invoke(id: &str, capability: &str, arguments: Value) -> Invocation {
    Invocation { client_request_id:id.into(), capability:CapabilityRef::new(capability,1).unwrap(), arguments, preconditions:vec![] }
}
async fn connection(host: &NextHost, view: &Value) -> PluginViewConnection {
    serde_json::from_value(host.query_snapshot(&NextHost::local_context(), QueryRequest {
        capability:CapabilityRef::new("views.connection",1).unwrap(),arguments:json!({"view":view["view"]})
    }).await.unwrap().data.unwrap()).unwrap()
}
fn message(connection: &PluginViewConnection, sequence: u32) -> PluginViewMessage {
    serde_json::from_value(json!({"protocol_version":1,"connection":connection.connection,"view":connection.view.view,
        "sequence":sequence,"request":format!("optional-{sequence}"),"body":{"type":"query","capability":{"id":"plugins.list","version":1},"arguments":{"limit":1}}})).unwrap()
}

#[tokio::test]
async fn optional_selection_is_frozen_at_activation_and_view_delegation_cannot_expand_it() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project"); fs::create_dir(&project).unwrap();
    let db = temp.path().join("state.sqlite");
    let good = package(&temp.path().join("good"), false);
    let weak = package(&temp.path().join("weak"), true);
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&good).unwrap(); repo.import(&weak).unwrap(); drop(repo);
    let host = NextHost::open_project(&db, &project).await.unwrap();
    let context = NextHost::local_context();
    let mut limited = context.clone(); limited.scopes.remove("plugins.read");
    let optional = json!({"id":"plugins.list","version":1});
    let activation = |archive: &PluginArchive, id: &str, choices: Value| invoke(id,"plugins.activate",json!({
        "revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":"ui-web","alias":id,"configuration":{},"optional_capabilities":choices}));
    let mut plain_request = activation(&good,"plain",json!([]));
    plain_request.arguments["configuration"] = json!({"optional_capabilities":[optional.clone()],"scopes":["plugins.read"]});
    let plain = host.invoke(&limited, plain_request).await.unwrap();
    assert_eq!(plain.status,OperationStatus::Succeeded,"{plain:?}");
    assert!(plain.operation.normalized_arguments.get("optional_capabilities").is_none(),
        "the empty default preserves existing normalized activation requests");
    let plain_instance = plain.output.unwrap()["instance"]["identity"].clone();
    let open = |id: &str, instance: &Value| invoke(id,"views.open",json!({"instance":instance,"contribution":"view","window":"optional-window","configuration":{},"state":{}}));
    let plain_view = host.invoke(&limited,open("plain-view",&plain_instance)).await.unwrap().output.unwrap();
    let plain_connection = connection(&host,&plain_view).await;
    assert_eq!(plain_connection.grants,good.revision.manifest.requires);
    assert!(host.dispatch_plugin_view(&context,"optional-window",&plain_connection.call_token,message(&plain_connection,1)).await.is_err(),
        "an available optional capability and a stronger parent do not grant authority after activation");
    for (archive,id,choices) in [
        (&good,"missing",json!([{"id":"absent.optional","version":1}])),
        (&good,"undeclared",json!([{"id":"plugins.instances","version":1}])),
        (&good,"wrong-version",json!([{"id":"plugins.list","version":2}])),
        (&good,"required-as-optional",json!([{"id":"operation.get","version":1}])),
        (&good,"forged-scopes",json!([{"id":"plugins.list","version":1,"scopes":["plugins.read"]}])),
        (&good,"duplicate",json!([optional.clone(),optional.clone()])),
        (&weak,"weak",json!([optional.clone()])),
    ] { assert!(host.invoke(&context,activation(archive,id,choices)).await.is_err(),"{id}"); }
    assert!(host.invoke(&limited,activation(&good,"denied",json!([optional.clone()]))).await.is_err());
    let selected = host.invoke(&context,activation(&good,"selected",json!([optional.clone()]))).await.unwrap();
    assert_eq!(selected.status,OperationStatus::Succeeded,"{selected:?}");
    assert_eq!(selected.operation.normalized_arguments["optional_capabilities"],json!([optional]));
    let selected_instance = selected.output.unwrap()["instance"]["identity"].clone();
    assert!(host.invoke(&limited,open("insufficient-delegation",&selected_instance)).await.is_err());
    let selected_view = host.invoke(&context,open("selected-view",&selected_instance)).await.unwrap().output.unwrap();
    let selected_connection = connection(&host,&selected_view).await;
    assert_eq!(selected_connection.grants.len(),2);
    assert_eq!(selected_connection.grants[1],good.revision.manifest.optional_requires[0]);
    assert!(host.dispatch_plugin_view(&limited,"optional-window",&selected_connection.call_token,message(&selected_connection,1)).await.is_err());
    assert!(host.dispatch_plugin_view(&context,"optional-window",&selected_connection.call_token,message(&selected_connection,2)).await.unwrap()["data"].is_object());
    for (id,view,instance) in [("plain",plain_view,plain_instance),("selected",selected_view,selected_instance)] {
        let closed = host.invoke(&context,invoke(&format!("close-{id}"),"views.close",json!({"view":view["view"],"mode":{"kind":"retain_acknowledged","expected_version":0}}))).await.unwrap();
        assert_eq!(closed.status,OperationStatus::Succeeded);
        let released = host.invoke(&context,invoke(&format!("release-{id}"),"plugins.release",json!({"instance":instance}))).await.unwrap();
        assert_eq!(released.status,OperationStatus::Succeeded);
    }
    host.drain().await;
}
