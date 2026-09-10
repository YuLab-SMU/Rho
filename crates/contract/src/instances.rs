//! Project-owned logical R sessions. A native process is one incarnation of an instance.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const RUNTIME_READ_SCOPE: &str = "workspace.read";
pub const RUNTIME_CONTROL_SCOPE: &str = "workspace.run_r";
pub const MAIN_WORKSPACE_INSTANCE: &str = "main";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeLaunchBinding {
    pub r_executable: String,
    pub ark_executable: String,
    pub environment_realization_id: Option<String>,
    #[serde(default)]
    pub library_path: Option<String>,
    #[serde(default)]
    pub checkpoint_helper_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeInstallationIdentity {
    pub r_home: String,
    pub r_version: String,
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProcessIdentity {
    pub native_session_id: String,
    pub pid: u32,
    pub start_time: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeContinuationMode {
    AutoContinue,
    SaveStartEmpty,
    Manual,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointObjectSelection {
    AllEligible,
    Selected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimePolicy {
    pub mode: RuntimeContinuationMode,
    pub object_selection: CheckpointObjectSelection,
    pub include_names: Vec<String>,
    pub exclude_names: Vec<String>,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub idle_delay_seconds: u32,
    pub automatic_interval_seconds: u32,
    pub automatic_payload_limit_bytes: u64,
    pub capture_budget_ms: u32,
    pub recent_checkpoints: u32,
    pub daily_retention_days: u32,
    pub project_storage_limit_bytes: u64,
    pub global_storage_limit_bytes: u64,
    pub minimum_free_bytes: u64,
    pub max_running_instances: u32,
    /// None keeps idle sessions alive. Only fully protected sessions may auto-stop.
    pub idle_stop_without_windows_seconds: Option<u32>,
}

impl Default for RuntimePolicy {
    fn default() -> Self {
        Self {
            mode: RuntimeContinuationMode::AutoContinue,
            object_selection: CheckpointObjectSelection::AllEligible,
            include_names: vec![],
            exclude_names: vec![],
            include_patterns: vec![],
            exclude_patterns: vec![],
            idle_delay_seconds: 30,
            automatic_interval_seconds: 300,
            automatic_payload_limit_bytes: 2 * 1024 * 1024 * 1024,
            capture_budget_ms: 2_000,
            recent_checkpoints: 5,
            daily_retention_days: 7,
            project_storage_limit_bytes: 10 * 1024 * 1024 * 1024,
            global_storage_limit_bytes: 50 * 1024 * 1024 * 1024,
            minimum_free_bytes: 2 * 1024 * 1024 * 1024,
            max_running_instances: 4,
            idle_stop_without_windows_seconds: None,
        }
    }
}

/// An update replaces this scope's whole override set: a missing field inherits,
/// so omitting one is how it is reset to the inherited value. Writing a narrower
/// scope never rewrites an explicit choice already stored in a wider one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimePolicyOverrides {
    pub mode: Option<RuntimeContinuationMode>,
    pub object_selection: Option<CheckpointObjectSelection>,
    pub include_names: Option<Vec<String>>,
    pub exclude_names: Option<Vec<String>>,
    pub include_patterns: Option<Vec<String>>,
    pub exclude_patterns: Option<Vec<String>>,
    pub idle_delay_seconds: Option<u32>,
    pub automatic_interval_seconds: Option<u32>,
    pub automatic_payload_limit_bytes: Option<u64>,
    pub capture_budget_ms: Option<u32>,
    pub recent_checkpoints: Option<u32>,
    pub daily_retention_days: Option<u32>,
    pub project_storage_limit_bytes: Option<u64>,
    pub global_storage_limit_bytes: Option<u64>,
    pub minimum_free_bytes: Option<u64>,
    pub max_running_instances: Option<u32>,
    /// Zero explicitly disables idle stopping; missing inherits.
    pub idle_stop_without_windows_seconds: Option<u32>,
}

impl RuntimePolicyOverrides {
    pub fn apply_to(&self, policy: &mut RuntimePolicy) {
        macro_rules! inherit {
            ($($field:ident),+ $(,)?) => { $(if let Some(value) = self.$field { policy.$field = value; })+ };
        }
        inherit!(
            mode,
            object_selection,
            idle_delay_seconds,
            automatic_interval_seconds,
            automatic_payload_limit_bytes,
            capture_budget_ms,
            recent_checkpoints,
            daily_retention_days,
            project_storage_limit_bytes,
            global_storage_limit_bytes,
            minimum_free_bytes,
            max_running_instances
        );
        if let Some(value) = &self.include_names {
            policy.include_names = value.clone();
        }
        if let Some(value) = &self.exclude_names {
            policy.exclude_names = value.clone();
        }
        if let Some(value) = &self.include_patterns {
            policy.include_patterns = value.clone();
        }
        if let Some(value) = &self.exclude_patterns {
            policy.exclude_patterns = value.clone();
        }
        if let Some(seconds) = self.idle_stop_without_windows_seconds {
            policy.idle_stop_without_windows_seconds = (seconds > 0).then_some(seconds);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeEffectivePolicy {
    pub value: RuntimePolicy,
    pub app: RuntimePolicyOverrides,
    pub project: RuntimePolicyOverrides,
    pub instance: RuntimePolicyOverrides,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeInstanceState {
    Stopped,
    Starting,
    Ready,
    Stopping,
    RecoveryRequired,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeLifecycleBlocker {
    pub kind: String,
    pub reference: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceInstance {
    pub workspace_instance_id: String,
    pub name: String,
    pub binding: RuntimeLaunchBinding,
    pub installation: Option<RuntimeInstallationIdentity>,
    pub native_session_id: Option<String>,
    /// A clean restart changes this even when no objects have been created yet.
    pub continuation_lineage_id: String,
    pub state: RuntimeInstanceState,
    pub policy: RuntimeEffectivePolicy,
    pub blockers: Vec<RuntimeLifecycleBlocker>,
    pub last_error: Option<String>,
    pub last_lifecycle_operation_id: Option<String>,
    pub protection: crate::RuntimeProtectionStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeInstances {
    pub instances: Vec<WorkspaceInstance>,
    pub default_workspace_instance_id: Option<String>,
    pub total: u64,
    pub next_after_instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeInstancesArguments {
    #[serde(default)]
    pub after_instance_id: Option<String>,
    #[serde(default = "default_instance_page")]
    pub limit: u32,
}
fn default_instance_page() -> u32 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeInstanceArguments {
    pub workspace_instance_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CreateRuntimeInstance {
    pub name: String,
    pub binding: RuntimeLaunchBinding,
    #[serde(default = "default_start")]
    pub start: bool,
    #[serde(default)]
    pub policy: RuntimePolicyOverrides,
}
fn default_start() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContinueRuntimeInstance {
    pub workspace_instance_id: String,
    pub expected_continuation_lineage_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct StopRuntimeInstance {
    pub workspace_instance_id: String,
    pub expected_native_session_id: String,
    /// Explicitly stopping without a fresh recovery point is never inferred.
    #[serde(default)]
    pub discard_unsaved_objects: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RestartRuntimeInstance {
    pub workspace_instance_id: String,
    pub expected_native_session_id: String,
    /// A clean restart creates an empty continuation lineage and retains old recovery points.
    pub clean: bool,
    #[serde(default)]
    pub discard_unsaved_objects: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RestoreRuntimeInstance {
    pub source_workspace_instance_id: String,
    pub checkpoint_id: crate::OperationId,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RenameRuntimeInstance {
    pub workspace_instance_id: String,
    pub expected_name: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ConfigureRuntimeInstance {
    pub workspace_instance_id: String,
    pub expected_continuation_lineage_id: String,
    pub binding: RuntimeLaunchBinding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSettingsScope {
    App,
    Project,
    Instance,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSettingsArguments {
    pub workspace_instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpdateRuntimeSettings {
    pub scope: RuntimeSettingsScope,
    pub workspace_instance_id: Option<String>,
    pub expected_version: Option<String>,
    pub overrides: RuntimePolicyOverrides,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSettings {
    pub effective: RuntimeEffectivePolicy,
    pub app_version: Option<String>,
    pub project_version: Option<String>,
    pub instance_version: Option<String>,
}
