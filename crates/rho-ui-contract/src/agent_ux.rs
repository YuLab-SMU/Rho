use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    ContractError, RSR_CONTRACT_MAJOR, Validate, encoded_json_len, validate_json_value,
    validate_label, validate_opaque_text, validate_text, validate_unique,
};

pub const AGENT_UX_CONTRACT: &str = "rho.ui.agent-ux.v1";
pub const MAX_AGENT_UX_PROJECTION_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_AGENT_GOAL_BYTES: usize = 16 * 1024;
pub const MAX_AGENT_MESSAGE_BYTES: usize = 128 * 1024;
pub const MAX_AGENT_ACTIVITY: usize = 512;
pub const MAX_AGENT_PLAN_STEPS: usize = 64;
pub const MAX_AGENT_ARGUMENT_BYTES: usize = 64 * 1024;

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum AgentSurfaceStateV1 {
    Loading,
    Empty,
    Ready,
    Streaming,
    Blocked,
    Denied,
    Stale,
    Uncertain,
    Reconnecting,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPostureV1 {
    AskBeforeChanges,
    AutoWithinPolicy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DataEgressControlV1 {
    Deny,
    ConfiguredProviderOnly,
    AllowlistedDestinations,
    AskForUnrestrictedDestination,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ActivityKindV1 {
    Message,
    PlanTransition,
    CapabilityRequest,
    Approval,
    ExecutionJob,
    Revision,
    Artifact,
    Recovery,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatusV1 {
    Pending,
    Streaming,
    WaitingApproval,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
    Reconnecting,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MessageRoleV1 {
    User,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MessageVisibilityV1 {
    UserVisible,
    ObservableReasoningArtifact,
    PrivateReasoningRedacted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanStateV1 {
    Proposed,
    Active,
    Completed,
    Stale,
    Replaced,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStateV1 {
    Pending,
    Running,
    Completed,
    Blocked,
    Denied,
    Stale,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStateV1 {
    Pending,
    Approved,
    Denied,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EffectClassV1 {
    Read,
    WorkspaceMutation,
    ProjectMutation,
    ExternalEffect,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DestinationClassV1 {
    LocalWorkspace,
    LocalSandbox,
    ConfiguredProvider,
    AllowlistedDomain,
    UnrestrictedNetwork,
    RemoteExecutor,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum JobStateV1 {
    Prepared,
    Queued,
    Submitted,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
    Reconciling,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct RevisionRefV1 {
    pub workspace_id: String,
    pub kernel_instance_id: String,
    #[specta(type = crate::UiIpcNumber)]
    pub state_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub project_revision: u64,
}

impl Validate for RevisionRefV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.workspace_id, "revision.workspace_id")?;
        validate_opaque_text(&self.kernel_instance_id, "revision.kernel_instance_id")?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct AuthoritativeCommitRefV1 {
    pub event_id: String,
    pub revision: RevisionRefV1,
}

impl Validate for AuthoritativeCommitRefV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.event_id, "commit.event_id")?;
        self.revision.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct GoalProjectionV1 {
    pub goal_id: String,
    pub text: String,
    pub state: AgentSurfaceStateV1,
}

impl Validate for GoalProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.goal_id, "goal.goal_id")?;
        validate_text(&self.text, "goal.text", MAX_AGENT_GOAL_BYTES, false, true)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct MessageProjectionV1 {
    pub message_id: String,
    pub role: MessageRoleV1,
    pub state: AgentSurfaceStateV1,
    pub visibility: MessageVisibilityV1,
    pub content_preview: String,
    pub authoritative_commit: Option<AuthoritativeCommitRefV1>,
}

impl Validate for MessageProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.message_id, "message.message_id")?;
        validate_text(
            &self.content_preview,
            "message.content_preview",
            MAX_AGENT_MESSAGE_BYTES,
            true,
            true,
        )?;
        if let Some(commit) = &self.authoritative_commit {
            commit.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct PlanStepProjectionV1 {
    pub step_id: String,
    pub label: String,
    pub state: PlanStepStateV1,
    pub stale_after: Option<RevisionRefV1>,
}

impl Validate for PlanStepProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.step_id, "plan_step.step_id")?;
        validate_label(&self.label, "plan_step.label")?;
        if let Some(revision) = &self.stale_after {
            revision.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct PlanProjectionV1 {
    pub plan_id: String,
    pub state: PlanStateV1,
    pub visual_component: String,
    pub steps: Vec<PlanStepProjectionV1>,
}

impl Validate for PlanProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.plan_id, "plan.plan_id")?;
        validate_label(&self.visual_component, "plan.visual_component")?;
        if self.steps.len() > MAX_AGENT_PLAN_STEPS {
            return Err(ContractError::LimitExceeded {
                path: "plan.steps".to_string(),
                limit: MAX_AGENT_PLAN_STEPS,
                actual: self.steps.len(),
            });
        }
        validate_unique(
            "plan.steps",
            self.steps.iter().map(|step| step.step_id.as_str()),
        )?;
        for step in &self.steps {
            step.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct ExactEffectReviewV1 {
    pub capability_id: String,
    pub effect_class: EffectClassV1,
    pub destination: DestinationClassV1,
    pub expected_revision: RevisionRefV1,
    #[specta(type = crate::UiIpcUnknown)]
    pub normalized_arguments: Value,
    pub reversible: bool,
    pub risk_label: String,
}

impl Validate for ExactEffectReviewV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.capability_id, "effect.capability_id")?;
        self.expected_revision.validate()?;
        validate_json_value(
            "effect.normalized_arguments",
            &self.normalized_arguments,
            MAX_AGENT_ARGUMENT_BYTES,
        )?;
        validate_label(&self.risk_label, "effect.risk_label")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct ApprovalProjectionV1 {
    pub approval_id: String,
    pub state: ApprovalStateV1,
    pub exact_effect: ExactEffectReviewV1,
    pub authoritative_commit: Option<AuthoritativeCommitRefV1>,
}

impl Validate for ApprovalProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.approval_id, "approval.approval_id")?;
        self.exact_effect.validate()?;
        if let Some(commit) = &self.authoritative_commit {
            commit.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct JobProjectionV1 {
    pub job_id: String,
    pub execution_id: String,
    pub state: JobStateV1,
    pub visual_component: String,
    pub revision: RevisionRefV1,
    pub terminal_event: Option<AuthoritativeCommitRefV1>,
}

impl Validate for JobProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.job_id, "job.job_id")?;
        validate_opaque_text(&self.execution_id, "job.execution_id")?;
        validate_label(&self.visual_component, "job.visual_component")?;
        self.revision.validate()?;
        if let Some(commit) = &self.terminal_event {
            commit.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct ArtifactProjectionV1 {
    pub artifact_id: String,
    pub digest: String,
    pub producer_id: String,
    pub revision: RevisionRefV1,
}

impl Validate for ArtifactProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.artifact_id, "artifact.artifact_id")?;
        validate_opaque_text(&self.digest, "artifact.digest")?;
        validate_opaque_text(&self.producer_id, "artifact.producer_id")?;
        if !self.digest.starts_with("sha256:") {
            return Err(ContractError::InvalidValue {
                path: "artifact.digest".to_string(),
                reason: "artifact identity must be content-addressed".to_string(),
            });
        }
        self.revision.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct RecoveryProjectionV1 {
    pub recovery_id: String,
    pub state: AgentSurfaceStateV1,
    pub object: String,
    pub known_truth: String,
    pub safe_next_step: String,
}

impl Validate for RecoveryProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.recovery_id, "recovery.recovery_id")?;
        validate_label(&self.object, "recovery.object")?;
        validate_text(
            &self.known_truth,
            "recovery.known_truth",
            MAX_AGENT_GOAL_BYTES,
            false,
            true,
        )?;
        validate_text(
            &self.safe_next_step,
            "recovery.safe_next_step",
            MAX_AGENT_GOAL_BYTES,
            false,
            true,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct ProviderCapabilitySelectorV1 {
    pub provider_snapshot_id: String,
    pub provider_label: String,
    pub capability_ids: Vec<String>,
    pub read_only_external_observer: bool,
    pub writable_controls_visible: bool,
}

impl Validate for ProviderCapabilitySelectorV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.provider_snapshot_id, "provider.provider_snapshot_id")?;
        validate_label(&self.provider_label, "provider.provider_label")?;
        validate_unique(
            "provider.capability_ids",
            self.capability_ids.iter().map(String::as_str),
        )?;
        for capability in &self.capability_ids {
            validate_opaque_text(capability, "provider.capability_id")?;
        }
        if self.read_only_external_observer && self.writable_controls_visible {
            return Err(ContractError::InvalidValue {
                path: "provider.writable_controls_visible".to_string(),
                reason: "read-only external observers must not expose writable controls"
                    .to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct AgentLayoutAcceptanceV1 {
    pub keyboard_navigation: bool,
    pub screen_reader_labels: bool,
    pub narrow_width: bool,
    pub long_output: bool,
}

impl Validate for AgentLayoutAcceptanceV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if !self.keyboard_navigation
            || !self.screen_reader_labels
            || !self.narrow_width
            || !self.long_output
        {
            return Err(ContractError::InvalidValue {
                path: "layout_acceptance".to_string(),
                reason: "keyboard, screen-reader, narrow layout and long output cases are required"
                    .to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct ActivityProjectionV1 {
    pub activity_id: String,
    pub kind: ActivityKindV1,
    pub status: ActivityStatusV1,
    pub label: String,
    pub authoritative_commit: Option<AuthoritativeCommitRefV1>,
    pub transport_acknowledged: bool,
}

impl Validate for ActivityProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.activity_id, "activity.activity_id")?;
        validate_label(&self.label, "activity.label")?;
        if let Some(commit) = &self.authoritative_commit {
            commit.validate()?;
        }
        if self.status == ActivityStatusV1::Succeeded && self.authoritative_commit.is_none() {
            return Err(ContractError::InvalidValue {
                path: "activity.authoritative_commit".to_string(),
                reason: "success requires an authoritative committed event and revision"
                    .to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct AgentUxProjectionV1 {
    pub contract: String,
    #[specta(type = crate::UiIpcNumber)]
    pub contract_major: u16,
    pub surface_state: AgentSurfaceStateV1,
    pub permission_posture: PermissionPostureV1,
    pub data_egress: DataEgressControlV1,
    pub goal: GoalProjectionV1,
    pub messages: Vec<MessageProjectionV1>,
    pub plan: Option<PlanProjectionV1>,
    pub activities: Vec<ActivityProjectionV1>,
    pub approvals: Vec<ApprovalProjectionV1>,
    pub jobs: Vec<JobProjectionV1>,
    pub artifacts: Vec<ArtifactProjectionV1>,
    pub recovery: Vec<RecoveryProjectionV1>,
    pub provider: ProviderCapabilitySelectorV1,
    pub layout_acceptance: AgentLayoutAcceptanceV1,
}

impl Validate for AgentUxProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != AGENT_UX_CONTRACT || self.contract_major != RSR_CONTRACT_MAJOR {
            return Err(ContractError::InvalidValue {
                path: "agent_ux.contract".to_string(),
                reason: "unsupported Agent UX contract".to_string(),
            });
        }
        self.goal.validate()?;
        for message in &self.messages {
            message.validate()?;
        }
        if let Some(plan) = &self.plan {
            plan.validate()?;
        }
        if self.activities.len() > MAX_AGENT_ACTIVITY {
            return Err(ContractError::LimitExceeded {
                path: "agent_ux.activities".to_string(),
                limit: MAX_AGENT_ACTIVITY,
                actual: self.activities.len(),
            });
        }
        validate_unique(
            "agent_ux.activities",
            self.activities
                .iter()
                .map(|activity| activity.activity_id.as_str()),
        )?;
        for activity in &self.activities {
            activity.validate()?;
        }
        validate_unique(
            "agent_ux.approvals",
            self.approvals
                .iter()
                .map(|approval| approval.approval_id.as_str()),
        )?;
        for approval in &self.approvals {
            approval.validate()?;
        }
        validate_unique(
            "agent_ux.jobs",
            self.jobs.iter().map(|job| job.job_id.as_str()),
        )?;
        for job in &self.jobs {
            job.validate()?;
        }
        if let Some(plan) = &self.plan {
            let job_ids = self
                .jobs
                .iter()
                .map(|job| job.job_id.as_str())
                .collect::<BTreeSet<_>>();
            if job_ids.contains(plan.plan_id.as_str()) {
                return Err(ContractError::InvalidValue {
                    path: "agent_ux.plan.plan_id".to_string(),
                    reason: "Plan and Job identities must not share IDs".to_string(),
                });
            }
            if self
                .jobs
                .iter()
                .any(|job| job.visual_component == plan.visual_component)
            {
                return Err(ContractError::InvalidValue {
                    path: "agent_ux.visual_component".to_string(),
                    reason: "Plan and Job must use distinct visual components".to_string(),
                });
            }
        }
        validate_unique(
            "agent_ux.artifacts",
            self.artifacts
                .iter()
                .map(|artifact| artifact.artifact_id.as_str()),
        )?;
        for artifact in &self.artifacts {
            artifact.validate()?;
        }
        validate_unique(
            "agent_ux.recovery",
            self.recovery
                .iter()
                .map(|recovery| recovery.recovery_id.as_str()),
        )?;
        for recovery in &self.recovery {
            recovery.validate()?;
        }
        self.provider.validate()?;
        self.layout_acceptance.validate()?;
        let encoded = encoded_json_len("agent_ux", self)?;
        if encoded > MAX_AGENT_UX_PROJECTION_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "agent_ux".to_string(),
                limit: MAX_AGENT_UX_PROJECTION_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

pub fn required_agent_surface_states() -> Vec<AgentSurfaceStateV1> {
    vec![
        AgentSurfaceStateV1::Loading,
        AgentSurfaceStateV1::Empty,
        AgentSurfaceStateV1::Streaming,
        AgentSurfaceStateV1::Blocked,
        AgentSurfaceStateV1::Denied,
        AgentSurfaceStateV1::Stale,
        AgentSurfaceStateV1::Uncertain,
        AgentSurfaceStateV1::Reconnecting,
        AgentSurfaceStateV1::Cancelled,
    ]
}

fn revision(state_revision: u64, project_revision: u64) -> RevisionRefV1 {
    RevisionRefV1 {
        workspace_id: "workspace_main".to_string(),
        kernel_instance_id: "kernel_a".to_string(),
        state_revision,
        project_revision,
    }
}

fn commit(event_id: &str, state_revision: u64, project_revision: u64) -> AuthoritativeCommitRefV1 {
    AuthoritativeCommitRefV1 {
        event_id: event_id.to_string(),
        revision: revision(state_revision, project_revision),
    }
}

pub fn agent_ux_contract_fixture() -> AgentUxProjectionV1 {
    AgentUxProjectionV1 {
        contract: AGENT_UX_CONTRACT.to_string(),
        contract_major: RSR_CONTRACT_MAJOR,
        surface_state: AgentSurfaceStateV1::Streaming,
        permission_posture: PermissionPostureV1::AskBeforeChanges,
        data_egress: DataEgressControlV1::ConfiguredProviderOnly,
        goal: GoalProjectionV1 {
            goal_id: "goal_cluster_compare".to_string(),
            text: "Compare cluster 3 and cluster 7 while controlling sample effects".to_string(),
            state: AgentSurfaceStateV1::Streaming,
        },
        messages: vec![MessageProjectionV1 {
            message_id: "message_observation_1".to_string(),
            role: MessageRoleV1::Agent,
            state: AgentSurfaceStateV1::Ready,
            visibility: MessageVisibilityV1::ObservableReasoningArtifact,
            content_preview: "Observation: cluster 7 is enriched for sample B".to_string(),
            authoritative_commit: Some(commit("event_message_completed_1", 842, 15)),
        }],
        plan: Some(PlanProjectionV1 {
            plan_id: "plan_current".to_string(),
            state: PlanStateV1::Active,
            visual_component: "agent-plan-card".to_string(),
            steps: vec![
                PlanStepProjectionV1 {
                    step_id: "step_inspect_composition".to_string(),
                    label: "Inspect cluster composition".to_string(),
                    state: PlanStepStateV1::Completed,
                    stale_after: None,
                },
                PlanStepProjectionV1 {
                    step_id: "step_control_sample_effect".to_string(),
                    label: "Control for sample effect".to_string(),
                    state: PlanStepStateV1::Running,
                    stale_after: Some(revision(842, 15)),
                },
            ],
        }),
        activities: vec![
            ActivityProjectionV1 {
                activity_id: "activity_observe".to_string(),
                kind: ActivityKindV1::Revision,
                status: ActivityStatusV1::Succeeded,
                label: "Observation committed".to_string(),
                authoritative_commit: Some(commit("event_observe_1", 842, 15)),
                transport_acknowledged: false,
            },
            ActivityProjectionV1 {
                activity_id: "activity_run_r".to_string(),
                kind: ActivityKindV1::Approval,
                status: ActivityStatusV1::WaitingApproval,
                label: "run_r waiting for approval".to_string(),
                authoritative_commit: None,
                transport_acknowledged: true,
            },
        ],
        approvals: vec![ApprovalProjectionV1 {
            approval_id: "approval_run_r_1".to_string(),
            state: ApprovalStateV1::Pending,
            exact_effect: ExactEffectReviewV1 {
                capability_id: "workspace.run_r".to_string(),
                effect_class: EffectClassV1::WorkspaceMutation,
                destination: DestinationClassV1::LocalWorkspace,
                expected_revision: revision(842, 15),
                normalized_arguments: json!({
                    "code": "model <- fit_sample_adjusted_de(sce, cluster=c(3, 7))",
                    "timeout_ms": 30000
                }),
                reversible: false,
                risk_label: "Workspace mutation; not infrastructure-replayable".to_string(),
            },
            authoritative_commit: None,
        }],
        jobs: vec![JobProjectionV1 {
            job_id: "job_workspace_run_1".to_string(),
            execution_id: "execution_workspace_run_1".to_string(),
            state: JobStateV1::Running,
            visual_component: "agent-job-card".to_string(),
            revision: revision(842, 15),
            terminal_event: None,
        }],
        artifacts: vec![ArtifactProjectionV1 {
            artifact_id: "artifact_de_plot".to_string(),
            digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                .to_string(),
            producer_id: "execution_workspace_run_1".to_string(),
            revision: revision(843, 15),
        }],
        recovery: vec![RecoveryProjectionV1 {
            recovery_id: "recovery_reconnect_1".to_string(),
            state: AgentSurfaceStateV1::Reconnecting,
            object: "Workspace job".to_string(),
            known_truth: "Execution submitted; terminal outcome not yet reconciled".to_string(),
            safe_next_step: "Reconnect to durable snapshot and observe job truth".to_string(),
        }],
        provider: ProviderCapabilitySelectorV1 {
            provider_snapshot_id: "provider_snapshot_1".to_string(),
            provider_label: "Configured provider".to_string(),
            capability_ids: vec![
                "workspace.inspect".to_string(),
                "workspace.run_r".to_string(),
            ],
            read_only_external_observer: false,
            writable_controls_visible: true,
        },
        layout_acceptance: AgentLayoutAcceptanceV1 {
            keyboard_navigation: true,
            screen_reader_labels: true,
            narrow_width: true,
            long_output: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_ux_fixture_validates_required_semantics() {
        agent_ux_contract_fixture().validate().unwrap();
    }

    #[test]
    fn required_states_cover_error_recovery_and_empty_cases() {
        let states = required_agent_surface_states()
            .into_iter()
            .collect::<BTreeSet<_>>();
        for state in [
            AgentSurfaceStateV1::Loading,
            AgentSurfaceStateV1::Empty,
            AgentSurfaceStateV1::Streaming,
            AgentSurfaceStateV1::Blocked,
            AgentSurfaceStateV1::Denied,
            AgentSurfaceStateV1::Stale,
            AgentSurfaceStateV1::Uncertain,
            AgentSurfaceStateV1::Reconnecting,
            AgentSurfaceStateV1::Cancelled,
        ] {
            assert!(states.contains(&state));
        }
    }

    #[test]
    fn transport_ack_is_not_success_without_authoritative_commit() {
        let mut projection = agent_ux_contract_fixture();
        projection.activities[1].status = ActivityStatusV1::Succeeded;
        assert!(matches!(
            projection.validate(),
            Err(ContractError::InvalidValue { path, .. })
                if path == "activity.authoritative_commit"
        ));
    }

    #[test]
    fn plan_and_job_have_separate_identity_and_visual_models() {
        let mut projection = agent_ux_contract_fixture();
        projection.jobs[0].job_id = projection.plan.as_ref().unwrap().plan_id.clone();
        assert!(projection.validate().is_err());

        let mut projection = agent_ux_contract_fixture();
        projection.jobs[0].visual_component =
            projection.plan.as_ref().unwrap().visual_component.clone();
        assert!(projection.validate().is_err());
    }

    #[test]
    fn read_only_external_observer_hides_writable_controls() {
        let mut projection = agent_ux_contract_fixture();
        projection.provider.read_only_external_observer = true;
        projection.provider.writable_controls_visible = true;
        assert!(matches!(
            projection.validate(),
            Err(ContractError::InvalidValue { path, .. })
                if path == "provider.writable_controls_visible"
        ));
    }

    #[test]
    fn fixture_does_not_expose_acp_or_private_thinking_fields() {
        let encoded = serde_json::to_string(&agent_ux_contract_fixture()).unwrap();
        for forbidden in [
            "acp",
            "private_thinking",
            "chain_of_thought",
            "provider_method",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "forbidden UI leak: {forbidden}"
            );
        }
    }
}
