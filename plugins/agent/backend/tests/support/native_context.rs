use super::*;
use rho_agent_owner::{AgentTaskRepository, AgentTaskScope};
use rho_agent_store::AgentStore;

fn reference() -> Value {
    json!({"provider":{"plugin":"org.rho.editor","instance":"editor-one","revision":format!("sha256:{}","c".repeat(64)),"artifact":format!("sha256:{}","d".repeat(64))},"contribution":"documents","window":"source-window","selector":{"draft":"draft-one","version":7,"digest":format!("sha256:{}","e".repeat(64))}})
}
fn selection() -> Value {
    json!({"source":"plugin","label":"Captured document","reference":reference(),"inclusion":"{\"kind\":\"selection\"}"})
}
fn inspection() -> Value {
    let r = reference();
    let mut manifest = json!(manifest::manifest());
    manifest["id"] = r["provider"]["plugin"].clone();
    manifest["contexts"] = json!([{"id":"documents","title":"Editor documents","search":{"id":"editor.context.search","version":1},"preview":{"id":"editor.context.preview","version":1}}]);
    manifest["capabilities"] = json!([{"capability":{"id":"editor.context.preview","version":1},"kind":"query","title":"Preview","description":"Exact synchronized source","input_schema":{},"examples":[],"output_schema":{},"recovery_schema":{},"required_scopes":["documents.read"],"effects":[],"cancellation":"unsupported","preflight":null}]);
    let mut search = manifest["capabilities"][0].clone();
    search["capability"]["id"] = json!("editor.context.search");
    manifest["capabilities"]
        .as_array_mut()
        .unwrap()
        .push(search);
    manifest["requires"] = json!([]);
    manifest["optional_requires"] = json!([]);
    manifest["views"] = json!([]);
    serde_json::from_value::<PluginManifest>(manifest.clone())
        .unwrap()
        .validate()
        .unwrap();
    json!({"summary":{"revision":r["provider"]["revision"],"plugin":r["provider"]["plugin"],"name":"Editor","version":"1","description":"Source owner","artifacts":[r["provider"]["artifact"]],"reference_count":0},"manifest":manifest,"parent":null,"source_file_count":1,"artifacts":[{"id":r["provider"]["artifact"],"target":"fixture","file_count":1}]})
}
fn preview() -> Value {
    json!({"item":{"reference":reference(),"title":"analysis.R · selection","description":"Synchronized version 7","kind":"document"},"text":"selected_value <- 42 # 中文 Ω","truncated":false,"data":{"document_version":"version-seven","inclusion":"selection"},"resources":[]})
}
async fn start(factory: Arc<Factory>) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let project = root.join("project");
    let data = root.join("instance");
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&data).unwrap();
    let environment = BackendEnvironment {
        project_root: project.to_str().unwrap().into(),
        data_root: data.to_str().unwrap().into(),
    };
    Fixture::open_with_factory(
        directory,
        environment,
        &["plugins.inspect", "editor.context.preview"],
        factory,
    )
    .await
}
async fn answer(f: &mut Fixture, cap: &str, data: Value, complete: bool) -> Value {
    let frame = f.read().await;
    let RpcBody::HostCall {
        capability,
        arguments,
        parent_request,
    } = frame.body
    else {
        panic!("Expected context Host read")
    };
    assert_eq!(capability, manifest::key(cap));
    assert_eq!(parent_request, id("captured-context-send"));
    f.writer.send(frame.request, RpcBody::HostResult { result:json!({"status":"ready","completeness":if complete {"complete"} else {"partial"},"data":data}) }).await.unwrap();
    arguments
}
async fn begin(f: &mut Fixture, input: Value, source_scope: bool) -> PluginCall {
    let mut native = call("captured-context-send", "agent.native.command", input, true);
    if source_scope {
        native.scopes.insert("documents.read".into());
    }
    f.writer
        .send(native.request.clone(), RpcBody::Invoke(native.clone()))
        .await
        .unwrap();
    answer(f, "views.caller", origin("view-one"), true).await;
    native
}
async fn draft(f: &mut Fixture) -> Value {
    let created = f.native_create().await;
    f.native_action("selected-context-draft", action(json!({"kind":"save_draft","control":control(&created),"version":0,"content":{"text":"Explain the selected source","assets":[],"context":[selection()]}}))).await
}
fn send(saved: &Value) -> Value {
    action(
        json!({"kind":"send","control":control(saved),"draft_version":saved["detail"]["draft"]["version"]}),
    )
}

#[tokio::test]
async fn contributed_context_retains_exact_source_before_send_and_never_rereads_on_replay() {
    let factory = Arc::new(Factory::default());
    let mut f = start(factory.clone()).await;
    let saved = draft(&mut f).await;
    let input = send(&saved);
    let native = begin(&mut f, input.clone(), true).await;
    let args = answer(&mut f, "plugins.inspect", inspection(), true).await;
    assert_eq!(args["revision"], reference()["provider"]["revision"]);
    let args = answer(&mut f, "editor.context.preview", preview(), true).await;
    assert_eq!(args["binding"]["provider"], reference()["provider"]);
    assert_eq!(args["arguments"]["reference"], reference());
    assert_eq!(args["arguments"]["inclusion"], json!({"kind":"selection"}));
    assert_eq!(args["arguments"]["max_bytes"], 16384);
    answer(&mut f, "views.caller", origin("view-one"), true).await;
    let response = f.read().await;
    assert_eq!(response.request, native.request);
    let RpcBody::CommitPlan(plan) = response.body else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Succeeded, "{plan:?}");
    f.settle(&native, plan.outcome).await;
    assert_eq!(factory.sends.load(Ordering::SeqCst), 1);
    let delivered = factory
        .inputs
        .lock()
        .unwrap()
        .iter()
        .flatten()
        .filter_map(|part| match part {
            NativeInput::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        delivered.contains("selected_value <- 42 # 中文 Ω"),
        "{delivered}"
    );
    assert!(delivered.contains("source-window") && delivered.contains("version-seven"));
    let store =
        AgentStore::open(&std::path::Path::new(&f.environment.data_root).join("agent-v1.sqlite"))
            .unwrap();
    let scope = AgentTaskScope {
        project: f.environment.project_root.clone(),
        principal: instance().principal.to_string(),
    };
    let captured = store
        .agent_native_admission(&scope, input["request_id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        captured.origin.contexts[0].text,
        preview()["text"].as_str().unwrap()
    );
    assert_eq!(captured.origin.contexts[0].selection.reference, reference());
    assert!(captured.origin.tools.is_empty());
    drop(store);
    let (directory, environment) = f.release().await;
    let mut reopened =
        Fixture::open_with_factory(directory, environment, &[], factory.clone()).await;
    // No source grants in this new process: replay must only read original bytes.
    let observed = reopened.native_action("context-replay", input).await;
    assert_eq!(
        observed["receipt"]["request_id"],
        captured.request.request_id
    );
    let retained = reopened
        .query(
            "agent.native.context",
            json!({"request_id":captured.request.request_id}),
        )
        .await;
    assert_eq!(retained["contexts"][0]["text"], preview()["text"]);
    assert_eq!(
        retained["contexts"][0]["selection"]["reference"],
        reference()
    );
    assert_eq!(factory.sends.load(Ordering::SeqCst), 1);
    reopened.release().await;
}

#[tokio::test]
async fn contributed_context_refuses_changed_partial_oversized_or_foreign_sources_before_admission()
{
    for fault in [
        "manifest",
        "reference",
        "partial",
        "truncated",
        "oversized",
        "caller",
        "scope",
        "resource",
    ] {
        let factory = Arc::new(Factory::default());
        let mut f = start(factory.clone()).await;
        let saved = draft(&mut f).await;
        let input = send(&saved);
        let native = begin(&mut f, input.clone(), fault != "scope").await;
        let mut inspected = inspection();
        if fault == "manifest" {
            inspected["manifest"]["id"] = json!("org.wrong.source");
        }
        answer(&mut f, "plugins.inspect", inspected, true).await;
        if !matches!(fault, "manifest" | "scope") {
            let mut value = preview();
            match fault {
                "reference" => value["item"]["reference"]["selector"]["version"] = json!(8),
                "truncated" => value["truncated"] = json!(true),
                "oversized" => value["text"] = json!("x".repeat(16385)),
                "resource" => {
                    value["resources"] = json!([{"owner":reference()["provider"],"resource":"source-image","digest":format!("sha256:{}","f".repeat(64)),"media_type":"image/png","bytes":12}])
                }
                _ => (),
            }
            answer(&mut f, "editor.context.preview", value, fault != "partial").await;
            if fault == "caller" {
                answer(&mut f, "views.caller", origin("another-view"), true).await;
            }
        }
        let frame = f.read().await;
        assert_eq!(frame.request, native.request);
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!()
        };
        assert_eq!(plan.outcome, PluginOutcome::Failed, "{fault}: {plan:?}");
        f.settle(&native, plan.outcome).await;
        let current = f
            .query(
                "agent.native.task",
                json!({"task_id":saved["detail"]["summary"]["task"]["task_id"]}),
            )
            .await;
        assert_eq!(current["draft"], saved["detail"]["draft"], "{fault}");
        assert_eq!(factory.opens.load(Ordering::SeqCst), 0, "{fault}");
        assert_eq!(factory.sends.load(Ordering::SeqCst), 0, "{fault}");
        f.release().await;
    }
}
