use super::*;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

type Key = (String, String, String);
#[derive(Clone)]
struct Row {
    task: StoredAgentTask,
    draft: AgentTaskDraft,
    receipts: Vec<AgentCommandReceipt>,
}
#[derive(Default)]
struct Store {
    rows: Mutex<BTreeMap<Key, Row>>,
    fail_write: AtomicBool,
}
fn key(scope: &AgentTaskScope, id: &str) -> Key {
    (scope.project.clone(), scope.principal.clone(), id.into())
}
impl Store {
    fn row(&self, scope: &AgentTaskScope, id: &str) -> Result<Row, AgentTaskError> {
        self.rows
            .lock()
            .unwrap()
            .get(&key(scope, id))
            .cloned()
            .ok_or(AgentTaskError::NotFound)
    }
}
impl AgentTaskRepository for Store {
    fn agent_task(
        &self,
        s: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<StoredAgentTask>, AgentTaskError> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .get(&key(s, id))
            .map(|r| r.task.clone()))
    }
    fn agent_tasks(
        &self,
        _: &AgentTaskScope,
        _: Option<bool>,
        _: Option<&str>,
        _: usize,
    ) -> Result<Vec<StoredAgentTask>, AgentTaskError> {
        Err(AgentTaskError::Storage(
            "listing is outside this admission fixture".into(),
        ))
    }
    fn agent_task_counts(&self, _: &AgentTaskScope, _: &str) -> Result<(u32, u32), AgentTaskError> {
        Err(AgentTaskError::Storage(
            "counts are outside this admission fixture".into(),
        ))
    }
    fn agent_draft(&self, s: &AgentTaskScope, id: &str) -> Result<AgentTaskDraft, AgentTaskError> {
        Ok(self.row(s, id)?.draft)
    }
    fn agent_receipt(
        &self,
        s: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<AgentCommandReceipt>, AgentTaskError> {
        Ok(self
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|((p, a, _), _)| p == &s.project && a == &s.principal)
            .flat_map(|(_, r)| &r.receipts)
            .find(|r| r.request_id == id)
            .cloned())
    }
    fn agent_receipts(
        &self,
        s: &AgentTaskScope,
        id: &str,
    ) -> Result<Vec<AgentCommandReceipt>, AgentTaskError> {
        Ok(self.row(s, id)?.receipts)
    }
    fn agent_events(
        &self,
        _: &AgentTaskScope,
        _: &str,
        _: Option<u64>,
        _: Option<u64>,
        _: usize,
    ) -> Result<AgentTaskEventPage, AgentTaskError> {
        Err(AgentTaskError::Storage(
            "event paging is outside this admission fixture".into(),
        ))
    }
    fn agent_assets(
        &self,
        s: &AgentTaskScope,
        id: &str,
    ) -> Result<Vec<AgentAsset>, AgentTaskError> {
        self.row(s, id)?;
        Ok(vec![])
    }
    fn agent_asset(
        &self,
        _: &AgentTaskScope,
        _: &str,
        _: &str,
    ) -> Result<(AgentAsset, Vec<u8>), AgentTaskError> {
        Err(AgentTaskError::NotFound)
    }
    fn put_agent_asset(
        &self,
        _: &AgentTaskScope,
        _: &str,
        _: &AgentAsset,
        _: &[u8],
    ) -> Result<(), AgentTaskError> {
        Err(AgentTaskError::Storage(
            "asset bytes are outside this admission fixture".into(),
        ))
    }
    fn commit_agent_task(
        &self,
        scope: &AgentTaskScope,
        write: AgentTaskWrite<'_>,
    ) -> Result<(), AgentTaskError> {
        if self.fail_write.swap(false, Ordering::SeqCst) {
            return Err(AgentTaskError::Storage(
                "injected atomic write failure".into(),
            ));
        }
        let mut rows = self.rows.lock().unwrap();
        let k = key(scope, &write.task.task.task_id);
        let old = rows.get(&k);
        if write.expected_revision != old.map(|r| r.task.revision.as_str()) {
            return Err(AgentTaskError::Conflict);
        }
        let mut receipts = old.map_or_else(Vec::new, |r| r.receipts.clone());
        for receipt in write.receipts {
            receipts.retain(|r| r.request_id != receipt.request_id);
            receipts.push(receipt.clone());
        }
        let draft = write
            .draft
            .cloned()
            .or_else(|| old.map(|r| r.draft.clone()))
            .ok_or(AgentTaskError::NotFound)?;
        rows.insert(
            k,
            Row {
                task: write.task.clone(),
                draft,
                receipts,
            },
        );
        Ok(())
    }
}
fn scope() -> AgentTaskScope {
    AgentTaskScope {
        project: "/study".into(),
        principal: "principal-a".into(),
    }
}
fn controller(id: &str) -> AgentControllerRef {
    AgentControllerRef {
        window_id: id.into(),
        incarnation: format!("{id}-incarnation"),
    }
}
fn request(window: &str, command: AgentTaskCommand) -> AgentTaskRequest {
    AgentTaskRequest {
        project_root: scope().project,
        window: controller(window),
        request_id: fresh(),
        command,
    }
}
fn control(task: &StoredAgentTask) -> AgentTaskControl {
    AgentTaskControl {
        task_id: task.task.task_id.clone(),
        generation: task.attachment.generation,
    }
}
fn create() -> AgentTaskRequest {
    request(
        "one",
        AgentTaskCommand::Create {
            provider: AgentProvider::Kimi,
            model: "fixture".into(),
            effort: None,
        },
    )
}
fn draft(
    owner: &AgentTaskOwner,
    task: &StoredAgentTask,
    version: u64,
    text: &str,
) -> AgentTaskAdmission {
    owner.admit(&scope(),&request("one",AgentTaskCommand::SaveDraft{control:control(task),version,content:AgentDraftContent{text:text.into(),assets:vec![],context:vec![AgentContextSelection{source:"plugins.source".into(),label:"插件分支".into(),reference:serde_json::json!({"draft":"captured-branch","version":"captured-version"}),inclusion:"reference".into()}]}}),2).unwrap()
}

#[test]
fn original_receipt_deduplicates_and_scope_draft_and_generation_fences_remain() {
    let store = Arc::new(Store::default());
    let owner = AgentTaskOwner::new(store.clone());
    let original = create();
    let created = owner.admit(&scope(), &original, 1).unwrap();
    let id = &created.task.task.task_id;
    let repeated = owner.admit(&scope(), &original, 9).unwrap();
    assert!(repeated.repeated && !repeated.native);
    assert_eq!(&repeated.task.task.task_id, id);
    let mut changed = original;
    changed.window = controller("two");
    assert!(matches!(
        owner.admit(&scope(), &changed, 9),
        Err(AgentTaskError::RequestConflict)
    ));
    assert!(matches!(
        owner.get(
            &AgentTaskScope {
                principal: "other".into(),
                ..scope()
            },
            id
        ),
        Err(AgentTaskError::NotFound)
    ));
    let saved = draft(&owner, &created.task, 0, "保留 Unicode 草稿");
    let stale = request(
        "one",
        AgentTaskCommand::SaveDraft {
            control: control(&saved.task),
            version: 0,
            content: AgentDraftContent::default(),
        },
    );
    assert!(matches!(
        owner.admit(&scope(), &stale, 3),
        Err(AgentTaskError::Conflict)
    ));
    let foreign = request(
        "two",
        AgentTaskCommand::Rename {
            control: control(&saved.task),
            title: "foreign".into(),
        },
    );
    assert!(matches!(
        owner.admit(&scope(), &foreign, 3),
        Err(AgentTaskError::InvalidInput(_))
    ));
    assert_eq!(
        owner.detail(&scope(), id).unwrap().draft.content.text,
        "保留 Unicode 草稿"
    );
    assert_eq!(store.rows.lock().unwrap().len(), 1);
}

#[test]
fn failed_atomic_admission_does_not_publish_or_duplicate_a_native_request() {
    let store = Arc::new(Store::default());
    let owner = AgentTaskOwner::new(store.clone());
    let original = create();
    store.fail_write.store(true, Ordering::SeqCst);
    assert!(matches!(
        owner.admit(&scope(), &original, 1),
        Err(AgentTaskError::Storage(_))
    ));
    assert!(store.rows.lock().unwrap().is_empty());
    let created = owner.admit(&scope(), &original, 1).unwrap();
    let saved = draft(&owner, &created.task, 0, "captured input");
    let send = request(
        "one",
        AgentTaskCommand::Send {
            control: control(&saved.task),
            draft_version: saved.draft.version,
        },
    );
    store.fail_write.store(true, Ordering::SeqCst);
    assert!(matches!(
        owner.admit(&scope(), &send, 3),
        Err(AgentTaskError::Storage(_))
    ));
    assert!(
        store
            .agent_receipt(&scope(), &send.request_id)
            .unwrap()
            .is_none()
    );
    let accepted = owner.admit(&scope(), &send, 4).unwrap();
    assert!(accepted.native);
    assert_eq!(accepted.receipt.status, "prepared");
    let next = draft(&owner, &accepted.task, accepted.draft.version, "next draft");
    let recovered = owner.admit(&scope(), &send, 5).unwrap();
    assert!(recovered.repeated && !recovered.native);
    assert_eq!(
        recovered.receipt.submitted_draft.unwrap().text,
        "captured input"
    );
    assert_eq!(
        recovered.receipt.input_context[0].reference["version"],
        "captured-version"
    );
    assert_eq!(next.draft.content.text, "next draft");
    assert_eq!(store.rows.lock().unwrap().len(), 1);
}

#[test]
fn restart_observes_original_uncertainty_without_rewriting_or_replaying() {
    let store = Arc::new(Store::default());
    let owner = AgentTaskOwner::new(store.clone());
    let created = owner.admit(&scope(), &create(), 1).unwrap();
    let saved = draft(&owner, &created.task, 0, "original instruction");
    let send = request(
        "one",
        AgentTaskCommand::Send {
            control: control(&saved.task),
            draft_version: saved.draft.version,
        },
    );
    let active = owner.admit(&scope(), &send, 3).unwrap();
    let id = &active.task.task.task_id;
    owner
        .update(
            &scope(),
            id,
            active.task.attachment.generation,
            |task, _, _, _| {
                task.task.native_session_id = Some("original-native".into());
                task.attachment.state = "running".into();
                Ok(())
            },
        )
        .unwrap();
    let retained = store.row(&scope(), id).unwrap();
    let reopened = AgentTaskOwner::new(store.clone());
    let detail = reopened.detail(&scope(), id).unwrap();
    assert_eq!(detail.summary.attachment.state, "disconnected");
    assert_eq!(
        detail.summary.task.native_session_id.as_deref(),
        Some("original-native")
    );
    assert_eq!(
        detail
            .receipts
            .iter()
            .find(|r| r.request_id == send.request_id)
            .unwrap()
            .status,
        "uncertain"
    );
    assert_eq!(detail.draft.content.text, "original instruction");
    assert_eq!(
        store.row(&scope(), id).unwrap().task.revision,
        retained.task.revision
    );
    assert_eq!(
        store
            .agent_receipt(&scope(), &send.request_id)
            .unwrap()
            .unwrap()
            .status,
        "prepared"
    );
    let repeated = reopened.admit(&scope(), &send, 4).unwrap();
    assert!(repeated.repeated && !repeated.native);
}

#[test]
fn stop_takeover_freezes_writes_until_confirmed_transition_commits() {
    let store = Arc::new(Store::default());
    let owner = AgentTaskOwner::new(store.clone());
    let created = owner.admit(&scope(), &create(), 1).unwrap();
    let saved = draft(&owner, &created.task, 0, "running input");
    let active = owner
        .admit(
            &scope(),
            &request(
                "one",
                AgentTaskCommand::Send {
                    control: control(&saved.task),
                    draft_version: saved.draft.version,
                },
            ),
            3,
        )
        .unwrap();
    let transfer = owner
        .admit(
            &scope(),
            &request(
                "two",
                AgentTaskCommand::TakeOver {
                    control: control(&active.task),
                    stop: true,
                },
            ),
            4,
        )
        .unwrap();
    let id = &transfer.task.task.task_id;
    assert!(transfer.native && transfer.task.attachment.control_frozen);
    assert_eq!(transfer.task.attachment.controller, controller("one"));
    let edit = request(
        "one",
        AgentTaskCommand::Rename {
            control: control(&transfer.task),
            title: "too early".into(),
        },
    );
    assert!(matches!(
        owner.admit(&scope(), &edit, 5),
        Err(AgentTaskError::InvalidInput(_))
    ));
    let confirmed = |task: &mut StoredAgentTask,
                     _: &mut AgentTaskDraft,
                     _: &mut Vec<AgentCommandReceipt>,
                     _: &mut Vec<AgentTaskEvent>| {
        task.attachment.controller = controller("two");
        task.attachment.generation += 1;
        task.attachment.control_frozen = false;
        task.attachment.state = "ready".into();
        task.native_quiet = true;
        task.active_request = None;
        Ok(())
    };
    store.fail_write.store(true, Ordering::SeqCst);
    assert!(matches!(
        owner.update(&scope(), id, transfer.task.attachment.generation, confirmed),
        Err(AgentTaskError::Storage(_))
    ));
    assert_eq!(
        owner.get(&scope(), id).unwrap().attachment.controller,
        controller("one")
    );
    owner
        .update(&scope(), id, transfer.task.attachment.generation, confirmed)
        .unwrap();
    assert!(matches!(
        owner.admit(&scope(), &edit, 6),
        Err(AgentTaskError::Conflict)
    ));
    assert_eq!(
        owner.get(&scope(), id).unwrap().attachment.controller,
        controller("two")
    );
}
