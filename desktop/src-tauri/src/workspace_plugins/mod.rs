//! Trusted application coordination for project-local workspace plugins.
//!
//! P2-2B owns discovery projection, explicit enable requests, the dedicated
//! permission lane, and fresh in-memory handles. It intentionally exposes no
//! filesystem, network, Workspace R, contribution, install, or update call.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result, anyhow, bail, ensure};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rho_extension_runtime::{
    ActivationGeneration, BrokerCallIdSource, CapabilityHandle, ContributionCallOutcome,
    ContributionCallRequest, ContributionCallSession, ContributionCandidate,
    ContributionInstanceIdentity, ContributionInvocationOrigin, ContributionKind,
    ContributionStore, DiscoveredPlugin, GrantErrorKind, GrantRequest, GrantSource, GrantStore,
    GuestStep, HOST_PROTOCOL_VERSION, HostFrame, HostInstanceId, HostInstanceState, HostMessage,
    HostRequestId, HostResponse, MAX_WASM_MODULE_BYTES, OsBrokerCallIdSource,
    PermissionConstraints, PermissionKind, PermissionUse, PluginCommandResultV1, PluginId,
    Revalidation, RevalidationRequest, RuntimeKind, SystemContributionClock, ViewerDocumentV1,
    WasmHostIdentity, WasmPluginHost, WorkspaceGrantIdentity, discover_workspace_plugins,
};
use rho_server::coordinator::{AgentPluginContextItem, AgentPluginToolDefinition};
use rho_server::plugin_fs::{ProjectFsReadErrorCode, ProjectFsReadRequest, read_project_file};
use rho_server::plugin_network::{
    NetworkAuthorizer, NetworkFetchEngine, NetworkFetchError, NetworkFetchErrorCode,
    NetworkFetchPolicy, NetworkFetchRequest, NetworkHopAuthorization,
    network_request_authorization,
};
use rho_server::plugin_package_cache::{CachedPluginPackage, PluginPackageCache};
use rho_server::plugin_package_trash::{PluginPackageOwnershipOutcome, PluginPackageTrash};
use rho_server::plugin_retention::PluginTrashRetentionService;
use rho_server::plugin_workspace::{
    WorkspaceInspectErrorCode, WorkspaceInspectOperation, WorkspaceInspectRequest,
    WorkspaceInspectionContext, WorkspaceObjectReferenceRegistry, WorkspaceObjectReferenceView,
};
use rho_store::{
    PluginLifecycleMutationOutcome, PluginLifecycleMutationService, PluginLifecycleQueryService,
    PluginPermissionCallEventDraft, PluginPermissionDecision, PluginPermissionDecisionDraft,
    PluginPermissionGrant, PluginPermissionMutationOutcome, PluginPermissionMutationService,
    PluginPermissionQueryService, PluginPermissionRequest, PluginPermissionRequestDraft, Store,
    WorkspacePluginCrashOutcome, WorkspacePluginDiscoveredDraft, WorkspacePluginState,
    WorkspacePluginTombstoneDraft, WorkspacePluginTransitionAdvance,
    WorkspacePluginTransitionDraft, normalize_project_root,
};
use sha2::{Digest, Sha256};

const POLICY_REVISION: i64 = 1;
const MAX_PLUGIN_SKILL_BYTES: usize = 64 * 1024;
const MAX_PLUGIN_SKILL_PACK_BYTES: usize = 256 * 1024;
const MAX_AGENT_PLUGIN_TOOL_PROFILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_AGENT_PLUGIN_CONTEXT_PROFILE_BYTES: usize = 512 * 1024;
const MAX_PLUGIN_RECONCILIATION_ENTRIES: usize = 256;

mod activation;
mod activation_helpers;
mod broker_helpers;
mod contracts;
mod contributions;
mod discovery;
mod lifecycle;
mod permissions;
mod projection_helpers;
mod recovery_helpers;
mod runtime_calls;
mod upgrade;
mod workspace_dispatch;

use activation_helpers::*;
use broker_helpers::*;
pub(crate) use contracts::*;
use projection_helpers::{
    agent_plugin_tool_name, contribution_kind_name, discover_exact_plugin,
    missing_workspace_plugin_view, plugin_view, push_agent_plugin_context, read_plugin_skill,
    registry_key, validate_agent_tool_schema, validate_command_result_artifacts,
    validate_viewer_artifacts,
};
pub(crate) use projection_helpers::{validate_surface_artifacts, validate_surface_command_result};
use recovery_helpers::*;
pub(crate) use workspace_dispatch::*;

#[derive(Clone)]
struct PendingEnable {
    kind: PendingActivationKind,
    plugin_id: String,
    plugin_version: String,
    package_digest: String,
    transition_id: String,
    request_ids: Vec<String>,
    expected_project_revision: i64,
}

#[derive(Clone)]
enum PendingActivationKind {
    Enable,
    Retry,
    Upgrade { expected_old_digest: String },
    Rollback { expected_old_digest: String },
}

struct ActivePlugin {
    project_root: String,
    plugin_version: String,
    package_digest: String,
    host_instance_id: HostInstanceId,
    host: WasmPluginHost,
    handles: BTreeMap<String, CapabilityHandle>,
    permission_count: usize,
    contribution_identity: Option<ContributionInstanceIdentity>,
    skill_instructions: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
struct ActiveCrashIdentity {
    plugin_id: String,
    package_digest: String,
    host_instance_id: HostInstanceId,
}

struct RegistryState {
    pending: BTreeMap<String, PendingEnable>,
    active: BTreeMap<String, ActivePlugin>,
    contributions: ContributionStore,
    grants: GrantStore,
    broker_call_id_source: Arc<dyn BrokerCallIdSource>,
    workspace_objects: WorkspaceObjectReferenceRegistry,
    network_engine: Arc<NetworkFetchEngine>,
}

impl Default for RegistryState {
    fn default() -> Self {
        Self {
            pending: BTreeMap::new(),
            active: BTreeMap::new(),
            contributions: ContributionStore::new(),
            grants: GrantStore::new(),
            broker_call_id_source: Arc::new(OsBrokerCallIdSource),
            workspace_objects: WorkspaceObjectReferenceRegistry::new(),
            network_engine: Arc::new(NetworkFetchEngine::new()),
        }
    }
}

#[derive(Default)]
pub(crate) struct PendingPluginPermissionRegistry {
    state: Mutex<RegistryState>,
}

struct LiveNetworkAuthorizer<'a> {
    registry: &'a PendingPluginPermissionRegistry,
    key: &'a str,
    template: RevalidationRequest,
}

impl NetworkAuthorizer for LiveNetworkAuthorizer<'_> {
    fn authorize(&self, hop: &NetworkHopAuthorization) -> Result<(), NetworkFetchError> {
        let state = self
            .registry
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let session_current = state.active.get(self.key).is_some_and(|active| {
            active.host.identity().host_instance_id() == &self.template.host_instance_id
        });
        let mut request = self.template.clone();
        request.permission_use = PermissionUse::NetworkFetch {
            scheme: hop.scheme.clone(),
            host: hop.host.clone(),
            method: hop.method.clone(),
            requested_response_bytes: hop.requested_response_bytes,
        };
        if session_current && state.grants.revalidate_admitted(&request) == Revalidation::Allowed {
            Ok(())
        } else {
            Err(NetworkFetchError::new(
                NetworkFetchErrorCode::AuthorizationDenied,
            ))
        }
    }
}

impl PendingPluginPermissionRegistry {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

#[cfg(test)]
mod tests;
