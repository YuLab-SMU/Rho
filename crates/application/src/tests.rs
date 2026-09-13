use super::*;
use std::collections::BTreeMap;

#[derive(Default, Clone)]
struct MemoryState {
    windows: BTreeMap<(String, String, String), StoredWindow>,
    documents: BTreeMap<(String, String, String, String), ApplicationDocument>,
    commands: BTreeMap<(String, String, String, String), StoredCommand>,
    bindings: BTreeMap<(String, String, String), ApplicationMethodBinding>,
    skill_reads: Vec<(String, String, ApplicationSkillReadReceipt)>,
}
#[derive(Default)]
struct MemoryRepository(Mutex<MemoryState>);
fn key(scope: &ApplicationScope, id: &str) -> (String, String, String) {
    (scope.project.clone(), scope.principal.clone(), id.into())
}
impl ApplicationRepository for MemoryRepository {
    fn windows(&self, s: &ApplicationScope) -> Result<Vec<StoredWindow>, ApplicationError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .windows
            .iter()
            .filter(|((p, a, _), _)| p == &s.project && a == &s.principal)
            .map(|(_, v)| v.clone())
            .collect())
    }
    fn window(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredWindow>, ApplicationError> {
        Ok(self.0.lock().unwrap().windows.get(&key(s, id)).cloned())
    }
    fn documents(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Vec<ApplicationDocument>, ApplicationError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .documents
            .iter()
            .filter(|((p, a, w, _), _)| p == &s.project && a == &s.principal && w == id)
            .map(|(_, v)| v.clone())
            .collect())
    }
    fn command(
        &self,
        s: &ApplicationScope,
        w: &str,
        r: &str,
    ) -> Result<Option<StoredCommand>, ApplicationError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .commands
            .get(&(s.project.clone(), s.principal.clone(), w.into(), r.into()))
            .cloned())
    }
    fn commands(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Vec<StoredCommand>, ApplicationError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .commands
            .iter()
            .filter(|((p, a, w, _), _)| p == &s.project && a == &s.principal && w == id)
            .map(|(_, v)| v.clone())
            .collect())
    }
    fn commit(
        &self,
        s: &ApplicationScope,
        expected: Option<&str>,
        w: &StoredWindow,
        changes: &ApplicationStoreChanges,
    ) -> Result<(), ApplicationError> {
        let mut state = self.0.lock().unwrap();
        if state
            .windows
            .get(&key(s, &w.window.window_id))
            .map(|w| w.revision.as_str())
            != expected
        {
            return Err(ApplicationError::Conflict);
        }
        state.windows.insert(key(s, &w.window.window_id), w.clone());
        for d in &changes.documents {
            state.documents.insert(
                (
                    s.project.clone(),
                    s.principal.clone(),
                    w.window.window_id.clone(),
                    d.document_id.clone(),
                ),
                d.clone(),
            );
        }
        for id in &changes.removed_document_ids {
            state.documents.remove(&(
                s.project.clone(),
                s.principal.clone(),
                w.window.window_id.clone(),
                id.clone(),
            ));
        }
        for c in &changes.commands {
            state.commands.insert(
                (
                    s.project.clone(),
                    s.principal.clone(),
                    w.window.window_id.clone(),
                    c.request.request_id.clone(),
                ),
                c.clone(),
            );
        }
        Ok(())
    }
    fn method_bindings(
        &self,
        s: &ApplicationScope,
    ) -> Result<Vec<ApplicationMethodBinding>, ApplicationError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .bindings
            .iter()
            .filter(|((p, a, _), _)| p == &s.project && a == &s.principal)
            .map(|(_, v)| v.clone())
            .collect())
    }
    fn write_method_binding(
        &self,
        s: &ApplicationScope,
        expected: Option<&str>,
        b: &ApplicationMethodBinding,
    ) -> Result<(), ApplicationError> {
        let mut state = self.0.lock().unwrap();
        if state
            .bindings
            .get(&key(s, &b.binding_id))
            .map(|b| b.version.as_str())
            != expected
        {
            return Err(ApplicationError::Conflict);
        }
        state.bindings.insert(key(s, &b.binding_id), b.clone());
        Ok(())
    }
    fn record_skill_read(
        &self,
        scope: &ApplicationScope,
        receipt: &ApplicationSkillReadReceipt,
    ) -> Result<(), ApplicationError> {
        self.0.lock().unwrap().skill_reads.push((
            scope.project.clone(),
            scope.principal.clone(),
            receipt.clone(),
        ));
        Ok(())
    }
    fn skill_reads(
        &self,
        scope: &ApplicationScope,
        task: Option<&str>,
    ) -> Result<Vec<ApplicationSkillReadReceipt>, ApplicationError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .skill_reads
            .iter()
            .filter(|(p, a, r)| {
                p == &scope.project
                    && a == &scope.principal
                    && task.is_none_or(|t| r.external_task_ref.as_deref() == Some(t))
            })
            .map(|(_, _, r)| r.clone())
            .collect())
    }
}
fn actor(agent: bool) -> CallContext {
    CallContext {
        caller: CallerIdentity {
            kind: if agent {
                CallerKind::Agent
            } else {
                CallerKind::Human
            },
            id: if agent { "codex-task" } else { "local" }.into(),
        },
        principal: Some(CallerIdentity {
            kind: CallerKind::Human,
            id: "account-1".into(),
        }),
        scopes: Default::default(),
        connection_id: "studio:one".into(),
        correlation_id: None,
        causation_id: None,
        trace_parent: None,
    }
}
fn owner() -> ApplicationOwner {
    ApplicationOwner::new("/project".into(), Arc::new(MemoryRepository::default()))
}
fn register(owner: &ApplicationOwner, id: &str, now: u64) -> ApplicationBridgeRegistration {
    let ApplicationBridgeReply::Registered(r) = owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Register {
                window_id: id.into(),
                incarnation: format!("{id}-lifetime-1"),
                label: id.into(),
                previous_session: None,
            },
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    r
}
fn document(text: &str) -> ApplicationDocument {
    ApplicationDocument {
        document_id: "doc1".into(),
        version: "doc-v1".into(),
        path: Some("analysis.R".into()),
        text: text.into(),
        base_text: Some("x <- 1\n".into()),
        base_hash: Some(sha256("x <- 1\n")),
        selection: ApplicationSelection {
            anchor: 0,
            head: 0,
            version: "selection-v1".into(),
        },
        readonly_reason: None,
    }
}
fn sync(
    owner: &ApplicationOwner,
    registration: &ApplicationBridgeRegistration,
    document: ApplicationDocument,
    now: u64,
) -> ApplicationDocument {
    let mut context = registration.context.clone();
    context.version = "context-v1".into();
    context.active_document_id = Some(document.document_id.clone());
    context.native_session_id = Some("R-session-1".into());
    owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Sync {
                session: registration.session.clone(),
                sync_id: fresh(),
                changes: ApplicationChanges {
                    context: Some(ApplicationContextUpdate {
                        expected_version: registration.context.version.clone(),
                        context,
                    }),
                    documents: vec![ApplicationDocumentUpdate {
                        expected_version: None,
                        expected_selection_version: None,
                        document: document.clone(),
                    }],
                    removed_documents: vec![],
                },
            },
            now,
        )
        .unwrap();
    document
}
fn control(
    owner: &ApplicationOwner,
    r: &ApplicationBridgeRegistration,
    d: &ApplicationDocument,
    id: &str,
    now: u64,
) -> ApplicationCommandReceipt {
    owner
        .control(
            &actor(true),
            ApplicationCommandRequest { execution_target: None,
                window: r.session.window.clone(),
                request_id: id.into(),
                action: ApplicationAction::RunFile {
                    document: document_ref(d),
                    target_path: None,
                },
            },
            now,
        )
        .unwrap()
}
fn claim(
    owner: &ApplicationOwner,
    r: &ApplicationBridgeRegistration,
    now: u64,
) -> ApplicationCommandGrant {
    let ApplicationBridgeReply::Claimed(Some(grant)) = owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Claim {
                session: r.session.clone(),
                claim_request_id: fresh(),
            },
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    grant
}
fn complete(
    owner: &ApplicationOwner,
    r: &ApplicationBridgeRegistration,
    grant: &ApplicationCommandGrant,
    now: u64,
) -> ApplicationCommandReceipt {
    let ApplicationBridgeReply::Completed(receipt) = owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Complete {
                session: r.session.clone(),
                completion: ApplicationCommandCompletion {
                    request_id: grant.request.request_id.clone(),
                    claim_id: grant.claim_id.clone(),
                    outcome: ApplicationLocalOutcome::Applied,
                    changes: ApplicationChanges::default(),
                    diagnostic: None,
                },
            },
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    *receipt
}
fn execute_request(
    r: &ApplicationBridgeRegistration,
    grant: &ApplicationCommandGrant,
    step: ApplicationExecutionStep,
) -> ApplicationExecuteRequest {
    ApplicationExecuteRequest {
        session: r.session.clone(),
        request_id: grant.request.request_id.clone(),
        execution_ref: grant.execution_ref.clone().unwrap(),
        step,
    }
}

#[test]
fn two_windows_keep_distinct_drafts_and_principals_cannot_read_each_other() {
    let owner = owner();
    let a = register(&owner, "a", 0);
    let b = register(&owner, "b", 0);
    sync(&owner, &a, document("unsaved A\n"), 1);
    sync(&owner, &b, document("unsaved B\n"), 1);
    let read = |window: ApplicationWindowRef| {
        owner
            .context(
                &actor(true),
                ApplicationContextArguments {
                    window,
                    allow_offline: false,
                    after_document_id: None,
                    limit: None,
                },
                2,
            )
            .unwrap()
    };
    assert_ne!(
        read(a.session.window.clone())
            .current_document
            .unwrap()
            .sha256,
        read(b.session.window).current_document.unwrap().sha256
    );
    let mut other = actor(true);
    other.principal.as_mut().unwrap().id = "other".into();
    assert!(
        owner
            .windows(&other, ApplicationWindowsArguments::default(), 2)
            .unwrap()
            .windows
            .is_empty()
    );
    assert_eq!(
        owner
            .context(
                &other,
                ApplicationContextArguments {
                    window: a.session.window,
                    allow_offline: false,
                    after_document_id: None,
                    limit: None
                },
                2
            )
            .unwrap_err(),
        ApplicationError::NotFound
    );
}
#[test]
fn lease_boundary_and_synced_history_are_explicit() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    sync(&owner, &r, document("draft"), 1);
    let args = ApplicationContextArguments {
        window: r.session.window,
        allow_offline: false,
        after_document_id: None,
        limit: None,
    };
    assert!(
        owner
            .context(&actor(true), args.clone(), 14_999)
            .unwrap()
            .window
            .online
    );
    assert_eq!(
        owner
            .context(&actor(true), args.clone(), 15_000)
            .unwrap_err(),
        ApplicationError::Offline
    );
    assert_eq!(
        owner
            .context(
                &actor(true),
                ApplicationContextArguments {
                    allow_offline: true,
                    ..args
                },
                15_000
            )
            .unwrap()
            .source,
        "synced_history"
    );
}
#[test]
fn same_request_returns_original_and_different_input_is_rejected() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    let first = control(&owner, &r, &d, "request", 2);
    let again = control(&owner, &r, &d, "request", 3);
    assert_eq!(first, again);
    let changed = ApplicationCommandRequest { execution_target: None,
        window: r.session.window,
        request_id: "request".into(),
        action: ApplicationAction::Save {
            document: document_ref(&d),
            target_path: None,
        },
    };
    assert_eq!(
        owner.control(&actor(true), changed, 3).unwrap_err(),
        ApplicationError::RequestConflict
    );
}
#[test]
fn unclaimed_commands_expire_and_never_follow_new_incarnations() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let receipt = owner
        .command_status(
            &actor(true),
            ApplicationCommandStatusArguments {
                window: r.session.window.clone(),
                request_id: "request".into(),
            },
            30_002,
        )
        .unwrap();
    assert_eq!(receipt.state, ApplicationCommandState::Expired);
    owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Register {
                window_id: "a".into(),
                incarnation: "new".into(),
                label: "a".into(),
                previous_session: Some(r.session.clone()),
            },
            4,
        )
        .unwrap();
    assert_eq!(
        owner
            .command_status(
                &actor(true),
                ApplicationCommandStatusArguments {
                    window: r.session.window,
                    request_id: "request".into()
                },
                5
            )
            .unwrap()
            .state,
        ApplicationCommandState::Expired
    );
}
#[test]
fn a_lost_claim_reply_reuses_delivery_without_a_second_command() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let request = ApplicationBridgeRequest::Claim {
        session: r.session.clone(),
        claim_request_id: "delivery".into(),
    };
    let ApplicationBridgeReply::Claimed(Some(first)) =
        owner.bridge(&actor(false), request.clone(), 3).unwrap()
    else {
        panic!()
    };
    let ApplicationBridgeReply::Claimed(Some(second)) =
        owner.bridge(&actor(false), request, 4).unwrap()
    else {
        panic!()
    };
    assert_eq!(first.claim_id, second.claim_id);
    assert!(matches!(
        owner
            .bridge(
                &actor(false),
                ApplicationBridgeRequest::Claim {
                    session: r.session,
                    claim_request_id: "different-delivery".into()
                },
                4
            )
            .unwrap(),
        ApplicationBridgeReply::Claimed(None)
    ));
}
#[test]
fn stale_completion_reports_local_unsynced_and_preserves_newer_draft() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let grant = claim(&owner, &r, 3);
    let mut newer = d.clone();
    newer.version = "newer".into();
    newer.text = "user typed after capture\n".into();
    let update = |document| ApplicationChanges {
        documents: vec![ApplicationDocumentUpdate {
            expected_version: Some(d.version.clone()),
            expected_selection_version: Some(d.selection.version.clone()),
            document,
        }],
        ..Default::default()
    };
    owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Sync {
                session: r.session.clone(),
                sync_id: "user-input".into(),
                changes: update(newer.clone()),
            },
            4,
        )
        .unwrap();
    let completion = ApplicationCommandCompletion {
        request_id: grant.request.request_id,
        claim_id: grant.claim_id,
        outcome: ApplicationLocalOutcome::Applied,
        changes: update(d.clone()),
        diagnostic: None,
    };
    let ApplicationBridgeReply::Completed(receipt) = owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Complete {
                session: r.session.clone(),
                completion: completion.clone(),
            },
            5,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(
        receipt.state,
        ApplicationCommandState::LocallyAppliedUnsynced
    );
    let ApplicationBridgeReply::Completed(again) = owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Complete {
                session: r.session.clone(),
                completion,
            },
            6,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(receipt, again);
    let actual = owner
        .context(
            &actor(true),
            ApplicationContextArguments {
                window: r.session.window,
                allow_offline: false,
                after_document_id: None,
                limit: None,
            },
            6,
        )
        .unwrap()
        .current_document
        .unwrap();
    assert_eq!(actual.sha256, sha256(&newer.text));
}
#[test]
fn captured_scientific_parameters_retain_agent_actor_and_retry_only_observes() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let grant = claim(&owner, &r, 3);
    complete(&owner, &r, &grant, 4);
    let request = execute_request(&r, &grant, ApplicationExecutionStep::Save);
    let ApplicationExecutionAdmission::Invoke {
        context,
        invocation,
    } = owner.begin_execution(&actor(false), &request, 5).unwrap()
    else {
        panic!()
    };
    assert_eq!(context.caller, actor(true).caller);
    assert_eq!(invocation.capability.id, "project.apply_patch");
    assert!(
        invocation.arguments["patch"]
            .as_str()
            .unwrap()
            .contains("+x <- 2")
    );
    let ApplicationExecutionAdmission::Observe { lookup } = owner
        .begin_execution(&actor(false), &request, 100_000)
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(lookup.client_request_id, invocation.client_request_id);
    assert!(
        owner
            .begin_execution(
                &actor(false),
                &execute_request(&r, &grant, ApplicationExecutionStep::Run),
                6
            )
            .is_err()
    );
    let mut substituted = request;
    substituted.execution_ref = "different-capture".into();
    assert!(
        owner
            .begin_execution(&actor(false), &substituted, 6)
            .is_err()
    );
}

#[test]
fn captured_run_keeps_its_instance_when_the_window_selects_another_session() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    let select = |instance: &str, native: &str, now: u64| {
        let before = owner.context(&actor(true), ApplicationContextArguments {
            window: r.session.window.clone(), allow_offline: false,
            after_document_id: None, limit: None,
        }, now).unwrap().context;
        let mut context = before.clone();
        context.version = format!("context-{instance}");
        context.workspace_instance_id = Some(instance.into());
        context.native_session_id = Some(native.into());
        owner.bridge(&actor(false), ApplicationBridgeRequest::Sync {
            session: r.session.clone(), sync_id: fresh(),
            changes: ApplicationChanges {
                context: Some(ApplicationContextUpdate { expected_version: before.version, context }),
                ..Default::default()
            },
        }, now).unwrap();
    };
    select("main", "R-session-1", 2);
    owner.control(&actor(true), ApplicationCommandRequest { execution_target: None,
        window: r.session.window.clone(), request_id: "captured-main".into(),
        action: ApplicationAction::RunSelection { document: document_ref(&d) },
    }, 3).unwrap();
    let grant = claim(&owner, &r, 4);
    assert_eq!(grant.capture.as_ref().unwrap().workspace_instance_id.as_deref(), Some("main"));
    complete(&owner, &r, &grant, 5);
    select("scratch", "R-session-2", 6);
    let request = execute_request(&r, &grant, ApplicationExecutionStep::Run);
    let ApplicationExecutionAdmission::Invoke { context, invocation } =
        owner.begin_execution(&actor(false), &request, 7).unwrap() else { panic!() };
    assert_eq!(invocation.arguments["workspace_instance_id"], "main");
    assert_eq!(invocation.preconditions[0].expected, "R-session-1");
    let mut substituted = operation_record(&invocation, &context, OperationStatus::Accepted, None);
    substituted.operation.normalized_arguments["workspace_instance_id"] = serde_json::json!("scratch");
    assert!(owner.record_execution(&actor(false), &request, &substituted, 8).is_err());
    let original = operation_record(&invocation, &context, OperationStatus::Accepted, None);
    owner.record_execution(&actor(false), &request, &original, 9).unwrap();
    assert!(matches!(owner.begin_execution(&actor(false), &request, 10).unwrap(),
        ApplicationExecutionAdmission::Observe { .. }));
}

#[test]
fn pinned_inspection_names_its_instance_without_retargeting_execution() {
    let mut context=ApplicationContextState {
        version:"context-pinned".into(), label:"study".into(),
        native_session_id:Some("native-main".into()), workspace_instance_id:Some("main".into()),
        views:vec![ApplicationView {view_id:"objects-scratch".into(),view_type:ApplicationViewType::Objects,
            document_id:None,active:true,workspace_instance_id:Some("scratch".into()),native_session_id:Some("native-scratch".into())}],
        selected_object:Some(ApplicationObjectSelection {name:"data".into(),object_ref:Some("object-1".into()),
            native_session_id:"native-scratch".into(),workspace_instance_id:Some("scratch".into())}),
        ..Default::default()
    };
    validation::validate_context(&context,&[]).unwrap();
    assert_eq!(context.workspace_instance_id.as_deref(),Some("main"));
    context.views[0].native_session_id=Some("native-new-scratch".into());
    assert!(validation::validate_context(&context,&[]).is_err());
    context.views.clear();
    assert!(validation::validate_context(&context,&[]).is_err());
}
#[test]
fn draft_and_base_pages_have_separate_hashes_and_utf8_boundaries() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("🦀中文\r\n"), 1);
    let args = ApplicationReadDocumentArguments {
        window: r.session.window,
        document: document_ref(&d),
        expected_sha256: sha256(&d.text),
        content: ApplicationDocumentContent::Draft,
        offset_utf8: 0,
        limit_bytes: Some(4),
        allow_offline: false,
    };
    let first = owner.read_document(&actor(true), args.clone(), 2).unwrap();
    assert_eq!(first.text, "🦀");
    assert_eq!(first.next_offset_utf8, Some(4));
    assert!(
        owner
            .read_document(
                &actor(true),
                ApplicationReadDocumentArguments {
                    offset_utf8: 1,
                    ..args.clone()
                },
                2
            )
            .is_err()
    );
    let base = owner
        .read_document(
            &actor(true),
            ApplicationReadDocumentArguments {
                content: ApplicationDocumentContent::Base,
                expected_sha256: d.base_hash.unwrap(),
                limit_bytes: None,
                ..args
            },
            2,
        )
        .unwrap();
    assert_eq!(base.text, "x <- 1\n");
}
#[test]
fn selection_versions_are_local_and_surrogate_boundaries_are_checked() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("🦀 x"), 1);
    let action = ApplicationAction::SetSelection {
        document: document_ref(&d),
        anchor: 1,
        head: 2,
    };
    assert!(
        owner
            .control(
                &actor(true),
                ApplicationCommandRequest { execution_target: None,
                    window: r.session.window.clone(),
                    request_id: "bad-selection".into(),
                    action
                },
                2
            )
            .is_err()
    );
    let mut moved = d.clone();
    moved.selection.anchor = 2;
    moved.selection.version = "selection-v2".into();
    owner
        .bridge(
            &actor(false),
            ApplicationBridgeRequest::Sync {
                session: r.session,
                sync_id: "selection".into(),
                changes: ApplicationChanges {
                    documents: vec![ApplicationDocumentUpdate {
                        expected_version: Some(d.version),
                        expected_selection_version: Some(d.selection.version),
                        document: moved,
                    }],
                    ..Default::default()
                },
            },
            2,
        )
        .unwrap();
}
#[test]
fn host_restart_invalidates_liveness_without_discarding_drafts() {
    let store = Arc::new(MemoryRepository::default());
    let first = ApplicationOwner::new("/project".into(), store.clone());
    let r = register(&first, "a", 0);
    sync(&first, &r, document("retained"), 1);
    let second = ApplicationOwner::new("/project".into(), store);
    assert!(
        !second
            .windows(&actor(true), ApplicationWindowsArguments::default(), 2)
            .unwrap()
            .windows[0]
            .online
    );
    assert!(
        second
            .bridge(
                &actor(false),
                ApplicationBridgeRequest::Renew { session: r.session },
                2
            )
            .is_err()
    );
}

fn operation_record(
    invocation: &Invocation,
    original: &CallContext,
    status: OperationStatus,
    output: Option<serde_json::Value>,
) -> OperationRecord {
    let domain = if invocation.capability.id.starts_with("project.") {
        "project"
    } else {
        "workspace"
    };
    OperationRecord {
        next_reads: None,
        diagnostics: None,
        operation: Operation {
            operation_id: OperationId::new(format!("operation-{domain}")).unwrap(),
            client_request_id: invocation.client_request_id.clone(),
            caller: original.caller.clone(),
            principal: original.principal.clone(),
            capability: invocation.capability.clone(),
            domain: domain.into(),
            target: TargetRef {
                kind: domain.into(),
                identity: if domain == "project" {
                    "/project"
                } else {
                    "R-session-1"
                }
                .into(),
            },
            normalized_arguments: invocation.arguments.clone(),
            invocation_digest: "bound-digest".into(),
            idempotency_scope: Some("/project".into()),
            preconditions: invocation.preconditions.clone(),
            potential_effects: Default::default(),
            correlation_id: "correlation".into(),
            causation_id: None,
            trace_parent: None,
            accepted_at_ms: 5,
        },
        status,
        outcome: OperationOutcome::from_status(status).ok(),
        output,
        error: None,
        recovery: None,
        cancellation_requested: false,
        updated_at_ms: 6,
    }
}
fn project_output(digest: &str) -> serde_json::Value {
    let snapshot = ProjectSnapshot {
        root: "/project".into(),
        git: None,
        files: vec![FileObservation {
            path: "analysis.R".into(),
            kind: "file".into(),
            sha256: Some(digest.into()),
            byte_size: 7,
            mode: None,
            modified_at_ns: None,
        }],
        entries: vec![],
        entries_truncated: false,
        observed_at_ms: 6,
    };
    serde_json::to_value(ProjectPatchResult {
        before: snapshot.clone(),
        after: snapshot,
        affected_paths: vec!["analysis.R".into()],
        changed_paths: vec!["analysis.R".into()],
        git_exit_code: Some(0),
        diagnostic: String::new(),
        committed_to_git: false,
    })
    .unwrap()
}
#[test]
fn saved_digest_is_verified_and_next_run_stays_unsubmitted_after_disconnect() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let grant = claim(&owner, &r, 3);
    assert!(complete(&owner, &r, &grant, 4).completed_at_ms.is_none());
    let request = execute_request(&r, &grant, ApplicationExecutionStep::Save);
    let ApplicationExecutionAdmission::Invoke {
        context,
        invocation,
    } = owner.begin_execution(&actor(false), &request, 5).unwrap()
    else {
        panic!()
    };
    let accepted = operation_record(&invocation, &context, OperationStatus::Accepted, None);
    let admitted = owner
        .record_execution(&actor(false), &request, &accepted, 6)
        .unwrap();
    assert_eq!(admitted.save.unwrap().state, ApplicationStepState::Accepted);
    assert!(admitted.completed_at_ms.is_none());
    let running = operation_record(&invocation, &context, OperationStatus::Running, None);
    assert!(
        owner
            .record_execution(&actor(false), &request, &running, 7)
            .unwrap()
            .completed_at_ms
            .is_none()
    );
    let succeeded = operation_record(
        &invocation,
        &context,
        OperationStatus::Succeeded,
        Some(project_output(&sha256(&d.text))),
    );
    let receipt = owner
        .record_execution(&actor(false), &request, &succeeded, 30_000)
        .unwrap();
    assert!(receipt.completed_at_ms.is_none());
    assert_eq!(receipt.save.unwrap().state, ApplicationStepState::Succeeded);
    assert_eq!(
        receipt.run.unwrap().state,
        ApplicationStepState::NotSubmitted
    );
    assert!(matches!(
        owner.begin_execution(
            &actor(false),
            &execute_request(&r, &grant, ApplicationExecutionStep::Run),
            30_000
        ),
        Err(ApplicationError::Offline)
    ));
    let lookups = owner
        .status_executions(
            &actor(true),
            &ApplicationCommandStatusArguments {
                window: r.session.window,
                request_id: "request".into(),
            },
        )
        .unwrap();
    assert_eq!(lookups.len(), 1);
    assert_eq!(lookups[0].1.context.caller, actor(true).caller);
}

#[test]
fn application_completion_time_is_set_only_after_the_final_scientific_step() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let grant = claim(&owner, &r, 3);
    assert!(complete(&owner, &r, &grant, 4).completed_at_ms.is_none());
    let save = execute_request(&r, &grant, ApplicationExecutionStep::Save);
    let ApplicationExecutionAdmission::Invoke {
        context,
        invocation,
    } = owner.begin_execution(&actor(false), &save, 5).unwrap()
    else {
        panic!()
    };
    let record = operation_record(
        &invocation,
        &context,
        OperationStatus::Succeeded,
        Some(project_output(&sha256(&d.text))),
    );
    assert!(
        owner
            .record_execution(&actor(false), &save, &record, 6)
            .unwrap()
            .completed_at_ms
            .is_none()
    );
    let run = execute_request(&r, &grant, ApplicationExecutionStep::Run);
    let ApplicationExecutionAdmission::Invoke {
        context,
        invocation,
    } = owner.begin_execution(&actor(false), &run, 7).unwrap()
    else {
        panic!()
    };
    let accepted = operation_record(&invocation, &context, OperationStatus::Accepted, None);
    assert!(
        owner
            .record_execution(&actor(false), &run, &accepted, 8)
            .unwrap()
            .completed_at_ms
            .is_none()
    );
    let running = operation_record(&invocation, &context, OperationStatus::Running, None);
    assert!(
        owner
            .record_execution(&actor(false), &run, &running, 9)
            .unwrap()
            .completed_at_ms
            .is_none()
    );
    let succeeded = operation_record(
        &invocation,
        &context,
        OperationStatus::Succeeded,
        Some(
            serde_json::json!({"session_id":"R-session-1","value":2,"stdout":"","stderr":"","conditions":[],"output_references":[]}),
        ),
    );
    let receipt = owner
        .record_execution(&actor(false), &run, &succeeded, 10)
        .unwrap();
    assert_eq!(receipt.state, ApplicationCommandState::Applied);
    assert_eq!(receipt.completed_at_ms, Some(10));
}
#[test]
fn digest_mismatch_or_actor_substitution_cannot_start_the_run() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let grant = claim(&owner, &r, 3);
    complete(&owner, &r, &grant, 4);
    let request = execute_request(&r, &grant, ApplicationExecutionStep::Save);
    let ApplicationExecutionAdmission::Invoke {
        context,
        invocation,
    } = owner.begin_execution(&actor(false), &request, 5).unwrap()
    else {
        panic!()
    };
    let substituted = operation_record(
        &invocation,
        &actor(false),
        OperationStatus::Succeeded,
        Some(project_output(&sha256(&d.text))),
    );
    assert_eq!(
        owner
            .record_execution(&actor(false), &request, &substituted, 6)
            .unwrap_err(),
        ApplicationError::RequestConflict
    );
    let mismatch = operation_record(
        &invocation,
        &context,
        OperationStatus::Succeeded,
        Some(project_output(&sha256("different actual bytes"))),
    );
    let receipt = owner
        .record_execution(&actor(false), &request, &mismatch, 6)
        .unwrap();
    assert_eq!(receipt.state, ApplicationCommandState::Uncertain);
    assert_eq!(
        receipt.run.unwrap().state,
        ApplicationStepState::NotSubmitted
    );
    assert!(
        owner
            .begin_execution(
                &actor(false),
                &execute_request(&r, &grant, ApplicationExecutionStep::Run),
                7
            )
            .is_err()
    );
}
#[test]
fn uncertain_admission_can_be_reconciled_with_its_original_accepted_record() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let grant = claim(&owner, &r, 3);
    complete(&owner, &r, &grant, 4);
    let request = execute_request(&r, &grant, ApplicationExecutionStep::Save);
    let ApplicationExecutionAdmission::Invoke {
        context,
        invocation,
    } = owner.begin_execution(&actor(false), &request, 5).unwrap()
    else {
        panic!()
    };
    owner
        .record_execution_error(
            &actor(false),
            &request,
            "lost admission acknowledgement".into(),
            6,
        )
        .unwrap();
    let original = operation_record(&invocation, &context, OperationStatus::Accepted, None);
    let receipt = owner
        .record_execution(&actor(false), &request, &original, 7)
        .unwrap();
    assert_eq!(receipt.save.unwrap().state, ApplicationStepState::Accepted);
    assert!(matches!(
        owner.begin_execution(&actor(false), &request, 8).unwrap(),
        ApplicationExecutionAdmission::Observe { .. }
    ));
}

#[test]
fn an_unchanged_empty_save_uses_project_evidence_without_an_operation_id() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let mut d = document("");
    d.base_text = Some(String::new());
    d.base_hash = Some(sha256(""));
    let d = sync(&owner, &r, d, 1);
    owner
        .control(
            &actor(true),
            ApplicationCommandRequest { execution_target: None,
                window: r.session.window.clone(),
                request_id: "empty-save".into(),
                action: ApplicationAction::Save {
                    document: document_ref(&d),
                    target_path: None,
                },
            },
            2,
        )
        .unwrap();
    let grant = claim(&owner, &r, 3);
    complete(&owner, &r, &grant, 4);
    let request = execute_request(&r, &grant, ApplicationExecutionStep::Save);
    let ApplicationExecutionAdmission::VerifySaved {
        context,
        path,
        sha256: digest,
    } = owner.begin_execution(&actor(false), &request, 5).unwrap()
    else {
        panic!()
    };
    assert_eq!(context.caller, actor(true).caller);
    assert_eq!(digest, sha256(""));
    let verified = ApplicationSaveVerification {
        path,
        sha256: digest,
        source: "project/filesystem".into(),
        observed_at_ms: 6,
    };
    let receipt = owner
        .record_saved_verification(&actor(false), &request, &verified, 6)
        .unwrap();
    let save = receipt.save.as_ref().unwrap();
    assert_eq!(save.state, ApplicationStepState::Succeeded);
    assert!(save.operation_id.is_none());
    assert_eq!(save.verification.as_ref(), Some(&verified));
    assert_eq!(
        owner
            .record_saved_verification(&actor(false), &request, &verified, 7)
            .unwrap(),
        receipt
    );
    assert!(
        owner
            .status_executions(
                &actor(true),
                &ApplicationCommandStatusArguments {
                    window: r.session.window,
                    request_id: "empty-save".into()
                }
            )
            .unwrap()
            .is_empty()
    );
}
#[test]
fn failed_empty_save_verification_reports_no_effect_without_replay() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let mut d = document("");
    d.base_text = Some(String::new());
    d.base_hash = Some(sha256(""));
    let d = sync(&owner, &r, d, 1);
    owner
        .control(
            &actor(true),
            ApplicationCommandRequest { execution_target: None,
                window: r.session.window.clone(),
                request_id: "empty-save".into(),
                action: ApplicationAction::Save {
                    document: document_ref(&d),
                    target_path: None,
                },
            },
            2,
        )
        .unwrap();
    let grant = claim(&owner, &r, 3);
    complete(&owner, &r, &grant, 4);
    let request = execute_request(&r, &grant, ApplicationExecutionStep::Save);
    assert!(matches!(
        owner.begin_execution(&actor(false), &request, 5).unwrap(),
        ApplicationExecutionAdmission::VerifySaved { .. }
    ));
    let receipt = owner
        .record_saved_verification_failure(&actor(false), &request, "file content changed", 6)
        .unwrap();
    assert_eq!(receipt.state, ApplicationCommandState::Failed);
    assert!(receipt.save.unwrap().operation_id.is_none());
    assert!(matches!(
        owner.begin_execution(&actor(false), &request, 7).unwrap(),
        ApplicationExecutionAdmission::Observe { .. }
    ));
}
#[test]
fn a_bridge_acknowledgement_cannot_claim_an_edit_that_its_resources_do_not_show() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    owner
        .control(
            &actor(true),
            ApplicationCommandRequest { execution_target: None,
                window: r.session.window.clone(),
                request_id: "missing-edit".into(),
                action: ApplicationAction::EditDocument {
                    document: document_ref(&d),
                    edits: vec![ApplicationTextEdit {
                        from: 5,
                        to: 6,
                        insert: "9".into(),
                    }],
                },
            },
            2,
        )
        .unwrap();
    let grant = claim(&owner, &r, 3);
    let receipt = complete(&owner, &r, &grant, 4);
    assert_eq!(receipt.state, ApplicationCommandState::Uncertain);
    assert!(receipt.diagnostic.unwrap().contains("could not confirm"));
    let actual = owner
        .context(
            &actor(true),
            ApplicationContextArguments {
                window: r.session.window,
                allow_offline: false,
                after_document_id: None,
                limit: None,
            },
            5,
        )
        .unwrap();
    assert_eq!(actual.current_document.unwrap().sha256, sha256(&d.text));
}

#[test]
fn native_read_controls_require_the_original_actor_scope_before_a_bridge_command_exists() {
    let owner = owner();
    let r = register(&owner, "window", 0);
    sync(&owner, &r, document("draft"), 1);
    let actions = [
        (
            "project.read",
            ApplicationAction::OpenDocument {
                path: "another.R".into(),
                expected_context_version: "context-v1".into(),
            },
        ),
        (
            "workspace.read",
            ApplicationAction::SelectObject {
                selection: ApplicationObjectSelection {
                    workspace_instance_id: None,
                    name: "x".into(),
                    object_ref: Some("object_1".into()),
                    native_session_id: "R-session-1".into(),
                },
                expected_context_version: "context-v1".into(),
            },
        ),
        (
            "workspace.read",
            ApplicationAction::SelectPackage {
                selection: ApplicationPackageSelection {
                    workspace_instance_id: None,
                    package: "stats".into(),
                    copy_id: "/library\nstats\n4.6".into(),
                    observation_id: "packages_1".into(),
                    native_session_id: "R-session-1".into(),
                },
                expected_context_version: "context-v1".into(),
            },
        ),
        (
            "workspace.read",
            ApplicationAction::SelectPlot {
                selection: ApplicationPlotSelection {
                    operation_id: OperationId::new("plot-operation").unwrap(),
                    sequence: 1,
                },
                expected_context_version: "context-v1".into(),
            },
        ),
    ];
    for (index, (required, action)) in actions.into_iter().enumerate() {
        let request = ApplicationCommandRequest { execution_target: None,
            window: r.session.window.clone(),
            request_id: format!("native-read-{index}"),
            action,
        };
        let mut denied = actor(true);
        denied.scopes.insert("application.control".into());
        assert_eq!(
            owner.control(&denied, request.clone(), 2).unwrap_err(),
            ApplicationError::AccessDenied {
                missing: vec![required.into()]
            }
        );
        assert!(
            owner
                .store
                .command(
                    &owner.scope(&denied).unwrap(),
                    "window",
                    &request.request_id
                )
                .unwrap()
                .is_none()
        );
        let mut allowed = denied;
        allowed.scopes.insert(required.into());
        let receipt = owner.control(&allowed, request.clone(), 3).unwrap();
        assert_eq!(receipt.state, ApplicationCommandState::Pending);
        assert_eq!(receipt.actor, actor(true).caller);
        let stored = owner
            .store
            .command(
                &owner.scope(&allowed).unwrap(),
                "window",
                &request.request_id,
            )
            .unwrap()
            .unwrap();
        assert_eq!(stored.context, allowed);
        assert_ne!(stored.context.caller, actor(false).caller);
    }
}
#[test]
fn application_owned_edits_and_creation_do_not_require_native_read_authority() {
    let owner = owner();
    let r = register(&owner, "window", 0);
    let d = sync(&owner, &r, document("draft"), 1);
    for (index, action) in [
        ApplicationAction::EditDocument {
            document: document_ref(&d),
            edits: vec![ApplicationTextEdit {
                from: 0,
                to: 1,
                insert: "D".into(),
            }],
        },
        ApplicationAction::SetSelection {
            document: document_ref(&d),
            anchor: 0,
            head: 1,
        },
        ApplicationAction::CreateDocument {
            path: None,
            text: "new draft".into(),
            expected_context_version: "context-v1".into(),
        },
        ApplicationAction::OpenView {
            view_type: ApplicationViewType::Files,
            view_id: None,
            expected_context_version: "context-v1".into(),
        },
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            owner
                .control(
                    &actor(true),
                    ApplicationCommandRequest { execution_target: None,
                        window: r.session.window.clone(),
                        request_id: format!("application-only-{index}"),
                        action
                    },
                    2
                )
                .unwrap()
                .state,
            ApplicationCommandState::Pending
        );
    }
}

#[test]
fn applied_document_receipt_does_not_follow_later_user_edits() {
    let owner=owner();let r=register(&owner,"window",0);let original=sync(&owner,&r,document("draft"),1);
    owner.control(&actor(true),ApplicationCommandRequest{execution_target:None,window:r.session.window.clone(),request_id:"edit".into(),action:ApplicationAction::EditDocument{document:document_ref(&original),edits:vec![ApplicationTextEdit{from:0,to:1,insert:"D".into()}]}},2).unwrap();
    let grant=claim(&owner,&r,3);
    let mut edited=original.clone();edited.version="doc-v2".into();edited.text="Draft".into();
    let completion=ApplicationCommandCompletion{request_id:"edit".into(),claim_id:grant.claim_id,outcome:ApplicationLocalOutcome::Applied,changes:ApplicationChanges{documents:vec![ApplicationDocumentUpdate{expected_version:Some(original.version),expected_selection_version:Some(original.selection.version),document:edited.clone()}],..Default::default()},diagnostic:None};
    let ApplicationBridgeReply::Completed(receipt)=owner.bridge(&actor(false),ApplicationBridgeRequest::Complete{session:r.session.clone(),completion},4).unwrap() else{panic!()};
    assert_eq!(receipt.applied_documents,Some(vec![document_ref(&edited)]));
    let mut later=edited.clone();later.version="doc-v3".into();later.text="later user input".into();
    owner.bridge(&actor(false),ApplicationBridgeRequest::Sync{session:r.session.clone(),sync_id:"later".into(),changes:ApplicationChanges{documents:vec![ApplicationDocumentUpdate{expected_version:Some(edited.version.clone()),expected_selection_version:Some(edited.selection.version.clone()),document:later}],..Default::default()}},5).unwrap();
    let receipt=owner.command_status(&actor(true),ApplicationCommandStatusArguments{window:r.session.window,request_id:"edit".into()},6).unwrap();
    assert_eq!(receipt.applied_documents,Some(vec![document_ref(&edited)]));
}

/// The runtime idle-release policy treats this one fact as its safety condition for
/// ending an unattended session, so its scope and expiry are load-bearing.
#[test]
fn window_liveness_is_principal_scoped_and_expires() {
    let owner = owner();
    assert!(!owner.any_window_online(&actor(false), 0).unwrap());
    register(&owner, "a", 0);
    assert!(owner.any_window_online(&actor(false), 1).unwrap());
    assert!(
        !owner
            .any_window_online(&actor(false), OFFLINE_AFTER_MS + 1)
            .unwrap(),
        "a window that stopped renewing is not online"
    );
    let mut other = actor(false);
    other.principal.as_mut().unwrap().id = "other".into();
    assert!(
        !owner.any_window_online(&other, 1).unwrap(),
        "another principal's window is not attendance for this session"
    );
}

#[test]
fn cancellation_prevents_unclaimed_or_unsubmitted_document_work() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "pending", 2);
    let receipt = owner
        .cancel_command(&actor(true), &r.session.window, "pending", 3)
        .unwrap();
    assert_eq!(receipt.state, ApplicationCommandState::Cancelled);
    assert!(matches!(
        owner
            .bridge(
                &actor(false),
                ApplicationBridgeRequest::Claim {
                    session: r.session.clone(),
                    claim_request_id: fresh(),
                },
                4
            )
            .unwrap(),
        ApplicationBridgeReply::Claimed(None)
    ));
    control(&owner, &r, &d, "claimed", 5);
    let grant = claim(&owner, &r, 6);
    assert_eq!(
        owner
            .cancel_command(&actor(true), &r.session.window, "claimed", 7)
            .unwrap()
            .state,
        ApplicationCommandState::Claimed
    );
    assert_eq!(
        complete(&owner, &r, &grant, 8).state,
        ApplicationCommandState::Cancelled
    );
    assert!(
        owner
            .begin_execution(
                &actor(false),
                &execute_request(&r, &grant, ApplicationExecutionStep::Save),
                9
            )
            .is_err()
    );
}

#[test]
fn cancellation_during_save_retains_its_result_and_fences_the_run() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    control(&owner, &r, &d, "request", 2);
    let grant = claim(&owner, &r, 3);
    complete(&owner, &r, &grant, 4);
    let request = execute_request(&r, &grant, ApplicationExecutionStep::Save);
    let ApplicationExecutionAdmission::Invoke {
        context,
        invocation,
    } = owner.begin_execution(&actor(false), &request, 5).unwrap()
    else {
        panic!()
    };
    assert!(
        owner
            .cancel_command(&actor(false), &r.session.window, "request", 6)
            .is_err()
    );
    let stopping = owner
        .cancel_command(&actor(true), &r.session.window, "request", 6)
        .unwrap();
    assert_eq!(stopping.state, ApplicationCommandState::AwaitingExecution);
    assert_eq!(
        stopping.save.unwrap().state,
        ApplicationStepState::Submitting
    );
    assert_eq!(stopping.run.unwrap().state, ApplicationStepState::Cancelled);
    let record = operation_record(
        &invocation,
        &context,
        OperationStatus::Succeeded,
        Some(project_output(&sha256(&d.text))),
    );
    let done = owner
        .record_execution(&actor(false), &request, &record, 7)
        .unwrap();
    assert_eq!(done.state, ApplicationCommandState::Cancelled);
    assert_eq!(done.save.unwrap().state, ApplicationStepState::Succeeded);
    assert!(
        owner
            .begin_execution(
                &actor(false),
                &execute_request(&r, &grant, ApplicationExecutionStep::Run),
                8
            )
            .is_err()
    );
}

#[test]
fn execution_target_is_checked_before_document_capture() {
    let owner = owner();
    let r = register(&owner, "a", 0);
    let d = sync(&owner, &r, document("x <- 2\n"), 1);
    let request = ApplicationCommandRequest {
        window: r.session.window.clone(),
        request_id: "wrong-session".into(),
        action: ApplicationAction::RunSelection {
            document: document_ref(&d),
        },
        execution_target: Some(ApplicationExecutionTarget {
            workspace_instance_id: "main".into(),
            native_session_id: "other-R".into(),
        }),
    };
    assert!(owner.control(&actor(true), request, 2).is_err());
    assert!(matches!(
        owner.command_status(
            &actor(true),
            ApplicationCommandStatusArguments {
                window: r.session.window,
                request_id: "wrong-session".into()
            },
            3
        ),
        Err(ApplicationError::NotFound)
    ));
}

#[test]
fn saved_document_acknowledgement_preserves_capture_and_rejects_concurrent_typing() {
    for changed in [false, true] {
        let owner = owner();
        let r = register(&owner, "a", 0);
        let d = sync(&owner, &r, document("x <- 2\n"), 1);
        control(&owner, &r, &d, "request", 2);
        let grant = claim(&owner, &r, 3);
        complete(&owner, &r, &grant, 4);
        let request = execute_request(&r, &grant, ApplicationExecutionStep::Save);
        let ApplicationExecutionAdmission::Invoke {
            context,
            invocation,
        } = owner.begin_execution(&actor(false), &request, 5).unwrap()
        else {
            panic!()
        };
        let record = operation_record(
            &invocation,
            &context,
            OperationStatus::Succeeded,
            Some(project_output(&sha256(&d.text))),
        );
        owner
            .record_execution(&actor(false), &request, &record, 6)
            .unwrap();
        let mut saved = d.clone();
        saved.version = "saved-version".into();
        saved.base_text = Some(d.text.clone());
        saved.base_hash = Some(sha256(&d.text));
        if changed {
            saved.text = "user input during save\n".into();
        }
        owner
            .bridge(
                &actor(false),
                ApplicationBridgeRequest::Sync {
                    session: r.session.clone(),
                    sync_id: fresh(),
                    changes: ApplicationChanges {
                        documents: vec![ApplicationDocumentUpdate {
                            expected_version: Some(d.version),
                            expected_selection_version: Some(d.selection.version),
                            document: saved.clone(),
                        }],
                        ..Default::default()
                    },
                },
                7,
            )
            .unwrap();
        let ack = ApplicationBridgeRequest::ConfirmSaved {
            session: r.session.clone(),
            request_id: "request".into(),
            execution_ref: grant.execution_ref.unwrap(),
            document: document_ref(&saved),
        };
        let ApplicationBridgeReply::Saved(receipt) =
            owner.bridge(&actor(false), ack.clone(), 8).unwrap()
        else {
            panic!()
        };
        assert_eq!(receipt.save_synchronized, Some(true));
        assert_eq!(
            receipt.applied_documents.as_ref().unwrap(),
            &if changed {
                vec![]
            } else {
                vec![document_ref(&saved)]
            }
        );
        let mut later = saved.clone();
        later.text = "later user input\n".into();
        later.version = "later".into();
        owner
            .bridge(
                &actor(false),
                ApplicationBridgeRequest::Sync {
                    session: r.session.clone(),
                    sync_id: fresh(),
                    changes: ApplicationChanges {
                        documents: vec![ApplicationDocumentUpdate {
                            expected_version: Some(saved.version),
                            expected_selection_version: Some(saved.selection.version),
                            document: later,
                        }],
                        ..Default::default()
                    },
                },
                9,
            )
            .unwrap();
        let ApplicationBridgeReply::Saved(repeated) = owner.bridge(&actor(false), ack, 10).unwrap()
        else {
            panic!()
        };
        assert_eq!(repeated, receipt);
    }
}

#[test]
fn exact_text_replacement_uses_editor_utf16_positions_without_mutating_the_document() {
    let owner=owner();let r=register(&owner,"match",0);
    let d=sync(&owner,&r,document("\u{feff}a😀\r\nstop('bad')\r\nz\r\n"),1);
    let ApplicationTextMatch::Unique(edit)=owner.prepare_text_replacement(&actor(false),&r.session.window,&document_ref(&d),"stop('bad')","",2).unwrap() else {panic!()};
    assert_eq!((edit.from,edit.to),(4,15));assert!(edit.insert.is_empty());
    let unchanged=owner.find_document(&owner.scope(&actor(false)).unwrap(),&r.session.window.window_id,&document_ref(&d)).unwrap();
    assert_eq!(unchanged,d);
    let ApplicationTextMatch::Unique(edit)=owner.prepare_text_replacement(&actor(false),&r.session.window,&document_ref(&d),"stop('bad')\r\n","ok\r\n",3).unwrap() else {panic!()};
    assert_eq!(edit.insert,"ok\n");
}

#[test]
fn exact_text_replacement_rejects_missing_ambiguous_and_overlapping_matches() {
    let owner=owner();let r=register(&owner,"match",0);
    let d=sync(&owner,&r,document("aaa\n"),1);
    assert!(matches!(owner.prepare_text_replacement(&actor(false),&r.session.window,&document_ref(&d),"aa","b",2).unwrap(),ApplicationTextMatch::Ambiguous));
    assert!(matches!(owner.prepare_text_replacement(&actor(false),&r.session.window,&document_ref(&d),"absent","b",2).unwrap(),ApplicationTextMatch::Missing));
    assert!(owner.prepare_text_replacement(&actor(false),&r.session.window,&document_ref(&d),"","b",2).is_err());
    let mut stale=document_ref(&d);stale.document_version="stale".into();
    assert!(matches!(owner.prepare_text_replacement(&actor(false),&r.session.window,&stale,"aaa","b",2),Err(ApplicationError::Conflict)));
}

#[test]
fn exact_text_replacement_cannot_edit_a_readonly_document() {
    let owner=owner();let r=register(&owner,"match",0);
    let mut d=document("readonly");d.readonly_reason=Some("read-only source".into());
    let d=sync(&owner,&r,d,1);
    assert!(owner.prepare_text_replacement(&actor(false),&r.session.window,&document_ref(&d),"readonly","changed",2).is_err());
}
