//! Production framed backend with deterministic public source peers. This is not
//! acceptance against a real Editor/R provider or an installed Host package.
use crate::{manifest, server};
use rho_plugin_sdk::{BackendConnection, RpcReader, RpcWriter, protocol::*};
use serde_json::{Value, json};
use tokio::io::{DuplexStream, ReadHalf, WriteHalf};
fn id(value: &str) -> RequestId {
    RequestId::new(value).unwrap()
}
fn instance() -> PluginInstance {
    serde_json::from_value(json!({"identity":{"plugin":"org.rho.annotations","instance":"notes-one","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},"project":"project-one","principal":"principal-one","alias":"notes","configuration":{},"state":"preparing","diagnostic":null})).unwrap()
}
fn call(request: &str, cap: &str, arguments: Value) -> PluginCall {
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
            "application.read",
            "application.control",
            "plugins.read",
            "documents.read",
            "resources.read",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        arguments,
        preconditions: Value::Null,
        owner_context: Value::Null,
        operation_id: (manifest::is_operation(cap) == Some(true))
            .then(|| format!("operation-{request}")),
    }
}
fn reference() -> Value {
    json!({"provider":{"plugin":"org.rho.editor","instance":"editor-one","revision":format!("sha256:{}","c".repeat(64)),"artifact":format!("sha256:{}","d".repeat(64))},"contribution":"documents","window":"window-one","selector":{"draft":"draft-one","version":7,"digest":format!("sha256:{}","e".repeat(64))}})
}
fn origin() -> Value {
    json!({"view":{"view":"caller-one","window":"window-one","connection":"connection-one"}})
}
fn inspection() -> Value {
    let r = reference();
    let mut manifest = json!(manifest::manifest());
    manifest["id"] = r["provider"]["plugin"].clone();
    let mut preview = manifest["capabilities"][3].clone();
    preview["capability"]["id"] = json!("editor.context.preview");
    preview["required_scopes"] = json!(["documents.read"]);
    preview["input_schema"] = json!({});
    preview["examples"] = json!([{}]);
    let mut search = preview.clone();
    search["capability"]["id"] = json!("editor.context.search");
    manifest["capabilities"] = json!([search, preview]);
    manifest["contexts"] = json!([{"id":"documents","title":"Documents","search":{"id":"editor.context.search","version":1},"preview":{"id":"editor.context.preview","version":1}}]);
    manifest["requires"] = json!([]);
    manifest["optional_requires"] = json!([]);
    serde_json::from_value::<PluginManifest>(manifest.clone())
        .unwrap()
        .validate()
        .unwrap();
    json!({"summary":{"revision":r["provider"]["revision"],"plugin":r["provider"]["plugin"],"name":"Editor","version":"1","description":"Source owner","artifacts":[r["provider"]["artifact"]],"reference_count":0},"manifest":manifest,"parent":null,"source_file_count":1,"artifacts":[{"id":r["provider"]["artifact"],"target":"fixture","file_count":1}]})
}
fn source() -> Value {
    json!({"item":{"reference":reference(),"title":"研究.R","description":"Synchronized draft","kind":"text"},"text":"a🧬中z","truncated":false,"data":{"annotation_source":{"source_id":"draft-one","source_version":"content-v1"}},"resources":[]})
}
fn freeze(request: &str) -> Value {
    json!({"request_id":request,"command":{"kind":"freeze","reference":reference(),"inclusion":{"kind":"document"},"anchor":{"kind":"text_quote","quote":"🧬中","start":1,"end":4,"unit":"utf16"}}})
}
struct Fixture {
    directory: tempfile::TempDir,
    environment: BackendEnvironment,
    reader: RpcReader<ReadHalf<DuplexStream>>,
    writer: RpcWriter<WriteHalf<DuplexStream>>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let project = root.join("project");
        let data = root.join("instance");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&data).unwrap();
        Self::open(
            directory,
            BackendEnvironment {
                project_root: project.to_str().unwrap().into(),
                data_root: data.to_str().unwrap().into(),
            },
        )
        .await
    }
    async fn open(directory: tempfile::TempDir, environment: BackendEnvironment) -> Self {
        let (native, peer) = tokio::io::duplex(512 * 1024);
        let (nr, nw) = tokio::io::split(native);
        let (pr, pw) = tokio::io::split(peer);
        let instance = instance();
        let connection = ConnectionId::new("connection-fixture").unwrap();
        let mut writer = RpcWriter::new(pw, instance.identity.instance.clone(), connection.clone());
        let reader = RpcReader::new(pr, instance.identity.instance.clone(), connection);
        let task = tokio::spawn(async move {
            server::serve(BackendConnection::accept(nr, nw).await.unwrap()).await
        });
        let mut grants = manifest::manifest().requires;
        grants.push(CapabilityRequirement {
            capability: manifest::key("editor.context.preview"),
            scopes: ["documents.read".into()].into(),
        });
        grants.push(CapabilityRequirement {
            capability: manifest::key("resources.read"),
            scopes: ["resources.read".into()].into(),
        });
        writer
            .send(
                id("initialize"),
                RpcBody::Initialize {
                    instance,
                    grants,
                    environment: Some(environment.clone()),
                    resource_channel: None,
                },
            )
            .await
            .unwrap();
        let mut f = Self {
            directory,
            environment,
            reader,
            writer,
            task,
        };
        assert!(matches!(f.next().await.body, RpcBody::Ready { .. }));
        f
    }
    async fn next(&mut self) -> RpcFrame {
        tokio::time::timeout(std::time::Duration::from_secs(3), self.reader.receive())
            .await
            .expect("bounded frame wait")
            .unwrap()
            .unwrap()
    }
    async fn perform(
        &mut self,
        call: PluginCall,
        replies: Vec<(&str, Value)>,
        settle: bool,
    ) -> RpcBody {
        let operation = call.operation_id.clone();
        let binding = call.binding.clone();
        let request = call.request.clone();
        self.writer
            .send(
                request.clone(),
                if operation.is_some() {
                    RpcBody::Invoke(call)
                } else {
                    RpcBody::Query(call)
                },
            )
            .await
            .unwrap();
        for (expected, data) in replies {
            let frame = self.next().await;
            let RpcBody::HostCall {
                parent_request,
                capability,
                arguments,
            } = frame.body
            else {
                panic!("expected {expected}, got {:?}", frame.body)
            };
            assert_eq!(parent_request, request);
            assert_eq!(capability.id.as_str(), expected);
            if expected == "editor.context.preview" {
                assert_eq!(arguments["binding"]["provider"], reference()["provider"]);
                assert_eq!(arguments["arguments"]["reference"], reference());
            }
            if expected == "resources.read" {
                assert_eq!(arguments["reference"], data["reference"]);
                assert_eq!(arguments["offset"], data["offset"]);
                assert_eq!(arguments["limit"], 65536);
            }
            self.writer
                .send(
                    frame.request,
                    RpcBody::HostResult {
                        result: json!({"status":"ready","completeness":"complete","data":data}),
                    },
                )
                .await
                .unwrap();
        }
        let frame = self.next().await;
        assert_eq!(frame.request, request);
        if settle {
            let RpcBody::CommitPlan(plan) = &frame.body else {
                panic!("expected commit plan")
            };
            let settlement = OperationSettlement {
                operation_id: OperationId::new(operation.unwrap()).unwrap(),
                binding,
                outcome: plan.outcome,
            };
            self.writer
                .send(id("settled"), RpcBody::OperationSettled(settlement.clone()))
                .await
                .unwrap();
            assert_eq!(
                self.next().await.body,
                RpcBody::SettlementAcknowledged(settlement)
            );
        }
        frame.body
    }
    async fn stop(mut self) -> (tempfile::TempDir, BackendEnvironment) {
        self.writer
            .send(id("release"), RpcBody::Release)
            .await
            .unwrap();
        assert_eq!(self.next().await.body, RpcBody::Released);
        self.task.await.unwrap().unwrap();
        (self.directory, self.environment)
    }
}
fn succeeded(body: RpcBody) -> Value {
    let RpcBody::CommitPlan(plan) = body else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Succeeded, "{plan:?}");
    plan.output.unwrap()
}
fn observed(body: RpcBody) -> Value {
    let RpcBody::QueryResult {
        data, completeness, ..
    } = body
    else {
        panic!("{body:?}")
    };
    assert_eq!(completeness, ObservationCompleteness::Complete);
    data
}
fn capture_replies() -> Vec<(&'static str, Value)> {
    vec![
        ("views.caller", origin()),
        ("plugins.inspect", inspection()),
        ("editor.context.preview", source()),
        ("views.caller", origin()),
    ]
}

#[test]
fn public_manifest_declares_only_supported_contracts() {
    let manifest = manifest::manifest();
    manifest.validate().unwrap();
    assert_eq!(manifest.capabilities.len(), 6);
    assert_eq!(manifest.contexts.len(), 1);
    assert_eq!(manifest.views.len(), 1);
    assert_eq!(manifest.views[0].id.as_str(), "annotations");
    assert_eq!(manifest.views[0].entrypoint.as_str(), "dist/src/index.html");
    assert!(
        manifest
            .capabilities
            .iter()
            .all(|cap| cap.cancellation == CancellationSupport::Unsupported)
    );
    assert!(
        manifest
            .requires
            .iter()
            .all(|g| ["views.caller", "plugins.inspect", "annotations.read", "annotations.write"].contains(&g.capability.id.as_str()))
    );
}
#[tokio::test]
async fn exact_freeze_note_context_and_reopen_preserve_original_receipts() {
    let mut f = Fixture::new().await;
    let frozen = succeeded(
        f.perform(
            call("freeze", "annotations.write", freeze("freeze-original")),
            capture_replies(),
            true,
        )
        .await,
    );
    let evidence = frozen["outcome"]["evidence_id"].clone();
    let create = json!({"request_id":"note-original","command":{"kind":"create","evidence_id":evidence,"note":"Check 🧬 result","labels":[],"marks":[],"continued_from":null}});
    let saved = succeeded(
        f.perform(
            call("create", "annotations.write", create.clone()),
            vec![("views.caller", origin())],
            true,
        )
        .await,
    );
    let note = saved["outcome"]["annotation"].clone();
    let read = observed(
        f.perform(
            call(
                "read",
                "annotations.read",
                json!({"kind":"read","annotation":note}),
            ),
            vec![("views.caller", origin())],
            false,
        )
        .await,
    );
    assert_eq!(read["evidence"]["fragment"]["text"], "🧬中");
    assert_eq!(
        read["revision"]["author"],
        json!({"kind":"principal","id":"principal-one"})
    );
    let page = observed(
        f.perform(
            call(
                "search",
                "annotations.context.search",
                json!({"window":"window-one","text":"🧬","after":null,"limit":20}),
            ),
            vec![("views.caller", origin())],
            false,
        )
        .await,
    );
    let preview=observed(f.perform(call("preview","annotations.context.preview",json!({"reference":page["items"][0]["reference"],"inclusion":{"kind":"note_and_evidence"},"max_bytes":16384})),vec![("views.caller",origin())],false).await);
    assert!(
        preview["text"]
            .as_str()
            .unwrap()
            .contains("Check 🧬 result")
    );
    assert_eq!(preview["data"]["source_status"], "unknown");
    assert_eq!(preview["truncated"], false);
    let (directory, environment) = f.stop().await;
    let mut f = Fixture::open(directory, environment).await;
    assert_eq!(
        succeeded(
            f.perform(
                call(
                    "freeze-replay",
                    "annotations.write",
                    freeze("freeze-original")
                ),
                vec![("views.caller", origin())],
                true
            )
            .await
        ),
        frozen,
        "replay must not reread source"
    );
    assert_eq!(
        succeeded(
            f.perform(
                call("create-replay", "annotations.write", create),
                vec![("views.caller", origin())],
                true
            )
            .await
        ),
        saved
    );
    f.stop().await;
}
#[tokio::test]
async fn malformed_source_and_changed_caller_cannot_write_evidence() {
    for variant in ["lineage", "reference", "partial", "quote", "caller"] {
        let mut f = Fixture::new().await;
        let mut preview = source();
        let mut request = freeze("invalid-source");
        match variant {
            "lineage" => preview["data"] = json!({}),
            "reference" => preview["item"]["reference"]["selector"]["version"] = json!(8),
            "partial" => preview["truncated"] = json!(true),
            "quote" => request["command"]["anchor"]["end"] = json!(2),
            _ => {}
        }
        let mut replies = vec![
            ("views.caller", origin()),
            ("plugins.inspect", inspection()),
            ("editor.context.preview", preview),
        ];
        if variant == "caller" {
            let mut changed = origin();
            changed["view"]["connection"] = json!("changed");
            replies.push(("views.caller", changed));
        }
        let RpcBody::CommitPlan(plan) = f
            .perform(call("bad", "annotations.write", request), replies, true)
            .await
        else {
            panic!()
        };
        assert_eq!(plan.outcome, PluginOutcome::Failed, "{variant}");
        let receipt = observed(
            f.perform(
                call(
                    "receipt",
                    "annotations.read",
                    json!({"kind":"receipt","request_id":"invalid-source"}),
                ),
                vec![("views.caller", origin())],
                false,
            )
            .await,
        );
        assert!(receipt["receipt"].is_null());
        f.stop().await;
    }
}
#[tokio::test]
async fn caller_scope_window_and_identity_are_not_taken_from_arguments() {
    let mut f = Fixture::new().await;
    for (capability, scope, arguments) in [
        (
            "annotations.read",
            "application.read",
            json!({"kind":"list","limit":10}),
        ),
        (
            "annotations.write",
            "application.control",
            freeze("missing-write-scope"),
        ),
    ] {
        let mut denied = call("missing-metadata-scope", capability, arguments);
        denied.scopes.remove(scope);
        assert!(matches!(f.perform(denied, vec![], false).await,
            RpcBody::Error { code, .. } if code == "access_denied"));
    }
    let mut bad = call(
        "wrong-principal",
        "annotations.read",
        json!({"kind":"list","limit":10}),
    );
    bad.principal = PrincipalId::new("other").unwrap();
    assert!(matches!(
        f.perform(bad, vec![], false).await,
        RpcBody::Error { .. }
    ));
    let mut bad = call("no-scope", "annotations.write", freeze("no-scope"));
    bad.scopes.remove("documents.read");
    let RpcBody::CommitPlan(plan) = f
        .perform(
            bad,
            vec![
                ("views.caller", origin()),
                ("plugins.inspect", inspection()),
            ],
            true,
        )
        .await
    else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Failed);
    let mut bad = freeze("wrong-window");
    bad["command"]["reference"]["window"] = json!("other-window");
    let RpcBody::CommitPlan(plan) = f
        .perform(
            call("wrong-window", "annotations.write", bad),
            vec![("views.caller", origin())],
            true,
        )
        .await
    else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Failed);
    f.stop().await;
}
#[tokio::test]
async fn release_requires_original_settlement_and_changed_request_is_rejected() {
    let mut f = Fixture::new().await;
    let original = call("freeze", "annotations.write", freeze("same-request"));
    let frozen = succeeded(f.perform(original.clone(), capture_replies(), false).await);
    f.writer
        .send(id("early-release"), RpcBody::Release)
        .await
        .unwrap();
    assert!(matches!(f.next().await.body,RpcBody::Error {code,..} if code=="busy"));
    let settlement = OperationSettlement {
        operation_id: OperationId::new(original.operation_id.unwrap()).unwrap(),
        binding: original.binding,
        outcome: PluginOutcome::Succeeded,
    };
    f.writer
        .send(id("settle"), RpcBody::OperationSettled(settlement.clone()))
        .await
        .unwrap();
    assert_eq!(
        f.next().await.body,
        RpcBody::SettlementAcknowledged(settlement)
    );
    let mut changed = freeze("same-request");
    changed["command"]["anchor"] = json!({"kind":"whole_item"});
    let RpcBody::CommitPlan(plan) = f
        .perform(
            call("changed", "annotations.write", changed),
            vec![("views.caller", origin())],
            true,
        )
        .await
    else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Failed);
    assert_eq!(plan.recovery.unwrap()["code"], "request_conflict");
    assert!(frozen["outcome"]["evidence_id"].is_string());
    f.stop().await;
}

#[tokio::test]
async fn captured_resource_replays_without_source_reads_and_preserves_image_anchor_after_reopen() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut f = Fixture::new().await;
    let mut seed = 713u32;
    let image = image::RgbImage::from_fn(256, 256, |_, _| {
        let mut rgb = [0u8; 3];
        for channel in &mut rgb {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *channel = seed as u8;
        }
        image::Rgb(rgb)
    });
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    let bytes = bytes.into_inner();
    assert!(bytes.len() > 65536);
    let resource = json!({"owner":reference()["provider"],"resource":"captured-image","digest":rho_annotation_owner::sha256(&bytes),"media_type":"image/png","bytes":bytes.len()});
    let input = json!({"request_id":"import-original","reference":resource});
    let mut replies = vec![("views.caller", origin())];
    for (index, part) in bytes.chunks(65536).enumerate() {
        let offset = index * 65536;
        let end = offset + part.len();
        replies.push(("resources.read",json!({"reference":resource,"offset":offset,"base64":STANDARD.encode(part),"next":(end<bytes.len()).then_some(end)})));
    }
    replies.push(("views.caller", origin()));
    let imported = succeeded(
        f.perform(
            call(
                "capture-import",
                "annotations.capture.import",
                input.clone(),
            ),
            replies,
            true,
        )
        .await,
    );
    let capture = imported["outcome"]["capture"].clone();
    assert_eq!(capture["width"], 256);
    assert_eq!(capture["height"], 256);
    assert_eq!(capture["original_media"], false);
    let mut freeze = freeze("capture-anchor");
    freeze["command"]["anchor"] = json!({"kind":"captured_view","capture":capture});
    let frozen = succeeded(
        f.perform(
            call("freeze-image", "annotations.write", freeze),
            vec![
                ("views.caller", origin()),
                ("plugins.inspect", inspection()),
                ("editor.context.preview", source()),
                ("views.caller", origin()),
            ],
            true,
        )
        .await,
    );
    let (directory, environment) = f.stop().await;
    let mut f = Fixture::open(directory, environment).await;
    assert_eq!(
        succeeded(
            f.perform(
                call("capture-retry", "annotations.capture.import", input.clone()),
                vec![("views.caller", origin())],
                true
            )
            .await
        ),
        imported
    );
    let mut changed = input;
    changed["reference"]["resource"] = json!("another-image");
    let RpcBody::CommitPlan(plan) = f
        .perform(
            call("capture-conflict", "annotations.capture.import", changed),
            vec![("views.caller", origin())],
            true,
        )
        .await
    else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Failed);
    let mut actual = Vec::new();
    let mut offset = 0;
    loop {
        let RpcBody::QueryResult { data, .. } = f
            .perform(
                call(
                    "capture-read",
                    "annotations.capture.read",
                    json!({"capture":capture,"offset":offset,"limit":65536}),
                ),
                vec![("views.caller", origin())],
                false,
            )
            .await
        else {
            panic!()
        };
        actual.extend(STANDARD.decode(data["base64"].as_str().unwrap()).unwrap());
        match data["next"].as_u64() {
            Some(next) => offset = next,
            None => break,
        }
    }
    assert_eq!(actual, bytes);
    let RpcBody::QueryResult { data, .. } = f
        .perform(
            call(
                "capture-evidence",
                "annotations.read",
                json!({"kind":"evidence","evidence_id":frozen["outcome"]["evidence_id"]}),
            ),
            vec![("views.caller", origin())],
            false,
        )
        .await
    else {
        panic!()
    };
    assert_eq!(data["evidence"]["anchor"]["capture"], capture);
    let mut forged = capture.clone();
    forged["width"] = json!(1);
    assert!(matches!(
        f.perform(
            call(
                "bad-capture-read",
                "annotations.capture.read",
                json!({"capture":forged,"offset":0,"limit":65536})
            ),
            vec![("views.caller", origin())],
            false
        )
        .await,
        RpcBody::Error { .. }
    ));
    f.stop().await;
}

#[tokio::test]
async fn capture_import_refuses_wrong_bytes_changed_caller_and_missing_original_scope() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let bytes = crate::captures::tests::png();
    for variant in ["digest", "damaged", "caller", "scope"] {
        let mut f = Fixture::new().await;
        let actual = if variant == "damaged" {
            bytes[..bytes.len() / 2].to_vec()
        } else {
            bytes.clone()
        };
        let resource = json!({"owner":reference()["provider"],"resource":"capture-refusal","digest":if variant=="digest"{format!("sha256:{}","0".repeat(64))}else{rho_annotation_owner::sha256(&actual)},"media_type":"image/png","bytes":actual.len()});
        let mut request = call(
            "refused-capture",
            "annotations.capture.import",
            json!({"request_id":"refused","reference":resource}),
        );
        let mut replies = vec![("views.caller", origin())];
        if variant == "scope" {
            request.scopes.remove("resources.read");
        } else {
            replies.push(("resources.read",json!({"reference":resource,"offset":0,"base64":STANDARD.encode(&actual),"next":null})));
            if variant == "caller" {
                let mut changed = origin();
                changed["view"]["connection"] = json!("new-connection");
                replies.push(("views.caller", changed));
            }
        }
        let RpcBody::CommitPlan(plan) = f.perform(request, replies, true).await else {
            panic!()
        };
        assert_eq!(plan.outcome, PluginOutcome::Failed, "{variant}");
        let RpcBody::QueryResult { data, .. } = f
            .perform(
                call(
                    "refused-receipt",
                    "annotations.read",
                    json!({"kind":"receipt","request_id":"refused"}),
                ),
                vec![("views.caller", origin())],
                false,
            )
            .await
        else {
            panic!()
        };
        assert_eq!(data["receipt"], Value::Null);
        f.stop().await;
    }
}
