use rho_application::*;
use rho_contract::*;
use rho_sqlite::ApplicationStore;
use serde_json::json;
use std::sync::Arc;

struct Fixture {
    directory: tempfile::TempDir,
    store: Arc<ApplicationStore>,
    application: ApplicationOwner,
    native: AgentTaskOwner,
    rho: ComponentAgentOwner,
    handoff: AgentHandoffOwner,
    context: CallContext,
    actor: ComponentActor,
}
fn context(id: &str) -> CallContext {
    CallContext {
        view_scope: None,
        caller: CallerIdentity {
            kind: CallerKind::Human,
            id: id.into(),
        },
        principal: None,
        scopes: Default::default(),
        connection_id: "studio:handoff".into(),
        correlation_id: None,
        causation_id: None,
        trace_parent: None,
    }
}
fn actor(application: &ApplicationOwner, context: &CallContext, id: &str) -> ComponentActor {
    let ApplicationBridgeReply::Registered(window) = application
        .bridge(
            context,
            ApplicationBridgeRequest::Register {
                window_id: id.into(),
                incarnation: format!("{id}-life"),
                label: id.into(),
                previous_session: None,
            },
            1,
        )
        .unwrap()
    else {
        panic!()
    };
    application
        .component_actor(context, &window.session.window, 1)
        .unwrap()
}
fn selection(label: &str) -> AgentContextSelection {
    AgentContextSelection {
        source: "files".into(),
        label: label.into(),
        reference: json!({"path":"analysis.R","expected_sha256":"a".repeat(64)}),
        inclusion: "text".into(),
    }
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store =
            Arc::new(ApplicationStore::open(&directory.path().join("state.sqlite")).unwrap());
        let application = ApplicationOwner::new("/project".into(), store.clone());
        let context = context("alice");
        let actor = actor(&application, &context, "window");
        Self {
            directory,
            application,
            context,
            actor,
            native: AgentTaskOwner::new(store.clone()),
            rho: ComponentAgentOwner::new(store.clone(), "rho-host".into()),
            handoff: AgentHandoffOwner::new(store.clone()),
            store,
        }
    }
    fn create(&self, rho: bool, id: &str, text: &str) -> ProjectAgentTaskRef {
        let content = AgentDraftContent {
            text: text.into(),
            assets: vec![],
            context: vec![selection(if text == "Existing draft" {
                "Existing label"
            } else {
                "Source label"
            })],
        };
        if rho {
            let conversation = self
                .rho
                .create(&self.actor, id, ComponentAgentProfile::Objects, 2)
                .unwrap();
            self.rho
                .save_draft_content(
                    &self.actor,
                    id,
                    conversation.draft_version,
                    content,
                    Some(ComponentAgentGrant {
                        permission_policy: Some(if text == "Existing draft" {
                            ComponentPermissionPolicy::Ask
                        } else {
                            ComponentPermissionPolicy::FullAccess
                        }),
                        mode: ComponentAgentMode::Explain,
                        session: None,
                        documents: vec![],
                        files: vec![],
                    }),
                    3,
                )
                .unwrap();
            ProjectAgentTaskRef::Rho {
                conversation_id: id.into(),
            }
        } else {
            let created = self
                .native
                .admit(
                    &self.actor.scope().into(),
                    &AgentTaskRequest {
                        project_root: "/project".into(),
                        window: self.actor.window().clone().into(),
                        request_id: uuid::Uuid::new_v4().to_string(),
                        command: AgentTaskCommand::Create {
                            provider: AgentProvider::Codex,
                            model: "fixture-model".into(),
                            effort: None,
                        },
                    },
                    2,
                )
                .unwrap();
            let id = created.task.task.task_id;
            self.native
                .admit(
                    &self.actor.scope().into(),
                    &AgentTaskRequest {
                        project_root: "/project".into(),
                        window: self.actor.window().clone().into(),
                        request_id: uuid::Uuid::new_v4().to_string(),
                        command: AgentTaskCommand::SaveDraft {
                            control: AgentTaskControl {
                                task_id: id.clone(),
                                generation: 1,
                            },
                            version: 0,
                            content,
                        },
                    },
                    3,
                )
                .unwrap();
            ProjectAgentTaskRef::Native { task_id: id }
        }
    }
    fn command(
        &self,
        source: ProjectAgentTaskRef,
        target: ProjectAgentTaskRef,
    ) -> AgentHandoffCommand {
        let material = self
            .handoff
            .source(self.actor.scope(), &source, &[])
            .unwrap();
        let destination = self
            .handoff
            .target(self.actor.scope(), &target, self.actor.window())
            .unwrap();
        AgentHandoffCommand{project_root:"/project".into(),window:self.actor.window().clone(),request_id:uuid::Uuid::new_v4().to_string(),
            source,source_revision:material.revision,target,target_draft_version:destination.draft_version,target_control_generation:destination.control_generation,
            body:"Goal:\nContinue the study\n\nConfirmed:\nReviewed by the user\n\nNext:\nInspect the result".into(),context:material.context}
    }
    fn transfer(
        &self,
        request: &AgentHandoffCommand,
    ) -> Result<AgentHandoffReceipt, ApplicationError> {
        let write = || self.handoff.transfer(&self.actor, request, &[], 4);
        match request.target {
            ProjectAgentTaskRef::Native { .. } => self.native.with_handoff_write(write),
            ProjectAgentTaskRef::Rho { .. } => self.rho.with_handoff_write(write),
        }
    }
}

#[test]
fn all_target_kinds_preserve_existing_draft_and_scope_with_durable_idempotent_receipts() {
    for (source_rho, target_rho) in [(false, false), (false, true), (true, false), (true, true)] {
        let f = Fixture::new();
        let source = f.create(source_rho, "source", "Source goal");
        let target = f.create(target_rho, "target", "Existing draft");
        let before_source = f.handoff.source(f.actor.scope(), &source, &[]).unwrap();
        let before_target = f
            .handoff
            .target(f.actor.scope(), &target, f.actor.window())
            .unwrap();
        let old_native = if let ProjectAgentTaskRef::Native { task_id } = &target {
            Some(
                f.store
                    .agent_task(&f.actor.scope().into(), task_id)
                    .unwrap()
                    .unwrap(),
            )
        } else {
            None
        };
        let old_rho = if let ProjectAgentTaskRef::Rho { conversation_id } = &target {
            Some(
                f.store
                    .component_conversation(f.actor.scope(), conversation_id)
                    .unwrap()
                    .unwrap(),
            )
        } else {
            None
        };
        let request = f.command(source.clone(), target.clone());
        let receipt = f.transfer(&request).unwrap();
        let after = f
            .handoff
            .target(f.actor.scope(), &target, f.actor.window())
            .unwrap();
        assert_eq!(
            after.draft.text,
            format!("Existing draft\n\n{}", request.body)
        );
        assert_eq!(after.draft.context.len(), 1);
        assert_eq!(after.draft.context[0].label, "Existing label");
        assert_eq!(after.draft.assets, before_target.draft.assets);
        assert_eq!(after.draft_version, before_target.draft_version + 1);
        assert_eq!(
            f.handoff
                .source(f.actor.scope(), &source, &[])
                .unwrap()
                .revision,
            before_source.revision
        );
        let again = f.transfer(&request).unwrap();
        assert_eq!(again.target_draft_version, receipt.target_draft_version);
        assert_eq!(
            f.handoff
                .target(f.actor.scope(), &target, f.actor.window())
                .unwrap()
                .draft
                .text,
            after.draft.text
        );
        let reopened = ApplicationStore::open(&f.directory.path().join("state.sqlite")).unwrap();
        assert_eq!(
            reopened
                .handoff_receipt(f.actor.scope(), &request.request_id)
                .unwrap()
                .unwrap()
                .receipt
                .target_draft_version,
            receipt.target_draft_version
        );
        let mut changed = request.clone();
        changed.body.push_str(" altered");
        assert!(matches!(
            f.transfer(&changed),
            Err(ApplicationError::RequestConflict)
        ));
        if let Some(old) = old_native {
            let stored = f
                .store
                .agent_task(&f.actor.scope().into(), &old.task.task_id)
                .unwrap()
                .unwrap();
            assert_ne!(stored.revision, old.revision);
            assert_eq!(stored.task.mode, old.task.mode);
            assert_eq!(stored.active_request, old.active_request);
            assert!(matches!(
                f.store.commit_agent_task(
                    &f.actor.scope().into(),
                    AgentTaskWrite {
                        expected_revision: Some(&old.revision),
                        task: &old,
                        draft: None,
                        receipts: &[],
                        events: &[]
                    }
                ),
                Err(AgentTaskError::Conflict)
            ));
        }
        if let Some(old) = old_rho {
            let stored = f
                .store
                .component_conversation(f.actor.scope(), &old.conversation_id)
                .unwrap()
                .unwrap();
            assert_eq!(stored.draft_grant, old.draft_grant);
            assert_eq!(stored.active_run_id, old.active_run_id);
            assert_eq!(stored.version, old.version + 1);
            let mut stale = old.clone();
            stale.version += 1;
            assert!(matches!(
                f.store.commit_component(
                    f.actor.scope(),
                    ComponentWrite {
                        expected_version: Some(old.version),
                        conversation: &stale,
                        run: None,
                        tools: &[],
                        events: &[]
                    }
                ),
                Err(ApplicationError::Conflict)
            ));
        }
    }
}

#[test]
fn receipt_write_failure_rolls_back_target_then_original_request_can_retry() {
    for target_rho in [false, true] {
        let f = Fixture::new();
        let source = f.create(true, "source", "Source goal");
        let target = f.create(target_rho, "target", "Existing draft");
        let request = f.command(source.clone(), target.clone());
        let before = f
            .handoff
            .target(f.actor.scope(), &target, f.actor.window())
            .unwrap();
        let source_before = f.handoff.source(f.actor.scope(), &source, &[]).unwrap();
        let connection =
            rusqlite::Connection::open(f.directory.path().join("state.agent-v1.sqlite")).unwrap();
        connection.execute_batch("CREATE TRIGGER fail_handoff BEFORE INSERT ON agent_handoff_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;").unwrap();
        assert!(matches!(
            f.transfer(&request),
            Err(ApplicationError::Storage(_))
        ));
        let after = f
            .handoff
            .target(f.actor.scope(), &target, f.actor.window())
            .unwrap();
        assert_eq!(after.draft_version, before.draft_version);
        assert_eq!(after.draft.text, before.draft.text);
        assert_eq!(
            f.handoff
                .source(f.actor.scope(), &source, &[])
                .unwrap()
                .revision,
            source_before.revision
        );
        assert!(
            f.handoff
                .receipt(f.actor.scope(), &request.request_id)
                .unwrap()
                .is_none()
        );
        connection
            .execute_batch("DROP TRIGGER fail_handoff")
            .unwrap();
        f.transfer(&request).unwrap();
    }
}

#[test]
fn stale_source_target_or_forged_reference_never_changes_target_draft() {
    let f = Fixture::new();
    let source = f.create(true, "source", "Source goal");
    let target = f.create(true, "target", "Existing draft");
    let request = f.command(source.clone(), target.clone());
    let mut forged = request.clone();
    forged.context[0].reference["path"] = json!("../other-project/secret");
    assert!(matches!(
        f.transfer(&forged),
        Err(ApplicationError::InvalidInput(_))
    ));
    let mut stale = request.clone();
    stale.target_draft_version -= 1;
    assert!(matches!(
        f.transfer(&stale),
        Err(ApplicationError::Conflict)
    ));
    let current = f
        .store
        .component_conversation(f.actor.scope(), "source")
        .unwrap()
        .unwrap();
    f.rho
        .save_draft_content(
            &f.actor,
            "source",
            current.draft_version,
            AgentDraftContent {
                text: "A changed source goal".into(),
                assets: vec![],
                context: vec![],
            },
            current.draft_grant,
            4,
        )
        .unwrap();
    let error = f.transfer(&request).unwrap_err();
    assert_eq!(error.diagnostic().code, DiagnosticCode::ObservationExpired);
    assert_eq!(
        f.handoff
            .target(f.actor.scope(), &target, f.actor.window())
            .unwrap()
            .draft
            .text,
        "Existing draft"
    );
    assert!(
        f.handoff
            .receipt(f.actor.scope(), &request.request_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn scope_and_target_controller_are_checked_but_source_can_be_archived_and_read_only() {
    for target_rho in [false, true] {
        let f = Fixture::new();
        let source = f.create(true, "source", "Source goal");
        let target = f.create(target_rho, "target", "Existing draft");
        let source_row = f
            .store
            .component_conversation(f.actor.scope(), "source")
            .unwrap()
            .unwrap();
        f.rho
            .update_task_metadata(&f.actor, "source", source_row.version, None, Some(true), 4)
            .unwrap();
        let request = f.command(source.clone(), target.clone());
        f.transfer(&request).unwrap();
        let request = f.command(source.clone(), target.clone());
        let expected_target = f
            .handoff
            .target(f.actor.scope(), &target, f.actor.window())
            .unwrap()
            .draft
            .text;
        let another = actor(&f.application, &f.context, "another");
        assert!(f.handoff.source(another.scope(), &source, &[]).is_ok());
        let mut wrong_window = request.clone();
        wrong_window.window = another.window().clone();
        assert!(matches!(
            f.handoff.transfer(&another, &wrong_window, &[], 4),
            Err(ApplicationError::Conflict)
        ));
        let bob_context = context("bob");
        let bob = actor(&f.application, &bob_context, "window");
        assert!(matches!(
            f.handoff.source(bob.scope(), &source, &[]),
            Err(ApplicationError::NotFound)
        ));
        assert!(matches!(
            f.handoff.transfer(&bob, &request, &[], 4),
            Err(ApplicationError::NotFound)
        ));
        let mut outside = request.clone();
        outside.project_root = "/different".into();
        assert!(f.transfer(&outside).is_err());
        if let ProjectAgentTaskRef::Native { task_id } = &target {
            let mut stale_generation = request.clone();
            stale_generation.target_control_generation = Some(999);
            assert!(matches!(
                f.transfer(&stale_generation),
                Err(ApplicationError::Conflict)
            ));
            for frozen in [true, false] {
                let old = f
                    .store
                    .agent_task(&f.actor.scope().into(), task_id)
                    .unwrap()
                    .unwrap();
                let mut changed = old.clone();
                changed.attachment.control_frozen = frozen;
                changed.revision = uuid::Uuid::new_v4().to_string();
                changed.observation_version += 1;
                f.store
                    .commit_agent_task(
                        &f.actor.scope().into(),
                        AgentTaskWrite {
                            expected_revision: Some(&old.revision),
                            task: &changed,
                            draft: None,
                            receipts: &[],
                            events: &[],
                        },
                    )
                    .unwrap();
                if frozen {
                    assert!(matches!(
                        f.transfer(&request),
                        Err(ApplicationError::Conflict)
                    ));
                }
            }
        }
        if let ProjectAgentTaskRef::Rho { conversation_id } = &target {
            let target_row = f
                .store
                .component_conversation(f.actor.scope(), conversation_id)
                .unwrap()
                .unwrap();
            f.rho
                .update_task_metadata(
                    &f.actor,
                    conversation_id,
                    target_row.version,
                    None,
                    Some(true),
                    4,
                )
                .unwrap();
        } else if let ProjectAgentTaskRef::Native { task_id } = &target {
            f.native
                .admit(
                    &f.actor.scope().into(),
                    &AgentTaskRequest {
                        project_root: "/project".into(),
                        window: f.actor.window().clone().into(),
                        request_id: uuid::Uuid::new_v4().to_string(),
                        command: AgentTaskCommand::Archive {
                            control: AgentTaskControl {
                                task_id: task_id.clone(),
                                generation: 1,
                            },
                            archived: true,
                        },
                    },
                    4,
                )
                .unwrap();
        }
        assert!(matches!(
            f.transfer(&request),
            Err(ApplicationError::Conflict)
        ));
        assert_eq!(
            f.handoff
                .target(f.actor.scope(), &target, f.actor.window())
                .unwrap()
                .draft
                .text,
            expected_target
        );
    }
}

#[test]
fn source_uploads_stay_with_their_owner_and_target_uploads_are_preserved() {
    for target_rho in [false, true] {
        let f = Fixture::new();
        let source = f.create(true, "source", "Source goal");
        let target = f.create(target_rho, "target", "Existing draft");
        let asset = |name: &str, bytes: &[u8]| AgentAsset {
            asset_id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            mime_type: "text/plain".into(),
            bytes: bytes.len() as u64,
            sha256: sha256(bytes),
        };
        let source_asset = asset("source.txt", b"source-private-content");
        f.rho
            .put_asset(
                &f.actor,
                "source",
                &source_asset,
                b"source-private-content",
                3,
            )
            .unwrap();
        let current = f
            .store
            .component_conversation(f.actor.scope(), "source")
            .unwrap()
            .unwrap();
        let mut draft = current.draft_content;
        draft.assets.push(source_asset.asset_id.clone());
        f.rho
            .save_draft_content(
                &f.actor,
                "source",
                current.draft_version,
                draft,
                current.draft_grant,
                3,
            )
            .unwrap();
        let target_asset = asset("keep.txt", b"keep");
        match &target {
            ProjectAgentTaskRef::Native { task_id } => {
                f.store
                    .put_agent_asset(&f.actor.scope().into(), task_id, &target_asset, b"keep")
                    .unwrap();
                let mut draft = f.store.agent_draft(&f.actor.scope().into(), task_id).unwrap();
                draft.content.assets.push(target_asset.asset_id.clone());
                f.native
                    .admit(
                        &f.actor.scope().into(),
                        &AgentTaskRequest {
                            project_root: "/project".into(),
                            window: f.actor.window().clone().into(),
                            request_id: uuid::Uuid::new_v4().to_string(),
                            command: AgentTaskCommand::SaveDraft {
                                control: AgentTaskControl {
                                    task_id: task_id.clone(),
                                    generation: 1,
                                },
                                version: draft.version,
                                content: draft.content,
                            },
                        },
                        3,
                    )
                    .unwrap();
            }
            ProjectAgentTaskRef::Rho { conversation_id } => {
                f.rho
                    .put_asset(&f.actor, conversation_id, &target_asset, b"keep", 3)
                    .unwrap();
                let current = f
                    .store
                    .component_conversation(f.actor.scope(), conversation_id)
                    .unwrap()
                    .unwrap();
                let mut draft = current.draft_content;
                draft.assets.push(target_asset.asset_id.clone());
                f.rho
                    .save_draft_content(
                        &f.actor,
                        conversation_id,
                        current.draft_version,
                        draft,
                        current.draft_grant,
                        3,
                    )
                    .unwrap();
            }
        }
        let material = f.handoff.source(f.actor.scope(), &source, &[]).unwrap();
        assert!(
            material
                .notices
                .iter()
                .any(|notice| notice.contains("attachments"))
        );
        assert!(!material.body.contains("source-private-content"));
        assert!(
            material
                .context
                .iter()
                .all(|selection| selection.source != "attachments")
        );
        f.transfer(&f.command(source, target.clone())).unwrap();
        let merged = f
            .handoff
            .target(f.actor.scope(), &target, f.actor.window())
            .unwrap();
        assert_eq!(merged.draft.assets, vec![target_asset.asset_id]);
        assert_eq!(
            f.store
                .component_asset(f.actor.scope(), "source", &source_asset.asset_id)
                .unwrap()
                .1,
            b"source-private-content"
        );
    }
}

#[test]
fn successful_native_send_uses_latest_retained_user_goal_after_draft_and_receipt_are_cleared() {
    let f = Fixture::new();
    let source = f.create(false, "source", "Plot the cluster labels");
    let ProjectAgentTaskRef::Native { task_id } = &source else {
        panic!()
    };
    let draft = f.store.agent_draft(&f.actor.scope().into(), task_id).unwrap();
    let sent = f
        .native
        .admit(
            &f.actor.scope().into(),
            &AgentTaskRequest {
                project_root: "/project".into(),
                window: f.actor.window().clone().into(),
                request_id: uuid::Uuid::new_v4().to_string(),
                command: AgentTaskCommand::Send {
                    control: AgentTaskControl {
                        task_id: task_id.clone(),
                        generation: 1,
                    },
                    draft_version: draft.version,
                },
            },
            4,
        )
        .unwrap();
    let mut receipt = sent.receipt;
    receipt.status = "succeeded".into();
    receipt.submitted_draft = None;
    receipt.native_session_id = Some("native-source".into());
    receipt.updated_at_ms = 5;
    f.native
        .update(
            &f.actor.scope().into(),
            task_id,
            sent.task.attachment.generation,
            |task, draft, receipts, events| {
                task.task.native_session_id = Some("native-source".into());
                task.attachment.state = "ready".into();
                task.active_request = None;
                task.event_cursor = 5;
                task.history_gap = true;
                draft.content = AgentDraftContent::default();
                draft.version += 1;
                draft.updated_at_ms = 5;
                receipts.push(receipt.clone());
                for (index, role, text) in [
                    (1, "user", "Earlier question"),
                    (2, "user", "Plot the cluster labels"),
                    (3, "assistant", "All results are fully verified"),
                    (4, "user", ""),
                    (5, "user", "   "),
                ] {
                    events.push(AgentTaskEvent {
                        usage: None,
                        sequence: index,
                        event_id: format!("event-{index}"),
                        request_id: Some(receipt.request_id.clone()),
                        generation: task.attachment.generation,
                        native_session_id: "native-source".into(),
                        native_turn_id: None,
                        native_item_id: None,
                        kind: "message".into(),
                        role: Some(role.into()),
                        text: text.into(),
                        status: None,
                        source: "native_history".into(),
                        observed_at_ms: 5,
                    });
                }
                Ok(())
            },
        )
        .unwrap();
    let other = f.create(false, "another", "Other task goal");
    let ProjectAgentTaskRef::Native { task_id: other } = &other else {
        panic!()
    };
    f.native
        .update(&f.actor.scope().into(), other, 1, |task, _, _, events| {
            task.task.native_session_id = Some("other-native".into());
            task.event_cursor = 99;
            events.push(AgentTaskEvent {
                usage: None,
                sequence: 99,
                event_id: "unrelated-user".into(),
                request_id: None,
                generation: 1,
                native_session_id: "other-native".into(),
                native_turn_id: None,
                native_item_id: None,
                kind: "message".into(),
                role: Some("user".into()),
                text: "Wrong task text".into(),
                status: None,
                source: "native_history".into(),
                observed_at_ms: 6,
            });
            Ok(())
        })
        .unwrap();
    assert!(
        f.store
            .agent_draft(&f.actor.scope().into(), task_id)
            .unwrap()
            .content
            .text
            .is_empty()
    );
    assert!(
        f.store
            .agent_receipt(&f.actor.scope().into(), &receipt.request_id)
            .unwrap()
            .unwrap()
            .submitted_draft
            .is_none()
    );
    let material = f.handoff.source(f.actor.scope(), &source, &[]).unwrap();
    assert!(
        material
            .body
            .starts_with("Goal:\nPlot the cluster labels\n")
    );
    assert!(material.body.contains("Confirmed:\n\nNext:\n"));
    assert!(
        !material.body.contains("fully verified") && !material.body.contains("Wrong task text")
    );
    assert!(material.truncated);
    assert!(
        material
            .notices
            .iter()
            .any(|notice| notice.contains("message history is incomplete"))
    );
}
