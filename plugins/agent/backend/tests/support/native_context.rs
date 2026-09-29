use super::*;
use rho_agent_owner::{AgentTaskRepository, AgentTaskScope};
use rho_agent_store::AgentStore;

#[tokio::test]
async fn handoff_checks_original_contributed_reference_and_fresh_caller_then_retries_without_reads()
{
    use crate::handoffs::{append, create, operation};
    let factory = Arc::new(Factory::default());
    let mut f = start(factory.clone()).await;
    create(&mut f, "source", "Source document", json!([selection()])).await;
    create(&mut f, "target", "Target draft", json!([])).await;
    let source = f
        .query(
            "agent.handoff.source",
            json!({"source":{"kind":"rho","conversation_id":"source"}}),
        )
        .await;
    let target = json!({"target":{"kind":"rho","conversation_id":"target"},"draft_version":2,"control_generation":null});
    let input = append(&source, &target);
    let mut original_receipt = Value::Null;
    for attempt in 0..3 {
        let native_request = format!("handoff-context-{attempt}");
        let mut native = call(&native_request, "agent.handoff.append", input.clone(), true);
        native.scopes.insert("documents.read".into());
        f.writer
            .send(native.request.clone(), RpcBody::Invoke(native.clone()))
            .await
            .unwrap();
        for (step, capability) in [
            "views.caller",
            "plugins.inspect",
            "editor.context.preview",
            "views.caller",
        ]
        .into_iter()
        .enumerate()
        {
            let frame = f.read().await;
            let RpcBody::HostCall {
                parent_request,
                capability: actual,
                arguments,
            } = frame.body
            else {
                panic!("Expected original handoff read")
            };
            assert_eq!(parent_request, native.request);
            assert_eq!(actual, manifest::key(capability));
            let data = match capability {
                "plugins.inspect" => inspection(),
                "editor.context.preview" => {
                    assert_eq!(arguments["arguments"]["reference"], reference());
                    let mut value = preview();
                    if attempt == 0 {
                        value["item"]["reference"]["selector"]["version"] = json!(8);
                    }
                    value
                }
                _ => {
                    // The last caller read must still be the admitted view.
                    if step == 3 && attempt == 1 {
                        origin("view-two")
                    } else {
                        origin("view-one")
                    }
                }
            };
            f.writer
                .send(
                    frame.request,
                    RpcBody::HostResult {
                        result: json!({"status":"ready","completeness":"complete","data":data}),
                    },
                )
                .await
                .unwrap();
            if attempt == 0 && capability == "editor.context.preview" {
                break;
            }
        }
        let frame = f.read().await;
        assert_eq!(frame.request, native.request);
        let RpcBody::CommitPlan(result) = frame.body else {
            panic!("Expected handoff commit plan")
        };
        assert_eq!(
            result.outcome,
            if attempt < 2 {
                PluginOutcome::Failed
            } else {
                PluginOutcome::Succeeded
            },
            "{result:?}"
        );
        if attempt == 2 {
            original_receipt = result.output.unwrap();
        }
        f.settle(&native, result.outcome).await;
        let draft = f
            .query(
                "agent.model.conversation",
                json!({"conversation_id":"target"}),
            )
            .await;
        assert_eq!(draft["draft_version"], if attempt < 2 { 2 } else { 3 });
        if attempt == 2 {
            assert_eq!(draft["draft_content"]["context"], json!([selection()]));
        }
    }
    // The repeat has no document scope and receives no source/native reads.
    let repeated = operation(
        &mut f,
        "handoff-repeat",
        "agent.handoff.append",
        input,
        "view-one",
    )
    .await;
    assert_eq!(repeated.outcome, PluginOutcome::Succeeded, "{repeated:?}");
    assert_eq!(repeated.output.unwrap(), original_receipt);
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    assert_eq!(factory.sends.load(Ordering::SeqCst), 0);
    f.release().await;
}

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
    manifest["capabilities"] = json!([{"capability":{"id":"editor.context.preview","version":1},"kind":"query","title":"Preview","description":"Exact synchronized source","input_schema":{},"examples":[{"reference":r,"inclusion":{"kind":"selection"},"max_bytes":16384}],"output_schema":{},"recovery_schema":{},"required_scopes":["documents.read"],"effects":[],"cancellation":"unsupported","preflight":null}]);
    let mut search = manifest["capabilities"][0].clone();
    search["capability"]["id"] = json!("editor.context.search");
    search["examples"] = json!([{"window":"source-window","text":"","after":null,"limit":20}]);
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
        &[
            "plugins.inspect",
            "editor.context.preview",
            "resources.read",
        ],
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

async fn rho_input(f: &mut Fixture, model: &SyntheticModel) -> Value {
    f.model_settings(model).await;
    let mut input = f.run_input().await;
    input["sources"] = json!([selection()]);
    let (save, reverse) = f.begin("rho-context-draft", "agent.model.draft", json!({"conversation_id":"task-one","draft_version":1,"content":{"text":input["text"],"assets":[],"context":[selection()]},"grant":null})).await;
    let saved = f.answer(reverse, origin("view-one")).await;
    assert_eq!(saved.outcome, PluginOutcome::Succeeded);
    input["conversation_version"] = saved.output.as_ref().unwrap()["version"].clone();
    f.settle(&save, saved.outcome).await;
    input
}
async fn rho_begin(f: &mut Fixture, input: Value, source_scope: bool) -> PluginCall {
    let mut native = call("captured-context-send", "agent.model.run", input, true);
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

#[tokio::test]
async fn rho_contributed_context_reaches_model_and_survives_reopen_without_source_reads() {
    let mut f = start(Arc::new(Factory::default())).await;
    let model = SyntheticModel::start().await;
    let input = rho_input(&mut f, &model).await;
    let native = rho_begin(&mut f, input.clone(), true).await;
    answer(&mut f, "plugins.inspect", inspection(), true).await;
    let selected = answer(&mut f, "editor.context.preview", preview(), true).await;
    assert_eq!(selected["arguments"]["reference"], reference());
    // A real source read outlives the original caller's millisecond. Admission
    // must consume the revalidated caller at its new synchronous commit time.
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    answer(&mut f, "views.caller", origin("view-one"), true).await;
    model.entered().await;
    let running = f.original_run().await;
    let context = running["context"].clone();
    assert_eq!(context["sources"][0]["text"], preview()["text"]);
    assert_eq!(context["sources"][0]["selection"], selection());
    assert_eq!(context["sources"][0]["native_data"], preview()["data"]);
    let delivered = model.state.bodies.lock().unwrap()[0].to_string();
    assert!(delivered.contains("selected_value <- 42 # 中文 Ω"));
    assert!(delivered.contains("source-window") && delivered.contains("version-seven"));
    let conversation = f
        .query(
            "agent.model.conversation",
            json!({"conversation_id":"task-one"}),
        )
        .await;
    assert_eq!(
        conversation["draft_content"],
        json!({"text":"","context":[],"assets":[]})
    );
    model.state.resume.notify_one();
    let frame = f.read().await;
    assert_eq!(frame.request, native.request);
    let RpcBody::CommitPlan(plan) = frame.body else {
        panic!("{frame:?}")
    };
    assert_eq!(plan.outcome, PluginOutcome::Succeeded, "{plan:?}");
    assert_eq!(plan.output.as_ref().unwrap()["state"], "completed");
    f.settle(&native, plan.outcome).await;
    let (directory, environment) = f.release().await;
    let mut reopened = Fixture::open_with_optional(directory, environment, &[]).await;
    let (retry, reverse) = reopened
        .begin("rho-context-reopened", "agent.model.run", input)
        .await;
    let result = reopened.answer(reverse, origin("view-one")).await;
    assert_eq!(result.outcome, PluginOutcome::Succeeded, "{result:?}");
    assert_eq!(result.output.as_ref().unwrap()["context"], context);
    assert_eq!(model.count(), 1);
    reopened.settle(&retry, result.outcome).await;
    reopened.release().await;
}

#[tokio::test]
async fn rho_contributed_context_refusal_preserves_draft_before_model_admission() {
    for fault in ["truncated", "changed-caller", "version", "scope"] {
        let mut f = start(Arc::new(Factory::default())).await;
        let model = SyntheticModel::start().await;
        let input = rho_input(&mut f, &model).await;
        let before = f
            .query(
                "agent.model.conversation",
                json!({"conversation_id":"task-one"}),
            )
            .await;
        let native = rho_begin(&mut f, input, fault != "scope").await;
        answer(&mut f, "plugins.inspect", inspection(), true).await;
        if fault != "scope" {
            let mut value = preview();
            if fault == "truncated" {
                value["truncated"] = json!(true);
            }
            if fault == "version" {
                value["item"]["reference"]["selector"]["version"] = json!(8);
            }
            answer(&mut f, "editor.context.preview", value, true).await;
            if fault == "changed-caller" {
                answer(&mut f, "views.caller", origin("other-view"), true).await;
            }
        }
        let frame = f.read().await;
        assert_eq!(frame.request, native.request);
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!("{frame:?}")
        };
        assert_eq!(plan.outcome, PluginOutcome::Failed, "{fault}: {plan:?}");
        assert_eq!(
            f.query(
                "agent.model.conversation",
                json!({"conversation_id":"task-one"})
            )
            .await,
            before
        );
        assert_eq!(model.count(), 0);
        f.settle(&native, plan.outcome).await;
        f.release().await;
    }
}

#[tokio::test]
async fn contributed_image_bytes_reach_native_send_and_survive_reopen_without_source_reads() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha256};
    let factory = Arc::new(Factory::default());
    let mut f = start(factory.clone()).await;
    let saved = draft(&mut f).await;
    let input = send(&saved);
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(3, 2, image::Rgb([20, 40, 60]))
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let bytes = bytes.into_inner();
    let resource = json!({"owner":reference()["provider"],"resource":"context-image","digest":format!("sha256:{:x}",Sha256::digest(&bytes)),"bytes":bytes.len(),"media_type":"image/png"});
    let mut native = call(
        "captured-context-send",
        "agent.native.command",
        input.clone(),
        true,
    );
    native
        .scopes
        .extend(["documents.read".into(), "resources.read".into()]);
    f.writer
        .send(native.request.clone(), RpcBody::Invoke(native.clone()))
        .await
        .unwrap();
    answer(&mut f, "views.caller", origin("view-one"), true).await;
    answer(&mut f, "plugins.inspect", inspection(), true).await;
    let mut value = preview();
    value["resources"] = json!([resource]);
    answer(&mut f, "editor.context.preview", value, true).await;
    let requested = answer(
        &mut f,
        "resources.read",
        json!({"reference":resource,"offset":0,"base64":STANDARD.encode(&bytes),"next":null}),
        true,
    )
    .await;
    assert_eq!(requested["reference"], resource);
    assert_eq!(requested["limit"], 65536);
    answer(&mut f, "views.caller", origin("view-one"), true).await;
    let RpcBody::CommitPlan(plan) = f.read().await.body else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Succeeded, "{plan:?}");
    f.settle(&native, plan.outcome).await;
    assert!(factory.inputs.lock().unwrap().iter().flatten().any(|part|matches!(part,NativeInput::Image{mime_type,data} if mime_type=="image/png" && data==&bytes)));
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
    let image = captured.origin.contexts[0].images[0].clone();
    assert_eq!(image.reference, resource);
    assert_eq!(store.agent_context_image(&scope, &image).unwrap(), bytes);
    drop(store);
    let (directory, environment) = f.release().await;
    let mut reopened =
        Fixture::open_with_factory(directory, environment, &[], factory.clone()).await;
    reopened.native_action("image-replay", input).await;
    let retained = reopened
        .query(
            "agent.native.context",
            json!({"request_id":captured.request.request_id}),
        )
        .await;
    assert_eq!(retained["contexts"][0]["images"][0]["reference"], resource);
    assert_eq!(factory.sends.load(Ordering::SeqCst), 1);
    reopened.release().await;
}
