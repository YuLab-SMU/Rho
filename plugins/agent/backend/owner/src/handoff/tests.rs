//! Runs with only the public Agent package: no native Host or database is imported.
use super::*;
use crate::component::ComponentActorValidator;
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Clone)]
struct Records {
    source: AgentHandoffSourceSnapshot,
    target: AgentHandoffTargetSnapshot,
    receipt: Option<StoredAgentHandoff>,
}
struct Repository {
    scope: ApplicationScope,
    records: Mutex<Records>,
    // Inject changes between observation and the atomic write.
    fault: AtomicUsize,
    commits: AtomicUsize,
}
impl Repository {
    fn scoped(&self, scope: &ApplicationScope) -> Result<(), ApplicationError> {
        if *scope == self.scope {
            Ok(())
        } else {
            Err(ApplicationError::NotFound)
        }
    }
}
impl AgentHandoffRepository for Repository {
    fn handoff_source(
        &self,
        scope: &ApplicationScope,
        source: &ProjectAgentTaskRef,
    ) -> Result<AgentHandoffSourceSnapshot, ApplicationError> {
        self.scoped(scope)?;
        let records = self.records.lock().unwrap();
        if records.source.source != *source {
            return Err(ApplicationError::NotFound);
        }
        Ok(records.source.clone())
    }
    fn handoff_target(
        &self,
        scope: &ApplicationScope,
        target: &ProjectAgentTaskRef,
        window: &ApplicationWindowRef,
    ) -> Result<AgentHandoffTargetSnapshot, ApplicationError> {
        self.scoped(scope)?;
        let records = self.records.lock().unwrap();
        if records.target.target != *target {
            return Err(ApplicationError::NotFound);
        }
        let mut target = records.target.clone();
        target.writable &= target.controller == *window;
        Ok(target)
    }
    fn handoff_receipt(
        &self,
        scope: &ApplicationScope,
        request_id: &str,
    ) -> Result<Option<StoredAgentHandoff>, ApplicationError> {
        self.scoped(scope)?;
        Ok(self
            .records
            .lock()
            .unwrap()
            .receipt
            .clone()
            .filter(|r| r.receipt.request_id == request_id))
    }
    fn commit_handoff(
        &self,
        scope: &ApplicationScope,
        write: AgentHandoffWrite<'_>,
    ) -> Result<AgentHandoffReceipt, ApplicationError> {
        self.scoped(scope)?;
        let mut records = self.records.lock().unwrap();
        match self.fault.load(Ordering::SeqCst) {
            1 => {
                return Err(ApplicationError::Storage(
                    "injected receipt write failure".into(),
                ));
            }
            2 => {
                records.source.body = "Another source edit".into();
                records.source.revision = handoff_source_fingerprint(&records.source)?;
            }
            3 => records.target.draft_version += 1,
            4 => records.target.controller.incarnation = "replacement-window".into(),
            _ => (),
        }
        if records.source.revision != write.source_fingerprint {
            return Err(handoff_source_expired());
        }
        if records.target.draft_version != write.request.target_draft_version
            || records.target.control_generation != write.request.target_control_generation
            || records.target.controller != write.request.window
        {
            return Err(ApplicationError::Conflict);
        }
        // Commit draft and receipt together only after every original precondition.
        records.target.draft = write.draft.clone();
        records.target.draft_version = write.receipt.target_draft_version;
        records.receipt = Some(StoredAgentHandoff {
            input_digest: write.input_digest.into(),
            receipt: write.receipt.clone(),
        });
        self.commits.fetch_add(1, Ordering::SeqCst);
        Ok(write.receipt.clone())
    }
}
struct Live(AtomicBool);
impl ComponentActorValidator for Live {
    fn validate(&self, _now: u64) -> Result<(), ApplicationError> {
        if self.0.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(ApplicationError::Offline)
        }
    }
}
struct Fixture {
    store: Arc<Repository>,
    owner: AgentHandoffOwner,
    actor: ComponentActor,
    live: Arc<Live>,
    request: AgentHandoffCommand,
}
fn reference(rho: bool, id: &str) -> ProjectAgentTaskRef {
    if rho {
        ProjectAgentTaskRef::Rho {
            conversation_id: id.into(),
        }
    } else {
        ProjectAgentTaskRef::Native { task_id: id.into() }
    }
}
fn selection(path: &str) -> AgentContextSelection {
    AgentContextSelection {
        source: "files".into(),
        label: path.into(),
        reference: json!({"path": path}),
        inclusion: "text".into(),
    }
}
impl Fixture {
    fn new(source_rho: bool, target_rho: bool) -> Self {
        let scope = ApplicationScope {
            project: "/project".into(),
            principal: "alice".into(),
        };
        let window = ApplicationWindowRef {
            window_id: "window".into(),
            incarnation: "life".into(),
        };
        let mut source = AgentHandoffSourceSnapshot {
            source: reference(source_rho, "source"),
            title: "Source".into(),
            body: "Read the result".into(),
            context: vec![selection("analysis.R")],
            revision: String::new(),
            truncated: false,
            notices: vec![],
        };
        source.revision = handoff_source_fingerprint(&source).unwrap();
        let target = AgentHandoffTargetSnapshot {
            target: reference(target_rho, "target"),
            title: "Target".into(),
            draft: AgentDraftContent {
                text: "Existing draft".into(),
                assets: vec!["retained-asset".into()],
                context: vec![selection("analysis.R")],
            },
            draft_version: 3,
            controller: window.clone(),
            control_generation: if target_rho { None } else { Some(9) },
            writable: true,
            reason: None,
        };
        let request = AgentHandoffCommand {
            project_root: scope.project.clone(),
            window: window.clone(),
            request_id: "handoff-1".into(),
            source: source.source.clone(),
            source_revision: source.revision.clone(),
            target: target.target.clone(),
            target_draft_version: target.draft_version,
            target_control_generation: target.control_generation,
            body: "用户确认的后续工作 🧪".into(),
            context: source.context.clone(),
        };
        let live = Arc::new(Live(AtomicBool::new(true)));
        let actor = ComponentActor::new(scope.clone(), window, live.clone());
        let store = Arc::new(Repository {
            scope,
            records: Mutex::new(Records {
                source,
                target,
                receipt: None,
            }),
            fault: AtomicUsize::new(0),
            commits: AtomicUsize::new(0),
        });
        Self {
            owner: AgentHandoffOwner::new(store.clone()),
            store,
            actor,
            live,
            request,
        }
    }
    fn transfer(&self) -> Result<AgentHandoffReceipt, ApplicationError> {
        self.owner.transfer(&self.actor, &self.request, &[], 5)
    }
    fn unchanged(&self) {
        let records = self.store.records.lock().unwrap();
        assert_eq!(records.target.draft.text, "Existing draft");
        assert!(records.receipt.is_none());
        assert_eq!(self.store.commits.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn handoff_appends_once_for_all_owner_pairs_and_retains_original_receipt() {
    for (source, target) in [(false, false), (false, true), (true, false), (true, true)] {
        let mut f = Fixture::new(source, target);
        let first = f.transfer().unwrap();
        {
            let records = f.store.records.lock().unwrap();
            assert_eq!(
                records.target.draft.text,
                format!("Existing draft\n\n{}", f.request.body)
            );
            assert_eq!(records.target.draft.assets, ["retained-asset"]);
            assert_eq!(records.target.draft.context.len(), 1);
            assert_eq!(records.target.draft_version, 4);
            assert_eq!(
                records.target.control_generation,
                f.request.target_control_generation
            );
        }
        // Lost acknowledgement recovery does not re-read or append newer source material.
        f.store.records.lock().unwrap().source.body = "Changed after success".into();
        let repeat = f.transfer().unwrap();
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(repeat).unwrap()
        );
        assert_eq!(f.store.commits.load(Ordering::SeqCst), 1);
        f.request.body.push('!');
        assert_eq!(f.transfer().unwrap_err(), ApplicationError::RequestConflict);
    }
}

#[test]
fn handoff_validates_live_original_actor_and_scoped_source_before_writing() {
    let mut f = Fixture::new(false, true);
    f.live.0.store(false, Ordering::SeqCst);
    assert_eq!(f.transfer().unwrap_err(), ApplicationError::Offline);
    f.live.0.store(true, Ordering::SeqCst);
    f.request.window.incarnation = "forged".into();
    assert_eq!(f.transfer().unwrap_err(), ApplicationError::Conflict);
    f.request.window = f.actor.window().clone();
    f.request.project_root = "/other".into();
    assert_eq!(f.transfer().unwrap_err(), ApplicationError::Conflict);
    let scope = ApplicationScope {
        project: "/project".into(),
        principal: "bob".into(),
    };
    assert_eq!(
        f.owner.source(&scope, &f.request.source, &[]).unwrap_err(),
        ApplicationError::NotFound
    );
    f.unchanged();
}

#[test]
fn handoff_rejects_stale_material_unowned_references_and_target_limits() {
    let mut f = Fixture::new(true, false);
    f.request.source_revision = "stale".into();
    assert_eq!(f.transfer().unwrap_err(), handoff_source_expired());
    f.request.source_revision = f.store.records.lock().unwrap().source.revision.clone();
    f.request.context.push(selection("private.R"));
    assert!(matches!(
        f.transfer(),
        Err(ApplicationError::InvalidInput(_))
    ));
    f.request.context.pop();
    f.store.records.lock().unwrap().target.draft.text = "x".repeat(32 * 1024);
    assert!(matches!(f.transfer(), Err(ApplicationError::Budget(_))));
    assert!(f.store.records.lock().unwrap().receipt.is_none());
    assert_eq!(f.store.commits.load(Ordering::SeqCst), 0);
}

#[test]
fn handoff_atomic_repository_faults_never_create_a_receipt_or_append() {
    for fault in 1..=4 {
        let f = Fixture::new(false, true);
        f.store.fault.store(fault, Ordering::SeqCst);
        let error = f.transfer().unwrap_err();
        match fault {
            1 => assert!(matches!(error, ApplicationError::Storage(_))),
            2 => assert_eq!(error, handoff_source_expired()),
            _ => assert_eq!(error, ApplicationError::Conflict),
        }
        f.unchanged();
        if fault == 1 {
            f.store.fault.store(0, Ordering::SeqCst);
            assert_eq!(f.transfer().unwrap().target_draft_version, 4);
        }
    }
}

#[test]
fn handoff_additional_context_is_bounded_and_uploads_never_cross_owners() {
    let f = Fixture::new(false, true);
    let mut extra = vec![AgentContextSelection {
        source: "attachments".into(),
        ..selection("secret.png")
    }];
    extra.push(AgentContextSelection {
        label: "Same reference, new label".into(),
        ..selection("analysis.R")
    });
    extra.extend((0..20).map(|i| selection(&format!("extra-{i}.R"))));
    let observed = f
        .owner
        .source(f.actor.scope(), &f.request.source, &extra)
        .unwrap();
    assert_eq!(observed.context.len(), MAX_HANDOFF_CONTEXT);
    assert!(observed.truncated);
    assert!(observed.context.iter().all(|c| c.source != "attachments"));
    assert_eq!(observed.context[0].label, "analysis.R");
    assert_eq!(
        observed.revision,
        handoff_source_fingerprint(&observed).unwrap()
    );
    f.unchanged();
}
