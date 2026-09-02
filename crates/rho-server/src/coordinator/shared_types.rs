async fn run_workspace_store_service<R, F>(executor: &StoreExecutor, operation: F) -> Result<R>
where
    R: Send + 'static,
    F: FnOnce(&mut BorrowedStore<'_>) -> Result<R> + Send + 'static,
{
    executor
        .run_service(operation)
        .await
        .map_err(|error| match error {
            StoreExecutorOperationError::Operation(error) => error,
            StoreExecutorOperationError::Worker(message) => {
                anyhow::anyhow!("Store worker failed: {message}")
            }
        })
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentRuntimeCapabilityRoute {
    pub capability: String,
    pub model: String,
    pub model_type: String,
    pub required_model_capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentPluginToolDefinition {
    pub name: String,
    pub contribution_id: String,
    pub label: String,
    pub purpose: String,
    pub input_schema: Value,
    pub plugin_id: String,
    pub package_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentPluginContextItem {
    pub kind: String,
    pub contribution_id: String,
    pub label: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub status: String,
    pub content: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentRuntimeModelProfile {
    pub settings_revision: u64,
    pub route_capability: String,
    pub profile_id: String,
    pub provider_kind: String,
    pub runtime_provider_id: String,
    pub registered_provider_id: Option<String>,
    pub model_id: String,
    pub api_key_env: Option<String>,
    pub api_key_required: bool,
    pub base_url: Option<String>,
    pub base_url_env: Option<String>,
    pub wire_api: Option<String>,
    pub disable_stream_options: bool,
    pub tool_calling: String,
    pub provider_display_name: String,
    pub model_display_name: String,
    pub context_window_tokens: u64,
    pub reserved_output_tokens: u64,
    pub context_capacity_source: String,
    pub capability_routes: Vec<AgentRuntimeCapabilityRoute>,
    #[serde(default)]
    pub plugin_tools: Vec<AgentPluginToolDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentExplicitContextItem {
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: String,
    pub source_sha256: String,
    pub trust_class: String,
    pub original_bytes: i64,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentContextPlanPreview {
    pub plan_digest: String,
    pub context_window_tokens: u64,
    pub reserved_output_tokens: u64,
    pub estimated_input_tokens: u64,
    pub capacity_source: String,
    pub items: Vec<AgentTurnContextItemDraft>,
}

const MAX_CANONICAL_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const PROJECT_SKILL_TRUST_STATUS: &str = "untrusted_project_content";
const MAX_PROJECT_SKILL_MANIFEST_BYTES: u64 = 65_536;
const MAX_PROJECT_SKILL_COUNT: usize = 16;
const MAX_PROJECT_SKILL_REFERENCES: usize = 4;
const MAX_PROJECT_SKILL_INSTRUCTION_BYTES: u64 = 8_192;
const MAX_PROJECT_SKILL_REFERENCE_BYTES: u64 = 16_384;
#[cfg(test)]
const MAX_AGENT_CONTEXT_ATTACHMENTS_CHARS: usize = 64 * 1024;
const AGENT_CONTEXT_RENDER_RESERVE_CHARS: usize = 4 * 1024;
const AGENT_POLICY_AND_TOOL_RESERVE_TOKENS: u64 = 8 * 1024;
const MAX_GENERATED_OUTPUT_DEPTH: usize = 8;
const MAX_GENERATED_OUTPUT_ENTRIES: usize = 10_000;
const MAX_GENERATED_OUTPUT_FILES: usize = 2_000;
const MAX_GENERATED_OUTPUT_RECORDS: usize = 100;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct GeneratedOutputSnapshot {
    files: BTreeMap<String, GeneratedOutputSignature>,
    truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GeneratedOutputSignature {
    size_bytes: u64,
    modified_nanos: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GeneratedOutputDelta {
    path: String,
    change_kind: &'static str,
    signature: GeneratedOutputSignature,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct RawEnvironmentReceipt {
    #[serde(default)]
    project_dir: String,
    #[serde(default)]
    runtime: RawRuntimeState,
    #[serde(default)]
    library_paths: Vec<String>,
    #[serde(default)]
    installed_packages: RawInstalledPackages,
    #[serde(default)]
    renv: RawRenvState,
    #[serde(default)]
    bioconductor: RawBioconductorState,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct RawRuntimeState {
    version: Option<String>,
    platform: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct RawInstalledPackages {
    #[serde(default)]
    values: Vec<RawInstalledPackage>,
    #[serde(default)]
    truncated: bool,
    incomplete_reason: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct RawInstalledPackage {
    name: String,
    version: Option<String>,
    library: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct RawRenvState {
    status: Option<String>,
    has_lockfile: Option<bool>,
    lockfile_path: Option<String>,
    package_available: Option<bool>,
    project_library: Option<String>,
    active: Option<bool>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct RawBioconductorState {
    status: Option<String>,
    version: Option<String>,
    package_available: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CanonicalEnvironmentSnapshot {
    project_root: String,
    runtime: CanonicalRuntimeState,
    bioconductor: CanonicalBioconductorState,
    library_paths: Vec<String>,
    installed_packages: Vec<CanonicalInstalledPackage>,
    renv: CanonicalRenvState,
    incomplete_reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CanonicalRuntimeState {
    version: Option<String>,
    platform: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CanonicalBioconductorState {
    status: String,
    version: Option<String>,
    package_available: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CanonicalInstalledPackage {
    name: String,
    version: Option<String>,
    library: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CanonicalRenvState {
    status: String,
    has_lockfile: bool,
    package_available: bool,
    project_library: Option<String>,
    active: bool,
    lockfile: CanonicalLockfileState,
    synchronization: String,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CanonicalLockfileState {
    exists: bool,
    sha256: Option<String>,
    valid: bool,
    packages: Vec<CanonicalLockfilePackage>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CanonicalLockfilePackage {
    name: String,
    version: Option<String>,
    source: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
struct ProjectSkillDiscovery {
    project_root: String,
    trust_status: String,
    skills: Vec<ResolvedProjectSkill>,
    discovery_error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ProjectSkillManifest {
    schema_version: u32,
    skills: Vec<ProjectSkillManifestEntry>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ProjectSkillManifestEntry {
    id: String,
    title: String,
    description: Option<String>,
    instructions_path: String,
    #[serde(default)]
    references: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct ResolvedProjectSkill {
    id: String,
    title: String,
    description: Option<String>,
    trust_status: String,
    instructions_path: String,
    instructions: String,
    references: Vec<ResolvedProjectSkillReference>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct ResolvedProjectSkillReference {
    path: String,
    content: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProjectSkillDiscoverySummary {
    pub project_root: String,
    pub trust_status: String,
    pub skills: Vec<ProjectSkillSummary>,
    pub discovery_error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProjectSkillSummary {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub trust_status: String,
    pub instructions_path: String,
    pub references: Vec<String>,
}

#[derive(Default)]
pub struct AgentWorkspaceLane {
    #[cfg(test)]
    gate: Mutex<()>,
    state: StdMutex<AgentWorkspaceLaneState>,
}

#[derive(Default)]
struct AgentWorkspaceLaneState {
    active: Option<AgentWorkspaceExecution>,
    cancelled_turns: HashSet<String>,
}

#[derive(Clone)]
struct AgentWorkspaceExecution {
    turn_id: String,
    run_id: String,
}

#[cfg(test)]
struct AgentWorkspaceExecutionGuard<'a> {
    lane: &'a AgentWorkspaceLane,
    turn_id: String,
}

impl AgentWorkspaceLane {
    pub fn cancel_turn(&self, turn_id: &str) -> Option<String> {
        let mut state = self
            .state
            .lock()
            .expect("Agent Workspace lane state poisoned");
        state.cancelled_turns.insert(turn_id.to_string());
        state
            .active
            .as_ref()
            .filter(|active| active.turn_id == turn_id)
            .map(|active| active.run_id.clone())
    }

    pub fn clear_turn_cancellation(&self, turn_id: &str) {
        self.state
            .lock()
            .expect("Agent Workspace lane state poisoned")
            .cancelled_turns
            .remove(turn_id);
    }

    #[cfg(test)]
    fn begin_execution<'a>(
        &'a self,
        turn_id: &str,
        run_id: &str,
    ) -> Result<AgentWorkspaceExecutionGuard<'a>> {
        let mut state = self
            .state
            .lock()
            .expect("Agent Workspace lane state poisoned");
        ensure!(
            !state.cancelled_turns.contains(turn_id),
            "Agent turn was cancelled before Workspace R admission"
        );
        debug_assert!(state.active.is_none());
        state.active = Some(AgentWorkspaceExecution {
            turn_id: turn_id.to_string(),
            run_id: run_id.to_string(),
        });
        Ok(AgentWorkspaceExecutionGuard {
            lane: self,
            turn_id: turn_id.to_string(),
        })
    }
}

#[cfg(test)]
impl Drop for AgentWorkspaceExecutionGuard<'_> {
    fn drop(&mut self) {
        let mut state = self
            .lane
            .state
            .lock()
            .expect("Agent Workspace lane state poisoned");
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.turn_id == self.turn_id)
        {
            state.active = None;
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApprovalResponseInput {
    pub decision: String,
    pub reason: Option<String>,
}

#[derive(Default)]
pub struct PendingApprovalRegistry {
    waiters: Mutex<std::collections::HashMap<String, PendingApprovalWaiter>>,
}

struct PendingApprovalWaiter {
    turn_id: Option<String>,
    sender: oneshot::Sender<ApprovalResponseInput>,
}

impl PendingApprovalRegistry {
    pub async fn is_empty(&self) -> bool {
        self.waiters.lock().await.is_empty()
    }

    pub async fn count(&self) -> usize {
        self.waiters.lock().await.len()
    }

    pub async fn register(
        &self,
        request_id: String,
        turn_id: Option<String>,
    ) -> oneshot::Receiver<ApprovalResponseInput> {
        let (sender, receiver) = oneshot::channel();
        self.waiters
            .lock()
            .await
            .insert(request_id, PendingApprovalWaiter { turn_id, sender });
        receiver
    }

    pub async fn respond(&self, request_id: &str, decision: ApprovalResponseInput) -> bool {
        let waiter = self.waiters.lock().await.remove(request_id);
        waiter.is_some_and(|waiter| waiter.sender.send(decision).is_ok())
    }

    pub async fn respond_for_turn(
        &self,
        request_id: &str,
        turn_id: Option<&str>,
        decision: ApprovalResponseInput,
    ) -> bool {
        let waiter = {
            let mut waiters = self.waiters.lock().await;
            if waiters
                .get(request_id)
                .is_some_and(|waiter| waiter.turn_id.as_deref() == turn_id)
            {
                waiters.remove(request_id)
            } else {
                None
            }
        };
        waiter.is_some_and(|waiter| waiter.sender.send(decision).is_ok())
    }

    pub async fn remove(&self, request_id: &str) {
        self.waiters.lock().await.remove(request_id);
    }

    pub async fn cancel_all(&self, reason: impl Into<String>) -> usize {
        let reason = reason.into();
        let waiters = {
            let mut waiters = self.waiters.lock().await;
            std::mem::take(&mut *waiters)
        };
        let count = waiters.len();
        for (_, waiter) in waiters {
            let _ = waiter.sender.send(ApprovalResponseInput {
                decision: "cancel".to_string(),
                reason: Some(reason.clone()),
            });
        }
        count
    }

    pub async fn cancel_turn(&self, turn_id: &str, reason: impl Into<String>) -> usize {
        let reason = reason.into();
        let cancelled = {
            let mut waiters = self.waiters.lock().await;
            let all = std::mem::take(&mut *waiters);
            let (cancelled, retained): (
                std::collections::HashMap<_, _>,
                std::collections::HashMap<_, _>,
            ) = all
                .into_iter()
                .partition(|(_, waiter)| waiter.turn_id.as_deref() == Some(turn_id));
            *waiters = retained;
            cancelled
        };
        let count = cancelled.len();
        for (_, waiter) in cancelled {
            let _ = waiter.sender.send(ApprovalResponseInput {
                decision: "cancel".to_string(),
                reason: Some(reason.clone()),
            });
        }
        count
    }
}
