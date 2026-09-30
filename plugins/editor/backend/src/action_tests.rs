use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_sdk::{host_call_channel, protocol::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn instance() -> PluginInstance {
    serde_json::from_value(json!({"identity":{"plugin":"org.rho.editor","instance":"editor","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},"project":"project","principal":"principal","alias":"editor","configuration":{},"state":"active","diagnostic":null})).unwrap()
}
fn key(id: &str, version: u32) -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new(id).unwrap(),
        version,
    }
}
fn observed(data: Value) -> Value {
    json!({"status":"ready","completeness":"complete","data":data})
}
fn fixture() -> (PluginCall, Value, Value) {
    let i = instance();
    let runtime = json!({"plugin":"org.rho.r","instance":"r","revision":format!("sha256:{}","c".repeat(64)),"artifact":format!("sha256:{}","d".repeat(64))});
    let payload = json!({"schema":1,"document":{"raw":"answer <- 42L\r\n","version":"v1","path":"分析.R","readonly":null},"save":null,"code":null,"fileRun":null,"runtime":runtime});
    let bytes = serde_json::to_vec(&payload).unwrap();
    let draft = json!({"draft":"draft-one","window":"window","project":"project","principal":"principal","source":{"revision":i.identity.revision,"contribution":"editor"},"version":1,"content":{"digest":hash(&bytes),"bytes":bytes.len(),"chunks":[{"digest":hash(&bytes),"bytes":bytes.len()}]},"metadata":{"encoding":"org.rho.editor.document.v1","document_version":"v1","path":"分析.R"},"discarded":false});
    let reference = json!({"provider":i.identity,"contribution":"documents","window":"window","selector":{"draft":"draft-one","version":1,"digest":hash(&bytes)}});
    let call = PluginCall {
        request: RequestId::new("original-run").unwrap(),
        binding: ProviderBinding {
            provider: i.identity,
            project: i.project,
            capability: key("editor.run", 1),
            target: None,
        },
        principal: i.principal,
        scopes: Default::default(),
        arguments: json!({"reference":reference,"runtime":runtime,"expected_session":"native-session"}),
        preconditions: Value::Null,
        owner_context: Value::Null,
        operation_id: Some("editor-parent".into()),
    };
    (call, draft, payload)
}
async fn run(
    mode: &str,
) -> (
    PluginCommitPlan,
    Value,
    Vec<(RequestId, CapabilityKey, Value)>,
) {
    let (call, mut draft, payload) = fixture();
    let (host, mut pump) = host_call_channel(32).unwrap();
    let mut task = tokio::spawn(crate::actions::invoke(host, instance(), call));
    let mut calls = vec![];
    let mut staged = vec![];
    let mut saved = Value::Null;
    loop {
        tokio::select! {
            plan=&mut task => return (plan.unwrap(),saved,calls),
            outgoing=pump.next()=>{
                let Some(outgoing)=outgoing else {return (task.await.unwrap(),saved,calls)};let RpcBody::HostCall{capability,arguments,..}=outgoing.body else{panic!()};
                calls.push((outgoing.request.clone(),capability.clone(),arguments.clone()));
                let result=match capability.id.as_str() {
                    "documents.inspect"=>observed(draft.clone()),
                    "documents.read"=>{let bytes=serde_json::to_vec(&payload).unwrap();observed(json!({"draft":"draft-one","version":1,"digest":hash(&bytes),"offset":0,"base64":STANDARD.encode(bytes),"next":null}))},
                    "documents.stage"=>{let bytes=STANDARD.decode(arguments["base64"].as_str().unwrap()).unwrap();staged.extend(&bytes);json!({"digest":hash(&bytes),"bytes":bytes.len()})},
                    "documents.save"=>{
                        saved=serde_json::from_slice(&staged).unwrap();draft["version"]=json!(2);draft["content"]=arguments["content"].clone();draft["metadata"]=arguments["metadata"].clone();
                        record("draft-child",&capability,&arguments,if mode=="draft-failure"{"failed"}else{"succeeded"},draft.clone())
                    },
                    "r.execute"=>{
                        assert_eq!(saved["externalRun"]["operation"],"editor-parent","run linkage must be saved before native dispatch");
                        assert_eq!(arguments["arguments"]["run"]["code"],"answer <- 42L\n");
                        assert_eq!(arguments["arguments"]["run"]["source"],saved["externalRun"]["source"]);
                        if mode=="lost" { pump.close();return (task.await.unwrap(),saved,calls); }
                        record("r-child",&capability,&arguments,if mode=="native-failure"{"failed"}else{"succeeded"},json!({"operation_id":"r-child","session_id":"native-session"}))
                    },
                    other=>panic!("unexpected {other}"),
                };
                pump.respond(&outgoing.request,RpcBody::HostResult{result}).unwrap();
            }
        }
    }
}
fn record(id: &str, cap: &CapabilityKey, args: &Value, status: &str, output: Value) -> Value {
    json!({"operation":{"operation_id":id,"capability":cap,"normalized_arguments":args,"causation_id":"editor-parent","caller":{"kind":"plugin","id":"editor"}},"status":status,"output":output,"error":if status=="failed"{Some("confirmed native failure")}else{None}})
}
#[tokio::test]
async fn run_links_exact_capture_before_one_native_effect() {
    let (plan, saved, calls) = run("success").await;
    assert_eq!(plan.outcome, PluginOutcome::Succeeded);
    assert_eq!(
        calls
            .iter()
            .filter(|(_, cap, _)| cap.id.as_str() == "r.execute")
            .count(),
        1
    );
    assert_eq!(
        saved["externalRun"]["source"],
        json!({"view_id":"draft:draft-one","label":"分析.R","kind":"document"})
    );
    assert_eq!(
        saved["externalRun"]["code_digest"],
        hash(b"answer <- 42L\n")
    );
    assert_eq!(
        plan.output.as_ref().unwrap()["reference"]["selector"]["version"],
        2
    );
}
#[tokio::test]
async fn lost_native_ack_retains_request_without_replay() {
    let (plan, _, calls) = run("lost").await;
    assert_eq!(plan.outcome, PluginOutcome::Uncertain);
    let effects = &plan.recovery.unwrap()["operations"];
    let effect = effects.as_array().unwrap().last().unwrap();
    assert_eq!(effect["request"], json!(calls.last().unwrap().0));
    assert_eq!(effect["capability"], json!(key("r.execute", 2)));
    assert!(effect["operation"].is_null());
    assert_eq!(
        calls
            .iter()
            .filter(|(_, cap, _)| cap.id.as_str() == "r.execute")
            .count(),
        1
    );
}
#[tokio::test]
async fn confirmed_failures_are_not_unknown_and_failed_capture_cannot_run() {
    let (plan, _, calls) = run("draft-failure").await;
    assert_eq!(plan.outcome, PluginOutcome::Failed);
    assert!(
        !calls
            .iter()
            .any(|(_, cap, _)| cap.id.as_str() == "r.execute")
    );
    let (plan, _, _) = run("native-failure").await;
    assert_eq!(plan.outcome, PluginOutcome::Failed);
    assert_eq!(plan.recovery.unwrap()["operations"][1]["status"], "failed");
}
#[tokio::test]
async fn inspection_recovers_lost_child_identity_read_only_and_preserves_parent_uncertainty() {
    let (plan, _, calls) = run("lost").await;
    let original = fixture().0;
    let mut parent = record(
        "editor-parent",
        &key("editor.run", 1),
        &json!({"binding":original.binding,"arguments":original.arguments}),
        "uncertain",
        Value::Null,
    );
    let owner_recovery = json!({"kind":"plugin_owner_recovery","data":plan.recovery.unwrap()});
    let rcall = calls.last().unwrap();
    let child = record("r-child", &rcall.1, &rcall.2, "succeeded", json!({}));
    // Emulate a real backend disconnect before its final plan reaches Host.
    // The semantic child request must still be discoverable with no effects.
    for recovery in [
        owner_recovery,
        json!({"kind":"plugin_boundary_failure","candidate":null}),
    ] {
        parent["recovery"] = recovery;
        let mut query = original.clone();
        query.operation_id = None;
        query.binding.capability = key("editor.run.inspect", 1);
        query.arguments = json!({"operation":"editor-parent"});
        let (host, mut pump) = host_call_channel(32).unwrap();
        let i = instance();
        let mut task =
            tokio::spawn(async move { crate::actions::inspect(&host, &i, &query).await });
        let mut reads = vec![];
        let result = loop {
            tokio::select! {
                result=&mut task=>break result.unwrap().unwrap(),
                outgoing=pump.next()=>{
                    let Some(outgoing)=outgoing else {break task.await.unwrap().unwrap()};let RpcBody::HostCall{capability,arguments,..}=outgoing.body else{panic!()};reads.push(capability.id.to_string());
                    let data=match capability.id.as_str(){
                        "operation.get"=>json!({"record":if arguments["operation_id"]=="editor-parent"{&parent}else{&child}}),
                        "plugins.delegated_operation"=>{assert_eq!(arguments["request"],json!(rcall.0));assert_eq!(arguments["parent_operation"],"editor-parent");json!({"operation_id":"r-child"})},
                        _=>panic!("inspection dispatched work"),
                    };
                    pump.respond(&outgoing.request,RpcBody::HostResult{result:observed(data)}).unwrap();
                }
            }
        };
        assert_eq!(result["parent"]["status"], "uncertain");
        assert_eq!(result["execution"]["status"], "succeeded");
        assert_eq!(
            reads,
            [
                "operation.get",
                "plugins.delegated_operation",
                "operation.get"
            ]
        );
    }
}
