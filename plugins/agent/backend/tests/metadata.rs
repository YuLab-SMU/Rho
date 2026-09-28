use rho_agent_backend::{manifest, server};
use rho_plugin_sdk::{BackendConnection, RpcReader, RpcWriter, protocol::*};
use serde_json::{Value, json};
use tokio::io::{DuplexStream, ReadHalf, WriteHalf};

fn id(value: &str) -> RequestId {
    RequestId::new(value).unwrap()
}
fn instance() -> PluginInstance {
    serde_json::from_value(json!({
        "identity":{"plugin":"org.rho.agent","instance":"agent-one","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},
        "project":"project-one","principal":"principal-one","alias":"agent","configuration":{},"state":"preparing","diagnostic":null
    })).unwrap()
}
fn call(request: &str, cap: &str, arguments: Value, operation: bool) -> PluginCall {
    let instance = instance();
    PluginCall {
        request: id(request),
        binding: ProviderBinding {
            capability: manifest::key(cap),
            provider: instance.identity,
            project: instance.project,
            target: None,
        },
        principal: instance.principal,
        scopes: [
            "application.read".into(),
            "application.control".into(),
            "plugins.read".into(),
        ]
        .into(),
        arguments,
        preconditions: json!([]),
        owner_context: Value::Null,
        operation_id: operation.then(|| format!("operation-{request}")),
    }
}
fn origin(name: &str) -> Value {
    json!({"view":{"view":name,"window":"window-one","connection":format!("connection-{name}")}})
}

struct Fixture {
    directory: tempfile::TempDir,
    environment: BackendEnvironment,
    reader: RpcReader<ReadHalf<DuplexStream>>,
    writer: RpcWriter<WriteHalf<DuplexStream>>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}
impl Fixture {
    async fn start() -> Self {
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
        Self::open(directory, environment).await
    }
    async fn open(directory: tempfile::TempDir, environment: BackendEnvironment) -> Self {
        let (host, backend) = tokio::io::duplex(65536);
        let (input, output) = tokio::io::split(backend);
        let task = tokio::spawn(async move {
            server::serve(
                BackendConnection::accept(input, output)
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .await
        });
        let native = instance();
        let connection = ConnectionId::new("native-channel").unwrap();
        let (input, output) = tokio::io::split(host);
        let mut writer =
            RpcWriter::new(output, native.identity.instance.clone(), connection.clone());
        let reader = RpcReader::new(input, native.identity.instance.clone(), connection);
        writer
            .send(
                id("initialize"),
                RpcBody::Initialize {
                    instance: native,
                    environment: Some(environment.clone()),
                    grants: manifest::manifest().requires,
                    resource_channel: None,
                },
            )
            .await
            .unwrap();
        let mut fixture = Self {
            directory,
            environment,
            reader,
            writer,
            task,
        };
        assert!(matches!(fixture.read().await.body, RpcBody::Ready { .. }));
        fixture
    }
    async fn read(&mut self) -> RpcFrame {
        tokio::time::timeout(std::time::Duration::from_secs(10), self.reader.receive())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    }
    async fn query(&mut self, cap: &str, arguments: Value) -> Value {
        self.writer
            .send(
                id("read"),
                RpcBody::Query(call("read", cap, arguments, false)),
            )
            .await
            .unwrap();
        let response = self.read().await;
        assert_eq!(response.request, id("read"));
        match response.body {
            RpcBody::QueryResult { data, .. } => data,
            other => panic!("{other:?}"),
        }
    }
    async fn begin(
        &mut self,
        request: &str,
        cap: &str,
        arguments: Value,
    ) -> (PluginCall, RpcFrame) {
        let call = call(request, cap, arguments, true);
        self.writer
            .send(call.request.clone(), RpcBody::Invoke(call.clone()))
            .await
            .unwrap();
        let reverse = self.read().await;
        assert_eq!(
            reverse.body,
            RpcBody::HostCall {
                parent_request: call.request.clone(),
                capability: manifest::key("views.caller"),
                arguments: json!({})
            }
        );
        (call, reverse)
    }
    async fn answer(&mut self, reverse: RpcFrame, origin: Value) -> PluginCommitPlan {
        let parent = match &reverse.body {
            RpcBody::HostCall { parent_request, .. } => parent_request.clone(),
            _ => panic!("Expected the original native caller query"),
        };
        self.writer
            .send(
                reverse.request,
                RpcBody::HostResult {
                    result: json!({"status":"ready","completeness":"complete","data":origin}),
                },
            )
            .await
            .unwrap();
        let response = self.read().await;
        assert_eq!(response.request, parent);
        match response.body {
            RpcBody::CommitPlan(plan) => plan,
            other => panic!("{other:?}"),
        }
    }
    async fn settle(&mut self, call: &PluginCall, outcome: PluginOutcome) {
        let settled = OperationSettlement {
            operation_id: OperationId::new(call.operation_id.as_ref().unwrap()).unwrap(),
            binding: call.binding.clone(),
            outcome,
        };
        self.writer
            .send(id("settle"), RpcBody::OperationSettled(settled.clone()))
            .await
            .unwrap();
        assert_eq!(
            self.read().await.body,
            RpcBody::SettlementAcknowledged(settled)
        );
    }
    async fn release(mut self) -> (tempfile::TempDir, BackendEnvironment) {
        self.writer
            .send(id("release"), RpcBody::Release)
            .await
            .unwrap();
        assert_eq!(self.read().await.body, RpcBody::Released);
        self.task.await.unwrap().unwrap();
        (self.directory, self.environment)
    }
}

#[test]
fn manifest_contains_only_public_bounded_metadata_capabilities() {
    let manifest = manifest::manifest();
    manifest.validate().unwrap();
    assert_eq!(manifest.capabilities.len(), 10);
    assert_eq!(
        manifest.requires[0].capability,
        manifest::key("views.caller")
    );
    for contribution in &manifest.capabilities {
        assert_eq!(
            contribution.kind,
            manifest::kind(contribution.capability.id.as_str())
        );
        assert_eq!(contribution.cancellation, CancellationSupport::Unsupported);
        assert_eq!(contribution.input_schema["additionalProperties"], false);
        for name in [
            "project",
            "principal",
            "controller",
            "window",
            "path",
            "credential",
        ] {
            assert!(contribution.input_schema["properties"].get(name).is_none());
        }
    }
    let key = manifest
        .capabilities
        .iter()
        .find(|cap| cap.capability.id.as_str() == "agent.model.key.store")
        .unwrap();
    assert_eq!(key.kind, CapabilityKind::Control);
    assert_eq!(key.input_schema["properties"]["value"]["maxLength"], 16384);
}

#[tokio::test]
async fn metadata_uses_native_origin_cas_and_settlement_without_replaying_on_reopen() {
    let mut f = Fixture::start().await;
    let (create, reverse) = f
        .begin(
            "create",
            "agent.model.create",
            json!({"conversation_id":"task-one","profile":"project"}),
        )
        .await;
    // An outstanding native observation does not block another ordinary read.
    assert_eq!(
        f.query("agent.tasks", json!({"limit":20})).await["tasks"],
        json!([])
    );
    let created = f.answer(reverse, origin("view-one")).await;
    assert_eq!(created.outcome, PluginOutcome::Succeeded);
    assert!(created.facts.is_empty() && created.evidence.is_empty());
    assert_eq!(
        created.output.as_ref().unwrap()["controller"]["incarnation"],
        "view-one:connection-view-one"
    );
    f.writer
        .send(id("early-release"), RpcBody::Release)
        .await
        .unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error { code, .. } if code == "busy"));
    f.settle(&create, PluginOutcome::Succeeded).await;
    f.settle(&create, PluginOutcome::Succeeded).await;
    let draft = json!({"conversation_id":"task-one","draft_version":1,"content":{"text":"研究🙂 unsaved","context":[],"assets":[]},"grant":null});
    let (save, reverse) = f.begin("save", "agent.model.draft", draft.clone()).await;
    let saved = f.answer(reverse, origin("view-one")).await;
    assert_eq!(saved.outcome, PluginOutcome::Succeeded);
    assert_eq!(saved.output.unwrap()["draft_version"], 2);
    f.settle(&save, PluginOutcome::Succeeded).await;
    let (stale, reverse) = f.begin("stale", "agent.model.draft", draft).await;
    assert_eq!(
        f.answer(reverse, origin("view-one")).await.outcome,
        PluginOutcome::Failed
    );
    f.settle(&stale, PluginOutcome::Failed).await;
    let (foreign, reverse) = f
        .begin(
            "foreign-view",
            "agent.model.update",
            json!({"conversation_id":"task-one","expected_version":2,"title":"Wrong view"}),
        )
        .await;
    assert_eq!(
        f.answer(reverse, origin("view-two")).await.outcome,
        PluginOutcome::Failed
    );
    f.settle(&foreign, PluginOutcome::Failed).await;
    let (directory, environment) = f.release().await;
    let mut f = Fixture::open(directory, environment).await;
    let before = f
        .query(
            "agent.model.conversation",
            json!({"conversation_id":"task-one"}),
        )
        .await;
    assert_eq!(before["version"], 2);
    assert_eq!(before["draft"], "研究🙂 unsaved");
    assert_eq!(before["controller"], created.output.unwrap()["controller"]);
    let (takeover, reverse) = f
        .begin(
            "takeover",
            "agent.model.take_control",
            json!({"conversation_id":"task-one","expected_version":2}),
        )
        .await;
    let changed = f.answer(reverse, origin("view-two")).await;
    assert_eq!(changed.outcome, PluginOutcome::Succeeded);
    assert_eq!(changed.output.as_ref().unwrap()["version"], 3);
    assert_eq!(changed.output.unwrap()["draft"], before["draft"]);
    f.settle(&takeover, PluginOutcome::Succeeded).await;
    f.release().await;
}

#[tokio::test]
async fn missing_or_closed_origin_and_forged_arguments_never_create_metadata() {
    let mut f = Fixture::start().await;
    for (request, answer) in [
        ("missing", json!({})),
        ("partial", json!({"view":{"view":"other"}})),
    ] {
        let (call, reverse) = f
            .begin(
                request,
                "agent.model.create",
                json!({"conversation_id":request,"profile":"project"}),
            )
            .await;
        assert_eq!(
            f.answer(reverse, answer).await.outcome,
            PluginOutcome::Failed
        );
        f.settle(&call, PluginOutcome::Failed).await;
    }
    let (closed, reverse) = f
        .begin(
            "closed",
            "agent.model.create",
            json!({"conversation_id":"closed","profile":"project"}),
        )
        .await;
    f.writer
        .send(
            reverse.request,
            RpcBody::Error {
                code: "unavailable".into(),
                message: "Original calling view closed".into(),
                recovery: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        f.read().await.body,
        RpcBody::CommitPlan(PluginCommitPlan {
            outcome: PluginOutcome::Failed,
            ..
        })
    ));
    f.settle(&closed, PluginOutcome::Failed).await;
    let (forged, reverse) = f.begin("forged", "agent.model.create", json!({"conversation_id":"forged","profile":"project","controller":{"window_id":"other","incarnation":"fake"}})).await;
    assert_eq!(
        f.answer(reverse, json!({"view":null})).await.outcome,
        PluginOutcome::Failed
    );
    f.settle(&forged, PluginOutcome::Failed).await;
    for field in ["principal", "scope", "target", "project"] {
        let mut denied = call(
            "denied",
            "agent.model.create",
            json!({"conversation_id":"denied","profile":"project"}),
            true,
        );
        match field {
            "principal" => denied.principal = PrincipalId::new("other").unwrap(),
            "scope" => {
                denied.scopes.remove("application.control");
            }
            "target" => denied.binding.target = Some("forged".into()),
            _ => denied.binding.project = ProjectId::new("other").unwrap(),
        }
        f.writer
            .send(denied.request.clone(), RpcBody::Invoke(denied))
            .await
            .unwrap();
        assert!(matches!(f.read().await.body, RpcBody::Error { .. }));
    }
    assert_eq!(
        f.query("agent.tasks", json!({"limit":20})).await["tasks"],
        json!([])
    );
    f.release().await;
}

#[tokio::test]
async fn disconnect_with_unanswered_origin_preserves_empty_store_and_never_replays() {
    let mut f = Fixture::start().await;
    f.begin(
        "unconfirmed",
        "agent.model.create",
        json!({"conversation_id":"unconfirmed","profile":"project"}),
    )
    .await;
    let Fixture {
        directory,
        environment,
        reader,
        writer,
        task,
    } = f;
    drop(reader);
    drop(writer);
    task.await.unwrap().unwrap();
    let mut reopened = Fixture::open(directory, environment).await;
    assert_eq!(
        reopened.query("agent.tasks", json!({"limit":20})).await["tasks"],
        json!([])
    );
    reopened.release().await;
}

#[tokio::test]
async fn bounded_concurrent_calls_keep_each_origin_and_refuse_original_operation_replay() {
    let mut f = Fixture::start().await;
    let mut pending = vec![];
    for index in 0..16 {
        pending.push(
            f.begin(
                &format!("create-{index}"),
                "agent.model.create",
                json!({"conversation_id":format!("task-{index}"),"profile":"project"}),
            )
            .await,
        );
    }
    let excess = call(
        "excess",
        "agent.model.create",
        json!({"conversation_id":"excess","profile":"project"}),
        true,
    );
    f.writer
        .send(excess.request.clone(), RpcBody::Invoke(excess.clone()))
        .await
        .unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error { code, .. } if code == "busy"));
    // Even a rejected native admission has an original terminal Host record.
    f.settle(&excess, PluginOutcome::Failed).await;
    let duplicate = pending[0].0.clone();
    for (call, reverse) in pending.into_iter().rev() {
        let name = call.request.to_string();
        let plan = f.answer(reverse, origin(&name)).await;
        assert_eq!(plan.outcome, PluginOutcome::Succeeded);
        assert_eq!(
            plan.output.unwrap()["controller"]["incarnation"],
            format!("{name}:connection-{name}")
        );
        f.settle(&call, PluginOutcome::Succeeded).await;
    }
    f.writer
        .send(duplicate.request.clone(), RpcBody::Invoke(duplicate))
        .await
        .unwrap();
    let Fixture {
        directory,
        environment,
        mut reader,
        writer,
        task,
    } = f;
    assert!(reader.receive().await.unwrap().is_none());
    assert!(
        task.await
            .unwrap()
            .unwrap_err()
            .contains("dispatched twice")
    );
    drop(reader);
    drop(writer);
    let mut reopened = Fixture::open(directory, environment).await;
    assert_eq!(
        reopened.query("agent.tasks", json!({"limit":20})).await["tasks"]
            .as_array()
            .unwrap()
            .len(),
        16
    );
    reopened.release().await;
}

#[tokio::test]
async fn model_settings_use_scoped_owner_cas_without_reading_keys_or_contacting_a_model() {
    let mut f = Fixture::start().await;
    let before = f.query("agent.model.settings", json!({})).await;
    let settings = json!({"version":before["version"],"enabled":true,"connection":{
        "protocol":"openai_completions","base_url":"https://model.invalid/v1","model":"fixture-only",
        "credential":{"kind":"environment","name":"RHO_AGENT_FIXTURE_UNUSED_KEY"}
    }});
    let (first, reverse) = f
        .begin("configure", "agent.model.configure", settings.clone())
        .await;
    let changed = f.answer(reverse, origin("view-one")).await;
    assert_eq!(
        changed.outcome,
        PluginOutcome::Succeeded,
        "{:?}",
        changed.error
    );
    assert!(changed.facts.is_empty() && changed.evidence.is_empty());
    let saved = changed.output.unwrap();
    assert_eq!(saved["version"], before["version"].as_u64().unwrap() + 1);
    f.settle(&first, PluginOutcome::Succeeded).await;
    let (stale, reverse) = f
        .begin("stale-settings", "agent.model.configure", settings)
        .await;
    assert_eq!(
        f.answer(reverse, origin("view-two")).await.outcome,
        PluginOutcome::Failed
    );
    f.settle(&stale, PluginOutcome::Failed).await;
    for (name, value) in [
        (
            "no-model",
            json!({"version":saved["version"],"enabled":true,"connection":null}),
        ),
        ("secret", {
            let mut value = saved.clone();
            value["connection"]["api_key"] = json!("never-persist-this-secret");
            value
        }),
        ("bad-endpoint", {
            let mut value = saved.clone();
            value["connection"]["base_url"] = json!("https://user:secret@model.invalid/v1");
            value
        }),
    ] {
        let (call, reverse) = f.begin(name, "agent.model.configure", value).await;
        let rejected = f.answer(reverse, origin("view-one")).await;
        assert_eq!(rejected.outcome, PluginOutcome::Failed, "{name}");
        assert!(
            !serde_json::to_string(&rejected)
                .unwrap()
                .contains("never-persist-this-secret")
        );
        f.settle(&call, PluginOutcome::Failed).await;
        assert_eq!(f.query("agent.model.settings", json!({})).await, saved);
    }
    let (directory, environment) = f.release().await;
    let mut reopened = Fixture::open(directory, environment).await;
    assert_eq!(
        reopened.query("agent.model.settings", json!({})).await,
        saved
    );
    let mut independent = Fixture::start().await;
    assert_eq!(
        independent.query("agent.model.settings", json!({})).await,
        before
    );
    independent.release().await;
    reopened.release().await;
}

impl Fixture {
    async fn begin_control(&mut self, request: &str, arguments: Value) -> RpcFrame {
        let call = call(request, "agent.model.key.store", arguments, false);
        self.writer
            .send(call.request.clone(), RpcBody::Control(call))
            .await
            .unwrap();
        let reverse = self.read().await;
        assert_eq!(
            reverse.body,
            RpcBody::HostCall {
                parent_request: id(request),
                capability: manifest::key("views.caller"),
                arguments: json!({})
            }
        );
        reverse
    }
    async fn control_answer(&mut self, reverse: RpcFrame, origin: Value) -> RpcBody {
        let parent = match reverse.body {
            RpcBody::HostCall { parent_request, .. } => parent_request,
            _ => panic!("Expected original caller observation"),
        };
        self.writer
            .send(
                reverse.request,
                RpcBody::HostResult {
                    result: json!({"status":"ready","completeness":"complete","data":origin}),
                },
            )
            .await
            .unwrap();
        let result = self.read().await;
        assert_eq!(result.request, parent);
        result.body
    }
}

#[tokio::test]
async fn key_controls_recover_original_references_without_operations_or_secret_metadata() {
    let mut f = Fixture::start().await;
    let secret = "test-only-key-29c13";
    let args = json!({"request_id":"original-key","value":secret});
    let reverse = f.begin_control("key-write", args.clone()).await;
    let path = std::path::Path::new(&f.environment.data_root).join("model-credentials-v1.json");
    assert!(!path.exists());
    f.writer
        .send(id("busy-release"), RpcBody::Release)
        .await
        .unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error { code, .. } if code == "busy"));
    f.writer.send(reverse.request, RpcBody::HostResult {
        result: json!({"status":"ready","completeness":"complete","data":origin("view-one")})
    }).await.unwrap();
    // Ignore the original Control result. A later query, not another write,
    // discovers the reference even if observation races with the atomic write.
    let reference = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut ignored_reply = false;
        for sequence in 0..100 {
            let request = format!("receipt-{sequence}");
            f.writer
                .send(
                    id(&request),
                    RpcBody::Query(call(
                        &request,
                        "agent.model.key.receipt",
                        json!({"request_id":"original-key"}),
                        false,
                    )),
                )
                .await
                .unwrap();
            loop {
                let reply = f.read().await;
                if reply.request == id("key-write") {
                    assert!(matches!(&reply.body, RpcBody::ControlResult { .. }));
                    assert!(!serde_json::to_string(&reply).unwrap().contains(secret));
                    ignored_reply = true;
                    continue;
                }
                assert_eq!(reply.request, id(&request));
                let RpcBody::QueryResult {
                    data, completeness, ..
                } = reply.body
                else {
                    panic!()
                };
                if data["credential"].is_null() {
                    assert_eq!(completeness, ObservationCompleteness::Partial);
                    break;
                }
                assert_eq!(completeness, ObservationCompleteness::Complete);
                assert_eq!(data["available"], true);
                if !ignored_reply {
                    let reply = f.read().await;
                    assert_eq!(reply.request, id("key-write"));
                    assert!(matches!(&reply.body, RpcBody::ControlResult { .. }));
                    assert!(!serde_json::to_string(&reply).unwrap().contains(secret));
                }
                return data["credential"].clone();
            }
            tokio::task::yield_now().await;
        }
        panic!("Original key receipt was not observed");
    })
    .await
    .unwrap();
    let before = std::fs::read(&path).unwrap();
    let reverse = f.begin_control("repeat-key", args.clone()).await;
    let repeated = f.control_answer(reverse, origin("view-one")).await;
    assert_eq!(
        repeated,
        RpcBody::ControlResult {
            data: reference.clone()
        }
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let reverse = f
        .begin_control(
            "changed-key",
            json!({"request_id":"original-key","value":"different-test-key"}),
        )
        .await;
    assert!(
        matches!(f.control_answer(reverse, origin("view-one")).await, RpcBody::Error { code, .. } if code == "request_conflict")
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        f.query("agent.tasks", json!({"limit":20})).await["tasks"],
        json!([])
    );
    for entry in std::fs::read_dir(&f.environment.data_root).unwrap() {
        let entry = entry.unwrap();
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("agent-v1.sqlite")
        {
            assert!(
                !String::from_utf8_lossy(&std::fs::read(entry.path()).unwrap()).contains(secret)
            );
        }
    }
    let (directory, environment) = f.release().await;
    let mut reopened = Fixture::open(directory, environment).await;
    assert_eq!(
        reopened
            .query(
                "agent.model.key.receipt",
                json!({"request_id":"original-key"})
            )
            .await,
        json!({"credential":reference,"available":true})
    );
    let reverse = reopened.begin_control("after-reopen", args).await;
    assert_eq!(
        reopened.control_answer(reverse, origin("view-one")).await,
        RpcBody::ControlResult { data: reference }
    );
    reopened.release().await;
}

#[tokio::test]
async fn key_input_requires_control_kind_native_identity_scope_and_complete_origin() {
    let mut f = Fixture::start().await;
    let args = json!({"request_id":"original-key","value":"test-only-key-44"});
    for variant in ["query", "invoke", "principal", "scope", "operation"] {
        let mut native = call(
            variant,
            "agent.model.key.store",
            args.clone(),
            variant == "invoke",
        );
        match variant {
            "principal" => native.principal = PrincipalId::new("foreign").unwrap(),
            "scope" => {
                native.scopes.remove("application.control");
            }
            "operation" => native.operation_id = Some("forged-operation".into()),
            _ => {}
        }
        let body = match variant {
            "query" => RpcBody::Query(native),
            "invoke" => RpcBody::Invoke(native),
            _ => RpcBody::Control(native),
        };
        f.writer.send(id(variant), body).await.unwrap();
        let reply = f.read().await;
        assert_eq!(reply.request, id(variant));
        assert!(matches!(reply.body, RpcBody::Error { .. }));
    }
    let reverse = f
        .begin_control(
            "forged-path",
            json!({"request_id":"original-key","value":"test-only-key-44","path":"/forged"}),
        )
        .await;
    assert!(matches!(
        f.control_answer(reverse, origin("view-one")).await,
        RpcBody::Error { .. }
    ));
    let reverse = f.begin_control("closed-view", args).await;
    f.writer.send(reverse.request, RpcBody::HostResult {
        result: json!({"status":"unavailable","completeness":"partial","data":{"view":null}})
    }).await.unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error { .. }));
    assert!(
        !std::path::Path::new(&f.environment.data_root)
            .join("model-credentials-v1.json")
            .exists()
    );
    f.release().await;
}

#[tokio::test]
async fn disconnect_before_key_admission_never_writes_or_replays_on_reopen() {
    let mut f = Fixture::start().await;
    f.begin_control(
        "unanswered-key",
        json!({"request_id":"original-key","value":"never-stored-key"}),
    )
    .await;
    let Fixture {
        directory,
        environment,
        reader,
        writer,
        task,
    } = f;
    drop(reader);
    drop(writer);
    task.await.unwrap().unwrap();
    assert!(
        !std::path::Path::new(&environment.data_root)
            .join("model-credentials-v1.json")
            .exists()
    );
    let mut reopened = Fixture::open(directory, environment).await;
    reopened
        .writer
        .send(
            id("original-receipt"),
            RpcBody::Query(call(
                "original-receipt",
                "agent.model.key.receipt",
                json!({"request_id":"original-key"}),
                false,
            )),
        )
        .await
        .unwrap();
    let result = reopened.read().await;
    assert!(matches!(
        result.body,
        RpcBody::QueryResult {
            completeness: ObservationCompleteness::Partial,
            ..
        }
    ));
    assert!(
        !std::path::Path::new(&reopened.environment.data_root)
            .join("model-credentials-v1.json")
            .exists()
    );
    reopened.release().await;
}

#[tokio::test]
async fn controls_and_operations_share_capacity_without_sharing_settlement() {
    let mut f = Fixture::start().await;
    let mut operations = Vec::new();
    for index in 0..16 {
        let request = format!("mixed-{index}");
        if index % 2 == 0 {
            let native = call(
                &request,
                "agent.model.create",
                json!({"conversation_id":format!("task-{index}"),"profile":"project"}),
                true,
            );
            operations.push(native.clone());
            f.writer
                .send(id(&request), RpcBody::Invoke(native))
                .await
                .unwrap();
        } else {
            f.writer
                .send(
                    id(&request),
                    RpcBody::Control(call(
                        &request,
                        "agent.model.key.store",
                        json!({"request_id":request,"value":format!("fixture-key-{index}")}),
                        false,
                    )),
                )
                .await
                .unwrap();
        }
    }
    let mut reverse = Vec::new();
    for _ in 0..16 {
        let frame = f.read().await;
        assert!(matches!(frame.body, RpcBody::HostCall { .. }));
        reverse.push(frame);
    }
    f.writer
        .send(
            id("too-many"),
            RpcBody::Control(call(
                "too-many",
                "agent.model.key.store",
                json!({"request_id":"overflow","value":"never-admitted"}),
                false,
            )),
        )
        .await
        .unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error { code, .. } if code == "busy"));
    for frame in reverse.into_iter().rev() {
        f.writer.send(frame.request, RpcBody::HostResult {
            result: json!({"status":"ready","completeness":"complete","data":origin("view-one")})
        }).await.unwrap();
    }
    let mut control_results = 0;
    let mut operation_results = 0;
    for _ in 0..16 {
        match f.read().await.body {
            RpcBody::ControlResult { data } => {
                assert_eq!(data["kind"], "local_file");
                control_results += 1;
            }
            RpcBody::CommitPlan(plan) => {
                assert_eq!(plan.outcome, PluginOutcome::Succeeded);
                operation_results += 1;
            }
            other => panic!("{other:?}"),
        }
    }
    assert_eq!((control_results, operation_results), (8, 8));
    f.writer
        .send(id("before-settlement"), RpcBody::Release)
        .await
        .unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error { code, .. } if code == "busy"));
    for native in operations {
        f.settle(&native, PluginOutcome::Succeeded).await;
    }
    f.release().await;
}
