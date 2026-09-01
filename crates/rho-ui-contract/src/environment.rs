//! Read-only renderer projections for Environment authority and Workspace
//! activation state. Mutation requests remain separate Broker capabilities.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentHealthStatusViewV1 {
    Unbound,
    LocalReady,
    Realized,
    RestartRequired,
    ObservationRequired,
    BlockedByIncident,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct LocalEnvironmentObservationViewV1 {
    pub project_mode: String,
    pub runtime_version: String,
    pub runtime_selection_digest: String,
    pub library_stack_digest: String,
    pub library_count: u32,
    pub lockfile_digest: Option<String>,
    pub coverage: String,
    pub package_inventory_status: String,
    pub externally_mutable: bool,
    pub source: String,
    pub observation_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct EnvironmentBindingViewV1 {
    pub environment_id: String,
    pub role: String,
    pub target_id: String,
    pub runtime_id: String,
    pub runtime_ownership: Option<String>,
    pub runtime_support_tier: Option<String>,
    pub desired_revision: String,
    pub realization_revision: String,
    pub receipt_id: String,
    pub receipt_digest: String,
    pub receipt_outcome: String,
    pub receipt_restart_required: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct EnvironmentPlanActionViewV1 {
    pub package: String,
    pub action: String,
    pub version: Option<String>,
    pub source: String,
    pub artifact_digest: String,
    #[specta(type = crate::UiIpcNumber)]
    pub artifact_byte_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct EnvironmentPlanReviewViewV1 {
    pub plan_id: String,
    pub intent: String,
    pub environment_id: String,
    pub expected_desired_revision: String,
    pub expected_realization_revision: String,
    pub runtime_id: String,
    pub runtime_version: String,
    pub runtime_ownership: String,
    pub runtime_support_tier: String,
    pub library_stack_digest: String,
    pub target_library_kind: String,
    pub target_library_path: String,
    pub package_actions: Vec<EnvironmentPlanActionViewV1>,
    pub native_actions: Vec<String>,
    pub toolchain_actions: Vec<String>,
    pub network_intents: Vec<String>,
    pub secret_requirements: Vec<String>,
    pub verification_probes: Vec<String>,
    pub restart_required: bool,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct EnvironmentCheckpointViewV1 {
    pub name: String,
    pub reached_at: String,
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct EnvironmentOperationViewV1 {
    pub operation_id: String,
    pub status: String,
    pub reason: Option<String>,
    pub checkpoints: Vec<EnvironmentCheckpointViewV1>,
    pub plan: EnvironmentPlanReviewViewV1,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct EnvironmentIncidentViewV1 {
    pub incident_id: String,
    pub kind: String,
    pub subject: String,
    pub detail: String,
    pub status: String,
    pub detected_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct EnvironmentWorkspaceViewV1 {
    pub phase: String,
    pub workspace_id: Option<String>,
    pub kernel_instance_id: Option<String>,
    pub active_receipt_digest: Option<String>,
    pub pending_receipt_digest: Option<String>,
    pub restart_required: bool,
    pub reobserve_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct EnvironmentHealthViewV1 {
    pub status: EnvironmentHealthStatusViewV1,
    pub binding: Option<EnvironmentBindingViewV1>,
    pub local_observation: Option<LocalEnvironmentObservationViewV1>,
    pub workspace: EnvironmentWorkspaceViewV1,
    pub pending_plan: Option<EnvironmentPlanReviewViewV1>,
    pub latest_operation: Option<EnvironmentOperationViewV1>,
    pub incidents: Vec<EnvironmentIncidentViewV1>,
    pub limitations: Vec<String>,
    pub observed_at: String,
}
