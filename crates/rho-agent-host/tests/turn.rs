use std::collections::BTreeMap;

use rho_agent_host::turn::*;
use rho_control_plane::{
    AgentEffectAdmission, AgentEffectPort, AgentEffectRequest, AgentEffectTerminal,
};
use rho_protocol::*;
use serde_json::json;

#[derive(Clone)]
struct FakePort {
    revision: RevisionStamp,
    requests: Vec<AgentEffectRequest>,
    decisions: BTreeMap<String, BrokerDecisionKind>,
    terminals: BTreeMap<OperationId, AgentEffectTerminal>,
}

impl AgentEffectPort for FakePort {
    fn current_revision(&self) -> RevisionStamp {
        self.revision.clone()
    }

    fn request_effect(&mut self, request: AgentEffectRequest) -> AgentEffectAdmission {
        let decision = self
            .decisions
            .get(request.operation_id.as_str())
            .copied()
            .unwrap_or(BrokerDecisionKind::Allow);
        self.requests.push(request.clone());
        AgentEffectAdmission {
            operation_id: request.operation_id,
            decision,
            reason_code: match decision {
                BrokerDecisionKind::Allow => "allowed",
                BrokerDecisionKind::Ask => "approval_required",
                BrokerDecisionKind::Deny => "denied",
            }
            .to_string(),
        }
    }

    fn observe_terminal(&self, operation_id: &OperationId) -> Option<AgentEffectTerminal> {
        self.terminals.get(operation_id).cloned()
    }
}

fn revision(state: u64) -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_turn").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_turn").unwrap(),
        state_revision: StateRevision(state),
        project_revision: ProjectRevision(2),
    }
}

fn expected(state: u64) -> ExpectedRevisions {
    revision(state).into()
}

fn context() -> AgentPromptContext {
    AgentPromptContext::bounded(
        TurnId::new("turn_loop").unwrap(),
        "analyze differential expression",
        revision(4),
        [
            CapabilityId::new("workspace.inspect").unwrap(),
            CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
        ],
        [BoundedAgentObservation {
            provenance: "workspace_snapshot:sha256:abc".to_string(),
            summary: "objects: counts, metadata".to_string(),
            revision: revision(4),
        }],
    )
}

#[test]
fn turn_loop_runs_observe_plan_approval_execute_reobserve_complete_without_mode_state() {
    let operation_id = OperationId::new("operation_turn_run").unwrap();
    let terminal = AgentEffectTerminal {
        operation_id: operation_id.clone(),
        outcome: OperationOutcome::Succeeded,
        revision: revision(5),
    };
    let mut port = FakePort {
        revision: revision(4),
        requests: Vec::new(),
        decisions: BTreeMap::from([(operation_id.as_str().to_string(), BrokerDecisionKind::Ask)]),
        terminals: BTreeMap::from([(operation_id.clone(), terminal)]),
    };
    let mut loop_ = AutonomousTurnLoop::new(context());

    loop_
        .handle_action(AutonomousAction::Observe, &mut port)
        .unwrap();
    loop_
        .handle_action(
            AutonomousAction::PublishPlan {
                plan_id: "provider_plan_1".to_string(),
                steps: vec!["inspect".to_string(), "fit model".to_string()],
            },
            &mut port,
        )
        .unwrap();
    let result = loop_
        .handle_action(
            AutonomousAction::RequestEffect {
                capability_id: CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
                operation_id: operation_id.clone(),
                normalized_arguments: json!({"code":"fit <- lm(y ~ group)"}),
                depends_on: expected(4),
            },
            &mut port,
        )
        .unwrap()
        .unwrap();
    assert!(matches!(result, AgentToolResult::ApprovalRequired { .. }));

    // Approval/execution truth arrives through the port; the provider plan is not authoritative.
    assert!(matches!(
        loop_.observe_terminal(&port, &operation_id),
        Some(AgentToolResult::Terminal { outcome: OperationOutcome::Succeeded, revision, .. })
            if revision.state_revision == StateRevision(5)
    ));
    port.revision = revision(5);
    loop_
        .handle_action(AutonomousAction::Observe, &mut port)
        .unwrap();
    loop_
        .handle_action(AutonomousAction::Complete, &mut port)
        .unwrap();
    assert!(loop_.is_complete());
    assert_eq!(
        loop_.context().current_revision.state_revision,
        StateRevision(5)
    );
}

#[test]
fn stale_effect_is_not_executed_and_new_request_requires_new_operation_id() {
    let mut port = FakePort {
        revision: revision(8),
        requests: Vec::new(),
        decisions: BTreeMap::new(),
        terminals: BTreeMap::new(),
    };
    let mut loop_ = AutonomousTurnLoop::new(context());
    let stale_id = OperationId::new("operation_stale").unwrap();
    let action = AutonomousAction::RequestEffect {
        capability_id: CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
        operation_id: stale_id.clone(),
        normalized_arguments: json!({"code":"x <- 1"}),
        depends_on: expected(4),
    };
    let result = loop_
        .handle_action(action.clone(), &mut port)
        .unwrap()
        .unwrap();
    assert!(
        matches!(result, AgentToolResult::Stale { current, .. } if current.state_revision == StateRevision(8))
    );
    assert!(
        port.requests.is_empty(),
        "stale request must not reach execution admission"
    );
    assert_eq!(
        loop_.handle_action(action, &mut port).unwrap_err(),
        TurnLoopError::DuplicateOperation(stale_id)
    );

    let fresh = loop_
        .handle_action(
            AutonomousAction::RequestEffect {
                capability_id: CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
                operation_id: OperationId::new("operation_fresh_after_stale").unwrap(),
                normalized_arguments: json!({"code":"x <- 1"}),
                depends_on: expected(8),
            },
            &mut port,
        )
        .unwrap()
        .unwrap();
    assert!(matches!(fresh, AgentToolResult::Admitted { .. }));
    assert_eq!(port.requests.len(), 1);
}

#[test]
fn provider_restart_loses_plan_but_not_job_or_execution_truth() {
    let operation_id = OperationId::new("operation_survives_provider").unwrap();
    let mut port = FakePort {
        revision: revision(4),
        requests: Vec::new(),
        decisions: BTreeMap::new(),
        terminals: BTreeMap::from([(
            operation_id.clone(),
            AgentEffectTerminal {
                operation_id: operation_id.clone(),
                outcome: OperationOutcome::Succeeded,
                revision: revision(5),
            },
        )]),
    };
    let mut loop_ = AutonomousTurnLoop::new(context());
    loop_
        .handle_action(
            AutonomousAction::RequestEffect {
                capability_id: CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
                operation_id: operation_id.clone(),
                normalized_arguments: json!({"code":"x <- 1"}),
                depends_on: expected(4),
            },
            &mut port,
        )
        .unwrap();
    assert_eq!(loop_.pending_operations().count(), 1);
    loop_.restart_provider();
    assert_eq!(loop_.pending_operations().count(), 1);
    assert!(loop_.observe_terminal(&port, &operation_id).is_some());
}

#[test]
fn prompt_context_is_bounded_and_contains_no_raw_project_or_secret_surface() {
    let observations = (0..100)
        .map(|idx| BoundedAgentObservation {
            provenance: format!("observation_{idx}"),
            summary: "x".repeat(MAX_AGENT_CONTEXT_ITEM_BYTES + 100),
            revision: revision(4),
        })
        .collect::<Vec<_>>();
    let context = AgentPromptContext::bounded(
        TurnId::new("turn_bounded").unwrap(),
        "goal",
        revision(4),
        (0..200).map(|idx| CapabilityId::new(format!("capability_{idx}")).unwrap()),
        observations,
    );
    assert_eq!(context.observations.len(), MAX_AGENT_CONTEXT_ITEMS);
    assert_eq!(
        context.policy_visible_capabilities.len(),
        MAX_VISIBLE_CAPABILITIES
    );
    assert!(
        context
            .observations
            .iter()
            .all(|item| item.summary.len() <= MAX_AGENT_CONTEXT_ITEM_BYTES)
    );
    let encoded = serde_json::to_string(&context).unwrap();
    assert!(!encoded.contains("SecretRef"));
    assert!(!encoded.contains("raw_project"));
}

#[test]
fn turn_loop_does_not_own_execution_retry_or_mode_specific_prompting() {
    let source = include_str!("../src/turn/mod.rs");
    for forbidden in [
        "ExecutionController",
        "retry_decision",
        "mode_prompt",
        "stored_mode",
        "AskMode",
        "PlanMode",
        "ActMode",
    ] {
        assert!(
            !source.contains(forbidden),
            "turn loop leaked forbidden ownership: {forbidden}"
        );
    }
    let (_, does_not_own) = turn_loop_boundary();
    assert!(does_not_own.contains(&"execution_retry"));
}
