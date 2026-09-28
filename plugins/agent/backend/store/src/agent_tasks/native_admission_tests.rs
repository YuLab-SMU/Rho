use super::*;
use rho_agent_owner::{AgentNativeCommandOrigin, AgentTaskAdmission, AgentTaskOwner};
use serde::Serialize;
use std::sync::Arc;

fn scope() -> AgentTaskScope {
    AgentTaskScope {
        project: "/native-fixture".into(),
        principal: "fixture-user".into(),
    }
}
fn origin() -> AgentNativeCommandOrigin {
    serde_json::from_value(serde_json::json!({
        "operation":uuid::Uuid::new_v4().to_string(),
        "request":uuid::Uuid::new_v4().to_string(),
        "binding":{"capability":{"id":"agent.native.command","version":1},
            "provider":{"instance":"agent-one","plugin":"org.rho.agent",
                "revision":format!("sha256:{}", "a".repeat(64)),
                "artifact":format!("sha256:{}", "b".repeat(64))},
            "project":"fixture-native-project","target":null},
        "project_root":scope().project,"principal":scope().principal,
        "scopes":["application.control","plugins.read"]
    }))
    .unwrap()
}

fn scientific_origin() -> AgentNativeCommandOrigin {
    let mut origin = origin();
    origin.scopes.insert("workspace.run_r".into());
    let mut binding = origin.binding.clone();
    binding.provider.instance = serde_json::from_value(serde_json::json!("r-one")).unwrap();
    binding.provider.plugin = serde_json::from_value(serde_json::json!("org.rho.r")).unwrap();
    binding.capability.id = serde_json::from_value(serde_json::json!("r.execute")).unwrap();
    binding.capability.version = 2;
    binding.target = Some("original-session".into());
    origin.tools = vec![AgentNativeToolGrant {
        selection: AgentNativeToolSelection {
            name: "execute".into(),
            target: AgentNativeToolTarget::Provider { binding },
        },
        kind: AgentNativeToolKind::Operation,
        description: "Execute in the captured session".into(),
        input_schema: serde_json::json!({"type":"object"}),
        required_scopes: ["workspace.run_r".into()].into(),
    }];
    origin
}

#[test]
fn native_tools_capture_exact_selection_and_deduplicate_semantic_requests_after_stop_and_reopen() {
    let (directory, store, owner, created) = setup();
    let saved = draft(&owner, &created.task, 0, "Use selected tools");
    let command = request(AgentTaskCommand::Send {
        control: control(&saved.task),
        draft_version: 1,
    });
    let parent = scientific_origin();
    let sent = owner
        .admit_native(&scope(), &command, parent.clone(), 3)
        .unwrap();
    let mut altered = parent.clone();
    let AgentNativeToolTarget::Provider { binding } = &mut altered.tools[0].selection.target else {
        panic!("expected provider")
    };
    binding.target = Some("another-session".into());
    assert!(matches!(
        owner.admit_native(&scope(), &command, altered, 4),
        Err(AgentTaskError::RequestConflict)
    ));
    let input = AgentNativeToolInvocation {
        send_request: command.request_id.clone(),
        tool_request: uuid::Uuid::new_v4().to_string(),
        tool: "execute".into(),
        arguments: serde_json::json!({"code":"original Unicode 数据"}),
        preconditions: serde_json::Value::Null,
    };
    let id = &sent.task.task.task_id;
    let generation = sent.task.attachment.generation;
    let (prepared, repeated) = owner
        .admit_native_tool(&scope(), id, generation, input.clone(), 5)
        .unwrap();
    assert!(!repeated);
    let AgentNativeToolRequest::Provider { request: admitted } = &prepared.native_request else {
        panic!("expected provider request")
    };
    let AgentNativeToolTarget::Provider { binding: selected } = &parent.tools[0].selection.target
    else {
        panic!("expected provider")
    };
    assert_eq!(&admitted.binding, selected);
    assert_ne!(prepared.request, parent.request);
    let (retry, repeated) = owner
        .admit_native_tool(&scope(), id, generation, input.clone(), 6)
        .unwrap();
    assert!(repeated);
    assert_eq!(retry, prepared);
    let mut changed = input.clone();
    changed.arguments = serde_json::json!({"code":"different effect"});
    assert!(matches!(
        owner.admit_native_tool(&scope(), id, generation, changed, 6),
        Err(AgentTaskError::RequestConflict)
    ));
    owner
        .admit_native(
            &scope(),
            &request(AgentTaskCommand::Stop {
                control: control(&sent.task),
            }),
            origin(),
            7,
        )
        .unwrap();
    let mut fresh = input.clone();
    fresh.tool_request = uuid::Uuid::new_v4().to_string();
    assert!(
        owner
            .admit_native_tool(&scope(), id, generation, fresh, 8)
            .is_err()
    );
    assert!(
        owner
            .admit_native_tool(&scope(), id, generation, input.clone(), 8)
            .unwrap()
            .1
    );
    let mut resolved = prepared.clone();
    resolved.phase = AgentNativeToolPhase::Resolved;
    resolved.operation =
        Some(rho_agent_api::component::OperationId::new("original-child").unwrap());
    resolved.result = Some(serde_json::json!({"status":"succeeded","output":"retained"}));
    resolved.updated_at_ms = 9;
    store.put_agent_native_tool(&scope(), &resolved).unwrap();
    let mut replaced = resolved.clone();
    replaced.result = Some(serde_json::json!("changed"));
    assert!(matches!(
        store.put_agent_native_tool(&scope(), &replaced),
        Err(AgentTaskError::RequestConflict)
    ));
    let foreign = AgentTaskScope {
        principal: "other".into(),
        ..scope()
    };
    assert!(
        store
            .agent_native_tool(&foreign, &input.send_request, &input.tool_request)
            .unwrap()
            .is_none()
    );
    let reopened = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let next = AgentTaskOwner::new(reopened);
    let (observed, repeated) = next
        .admit_native_tool(&scope(), id, generation, input, 10)
        .unwrap();
    assert!(repeated);
    assert_eq!(observed, resolved);
}

#[test]
fn native_tools_refuse_invalid_capture_missing_scope_and_storage_failure_before_dispatch() {
    let (_directory, store, owner, created) = setup();
    let saved = draft(&owner, &created.task, 0, "Bounded tool work");
    let command = request(AgentTaskCommand::Send {
        control: control(&saved.task),
        draft_version: 1,
    });
    for variant in 0..3 {
        let mut invalid = scientific_origin();
        match variant {
            0 => {
                invalid.scopes.remove("workspace.run_r");
            }
            1 => invalid.tools.push(invalid.tools[0].clone()),
            _ => {
                let AgentNativeToolTarget::Provider { binding } =
                    &mut invalid.tools[0].selection.target
                else {
                    panic!("expected provider")
                };
                binding.project =
                    serde_json::from_value(serde_json::json!("foreign-project")).unwrap();
            }
        }
        assert!(owner.admit_native(&scope(), &command, invalid, 3).is_err());
        assert!(
            store
                .agent_receipt(&scope(), &command.request_id)
                .unwrap()
                .is_none()
        );
    }
    let sent = owner
        .admit_native(&scope(), &command, scientific_origin(), 3)
        .unwrap();
    let input = AgentNativeToolInvocation {
        send_request: command.request_id,
        tool_request: uuid::Uuid::new_v4().to_string(),
        tool: "execute".into(),
        arguments: serde_json::json!({}),
        preconditions: serde_json::Value::Null,
    };
    let invoke = |input| {
        owner.admit_native_tool(
            &scope(),
            &sent.task.task.task_id,
            sent.task.attachment.generation,
            input,
            4,
        )
    };
    let mut oversized = input.clone();
    oversized.arguments =
        serde_json::json!("x".repeat(rho_agent_owner::MAX_NATIVE_TOOL_ARGUMENT_BYTES));
    assert!(matches!(invoke(oversized), Err(AgentTaskError::Budget(_))));
    store.0.lock().unwrap().execute_batch("CREATE TRIGGER fail_tool BEFORE INSERT ON agent_native_tools BEGIN SELECT RAISE(ABORT, 'injected native tool write failure'); END;").unwrap();
    assert!(matches!(
        invoke(input.clone()),
        Err(AgentTaskError::Storage(_))
    ));
    assert!(
        store
            .agent_native_tool(&scope(), &input.send_request, &input.tool_request)
            .unwrap()
            .is_none()
    );
    store
        .0
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_tool;")
        .unwrap();
    let (record, _) = invoke(input.clone()).unwrap();
    let mut changed = record.clone();
    let AgentNativeToolRequest::Provider { request } = &mut changed.native_request else {
        panic!("expected provider request")
    };
    request.binding.target = Some("forged-target".into());
    assert!(store.put_agent_native_tool(&scope(), &changed).is_err());
    store
        .0
        .lock()
        .unwrap()
        .execute(
            "UPDATE agent_native_tools SET bytes=?1",
            [rho_agent_owner::MAX_PROJECT_NATIVE_TOOL_BYTES],
        )
        .unwrap();
    let mut fresh = input;
    fresh.tool_request = uuid::Uuid::new_v4().to_string();
    assert!(matches!(invoke(fresh), Err(AgentTaskError::Budget(_))));
}
fn request(command: AgentTaskCommand) -> AgentTaskRequest {
    AgentTaskRequest {
        project_root: scope().project,
        window: AgentControllerRef {
            window_id: "window-one".into(),
            incarnation: "connection-one".into(),
        },
        request_id: uuid::Uuid::new_v4().to_string(),
        command,
    }
}
fn create() -> AgentTaskRequest {
    request(AgentTaskCommand::Create {
        provider: AgentProvider::Kimi,
        model: "fixture".into(),
        effort: None,
    })
}
fn control(task: &StoredAgentTask) -> AgentTaskControl {
    AgentTaskControl {
        task_id: task.task.task_id.clone(),
        generation: task.attachment.generation,
    }
}
fn json(value: &impl Serialize) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}
fn setup() -> (
    tempfile::TempDir,
    Arc<AgentStore>,
    AgentTaskOwner,
    AgentTaskAdmission,
) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let owner = AgentTaskOwner::new(store.clone());
    let admitted = owner
        .admit_native(&scope(), &create(), origin(), 1)
        .unwrap();
    (directory, store, owner, admitted)
}
fn draft(
    owner: &AgentTaskOwner,
    task: &StoredAgentTask,
    version: u64,
    text: &str,
) -> AgentTaskAdmission {
    owner
        .admit_native(
            &scope(),
            &request(AgentTaskCommand::SaveDraft {
                control: control(task),
                version,
                content: AgentDraftContent {
                    text: text.into(),
                    assets: vec![],
                    context: vec![AgentContextSelection {
                        source: "plugins.source".into(),
                        label: "插件分支".into(),
                        reference: serde_json::json!({"version":"frozen-version"}),
                        inclusion: "reference".into(),
                    }],
                },
            }),
            origin(),
            2,
        )
        .unwrap()
}
fn capture(store: &AgentStore, admitted: &AgentTaskAdmission) -> StoredAgentNativeAdmission {
    store
        .agent_native_admission(&scope(), &admitted.receipt.request_id)
        .unwrap()
        .unwrap()
}

#[test]
fn native_admission_preserves_original_parent_and_pre_command_input_across_retries() {
    let (_directory, store, owner, created) = setup();
    let saved = draft(&owner, &created.task, 0, "Original Unicode 科学内容");
    let configured_request = request(AgentTaskCommand::Configure {
        control: control(&saved.task),
        model: "next-model".into(),
        effort: Some("high".into()),
        mode: None,
    });
    let configured = owner
        .admit_native(&scope(), &configured_request, origin(), 3)
        .unwrap();
    let retained = capture(&store, &configured);
    assert_eq!(retained.input_task.model, "fixture");
    assert_eq!(
        retained.input_draft.content.text,
        "Original Unicode 科学内容"
    );
    assert_eq!(configured.task.task.model, "next-model");
    assert!(configured.receipt.input_context.is_empty());
    let mut repeated_origin = origin();
    repeated_origin.scopes.insert("unrelated.read".into());
    let repeated = owner
        .admit_native(&scope(), &configured_request, repeated_origin, 4)
        .unwrap();
    assert!(repeated.repeated && !repeated.native);
    assert_eq!(json(&capture(&store, &configured)), json(&retained));
    assert_eq!(json(&repeated.task), json(&configured.task));
    let mut changed = configured_request.clone();
    changed.window.incarnation = "replacement".into();
    assert!(matches!(
        owner.admit_native(&scope(), &changed, origin(), 5),
        Err(AgentTaskError::RequestConflict)
    ));
    let mut foreign = json(&origin());
    foreign["binding"]["provider"]["instance"] = "agent-other".into();
    assert!(matches!(
        owner.admit_native(
            &scope(),
            &configured_request,
            serde_json::from_value(foreign).unwrap(),
            5
        ),
        Err(AgentTaskError::RequestConflict)
    ));
    let second = draft(&owner, &configured.task, 1, "New editable draft");
    assert_eq!(
        capture(&store, &second).input_draft.content.text,
        "Original Unicode 科学内容"
    );
    assert_eq!(second.draft.content.text, "New editable draft");
}

#[test]
fn native_admission_reopen_observes_uncertainty_and_keeps_submitted_input() {
    let (directory, store, owner, created) = setup();
    let saved = draft(&owner, &created.task, 0, "Run once");
    let send_request = request(AgentTaskCommand::Send {
        control: control(&saved.task),
        draft_version: 1,
    });
    let sent = owner
        .admit_native(&scope(), &send_request, origin(), 3)
        .unwrap();
    assert!(sent.native);
    let original = capture(&store, &sent);
    assert_eq!(original.input_draft.content.text, "Run once");
    let later = draft(&owner, &sent.task, 1, "Next message");
    let before = store
        .agent_task(&scope(), &sent.task.task.task_id)
        .unwrap()
        .unwrap();
    drop(owner);
    drop(store);
    let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let owner = AgentTaskOwner::new(store.clone());
    let detail = owner.detail(&scope(), &sent.task.task.task_id).unwrap();
    assert_eq!(detail.draft.content.text, "Next message");
    assert_eq!(detail.summary.attachment.state, "uncertain");
    assert_eq!(json(&capture(&store, &sent)), json(&original));
    assert_eq!(
        json(
            &store
                .agent_task(&scope(), &sent.task.task.task_id)
                .unwrap()
                .unwrap()
        ),
        json(&before)
    );
    let repeated = owner
        .admit_native(&scope(), &send_request, origin(), 8)
        .unwrap();
    assert!(repeated.repeated && !repeated.native);
    assert_eq!(json(&repeated.draft), json(&later.draft));
    assert_eq!(repeated.receipt.status, "prepared");
    for foreign in [
        AgentTaskScope {
            principal: "other-user".into(),
            ..scope()
        },
        AgentTaskScope {
            project: "/other".into(),
            ..scope()
        },
    ] {
        assert!(
            store
                .agent_native_admission(&foreign, &send_request.request_id)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .agent_receipt(&foreign, &send_request.request_id)
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn native_admission_failure_rolls_back_capture_task_draft_and_receipt_together() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let owner = AgentTaskOwner::new(store.clone());
    store.0.lock().unwrap().execute_batch("CREATE TRIGGER fail_draft BEFORE INSERT ON agent_task_drafts BEGIN SELECT RAISE(ABORT,'fixture write fault'); END;").unwrap();
    let command = create();
    let parent = origin();
    assert!(matches!(
        owner.admit_native(&scope(), &command, parent.clone(), 1),
        Err(AgentTaskError::Storage(_))
    ));
    assert!(
        store
            .agent_native_admission(&scope(), &command.request_id)
            .unwrap()
            .is_none()
    );
    let count: u32 = store.0.lock().unwrap().query_row("SELECT (SELECT COUNT(*) FROM agent_tasks)+(SELECT COUNT(*) FROM agent_task_drafts)+(SELECT COUNT(*) FROM agent_task_receipts)+(SELECT COUNT(*) FROM agent_native_admissions)", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
    store
        .0
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_draft;")
        .unwrap();
    let admitted = owner
        .admit_native(&scope(), &command, parent.clone(), 2)
        .unwrap();
    assert!(!admitted.repeated);
    assert_eq!(capture(&store, &admitted).origin, parent);
    assert_eq!(
        store.agent_tasks(&scope(), None, None, 20).unwrap().len(),
        1
    );
}

#[test]
fn native_admission_cannot_be_replaced_or_launder_changed_receipts() {
    let (_directory, store, owner, created) = setup();
    let saved = draft(&owner, &created.task, 0, "Bound original input");
    let sent = owner
        .admit_native(
            &scope(),
            &request(AgentTaskCommand::Send {
                control: control(&saved.task),
                draft_version: 1,
            }),
            origin(),
            3,
        )
        .unwrap();
    let original = capture(&store, &sent);
    let mut task = sent.task.clone();
    task.task.title = "Must roll back".into();
    let mut changed = original.clone();
    changed.origin = origin();
    assert!(matches!(
        store.commit_agent_native_admission(
            &scope(),
            AgentTaskWrite {
                expected_revision: Some(&sent.task.revision),
                task: &task,
                draft: None,
                receipts: std::slice::from_ref(&sent.receipt),
                events: &[],
            },
            &changed
        ),
        Err(AgentTaskError::RequestConflict)
    ));
    for mutation in 0..4 {
        let mut receipt = sent.receipt.clone();
        match mutation {
            0 => receipt.input_digest = "fabricated".into(),
            1 => receipt.input_context.clear(),
            2 => receipt.submitted_draft_version = Some(999),
            _ => receipt.submitted_draft.as_mut().unwrap().text = "changed instruction".into(),
        }
        assert!(matches!(
            store.commit_agent_task(
                &scope(),
                AgentTaskWrite {
                    expected_revision: Some(&sent.task.revision),
                    task: &task,
                    draft: None,
                    receipts: &[receipt],
                    events: &[],
                }
            ),
            Err(AgentTaskError::RequestConflict)
        ));
        assert_eq!(
            json(
                &store
                    .agent_task(&scope(), &sent.task.task.task_id)
                    .unwrap()
                    .unwrap()
            ),
            json(&sent.task)
        );
        assert_eq!(json(&capture(&store, &sent)), json(&original));
    }
    // A confirmed successful receipt may discard its display-only retained draft;
    // the immutable capture still retains the original input for inspection.
    let mut completed = sent.receipt.clone();
    completed.status = "succeeded".into();
    completed.submitted_draft = None;
    store
        .commit_agent_task(
            &scope(),
            AgentTaskWrite {
                expected_revision: Some(&sent.task.revision),
                task: &sent.task,
                draft: None,
                receipts: &std::slice::from_ref(&completed),
                events: &[],
            },
        )
        .unwrap();
    assert_eq!(json(&capture(&store, &sent)), json(&original));
    // A later disconnected observation may be uncertain after the display copy
    // was released. It must not lose the authoritative original input.
    completed.status = "uncertain".into();
    store
        .commit_agent_task(
            &scope(),
            AgentTaskWrite {
                expected_revision: Some(&sent.task.revision),
                task: &sent.task,
                draft: None,
                receipts: &[completed],
                events: &[],
            },
        )
        .unwrap();
    assert_eq!(json(&capture(&store, &sent)), json(&original));
    let mut corrupt = original.clone();
    corrupt.input_draft.content.text = "corrupt capture".into();
    store
        .0
        .lock()
        .unwrap()
        .execute(
            "UPDATE agent_native_admissions SET value=?1 WHERE request_id=?2",
            params![
                serde_json::to_string(&corrupt).unwrap(),
                sent.receipt.request_id
            ],
        )
        .unwrap();
    assert!(matches!(
        store.agent_native_admission(&scope(), &sent.receipt.request_id),
        Err(AgentTaskError::RequestConflict)
    ));
}

#[test]
fn native_admission_refuses_missing_authority_reused_parents_and_embedded_bytes() {
    let (_directory, store, owner, created) = setup();
    for field in [
        "project_root",
        "principal",
        "scopes",
        "capability",
        "target",
    ] {
        let mut invalid = json(&origin());
        match field {
            "project_root" => invalid[field] = "/other".into(),
            "principal" => invalid[field] = "other-user".into(),
            "scopes" => invalid[field] = serde_json::json!(["plugins.read"]),
            "capability" => invalid["binding"]["capability"]["id"] = "agent.model.run".into(),
            _ => invalid["binding"]["target"] = "foreign-target".into(),
        }
        assert!(
            owner
                .admit_native(
                    &scope(),
                    &create(),
                    serde_json::from_value(invalid).unwrap(),
                    2
                )
                .is_err()
        );
    }
    let retained = capture(&store, &created);
    for reuse_operation in [true, false] {
        let mut reused = origin();
        if reuse_operation {
            reused.operation = retained.origin.operation.clone();
        } else {
            reused.request = retained.origin.request.clone();
        }
        assert!(matches!(
            owner.admit_native(&scope(), &create(), reused, 3),
            Err(AgentTaskError::RequestConflict)
        ));
    }
    let bytes = request(AgentTaskCommand::AddAsset {
        control: control(&created.task),
        name: "private.txt".into(),
        mime_type: "text/plain".into(),
        data: "cHJpdmF0ZQ==".into(),
    });
    assert!(matches!(
        owner.admit_native(&scope(), &bytes, origin(), 3),
        Err(AgentTaskError::InvalidInput(_))
    ));
    assert!(
        store
            .agent_receipt(&scope(), &bytes.request_id)
            .unwrap()
            .is_none()
    );
    let old_request = create();
    let old = owner.admit(&scope(), &old_request, 3).unwrap();
    assert!(matches!(
        owner.admit_native(&scope(), &old_request, origin(), 4),
        Err(AgentTaskError::RequestConflict)
    ));
    assert!(
        store
            .agent_native_admission(&scope(), &old.receipt.request_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store.agent_tasks(&scope(), None, None, 20).unwrap().len(),
        2
    );
}

#[test]
fn native_admission_budgets_fail_before_publishing_any_command() {
    let (_directory, store, owner, created) = setup();
    // Context reference data may fit the draft contract but exceed the stricter
    // native admission envelope; no partial editable draft or receipt is retained.
    let oversized = request(AgentTaskCommand::SaveDraft {
        control: control(&created.task),
        version: 0,
        content: AgentDraftContent {
            text: "fixture".into(),
            assets: vec![],
            context: vec![AgentContextSelection {
                source: "fixture".into(),
                label: "Large reference".into(),
                reference: serde_json::json!({"value":"x".repeat(130 * 1024)}),
                inclusion: "reference".into(),
            }],
        },
    });
    assert!(matches!(
        owner.admit_native(&scope(), &oversized, origin(), 2),
        Err(AgentTaskError::Budget(_))
    ));
    assert!(
        store
            .agent_receipt(&scope(), &oversized.request_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .agent_draft(&scope(), &created.task.task.task_id)
            .unwrap()
            .version,
        0
    );
    store
        .0
        .lock()
        .unwrap()
        .execute(
            "UPDATE agent_native_admissions SET bytes=?1",
            [MAX_PROJECT_NATIVE_ADMISSION_BYTES],
        )
        .unwrap();
    let next = create();
    assert!(matches!(
        owner.admit_native(&scope(), &next, origin(), 3),
        Err(AgentTaskError::Budget(_))
    ));
    assert!(
        store
            .agent_native_admission(&scope(), &next.request_id)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .agent_receipt(&scope(), &next.request_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store.agent_tasks(&scope(), None, None, 20).unwrap().len(),
        1
    );
}

#[test]
fn native_admission_concurrent_retries_retain_one_original_parent() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let owner = Arc::new(AgentTaskOwner::new(store.clone()));
    let command = create();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let owner = owner.clone();
            let command = command.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let parent = origin();
                barrier.wait();
                (
                    owner
                        .admit_native(&scope(), &command, parent.clone(), 1)
                        .unwrap(),
                    parent,
                )
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    let first: Vec<_> = results
        .iter()
        .filter(|(result, _)| !result.repeated)
        .collect();
    assert_eq!(first.len(), 1);
    let (accepted, original_parent) = first[0];
    for (result, _) in &results {
        assert_eq!(result.task.task.task_id, accepted.task.task.task_id);
        assert_eq!(json(&result.receipt), json(&accepted.receipt));
    }
    assert_eq!(&capture(&store, accepted).origin, original_parent);
    assert_eq!(
        store.agent_tasks(&scope(), None, None, 20).unwrap().len(),
        1
    );
}

#[test]
fn native_host_tools_retain_captured_branch_and_refuse_model_scope_replacement() {
    let (directory, store, owner, created) = setup();
    let saved = draft(
        &owner,
        &created.task,
        0,
        "Edit only the chosen plugin branch",
    );
    let command = request(AgentTaskCommand::Send {
        control: control(&saved.task),
        draft_version: 1,
    });
    let mut parent = origin();
    parent.scopes.insert("plugins.write".into());
    parent.tools = vec![AgentNativeToolGrant {
        selection: AgentNativeToolSelection {
            name: "checkpoint".into(),
            target: AgentNativeToolTarget::Host {
                project: parent.binding.project.clone(),
                capability: serde_json::from_value(
                    serde_json::json!({"id":"plugins.checkpoint","version":1}),
                )
                .unwrap(),
                fixed_arguments: [("branch".into(), serde_json::json!("chosen-branch"))].into(),
            },
        },
        kind: AgentNativeToolKind::Operation,
        description: "Checkpoint the selected branch".into(),
        input_schema: serde_json::json!({"type":"object","properties":{"expected_head":{"type":"string"},"changes":{"type":"object"}},"required":["expected_head","changes"],"additionalProperties":false}),
        required_scopes: ["plugins.write".into()].into(),
    }];
    let sent = owner
        .admit_native(&scope(), &command, parent.clone(), 3)
        .unwrap();
    let id = sent.task.task.task_id.clone();
    let generation = sent.task.attachment.generation;
    let input = AgentNativeToolInvocation {
        send_request: command.request_id.clone(),
        tool_request: uuid::Uuid::new_v4().to_string(),
        tool: "checkpoint".into(),
        arguments: serde_json::json!({"expected_head":"sha256:original","changes":{}}),
        preconditions: serde_json::Value::Null,
    };
    for branch in ["another-branch", "chosen-branch"] {
        let mut invalid = input.clone();
        invalid.arguments["branch"] = serde_json::json!(branch);
        assert!(
            owner
                .admit_native_tool(&scope(), &id, generation, invalid, 4)
                .is_err()
        );
        assert!(
            store
                .agent_native_tool(&scope(), &input.send_request, &input.tool_request)
                .unwrap()
                .is_none()
        );
    }
    let mut invalid = input.clone();
    invalid.preconditions = serde_json::json!([]);
    assert!(
        owner
            .admit_native_tool(&scope(), &id, generation, invalid, 4)
            .is_err()
    );
    let (receipt, repeated) = owner
        .admit_native_tool(&scope(), &id, generation, input.clone(), 5)
        .unwrap();
    assert!(!repeated);
    let AgentNativeToolRequest::Host {
        project,
        capability,
        arguments,
    } = &receipt.native_request
    else {
        panic!("expected Host request")
    };
    assert_eq!(project, &parent.binding.project);
    assert_eq!(capability.id.as_str(), "plugins.checkpoint");
    assert_eq!(
        arguments,
        &serde_json::json!({"branch":"chosen-branch","expected_head":"sha256:original","changes":{}})
    );
    let mut forged = receipt.clone();
    let AgentNativeToolRequest::Host { arguments, .. } = &mut forged.native_request else {
        unreachable!()
    };
    arguments["branch"] = serde_json::json!("another-branch");
    assert!(store.put_agent_native_tool(&scope(), &forged).is_err());
    let mut altered = parent.clone();
    let AgentNativeToolTarget::Host {
        fixed_arguments, ..
    } = &mut altered.tools[0].selection.target
    else {
        unreachable!()
    };
    fixed_arguments.insert("branch".into(), serde_json::json!("another-branch"));
    assert!(matches!(
        owner.admit_native(&scope(), &command, altered, 6),
        Err(AgentTaskError::RequestConflict)
    ));
    owner
        .admit_native(
            &scope(),
            &request(AgentTaskCommand::Stop {
                control: control(&sent.task),
            }),
            origin(),
            7,
        )
        .unwrap();
    let (observed, repeated) = owner
        .admit_native_tool(&scope(), &id, generation, input.clone(), 8)
        .unwrap();
    assert!(repeated);
    assert_eq!(observed, receipt);
    drop(owner);
    drop(store);
    let reopened = AgentStore::open(&directory.path().join("agent.sqlite")).unwrap();
    assert_eq!(
        reopened
            .agent_native_tool(&scope(), &input.send_request, &input.tool_request)
            .unwrap(),
        Some(receipt)
    );
}
