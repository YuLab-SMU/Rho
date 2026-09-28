//! Deterministic Agent approval rules. The task intent is captured once from the
//! original request; tool arguments cannot change permission policy or authority.
use rho_application::ComponentToolAction;
use rho_contract::*;

pub fn task_intent_spec(_run: &ComponentAgentRun) -> rho_application::ComponentToolSpec {
    rho_agent_engine::task_intent_spec()
}

pub fn action_permission(run: &ComponentAgentRun, action: &ComponentToolAction) -> (ComponentTaskAuthorization, bool) {
    use rho_agent_engine::{AgentPermissionAction, AgentPermissionActionKind as Kind, AgentPermissionContext};
    let requested = requested_actions(action);
    let document_paths = requested.iter().filter_map(|need| {
        let id = need.document_id.as_ref()?;
        Some((id.clone(), rho_application::component_document_grant(run, id)?.path.clone()?))
    }).collect();
    let kind = match action {
        ComponentToolAction::Control(ApplicationCommandRequest { action: ApplicationAction::EditDocument { .. }
            | ApplicationAction::Save { .. } | ApplicationAction::CreateDocument { .. }
            | ApplicationAction::RunFile { .. } | ApplicationAction::RunSelection { .. }, .. }) => Kind::ProjectDocument,
        ComponentToolAction::Invoke(invocation) if invocation.capability.id == "workspace.run_r" => Kind::BoundExecution,
        ComponentToolAction::Invoke(invocation) if invocation.capability.id == "workspace.resume_queue" => Kind::QueueRecovery,
        _ => Kind::Other,
    };
    rho_agent_engine::action_permission(&AgentPermissionContext {
        intent: run.task_intent.as_ref(), policy: run.request.grant.permission_policy, document_paths,
    }, &AgentPermissionAction { kind, requested })
}

fn requested_actions(action: &ComponentToolAction) -> Vec<ComponentIntentAction> {
    let item = |action, document_id| ComponentIntentAction {
        action,
        document_id,
        path: None,
    };
    match action {
        ComponentToolAction::Control(command) => match &command.action {
            ApplicationAction::CreateDocument { path, .. } => vec![ComponentIntentAction {
                action: ComponentRequestedAction::Create,
                document_id: None,
                path: path.clone(),
            }],
            ApplicationAction::EditDocument { document, .. } => vec![item(
                ComponentRequestedAction::Edit,
                Some(document.document_id.clone()),
            )],
            ApplicationAction::Save { document, .. } => vec![item(
                ComponentRequestedAction::Save,
                Some(document.document_id.clone()),
            )],
            ApplicationAction::RunFile { document, .. } => vec![
                item(
                    ComponentRequestedAction::Save,
                    Some(document.document_id.clone()),
                ),
                item(
                    ComponentRequestedAction::Execute,
                    Some(document.document_id.clone()),
                ),
            ],
            ApplicationAction::RunSelection { document } => vec![item(
                ComponentRequestedAction::Execute,
                Some(document.document_id.clone()),
            )],
            _ => vec![],
        },
        ComponentToolAction::Invoke(invocation)
            if matches!(
                invocation.capability.id.as_str(),
                "workspace.run_r" | "workspace.resume_queue"
            ) =>
        {
            vec![item(ComponentRequestedAction::Execute, None)]
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn run() -> ComponentAgentRun {
        serde_json::from_value(json!({
            "run_id":"run", "profile":"objects", "state":"running",
            "request":{"request_id":"request","conversation_id":"task","conversation_version":1,
                "window":{"window_id":"window","incarnation":"life"},"model_settings_version":1,
                "text":"Fix, save and run this script", "sources":[],
                "grant":{"permission_policy":"ask","mode":"explain",
                    "session":{"workspace_instance_id":"main","session_id":"native"},"files":[],
                    "documents":[{"document":{"document_id":"doc","document_version":"v1","selection_version":"s1"},"allow_save":false,"path":"analysis.R"}]}},
            "model":{"protocol":"openai_completions","base_url":"https://example.test/v1","model":"fixture","credential":{"kind":"environment","name":"TEST_KEY"}},
            "budget":{"model_calls":12,"tool_calls":16,"context_bytes":65536,"tool_result_bytes":262144,"output_tokens":2048,"duration_ms":600000},
            "model_calls":1,"tool_calls":0,"tool_result_bytes":0,"input_tokens":null,"output_tokens":null,
            "event_cursor":0,"created_at_ms":1,"updated_at_ms":1,"reason":null,"context":null,"document_versions":null,
            "task_intent":{"request_id":"request","request_excerpt":"Fix, save and run this script","actions":[]}
        })).unwrap()
    }
    fn edit(run: &ComponentAgentRun) -> ComponentToolAction {
        ComponentToolAction::Control(ApplicationCommandRequest {
            window: run.request.window.clone(),
            request_id: "action".into(),
            execution_target: None,
            action: ApplicationAction::EditDocument {
                document: run.request.grant.documents[0].document.clone(),
                edits: vec![],
            },
        })
    }
    fn execute() -> ComponentToolAction {
        ComponentToolAction::Invoke(Invocation {
            client_request_id: "action".into(),
            capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
            arguments: json!({}),
            preconditions: vec![],
        })
    }
    #[test]
    fn policy_choices_differ_for_additional_actions_without_review_inference() {
        let mut run = run();
        let edit = edit(&run);
        for (policy, edits, executes, recovery) in [
            (ComponentPermissionPolicy::Ask, false, false, false),
            (ComponentPermissionPolicy::AutoApproval, true, true, false),
            (ComponentPermissionPolicy::FullAccess, true, true, true),
        ] {
            run.request.grant.permission_policy = Some(policy);
            assert_eq!(
                action_permission(&run, &edit),
                (ComponentTaskAuthorization::Additional, edits)
            );
            assert_eq!(
                action_permission(&run, &execute()),
                (ComponentTaskAuthorization::Additional, executes)
            );
            let mut resume = execute();
            if let ComponentToolAction::Invoke(invocation) = &mut resume {
                invocation.capability = CapabilityRef::new("workspace.resume_queue", 1).unwrap();
            }
            assert_eq!(
                action_permission(&run, &resume),
                (ComponentTaskAuthorization::Additional, recovery)
            );
        }
    }
    #[test]
    fn original_intent_authorizes_matching_actions_and_exact_path_targets() {
        let mut run = run();
        let edit = edit(&run);
        run.task_intent.as_mut().unwrap().actions = vec![
            ComponentIntentAction {
                action: ComponentRequestedAction::Edit,
                document_id: None,
                path: Some("analysis.R".into()),
            },
            ComponentIntentAction {
                action: ComponentRequestedAction::Execute,
                document_id: None,
                path: None,
            },
        ];
        assert_eq!(
            action_permission(&run, &edit),
            (ComponentTaskAuthorization::UserRequest, true)
        );
        assert_eq!(
            action_permission(&run, &execute()),
            (ComponentTaskAuthorization::UserRequest, true)
        );
        run.request.grant.documents[0].path = Some("different.R".into());
        assert_eq!(
            action_permission(&run, &edit),
            (ComponentTaskAuthorization::Additional, false)
        );
    }
}
