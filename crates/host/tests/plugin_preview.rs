use rho_contract::*;
use rho_host::{NextHost, OperationError};
use rho_plugin_protocol::{PluginArchive, PluginViewConnection, PluginViewMessage};
use rho_plugins::{PluginRepository, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::fs;
#[path = "fixtures/plugins.rs"]
mod native_fixture;

struct Fixture {
    temp: tempfile::TempDir,
    database: std::path::PathBuf,
    archive: PluginArchive,
    host: NextHost,
    context: CallContext,
}
impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("source");
        fs::create_dir_all(path.join("dist")).unwrap();
        fs::write(path.join("BUILD.md"), "Copy the fixture source into dist.").unwrap();
        fs::write(path.join("deps.lock"), "No dependencies").unwrap();
        fs::write(
            path.join("index.html"),
            "<!doctype html><p>Executable preview 科学</p>",
        )
        .unwrap();
        fs::copy(path.join("index.html"), path.join("dist/index.html")).unwrap();
        // An invalid native binary is deliberate: preview may inspect its package
        // but must not attempt to start it or need the native platform/toolchain.
        fs::write(path.join("backend"), "this backend must never be executed").unwrap();
        fs::copy(path.join("backend"), path.join("dist/backend")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path.join("dist/backend"), fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        fs::write(path.join("plugin.json"), serde_json::to_vec(&json!({
            "protocol_version":1,"id":"example.preview","name":"Preview fixture","version":"1","description":"No native backend may start","license":"MIT",
            "source":{"files":["index.html","backend"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},
            "dependencies":{},"requires":[{"capability":{"id":"fixture.read","version":1},"scopes":["unavailable.scientific.scope"]}],
            "views":[{"id":"view","title":"Fixture","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}],
            "capabilities":[{"capability":{"id":"fixture.read","version":1},"kind":"query","title":"Read fixture","description":"Unavailable native query","input_schema":{"type":"object"},"examples":[{}],"output_schema":{"type":"object"},"recovery_schema":true,"required_scopes":["unavailable.scientific.scope"],"effects":[],"cancellation":"unsupported"}],
            "contexts":[],"backend":{"executable":"dist/backend","arguments":[]},"configuration_schema":{"type":"object"},"default_configuration":{}
        })).unwrap()).unwrap();
        let archive = snapshot_directory(&path, None, "foreign-platform").unwrap();
        let database = temp.path().join("records.sqlite");
        PluginRepository::open(&repository_path(&database))
            .unwrap()
            .import(&archive)
            .unwrap();
        let host = NextHost::open_project(&database, temp.path())
            .await
            .unwrap();
        let context = NextHost::local_context();
        Self {
            temp,
            database,
            archive,
            host,
            context,
        }
    }
    fn args(&self) -> Value {
        json!({"revision":self.archive.revision.id,"artifact":self.archive.artifacts[0].id,"alias":"preview","configuration":{},
            "queries":[{"capability":{"id":"fixture.read","version":1},"arguments":{"offset":0},"data":{"text":"测试 fixture"}}]})
    }
    async fn query(&self, cap: &str, args: Value) -> Value {
        self.host
            .query_snapshot(
                &self.context,
                QueryRequest {
                    capability: CapabilityRef::new(cap, 1).unwrap(),
                    arguments: args,
                },
            )
            .await
            .unwrap()
            .data
            .unwrap()
    }
    async fn invoke(&self, id: &str, cap: &str, args: Value) -> OperationRecord {
        let record = self
            .host
            .invoke(&self.context, invocation(id, cap, args))
            .await
            .unwrap();
        assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
        record
    }
    async fn open(&self, instance: &Value, id: &str) -> Channel {
        let record = self.invoke(id,"views.open",json!({"instance":instance,"contribution":"view","window":"preview-window","configuration":{},"state":{}})).await;
        let view = &record.output.unwrap()["view"];
        Channel {
            connection: serde_json::from_value(
                self.query("views.connection", json!({"view":view})).await,
            )
            .unwrap(),
            sequence: 0,
        }
    }
}
fn invocation(id: &str, cap: &str, args: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(cap, 1).unwrap(),
        arguments: args,
        preconditions: vec![],
    }
}
struct Channel {
    connection: PluginViewConnection,
    sequence: u32,
}
impl Channel {
    fn message(&self, sequence: u32, body: Value) -> PluginViewMessage {
        serde_json::from_value(json!({"protocol_version":1,"connection":self.connection.connection,"view":self.connection.view.view,
            "sequence":sequence,"request":format!("request-{sequence}"),"body":body})).unwrap()
    }
    async fn send(&mut self, h: &Fixture, body: Value) -> Result<Value, OperationError> {
        self.sequence += 1;
        h.host
            .dispatch_plugin_view(
                &h.context,
                self.connection.view.window.as_str(),
                &self.connection.call_token,
                self.message(self.sequence, body),
            )
            .await
    }
}
fn read(offset: u32) -> Value {
    json!({"type":"query","capability":{"id":"fixture.read","version":1},"arguments":{"offset":offset}})
}

#[tokio::test]
async fn exact_artifact_preview_has_no_backend_grants_routes_or_project_queries() {
    let h = Fixture::new().await;
    let mut restricted = h.context.clone();
    restricted.scopes = ["plugins.run".into()].into();
    let request = invocation("preview", "plugins.preview", h.args());
    let started = h.host.invoke(&restricted, request.clone()).await.unwrap();
    assert_eq!(started.status, OperationStatus::Succeeded, "{started:?}");
    assert_eq!(
        json!(h.host.invoke(&restricted, request).await.unwrap()),
        json!(started),
        "original receipt is idempotent"
    );
    let observed = started.output.unwrap();
    assert_eq!(observed["instance"]["purpose"], "fixture_preview");
    assert_eq!(observed["instance"]["state"], "active");
    assert_eq!(observed["process_id"], Value::Null);
    assert_eq!(h.query("plugins.instances", json!({"after":null,"limit":1})).await,
        json!({"instances":[],"next":null,"total":0}), "old runtime readers do not receive new preview records");
    let all = h.query("plugins.instances", json!({"after":null,"limit":1,"include_previews":true})).await;
    assert_eq!(all["instances"][0]["instance"], observed["instance"]);
    assert_eq!(all["total"], 1);
    assert_eq!(all["next"], Value::Null);
    assert!(
        !repository_path(&h.database)
            .join("instance-data-v1")
            .exists(),
        "preview receives no native data/project directory"
    );
    let instance = &observed["instance"]["identity"];
    let mut channel = h.open(instance, "open").await;
    assert!(channel.connection.grants.is_empty());
    assert_eq!(
        channel.connection.view.purpose,
        rho_plugin_protocol::PluginInstancePurpose::FixturePreview
    );
    let asset = h
        .host
        .plugin_view_asset(
            channel.connection.connection.as_str(),
            &channel.connection.asset_token,
            "dist/index.html",
        )
        .unwrap();
    assert_eq!(
        asset.bytes,
        "<!doctype html><p>Executable preview 科学</p>".as_bytes()
    );
    let reply = channel.send(&h, read(0)).await.unwrap();
    assert_eq!(reply["source"], "fixture_preview");
    assert_eq!(reply["data"], json!({"text":"测试 fixture"}));
    assert_eq!(
        channel.send(&h, read(1)).await.unwrap()["status"],
        "unavailable"
    );
    assert_eq!(channel.send(&h,json!({"type":"query","capability":{"id":"plugins.repository","version":1},"arguments":{}})).await.unwrap()["data"],Value::Null);
    assert!(
        h.host
            .query_snapshot(
                &h.context,
                QueryRequest {
                    capability: CapabilityRef::new("fixture.read", 1).unwrap(),
                    arguments: json!({"offset":0})
                }
            )
            .await
            .is_err(),
        "fixture is never a published provider"
    );
    for body in [
        json!({"type":"invoke","request_id":"must-not-run","capability":{"id":"plugins.branch","version":1},"arguments":{"revision":h.archive.revision.id,"name":"forbidden"},"preconditions":[]}),
        json!({"type":"control","capability":{"id":"fixture.control","version":1},"arguments":{}}),
        json!({"type":"get_operation","operation_id":started.operation.operation_id}),
        json!({"type":"cancel","operation_id":started.operation.operation_id}),
        json!({"type":"open_external_url","url":"https://example.org"}),
        json!({"type":"download_resource","reference":{"owner":instance,"resource":"not-real","digest":h.archive.revision.id,"media_type":"text/plain","bytes":0},"filename":"result.txt"}),
    ] {
        assert!(matches!(
            channel.send(&h, body).await,
            Err(OperationError::AccessDenied { .. })
        ));
    }
    assert!(
        h.query(
            "plugins.branches",
            json!({"plugin":h.archive.revision.manifest.id,"after":null,"limit":20})
        )
        .await["branches"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let state = channel
        .send(
            &h,
            json!({"type":"set_state","expected_version":0,"state":{"local":"草稿"}}),
        )
        .await
        .unwrap();
    assert_eq!(state["status"], "succeeded");
    assert_eq!(state["output"]["state"]["local"], "草稿");
    h.invoke("close","views.close",json!({"view":channel.connection.view.view,"mode":{"kind":"retain_acknowledged","expected_version":1}})).await;
    assert!(
        h.host
            .plugin_view_asset(
                channel.connection.connection.as_str(),
                &channel.connection.asset_token,
                "dist/index.html"
            )
            .is_err()
    );
    assert!(channel.send(&h, read(0)).await.is_err());
    let released = h
        .invoke("release", "plugins.release", json!({"instance":instance}))
        .await;
    assert_eq!(released.output.unwrap()["instance"]["state"], "released");
    h.invoke(
        "remove",
        "plugins.remove",
        json!({"revision":h.archive.revision.id}),
    )
    .await;
    h.host.drain().await;
}

#[tokio::test]
async fn preview_rejects_spoofed_identity_replay_and_revoked_parent_authority() {
    let h = Fixture::new().await;
    let output = h
        .invoke("preview", "plugins.preview", h.args())
        .await
        .output
        .unwrap();
    let mut channel = h.open(&output["instance"]["identity"], "open").await;
    let mut foreign = h.context.clone();
    foreign.caller.id = "other-principal".into();
    let hidden = h.host.query_snapshot(&foreign, QueryRequest {
        capability: CapabilityRef::new("plugins.instances", 1).unwrap(),
        arguments: json!({"after":null,"limit":10,"include_previews":true}),
    }).await.unwrap().data.unwrap();
    assert_eq!(hidden, json!({"instances":[],"total":0,"next":null}));
    for (context, window, token) in [
        (
            &foreign,
            "preview-window",
            channel.connection.call_token.as_str(),
        ),
        (
            &h.context,
            "other-window",
            channel.connection.call_token.as_str(),
        ),
        (&h.context, "preview-window", "invalid-token"),
    ] {
        assert!(
            h.host
                .dispatch_plugin_view(context, window, token, channel.message(1, read(0)))
                .await
                .is_err()
        );
    }
    channel.send(&h, read(0)).await.unwrap();
    assert!(
        h.host
            .dispatch_plugin_view(
                &h.context,
                "preview-window",
                &channel.connection.call_token,
                channel.message(1, read(0))
            )
            .await
            .is_err()
    );
    let mut revoked = h.context.clone();
    revoked.scopes.remove("plugins.run");
    assert!(matches!(
        h.host
            .dispatch_plugin_view(
                &revoked,
                "preview-window",
                &channel.connection.call_token,
                channel.message(2, read(0))
            )
            .await,
        Err(OperationError::AccessDenied { .. })
    ));
    assert!(
        h.host
            .plugin_view_asset(
                channel.connection.connection.as_str(),
                &channel.connection.asset_token,
                "backend"
            )
            .is_err(),
        "source files are not preview assets"
    );
    assert!(
        h.host
            .plugin_view_asset(
                channel.connection.connection.as_str(),
                &channel.connection.asset_token,
                "dist/../plugin.json"
            )
            .is_err()
    );
    h.host.drain().await;
}

#[tokio::test]
async fn previews_cannot_satisfy_scenario_runtime_and_live_references_protect_revision() {
    let h = Fixture::new().await;
    let output = h
        .invoke("preview", "plugins.preview", h.args())
        .await
        .output
        .unwrap();
    let instance = &output["instance"]["identity"];
    let channel = h.open(instance, "open").await;
    let artifact = &h.archive.artifacts[0];
    let definition = h.invoke("scene","scenarios.checkpoint",json!({"scenario":"analysis","expected_head":null,"name":"Analysis","instances":{"preview":{
        "plugin":h.archive.revision.manifest.id,"revision":h.archive.revision.id,"artifact":artifact.id,"configuration":{},"dependencies":{},"optional_capabilities":[]
    }},"providers":[],"layout":{"kind":"empty"}})).await.output.unwrap();
    let apply = json!({"window":"preview-window","revision":definition["id"],"expected_layout_version":0,"instances":{"preview":instance},"views":{}});
    assert!(
        h.host
            .query_snapshot(
                &h.context,
                QueryRequest {
                    capability: CapabilityRef::new("scenarios.prepare", 1).unwrap(),
                    arguments: apply.clone()
                }
            )
            .await
            .is_err()
    );
    assert!(
        h.host
            .invoke(&h.context, invocation("apply", "scenarios.apply", apply))
            .await
            .is_err()
    );
    assert_eq!(
        h.query("windows.scenario", json!({"window":"preview-window"}))
            .await["scenario"],
        Value::Null
    );
    let mut repo = PluginRepository::open(&repository_path(&h.database)).unwrap();
    assert!(
        repo.references(&h.archive.revision.id)
            .unwrap()
            .iter()
            .any(|reference| reference.starts_with("view:"))
    );
    assert!(repo.remove(&h.archive.revision.id).is_err());
    let _ = channel;
    h.host.drain().await;
}

#[tokio::test]
async fn invalid_fixture_definitions_are_rejected_before_admission() {
    let h = Fixture::new().await;
    let mut cases = vec![];
    let mut duplicate = h.args();
    let first = duplicate["queries"][0].clone();
    duplicate["queries"].as_array_mut().unwrap().push(first);
    cases.push(duplicate);
    let mut unknown = h.args();
    unknown["queries"][0]["capability"]["id"] = json!("undeclared.read");
    cases.push(unknown);
    let mut mismatch = h.args();
    mismatch["artifact"] = json!(format!("sha256:{}", "a".repeat(64)));
    cases.push(mismatch);
    let mut big = h.args();
    big["queries"][0]["data"]["text"] = json!("a".repeat(256 * 1024));
    cases.push(big);
    let mut invalid_data = h.args();
    invalid_data["queries"][0]["data"] = json!(false);
    cases.push(invalid_data);
    for (index, args) in cases.into_iter().enumerate() {
        assert!(
            h.host
                .invoke(
                    &h.context,
                    invocation(&format!("invalid-{index}"), "plugins.preview", args)
                )
                .await
                .is_err()
        );
    }
    assert!(
        h.query("plugins.instances", json!({"after":null,"limit":20}))
            .await["instances"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    h.host.drain().await;
}

#[tokio::test]
async fn a_preview_contract_cannot_shadow_or_block_a_real_provider() {
    let h = Fixture::new().await;
    let preview = h.invoke("preview", "plugins.preview", h.args()).await.output.unwrap();
    let native = native_fixture::package(&h.temp.path().join("native"), "native", false);
    PluginRepository::open(&repository_path(&h.database)).unwrap().import(&native).unwrap();
    let running = h.invoke("activate", "plugins.activate", json!({
        "revision":native.revision.id,"artifact":native.artifacts[0].id,"target":rho_plugins::backend_target(),"alias":"runtime","configuration":{}
    })).await.output.unwrap();
    assert!(running["instance"].get("purpose").is_none(), "normal instances keep the original native wire shape");
    let normal = h.query("plugins.instances", json!({"after":null,"limit":1})).await;
    assert_eq!(normal["total"], 1);
    assert_eq!(normal["instances"][0]["instance"], running["instance"]);
    assert_eq!(normal["next"], Value::Null);
    let all = h.query("plugins.instances", json!({"after":null,"limit":1,"include_previews":true})).await;
    assert_eq!(all["total"], 2);
    assert!(all["next"].is_string());
    let next = h.query("plugins.instances", json!({"after":all["next"],"limit":1,"include_previews":true})).await;
    assert_eq!(next["total"], 2);
    assert_eq!(next["instances"].as_array().unwrap().len(), 1);
    assert_ne!(next["instances"][0]["instance"]["identity"], all["instances"][0]["instance"]["identity"]);
    assert_eq!(next["next"], Value::Null);
    let binding = h.query("plugins.resolve", json!({"capability":{"id":"fixture.read","version":1},"instance":null})).await;
    assert_eq!(binding["provider"], running["instance"]["identity"]);
    assert_ne!(binding["provider"], preview["instance"]["identity"]);
    let mut channel = h.open(&preview["instance"]["identity"], "open").await;
    assert_eq!(channel.send(&h, read(0)).await.unwrap()["data"]["text"], "测试 fixture");
    h.host.drain().await;
}
