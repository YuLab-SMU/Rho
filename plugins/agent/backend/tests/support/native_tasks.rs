use super::*;
use async_trait::async_trait;
use rho_agent_api::*;
use rho_agent_client::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
fn now() -> u64 {
    100
}

use std::sync::{Mutex as SyncMutex, atomic::AtomicUsize};
use tokio::sync::Notify;

#[path = "native_assets.rs"]
mod assets;
#[path = "native_context.rs"]
mod context;
#[path = "native_science.rs"]
mod science;
#[path = "native_uploads.rs"]
mod uploads;

#[derive(Default)]
struct Factory {
    opens: AtomicUsize,
    sends: Arc<AtomicUsize>,
    closes: Arc<AtomicUsize>,
    recoveries: AtomicUsize,
    hold: AtomicBool,
    refuse_stop: Arc<AtomicBool>,
    refuse_recovery: AtomicBool,
    refuse_open: AtomicBool,
    sessions: SyncMutex<Vec<Arc<Session>>>,
    inputs: Arc<SyncMutex<Vec<Vec<NativeInput>>>>,
    endpoints: SyncMutex<Vec<(String, String)>>,
    delay: AtomicBool,
    release: Notify,
}
struct Session {
    state: SyncMutex<AgentClientSession>,
    events: SyncMutex<Vec<NativeEvent>>,
    sends: Arc<AtomicUsize>,
    closes: Arc<AtomicUsize>,
    refuse_stop: Arc<AtomicBool>,
    hold: bool,
    inputs: Arc<SyncMutex<Vec<Vec<NativeInput>>>>,
    changed: Notify,
}
#[async_trait]
impl NativeAgentFactory for Factory {
    async fn open(
        &self,
        r: NativeOpenRequest,
    ) -> Result<Arc<dyn NativeAgentSession>, NativeOpenFailure> {
        let number = self.opens.fetch_add(1, Ordering::SeqCst) + 1;
        self.endpoints
            .lock()
            .unwrap()
            .push((r.endpoint.clone(), r.token.clone()));
        if self.refuse_open.load(Ordering::SeqCst) {
            return Err("native open refused".into());
        }
        if self.delay.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        let native = r
            .native_session_id
            .unwrap_or_else(|| format!("native-{number}"));
        let s = Arc::new(Session {
            state: SyncMutex::new(AgentClientSession {
                id: format!("connection-{number}"),
                provider: r.provider,
                native_session_id: native,
                project_root: r.root.to_string_lossy().into_owned(),
                window: r.window,
                model: "fixture".into(),
                effort: None,
                state: "ready".into(),
                messages: vec![],
                activity: vec![],
                decisions: vec![],
                error: None,
                truncated: false,
                elapsed_ms: None,
                last_request_id: None,
            }),
            events: SyncMutex::new(vec![]),
            sends: self.sends.clone(),
            closes: self.closes.clone(),
            refuse_stop: self.refuse_stop.clone(),
            hold: self.hold.load(Ordering::SeqCst),
            inputs: self.inputs.clone(),
            changed: Notify::new(),
        });
        self.sessions.lock().unwrap().push(s.clone());
        Ok(s)
    }
    async fn recover_process(&self, _: &NativeProcessProof) -> Result<(), String> {
        self.recoveries.fetch_add(1, Ordering::SeqCst);
        if self.refuse_recovery.load(Ordering::SeqCst) {
            Err("unconfirmed process ownership".into())
        } else {
            Ok(())
        }
    }
}
#[async_trait]
impl NativeAgentSession for Session {
    fn snapshot(&self) -> AgentClientSession {
        self.state.lock().unwrap().clone()
    }
    fn capabilities(&self) -> AgentNativeCapabilities {
        AgentNativeCapabilities {
            resume: true,
            history: "native_context_history".into(),
            images: true,
            embedded_context: true,
            modes: vec![],
            current_mode: None,
            models: vec![AgentModel {
                id: "fixture".into(),
                name: "Fixture".into(),
                efforts: vec![],
                default_effort: None,
            }],
        }
    }
    fn events(&self, after: u64) -> NativeEventPage {
        let events = self.events.lock().unwrap();
        NativeEventPage {
            cursor: events.last().map_or(0, |e| e.cursor),
            events: events
                .iter()
                .filter(|e| e.cursor > after)
                .cloned()
                .collect(),
            gap: false,
        }
    }
    fn native_turn_id(&self) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .last_request_id
            .as_ref()
            .map(|r| format!("turn-{r}"))
    }
    fn process_proof(&self) -> Option<NativeProcessProof> {
        Some(NativeProcessProof {
            pid: 1234,
            start_time: 1,
            executable: "fixture".into(),
            marker: "fixture-owned".into(),
        })
    }
    fn rebind(&self, w: AgentControllerRef) {
        self.state.lock().unwrap().window = w;
    }
    async fn configure(&self, m: &str, e: Option<&str>, _: Option<&str>) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        s.model = m.into();
        s.effort = e.map(str::to_owned);
        Ok(())
    }
    async fn send(&self, p: NativePrompt) -> Result<(), String> {
        self.sends.fetch_add(1, Ordering::SeqCst);
        self.inputs.lock().unwrap().push(p.parts.clone());
        let mut s = self.state.lock().unwrap();
        s.last_request_id = Some(p.request_id.clone());
        s.state = if self.hold { "running" } else { "ready" }.into();
        let mut events = self.events.lock().unwrap();
        let n = events.len() as u64;
        events.push(NativeEvent {
            usage: None,
            cursor: n + 1,
            key: format!("{}:user", p.request_id),
            request_id: Some(p.request_id.clone()),
            session: s.native_session_id.clone(),
            turn: None,
            item: None,
            kind: "message".into(),
            role: Some("user".into()),
            text: p.display_text,
            status: None,
            historical: false,
            at_ms: now(),
        });
        if !self.hold {
            events.push(NativeEvent {
                usage: None,
                cursor: n + 2,
                key: format!("{}:assistant", p.request_id),
                request_id: Some(p.request_id),
                session: s.native_session_id.clone(),
                turn: None,
                item: None,
                kind: "message".into(),
                role: Some("assistant".into()),
                text: "ok".into(),
                status: None,
                historical: false,
                at_ms: now(),
            });
        }
        self.changed.notify_waiters();
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), String> {
        if self.refuse_stop.load(Ordering::SeqCst) {
            return Err("stop unconfirmed".into());
        }
        self.state.lock().unwrap().state = "interrupted".into();
        self.changed.notify_waiters();
        Ok(())
    }
    async fn decide(&self, _: u64, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
        self.state.lock().unwrap().state = "disconnected".into();
        self.changed.notify_waiters();
    }
    async fn changed(&self) {
        self.changed.notified().await;
    }
    async fn history(
        &self,
        _: Option<String>,
        _: u32,
    ) -> Result<(Vec<NativeEvent>, Option<String>), String> {
        Ok((vec![], None))
    }
}

async fn fixture(factory: Arc<Factory>) -> Fixture {
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
    Fixture::open_with_factory(directory, environment, &[], factory).await
}
fn action(command: Value) -> Value {
    json!({"request_id":uuid::Uuid::new_v4().to_string(),"command":command})
}
impl Fixture {
    async fn native_action(&mut self, name: &str, input: Value) -> Value {
        let (call, reverse) = self.begin(name, "agent.native.command", input).await;
        let plan = self.answer(reverse, origin("view-one")).await;
        assert_eq!(plan.outcome, PluginOutcome::Succeeded, "{plan:?}");
        self.settle(&call, plan.outcome).await;
        plan.output.unwrap()
    }
    async fn native_create(&mut self) -> Value {
        self.native_action(
            "native-create",
            action(json!({"kind":"create","provider":"kimi","model":"fixture","effort":null})),
        )
        .await
    }
    async fn native_upload(&mut self, control: Value) -> (String, Value) {
        let request = uuid::Uuid::new_v4().to_string();
        let call = call(
            "native-upload",
            "agent.native.assets.upload",
            json!({"request_id":request,"control":control,"name":"notes.txt","mime_type":"text/plain","data":"Tm90ZXM="}),
            false,
        );
        self.writer
            .send(call.request.clone(), RpcBody::Control(call))
            .await
            .unwrap();
        let reverse = self.read().await;
        assert!(
            matches!(&reverse.body, RpcBody::HostCall { parent_request, .. } if parent_request == &id("native-upload"))
        );
        self.writer.send(reverse.request, RpcBody::HostResult {result:json!({"status":"ready","completeness":"complete","data":origin("view-one")})}).await.unwrap();
        let reply = self.read().await;
        assert_eq!(reply.request, id("native-upload"));
        let RpcBody::ControlResult { data } = reply.body else {
            panic!("{:?}", reply.body)
        };
        (request, data)
    }
    async fn native_send(&mut self, input: Value) -> PluginCall {
        let (call, reverse) = self
            .begin("native-send", "agent.native.command", input)
            .await;
        self.writer.send(reverse.request, RpcBody::HostResult {result:json!({"status":"ready","completeness":"complete","data":origin("view-one")})}).await.unwrap();
        call
    }
}
fn control(value: &Value) -> Value {
    json!({"task_id":value["detail"]["summary"]["task"]["task_id"],"generation":value["detail"]["summary"]["attachment"]["generation"]})
}
async fn submitted(factory: &Factory) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while factory.sends.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
fn finish(factory: &Factory) {
    let session = factory.sessions.lock().unwrap()[0].clone();
    session.state.lock().unwrap().state = "ready".into();
    session.changed.notify_waiters();
}

#[test]
fn native_contract_keeps_binary_input_out_of_operation_schema() {
    let schema =
        schemars::schema_for!(rho_agent_backend::native_arguments::NativeAction).to_value();
    assert!(!schema.to_string().contains("add_asset"));
    assert!(!schema.to_string().contains("\"data\""));
    let binary = action(
        json!({"kind":"add_asset","control":{"task_id":"task","generation":1},"name":"private.txt","mime_type":"text/plain","data":"secret"}),
    );
    assert!(
        serde_json::from_value::<rho_agent_backend::native_arguments::NativeAction>(binary)
            .is_err()
    );
    let manifest = manifest::manifest();
    let upload = manifest
        .capabilities
        .iter()
        .find(|v| v.capability.id.as_str() == "agent.native.assets.upload")
        .unwrap();
    assert_eq!(upload.kind, CapabilityKind::Control);
    assert!(serde_json::to_vec(&manifest).unwrap().len() < MAX_MANIFEST_BYTES);
    for field in ["project_root", "window", "principal"] {
        let mut input =
            action(json!({"kind":"create","provider":"kimi","model":"fixture","effort":null}));
        input[field] = "forged".into();
        assert!(
            serde_json::from_value::<rho_agent_backend::native_arguments::NativeAction>(input)
                .is_err()
        );
    }
}

#[tokio::test]
async fn native_command_retains_parent_uploaded_input_next_draft_and_reopen_identity() {
    let factory = Arc::new(Factory::default());
    factory.hold.store(true, Ordering::SeqCst);
    let mut f = fixture(factory.clone()).await;
    let created = f.native_create().await;
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    let (upload_request, uploaded) = f.native_upload(control(&created)).await;
    assert_eq!(uploaded["receipt"]["status"], "succeeded");
    assert_eq!(uploaded["detail"]["assets"][0]["bytes"], 5);
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    let saved = f.native_action("native-draft", action(json!({"kind":"save_draft","control":control(&uploaded),"version":uploaded["detail"]["draft"]["version"],"content":{"text":"Original Unicode 科学输入","assets":[uploaded["detail"]["assets"][0]["asset_id"]],"context":[]}}))).await;
    let send_input = action(
        json!({"kind":"send","control":control(&saved),"draft_version":saved["detail"]["draft"]["version"]}),
    );
    let parent = f.native_send(send_input.clone()).await;
    submitted(&factory).await;
    assert_eq!(factory.opens.load(Ordering::SeqCst), 1);
    assert_eq!(factory.sends.load(Ordering::SeqCst), 1);
    let current = f
        .query(
            "agent.native.task",
            json!({"task_id":saved["detail"]["summary"]["task"]["task_id"]}),
        )
        .await;
    assert_eq!(current["summary"]["attachment"]["state"], "running");
    let tasks = f.query("agent.tasks", json!({"limit":20})).await;
    assert!(tasks.to_string().contains("running"));
    let next = f.native_action("next-native-draft", action(json!({"kind":"save_draft","control":{"task_id":current["summary"]["task"]["task_id"],"generation":current["summary"]["attachment"]["generation"]},"version":current["draft"]["version"],"content":{"text":"Next draft 下一条","assets":[],"context":[]}}))).await;
    // An in-progress Send still retains its original Operation despite send()
    // returning after acceptance. The backend cannot acknowledge release yet.
    f.writer
        .send(id("busy-release"), RpcBody::Release)
        .await
        .unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error {code, ..} if code == "busy"));
    {
        use rho_agent_owner::{AgentTaskRepository, AgentTaskScope};
        let store = rho_agent_store::AgentStore::open(
            &std::path::Path::new(&f.environment.data_root).join("agent-v1.sqlite"),
        )
        .unwrap();
        let scope = AgentTaskScope {
            project: f.environment.project_root.clone(),
            principal: instance().principal.to_string(),
        };
        let retained = store
            .agent_native_admission(&scope, send_input["request_id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            retained.origin.operation.as_str(),
            parent.operation_id.as_ref().unwrap()
        );
        assert_eq!(retained.origin.request, parent.request);
        assert_eq!(retained.origin.binding, parent.binding);
        assert_eq!(
            retained.input_draft.content.text,
            "Original Unicode 科学输入"
        );
        assert!(
            store
                .agent_native_admission(&scope, &upload_request)
                .unwrap()
                .is_none()
        );
    }
    {
        let input = factory.inputs.lock().unwrap();
        assert!(
            input[0]
                .iter()
                .any(|p| matches!(p, NativeInput::Resource {text, ..} if text == "Notes"))
        );
    }
    finish(&factory);
    let reply = f.read().await;
    assert_eq!(reply.request, parent.request);
    let RpcBody::CommitPlan(plan) = reply.body else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Succeeded);
    assert_eq!(
        plan.output.as_ref().unwrap()["detail"]["draft"],
        next["detail"]["draft"]
    );
    f.settle(&parent, plan.outcome).await;
    let (directory, environment) = f.release().await;
    assert_eq!(factory.closes.load(Ordering::SeqCst), 1);
    let reopened_factory = Arc::new(Factory::default());
    let mut f =
        Fixture::open_with_factory(directory, environment, &[], reopened_factory.clone()).await;
    let (repeat, reverse) = f
        .begin("repeat-native-send", "agent.native.command", send_input)
        .await;
    let mut reconnected = origin("view-one");
    reconnected["view"]["connection"] = "new-renderer-connection".into();
    let observed = f.answer(reverse, reconnected).await;
    assert_eq!(observed.outcome, PluginOutcome::Succeeded);
    assert_eq!(
        observed.output.as_ref().unwrap()["receipt"]["status"],
        "succeeded"
    );
    assert_eq!(
        observed.output.as_ref().unwrap()["detail"]["draft"],
        next["detail"]["draft"]
    );
    assert_eq!(reopened_factory.opens.load(Ordering::SeqCst), 0);
    f.settle(&repeat, observed.outcome).await;
    f.release().await;
}

#[tokio::test]
async fn native_stop_settles_original_turn_separately_from_stop_request() {
    let factory = Arc::new(Factory::default());
    factory.hold.store(true, Ordering::SeqCst);
    let mut f = fixture(factory.clone()).await;
    let created = f.native_create().await;
    let draft = f.native_action("native-draft", action(json!({"kind":"save_draft","control":control(&created),"version":0,"content":{"text":"Wait for stop","assets":[],"context":[]}}))).await;
    let send_input = action(json!({"kind":"send","control":control(&draft),"draft_version":1}));
    let send = f.native_send(send_input.clone()).await;
    submitted(&factory).await;
    let task = f
        .query(
            "agent.native.task",
            json!({"task_id":draft["detail"]["summary"]["task"]["task_id"]}),
        )
        .await;
    let (stop, reverse) = f.begin("native-stop", "agent.native.command", action(json!({"kind":"stop","control":{"task_id":task["summary"]["task"]["task_id"],"generation":task["summary"]["attachment"]["generation"]}}))).await;
    f.writer.send(reverse.request,RpcBody::HostResult{result:json!({"status":"ready","completeness":"complete","data":origin("view-one")})}).await.unwrap();
    let mut outcomes = std::collections::BTreeMap::new();
    for _ in 0..2 {
        let frame = f.read().await;
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!()
        };
        assert!(!plan.cancellation_confirmed);
        outcomes.insert(frame.request, plan.outcome);
    }
    assert_eq!(outcomes[&send.request], PluginOutcome::Failed);
    assert_eq!(outcomes[&stop.request], PluginOutcome::Succeeded);
    f.settle(&send, outcomes[&send.request]).await;
    f.settle(&stop, outcomes[&stop.request]).await;
    let receipt = f
        .query(
            "agent.native.receipt",
            json!({"request_id":send_input["request_id"]}),
        )
        .await;
    assert_eq!(receipt["status"], "interrupted");
    assert_eq!(factory.sends.load(Ordering::SeqCst), 1);
    f.release().await;
}

#[tokio::test]
async fn native_release_never_forgets_unconfirmed_process_cleanup_on_retry() {
    let factory = Arc::new(Factory::default());
    let mut f = fixture(factory.clone()).await;
    let created = f.native_create().await;
    f.native_action(
        "native-connect",
        action(json!({"kind":"connect","control":control(&created)})),
    )
    .await;
    factory.refuse_recovery.store(true, Ordering::SeqCst);
    for _ in 0..2 {
        f.writer
            .send(id("failed-release"), RpcBody::Release)
            .await
            .unwrap();
        assert!(matches!(f.read().await.body,RpcBody::Error{code,..} if code == "invalid_input"));
    }
    let Fixture {
        directory,
        environment,
        reader,
        writer,
        task,
    } = f;
    drop(reader);
    drop(writer);
    assert!(task.await.unwrap().is_err());
    assert_eq!(factory.closes.load(Ordering::SeqCst), 1);
    assert!(
        std::path::Path::new(&environment.data_root)
            .join("agent-v1.sqlite")
            .exists()
    );
    drop(directory);
}
#[tokio::test]
async fn native_release_refuses_a_failed_disconnect_even_after_live_entry_is_removed() {
    let factory = Arc::new(Factory::default());
    let mut f = fixture(factory.clone()).await;
    let created = f.native_create().await;
    let connected = f
        .native_action(
            "native-connect",
            action(json!({"kind":"connect","control":control(&created)})),
        )
        .await;
    factory.refuse_recovery.store(true, Ordering::SeqCst);
    let (disconnect, reverse) = f
        .begin(
            "native-disconnect",
            "agent.native.command",
            action(json!({"kind":"disconnect","control":control(&connected)})),
        )
        .await;
    let plan = f.answer(reverse, origin("view-one")).await;
    assert_eq!(plan.outcome, PluginOutcome::Uncertain);
    f.settle(&disconnect, plan.outcome).await;
    assert_eq!(factory.closes.load(Ordering::SeqCst), 1);
    for _ in 0..2 {
        f.writer
            .send(id("failed-release"), RpcBody::Release)
            .await
            .unwrap();
        assert!(
            matches!(f.read().await.body, RpcBody::Error { message, .. } if message.contains("unconfirmed"))
        );
    }
    drop(f.writer);
    drop(f.reader);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), f.task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert_eq!(factory.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_foreign_takeover_requires_revoked_original_view_and_fresh_requesting_caller() {
    let factory = Arc::new(Factory::default());
    factory.hold.store(true, Ordering::SeqCst);
    let mut f = fixture(factory.clone()).await;
    let created = f.native_create().await;
    let draft=f.native_action("takeover-draft", action(json!({"kind":"save_draft","control":control(&created),"version":0,"content":{"text":"Retained turn","assets":[],"context":[]}}))).await;
    let send = f
        .native_send(action(
            json!({"kind":"send","control":control(&draft),"draft_version":1}),
        ))
        .await;
    submitted(&factory).await;
    let running = f
        .query(
            "agent.native.task",
            json!({"task_id":draft["detail"]["summary"]["task"]["task_id"]}),
        )
        .await;
    let task_control = json!({"task_id":running["summary"]["task"]["task_id"],"generation":running["summary"]["attachment"]["generation"]});
    let mut other = origin("view-two");
    other["view"]["window"] = "window-two".into();
    for (name, state) in [
        ("online", "attached"),
        ("closing", "closing"),
        ("unknown", "unknown"),
    ] {
        let (call, reverse) = f
            .begin(
                name,
                "agent.native.command",
                action(json!({"kind":"take_over","control":task_control,"stop":true})),
            )
            .await;
        f.writer
            .send(
                reverse.request,
                RpcBody::HostResult {
                    result: json!({"status":"ready","completeness":"complete","data":other}),
                },
            )
            .await
            .unwrap();
        let presence = f.read().await;
        assert!(
            matches!(&presence.body,RpcBody::HostCall{parent_request,capability,arguments} if parent_request==&call.request && capability==&manifest::key("views.presence") && arguments==&json!({"view":"view-one"}))
        );
        let plan=f.answer(presence,json!({"view":"view-one","window":"window-one","instance":instance().identity,"state":state})).await;
        assert_eq!(plan.outcome, PluginOutcome::Failed);
        assert_eq!(
            factory.sessions.lock().unwrap()[0].snapshot().state,
            "running"
        );
        f.settle(&call, plan.outcome).await;
    }
    // A complete old-view observation cannot preserve a caller which disappeared
    // while it was awaiting that observation.
    let (changed, reverse) = f
        .begin(
            "changed-controller",
            "agent.native.command",
            action(json!({"kind":"take_over","control":task_control,"stop":true})),
        )
        .await;
    f.writer
        .send(
            reverse.request,
            RpcBody::HostResult {
                result: json!({"status":"ready","completeness":"complete","data":other}),
            },
        )
        .await
        .unwrap();
    let presence = f.read().await;
    f.writer.send(presence.request,RpcBody::HostResult{result:json!({"status":"ready","completeness":"complete","data":{"view":"view-one","window":"window-one","instance":instance().identity,"state":"detached"}})}).await.unwrap();
    let recheck = f.read().await;
    assert!(
        matches!(&recheck.body,RpcBody::HostCall{capability,..} if capability==&manifest::key("views.caller"))
    );
    let mut replaced = other.clone();
    replaced["view"]["connection"] = "replacement-connection".into();
    let refused = f.answer(recheck, replaced).await;
    assert_eq!(refused.outcome, PluginOutcome::Failed);
    f.settle(&changed, refused.outcome).await;
    assert_eq!(
        factory.sessions.lock().unwrap()[0].snapshot().state,
        "running"
    );

    let takeover = action(json!({"kind":"take_over","control":task_control,"stop":true}));
    let (accepted, reverse) = f
        .begin(
            "accepted-controller",
            "agent.native.command",
            takeover.clone(),
        )
        .await;
    f.writer
        .send(
            reverse.request,
            RpcBody::HostResult {
                result: json!({"status":"ready","completeness":"complete","data":other}),
            },
        )
        .await
        .unwrap();
    let presence = f.read().await;
    f.writer.send(presence.request,RpcBody::HostResult{result:json!({"status":"ready","completeness":"complete","data":{"view":"view-one","window":"window-one","instance":instance().identity,"state":"closed"}})}).await.unwrap();
    let recheck = f.read().await;
    f.writer
        .send(
            recheck.request,
            RpcBody::HostResult {
                result: json!({"status":"ready","completeness":"complete","data":other}),
            },
        )
        .await
        .unwrap();
    let mut results = std::collections::BTreeMap::new();
    for _ in 0..2 {
        let frame = f.read().await;
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!()
        };
        assert_eq!(
            plan.outcome,
            if frame.request == accepted.request {
                PluginOutcome::Succeeded
            } else {
                PluginOutcome::Failed
            },
            "{plan:?}"
        );
        results.insert(frame.request, plan);
    }
    assert_eq!(results[&send.request].outcome, PluginOutcome::Failed);
    assert_eq!(results[&accepted.request].outcome, PluginOutcome::Succeeded);
    let taken = results[&accepted.request].output.as_ref().unwrap();
    assert_eq!(
        taken["detail"]["summary"]["attachment"]["controller"]["window_id"],
        "window-two"
    );
    assert_eq!(
        taken["detail"]["summary"]["attachment"]["generation"],
        task_control["generation"].as_u64().unwrap() + 1
    );
    f.settle(&send, results[&send.request].outcome).await;
    f.settle(&accepted, results[&accepted.request].outcome)
        .await;
    let (repeat, reverse) = f
        .begin("repeat-controller", "agent.native.command", takeover)
        .await;
    let repeated = f.answer(reverse, other).await;
    assert_eq!(repeated.outcome, PluginOutcome::Succeeded);
    f.settle(&repeat, repeated.outcome).await;
    assert_eq!(factory.sends.load(Ordering::SeqCst), 1);
    assert_eq!(factory.opens.load(Ordering::SeqCst), 1);
    f.release().await;
}
