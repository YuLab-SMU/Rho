use super::*;
use rho_agent_store::AgentStore;
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
    refuse_open: AtomicBool,
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
    store: Arc<AgentStore>,
    remaining: AtomicUsize,
    failed: AtomicUsize,
    refuse_registration: AtomicBool,
    receipts: SyncMutex<Vec<(String, String)>>,
}
impl FaultRepository {
    fn new(store: Arc<AgentStore>) -> Self {
        Self {
            store,
            remaining: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            refuse_registration: AtomicBool::new(false),
            receipts: SyncMutex::new(vec![]),
        }
    }
    fn arm(&self, failures: usize) {
        self.remaining.store(failures, Ordering::SeqCst);
    }
}
impl AgentTaskRepository for FaultRepository {
    fn agent_task(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<StoredAgentTask>, AgentTaskError> {
        self.store.agent_task(scope, id)
    }
    fn agent_tasks(
        &self,
        scope: &AgentTaskScope,
        archived: Option<bool>,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<StoredAgentTask>, AgentTaskError> {
        self.store.agent_tasks(scope, archived, before, limit)
    }
    fn agent_task_counts(
        &self,
        scope: &AgentTaskScope,
        host: &str,
    ) -> Result<(u32, u32), AgentTaskError> {
        self.store.agent_task_counts(scope, host)
    }
    fn agent_draft(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<AgentTaskDraft, AgentTaskError> {
        self.store.agent_draft(scope, id)
    }
    fn agent_receipt(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<AgentCommandReceipt>, AgentTaskError> {
        self.store.agent_receipt(scope, id)
    }
    fn agent_receipts(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Vec<AgentCommandReceipt>, AgentTaskError> {
        self.store.agent_receipts(scope, id)
    }
    fn agent_events(
        &self,
        scope: &AgentTaskScope,
        id: &str,
        after: Option<u64>,
        before: Option<u64>,
        limit: usize,
    ) -> Result<AgentTaskEventPage, AgentTaskError> {
        self.store.agent_events(scope, id, after, before, limit)
    }
    fn agent_assets(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Vec<AgentAsset>, AgentTaskError> {
        self.store.agent_assets(scope, id)
    }
    fn agent_asset(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), AgentTaskError> {
        self.store.agent_asset(scope, task, asset)
    }
    fn put_agent_asset(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        asset: &AgentAsset,
        bytes: &[u8],
    ) -> Result<(), AgentTaskError> {
        self.store.put_agent_asset(scope, task, asset, bytes)
    }
    fn commit_agent_task(
        &self,
        scope: &AgentTaskScope,
        write: AgentTaskWrite<'_>,
    ) -> Result<(), AgentTaskError> {
        if write.receipts.is_empty()
            && write.task.process.is_some()
            && !write.task.native_quiet
            && self.refuse_registration.swap(false, Ordering::SeqCst)
        {
            return Err(AgentTaskError::Storage(
                "Injected connection registration failure".into(),
            ));
        }
        if !write.events.is_empty()
            && self
                .remaining
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    (left > 0).then(|| left.saturating_sub(1))
                })
                .is_ok()
        {
            self.failed.fetch_add(1, Ordering::SeqCst);
            return Err(AgentTaskError::Storage(
                "Injected native event transaction failure".into(),
            ));
        }
        let receipts = write
            .receipts
            .iter()
            .map(|receipt| (receipt.request_id.clone(), receipt.status.clone()))
            .collect::<Vec<_>>();
        self.store.commit_agent_task(scope, write)?;
        self.receipts.lock().unwrap().extend(receipts);
        Ok(())
    }
}

#[derive(Default)]
struct Lease {
    revoked: AtomicBool,
}
impl NativeConnectionLease for Lease {
    fn revoke(&self) {
        self.revoked.store(true, Ordering::SeqCst);
    }
}
#[derive(Default)]
struct Port {
    leases: SyncMutex<Vec<Arc<Lease>>>,
}
#[async_trait]
impl NativeTaskPort for Port {
    async fn input(
        &self,
        _: &AgentTaskScope,
        _: &StoredAgentTask,
        draft: &AgentTaskDraft,
    ) -> Result<Vec<NativeInput>, NativeTaskFailure> {
        Ok(vec![NativeInput::Text(draft.content.text.clone())])
    }
    async fn endpoint(
        &self,
        _: &AgentTaskScope,
        _: &StoredAgentTask,
    ) -> Result<NativeTaskEndpoint, NativeTaskFailure> {
        let lease = Arc::new(Lease::default());
        self.leases.lock().unwrap().push(lease.clone());
        Ok(NativeTaskEndpoint {
            url: "http://fixture/mcp".into(),
            token: "fixture-only".into(),
            lease,
        })
    }
}
struct Fixture {
    _dir: tempfile::TempDir,
    store: Arc<AgentStore>,
    service: Arc<NativeTaskRuntime>,
    factory: Arc<Factory>,
    faults: Arc<FaultRepository>,
    port: Arc<Port>,
    root: String,
    window: AgentControllerRef,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
        let factory = Arc::new(Factory::default());
        let faults = Arc::new(FaultRepository::new(store.clone()));
        let owner = Arc::new(AgentTaskOwner::new(faults.clone()));
        let service = NativeTaskRuntime::new(owner, factory.clone());
        Self {
            _dir: directory,
            root,
            store,
            service,
            factory,
            faults,
            port: Arc::default(),
            window: AgentControllerRef {
                window_id: "one".into(),
                incarnation: "original-one".into(),
            },
        }
    }
    fn scope(&self) -> AgentTaskScope {
        AgentTaskScope {
            project: self.root.clone(),
            principal: "fixture-principal".into(),
        }
    }
    fn request(&self, window: &AgentControllerRef, command: AgentTaskCommand) -> AgentTaskRequest {
        AgentTaskRequest {
            project_root: self.root.clone(),
            window: window.clone(),
            request_id: uuid::Uuid::new_v4().to_string(),
            command,
        }
    }
    async fn command(&self, request: AgentTaskRequest) -> AgentTaskCommandResult {
        let scope = self.scope();
        let admitted = self.service.owner.admit(&scope, &request, now()).unwrap();
        let receipt = admitted.receipt.clone();
        if !admitted.native
            && !admitted.repeated
            && matches!(
                request.command,
                AgentTaskCommand::TakeOver { stop: false, .. }
            )
        {
            self.service
                .rebind(
                    &receipt.task_id,
                    request.window.clone(),
                    admitted.task.attachment.generation,
                )
                .await;
        }
        let _ = self
            .service
            .launch(scope.clone(), request, admitted, self.port.clone());
        AgentTaskCommandResult {
            detail: self.service.owner.detail(&scope, &receipt.task_id).unwrap(),
            receipt,
        }
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
    async fn draft(&self, detail: &AgentTaskDetail, text: &str) -> AgentTaskDetail {
        self.command(self.request(
            &self.window,
            AgentTaskCommand::SaveDraft {
                control: ctl(detail),
                version: detail.draft.version,
                content: AgentDraftContent {
                    text: text.into(),
                    ..Default::default()
                },
            },
        ))
        .await
        .detail
    }
}
fn ctl(detail: &AgentTaskDetail) -> AgentTaskControl {
    AgentTaskControl {
        task_id: detail.summary.task.task_id.clone(),
        generation: detail.summary.attachment.generation,
    }
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
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn send_acknowledgement_write_failure_is_uncertain_and_observation_does_not_resend() {
    let f = Fixture::new().await;
    let d = f.draft(&f.create().await, "deliver only once").await;
    f.faults.arm(1);
    let request = f.request(
        &f.window,
        AgentTaskCommand::Send {
            control: ctl(&d),
            draft_version: d.draft.version,
        },
    );
    let original = f.command(request.clone()).await;
    wait_for_native_observation(|| {
        f.store
            .agent_receipt(&f.scope(), &original.receipt.request_id)
            .unwrap()
            .is_some_and(|r| r.status == "succeeded")
    })
    .await;
    let receipts = f.faults.receipts.lock().unwrap().clone();
    let statuses: Vec<_> = receipts
        .iter()
        .filter(|(id, _)| id == &original.receipt.request_id)
        .map(|(_, status)| status.as_str())
        .collect();
    assert!(
        statuses.contains(&"uncertain"),
        "post-send failure must retain uncertainty before recovery: {statuses:?}"
    );
    assert!(!statuses.contains(&"failed"));
    assert_eq!(f.faults.failed.load(Ordering::SeqCst), 1);
    assert!(
        f.store
            .agent_draft(&f.scope(), &d.summary.task.task_id)
            .unwrap()
            .content
            .text
            .is_empty()
    );
    let page = f
        .store
        .agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100)
        .unwrap();
    assert_eq!(
        page.events
            .iter()
            .filter(|e| e.request_id.as_ref() == Some(&original.receipt.request_id))
            .count(),
        2
    );
    assert!(
        page.events
            .iter()
            .any(|e| e.role.as_deref() == Some("assistant") && e.text == "ok")
    );
    f.command(request).await;
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn persistent_post_send_failure_keeps_original_request_draft_and_cursor_for_recovery() {
    let f = Fixture::new().await;
    let d = f.draft(&f.create().await, "preserve submitted draft").await;
    f.faults.arm(usize::MAX);
    let request = f.request(
        &f.window,
        AgentTaskCommand::Send {
            control: ctl(&d),
            draft_version: d.draft.version,
        },
    );
    let original = f.command(request.clone()).await;
    wait_for_native_observation(|| f.faults.failed.load(Ordering::SeqCst) >= 2).await;
    let receipt = f
        .store
        .agent_receipt(&f.scope(), &original.receipt.request_id)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.status, "uncertain");
    assert_eq!(
        receipt.submitted_draft.as_ref().unwrap().text,
        "preserve submitted draft"
    );
    assert_eq!(
        f.store
            .agent_draft(&f.scope(), &d.summary.task.task_id)
            .unwrap()
            .content
            .text,
        "preserve submitted draft"
    );
    let live = f
        .service
        .live
        .lock()
        .await
        .get(&d.summary.task.task_id)
        .unwrap()
        .clone();
    assert_eq!(live.cursor.load(Ordering::Acquire), 0);
    assert!(
        f.store
            .agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100)
            .unwrap()
            .events
            .is_empty()
    );
    f.command(request).await;
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    let current = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    f.draft(&current, "newer user draft").await;
    f.faults.arm(0);
    f.factory.sessions.lock().unwrap()[0]
        .changed
        .notify_waiters();
    wait_for_native_observation(|| {
        f.store
            .agent_receipt(&f.scope(), &original.receipt.request_id)
            .unwrap()
            .is_some_and(|r| r.status == "succeeded")
    })
    .await;
    assert_eq!(live.cursor.load(Ordering::Acquire), 2);
    assert_eq!(
        f.store
            .agent_draft(&f.scope(), &d.summary.task.task_id)
            .unwrap()
            .content
            .text,
        "newer user draft"
    );
    assert_eq!(
        f.store
            .agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100)
            .unwrap()
            .events
            .len(),
        2
    );
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn disconnected_final_events_remain_live_until_the_sqlite_transaction_succeeds() {
    let f = Fixture::new().await;
    f.factory.hold.store(true, Ordering::SeqCst);
    let d = f.draft(&f.create().await, "finish later").await;
    let original = f
        .command(f.request(
            &f.window,
            AgentTaskCommand::Send {
                control: ctl(&d),
                draft_version: d.draft.version,
            },
        ))
        .await;
    wait_for_native_observation(|| {
        f.store
            .agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100)
            .unwrap()
            .events
            .len()
            == 1
    })
    .await;
    let live = f
        .service
        .live
        .lock()
        .await
        .get(&d.summary.task.task_id)
        .unwrap()
        .clone();
    f.faults.arm(usize::MAX);
    let session = f.factory.sessions.lock().unwrap()[0].clone();
    {
        let mut state = session.state.lock().unwrap();
        session.events.lock().unwrap().push(NativeEvent {
            usage: None,
            cursor: 2,
            key: "final-native-event".into(),
            request_id: Some(original.receipt.request_id.clone()),
            session: state.native_session_id.clone(),
            turn: Some("final-turn".into()),
            item: None,
            kind: "message".into(),
            role: Some("assistant".into()),
            text: "final output retained".into(),
            status: None,
            historical: false,
            at_ms: now(),
        });
        state.state = "disconnected".into();
    }
    session.changed.notify_waiters();
    wait_for_native_observation(|| f.faults.failed.load(Ordering::SeqCst) >= 2).await;
    assert_eq!(live.cursor.load(Ordering::Acquire), 1);
    assert!(!live.closed.load(Ordering::Acquire));
    assert!(
        f.service
            .live
            .lock()
            .await
            .contains_key(&d.summary.task.task_id)
    );
    assert_eq!(
        f.store
            .agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100)
            .unwrap()
            .events
            .len(),
        1
    );
    f.faults.arm(0);
    session.changed.notify_waiters();
    wait_for_native_observation(|| live.closed.load(Ordering::Acquire)).await;
    assert_eq!(live.cursor.load(Ordering::Acquire), 2);
    assert!(
        !f.service
            .live
            .lock()
            .await
            .contains_key(&d.summary.task.task_id)
    );
    let page = f
        .store
        .agent_events(&f.scope(), &d.summary.task.task_id, None, None, 100)
        .unwrap();
    assert_eq!(page.events.len(), 2);
    assert_eq!(
        page.events
            .iter()
            .filter(|e| e.text == "final output retained")
            .count(),
        1
    );
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn late_post_send_storage_error_cannot_regress_an_observed_terminal_receipt() {
    let f = Fixture::new().await;
    let d = f.draft(&f.create().await, "already confirmed").await;
    let original = f
        .command(f.request(
            &f.window,
            AgentTaskCommand::Send {
                control: ctl(&d),
                draft_version: d.draft.version,
            },
        ))
        .await;
    wait_for_native_observation(|| {
        f.store
            .agent_receipt(&f.scope(), &original.receipt.request_id)
            .unwrap()
            .is_some_and(|r| r.status == "succeeded")
    })
    .await;
    let current = f
        .service
        .owner
        .detail(&f.scope(), &d.summary.task.task_id)
        .unwrap();
    f.service
        .fail(
            &f.scope(),
            &d.summary.task.task_id,
            current.summary.attachment.generation,
            &original.receipt,
            NativeTaskFailure::uncertain("late error from an earlier failed acknowledgement write"),
            None,
        )
        .unwrap();
    let receipt = f
        .store
        .agent_receipt(&f.scope(), &original.receipt.request_id)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.status, "succeeded");
    assert!(receipt.error.is_none());
    assert!(receipt.submitted_draft.is_none());
    assert_eq!(
        f.service
            .owner
            .detail(&f.scope(), &d.summary.task.task_id)
            .unwrap()
            .summary
            .attachment
            .state,
        "ready"
    );
    assert_eq!(f.factory.sends.load(Ordering::SeqCst), 1);
    f.service.close().await;
}

#[tokio::test]
async fn failed_native_open_revokes_its_endpoint_and_releases_its_slot_without_replay() {
    let fixture = Fixture::new().await;
    fixture.factory.refuse_open.store(true, Ordering::SeqCst);
    let draft = fixture
        .draft(&fixture.create().await, "original instruction")
        .await;
    let request = fixture.request(
        &fixture.window,
        AgentTaskCommand::Send {
            control: ctl(&draft),
            draft_version: draft.draft.version,
        },
    );
    let original = fixture.command(request.clone()).await;
    wait_for_native_observation(|| {
        fixture
            .store
            .agent_receipt(&fixture.scope(), &original.receipt.request_id)
            .unwrap()
            .is_some_and(|receipt| receipt.status == "failed")
    })
    .await;
    let leases = fixture.port.leases.lock().unwrap().clone();
    assert_eq!(leases.len(), 1);
    assert!(leases[0].revoked.load(Ordering::SeqCst));
    assert!(!fixture.service.has_live().await);
    assert_eq!(fixture.factory.opens.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.factory.sends.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .store
            .agent_draft(&fixture.scope(), &draft.summary.task.task_id)
            .unwrap()
            .content
            .text,
        "original instruction"
    );
    fixture.command(request).await;
    assert_eq!(fixture.factory.opens.load(Ordering::SeqCst), 1);
    fixture.service.close().await;
}

#[tokio::test]
async fn failed_registration_retires_connection_and_keeps_uncertain_process_evidence_without_replay()
 {
    for quiet in [true, false] {
        let fixture = Fixture::new().await;
        let draft = fixture
            .draft(&fixture.create().await, "original unsent draft")
            .await;
        fixture
            .faults
            .refuse_registration
            .store(true, Ordering::SeqCst);
        fixture
            .factory
            .refuse_recovery
            .store(!quiet, Ordering::SeqCst);
        let request = fixture.request(
            &fixture.window,
            AgentTaskCommand::Send {
                control: ctl(&draft),
                draft_version: draft.draft.version,
            },
        );
        let original = fixture.command(request.clone()).await;
        let expected = if quiet { "failed" } else { "uncertain" };
        wait_for_native_observation(|| {
            fixture
                .store
                .agent_receipt(&fixture.scope(), &original.receipt.request_id)
                .unwrap()
                .is_some_and(|receipt| receipt.status == expected)
        })
        .await;
        let stored = fixture
            .store
            .agent_task(&fixture.scope(), &draft.summary.task.task_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.task.native_session_id.as_deref(), Some("native-1"));
        assert_eq!(stored.process.as_ref().unwrap().marker, "fixture-owned");
        assert_eq!(stored.native_quiet, quiet);
        assert!(stored.attachment.connection_id.is_none());
        assert_eq!(fixture.factory.closes.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.factory.recoveries.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.factory.sends.load(Ordering::SeqCst), 0);
        assert!(!fixture.service.has_live().await);
        assert!(
            fixture.port.leases.lock().unwrap()[0]
                .revoked
                .load(Ordering::SeqCst)
        );
        assert_eq!(
            fixture
                .store
                .agent_draft(&fixture.scope(), &draft.summary.task.task_id)
                .unwrap()
                .content
                .text,
            "original unsent draft"
        );
        fixture.command(request).await;
        assert_eq!(fixture.factory.opens.load(Ordering::SeqCst), 1);
        if !quiet {
            // Explicit resume must establish original process quiet before it may
            // issue another endpoint or open a replacement native connection.
            let detail = fixture
                .service
                .owner
                .detail(&fixture.scope(), &draft.summary.task.task_id)
                .unwrap();
            let resumed = fixture
                .command(fixture.request(
                    &fixture.window,
                    AgentTaskCommand::Resume {
                        control: ctl(&detail),
                    },
                ))
                .await;
            wait_for_native_observation(|| {
                fixture
                    .store
                    .agent_receipt(&fixture.scope(), &resumed.receipt.request_id)
                    .unwrap()
                    .is_some_and(|receipt| receipt.status == "uncertain")
            })
            .await;
            assert_eq!(fixture.factory.opens.load(Ordering::SeqCst), 1);
            assert_eq!(fixture.port.leases.lock().unwrap().len(), 1);
            assert!(!fixture.service.has_live().await);
        }
        fixture.service.close().await;
    }
}
