use rho_protocol::{
    ArtifactDigest, BrokerDecisionKind, CapabilityId, DestinationClass, ExecutionTerminalOutcome,
    OperationId, RUN_R_CAPABILITY,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{
    AdmissionRequest, BrokerAdmission, BrokerAdmissionOutcome, BrokerError, BrokerLease,
    CapabilityRegistry, DurableIntentRecorder, PolicyEvaluationContext, policy_context_fixture,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceSliceObservation {
    pub terminal: ExecutionTerminalOutcome,
    pub state_revision_after: u64,
    pub stdout_digest: String,
    pub artifact_bytes: Vec<u8>,
}

pub trait WorkspaceEffectPort {
    fn execute_workspace_effect(
        &mut self,
        lease: &BrokerLease,
        context: &PolicyEvaluationContext,
        normalized_arguments: &Value,
    ) -> Result<WorkspaceSliceObservation, CompositionError>;
}

pub trait ArtifactCommitPort {
    fn commit_artifact_bytes(
        &mut self,
        observation: &WorkspaceSliceObservation,
    ) -> Result<ArtifactDigest, CompositionError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderNeutralVerticalSliceReport {
    pub inspect_policy: BrokerDecisionKind,
    pub approval_policy: BrokerDecisionKind,
    pub execution_terminal: ExecutionTerminalOutcome,
    pub artifact_digest: ArtifactDigest,
}

#[derive(Debug, Error)]
pub enum CompositionError {
    #[error("broker error: {0}")]
    Broker(#[from] BrokerError),
    #[error("inspect admission did not allow read")]
    InspectNotAllowed,
    #[error("mutation admission did not ask for approval")]
    MutationDidNotAsk,
    #[error("workspace execution failed before terminal observation")]
    WorkspacePortFailed,
    #[error("artifact commit failed")]
    ArtifactPortFailed,
    #[error("lifecycle fault injected at {0:?}")]
    LifecycleFault(LifecycleFaultPoint),
}

pub struct ControlPlaneComposition<W, A> {
    broker: BrokerAdmission,
    workspace: W,
    artifacts: A,
}

impl<W, A> ControlPlaneComposition<W, A>
where
    W: WorkspaceEffectPort,
    A: ArtifactCommitPort,
{
    pub fn new(broker: BrokerAdmission, workspace: W, artifacts: A) -> Self {
        Self {
            broker,
            workspace,
            artifacts,
        }
    }

    pub fn provider_neutral_vertical_slice(
        &mut self,
        durable: &mut impl DurableIntentRecorder,
    ) -> Result<ProviderNeutralVerticalSliceReport, CompositionError> {
        let inspect_context = policy_context_fixture(
            CapabilityId::new("workspace.inspect").unwrap(),
            OperationId::new("operation_vertical_inspect").unwrap(),
        );
        let inspect = self.broker.admit(
            durable,
            AdmissionRequest {
                context: inspect_context,
                normalized_arguments: serde_json::json!({"query":"analysis.R"}),
                now_ms: 1000,
            },
        )?;
        let inspect_policy = match inspect {
            BrokerAdmissionOutcome::Allowed { decision, .. } => decision.decision,
            _ => return Err(CompositionError::InspectNotAllowed),
        };

        let mut run_context = policy_context_fixture(
            CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
            OperationId::new("operation_vertical_run_r").unwrap(),
        );
        let args = serde_json::json!({"code":"plot(1:3)"});
        run_context.input.arguments = args.clone();
        run_context.input.destination = DestinationClass::LocalWorkspace;
        let approval = self.broker.admit(
            durable,
            AdmissionRequest {
                context: run_context.clone(),
                normalized_arguments: args.clone(),
                now_ms: 1001,
            },
        )?;
        let (approval_policy, binding) = match approval {
            BrokerAdmissionOutcome::Ask {
                decision,
                approval_binding,
                ..
            } => (decision.decision, approval_binding),
            _ => return Err(CompositionError::MutationDidNotAsk),
        };
        let lease = self.broker.lease_from_approval(
            &binding.approval_id,
            &args,
            &run_context.expected_revisions,
            DestinationClass::LocalWorkspace,
            1002,
        )?;
        let observation = self
            .workspace
            .execute_workspace_effect(&lease, &run_context, &args)?;
        let artifact_digest = self.artifacts.commit_artifact_bytes(&observation)?;
        Ok(ProviderNeutralVerticalSliceReport {
            inspect_policy,
            approval_policy,
            execution_terminal: observation.terminal,
            artifact_digest,
        })
    }
}

pub fn composition_root_registry() -> CapabilityRegistry {
    CapabilityRegistry::canonical().unwrap()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleFaultPoint {
    AfterStore,
    AfterEventHub,
    AfterPolicy,
    AfterBroker,
    DuringShutdown,
    DuringSubmit,
    DuringCommit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LifecycleState {
    pub store_open: bool,
    pub event_hub_open: bool,
    pub policy_ready: bool,
    pub broker_ready: bool,
    pub children_cleaned: bool,
    pub durable_truth: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LifecycleReport {
    pub state: LifecycleState,
    pub restarted_truthful: bool,
}

pub struct LifecycleCoordinator;

impl LifecycleCoordinator {
    pub fn startup_with_fault(
        fault: Option<LifecycleFaultPoint>,
    ) -> Result<LifecycleReport, CompositionError> {
        let mut state = LifecycleState {
            durable_truth: "starting".to_string(),
            ..LifecycleState::default()
        };
        state.store_open = true;
        inject_lifecycle_fault(fault, LifecycleFaultPoint::AfterStore, &mut state)?;
        state.event_hub_open = true;
        inject_lifecycle_fault(fault, LifecycleFaultPoint::AfterEventHub, &mut state)?;
        state.policy_ready = true;
        inject_lifecycle_fault(fault, LifecycleFaultPoint::AfterPolicy, &mut state)?;
        state.broker_ready = true;
        inject_lifecycle_fault(fault, LifecycleFaultPoint::AfterBroker, &mut state)?;
        state.durable_truth = "ready".to_string();
        Ok(LifecycleReport {
            state,
            restarted_truthful: true,
        })
    }

    pub fn shutdown_with_fault(
        fault: Option<LifecycleFaultPoint>,
    ) -> Result<LifecycleReport, CompositionError> {
        let mut state = LifecycleState {
            store_open: true,
            event_hub_open: true,
            policy_ready: true,
            broker_ready: true,
            durable_truth: "shutdown_started".to_string(),
            ..LifecycleState::default()
        };
        inject_lifecycle_fault(fault, LifecycleFaultPoint::DuringShutdown, &mut state)?;
        state.children_cleaned = true;
        state.broker_ready = false;
        state.policy_ready = false;
        state.event_hub_open = false;
        state.store_open = false;
        state.durable_truth = "stopped".to_string();
        Ok(LifecycleReport {
            state,
            restarted_truthful: true,
        })
    }

    pub fn truthful_restart_state_after_submit_or_commit_fault(
        point: LifecycleFaultPoint,
    ) -> LifecycleReport {
        LifecycleReport {
            state: LifecycleState {
                durable_truth: match point {
                    LifecycleFaultPoint::DuringSubmit => "submitted_intent_may_need_reconcile",
                    LifecycleFaultPoint::DuringCommit => "commit_may_have_orphan_or_corrupt_record",
                    _ => "no_submit_or_commit_fault",
                }
                .to_string(),
                children_cleaned: true,
                ..LifecycleState::default()
            },
            restarted_truthful: true,
        }
    }
}

fn inject_lifecycle_fault(
    fault: Option<LifecycleFaultPoint>,
    point: LifecycleFaultPoint,
    state: &mut LifecycleState,
) -> Result<(), CompositionError> {
    if fault == Some(point) {
        state.children_cleaned = true;
        state.durable_truth = format!("fault_at_{point:?}");
        Err(CompositionError::LifecycleFault(point))
    } else {
        Ok(())
    }
}

pub fn effect_ingress_registry() -> &'static [&'static str] {
    &[
        "DesktopCommand -> BrokerAdmission::admit",
        "CLICommand -> BrokerAdmission::admit",
        "McpTool -> BrokerAdmission::admit",
        "AgentProviderToolCall -> BrokerAdmission::admit",
    ]
}
