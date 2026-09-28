use super::*;
use async_trait::async_trait;
use std::sync::{Mutex as SyncMutex, atomic::AtomicUsize};
use tokio::sync::Notify;

#[derive(Default)]
struct Factory {
    opens: AtomicUsize,
    sends: Arc<AtomicUsize>,
    closes: Arc<AtomicUsize>,
    recoveries: AtomicUsize,
    hold: AtomicBool,
    refuse_stop: Arc<AtomicBool>,
    refuse_recovery: AtomicBool,
    sessions: SyncMutex<Vec<Arc<Session>>>,
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
    changed: Notify,
}
#[async_trait]
impl NativeAgentFactory for Factory {
    async fn open(
        &self,
        r: NativeOpenRequest,
    ) -> Result<Arc<dyn NativeAgentSession>, NativeOpenFailure> {
        let number = self.opens.fetch_add(1, Ordering::SeqCst) + 1;
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
struct FaultRepository {
    store: Arc<ApplicationStore>,
    remaining: AtomicUsize,
    failed: AtomicUsize,
    receipts: SyncMutex<Vec<(String, String)>>,
}
impl FaultRepository {
    fn new(store: Arc<ApplicationStore>) -> Self {
        Self { store, remaining: AtomicUsize::new(0), failed: AtomicUsize::new(0), receipts: SyncMutex::new(vec![]) }
    }
    fn arm(&self, failures: usize) { self.remaining.store(failures, Ordering::SeqCst); }
}
impl AgentTaskRepository for FaultRepository {
    fn agent_task(&self, scope: &AgentTaskScope, id: &str) -> Result<Option<StoredAgentTask>, AgentTaskError> { self.store.agent_task(scope, id) }
    fn agent_tasks(&self, scope: &AgentTaskScope, archived: Option<bool>, before: Option<&str>, limit: usize) -> Result<Vec<StoredAgentTask>, AgentTaskError> { self.store.agent_tasks(scope, archived, before, limit) }
    fn agent_task_counts(&self, scope: &AgentTaskScope, host: &str) -> Result<(u32, u32), AgentTaskError> { self.store.agent_task_counts(scope, host) }
    fn agent_draft(&self, scope: &AgentTaskScope, id: &str) -> Result<AgentTaskDraft, AgentTaskError> { self.store.agent_draft(scope, id) }
    fn agent_receipt(&self, scope: &AgentTaskScope, id: &str) -> Result<Option<AgentCommandReceipt>, AgentTaskError> { self.store.agent_receipt(scope, id) }
    fn agent_receipts(&self, scope: &AgentTaskScope, id: &str) -> Result<Vec<AgentCommandReceipt>, AgentTaskError> { self.store.agent_receipts(scope, id) }
    fn agent_events(&self, scope: &AgentTaskScope, id: &str, after: Option<u64>, before: Option<u64>, limit: usize) -> Result<AgentTaskEventPage, AgentTaskError> { self.store.agent_events(scope, id, after, before, limit) }
    fn agent_assets(&self, scope: &AgentTaskScope, id: &str) -> Result<Vec<AgentAsset>, AgentTaskError> { self.store.agent_assets(scope, id) }
    fn agent_asset(&self, scope: &AgentTaskScope, task: &str, asset: &str) -> Result<(AgentAsset, Vec<u8>), AgentTaskError> { self.store.agent_asset(scope, task, asset) }
    fn put_agent_asset(&self, scope: &AgentTaskScope, task: &str, asset: &AgentAsset, bytes: &[u8]) -> Result<(), AgentTaskError> { self.store.put_agent_asset(scope, task, asset, bytes) }
    fn commit_agent_task(&self, scope: &AgentTaskScope, write: AgentTaskWrite<'_>) -> Result<(), AgentTaskError> {
        if !write.events.is_empty() && self.remaining.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
            (left > 0).then(|| left.saturating_sub(1))
        }).is_ok() {
            self.failed.fetch_add(1, Ordering::SeqCst);
            return Err(AgentTaskError::Storage("Injected native event transaction failure".into()));
        }
        let receipts = write.receipts.iter().map(|receipt| (receipt.request_id.clone(), receipt.status.clone())).collect::<Vec<_>>();
        self.store.commit_agent_task(scope, write)?;
        self.receipts.lock().unwrap().extend(receipts);
        Ok(())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    host: Arc<NextHost>,
    store: Arc<ApplicationStore>,
    service: Arc<AgentTaskService>,
    factory: Arc<Factory>,
    faults: Arc<FaultRepository>,
    root: String,
    window: ApplicationWindowRef,
    other: ApplicationWindowRef,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("study");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let db = dir.path().join("state.sqlite");
        let host = Arc::new(
            crate::HostProfile {
                database: db.clone(),
                runtime: crate::RuntimeConfiguration::Project,
                remote: None,
                host_skills: None,
            }
            .open(&root)
            .await
            .unwrap(),
        );
        let store = Arc::new(ApplicationStore::open(&db.with_extension("studio.sqlite")).unwrap());
        let factory = Arc::new(Factory::default());
        let faults = Arc::new(FaultRepository::new(store.clone()));
        let service = AgentTaskService::with_factory(faults.clone(), factory.clone());
        let window = register(&host, "one").await;
        let other = register(&host, "two").await;
        Self {
            _dir: dir,
            host,
            store,
            service,
            factory,
            faults,
            root: root.to_string_lossy().into_owned(),
            window,
            other,
        }
    }
    fn scope(&self) -> AgentTaskScope {
        scope(&self.root, &NextHost::local_context()).unwrap()
    }
    fn request(&self, w: &ApplicationWindowRef, command: AgentTaskCommand) -> AgentTasksCommand {
        AgentTasksCommand {
            project_root: self.root.clone(),
            window: w.clone(),
            request_id: uuid::Uuid::new_v4().to_string(),
            command,
        }
    }
    async fn command(&self, request: AgentTasksCommand) -> AgentTaskCommandResult {
        self.service
            .command(
                self.host.clone(),
                NextHost::local_context(),
                request,
                "http://fixture/mcp".into(),
                "fixture-only".into(),
            )
            .await
            .unwrap()
    }
    async fn create(&self) -> AgentTaskDetail {
        self.command(self.request(
            &self.window,
            AgentTaskCommand::Create {
                provider: AgentProvider::Kimi,
                model: "fixture".into(),
                effort: None,
            },
        ))
        .await
        .detail
    }
    async fn draft(&self, d: &AgentTaskDetail, text: &str) -> AgentTaskDetail {
        self.command(self.request(
            &self.window,
            AgentTaskCommand::SaveDraft {
                control: ctl(d),
                version: d.draft.version,
                content: AgentDraftContent {
                    text: text.into(),
                    ..Default::default()
                },
            },
        ))
        .await
        .detail
    }
    async fn settled(&self, id: &str) -> AgentCommandReceipt {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let r = self
                    .store
                    .agent_receipt(&self.scope(), id)
                    .unwrap()
                    .unwrap();
                if !matches!(r.status.as_str(), "prepared" | "submitted") {
                    return r;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
    fn expire_window(&self) {
        let mut w = self
            .store
            .window(&(&self.scope()).into(), &self.window.window_id)
            .unwrap()
            .unwrap();
        let old = w.revision.clone();
        w.revision = uuid::Uuid::new_v4().to_string();
        w.renewed_at_ms = 0;
        self.store
            .commit(
                &(&self.scope()).into(),
                Some(&old),
                &w,
                &ApplicationStoreChanges::default(),
            )
            .unwrap();
    }
}
fn ctl(d: &AgentTaskDetail) -> AgentTaskControl {
    AgentTaskControl {
        task_id: d.summary.task.task_id.clone(),
        generation: d.summary.attachment.generation,
    }
}
async fn register(host: &NextHost, id: &str) -> ApplicationWindowRef {
    let mut context = NextHost::local_context();
    context.connection_id = format!("studio:{id}");
    let value = host
        .dispatch(
            &context,
            HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
                window_id: id.into(),
                incarnation: uuid::Uuid::new_v4().to_string(),
                label: id.into(),
                previous_session: None,
            }),
        )
        .await
        .unwrap();
    serde_json::from_value::<ApplicationBridgeSession>(value["data"]["session"].clone())
        .unwrap()
        .window
}

#[tokio::test]
async fn task_reads_are_pure_and_instant_completion_cannot_be_reverted_to_submitted() {
    let f = Fixture::new().await;
    let a = f.create().await;
    let b = f.create().await;
    assert_ne!(a.summary.task.task_id, b.summary.task.task_id);
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 0);
    let a = f.draft(&a, "hello").await;
    let req = f.request(
        &f.window,
        AgentTaskCommand::Send {
            control: ctl(&a),
            draft_version: a.draft.version,
        },
    );
    let r = f.command(req.clone()).await;
    f.command(req).await;
    assert_eq!(f.settled(&r.receipt.request_id).await.status, "succeeded");
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 1);
    let d = f
        .service
        .owner
        .detail(&f.scope(), &a.summary.task.task_id)
        .unwrap();
    assert_eq!(d.summary.attachment.state, "ready");
    assert!(d.draft.content.text.is_empty());
    f.service.close().await;
}
#[tokio::test]
async fn connection_budget_never_terminates_another_task() {
    let f = Fixture::new().await;
    for i in 0..9 {
        let d = f.create().await;
        let r = f
            .command(f.request(&f.window, AgentTaskCommand::Connect { control: ctl(&d) }))
            .await;
        let r = f.settled(&r.receipt.request_id).await;
        assert_eq!(r.status, if i < 8 { "succeeded" } else { "failed" });
    }
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 8);
    assert_eq!(f.factory.closes.load(Ordering::SeqCst), 0);
    f.service.close().await;
}
#[tokio::test]
async fn unconfirmed_stop_never_transfers_control_or_starts_a_second_writer() {
    let f = Fixture::new().await;
    f.factory.hold.store(true, Ordering::SeqCst);
    f.factory.refuse_stop.store(true, Ordering::SeqCst);
    let d = f.draft(&f.create().await, "run").await;
    let _sent = f
        .command(f.request(
            &f.window,
            AgentTaskCommand::Send {
                control: ctl(&d),
                draft_version: d.draft.version,
            },
        ))
        .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.factory.sends.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    f.expire_window();
    let d = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    let r = f
        .command(f.request(
            &f.other,
            AgentTaskCommand::TakeOver {
                control: ctl(&d),
                stop: true,
            },
        ))
        .await;
    assert_eq!(f.settled(&r.receipt.request_id).await.status, "uncertain");
    let d = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    assert_eq!(d.summary.attachment.controller.window_id, "one");
    assert!(d.summary.attachment.control_frozen);
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 1);
    f.service.close().await;
}
#[tokio::test]
async fn restart_keeps_the_original_submission_when_a_later_draft_exists() {
    let f = Fixture::new().await;
    f.factory.hold.store(true, Ordering::SeqCst);
    let d = f.draft(&f.create().await, "original").await;
    let sent = f
        .command(f.request(
            &f.window,
            AgentTaskCommand::Send {
                control: ctl(&d),
                draft_version: d.draft.version,
            },
        ))
        .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.factory.sends.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let d = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    let d = f.draft(&d, "next draft").await;
    let restarted = AgentTaskService::with_factory(f.store.clone(), f.factory.clone());
    let restored = restarted
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    assert_eq!(restored.draft.content.text, "next draft");
    assert_eq!(restored.summary.attachment.state, "disconnected");
    let receipt = restored
        .receipts
        .iter()
        .find(|r| r.request_id == sent.receipt.request_id)
        .unwrap();
    assert_eq!(receipt.status, "uncertain");
    assert_eq!(receipt.submitted_draft.as_ref().unwrap().text, "original");
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 1);
    f.service.close().await;
}
#[tokio::test]
async fn late_connection_after_shutdown_is_closed_without_sending() {
    let f = Fixture::new().await;
    f.factory.delay.store(true, Ordering::SeqCst);
    let d = f.create().await;
    let r = f
        .command(f.request(&f.window, AgentTaskCommand::Connect { control: ctl(&d) }))
        .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.factory.opens.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    f.service.close().await;
    f.factory.release.notify_waiters();
    assert_eq!(f.settled(&r.receipt.request_id).await.status, "failed");
    assert_eq!(f.factory.closes.load(Ordering::SeqCst), 1);
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn context_file_capture_uses_owner_identity_and_rejects_changed_or_escaped_files() {
    let f = Fixture::new().await;
    let path = std::path::Path::new(&f.root).join("notes.txt");
    std::fs::write(&path, "verified context").unwrap();
    let context = NextHost::local_context();
    let reader = crate::AgentContextReader::new(&f.root, &f.host, &context);
    let (items, notices) =
        crate::agent_context::search(&reader, &f.window, Some("files"), "notes", 10, &[])
            .await
            .unwrap();
    assert!(notices.is_empty());
    assert_eq!(items.len(), 1);
    let captured =
        crate::agent_context::preview(&reader, &f.window, &items[0].selection, &[], false)
            .await
            .unwrap();
    assert_eq!(captured.text, "verified context");
    assert!(
        captured.selection.reference["expected_sha256"]
            .as_str()
            .is_some()
    );
    std::fs::write(&path, "changed since preview").unwrap();
    assert!(
        crate::agent_context::preview(&reader, &f.window, &captured.selection, &[], true)
            .await
            .is_err()
    );
    let mut escaped = items[0].selection.clone();
    escaped.reference = json!({"path":"../state.sqlite"});
    assert!(
        crate::agent_context::preview(&reader, &f.window, &escaped, &[], false)
            .await
            .is_err()
    );
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn confirmed_stop_takeover_preserves_draft_and_rejects_the_old_window() {
    let f = Fixture::new().await;
    f.factory.hold.store(true, Ordering::SeqCst);
    let d = f.draft(&f.create().await, "active request").await;
    let sent = f
        .command(f.request(
            &f.window,
            AgentTaskCommand::Send {
                control: ctl(&d),
                draft_version: d.draft.version,
            },
        ))
        .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.factory.sends.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let d = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    let d = f.draft(&d, "saved next instruction").await;
    f.expire_window();
    let transfer = f
        .command(f.request(
            &f.other,
            AgentTaskCommand::TakeOver {
                control: ctl(&d),
                stop: true,
            },
        ))
        .await;
    assert_eq!(
        f.settled(&transfer.receipt.request_id).await.status,
        "succeeded"
    );
    let latest = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    assert_eq!(latest.summary.attachment.controller.window_id, "two");
    assert!(latest.summary.attachment.generation > d.summary.attachment.generation);
    assert_eq!(latest.draft.content.text, "saved next instruction");
    assert_eq!(
        f.store
            .agent_receipt(&f.scope(), &sent.receipt.request_id)
            .unwrap()
            .unwrap()
            .status,
        "interrupted"
    );
    let old = f.request(
        &f.window,
        AgentTaskCommand::Send {
            control: ctl(&d),
            draft_version: d.draft.version,
        },
    );
    assert!(
        f.service
            .command(
                f.host.clone(),
                NextHost::local_context(),
                old,
                "http://fixture/mcp".into(),
                "fixture".into()
            )
            .await
            .is_err()
    );
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn disconnected_metadata_cannot_bypass_unconfirmed_process_ownership() {
    let f = Fixture::new().await;
    let d = f.create().await;
    let c = f
        .command(f.request(&f.window, AgentTaskCommand::Connect { control: ctl(&d) }))
        .await;
    f.settled(&c.receipt.request_id).await;
    let restarted = AgentTaskService::with_factory(f.store.clone(), f.factory.clone());
    f.factory.refuse_recovery.store(true, Ordering::SeqCst);
    let d = restarted
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    let req = f.request(&f.window, AgentTaskCommand::Disconnect { control: ctl(&d) });
    let result = restarted
        .command(
            f.host.clone(),
            NextHost::local_context(),
            req,
            "http://fixture/mcp".into(),
            "fixture".into(),
        )
        .await
        .unwrap();
    assert_eq!(
        f.settled(&result.receipt.request_id).await.status,
        "uncertain"
    );
    assert!(
        !restarted
            .owner
            .get(&f.scope(), &d.summary.task.task_id)
            .unwrap()
            .native_quiet
    );
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 1);
    f.factory.refuse_recovery.store(false, Ordering::SeqCst);
    f.service.close().await;
}
#[tokio::test]
async fn uncertain_live_attachment_resume_uses_a_new_verified_process() {
    let f = Fixture::new().await;
    let d = f.create().await;
    let c = f
        .command(f.request(&f.window, AgentTaskCommand::Connect { control: ctl(&d) }))
        .await;
    f.settled(&c.receipt.request_id).await;
    let d = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    let native = d.summary.task.native_session_id.clone();
    let c = f
        .command(f.request(&f.window, AgentTaskCommand::Resume { control: ctl(&d) }))
        .await;
    f.settled(&c.receipt.request_id).await;
    let restored = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    assert_eq!(restored.summary.task.native_session_id, native);
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 2);
    assert!(f.factory.recoveries.load(Ordering::SeqCst) > 0);
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 0);
    f.service.close().await;
}

struct InformationPlugin;
#[async_trait]
impl crate::AgentContextProvider for InformationPlugin {
    fn source(&self) -> AgentContextSource {
        AgentContextSource {
            id: "plugin.fixture".into(),
            name: "Fixture information".into(),
            plugin: true,
        }
    }
    async fn search(
        &self,
        reader: &crate::AgentContextReader<'_>,
        _: &ApplicationWindowRef,
        _: &str,
        _: u32,
    ) -> Result<Vec<AgentContextItem>, String> {
        reader
            .query("project.list_directory", json!({"path":"","limit":1}))
            .await?;
        Ok(vec![AgentContextItem {
            title: "Plugin result".into(),
            description: "Fixture · owner-backed text".into(),
            kind: "text".into(),
            selection: AgentContextSelection {
                source: self.source().id,
                label: "Plugin result".into(),
                reference: json!({"path":"plugin.txt"}),
                inclusion: "text".into(),
            },
        }])
    }
    async fn preview(
        &self,
        reader: &crate::AgentContextReader<'_>,
        _: &ApplicationWindowRef,
        selection: &AgentContextSelection,
    ) -> Result<AgentContextPreview, String> {
        let data = reader
            .query(
                "project.read_file",
                json!({"path":selection.reference["path"],"offset":0,"limit_bytes":128}),
            )
            .await?;
        let file: FilePage = serde_json::from_value(data).map_err(|e| e.to_string())?;
        Ok(AgentContextPreview {
            selection: selection.clone(),
            title: selection.label.clone(),
            description: "Fixture plugin".into(),
            text: String::from_utf8(file.bytes).map_err(|e| e.to_string())?,
            native_data: json!(file.file),
            columns: vec![],
            rows: vec![],
            image_base64: None,
            image_mime_type: None,
            inclusions: vec!["text".into()],
            truncated: false,
        })
    }
}
#[tokio::test]
async fn plugin_information_channels_use_the_read_port_and_preserve_project_containment() {
    let f = Fixture::new().await;
    std::fs::write(
        std::path::Path::new(&f.root).join("plugin.txt"),
        "owned plugin information",
    )
    .unwrap();
    f.service
        .register_context_provider(Arc::new(InformationPlugin))
        .unwrap();
    assert!(
        f.service
            .register_context_provider(Arc::new(InformationPlugin))
            .is_err()
    );
    let context = NextHost::local_context();
    let reader = crate::AgentContextReader::new(&f.root, &f.host, &context);
    let providers = f.service.context_providers.read().unwrap().clone();
    let (items, notices) =
        crate::agent_context::search(&reader, &f.window, Some("plugins"), "", 10, &providers)
            .await
            .unwrap();
    assert!(notices.is_empty());
    assert_eq!(items.len(), 1);
    let preview =
        crate::agent_context::preview(&reader, &f.window, &items[0].selection, &providers, false)
            .await
            .unwrap();
    assert_eq!(preview.text, "owned plugin information");
    let parts = crate::agent_context::input(preview).unwrap();
    assert!(
        matches!(&parts[0],NativeInput::Resource{uri,..} if uri.starts_with("rho://context/plugin.fixture/"))
    );
    let mut escaped = items[0].selection.clone();
    escaped.reference = json!({"path":"../state.sqlite"});
    assert!(
        crate::agent_context::preview(&reader, &f.window, &escaped, &providers, false)
            .await
            .is_err()
    );
    assert!(
        reader
            .query("project.apply_patch", json!({}))
            .await
            .is_err()
    );
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn task_gates_retain_one_lock_for_waiters_and_release_unused_entries() {
    let f = Fixture::new().await;
    let first = f.service.gate("same-task").await;
    let waiter = f.service.gate("same-task").await;
    assert!(Arc::ptr_eq(&first, &waiter));
    let held = first.clone().lock_owned().await;
    let weak = Arc::downgrade(&first);
    drop(first);
    let waiting = tokio::spawn(async move { waiter.lock_owned().await });
    tokio::task::yield_now().await;
    let observed = f.service.gate("same-task").await;
    assert!(Arc::ptr_eq(&observed, &weak.upgrade().unwrap()));
    assert!(observed.try_lock().is_err());
    assert!(!waiting.is_finished());
    drop(observed);
    drop(held);
    let acquired = waiting.await.unwrap();
    let while_waiter_owns = f.service.gate("same-task").await;
    assert!(while_waiter_owns.try_lock().is_err());
    drop(while_waiter_owns);
    drop(acquired);
    assert!(weak.upgrade().is_none());
    let other = f.service.gate("different-task").await;
    assert!(!f.service.gates.lock().await.contains_key("same-task"));
    let replacement = f.service.gate("same-task").await;
    assert!(!Arc::ptr_eq(&other, &replacement));
    f.service.close().await;
}

async fn wait_for_native_observation(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !condition() { tokio::task::yield_now().await; }
    }).await.unwrap();
}

#[tokio::test]
async fn send_acknowledgement_write_failure_is_uncertain_and_observation_does_not_resend() {
    let f = Fixture::new().await;
    let d = f.draft(&f.create().await, "deliver only once").await;
    f.faults.arm(1);
    let request = f.request(&f.window, AgentTaskCommand::Send { control: ctl(&d), draft_version: d.draft.version });
    let original = f.command(request.clone()).await;
    wait_for_native_observation(|| f.store.agent_receipt(&f.scope(), &original.receipt.request_id).unwrap().is_some_and(|r| r.status == "succeeded")).await;
    let receipts = f.faults.receipts.lock().unwrap().clone();
    let statuses: Vec<_> = receipts.iter().filter(|(id, _)| id == &original.receipt.request_id).map(|(_, status)| status.as_str()).collect();
    assert!(statuses.contains(&"uncertain"), "post-send failure must retain uncertainty before recovery: {statuses:?}");
    assert!(!statuses.contains(&"failed"));
    assert_eq!(f.faults.failed.load(Ordering::SeqCst), 1);
    assert!(f.store.agent_draft(&f.scope(), &d.summary.task.task_id).unwrap().content.text.is_empty());
    let page = f.store.agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100).unwrap();
    assert_eq!(page.events.iter().filter(|e| e.request_id.as_ref() == Some(&original.receipt.request_id)).count(), 2);
    assert!(page.events.iter().any(|e| e.role.as_deref() == Some("assistant") && e.text == "ok"));
    f.command(request).await;
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn persistent_post_send_failure_keeps_original_request_draft_and_cursor_for_recovery() {
    let f = Fixture::new().await;
    let d = f.draft(&f.create().await, "preserve submitted draft").await;
    f.faults.arm(usize::MAX);
    let request = f.request(&f.window, AgentTaskCommand::Send { control: ctl(&d), draft_version: d.draft.version });
    let original = f.command(request.clone()).await;
    wait_for_native_observation(|| f.faults.failed.load(Ordering::SeqCst) >= 2).await;
    let receipt = f.store.agent_receipt(&f.scope(), &original.receipt.request_id).unwrap().unwrap();
    assert_eq!(receipt.status, "uncertain");
    assert_eq!(receipt.submitted_draft.as_ref().unwrap().text, "preserve submitted draft");
    assert_eq!(f.store.agent_draft(&f.scope(), &d.summary.task.task_id).unwrap().content.text, "preserve submitted draft");
    let live = f.service.live.lock().await.get(&d.summary.task.task_id).unwrap().clone();
    assert_eq!(live.cursor.load(Ordering::Acquire), 0);
    assert!(f.store.agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100).unwrap().events.is_empty());
    f.command(request).await;
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    let current = f.service.owner.detail(&f.scope(), &d.summary.task.task_id).unwrap();
    f.draft(&current, "newer user draft").await;
    f.faults.arm(0);
    f.factory.sessions.lock().unwrap()[0].changed.notify_waiters();
    wait_for_native_observation(|| f.store.agent_receipt(&f.scope(), &original.receipt.request_id).unwrap().is_some_and(|r| r.status == "succeeded")).await;
    assert_eq!(live.cursor.load(Ordering::Acquire), 2);
    assert_eq!(f.store.agent_draft(&f.scope(), &d.summary.task.task_id).unwrap().content.text, "newer user draft");
    assert_eq!(f.store.agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100).unwrap().events.len(), 2);
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn disconnected_final_events_remain_live_until_the_sqlite_transaction_succeeds() {
    let f = Fixture::new().await;
    f.factory.hold.store(true, Ordering::SeqCst);
    let d = f.draft(&f.create().await, "finish later").await;
    let original = f.command(f.request(&f.window, AgentTaskCommand::Send { control: ctl(&d), draft_version: d.draft.version })).await;
    wait_for_native_observation(|| f.store.agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100).unwrap().events.len() == 1).await;
    let live = f.service.live.lock().await.get(&d.summary.task.task_id).unwrap().clone();
    f.faults.arm(usize::MAX);
    let session = f.factory.sessions.lock().unwrap()[0].clone();
    {
        let mut state = session.state.lock().unwrap();
        session.events.lock().unwrap().push(NativeEvent {
            usage: None, cursor: 2, key: "final-native-event".into(), request_id: Some(original.receipt.request_id.clone()),
            session: state.native_session_id.clone(), turn: Some("final-turn".into()), item: None, kind: "message".into(), role: Some("assistant".into()),
            text: "final output retained".into(), status: None, historical: false, at_ms: now(),
        });
        state.state = "disconnected".into();
    }
    session.changed.notify_waiters();
    wait_for_native_observation(|| f.faults.failed.load(Ordering::SeqCst) >= 2).await;
    assert_eq!(live.cursor.load(Ordering::Acquire), 1);
    assert!(!live.closed.load(Ordering::Acquire));
    assert!(f.service.live.lock().await.contains_key(&d.summary.task.task_id));
    assert_eq!(f.store.agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100).unwrap().events.len(), 1);
    f.faults.arm(0);
    session.changed.notify_waiters();
    wait_for_native_observation(|| live.closed.load(Ordering::Acquire)).await;
    assert_eq!(live.cursor.load(Ordering::Acquire), 2);
    assert!(!f.service.live.lock().await.contains_key(&d.summary.task.task_id));
    let page = f.store.agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100).unwrap();
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.events.iter().filter(|e| e.text == "final output retained").count(), 1);
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn late_post_send_storage_error_cannot_regress_an_observed_terminal_receipt() {
    let f = Fixture::new().await;
    let d = f.draft(&f.create().await, "already confirmed").await;
    let original = f.command(f.request(&f.window, AgentTaskCommand::Send { control: ctl(&d), draft_version: d.draft.version })).await;
    wait_for_native_observation(|| f.store.agent_receipt(&f.scope(), &original.receipt.request_id).unwrap().is_some_and(|r| r.status == "succeeded")).await;
    let current = f.service.owner.detail(&f.scope(), &d.summary.task.task_id).unwrap();
    f.service.fail(&f.scope(), &d.summary.task.task_id, current.summary.attachment.generation, &original.receipt,
        TaskFailure::uncertain("late error from an earlier failed acknowledgement write"), None).unwrap();
    let receipt = f.store.agent_receipt(&f.scope(), &original.receipt.request_id).unwrap().unwrap();
    assert_eq!(receipt.status, "succeeded");
    assert!(receipt.error.is_none());
    assert!(receipt.submitted_draft.is_none());
    assert_eq!(f.service.owner.detail(&f.scope(), &d.summary.task.task_id).unwrap().summary.attachment.state, "ready");
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn scientific_work_preserves_read_scope_and_does_not_guess_legacy_task_attribution() {
    let f=Fixture::new().await;
    let created=f.create().await; let id=created.summary.task.task_id;
    let request=AgentTasksQuery{project_root:f.root.clone(),query:AgentTaskQuery::ScientificWork{task_id:id.clone(),limit:8}};
    let mut limited=NextHost::local_context(); limited.scopes.remove("operation.read");
    let denied=f.service.query(&f.host,&limited,request.clone()).await.unwrap_err();
    assert_eq!(denied.diagnostic().code,DiagnosticCode::AccessDenied);
    let observed=f.service.query(&f.host,&NextHost::local_context(),request.clone()).await.unwrap();
    assert!(matches!(observed,AgentTaskQueryResult::ScientificWork{work} if work.attributable && work.operations.is_empty()));
    let mut stored=f.store.agent_task(&f.scope(),&id).unwrap().unwrap(); let previous=stored.revision.clone();
    stored.task_mcp_identity=false; stored.revision=uuid::Uuid::new_v4().to_string(); stored.observation_version+=1;
    f.store.commit_agent_task(&f.scope(),AgentTaskWrite{expected_revision:Some(&previous),task:&stored,draft:None,receipts:&[],events:&[]}).unwrap();
    let legacy=f.service.query(&f.host,&NextHost::local_context(),request).await.unwrap();
    assert!(matches!(legacy,AgentTaskQueryResult::ScientificWork{work} if !work.attributable && work.operations.is_empty()));
}

async fn assert_takeover_preserves_native_transport_until_disconnect(stop: bool) {
    let f = Fixture::new().await;
    f.factory.hold.store(stop, Ordering::SeqCst);
    let initial = f.create().await;
    let task_id = initial.summary.task.task_id.clone();
    if stop {
        let draft = f.draft(&initial, "original running instruction").await;
        f.command(f.request(&f.window, AgentTaskCommand::Send { control: ctl(&draft), draft_version: draft.draft.version })).await;
        wait_for_native_observation(|| f.factory.sends.load(Ordering::SeqCst) == 1).await;
    } else {
        let connected = f.command(f.request(&f.window, AgentTaskCommand::Connect { control: ctl(&initial) })).await;
        assert_eq!(f.settled(&connected.receipt.request_id).await.status, "succeeded");
    }
    let before = f.service.owner.detail(&f.scope(), &task_id).unwrap();
    let live = f.service.live.lock().await.get(&task_id).unwrap().clone();
    let token = live.mcp.token.clone();
    let identity = f.service.mcp_connections.resolve(&token).unwrap();
    let native = live.session.snapshot();
    f.expire_window();
    let transfer = f.command(f.request(&f.other, AgentTaskCommand::TakeOver { control: ctl(&before), stop })).await;
    assert_eq!(f.settled(&transfer.receipt.request_id).await.status, "succeeded");
    let controlled = f.service.owner.detail(&f.scope(), &task_id).unwrap();
    assert_eq!(controlled.summary.attachment.controller, f.other.clone().into());
    assert!(controlled.summary.attachment.generation > before.summary.attachment.generation);
    let current_live = f.service.live.lock().await.get(&task_id).unwrap().clone();
    assert!(Arc::ptr_eq(&live, &current_live));
    assert!(Arc::ptr_eq(&live.session, &current_live.session));
    assert_eq!(current_live.session.snapshot().native_session_id, native.native_session_id);
    assert_eq!(current_live.session.snapshot().window, AgentControllerRef::from(f.other.clone()));
    assert_eq!(current_live.mcp.token, token);
    assert_eq!(f.service.mcp_connections.resolve(&token).unwrap().context.connection_id, identity.context.connection_id);
    assert!(identity.is_valid());
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 1);

    // A fresh heartbeat cannot restore the old window's control. Check both its
    // old generation and a guessed current generation against the real owner.
    let mut old_window = f.store.window(&(&f.scope()).into(), &f.window.window_id).unwrap().unwrap();
    let old_revision = old_window.revision.clone();
    old_window.revision = uuid::Uuid::new_v4().to_string();
    old_window.renewed_at_ms = now();
    f.store.commit(&(&f.scope()).into(), Some(&old_revision), &old_window, &ApplicationStoreChanges::default()).unwrap();
    for control in [ctl(&before), ctl(&controlled)] {
        let rejected = f.request(&f.window, AgentTaskCommand::Send { control, draft_version: controlled.draft.version });
        assert!(f.service.command(f.host.clone(), NextHost::local_context(), rejected,
            "http://fixture/mcp".into(), "fixture-only".into()).await.is_err());
    }
    let draft = f.command(f.request(&f.other, AgentTaskCommand::SaveDraft { control: ctl(&controlled), version: controlled.draft.version,
        content: AgentDraftContent { text: "new controller instruction".into(), ..Default::default() } })).await.detail;
    let sent = f.command(f.request(&f.other, AgentTaskCommand::Send { control: ctl(&draft), draft_version: draft.draft.version })).await;
    let expected_sends = if stop { 2 } else { 1 };
    wait_for_native_observation(|| f.factory.sends.load(Ordering::SeqCst) == expected_sends).await;
    if stop {
        let current = f.service.owner.detail(&f.scope(), &task_id).unwrap();
        let stopped = f.command(f.request(&f.other, AgentTaskCommand::Stop { control: ctl(&current) })).await;
        assert_eq!(f.settled(&stopped.receipt.request_id).await.status, "succeeded");
    } else {
        assert_eq!(f.settled(&sent.receipt.request_id).await.status, "succeeded");
    }
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 1);
    assert_eq!(live.session.snapshot().native_session_id, native.native_session_id);
    assert!(identity.is_valid());
    assert_eq!(f.service.mcp_connections.resolve(&token).unwrap().context.connection_id, identity.context.connection_id);

    let current = f.service.owner.detail(&f.scope(), &task_id).unwrap();
    let disconnect = f.command(f.request(&f.other, AgentTaskCommand::Disconnect { control: ctl(&current) })).await;
    assert_eq!(f.settled(&disconnect.receipt.request_id).await.status, "succeeded");
    assert!(!identity.is_valid());
    assert!(f.service.mcp_connections.resolve(&token).is_none());
    let disconnected = f.service.owner.detail(&f.scope(), &task_id).unwrap();
    let resume = f.command(f.request(&f.other, AgentTaskCommand::Resume { control: ctl(&disconnected) })).await;
    assert_eq!(f.settled(&resume.receipt.request_id).await.status, "succeeded");
    let resumed = f.service.live.lock().await.get(&task_id).unwrap().clone();
    let resumed_identity = f.service.mcp_connections.resolve(&resumed.mcp.token).unwrap();
    assert_ne!(resumed.mcp.token, token);
    assert_ne!(resumed_identity.context.connection_id, identity.context.connection_id);
    assert_eq!(resumed_identity.context.caller, identity.context.caller);
    assert_eq!(resumed.session.snapshot().native_session_id, native.native_session_id);
    assert_eq!(f.factory.opens.load(Ordering::SeqCst), 2);
    f.service.close().await;
}

#[tokio::test]
async fn idle_takeover_preserves_native_session_and_mcp_lease_but_fences_old_controller() {
    assert_takeover_preserves_native_transport_until_disconnect(false).await;
}

#[tokio::test]
async fn stop_takeover_preserves_native_session_and_mcp_lease_but_fences_old_controller() {
    assert_takeover_preserves_native_transport_until_disconnect(true).await;
}
