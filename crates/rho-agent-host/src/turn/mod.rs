//! Autonomous revision-aware turn orchestration.
//!
//! A turn receives a goal and may observe, publish a provider-owned plan,
//! request effects, re-observe, and complete. Rho does not expose or persist a
//! user-selectable mode for this loop.

use std::collections::{BTreeSet, VecDeque};

use rho_control_plane::{AgentEffectPort, AgentEffectRequest};
use rho_protocol::{
    BrokerDecisionKind, CapabilityId, ExpectedRevisions, OperationId, OperationOutcome,
    RevisionStamp, TurnId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const MAX_AGENT_CONTEXT_ITEMS: usize = 64;
pub const MAX_AGENT_CONTEXT_ITEM_BYTES: usize = 16 * 1024;
pub const MAX_VISIBLE_CAPABILITIES: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BoundedAgentObservation {
    pub provenance: String,
    pub summary: String,
    pub revision: RevisionStamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentPromptContext {
    pub turn_id: TurnId,
    pub goal: String,
    pub current_revision: RevisionStamp,
    pub policy_visible_capabilities: Vec<CapabilityId>,
    pub observations: Vec<BoundedAgentObservation>,
}

impl AgentPromptContext {
    pub fn bounded(
        turn_id: TurnId,
        goal: impl Into<String>,
        current_revision: RevisionStamp,
        capabilities: impl IntoIterator<Item = CapabilityId>,
        observations: impl IntoIterator<Item = BoundedAgentObservation>,
    ) -> Self {
        Self {
            turn_id,
            goal: goal.into(),
            current_revision,
            policy_visible_capabilities: capabilities
                .into_iter()
                .take(MAX_VISIBLE_CAPABILITIES)
                .collect(),
            observations: observations
                .into_iter()
                .take(MAX_AGENT_CONTEXT_ITEMS)
                .map(|mut observation| {
                    observation.summary = observation
                        .summary
                        .chars()
                        .take(MAX_AGENT_CONTEXT_ITEM_BYTES)
                        .collect();
                    observation
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutonomousAction {
    Observe,
    PublishPlan {
        plan_id: String,
        steps: Vec<String>,
    },
    RequestEffect {
        capability_id: CapabilityId,
        operation_id: OperationId,
        normalized_arguments: Value,
        depends_on: ExpectedRevisions,
    },
    Answer {
        visible_text: String,
    },
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentToolResult {
    ObservationRequired {
        current_revision: RevisionStamp,
    },
    ApprovalRequired {
        operation_id: OperationId,
        reason_code: String,
    },
    Admitted {
        operation_id: OperationId,
        reason_code: String,
    },
    Rejected {
        operation_id: OperationId,
        reason_code: String,
    },
    Stale {
        operation_id: OperationId,
        requested: ExpectedRevisions,
        current: RevisionStamp,
    },
    Terminal {
        operation_id: OperationId,
        outcome: OperationOutcome,
        revision: RevisionStamp,
    },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum TurnLoopError {
    #[error("operation id {0} was already used; retry must use a new operation id")]
    DuplicateOperation(OperationId),
    #[error("provider plan exceeds bounded step count")]
    PlanTooLarge,
    #[error("visible answer exceeds bounded item size")]
    AnswerTooLarge,
}

#[derive(Debug, Clone)]
pub struct AutonomousTurnLoop {
    context: AgentPromptContext,
    used_operation_ids: BTreeSet<OperationId>,
    provider_plan: Option<String>,
    pending_operations: VecDeque<OperationId>,
    visible_answer: Option<String>,
    complete: bool,
}

impl AutonomousTurnLoop {
    pub fn new(context: AgentPromptContext) -> Self {
        Self {
            context,
            used_operation_ids: BTreeSet::new(),
            provider_plan: None,
            pending_operations: VecDeque::new(),
            visible_answer: None,
            complete: false,
        }
    }

    pub fn context(&self) -> &AgentPromptContext {
        &self.context
    }

    pub fn handle_action(
        &mut self,
        action: AutonomousAction,
        port: &mut impl AgentEffectPort,
    ) -> Result<Option<AgentToolResult>, TurnLoopError> {
        match action {
            AutonomousAction::Observe => {
                let current = port.current_revision();
                self.context.current_revision = current.clone();
                Ok(Some(AgentToolResult::ObservationRequired {
                    current_revision: current,
                }))
            }
            AutonomousAction::PublishPlan { plan_id, steps } => {
                if steps.len() > MAX_AGENT_CONTEXT_ITEMS {
                    return Err(TurnLoopError::PlanTooLarge);
                }
                self.provider_plan = Some(plan_id);
                Ok(None)
            }
            AutonomousAction::RequestEffect {
                capability_id,
                operation_id,
                normalized_arguments,
                depends_on,
            } => {
                if !self.used_operation_ids.insert(operation_id.clone()) {
                    return Err(TurnLoopError::DuplicateOperation(operation_id));
                }
                let current = port.current_revision();
                if !matches_expected(&depends_on, &current) {
                    return Ok(Some(AgentToolResult::Stale {
                        operation_id,
                        requested: depends_on,
                        current,
                    }));
                }
                let admission = port.request_effect(AgentEffectRequest {
                    capability_id,
                    operation_id: operation_id.clone(),
                    normalized_arguments,
                    depends_on,
                });
                let result = match admission.decision {
                    BrokerDecisionKind::Allow => {
                        self.pending_operations.push_back(operation_id.clone());
                        AgentToolResult::Admitted {
                            operation_id,
                            reason_code: admission.reason_code,
                        }
                    }
                    BrokerDecisionKind::Ask => AgentToolResult::ApprovalRequired {
                        operation_id,
                        reason_code: admission.reason_code,
                    },
                    BrokerDecisionKind::Deny => AgentToolResult::Rejected {
                        operation_id,
                        reason_code: admission.reason_code,
                    },
                };
                Ok(Some(result))
            }
            AutonomousAction::Answer { visible_text } => {
                if visible_text.len() > MAX_AGENT_CONTEXT_ITEM_BYTES {
                    return Err(TurnLoopError::AnswerTooLarge);
                }
                self.visible_answer = Some(visible_text);
                Ok(None)
            }
            AutonomousAction::Complete => {
                self.complete = true;
                Ok(None)
            }
        }
    }

    pub fn observe_terminal(
        &mut self,
        port: &impl AgentEffectPort,
        operation_id: &OperationId,
    ) -> Option<AgentToolResult> {
        let terminal = port.observe_terminal(operation_id)?;
        self.pending_operations.retain(|id| id != operation_id);
        self.context.current_revision = terminal.revision.clone();
        Some(AgentToolResult::Terminal {
            operation_id: terminal.operation_id,
            outcome: terminal.outcome,
            revision: terminal.revision,
        })
    }

    pub fn restart_provider(&mut self) {
        self.provider_plan = None;
        self.visible_answer = None;
    }

    pub fn pending_operations(&self) -> impl Iterator<Item = &OperationId> {
        self.pending_operations.iter()
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }
}

pub fn matches_expected(expected: &ExpectedRevisions, current: &RevisionStamp) -> bool {
    expected.workspace_id == current.workspace_id
        && expected.kernel_instance_id == current.kernel_instance_id
        && expected.state_revision == current.state_revision
        && expected.project_revision == current.project_revision
}

pub fn turn_loop_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "bounded_prompt_context",
            "revision_dependency",
            "provider_plan_projection",
            "structured_tool_result",
        ],
        &[
            "execution_retry",
            "direct_workspace_effect",
            "durable_job_truth",
            "mode_selection",
        ],
    )
}
