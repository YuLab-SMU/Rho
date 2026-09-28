//! An independent repository fixture: injected commit failure and native controller loss.
//! SQLite atomicity and actual native receipts are also tested by the containing Host.
use super::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

type Key = (String, String, String);
fn key(scope: &ApplicationScope, id: &str) -> Key {
    (scope.project.clone(), scope.principal.clone(), id.into())
}
#[derive(Default)]
struct Records {
    conversations: BTreeMap<Key, ComponentAgentConversation>,
    runs: BTreeMap<Key, StoredComponentRun>,
    tools: BTreeMap<Key, StoredComponentTool>,
    events: BTreeMap<Key, Vec<ComponentAgentEvent>>,
    settings: BTreeMap<Key, ComponentModelSettings>,
    diagnostics: BTreeMap<Key, ComponentModelDiagnostic>,
}
#[derive(Default)]
struct Repository {
    records: Mutex<Records>,
    fail: AtomicBool,
}
impl ComponentAgentRepository for Repository {
    fn component_diagnostic(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<ComponentModelDiagnostic>, ApplicationError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .diagnostics
            .get(&key(s, id))
            .cloned())
    }
    fn component_diagnostics(
        &self,
        s: &ApplicationScope,
    ) -> Result<Vec<ComponentModelDiagnostic>, ApplicationError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .diagnostics
            .iter()
            .filter(|(k, _)| k.0 == s.project && k.1 == s.principal)
            .map(|(_, v)| v.clone())
            .collect())
    }
    fn write_component_diagnostic(
        &self,
        s: &ApplicationScope,
        expected: Option<u64>,
        value: &ComponentModelDiagnostic,
    ) -> Result<(), ApplicationError> {
        let mut records = self.records.lock().unwrap();
        if records
            .diagnostics
            .get(&key(s, &value.request_id))
            .map(|v| v.version)
            != expected
        {
            return Err(ApplicationError::Conflict);
        }
        records
            .diagnostics
            .insert(key(s, &value.request_id), value.clone());
        Ok(())
    }
    fn component_conversation(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<ComponentAgentConversation>, ApplicationError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .conversations
            .get(&key(s, id))
            .cloned())
    }
    fn component_conversations(
        &self,
        s: &ApplicationScope,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ComponentAgentConversation>, ApplicationError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .conversations
            .iter()
            .filter(|(k, _)| {
                k.0 == s.project
                    && k.1 == s.principal
                    && after.is_none_or(|after| k.2.as_str() > after)
            })
            .take(limit)
            .map(|(_, v)| v.clone())
            .collect())
    }
    fn component_run(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredComponentRun>, ApplicationError> {
        Ok(self.records.lock().unwrap().runs.get(&key(s, id)).cloned())
    }
    fn component_run_by_request(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredComponentRun>, ApplicationError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .runs
            .iter()
            .find(|(k, v)| k.0 == s.project && k.1 == s.principal && v.run.request.request_id == id)
            .map(|(_, v)| v.clone()))
    }
    fn component_run_history(
        &self,
        _s: &ApplicationScope,
        _conversation: &str,
        _before: Option<&str>,
        _limit: usize,
    ) -> Result<Vec<(ComponentAgentRunSummary, String)>, ApplicationError> {
        Ok(vec![])
    }
    fn component_tools(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Vec<StoredComponentTool>, ApplicationError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .tools
            .iter()
            .filter(|(k, v)| k.0 == s.project && k.1 == s.principal && v.receipt.run_id == id)
            .map(|(_, v)| v.clone())
            .collect())
    }
    fn component_events(
        &self,
        s: &ApplicationScope,
        id: &str,
        after: u64,
        limit: usize,
    ) -> Result<ComponentAgentEventPage, ApplicationError> {
        let records = self.records.lock().unwrap();
        let events = records
            .events
            .get(&key(s, id))
            .into_iter()
            .flatten()
            .filter(|e| e.sequence > after)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        Ok(ComponentAgentEventPage {
            cursor: events.last().map_or(after, |e| e.sequence),
            events,
            history_gap: false,
        })
    }
    fn component_settings(
        &self,
        s: &ApplicationScope,
    ) -> Result<ComponentModelSettings, ApplicationError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .settings
            .get(&key(s, "settings"))
            .cloned()
            .unwrap_or(ComponentModelSettings {
                version: 0,
                enabled: false,
                connection: None,
            }))
    }
    fn write_component_settings(
        &self,
        s: &ApplicationScope,
        expected: u64,
        value: &ComponentModelSettings,
    ) -> Result<(), ApplicationError> {
        let mut records = self.records.lock().unwrap();
        if records
            .settings
            .get(&key(s, "settings"))
            .map_or(0, |v| v.version)
            != expected
        {
            return Err(ApplicationError::Conflict);
        }
        records.settings.insert(key(s, "settings"), value.clone());
        Ok(())
    }
    fn commit_component(
        &self,
        s: &ApplicationScope,
        write: ComponentWrite<'_>,
    ) -> Result<(), ApplicationError> {
        let mut records = self.records.lock().unwrap();
        if records
            .conversations
            .get(&key(s, &write.conversation.conversation_id))
            .map(|v| v.version)
            != write.expected_version
        {
            return Err(ApplicationError::Conflict);
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(ApplicationError::Storage(
                "injected atomic write failure".into(),
            ));
        }
        records.conversations.insert(
            key(s, &write.conversation.conversation_id),
            write.conversation.clone(),
        );
        if let Some(run) = write.run {
            records.runs.insert(key(s, &run.run.run_id), run.clone());
        }
        for tool in write.tools {
            records
                .tools
                .insert(key(s, &tool.receipt.receipt_id), tool.clone());
        }
        for event in write.events {
            records
                .events
                .entry(key(s, &event.run_id))
                .or_default()
                .push(event.clone());
        }
        Ok(())
    }
}
#[derive(Default)]
struct Controller(AtomicBool);
impl ComponentActorValidator for Controller {
    fn validate(&self, _now: u64) -> Result<(), ApplicationError> {
        if self.0.load(Ordering::SeqCst) {
            Err(ApplicationError::IncarnationChanged)
        } else {
            Ok(())
        }
    }
}
struct Fixture {
    store: Arc<Repository>,
    controller: Arc<Controller>,
    owner: ComponentAgentOwner,
    actor: ComponentActor,
}
impl Fixture {
    fn new() -> Self {
        let store = Arc::new(Repository::default());
        let controller = Arc::new(Controller::default());
        let actor = ComponentActor::new(
            ApplicationScope {
                project: "/fixture".into(),
                principal: "principal".into(),
            },
            ApplicationWindowRef {
                window_id: "window".into(),
                incarnation: "life".into(),
            },
            controller.clone(),
        );
        let owner = ComponentAgentOwner::new(store.clone(), "owner".into());
        owner
            .configure(
                &actor,
                &ComponentModelSettings {
                    version: 0,
                    enabled: true,
                    connection: Some(ComponentModelConnection {
                        protocol: ComponentModelProtocol::Anthropic,
                        base_url: "https://model.example".into(),
                        model: "fixture".into(),
                        credential: ComponentCredentialRef::Environment {
                            name: "RHO_FIXTURE_KEY".into(),
                        },
                    }),
                },
                1,
            )
            .unwrap();
        Self {
            store,
            controller,
            owner,
            actor,
        }
    }
    fn request(&self) -> ComponentAgentStart {
        let conversation = self
            .owner
            .create(&self.actor, "task", ComponentAgentProfile::Project, 2)
            .unwrap();
        ComponentAgentStart {
            request_id: "request".into(),
            conversation_id: conversation.conversation_id,
            conversation_version: conversation.version,
            window: self.actor.window().clone(),
            model_settings_version: 1,
            text: "Run the requested analysis".into(),
            assets: None,
            continuation: None,
            sources: vec![],
            grant: ComponentAgentGrant {
                mode: ComponentAgentMode::Run,
                permission_policy: None,
                session: Some(ComponentAgentSession {
                    workspace_instance_id: "main".into(),
                    session_id: "native-one".into(),
                }),
                documents: vec![],
                files: vec![],
            },
        }
    }
    fn running(&self) -> String {
        let id = self
            .owner
            .start(&self.actor, self.request(), 3)
            .unwrap()
            .run
            .run
            .run_id;
        self.owner.claim(self.actor.scope(), &id, 4).unwrap();
        self.owner
            .begin_model_call(self.actor.scope(), &id, 5)
            .unwrap();
        id
    }
}
fn mutation() -> ComponentToolAction {
    ComponentToolAction::Invoke(Invocation {
        client_request_id: "supplied".into(),
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        arguments: serde_json::json!({"workspace_instance_id":"main","code":"counter <- counter + 1"}),
        preconditions: vec![Precondition {
            kind: "workspace.session".into(),
            subject: "active".into(),
            expected: serde_json::json!("native-one"),
        }],
    })
}
#[test]
fn component_owner_preserves_original_admission_and_revalidates_controller() {
    let f = Fixture::new();
    let request = f.request();
    let admitted = f.owner.start(&f.actor, request.clone(), 3).unwrap();
    let repeated = f.owner.start(&f.actor, request.clone(), 4).unwrap();
    assert!(repeated.repeated);
    assert_eq!(repeated.run.run.run_id, admitted.run.run.run_id);
    let mut changed = request.clone();
    changed.text.push('!');
    assert!(matches!(
        f.owner.start(&f.actor, changed, 5),
        Err(ApplicationError::RequestConflict)
    ));
    let foreign = ApplicationScope {
        principal: "foreign".into(),
        ..f.actor.scope().clone()
    };
    assert!(
        f.store
            .component_run(&foreign, &admitted.run.run.run_id)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        f.owner.claim(&foreign, &admitted.run.run.run_id, 5),
        Err(ApplicationError::NotFound)
    ));
    f.controller.0.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.owner.start(&f.actor, request, 6),
        Err(ApplicationError::IncarnationChanged)
    ));
    assert!(matches!(
        f.owner.stop(&f.actor, &admitted.run.run.run_id, 6),
        Err(ApplicationError::IncarnationChanged)
    ));
}
#[test]
fn component_owner_atomic_failure_publishes_no_tool_or_counter() {
    let f = Fixture::new();
    let id = f.running();
    let before = f
        .store
        .component_conversation(f.actor.scope(), "task")
        .unwrap()
        .unwrap();
    f.store.fail.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.owner
            .admit_tool(f.actor.scope(), &id, 1, "tool", mutation(), 6),
        Err(ApplicationError::Storage(_))
    ));
    assert!(
        f.store
            .component_tools(f.actor.scope(), &id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.store
            .component_conversation(f.actor.scope(), "task")
            .unwrap()
            .unwrap()
            .version,
        before.version
    );
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &id)
            .unwrap()
            .unwrap()
            .run
            .tool_calls,
        0
    );
    f.store.fail.store(false, Ordering::SeqCst);
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &id, 1, "tool", mutation(), 7)
        .unwrap()
        .tool;
    let repeated = f
        .owner
        .admit_tool(f.actor.scope(), &id, 1, "tool-again", mutation(), 8)
        .unwrap();
    assert!(repeated.repeated);
    assert_eq!(tool.receipt.receipt_id, repeated.tool.receipt.receipt_id);
    assert_eq!(
        tool.receipt.client_request_id,
        repeated.tool.receipt.client_request_id
    );
}
#[test]
fn component_owner_restart_is_observation_only_and_stop_retains_late_native_receipt() {
    let f = Fixture::new();
    let id = f.running();
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &id, 1, "tool", mutation(), 6)
        .unwrap()
        .tool;
    let restarted = ComponentAgentOwner::new(f.store.clone(), "replacement".into());
    let before = f
        .store
        .component_run(f.actor.scope(), &id)
        .unwrap()
        .unwrap();
    assert_eq!(
        restarted.observed_run(before.clone()).state,
        ComponentAgentRunState::Interrupted
    );
    assert!(matches!(
        restarted.check_tool_dispatch(f.actor.scope(), &id, &tool.receipt.receipt_id, 7),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &id)
            .unwrap()
            .unwrap()
            .run
            .state,
        ComponentAgentRunState::Running
    );
    f.owner.stop(&f.actor, &id, 8).unwrap();
    assert!(
        f.owner
            .check_tool_dispatch(f.actor.scope(), &id, &tool.receipt.receipt_id, 9)
            .is_err()
    );
    let native = OperationId::new("native-operation").unwrap();
    f.owner
        .record_tool(
            f.actor.scope(),
            &id,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(native.clone()),
                application_request_id: None,
            },
            10,
        )
        .unwrap();
    assert_eq!(
        f.store.component_tools(f.actor.scope(), &id).unwrap()[0]
            .receipt
            .operation_id,
        Some(native)
    );
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &id)
            .unwrap()
            .unwrap()
            .run
            .state,
        ComponentAgentRunState::Stopping
    );
}
#[test]
fn component_owner_refuses_unsupported_document_controls_before_receipt() {
    let f = Fixture::new();
    let id = f.running();
    // Old fixed-view controls are not part of the public Agent document boundary.
    let command:ApplicationCommandRequest=serde_json::from_value(serde_json::json!({"window":f.actor.window(),"request_id":"unknown","action":{"kind":"close_view","view_id":"objects","expected_context_version":"v1"}})).unwrap();
    assert!(matches!(command.action, ApplicationAction::Unsupported));
    assert!(
        f.owner
            .admit_tool(
                f.actor.scope(),
                &id,
                1,
                "tool",
                ComponentToolAction::Control(command),
                6
            )
            .is_err()
    );
    assert!(
        f.store
            .component_tools(f.actor.scope(), &id)
            .unwrap()
            .is_empty()
    );
    assert!(serde_json::from_value::<ApplicationAction>(serde_json::json!({"kind":"open_document","path":"x.R","expected_context_version":"v1","injected":true})).is_err());
}

#[test]
fn component_owner_permission_receipt_remains_bound_to_original_action() {
    let f = Fixture::new();
    let mut request = f.request();
    request.grant.permission_policy = Some(ComponentPermissionPolicy::Ask);
    request.text = "Explain the current data".into();
    let run = f.owner.start(&f.actor, request.clone(), 3).unwrap().run.run;
    f.owner.claim(f.actor.scope(), &run.run_id, 4).unwrap();
    f.owner
        .begin_model_call(f.actor.scope(), &run.run_id, 5)
        .unwrap();
    let intent = ComponentAgentTaskIntent {
        request_id: request.request_id,
        request_excerpt: request.text,
        actions: vec![],
    };
    f.owner
        .capture_task_intent(f.actor.scope(), &run.run_id, &intent, 6)
        .unwrap();
    let mut forged = intent.clone();
    forged.actions.push(ComponentIntentAction {
        action: ComponentRequestedAction::Execute,
        document_id: None,
        path: None,
    });
    assert!(
        f.owner
            .capture_task_intent(f.actor.scope(), &run.run_id, &forged, 6)
            .is_err()
    );
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &run.run_id, 1, "additional", mutation(), 7)
        .unwrap()
        .tool;
    assert!(
        f.owner
            .check_tool_dispatch(f.actor.scope(), &run.run_id, &tool.receipt.receipt_id, 7)
            .is_err()
    );
    let permission = f
        .owner
        .record_permission(
            f.actor.scope(),
            &run.run_id,
            &tool.receipt.receipt_id,
            "workspace_run_r",
            ComponentTaskAuthorization::Additional,
            false,
            8,
        )
        .unwrap();
    assert_eq!(permission.action_digest, tool.receipt.action_digest);
    assert_eq!(permission.state, ComponentPermissionState::Pending);
    let wrong_controller = ComponentActor::new(
        f.actor.scope().clone(),
        ApplicationWindowRef {
            window_id: "other".into(),
            incarnation: "other-life".into(),
        },
        f.controller.clone(),
    );
    assert!(matches!(
        f.owner.decide_permission(
            &wrong_controller,
            &run.run_id,
            &permission.decision_id,
            true,
            9
        ),
        Err(ApplicationError::Conflict)
    ));
    f.owner
        .decide_permission(&f.actor, &run.run_id, &permission.decision_id, false, 10)
        .unwrap();
    assert!(matches!(
        f.owner
            .decide_permission(&f.actor, &run.run_id, &permission.decision_id, true, 11),
        Err(ApplicationError::RequestConflict)
    ));
    let original = &f
        .store
        .component_tools(f.actor.scope(), &run.run_id)
        .unwrap()[0];
    assert_eq!(original.receipt.receipt_id, tool.receipt.receipt_id);
    assert_eq!(original.receipt.phase, ComponentToolPhase::Resolved);
    assert!(original.receipt.operation_id.is_none());
}

fn native_origin() -> ComponentNativeRunOrigin {
    serde_json::from_value(serde_json::json!({
        "operation":"original-operation", "request":"original-request",
        "binding":{"capability":{"id":"agent.model.run","version":1},
            "provider":{"instance":"agent-one","plugin":"org.rho.agent",
                "revision":format!("sha256:{}", "a".repeat(64)),"artifact":format!("sha256:{}", "b".repeat(64))},
            "project":"project-one","target":null},
        "r":{"capability":{"id":"r.execute","version":2},
            "provider":{"instance":"main","plugin":"org.fixture.runtime",
                "revision":format!("sha256:{}", "c".repeat(64)),"artifact":format!("sha256:{}", "d".repeat(64))},
            "project":"project-one","target":"native-one"}
    })).unwrap()
}

#[test]
fn native_run_retry_observes_original_parent_without_reparenting_or_reclaiming() {
    let f = Fixture::new();
    let request = f.request();
    let origin = native_origin();
    let first = f
        .owner
        .start_native(&f.actor, request.clone(), origin.clone(), 3)
        .unwrap();
    let mut retry_origin = origin.clone();
    retry_origin.operation = OperationId::new("retry-operation").unwrap();
    retry_origin.request = RequestId::new("retry-request").unwrap();
    let repeat = f
        .owner
        .start_native(&f.actor, request.clone(), retry_origin, 4)
        .unwrap();
    assert!(repeat.repeated);
    assert_eq!(repeat.run.run.run_id, first.run.run.run_id);
    assert_eq!(repeat.run.native_origin, Some(origin.clone()));
    let mut changed = origin.clone();
    changed.binding.provider.instance =
        serde_json::from_value(serde_json::json!("agent-two")).unwrap();
    assert!(matches!(
        f.owner.start_native(&f.actor, request.clone(), changed, 5),
        Err(ApplicationError::RequestConflict)
    ));
    assert!(matches!(
        f.owner.start(&f.actor, request.clone(), 5),
        Err(ApplicationError::RequestConflict)
    ));
    let mut altered = request.clone();
    altered.text.push('!');
    assert!(matches!(
        f.owner.start_native(&f.actor, altered, origin.clone(), 5),
        Err(ApplicationError::RequestConflict)
    ));
    let restarted = ComponentAgentOwner::new(f.store.clone(), "replacement".into());
    let repeated = restarted
        .start_native(&f.actor, request.clone(), origin.clone(), 5)
        .unwrap();
    assert!(repeated.repeated);
    assert_eq!(
        restarted.observed_run(repeated.run).state,
        ComponentAgentRunState::Interrupted
    );
    assert!(
        restarted
            .claim(f.actor.scope(), &first.run.run.run_id, 5)
            .is_err()
    );
    f.controller.0.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.owner.start_native(&f.actor, request, origin, 6),
        Err(ApplicationError::IncarnationChanged)
    ));
}

#[test]
fn native_run_admission_failure_leaves_no_parent_or_active_task() {
    let f = Fixture::new();
    let request = f.request();
    let origin = native_origin();
    let before = f
        .store
        .component_conversation(f.actor.scope(), "task")
        .unwrap()
        .unwrap();
    let mut invalid_origin = origin.clone();
    invalid_origin.binding.target = Some("caller-selected".into());
    assert!(
        f.owner
            .start_native(&f.actor, request.clone(), invalid_origin, 3)
            .is_err()
    );
    f.store.fail.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.owner
            .start_native(&f.actor, request.clone(), origin.clone(), 3),
        Err(ApplicationError::Storage(_))
    ));
    assert!(
        f.store
            .component_run_by_request(f.actor.scope(), &request.request_id)
            .unwrap()
            .is_none()
    );
    let after = f
        .store
        .component_conversation(f.actor.scope(), "task")
        .unwrap()
        .unwrap();
    assert_eq!(after.version, before.version);
    assert!(after.active_run_id.is_none());
    f.store.fail.store(false, Ordering::SeqCst);
    let admitted = f
        .owner
        .start_native(&f.actor, request, origin.clone(), 4)
        .unwrap();
    assert!(!admitted.repeated);
    assert_eq!(admitted.run.native_origin, Some(origin));
}

fn native_execution(origin: &ComponentNativeRunOrigin) -> ComponentToolAction {
    ComponentToolAction::PluginInvoke(PluginRequest {
        binding: origin.r.clone().unwrap(),
        arguments: serde_json::json!({"expected_session":"native-one","run":{"code":"counter <- counter + 1"}}),
        preconditions: Value::Null,
    })
}

#[test]
fn native_plugin_tool_binds_revision_target_mode_and_original_request_before_dispatch() {
    let f = Fixture::new();
    let origin = native_origin();
    let run = f
        .owner
        .start_native(&f.actor, f.request(), origin.clone(), 3)
        .unwrap()
        .run
        .run;
    f.owner.claim(f.actor.scope(), &run.run_id, 4).unwrap();
    f.owner
        .begin_model_call(f.actor.scope(), &run.run_id, 5)
        .unwrap();
    let action = native_execution(&origin);
    for index in 0..7 {
        let ComponentToolAction::PluginInvoke(mut request) = action.clone() else {
            panic!()
        };
        match index {
            0 => {
                request.binding.provider.revision =
                    serde_json::from_value(serde_json::json!(format!("sha256:{}", "e".repeat(64))))
                        .unwrap()
            }
            1 => {
                request.binding.project =
                    serde_json::from_value(serde_json::json!("another-project")).unwrap()
            }
            2 => request.binding.target = Some("another-session".into()),
            3 => request.arguments["expected_session"] = serde_json::json!("another-session"),
            4 => request.preconditions = serde_json::json!({"caller_override":true}),
            5 => request.arguments["run"]["source"] = serde_json::json!({"document_id":"invented"}),
            _ => request.binding.capability.version = 1,
        }
        assert!(
            f.owner
                .admit_tool(
                    f.actor.scope(),
                    &run.run_id,
                    1,
                    "forged",
                    ComponentToolAction::PluginInvoke(request),
                    6
                )
                .is_err()
        );
    }
    assert!(
        f.store
            .component_tools(f.actor.scope(), &run.run_id)
            .unwrap()
            .is_empty()
    );
    let first = f
        .owner
        .admit_tool(
            f.actor.scope(),
            &run.run_id,
            1,
            "native-call",
            action.clone(),
            6,
        )
        .unwrap();
    assert!(RequestId::new(&first.tool.receipt.client_request_id).is_ok());
    f.owner
        .check_tool_dispatch(
            f.actor.scope(),
            &run.run_id,
            &first.tool.receipt.receipt_id,
            7,
        )
        .unwrap();
    let repeat = f
        .owner
        .admit_tool(
            f.actor.scope(),
            &run.run_id,
            1,
            "same-code-again",
            action,
            8,
        )
        .unwrap();
    assert!(repeat.repeated);
    assert_eq!(
        repeat.tool.receipt.receipt_id,
        first.tool.receipt.receipt_id
    );
    assert_eq!(
        repeat.tool.receipt.client_request_id,
        first.tool.receipt.client_request_id
    );
    f.owner.stop(&f.actor, &run.run_id, 9).unwrap();
    assert!(
        f.owner
            .check_tool_dispatch(
                f.actor.scope(),
                &run.run_id,
                &first.tool.receipt.receipt_id,
                10
            )
            .is_err()
    );
}

#[test]
fn native_explain_reads_only_captured_r_and_cannot_acquire_execution_or_change_provider_on_retry() {
    let f = Fixture::new();
    let origin = native_origin();
    let mut input = f.request();
    input.grant.mode = ComponentAgentMode::Explain;
    let run = f
        .owner
        .start_native(&f.actor, input.clone(), origin.clone(), 3)
        .unwrap()
        .run
        .run;
    let mut changed = origin.clone();
    changed.r.as_mut().unwrap().provider.artifact =
        serde_json::from_value(serde_json::json!(format!("sha256:{}", "e".repeat(64)))).unwrap();
    assert!(matches!(
        f.owner.start_native(&f.actor, input, changed, 4),
        Err(ApplicationError::RequestConflict)
    ));
    f.owner.claim(f.actor.scope(), &run.run_id, 4).unwrap();
    f.owner
        .begin_model_call(f.actor.scope(), &run.run_id, 5)
        .unwrap();
    assert!(
        f.owner
            .admit_tool(
                f.actor.scope(),
                &run.run_id,
                1,
                "execute",
                native_execution(&origin),
                6
            )
            .is_err()
    );
    let mut binding = origin.r.unwrap();
    binding.capability =
        serde_json::from_value(serde_json::json!({"id":"r.session","version":1})).unwrap();
    let query = ComponentToolAction::PluginQuery(PluginRequest {
        binding,
        arguments: serde_json::json!({}),
        preconditions: Value::Null,
    });
    let admitted = f
        .owner
        .admit_tool(f.actor.scope(), &run.run_id, 1, "read", query, 6)
        .unwrap();
    assert!(!admitted.tool.receipt.mutation);
    f.owner
        .check_tool_dispatch(
            f.actor.scope(),
            &run.run_id,
            &admitted.tool.receipt.receipt_id,
            7,
        )
        .unwrap();
}
