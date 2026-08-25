use std::path::PathBuf;

use rho_extension_runtime::{
    PluginCommandResultV1, ScopeId, ViewerDocumentV1, WorkspaceGrantIdentity,
};
use rho_server::coordinator::{AgentPluginContextItem, AgentPluginToolDefinition};
use rho_store::{PluginPermissionMutationOutcome, PluginPermissionRequest};
use serde::{Deserialize, Serialize};

pub(crate) struct WorkspacePluginAgentProjection {
    pub tools: Vec<AgentPluginToolDefinition>,
    pub context: Vec<AgentPluginContextItem>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginContributionList {
    pub project_root: String,
    pub project_revision: i64,
    pub contributions: Vec<PluginContributionView>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginContributionView {
    pub contribution_id: String,
    pub kind: String,
    pub label: String,
    pub purpose: String,
    pub contract_major: u64,
    pub plugin_id: String,
    pub package_digest: String,
    pub activation_generation: u64,
    pub short_digest: String,
    pub status: String,
    pub available: bool,
    pub accepts_empty_input: bool,
    pub input_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginCommandInvocationView {
    pub project_root: String,
    pub project_revision: i64,
    pub contribution_id: String,
    pub result: PluginCommandResultV1,
    pub provenance: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginViewerDocumentView {
    pub project_root: String,
    pub project_revision: i64,
    pub contribution_id: String,
    pub document: ViewerDocumentV1,
    pub provenance: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginList {
    pub project_root: String,
    pub project_revision: i64,
    pub status: String,
    pub plugins: Vec<WorkspacePluginView>,
    pub failures: Vec<WorkspacePluginFailureView>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginView {
    pub plugin_id: String,
    pub directory_name: String,
    pub name: String,
    pub version: String,
    pub package_digest: String,
    pub short_digest: String,
    pub runtime_kind: String,
    pub permission_count: usize,
    pub pending_request_count: usize,
    pub active_grant_count: usize,
    pub status: String,
    pub desired_state: String,
    pub observed_state: String,
    pub accepted_digest: Option<String>,
    pub rollback_digest: Option<String>,
    pub transition_id: Option<String>,
    pub recoverable_tombstone_id: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginFailureView {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginEnableResult {
    pub status: String,
    pub plugin_id: String,
    pub request_ids: Vec<String>,
    pub active_grant_count: usize,
    pub transition_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginDisableResult {
    pub status: String,
    pub plugin_id: String,
    pub transition_id: Option<String>,
    pub route_closed: bool,
    pub calls_cancelled: usize,
    pub pending_requests_cancelled: usize,
    pub handles_revoked: usize,
    pub contributions_disposed: usize,
    pub host_disposed: bool,
    pub errors: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspacePluginUninstallInput {
    pub plugin_id: String,
    pub directory_name: String,
    pub package_digest: String,
    pub expected_project_revision: i64,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginUninstallResult {
    pub status: String,
    pub plugin_id: String,
    pub transition_id: String,
    pub tombstone_id: String,
    pub project_revision: i64,
    pub route_closed: bool,
    pub pending_requests_cancelled: usize,
    pub durable_grants_revoked: usize,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspacePluginRestoreInput {
    pub tombstone_id: String,
    pub expected_project_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginRestoreResult {
    pub status: String,
    pub plugin_id: String,
    pub tombstone_id: String,
    pub project_revision: i64,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspacePluginUpdateInput {
    pub plugin_id: String,
    pub expected_old_digest: String,
    pub candidate_digest: String,
    pub expected_project_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspacePluginRollbackInput {
    pub plugin_id: String,
    pub expected_current_digest: String,
    pub rollback_digest: String,
    pub expected_project_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginBoundaryTeardownReport {
    pub project_root: String,
    pub kind: String,
    pub attempted: usize,
    pub completed: usize,
    pub completion_uncertain: usize,
    pub forced: usize,
    pub entries: Vec<WorkspacePluginBoundaryTeardownEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginBoundaryTeardownEntry {
    pub plugin_id: String,
    pub status: String,
    pub route_closed: bool,
    pub error_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginHeartbeatReport {
    pub project_root: String,
    pub checked: usize,
    pub crashed: usize,
    pub blocked: usize,
    pub failures: usize,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginReconciliationReport {
    pub project_root: String,
    pub reactivated: usize,
    pub already_active: usize,
    pub permission_required: usize,
    pub update_pending: usize,
    pub blocked: usize,
    pub skipped: usize,
    pub recovered_uninstalls: usize,
    pub recovered_purges: usize,
    pub recovered_replacements: usize,
    pub recovery_required: usize,
    pub project_files_changed: bool,
    pub entries: Vec<WorkspacePluginReconciliationEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginReconciliationEntry {
    pub plugin_id: Option<String>,
    pub status: String,
    pub reason_code: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginPermissionDecisionInput {
    pub request_id: String,
    pub decision: String,
    pub expected_project_revision: i64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginPermissionDecisionResult {
    pub outcome: PluginPermissionMutationOutcome,
    pub request: PluginPermissionRequest,
    pub plugin_status: String,
    pub active_grant_count: usize,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginGrantList {
    pub project_root: String,
    pub grants: Vec<PluginGrantView>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginGrantView {
    pub grant_id: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_digest: String,
    pub short_digest: String,
    pub permission: String,
    pub constraints: serde_json::Value,
    pub grant_source: String,
    pub policy_revision: i64,
    pub expires_at: String,
    pub status: String,
    pub live_handle: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginGrantRevokeResult {
    pub outcome: PluginPermissionMutationOutcome,
    pub grant_id: String,
    pub live_handle_revoked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct WorkspacePluginCallResult {
    pub plugin_id: String,
    pub status: String,
    pub result: Option<serde_json::Value>,
    pub error_code: Option<String>,
    pub broker_steps: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct PluginRuntimeContext {
    pub app_data_dir: PathBuf,
    pub project_root: String,
    pub project_revision: i64,
    pub project_scope_id: ScopeId,
    pub workspace: Option<WorkspaceGrantIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceSurfaceInvocationRoute {
    pub contribution_id: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub activation_generation: u64,
    pub host_instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceCheckRuleRegistration {
    pub contribution_id: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub activation_generation: u64,
}
