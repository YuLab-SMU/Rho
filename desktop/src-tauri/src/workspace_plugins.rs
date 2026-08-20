//! Trusted application coordination for project-local workspace plugins.
//!
//! P2-2B owns discovery projection, explicit enable requests, the dedicated
//! permission lane, and fresh in-memory handles. It intentionally exposes no
//! filesystem, network, Workspace R, contribution, install, or update call.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{Context, Result, anyhow, bail, ensure};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rho_core::ExecutionOrigin;
use rho_extension_runtime::{
    ActivationGeneration, BrokerCallIdSource, CapabilityHandle, DiscoveredPlugin, GrantErrorKind,
    GrantRequest, GrantSource, GrantStore, GuestStep, HOST_PROTOCOL_VERSION, HostFrame,
    HostInstanceId, HostMessage, HostRequestId, HostResponse, MAX_WASM_MODULE_BYTES,
    OsBrokerCallIdSource, PermissionConstraints, PermissionKind, PermissionUse, PluginId,
    Revalidation, RevalidationRequest, RuntimeKind, ScopeId, WasmHostIdentity, WasmPluginHost,
    WorkspaceGrantIdentity, discover_workspace_plugins,
};
use rho_kernel::ArkSession;
use rho_server::coordinator::{CoordinatorRuntime, dispatch_workspace_request};
use rho_server::plugin_fs::{ProjectFsReadErrorCode, ProjectFsReadRequest, read_project_file};
use rho_server::plugin_network::{
    NetworkAuthorizer, NetworkFetchEngine, NetworkFetchError, NetworkFetchErrorCode,
    NetworkFetchPolicy, NetworkFetchRequest, NetworkHopAuthorization,
    network_request_authorization,
};
use rho_server::plugin_workspace::{
    PreparedWorkspaceInspection, WorkspaceInspectErrorCode, WorkspaceInspectOperation,
    WorkspaceInspectRequest, WorkspaceInspectionContext, WorkspaceObjectReferenceRegistry,
    WorkspaceObjectReferenceView,
};
use rho_store::{
    PluginPermissionCallEventDraft, PluginPermissionDecision, PluginPermissionDecisionDraft,
    PluginPermissionGrant, PluginPermissionMutationOutcome, PluginPermissionMutationService,
    PluginPermissionQueryService, PluginPermissionRequest, PluginPermissionRequestDraft, Store,
    normalize_project_root,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

const POLICY_REVISION: i64 = 1;

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
    pub name: String,
    pub version: String,
    pub package_digest: String,
    pub short_digest: String,
    pub runtime_kind: String,
    pub permission_count: usize,
    pub pending_request_count: usize,
    pub active_grant_count: usize,
    pub status: String,
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
    pub message: String,
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
    pub project_root: String,
    pub project_revision: i64,
    pub project_scope_id: ScopeId,
    pub workspace: Option<WorkspaceGrantIdentity>,
}

pub(crate) struct WorkspaceDispatchResult {
    pub response: serde_json::Value,
    pub current_workspace: rho_protocol::WorkspaceIdentity,
}

pub(crate) trait WorkspacePluginDispatcher: Send + Sync {
    fn dispatch<'a>(
        &'a self,
        prepared: PreparedWorkspaceInspection,
    ) -> Pin<Box<dyn Future<Output = Result<WorkspaceDispatchResult>> + Send + 'a>>;
}

#[allow(dead_code)]
pub(crate) struct CoordinatorWorkspacePluginDispatcher {
    pub session: Arc<ArkSession>,
    pub context: Arc<AsyncMutex<CoordinatorRuntime>>,
}

impl WorkspacePluginDispatcher for CoordinatorWorkspacePluginDispatcher {
    fn dispatch<'a>(
        &'a self,
        prepared: PreparedWorkspaceInspection,
    ) -> Pin<Box<dyn Future<Output = Result<WorkspaceDispatchResult>> + Send + 'a>> {
        Box::pin(async move {
            let payload = serde_json::json!({
                "arguments": prepared.arguments,
                "expected_workspace": prepared.expected_workspace,
            });
            let mut context = self.context.lock().await;
            let CoordinatorRuntime { broker, store } = &mut *context;
            let response = dispatch_workspace_request(
                prepared.request_type,
                &payload,
                ExecutionOrigin::System,
                self.session.as_ref(),
                broker,
                store,
            )
            .await?;
            Ok(WorkspaceDispatchResult {
                response,
                current_workspace: broker.identity().clone(),
            })
        })
    }
}

#[derive(Clone)]
struct PendingEnable {
    plugin_id: String,
    plugin_version: String,
    package_digest: String,
    request_ids: Vec<String>,
    expected_project_revision: i64,
}

struct ActivePlugin {
    project_root: String,
    plugin_version: String,
    package_digest: String,
    host_instance_id: HostInstanceId,
    host: WasmPluginHost,
    handles: BTreeMap<String, CapabilityHandle>,
}

struct RegistryState {
    next_generation: u64,
    pending: BTreeMap<String, PendingEnable>,
    active: BTreeMap<String, ActivePlugin>,
    grants: GrantStore,
    broker_call_id_source: Arc<dyn BrokerCallIdSource>,
    workspace_objects: WorkspaceObjectReferenceRegistry,
    network_engine: Arc<NetworkFetchEngine>,
}

impl Default for RegistryState {
    fn default() -> Self {
        Self {
            next_generation: 1,
            pending: BTreeMap::new(),
            active: BTreeMap::new(),
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

    pub(crate) fn list(
        &self,
        context: &PluginRuntimeContext,
        store: &Store,
    ) -> Result<WorkspacePluginList> {
        let report = discover_workspace_plugins(Path::new(&context.project_root))?;
        let requests = PluginPermissionQueryService::new(store).list_requests(
            &context.project_root,
            Some(100),
            None,
        )?;
        let grants = PluginPermissionQueryService::new(store).list_grants(
            &context.project_root,
            Some(100),
            None,
        )?;
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(report) = report else {
            return Ok(WorkspacePluginList {
                project_root: context.project_root.clone(),
                project_revision: context.project_revision,
                status: "none_discovered".to_string(),
                plugins: Vec::new(),
                failures: Vec::new(),
            });
        };

        let plugins = report
            .plugins
            .iter()
            .map(|plugin| plugin_view(&context.project_root, plugin, &requests, &grants, &state))
            .collect();
        Ok(WorkspacePluginList {
            project_root: context.project_root.clone(),
            project_revision: context.project_revision,
            status: if report.plugins.is_empty() {
                "none_discovered"
            } else {
                "ready"
            }
            .to_string(),
            plugins,
            failures: report
                .failures
                .into_iter()
                .map(|failure| WorkspacePluginFailureView {
                    path: failure.path,
                    reason: failure.reason,
                })
                .collect(),
        })
    }

    pub(crate) fn request_enable(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        store: &mut Store,
    ) -> Result<WorkspacePluginEnableResult> {
        ensure!(
            context.project_revision >= 0,
            "plugin enable requires a current project revision"
        );
        let plugin = discover_exact_plugin(Path::new(&context.project_root), plugin_id)?;
        ensure!(
            plugin.manifest.runtime.kind == RuntimeKind::Wasm,
            "only Wasm workspace plugins are executable in Phase 2"
        );
        let key = registry_key(&context.project_root, plugin_id);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        if let Some(active) = state.active.get(&key)
            && active.package_digest == plugin.digest.as_str()
            && active.plugin_version == plugin.manifest.version.to_string()
        {
            return Ok(WorkspacePluginEnableResult {
                status: "enabled".to_string(),
                plugin_id: plugin_id.to_string(),
                request_ids: Vec::new(),
                active_grant_count: active.handles.len(),
                message: "The exact plugin package is already enabled.".to_string(),
            });
        }
        if let Some(pending) = state.pending.get(&key)
            && pending.package_digest == plugin.digest.as_str()
            && pending.plugin_version == plugin.manifest.version.to_string()
            && pending.expected_project_revision == context.project_revision
        {
            return Ok(WorkspacePluginEnableResult {
                status: "permission_required".to_string(),
                plugin_id: plugin_id.to_string(),
                request_ids: pending.request_ids.clone(),
                active_grant_count: 0,
                message: "Review the requested permissions before this plugin can start."
                    .to_string(),
            });
        }

        if let Some(previous) = state.active.remove(&key) {
            state.grants.invalidate_host(&previous.host_instance_id);
        }
        state.pending.remove(&key);

        let durable_grants = matching_project_grants(store, context, &plugin)?;
        let mut requests = Vec::new();
        let mut reusable_grants = BTreeMap::new();
        for permission in &plugin.manifest.permissions {
            let constraints = PermissionConstraints::from_manifest(permission)?;
            let constraints_digest = constraints.digest()?;
            if let Some(grant) = durable_grants.get(&(permission.name.clone(), constraints_digest))
            {
                reusable_grants.insert(permission.name.clone(), grant.clone());
                continue;
            }
            requests.push(PluginPermissionRequestDraft {
                request_id: format!("request.{}", uuid::Uuid::new_v4().simple()),
                project_root: context.project_root.clone(),
                plugin_id: plugin.manifest.id.to_string(),
                plugin_version: plugin.manifest.version.to_string(),
                package_digest: plugin.digest.to_string(),
                runtime_kind: plugin.manifest.runtime.kind.to_string(),
                permission: permission.name.clone(),
                constraints_json: constraints.canonical_json()?,
                constraints_digest: constraints.digest()?,
                purpose_text: permission.purpose.clone(),
                expected_project_revision: context.project_revision,
            });
        }

        if !requests.is_empty() {
            let created = PluginPermissionMutationService::new(store)
                .create_requests(&context.project_root, &requests)?;
            let request_ids = created
                .into_iter()
                .map(|request| request.request_id)
                .collect::<Vec<_>>();
            state.pending.insert(
                key,
                PendingEnable {
                    plugin_id: plugin_id.to_string(),
                    plugin_version: plugin.manifest.version.to_string(),
                    package_digest: plugin.digest.to_string(),
                    request_ids: request_ids.clone(),
                    expected_project_revision: context.project_revision,
                },
            );
            return Ok(WorkspacePluginEnableResult {
                status: "permission_required".to_string(),
                plugin_id: plugin_id.to_string(),
                request_ids,
                active_grant_count: reusable_grants.len(),
                message: "Review the requested permissions before this plugin can start."
                    .to_string(),
            });
        }

        activate_plugin(
            &mut state,
            context,
            &plugin,
            reusable_grants.values(),
            store,
        )
    }

    pub(crate) fn respond(
        &self,
        context: &PluginRuntimeContext,
        input: PluginPermissionDecisionInput,
        store: &mut Store,
    ) -> Result<PluginPermissionDecisionResult> {
        ensure!(
            input.expected_project_revision == context.project_revision,
            "plugin permission response is stale for the current project revision"
        );
        let request = PluginPermissionQueryService::new(store)
            .get_request(&context.project_root, &input.request_id)?
            .context("plugin permission request was not found in the current project")?;
        ensure!(
            request.expected_project_revision == context.project_revision,
            "plugin permission request belongs to a stale project revision"
        );
        let decision = match input.decision.as_str() {
            "deny" => PluginPermissionDecision::Deny,
            "allow_once" => PluginPermissionDecision::AllowOnce,
            "allow_project" => PluginPermissionDecision::AllowProject,
            _ => bail!("unsupported plugin permission decision"),
        };
        let (grant_id, policy_revision, expires_at) = match decision {
            PluginPermissionDecision::Deny => (None, None, None),
            PluginPermissionDecision::AllowOnce => (
                Some(format!("grant.{}", uuid::Uuid::new_v4().simple())),
                Some(POLICY_REVISION),
                Some((Utc::now() + ChronoDuration::minutes(5)).to_rfc3339()),
            ),
            PluginPermissionDecision::AllowProject => (
                Some(format!("grant.{}", uuid::Uuid::new_v4().simple())),
                Some(POLICY_REVISION),
                Some((Utc::now() + ChronoDuration::days(30)).to_rfc3339()),
            ),
        };
        let outcome = PluginPermissionMutationService::new(store).resolve_request(
            &context.project_root,
            &PluginPermissionDecisionDraft {
                request_id: input.request_id.clone(),
                project_root: context.project_root.clone(),
                expected_project_revision: input.expected_project_revision,
                decision,
                reason_code: (decision == PluginPermissionDecision::Deny)
                    .then(|| "user_denied".to_string()),
                grant_id,
                policy_revision,
                expires_at,
            },
        )?;
        ensure!(
            matches!(
                outcome,
                PluginPermissionMutationOutcome::Applied
                    | PluginPermissionMutationOutcome::Unchanged
            ),
            "plugin permission response was rejected as stale"
        );
        let resolved = PluginPermissionQueryService::new(store)
            .get_request(&context.project_root, &input.request_id)?
            .context("resolved plugin permission request disappeared")?;

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (plugin_status, active_grant_count, message) = match try_activate_pending(
            &mut state,
            context,
            &request.plugin_id,
            store,
        ) {
            Ok((status, count)) => (status, count, None),
            Err(error) => {
                let changed = error
                    .to_string()
                    .contains("package changed while permission review was open");
                state
                    .pending
                    .remove(&registry_key(&context.project_root, &request.plugin_id));
                (
                        if changed {
                            "stale_digest"
                        } else {
                            "host_unavailable"
                        }
                        .to_string(),
                        0,
                        Some(
                            if changed {
                                "The package changed after review. The recorded decision cannot authorize the new package; enable it again to review the new digest."
                            } else {
                                "The decision was saved, but the isolated plugin host did not start. No live handle is available."
                            }
                            .to_string(),
                        ),
                    )
            }
        };
        Ok(PluginPermissionDecisionResult {
            outcome,
            request: resolved,
            plugin_status,
            active_grant_count,
            message,
        })
    }

    pub(crate) fn list_grants(
        &self,
        context: &PluginRuntimeContext,
        store: &Store,
    ) -> Result<PluginGrantList> {
        let grants = PluginPermissionQueryService::new(store).list_grants(
            &context.project_root,
            Some(100),
            None,
        )?;
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(PluginGrantList {
            project_root: context.project_root.clone(),
            grants: grants
                .into_iter()
                .map(|grant| grant_view(grant, &state.grants))
                .collect::<Result<Vec<_>>>()?,
        })
    }

    pub(crate) fn revoke(
        &self,
        context: &PluginRuntimeContext,
        grant_id: &str,
        store: &mut Store,
    ) -> Result<PluginGrantRevokeResult> {
        let outcome = PluginPermissionMutationService::new(store).revoke_grant(
            &context.project_root,
            grant_id,
            "user_revoked",
        )?;
        ensure!(
            outcome != PluginPermissionMutationOutcome::Stale,
            "plugin grant revoke was rejected as stale"
        );
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let live_handle_revoked = state.grants.revoke_durable_grant(grant_id);
        for active in state.active.values_mut() {
            active.handles.remove(grant_id);
        }
        Ok(PluginGrantRevokeResult {
            outcome,
            grant_id: grant_id.to_string(),
            live_handle_revoked,
        })
    }

    #[allow(dead_code)]
    pub(crate) fn issue_workspace_object_references(
        &self,
        context: &PluginRuntimeContext,
        snapshot_response: &serde_json::Value,
    ) -> Result<Vec<WorkspaceObjectReferenceView>> {
        let workspace_context = workspace_inspection_context(context)?;
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .workspace_objects
            .issue_from_snapshot(&workspace_context, snapshot_response)
            .map_err(Into::into)
    }

    #[allow(dead_code)]
    pub(crate) async fn invoke_network_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store_path: &Path,
    ) -> Result<WorkspacePluginCallResult> {
        let key = registry_key(&context.project_root, plugin_id);
        let request_id = HostRequestId::generate();
        let mut step = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let active = state
                .active
                .get_mut(&key)
                .context("workspace plugin is not enabled for this project")?;
            ensure!(
                !active.host.broker_call_active(),
                "workspace plugin already has an active broker call"
            );
            let handles = active
                .handles
                .values()
                .map(|handle| (handle.permission.as_static_str(), handle.id.clone()))
                .collect::<BTreeMap<_, _>>();
            active
                .host
                .begin_broker_call(
                    request_id.clone(),
                    serde_json::json!({
                        "request": request,
                        "capability_handles": handles,
                    }),
                )
                .map_err(|error| anyhow!("workspace plugin broker begin failed: {error:?}"))?
        };
        let mut broker_steps = 0;
        loop {
            match step {
                GuestStep::Complete { result, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "completed".to_string(),
                        result: Some(result),
                        error_code: None,
                        broker_steps,
                    });
                }
                GuestStep::Error { code, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "failed".to_string(),
                        result: None,
                        error_code: Some(code),
                        broker_steps,
                    });
                }
                GuestStep::BrokerRequest {
                    handle_id,
                    permission,
                    operation,
                    args,
                    ..
                } => {
                    broker_steps += 1;
                    if permission != "network.fetch" || operation != "network.fetch" {
                        step =
                            self.resume_plugin_error(&key, &request_id, "operation_not_available")?;
                        continue;
                    }
                    let fetch_request: NetworkFetchRequest = match serde_json::from_value(args) {
                        Ok(request) => request,
                        Err(_) => {
                            step =
                                self.resume_plugin_error(&key, &request_id, "invalid_arguments")?;
                            continue;
                        }
                    };
                    let (
                        revalidation,
                        grant_id,
                        plugin_identity_id,
                        package_digest,
                        policy,
                        network_engine,
                    ) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let active = state
                            .active
                            .get(&key)
                            .context("workspace plugin was disabled before call admission")?;
                        let identity = active.host.identity().clone();
                        let setup = (|| {
                            let constraints = state
                                .grants
                                .permission_constraints_for_handle(&handle_id)
                                .ok_or("unknown_handle")?;
                            let policy = NetworkFetchPolicy {
                                allowed_hosts: constraints.hosts,
                                allowed_methods: constraints.methods,
                                max_response_bytes: constraints
                                    .max_response_bytes
                                    .ok_or("invalid_grant")?,
                                current_project_revision: u64::try_from(context.project_revision)
                                    .map_err(|_| "stale_project")?,
                            };
                            let initial = network_request_authorization(&fetch_request, &policy)
                                .map_err(|error| network_error_code(error.code))?;
                            Ok::<_, &'static str>((policy, initial))
                        })();
                        let (policy, initial) = match setup {
                            Ok(setup) => setup,
                            Err(code) => {
                                drop(state);
                                let mut store = Store::open(store_path)?;
                                if let Err(persistence_error) = record_call_event(
                                    &mut store,
                                    context,
                                    identity.plugin_id().as_str(),
                                    identity.package_digest().as_str(),
                                    None,
                                    "call_denied",
                                    "failed",
                                    Some(code),
                                    serde_json::json!({"operation": "network.fetch"}),
                                    false,
                                ) {
                                    self.cancel_plugin_call(&key, &request_id);
                                    return Err(persistence_error);
                                }
                                step = self.resume_plugin_error(&key, &request_id, code)?;
                                continue;
                            }
                        };
                        let revalidation = RevalidationRequest {
                            handle_id: handle_id.clone(),
                            plugin_id: identity.plugin_id().clone(),
                            host_instance_id: identity.host_instance_id().clone(),
                            package_digest: identity.package_digest().clone(),
                            project_id: identity.project_id().clone(),
                            scope_id: identity.project_id().clone(),
                            generation: identity.activation_generation(),
                            permission: PermissionKind::NetworkFetch,
                            permission_use: PermissionUse::NetworkFetch {
                                scheme: initial.scheme,
                                host: initial.host,
                                method: initial.method,
                                requested_response_bytes: initial.requested_response_bytes,
                            },
                            workspace: None,
                        };
                        let admitted = state.grants.revalidate(revalidation.clone());
                        if let Revalidation::Denied(error) = admitted {
                            drop(state);
                            let mut store = Store::open(store_path)?;
                            if let Err(persistence_error) = record_call_event(
                                &mut store,
                                context,
                                identity.plugin_id().as_str(),
                                identity.package_digest().as_str(),
                                None,
                                "call_denied",
                                "failed",
                                Some(grant_error_code(error)),
                                serde_json::json!({"operation": "network.fetch"}),
                                false,
                            ) {
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            step = self.resume_plugin_error(
                                &key,
                                &request_id,
                                grant_error_code(error),
                            )?;
                            continue;
                        }
                        let grant_id = state
                            .grants
                            .durable_grant_id_for_handle(&handle_id)
                            .context("admitted network handle has no durable grant identity")?
                            .to_string();
                        (
                            revalidation,
                            grant_id,
                            identity.plugin_id().to_string(),
                            identity.package_digest().to_string(),
                            policy,
                            Arc::clone(&state.network_engine),
                        )
                    };
                    {
                        let mut store = Store::open(store_path)?;
                        if let Err(error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            Some(&grant_id),
                            "call_admitted",
                            "completed",
                            None,
                            serde_json::json!({"operation": "network.fetch"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(error);
                        }
                    }
                    let authorizer = LiveNetworkAuthorizer {
                        registry: self,
                        key: &key,
                        template: revalidation.clone(),
                    };
                    let started = Instant::now();
                    let fetched = network_engine
                        .fetch(&fetch_request, &policy, &authorizer)
                        .await;
                    let fetched = match fetched {
                        Ok(result) => result,
                        Err(error) => {
                            let code = network_error_code(error.code);
                            let authorization_stale =
                                error.code == NetworkFetchErrorCode::AuthorizationDenied;
                            let mut store = Store::open(store_path)?;
                            let persisted = if authorization_stale {
                                record_call_event(
                                    &mut store,
                                    context,
                                    &plugin_identity_id,
                                    &package_digest,
                                    None,
                                    "call_denied",
                                    "stale",
                                    Some(code),
                                    serde_json::json!({"operation": "network.fetch"}),
                                    false,
                                )
                            } else if error.completion_uncertain {
                                record_call_event(
                                    &mut store,
                                    context,
                                    &plugin_identity_id,
                                    &package_digest,
                                    Some(&grant_id),
                                    "completion_uncertain",
                                    "failed",
                                    Some(code),
                                    serde_json::json!({"operation": "network.fetch"}),
                                    true,
                                )
                            } else {
                                record_call_event(
                                    &mut store,
                                    context,
                                    &plugin_identity_id,
                                    &package_digest,
                                    Some(&grant_id),
                                    "call_failed",
                                    "failed",
                                    Some(code),
                                    serde_json::json!({"operation": "network.fetch"}),
                                    false,
                                )
                            };
                            if authorization_stale {
                                self.release_plugin_admission(&handle_id);
                            } else if error.completion_uncertain {
                                self.complete_plugin_uncertain(&handle_id);
                            } else {
                                self.release_plugin_admission(&handle_id);
                            }
                            if let Err(persistence_error) = persisted {
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            step = self.resume_plugin_error(&key, &request_id, code)?;
                            continue;
                        }
                    };
                    let final_admitted = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.grants.revalidate_admitted(&revalidation) == Revalidation::Allowed
                    };
                    if !final_admitted {
                        let mut store = Store::open(store_path)?;
                        if let Err(persistence_error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "stale",
                            Some("stale_after_dispatch"),
                            serde_json::json!({"operation": "network.fetch"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(persistence_error);
                        }
                        self.release_plugin_admission(&handle_id);
                        step =
                            self.resume_plugin_error(&key, &request_id, "stale_after_dispatch")?;
                        continue;
                    }
                    {
                        let mut store = Store::open(store_path)?;
                        if let Err(error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            Some(&grant_id),
                            "call_completed",
                            "completed",
                            None,
                            serde_json::json!({
                                "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                "operation": "network.fetch",
                                "redirectCount": fetched.redirect_count,
                                "sizeBytes": fetched.size_bytes,
                                "statusCode": fetched.status
                            }),
                            true,
                        ) {
                            self.complete_plugin_uncertain(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(error);
                        }
                    }
                    let fetched_bytes = fetched.size_bytes as usize;
                    let fetched = serde_json::to_value(fetched)?;
                    let resume_result = (|| -> Result<GuestStep> {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        ensure!(
                            state.grants.revalidate_admitted(&revalidation)
                                == Revalidation::Allowed,
                            "network grant became stale after durable completion"
                        );
                        state.grants.complete_success(&handle_id);
                        state
                            .active
                            .get_mut(&key)
                            .context(
                                "workspace plugin was disabled before network result delivery",
                            )?
                            .host
                            .resume_broker_call(
                                &request_id,
                                &serde_json::json!({"ok": true, "value": fetched}),
                                fetched_bytes,
                            )
                            .map_err(|error| anyhow!("network plugin resume failed: {error:?}"))
                    })();
                    step = match resume_result {
                        Ok(step) => step,
                        Err(error) => {
                            let mut state = self
                                .state
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if let Some(active) = state.active.remove(&key) {
                                state.grants.invalidate_host(&active.host_instance_id);
                            }
                            drop(state);
                            let mut store = Store::open(store_path)?;
                            record_call_event(
                                &mut store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                None,
                                "call_failed",
                                "failed",
                                Some("completion_delivery_failed"),
                                serde_json::json!({"operation": "network.fetch"}),
                                false,
                            )?;
                            return Err(error);
                        }
                    };
                }
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn invoke_workspace_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store_path: &Path,
        dispatcher: &dyn WorkspacePluginDispatcher,
    ) -> Result<WorkspacePluginCallResult> {
        let key = registry_key(&context.project_root, plugin_id);
        let request_id = HostRequestId::generate();
        let workspace_context = workspace_inspection_context(context)?;
        let mut step = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let references = state.workspace_objects.list_for_context(&workspace_context);
            let active = state
                .active
                .get_mut(&key)
                .context("workspace plugin is not enabled for this project")?;
            ensure!(
                !active.host.broker_call_active(),
                "workspace plugin already has an active broker call"
            );
            let handles = active
                .handles
                .values()
                .map(|handle| (handle.permission.as_static_str(), handle.id.clone()))
                .collect::<BTreeMap<_, _>>();
            active
                .host
                .begin_broker_call(
                    request_id.clone(),
                    serde_json::json!({
                        "request": request,
                        "capability_handles": handles,
                        "workspace_object_references": references,
                    }),
                )
                .map_err(|error| anyhow!("workspace plugin broker begin failed: {error:?}"))?
        };
        let mut broker_steps = 0;
        loop {
            match step {
                GuestStep::Complete { result, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "completed".to_string(),
                        result: Some(result),
                        error_code: None,
                        broker_steps,
                    });
                }
                GuestStep::Error { code, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "failed".to_string(),
                        result: None,
                        error_code: Some(code),
                        broker_steps,
                    });
                }
                GuestStep::BrokerRequest {
                    handle_id,
                    permission,
                    operation,
                    args,
                    ..
                } => {
                    broker_steps += 1;
                    if permission != "workspace.r.inspect" || operation != "workspace.r.inspect" {
                        step =
                            self.resume_plugin_error(&key, &request_id, "operation_not_available")?;
                        continue;
                    }
                    let inspect_request: WorkspaceInspectRequest =
                        match serde_json::from_value(args) {
                            Ok(request) => request,
                            Err(_) => {
                                step = self.resume_plugin_error(
                                    &key,
                                    &request_id,
                                    "invalid_arguments",
                                )?;
                                continue;
                            }
                        };
                    let requested_bytes = match inspect_request.operation {
                        WorkspaceInspectOperation::Metadata => 64 * 1024,
                        WorkspaceInspectOperation::Preview => 256 * 1024,
                    };
                    let (prepared, revalidation, grant_id, plugin_identity_id, package_digest) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let prepared = state
                            .workspace_objects
                            .prepare(&workspace_context, &inspect_request)?;
                        let active = state
                            .active
                            .get(&key)
                            .context("workspace plugin was disabled before call admission")?;
                        let identity = active.host.identity().clone();
                        let revalidation = RevalidationRequest {
                            handle_id: handle_id.clone(),
                            plugin_id: identity.plugin_id().clone(),
                            host_instance_id: identity.host_instance_id().clone(),
                            package_digest: identity.package_digest().clone(),
                            project_id: identity.project_id().clone(),
                            scope_id: identity.project_id().clone(),
                            generation: identity.activation_generation(),
                            permission: PermissionKind::WorkspaceRInspect,
                            permission_use: PermissionUse::WorkspaceRInspect {
                                operation: match inspect_request.operation {
                                    WorkspaceInspectOperation::Metadata => "metadata",
                                    WorkspaceInspectOperation::Preview => "preview",
                                }
                                .to_string(),
                                requested_bytes,
                            },
                            workspace: context.workspace.clone(),
                        };
                        let admitted = state.grants.revalidate(revalidation.clone());
                        if let Revalidation::Denied(error) = admitted {
                            drop(state);
                            let mut store = Store::open(store_path)?;
                            if let Err(persistence_error) = record_call_event(
                                &mut store,
                                context,
                                identity.plugin_id().as_str(),
                                identity.package_digest().as_str(),
                                None,
                                "call_denied",
                                "failed",
                                Some(grant_error_code(error)),
                                serde_json::json!({"operation": "workspace.r.inspect"}),
                                false,
                            ) {
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            step = self.resume_plugin_error(
                                &key,
                                &request_id,
                                grant_error_code(error),
                            )?;
                            continue;
                        }
                        let grant_id = state
                            .grants
                            .durable_grant_id_for_handle(&handle_id)
                            .context("admitted Workspace handle has no durable grant identity")?
                            .to_string();
                        (
                            prepared,
                            revalidation,
                            grant_id,
                            identity.plugin_id().to_string(),
                            identity.package_digest().to_string(),
                        )
                    };
                    {
                        let mut store = Store::open(store_path)?;
                        if let Err(error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            Some(&grant_id),
                            "call_admitted",
                            "completed",
                            None,
                            serde_json::json!({"operation": "workspace.r.inspect"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(error);
                        }
                    }
                    let started = Instant::now();
                    let dispatched = match dispatcher.dispatch(prepared.clone()).await {
                        Ok(result) => result,
                        Err(_) => {
                            let mut store = Store::open(store_path)?;
                            if let Err(persistence_error) = record_call_event(
                                &mut store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                Some(&grant_id),
                                "call_failed",
                                "failed",
                                Some("workspace_dispatch_failed"),
                                serde_json::json!({"operation": "workspace.r.inspect"}),
                                false,
                            ) {
                                self.release_plugin_admission(&handle_id);
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            self.release_plugin_admission(&handle_id);
                            step = self.resume_plugin_error(
                                &key,
                                &request_id,
                                "workspace_dispatch_failed",
                            )?;
                            continue;
                        }
                    };
                    let completed_context = WorkspaceInspectionContext {
                        project_root: context.project_root.clone(),
                        workspace: dispatched.current_workspace.clone(),
                    };
                    let projected = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.workspace_objects.finish(
                            &completed_context,
                            &prepared,
                            &dispatched.response,
                        )
                    };
                    let projected = match projected {
                        Ok(projected) => projected,
                        Err(error) => {
                            let code = workspace_error_code(error.code);
                            let mut store = Store::open(store_path)?;
                            if let Err(persistence_error) = record_call_event(
                                &mut store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                None,
                                "call_denied",
                                "stale",
                                Some(code),
                                serde_json::json!({"operation": "workspace.r.inspect"}),
                                false,
                            ) {
                                self.release_plugin_admission(&handle_id);
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            self.release_plugin_admission(&handle_id);
                            step = self.resume_plugin_error(&key, &request_id, code)?;
                            continue;
                        }
                    };
                    let still_admitted = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        same_workspace_grant_identity(
                            context.workspace.as_ref(),
                            &dispatched.current_workspace,
                        ) && state.grants.revalidate_admitted(&revalidation)
                            == Revalidation::Allowed
                    };
                    if !still_admitted {
                        let mut store = Store::open(store_path)?;
                        if let Err(persistence_error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "stale",
                            Some("stale_after_dispatch"),
                            serde_json::json!({"operation": "workspace.r.inspect"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(persistence_error);
                        }
                        self.release_plugin_admission(&handle_id);
                        step =
                            self.resume_plugin_error(&key, &request_id, "stale_after_dispatch")?;
                        continue;
                    }
                    let projected_bytes = serde_json::to_vec(&projected)?.len();
                    {
                        let mut store = Store::open(store_path)?;
                        if let Err(error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            Some(&grant_id),
                            "call_completed",
                            "completed",
                            None,
                            serde_json::json!({
                                "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                "operation": "workspace.r.inspect",
                                "sizeBytes": projected_bytes
                            }),
                            true,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(error);
                        }
                    }
                    let resume_result = (|| -> Result<GuestStep> {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        ensure!(
                            state.grants.revalidate_admitted(&revalidation)
                                == Revalidation::Allowed,
                            "Workspace grant became stale after durable completion"
                        );
                        state.grants.complete_success(&handle_id);
                        state
                            .active
                            .get_mut(&key)
                            .context("workspace plugin was disabled before result delivery")?
                            .host
                            .resume_broker_call(
                                &request_id,
                                &serde_json::json!({"ok": true, "value": projected}),
                                projected_bytes,
                            )
                            .map_err(|error| anyhow!("Workspace plugin resume failed: {error:?}"))
                    })();
                    step = match resume_result {
                        Ok(step) => step,
                        Err(error) => {
                            let mut state = self
                                .state
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if let Some(active) = state.active.remove(&key) {
                                state.grants.invalidate_host(&active.host_instance_id);
                            }
                            drop(state);
                            let mut store = Store::open(store_path)?;
                            record_call_event(
                                &mut store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                None,
                                "call_failed",
                                "failed",
                                Some("completion_delivery_failed"),
                                serde_json::json!({"operation": "workspace.r.inspect"}),
                                false,
                            )?;
                            return Err(error);
                        }
                    };
                }
            }
        }
    }

    /// Execute a future contribution call through the no-import Guest ABI V2
    /// loop. P2-2C admits only `project.fs.read`; P2-3 will supply the first
    /// product contribution router that calls this method.
    #[allow(dead_code)]
    pub(crate) fn invoke_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store: &mut Store,
    ) -> Result<WorkspacePluginCallResult> {
        self.invoke_plugin_with_hook(
            context,
            plugin_id,
            request,
            store,
            &mut |_registry, _store, _grant_id| Ok(()),
        )
    }

    fn invoke_plugin_with_hook(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store: &mut Store,
        after_read: &mut impl FnMut(&Self, &mut Store, &str) -> Result<()>,
    ) -> Result<WorkspacePluginCallResult> {
        let key = registry_key(&context.project_root, plugin_id);
        let request_id = HostRequestId::generate();
        let mut step = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let active = state
                .active
                .get_mut(&key)
                .context("workspace plugin is not enabled for this project")?;
            ensure!(
                !active.host.broker_call_active(),
                "workspace plugin already has an active broker call"
            );
            ensure!(
                active.package_digest == active.host.identity().package_digest().as_str(),
                "workspace plugin host package identity is stale"
            );
            let handles = active
                .handles
                .values()
                .map(|handle| (handle.permission.as_static_str(), handle.id.clone()))
                .collect::<BTreeMap<_, _>>();
            active
                .host
                .begin_broker_call(
                    request_id.clone(),
                    serde_json::json!({
                        "request": request,
                        "capability_handles": handles,
                    }),
                )
                .map_err(|error| anyhow!("workspace plugin broker begin failed: {error:?}"))?
        };
        let mut broker_steps = 0;
        loop {
            match step {
                GuestStep::Complete { result, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "completed".to_string(),
                        result: Some(result),
                        error_code: None,
                        broker_steps,
                    });
                }
                GuestStep::Error { code, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "failed".to_string(),
                        result: None,
                        error_code: Some(code),
                        broker_steps,
                    });
                }
                GuestStep::BrokerRequest {
                    handle_id,
                    permission,
                    operation,
                    args,
                    ..
                } => {
                    broker_steps += 1;
                    if permission != "project.fs.read" || operation != "project.fs.read" {
                        step =
                            self.resume_plugin_error(&key, &request_id, "operation_not_available")?;
                        continue;
                    }
                    let file_request: ProjectFsReadRequest = match serde_json::from_value(args) {
                        Ok(request) => request,
                        Err(_) => {
                            step =
                                self.resume_plugin_error(&key, &request_id, "invalid_arguments")?;
                            continue;
                        }
                    };
                    let (revalidation, grant_id, plugin_identity) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let active = state
                            .active
                            .get(&key)
                            .context("workspace plugin was disabled before call admission")?;
                        let identity = active.host.identity().clone();
                        let revalidation = RevalidationRequest {
                            handle_id: handle_id.clone(),
                            plugin_id: identity.plugin_id().clone(),
                            host_instance_id: identity.host_instance_id().clone(),
                            package_digest: identity.package_digest().clone(),
                            project_id: identity.project_id().clone(),
                            scope_id: identity.project_id().clone(),
                            generation: identity.activation_generation(),
                            permission: PermissionKind::ProjectFsRead,
                            permission_use: PermissionUse::ProjectFsRead {
                                relative_path: file_request.project_relative_path.clone(),
                                requested_bytes: file_request.max_bytes,
                            },
                            workspace: None,
                        };
                        let outcome = state.grants.revalidate(revalidation.clone());
                        let grant_id = state
                            .grants
                            .durable_grant_id_for_handle(&handle_id)
                            .map(str::to_string);
                        (
                            revalidation,
                            grant_id,
                            (
                                identity.plugin_id().to_string(),
                                identity.package_digest().to_string(),
                                outcome,
                            ),
                        )
                    };
                    let (plugin_identity_id, package_digest, admitted) = plugin_identity;
                    if let Revalidation::Denied(error) = admitted {
                        if let Err(persistence_error) = record_call_event(
                            store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "failed",
                            Some(grant_error_code(error)),
                            serde_json::json!({"operation": "project.fs.read"}),
                            false,
                        ) {
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(persistence_error);
                        }
                        step =
                            self.resume_plugin_error(&key, &request_id, grant_error_code(error))?;
                        continue;
                    }
                    let Some(grant_id) = grant_id else {
                        self.cancel_plugin_call(&key, &request_id);
                        bail!("admitted plugin handle has no durable grant identity");
                    };
                    if let Err(error) = record_call_event(
                        store,
                        context,
                        &plugin_identity_id,
                        &package_digest,
                        Some(&grant_id),
                        "call_admitted",
                        "completed",
                        None,
                        serde_json::json!({"operation": "project.fs.read"}),
                        false,
                    ) {
                        self.release_plugin_admission(&handle_id);
                        self.cancel_plugin_call(&key, &request_id);
                        return Err(error);
                    }
                    let started = Instant::now();
                    let operation = read_project_file(
                        Path::new(&context.project_root),
                        u64::try_from(context.project_revision)
                            .context("current project revision is negative")?,
                        &file_request,
                    );
                    let file_result = match operation {
                        Ok(result) => result,
                        Err(error) => {
                            let code = project_file_error_code(error.code);
                            if let Err(persistence_error) = record_call_event(
                                store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                Some(&grant_id),
                                "call_failed",
                                "failed",
                                Some(code),
                                serde_json::json!({
                                    "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                    "operation": "project.fs.read"
                                }),
                                false,
                            ) {
                                self.release_plugin_admission(&handle_id);
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            self.release_plugin_admission(&handle_id);
                            step = self.resume_plugin_error(&key, &request_id, code)?;
                            continue;
                        }
                    };
                    after_read(self, store, &grant_id)?;
                    let still_admitted = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let session_current = state.active.get(&key).is_some_and(|active| {
                            active.host.identity().host_instance_id()
                                == &revalidation.host_instance_id
                        });
                        session_current
                            && state.grants.revalidate_admitted(&revalidation)
                                == Revalidation::Allowed
                    };
                    if !still_admitted {
                        if let Err(persistence_error) = record_call_event(
                            store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "stale",
                            Some("stale_after_dispatch"),
                            serde_json::json!({"operation": "project.fs.read"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(persistence_error);
                        }
                        self.release_plugin_admission(&handle_id);
                        step =
                            self.resume_plugin_error(&key, &request_id, "stale_after_dispatch")?;
                        continue;
                    }
                    if let Err(persistence_error) = record_call_event(
                        store,
                        context,
                        &plugin_identity_id,
                        &package_digest,
                        Some(&grant_id),
                        "call_completed",
                        "completed",
                        None,
                        serde_json::json!({
                            "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                            "operation": "project.fs.read",
                            "sizeBytes": file_result.size_bytes
                        }),
                        true,
                    ) {
                        self.release_plugin_admission(&handle_id);
                        self.cancel_plugin_call(&key, &request_id);
                        return Err(persistence_error);
                    }
                    let result_value = serde_json::to_value(&file_result)?;
                    let resume_result = (|| -> Result<GuestStep> {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let final_admission = state.grants.revalidate_admitted(&revalidation);
                        if final_admission != Revalidation::Allowed {
                            state.grants.complete_uncertain(&handle_id);
                            if let Some(active) = state.active.get_mut(&key) {
                                let _ = active.host.cancel_broker_call(&request_id);
                            }
                            bail!("plugin grant became stale after durable completion");
                        }
                        state.grants.complete_success(&handle_id);
                        let active = state
                            .active
                            .get_mut(&key)
                            .context("workspace plugin was disabled before result delivery")?;
                        active
                            .host
                            .resume_broker_call(
                                &request_id,
                                &serde_json::json!({"ok": true, "value": result_value}),
                                file_result.size_bytes as usize,
                            )
                            .map_err(|error| {
                                anyhow!("workspace plugin broker resume failed: {error:?}")
                            })
                    })();
                    step = match resume_result {
                        Ok(step) => step,
                        Err(error) => {
                            let mut state = self
                                .state
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if let Some(active) = state.active.remove(&key) {
                                state.grants.invalidate_host(&active.host_instance_id);
                            }
                            drop(state);
                            record_call_event(
                                store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                None,
                                "call_failed",
                                "failed",
                                Some("guest_resume_failed"),
                                serde_json::json!({"operation": "project.fs.read"}),
                                false,
                            )?;
                            return Err(error);
                        }
                    };
                }
            }
        }
    }

    fn resume_plugin_error(
        &self,
        key: &str,
        request_id: &HostRequestId,
        code: &str,
    ) -> Result<GuestStep> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (result, failed_host) = {
            let active = state
                .active
                .get_mut(key)
                .context("workspace plugin was disabled before error delivery")?;
            let host_id = active.host_instance_id.clone();
            let result = active.host.resume_broker_call(
                request_id,
                &serde_json::json!({"ok": false, "error": {"code": code}}),
                0,
            );
            (result, host_id)
        };
        match result {
            Ok(step) => Ok(step),
            Err(error) => {
                state.active.remove(key);
                state.grants.invalidate_host(&failed_host);
                Err(anyhow!("workspace plugin error resume failed: {error:?}"))
            }
        }
    }

    fn release_plugin_admission(&self, handle_id: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.grants.complete_failure_before_dispatch(handle_id);
    }

    fn complete_plugin_uncertain(&self, handle_id: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.grants.complete_uncertain(handle_id);
    }

    fn cancel_plugin_call(&self, key: &str, request_id: &HostRequestId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.active.get_mut(key) {
            let _ = active.host.cancel_broker_call(request_id);
        }
    }

    pub(crate) fn invalidate_project(&self, project_root: &str) -> usize {
        let project_root = normalize_project_root(project_root);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let invalidated = state.grants.invalidate_project(&project_root);
        let prefix = format!("{project_root}\0");
        state.active.retain(|key, _| !key.starts_with(&prefix));
        state.pending.retain(|key, _| !key.starts_with(&prefix));
        state.workspace_objects.invalidate_project(&project_root);
        invalidated
    }
}

fn record_call_event(
    store: &mut Store,
    context: &PluginRuntimeContext,
    plugin_id: &str,
    package_digest: &str,
    grant_id: Option<&str>,
    event_type: &str,
    status: &str,
    reason_code: Option<&str>,
    details: serde_json::Value,
    consume_allow_once: bool,
) -> Result<()> {
    PluginPermissionMutationService::new(store)
        .record_call_event(
            &context.project_root,
            &PluginPermissionCallEventDraft {
                project_root: context.project_root.clone(),
                plugin_id: plugin_id.to_string(),
                package_digest: package_digest.to_string(),
                grant_id: grant_id.map(str::to_string),
                event_type: event_type.to_string(),
                status: status.to_string(),
                reason_code: reason_code.map(str::to_string),
                details_json: details.to_string(),
            },
            consume_allow_once,
        )
        .map_err(Into::into)
}

fn grant_error_code(error: GrantErrorKind) -> &'static str {
    match error {
        GrantErrorKind::UnknownHandle => "unknown_handle",
        GrantErrorKind::Revoked => "grant_revoked",
        GrantErrorKind::Expired => "grant_expired",
        GrantErrorKind::Consumed => "grant_consumed",
        GrantErrorKind::InFlight => "grant_in_flight",
        GrantErrorKind::NotAdmitted => "grant_not_admitted",
        GrantErrorKind::WrongPlugin => "wrong_plugin",
        GrantErrorKind::WrongHostSession => "wrong_host_session",
        GrantErrorKind::WrongProject => "wrong_project",
        GrantErrorKind::WrongScope => "wrong_scope",
        GrantErrorKind::WrongGeneration => "wrong_generation",
        GrantErrorKind::WrongPackageDigest => "wrong_package_digest",
        GrantErrorKind::WrongPermission => "wrong_permission",
        GrantErrorKind::WrongWorkspace => "wrong_workspace",
        GrantErrorKind::ConstraintViolation => "constraint_violation",
    }
}

fn project_file_error_code(error: ProjectFsReadErrorCode) -> &'static str {
    match error {
        ProjectFsReadErrorCode::InvalidProject => "invalid_project",
        ProjectFsReadErrorCode::InvalidPath => "invalid_path",
        ProjectFsReadErrorCode::ReservedPath => "reserved_path",
        ProjectFsReadErrorCode::StaleProject => "stale_project",
        ProjectFsReadErrorCode::SymlinkOrReparse => "symlink_or_reparse",
        ProjectFsReadErrorCode::NestedRepository => "nested_repository",
        ProjectFsReadErrorCode::NotRegularFile => "not_regular_file",
        ProjectFsReadErrorCode::OutsideProject => "outside_project",
        ProjectFsReadErrorCode::TooLarge => "too_large",
        ProjectFsReadErrorCode::FileChanged => "file_changed",
        ProjectFsReadErrorCode::IoFailed => "io_failed",
    }
}

fn workspace_error_code(error: WorkspaceInspectErrorCode) -> &'static str {
    match error {
        WorkspaceInspectErrorCode::InvalidProject => "invalid_project",
        WorkspaceInspectErrorCode::InvalidSnapshot => "invalid_snapshot",
        WorkspaceInspectErrorCode::ReferenceLimit => "reference_limit",
        WorkspaceInspectErrorCode::UnknownReference => "unknown_object_reference",
        WorkspaceInspectErrorCode::StaleWorkspace => "stale_workspace",
        WorkspaceInspectErrorCode::ObjectChanged => "object_changed",
        WorkspaceInspectErrorCode::MalformedResult => "malformed_workspace_result",
        WorkspaceInspectErrorCode::ResultTooLarge => "workspace_result_too_large",
    }
}

fn network_error_code(error: NetworkFetchErrorCode) -> &'static str {
    match error {
        NetworkFetchErrorCode::InvalidUrl => "invalid_url",
        NetworkFetchErrorCode::HostNotAllowed => "host_not_allowed",
        NetworkFetchErrorCode::MethodNotAllowed => "method_not_allowed",
        NetworkFetchErrorCode::StaleProject => "stale_project",
        NetworkFetchErrorCode::DnsFailed => "dns_failed",
        NetworkFetchErrorCode::NonPublicAddress => "non_public_address",
        NetworkFetchErrorCode::AuthorizationDenied => "authorization_denied",
        NetworkFetchErrorCode::RedirectMissingLocation => "redirect_missing_location",
        NetworkFetchErrorCode::TooManyRedirects => "too_many_redirects",
        NetworkFetchErrorCode::ResponseTooLarge => "response_too_large",
        NetworkFetchErrorCode::Timeout => "network_timeout",
        NetworkFetchErrorCode::TransportFailed => "transport_failed",
    }
}

fn workspace_inspection_context(
    context: &PluginRuntimeContext,
) -> Result<WorkspaceInspectionContext> {
    let workspace = context
        .workspace
        .as_ref()
        .context("Workspace R identity is unavailable for plugin inspection")?;
    Ok(WorkspaceInspectionContext {
        project_root: context.project_root.clone(),
        workspace: rho_protocol::WorkspaceIdentity {
            workspace_id: workspace.workspace_id.clone(),
            kernel_instance_id: workspace.kernel_instance_id.clone(),
            execution_seq: 0,
            state_revision: workspace.state_revision,
            project_revision: workspace.project_revision,
        },
    })
}

fn same_workspace_grant_identity(
    expected: Option<&WorkspaceGrantIdentity>,
    actual: &rho_protocol::WorkspaceIdentity,
) -> bool {
    expected.is_some_and(|expected| {
        expected.workspace_id == actual.workspace_id
            && expected.kernel_instance_id == actual.kernel_instance_id
            && expected.state_revision == actual.state_revision
            && expected.project_revision == actual.project_revision
    })
}

fn plugin_view(
    project_root: &str,
    plugin: &DiscoveredPlugin,
    requests: &[PluginPermissionRequest],
    grants: &[PluginPermissionGrant],
    state: &RegistryState,
) -> WorkspacePluginView {
    let plugin_id = plugin.manifest.id.to_string();
    let exact_request = |request: &&PluginPermissionRequest| {
        request.plugin_id == plugin_id && request.package_digest == plugin.digest.as_str()
    };
    let pending_request_count = requests
        .iter()
        .filter(exact_request)
        .filter(|request| request.status == "pending")
        .count();
    let active_grant_count = grants
        .iter()
        .filter(|grant| {
            grant.plugin_id == plugin_id
                && grant.package_digest == plugin.digest.as_str()
                && grant.status == "active"
        })
        .count();
    let active = state.active.values().find(|active| {
        active.project_root == project_root
            && active.package_digest == plugin.digest.as_str()
            && active.plugin_version == plugin.manifest.version.to_string()
    });
    let status = if active.is_some() {
        "enabled"
    } else if pending_request_count > 0 {
        "permission_required"
    } else if requests
        .iter()
        .filter(exact_request)
        .any(|request| request.status == "denied")
    {
        "denied"
    } else {
        "disabled"
    };
    WorkspacePluginView {
        plugin_id,
        name: plugin.manifest.name.clone(),
        version: plugin.manifest.version.to_string(),
        package_digest: plugin.digest.to_string(),
        short_digest: plugin.digest.as_str()[..12].to_string(),
        runtime_kind: plugin.manifest.runtime.kind.to_string(),
        permission_count: plugin.manifest.permissions.len(),
        pending_request_count,
        active_grant_count,
        status: status.to_string(),
        message: (plugin.manifest.runtime.kind != RuntimeKind::Wasm)
            .then(|| "This runtime kind is not executable in Phase 2.".to_string()),
    }
}

fn discover_exact_plugin(project_root: &Path, plugin_id: &str) -> Result<DiscoveredPlugin> {
    PluginId::new(plugin_id.to_string()).context("validating workspace plugin id")?;
    let report = discover_workspace_plugins(project_root)?
        .context("this project has no .rho/plugins directory")?;
    report
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id.as_str() == plugin_id)
        .with_context(|| format!("workspace plugin {plugin_id} was not discovered"))
}

fn registry_key(project_root: &str, plugin_id: &str) -> String {
    format!("{}\0{plugin_id}", normalize_project_root(project_root))
}

fn matching_project_grants(
    store: &Store,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
) -> Result<BTreeMap<(String, String), PluginPermissionGrant>> {
    let now = Utc::now();
    let permissions = plugin
        .manifest
        .permissions
        .iter()
        .map(|permission| {
            Ok((
                permission.name.clone(),
                PermissionConstraints::from_manifest(permission)?.digest()?,
            ))
        })
        .collect::<Result<BTreeSet<_>>>()?;
    let grants = PluginPermissionQueryService::new(store).list_grants(
        &context.project_root,
        Some(100),
        Some("active"),
    )?;
    let mut matching = BTreeMap::new();
    for grant in grants {
        let expires_at = DateTime::parse_from_rfc3339(&grant.expires_at)
            .context("parsing durable plugin grant expiry")?
            .with_timezone(&Utc);
        let key = (grant.permission.clone(), grant.constraints_digest.clone());
        if grant.plugin_id == plugin.manifest.id.as_str()
            && grant.plugin_version == plugin.manifest.version.to_string()
            && grant.package_digest == plugin.digest.as_str()
            && grant.runtime_kind == "wasm"
            && grant.grant_source == "project"
            && grant.policy_revision == POLICY_REVISION
            && expires_at > now
            && permissions.contains(&key)
        {
            matching.insert(key, grant);
        }
    }
    Ok(matching)
}

fn try_activate_pending(
    state: &mut RegistryState,
    context: &PluginRuntimeContext,
    plugin_id: &str,
    store: &mut Store,
) -> Result<(String, usize)> {
    let key = registry_key(&context.project_root, plugin_id);
    let pending = state
        .pending
        .get(&key)
        .cloned()
        .context("plugin enable request is no longer pending")?;
    ensure!(
        pending.plugin_id == plugin_id
            && pending.expected_project_revision == context.project_revision,
        "plugin enable request is stale"
    );
    let requests = pending
        .request_ids
        .iter()
        .map(|request_id| {
            PluginPermissionQueryService::new(store)
                .get_request(&context.project_root, request_id)?
                .context("pending plugin permission request disappeared")
        })
        .collect::<Result<Vec<_>>>()?;
    if requests.iter().any(|request| request.status == "pending") {
        return Ok(("permission_required".to_string(), 0));
    }
    if requests.iter().any(|request| request.status != "granted") {
        state.pending.remove(&key);
        return Ok(("denied".to_string(), 0));
    }
    let plugin = discover_exact_plugin(Path::new(&context.project_root), plugin_id)?;
    ensure!(
        plugin.manifest.version.to_string() == pending.plugin_version
            && plugin.digest.as_str() == pending.package_digest,
        "plugin package changed while permission review was open"
    );
    let durable_grants = PluginPermissionQueryService::new(store).list_grants(
        &context.project_root,
        Some(100),
        Some("active"),
    )?;
    let result = activate_plugin(
        state,
        context,
        &plugin,
        durable_grants.iter().filter(|grant| {
            grant.plugin_id == plugin_id
                && grant.plugin_version == pending.plugin_version
                && grant.package_digest == pending.package_digest
        }),
        store,
    )?;
    state.pending.remove(&key);
    Ok((result.status, result.active_grant_count))
}

fn activate_plugin<'a>(
    state: &mut RegistryState,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
    durable_grants: impl IntoIterator<Item = &'a PluginPermissionGrant>,
    store: &mut Store,
) -> Result<WorkspacePluginEnableResult> {
    let module_bytes = read_exact_entry(Path::new(&context.project_root), plugin)?;
    let generation = ActivationGeneration::new(state.next_generation)
        .context("allocating workspace plugin activation generation")?;
    let host_instance_id = HostInstanceId::generate();
    let identity = WasmHostIdentity::new(
        context.project_scope_id.clone(),
        plugin.manifest.id.clone(),
        plugin.digest.clone(),
        generation,
        host_instance_id.clone(),
    );
    let mut host = WasmPluginHost::from_bytes_with_call_id_source(
        identity,
        &module_bytes,
        Arc::clone(&state.broker_call_id_source),
    )
    .map_err(|error| anyhow!("workspace plugin host rejected the module: {error:?}"))?;
    if !plugin.manifest.permissions.is_empty() {
        ensure!(
            host.guest_abi_version() == rho_extension_runtime::GUEST_ABI_V2,
            "permission-bearing workspace plugins require no-import Guest ABI V2"
        );
    }
    let frame = |message| HostFrame {
        instance_id: host_instance_id.clone(),
        message,
    };
    ensure!(
        matches!(
            host.handle_frame(frame(HostMessage::Hello {
                api_version: HOST_PROTOCOL_VERSION
            }))
            .map_err(|error| anyhow!("workspace plugin handshake failed: {error:?}"))?,
            Some(HostResponse::Ready { .. })
        ),
        "workspace plugin host did not negotiate Guest ABI V1"
    );
    ensure!(
        matches!(
            host.handle_frame(frame(HostMessage::Activate))
                .map_err(|error| anyhow!("workspace plugin activation failed: {error:?}"))?,
            Some(HostResponse::Activated)
        ),
        "workspace plugin host did not activate"
    );

    let grants = durable_grants.into_iter().collect::<Vec<_>>();
    let mut handles = BTreeMap::new();
    for permission in &plugin.manifest.permissions {
        let constraints = PermissionConstraints::from_manifest(permission)?;
        let constraints_digest = constraints.digest()?;
        let grant = grants
            .iter()
            .copied()
            .find(|grant| {
                grant.permission == permission.name
                    && grant.constraints_digest == constraints_digest
                    && grant.status == "active"
            })
            .with_context(|| {
                format!(
                    "plugin permission {} has no exact durable grant",
                    permission.name
                )
            })?;
        let permission_kind = PermissionKind::parse(&permission.name)
            .context("durable grant names an unsupported permission")?;
        let expires_at = DateTime::parse_from_rfc3339(&grant.expires_at)
            .context("parsing plugin grant expiry")?
            .timestamp_millis();
        ensure!(
            expires_at > 0,
            "plugin grant expiry is outside the supported range"
        );
        let workspace = (permission_kind == PermissionKind::WorkspaceRInspect)
            .then(|| context.workspace.clone())
            .flatten();
        let handle = match state.grants.grant(GrantRequest {
            durable_grant_id: grant.grant_id.clone(),
            normalized_project_root: context.project_root.clone(),
            plugin_id: plugin.manifest.id.clone(),
            plugin_version: plugin.manifest.version.clone(),
            runtime_kind: plugin.manifest.runtime.kind,
            host_instance_id: host_instance_id.clone(),
            package_digest: plugin.digest.clone(),
            project_id: context.project_scope_id.clone(),
            scope_id: context.project_scope_id.clone(),
            activation_generation: generation,
            permission: permission_kind,
            constraints,
            constraints_digest,
            grant_source: if grant.grant_source == "allow_once" {
                GrantSource::AllowOnce
            } else {
                GrantSource::Project
            },
            policy_revision: grant.policy_revision as u64,
            workspace,
            expires_at_millis: expires_at as u64,
        }) {
            Ok(handle) => handle,
            Err(error) => {
                state.grants.invalidate_host(&host_instance_id);
                return Err(error.into());
            }
        };
        if let Err(error) = PluginPermissionMutationService::new(store).record_call_event(
            &context.project_root,
            &PluginPermissionCallEventDraft {
                project_root: context.project_root.clone(),
                plugin_id: plugin.manifest.id.to_string(),
                package_digest: plugin.digest.to_string(),
                grant_id: Some(grant.grant_id.clone()),
                event_type: "handle_minted".to_string(),
                status: "completed".to_string(),
                reason_code: None,
                details_json: serde_json::json!({"operation": permission.name}).to_string(),
            },
            false,
        ) {
            state.grants.invalidate_host(&host_instance_id);
            return Err(error.into());
        }
        handles.insert(grant.grant_id.clone(), handle);
    }

    state.next_generation = state
        .next_generation
        .checked_add(1)
        .context("workspace plugin activation generation is exhausted")?;
    let active_grant_count = handles.len();
    let key = registry_key(&context.project_root, plugin.manifest.id.as_str());
    state.active.insert(
        key,
        ActivePlugin {
            project_root: context.project_root.clone(),
            plugin_version: plugin.manifest.version.to_string(),
            package_digest: plugin.digest.to_string(),
            host_instance_id,
            host,
            handles,
        },
    );
    Ok(WorkspacePluginEnableResult {
        status: "enabled".to_string(),
        plugin_id: plugin.manifest.id.to_string(),
        request_ids: Vec::new(),
        active_grant_count,
        message: if active_grant_count == 0 {
            "The plugin is enabled with zero privileged permissions."
        } else {
            "The plugin is enabled with fresh session-bound handles."
        }
        .to_string(),
    })
}

fn read_exact_entry(project_root: &Path, plugin: &DiscoveredPlugin) -> Result<Vec<u8>> {
    let plugin_directory = project_root
        .join(rho_extension_runtime::PLUGINS_DIR)
        .join(&plugin.directory);
    let entry_path = plugin_directory.join(&plugin.manifest.runtime.entry);
    let metadata = fs::symlink_metadata(&entry_path)
        .with_context(|| format!("reading plugin entry metadata: {}", entry_path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "plugin entry must remain a regular non-symlink file"
    );
    ensure!(
        metadata.len() <= MAX_WASM_MODULE_BYTES as u64,
        "plugin entry exceeds the Wasm module bound"
    );
    let canonical_directory = fs::canonicalize(&plugin_directory)?;
    let canonical_entry = fs::canonicalize(&entry_path)?;
    ensure!(
        canonical_entry.starts_with(&canonical_directory),
        "plugin entry escaped its package directory"
    );
    let bytes = fs::read(&canonical_entry)?;
    ensure!(
        bytes.len() <= MAX_WASM_MODULE_BYTES,
        "plugin entry grew beyond the Wasm module bound"
    );
    let rediscovered = discover_exact_plugin(project_root, plugin.manifest.id.as_str())?;
    ensure!(
        rediscovered.digest == plugin.digest
            && rediscovered.manifest.version == plugin.manifest.version
            && rediscovered.manifest.runtime == plugin.manifest.runtime,
        "plugin package changed during activation"
    );
    Ok(bytes)
}

fn grant_view(grant: PluginPermissionGrant, grants: &GrantStore) -> Result<PluginGrantView> {
    let constraints = serde_json::from_str(&grant.constraints_json)
        .context("decoding durable plugin grant constraints")?;
    Ok(PluginGrantView {
        grant_id: grant.grant_id.clone(),
        plugin_id: grant.plugin_id,
        plugin_version: grant.plugin_version,
        short_digest: grant.package_digest[..12].to_string(),
        package_digest: grant.package_digest,
        permission: grant.permission,
        constraints,
        grant_source: grant.grant_source,
        policy_revision: grant.policy_revision,
        expires_at: grant.expires_at,
        status: grant.status,
        live_handle: grants.has_live_durable_grant(&grant.grant_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_extension_runtime::{GrantTokenSource, P2_1_SMOKE_WASM, SystemGrantClock};
    use rho_server::plugin_network::{NetworkResolver, NetworkTransport, NetworkTransportResponse};
    use rho_server::plugin_workspace::{WorkspaceReferenceClock, WorkspaceReferenceIdSource};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use tempfile::tempdir;

    #[derive(Debug)]
    struct FixedToken;

    impl GrantTokenSource for FixedToken {
        fn next_token(&self) -> [u8; 32] {
            [7; 32]
        }
    }

    #[derive(Debug)]
    struct FixedCallId;

    impl BrokerCallIdSource for FixedCallId {
        fn next_call_id(&self) -> u64 {
            42
        }
    }

    #[derive(Debug)]
    struct FixedWorkspaceClock(AtomicU64);

    impl WorkspaceReferenceClock for FixedWorkspaceClock {
        fn now_millis(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[derive(Debug)]
    struct FixedWorkspaceReferenceId;

    impl WorkspaceReferenceIdSource for FixedWorkspaceReferenceId {
        fn next_id(&self) -> [u8; 16] {
            [7; 16]
        }
    }

    fn deterministic_registry() -> PendingPluginPermissionRegistry {
        deterministic_registry_with_network(NetworkFetchEngine::new())
    }

    fn deterministic_registry_with_network(
        network_engine: NetworkFetchEngine,
    ) -> PendingPluginPermissionRegistry {
        PendingPluginPermissionRegistry {
            state: Mutex::new(RegistryState {
                next_generation: 1,
                pending: BTreeMap::new(),
                active: BTreeMap::new(),
                grants: GrantStore::with_sources(Arc::new(SystemGrantClock), Arc::new(FixedToken)),
                broker_call_id_source: Arc::new(FixedCallId),
                workspace_objects: WorkspaceObjectReferenceRegistry::with_sources(
                    Arc::new(FixedWorkspaceClock(AtomicU64::new(123))),
                    Arc::new(FixedWorkspaceReferenceId),
                ),
                network_engine: Arc::new(network_engine),
            }),
        }
    }

    fn wat_data(value: &str) -> String {
        value
            .as_bytes()
            .iter()
            .map(|byte| format!("\\{byte:02x}"))
            .collect()
    }

    fn install_file_broker_module(project: &Path) {
        install_file_broker_module_with_resume(project, false);
    }

    fn install_file_broker_module_with_resume(project: &Path, resume_traps: bool) {
        let call_id = "call.000000000000002a";
        let begin = serde_json::json!({
            "type": "broker_request",
            "call_id": call_id,
            "handle_id": format!("handle.{}", "07".repeat(32)),
            "permission": "project.fs.read",
            "operation": "project.fs.read",
            "args": {
                "project_relative_path": "data/input.csv",
                "max_bytes": 5,
                "expected_project_revision": 3
            }
        })
        .to_string();
        let complete = serde_json::json!({
            "type": "complete",
            "call_id": call_id,
            "result": {"received": true}
        })
        .to_string();
        let begin_pointer = 1024_u64;
        let complete_pointer = 4096_u64;
        let begin_packed = (begin_pointer << 32) | begin.len() as u64;
        let complete_packed = (complete_pointer << 32) | complete.len() as u64;
        let resume_export = if resume_traps {
            r#"(func (export "rho_resume") (param i32 i32) (result i64) unreachable)"#.to_string()
        } else {
            format!(
                r#"(func (export "rho_resume") (param i32 i32) (result i64) i64.const {complete_packed})"#
            )
        };
        let module = wat::parse_str(format!(
            r#"(module
                (memory (export "memory") 1 32)
                (data (i32.const {begin_pointer}) "{}")
                (data (i32.const {complete_pointer}) "{}")
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0)
                (func (export "rho_begin") (param i32 i32) (result i64) i64.const {begin_packed})
                {resume_export}
                (func (export "rho_cancel") (param i32 i32) (result i32) i32.const 0))"#,
            wat_data(&begin),
            wat_data(&complete),
        ))
        .unwrap();
        fs::write(
            project.join(".rho/plugins/example/dist/plugin.wasm"),
            module,
        )
        .unwrap();
    }

    fn install_workspace_broker_module(project: &Path) {
        let call_id = "call.000000000000002a";
        let begin = serde_json::json!({
            "type": "broker_request",
            "call_id": call_id,
            "handle_id": format!("handle.{}", "07".repeat(32)),
            "permission": "workspace.r.inspect",
            "operation": "workspace.r.inspect",
            "args": {
                "object_reference": format!("object.{}", "07".repeat(16)),
                "operation": "preview"
            }
        })
        .to_string();
        let complete = serde_json::json!({
            "type": "complete",
            "call_id": call_id,
            "result": {"received": true}
        })
        .to_string();
        let begin_pointer = 1024_u64;
        let complete_pointer = 4096_u64;
        let begin_packed = (begin_pointer << 32) | begin.len() as u64;
        let complete_packed = (complete_pointer << 32) | complete.len() as u64;
        let module = wat::parse_str(format!(
            r#"(module
                (memory (export "memory") 1 32)
                (data (i32.const {begin_pointer}) "{}")
                (data (i32.const {complete_pointer}) "{}")
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0)
                (func (export "rho_begin") (param i32 i32) (result i64) i64.const {begin_packed})
                (func (export "rho_resume") (param i32 i32) (result i64) i64.const {complete_packed})
                (func (export "rho_cancel") (param i32 i32) (result i32) i32.const 0))"#,
            wat_data(&begin),
            wat_data(&complete),
        ))
        .unwrap();
        fs::write(
            project.join(".rho/plugins/example/dist/plugin.wasm"),
            module,
        )
        .unwrap();
    }

    fn install_network_broker_module(project: &Path) {
        let call_id = "call.000000000000002a";
        let begin = serde_json::json!({
            "type": "broker_request",
            "call_id": call_id,
            "handle_id": format!("handle.{}", "07".repeat(32)),
            "permission": "network.fetch",
            "operation": "network.fetch",
            "args": {
                "url": "https://api.example.org/data",
                "method": "GET",
                "max_response_bytes": 16,
                "expected_project_revision": 3
            }
        })
        .to_string();
        let complete = serde_json::json!({
            "type": "complete",
            "call_id": call_id,
            "result": {"received": true}
        })
        .to_string();
        let begin_pointer = 1024_u64;
        let complete_pointer = 4096_u64;
        let begin_packed = (begin_pointer << 32) | begin.len() as u64;
        let complete_packed = (complete_pointer << 32) | complete.len() as u64;
        let module = wat::parse_str(format!(
            r#"(module
                (memory (export "memory") 1 32)
                (data (i32.const {begin_pointer}) "{}")
                (data (i32.const {complete_pointer}) "{}")
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0)
                (func (export "rho_begin") (param i32 i32) (result i64) i64.const {begin_packed})
                (func (export "rho_resume") (param i32 i32) (result i64) i64.const {complete_packed})
                (func (export "rho_cancel") (param i32 i32) (result i32) i32.const 0))"#,
            wat_data(&begin),
            wat_data(&complete),
        ))
        .unwrap();
        fs::write(
            project.join(".rho/plugins/example/dist/plugin.wasm"),
            module,
        )
        .unwrap();
    }

    fn write_plugin(project: &Path, permissions: serde_json::Value) {
        let directory = project.join(".rho/plugins/example/dist");
        fs::create_dir_all(&directory).unwrap();
        let permission_bearing = permissions
            .as_array()
            .is_some_and(|permissions| !permissions.is_empty());
        let module = if permission_bearing {
            wat::parse_str(
                r#"(module
                    (memory (export "memory") 1 1)
                    (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                    (func (export "rho_echo") (param $ptr i32) (param $len i32) (result i64)
                      local.get $ptr i64.extend_i32_u i64.const 32 i64.shl
                      local.get $len i64.extend_i32_u i64.or)
                    (func (export "rho_heartbeat") (result i32) i32.const 0)
                    (func (export "rho_quiesce") (result i32) i32.const 0)
                    (func (export "rho_dispose") (result i32) i32.const 0)
                    (func (export "rho_begin") (param i32 i32) (result i64) i64.const 0)
                    (func (export "rho_resume") (param i32 i32) (result i64) i64.const 0)
                    (func (export "rho_cancel") (param i32 i32) (result i32) i32.const 0))"#,
            )
            .unwrap()
        } else {
            P2_1_SMOKE_WASM.to_vec()
        };
        fs::write(directory.join("plugin.wasm"), module).unwrap();
        fs::write(
            project.join(".rho/plugins/example/rho-plugin.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "id": "org.example.plugin",
                "name": "Example <unsafe>",
                "version": "1.0.0",
                "apiVersion": "^1.0",
                "runtime": { "kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project" },
                "activation": [],
                "provides": [],
                "requires": [],
                "optional": [],
                "permissions": permissions
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn context(project: &Path) -> PluginRuntimeContext {
        let canonical = project.canonicalize().unwrap();
        let root = normalize_project_root(canonical.to_string_lossy().as_ref());
        PluginRuntimeContext {
            project_root: root,
            project_revision: 3,
            project_scope_id: ScopeId::new("project.test").unwrap(),
            workspace: Some(WorkspaceGrantIdentity {
                workspace_id: "workspace.a".to_string(),
                kernel_instance_id: "kernel.a".to_string(),
                state_revision: 2,
                project_revision: 3,
            }),
        }
    }

    fn protocol_workspace(context: &PluginRuntimeContext) -> rho_protocol::WorkspaceIdentity {
        let workspace = context.workspace.as_ref().unwrap();
        rho_protocol::WorkspaceIdentity {
            workspace_id: workspace.workspace_id.clone(),
            kernel_instance_id: workspace.kernel_instance_id.clone(),
            execution_seq: 1,
            state_revision: workspace.state_revision,
            project_revision: workspace.project_revision,
        }
    }

    fn workspace_snapshot(context: &PluginRuntimeContext) -> serde_json::Value {
        serde_json::json!({
            "execution": {"ok": true, "objects": [{
                "name": "qc", "classes": ["data.frame"], "dimensions": [2, 2],
                "size_bytes": 128, "typeof": "list", "preview_kind": "tabular"
            }]},
            "workspace": protocol_workspace(context)
        })
    }

    fn workspace_inspection_response(context: &PluginRuntimeContext) -> serde_json::Value {
        serde_json::json!({
            "execution": {
                "ok": true, "name": "qc", "classes": ["data.frame"],
                "dimensions": [2, 2], "size_bytes": 128, "typeof": "list",
                "preview_kind": "tabular",
                "preview": {"kind": "tabular", "rows": [{"x": 1}, {"x": 2}]},
                "structure": "data.frame: 2 obs.",
                "function_source": {"definition": "must not escape"}
            },
            "workspace": protocol_workspace(context)
        })
    }

    struct MockWorkspaceDispatcher {
        response: serde_json::Value,
        current_workspace: rho_protocol::WorkspaceIdentity,
        fail: bool,
    }

    impl WorkspacePluginDispatcher for MockWorkspaceDispatcher {
        fn dispatch<'a>(
            &'a self,
            prepared: PreparedWorkspaceInspection,
        ) -> Pin<Box<dyn Future<Output = Result<WorkspaceDispatchResult>> + Send + 'a>> {
            Box::pin(async move {
                ensure!(
                    prepared.request_type == "workspace.inspect_object",
                    "only the fixed inspection request is allowed"
                );
                ensure!(
                    prepared.arguments == serde_json::json!({"name": "qc"}),
                    "guest input must not become R code"
                );
                if self.fail {
                    bail!("injected Workspace crash");
                }
                Ok(WorkspaceDispatchResult {
                    response: self.response.clone(),
                    current_workspace: self.current_workspace.clone(),
                })
            })
        }
    }

    struct NetworkResolverFixture {
        addresses: Vec<std::net::IpAddr>,
    }

    impl NetworkResolver for NetworkResolverFixture {
        fn resolve<'a>(
            &'a self,
            _host: &'a str,
        ) -> Pin<
            Box<dyn Future<Output = Result<Vec<std::net::IpAddr>, NetworkFetchError>> + Send + 'a>,
        > {
            Box::pin(async move { Ok(self.addresses.clone()) })
        }
    }

    struct NetworkTransportFixture {
        response: NetworkTransportResponse,
        delay: Duration,
    }

    impl NetworkTransport for NetworkTransportFixture {
        fn send<'a>(
            &'a self,
            _hop: &'a rho_server::plugin_network::NetworkHop,
            _maximum_bytes: u64,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<NetworkTransportResponse, NetworkFetchError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                tokio::time::sleep(self.delay).await;
                Ok(self.response.clone())
            })
        }
    }

    fn network_engine(
        addresses: Vec<std::net::IpAddr>,
        body: &[u8],
        delay: Duration,
        timeout: Duration,
    ) -> NetworkFetchEngine {
        NetworkFetchEngine::with_parts(
            Arc::new(NetworkResolverFixture { addresses }),
            Arc::new(NetworkTransportFixture {
                response: NetworkTransportResponse {
                    status: 200,
                    safe_headers: BTreeMap::from([
                        ("content-type".to_string(), "text/plain".to_string()),
                        ("set-cookie".to_string(), "secret=never".to_string()),
                    ]),
                    location: None,
                    body: body.to_vec(),
                },
                delay,
            }),
            timeout,
        )
    }

    #[test]
    fn zero_permission_plugin_enables_without_live_authority() {
        let directory = tempdir().unwrap();
        write_plugin(directory.path(), serde_json::json!([]));
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let registry = PendingPluginPermissionRegistry::default();
        let result = registry
            .request_enable(&context(directory.path()), "org.example.plugin", &mut store)
            .unwrap();
        assert_eq!(result.status, "enabled");
        assert_eq!(result.active_grant_count, 0);
        assert_eq!(
            registry
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .grants
                .active_handle_count(),
            0
        );
    }

    #[test]
    fn permission_decision_mints_fresh_handle_without_exposing_token() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "project.fs.read",
                "purpose": "Read bounded CSV inputs",
                "paths": ["data/**/*.csv"],
                "maxBytes": 1024
            }]),
        );
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = PendingPluginPermissionRegistry::default();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        assert_eq!(requested.status, "permission_required");
        let decision = registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_once".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        assert_eq!(decision.plugin_status, "enabled");
        assert_eq!(decision.active_grant_count, 1);
        let encoded = serde_json::to_string(&decision).unwrap();
        assert!(!encoded.contains("handle."));
        assert_eq!(
            registry
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .grants
                .active_handle_count(),
            1
        );
    }

    #[test]
    fn stale_revision_and_changed_digest_fail_without_activation() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "project.fs.read",
                "paths": ["data/**/*.csv"],
                "maxBytes": 1024
            }]),
        );
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = PendingPluginPermissionRegistry::default();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        let stale = PluginPermissionDecisionInput {
            request_id: requested.request_ids[0].clone(),
            decision: "allow_project".to_string(),
            expected_project_revision: 2,
        };
        assert!(registry.respond(&context, stale, &mut store).is_err());
        let entry = directory
            .path()
            .join(".rho/plugins/example/dist/plugin.wasm");
        let mut changed = fs::read(&entry).unwrap();
        changed.push(0);
        fs::write(entry, changed).unwrap();
        let allowed = registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_project".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        assert_eq!(allowed.outcome, PluginPermissionMutationOutcome::Applied);
        assert_eq!(allowed.plugin_status, "stale_digest");
        assert!(allowed.message.is_some());
        assert!(
            registry
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active
                .is_empty()
        );
    }

    #[test]
    fn durable_decision_reports_host_failure_without_claiming_live_authority() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "project.fs.read",
                "paths": ["data/**/*.csv"],
                "maxBytes": 1024
            }]),
        );
        fs::write(
            directory
                .path()
                .join(".rho/plugins/example/dist/plugin.wasm"),
            wat::parse_str(
                r#"(module
                    (memory (export "memory") 1 1)
                    (func (export "rho_activate") (param i32) (result i32) i32.const 1)
                    (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                    (func (export "rho_heartbeat") (result i32) i32.const 0)
                    (func (export "rho_quiesce") (result i32) i32.const 0)
                    (func (export "rho_dispose") (result i32) i32.const 0)
                    (func (export "rho_begin") (param i32 i32) (result i64) i64.const 0)
                    (func (export "rho_resume") (param i32 i32) (result i64) i64.const 0)
                    (func (export "rho_cancel") (param i32 i32) (result i32) i32.const 0))"#,
            )
            .unwrap(),
        )
        .unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = PendingPluginPermissionRegistry::default();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        let result = registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_project".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        assert_eq!(result.outcome, PluginPermissionMutationOutcome::Applied);
        assert_eq!(result.plugin_status, "host_unavailable");
        assert!(result.message.is_some());
        let state = registry
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(state.active.is_empty());
        assert_eq!(state.grants.active_handle_count(), 0);
        drop(state);
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("active"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn multi_permission_denial_remains_reviewable_until_all_requests_are_terminal() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([
                {
                    "name": "project.fs.read",
                    "paths": ["data/**/*.csv"],
                    "maxBytes": 1024
                },
                {
                    "name": "network.fetch",
                    "schemes": ["https"],
                    "hosts": ["api.example.org"],
                    "methods": ["GET"],
                    "maxResponseBytes": 2048
                }
            ]),
        );
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = PendingPluginPermissionRegistry::default();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        assert_eq!(requested.request_ids.len(), 2);
        let first = registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "deny".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        assert_eq!(first.plugin_status, "permission_required");
        let second = registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[1].clone(),
                    decision: "deny".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        assert_eq!(second.plugin_status, "denied");
        assert_eq!(second.active_grant_count, 0);
        assert!(
            registry
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active
                .is_empty()
        );
    }

    #[test]
    fn file_broker_call_yields_outside_wasm_consumes_once_and_persists_bounded_audit() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "project.fs.read",
                "paths": ["data/**/*.csv"],
                "maxBytes": 1024
            }]),
        );
        install_file_broker_module(directory.path());
        fs::create_dir_all(directory.path().join("data")).unwrap();
        fs::write(directory.path().join("data/input.csv"), b"abcde").unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let registry = deterministic_registry();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        let decision = registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_once".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        assert_eq!(decision.plugin_status, "enabled");
        let result = registry
            .invoke_plugin(
                &context,
                "org.example.plugin",
                serde_json::json!({"contribution": "test"}),
                &mut store,
            )
            .unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(result.result, Some(serde_json::json!({"received": true})));
        assert_eq!(result.broker_steps, 1);
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("consumed"))
                .unwrap()
                .len(),
            1
        );
        let events = PluginPermissionQueryService::new(&store)
            .list_events(&context.project_root, Some(100))
            .unwrap();
        for event_type in [
            "handle_minted",
            "call_admitted",
            "call_completed",
            "grant_consumed",
        ] {
            assert!(events.iter().any(|event| event.event_type == event_type));
        }
        assert!(!serde_json::to_string(&events).unwrap().contains("handle."));
    }

    #[test]
    fn revoke_during_file_read_withholds_bytes_and_records_stale_completion() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "project.fs.read",
                "paths": ["data/**/*.csv"],
                "maxBytes": 1024
            }]),
        );
        install_file_broker_module(directory.path());
        fs::create_dir_all(directory.path().join("data")).unwrap();
        fs::write(directory.path().join("data/input.csv"), b"abcde").unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = deterministic_registry();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_project".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        let result = registry
            .invoke_plugin_with_hook(
                &context,
                "org.example.plugin",
                serde_json::json!({}),
                &mut store,
                &mut |registry, store, grant_id| {
                    let revoked = registry.revoke(&context, grant_id, store)?;
                    ensure!(
                        revoked.outcome == PluginPermissionMutationOutcome::Applied,
                        "test revoke must apply"
                    );
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(result.status, "completed");
        let events = PluginPermissionQueryService::new(&store)
            .list_events(&context.project_root, Some(100))
            .unwrap();
        assert!(events.iter().any(|event| {
            event.event_type == "call_denied"
                && event.reason_code.as_deref() == Some("stale_after_dispatch")
        }));
        assert!(
            !events
                .iter()
                .any(|event| event.event_type == "call_completed")
        );
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("revoked"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn completion_persistence_failure_releases_once_reservation_and_retry_recovers() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "project.fs.read",
                "paths": ["data/**/*.csv"],
                "maxBytes": 1024
            }]),
        );
        install_file_broker_module(directory.path());
        fs::create_dir_all(directory.path().join("data")).unwrap();
        fs::write(directory.path().join("data/input.csv"), b"abcde").unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let registry = deterministic_registry();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_once".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        let injection = rusqlite::Connection::open(&database).unwrap();
        injection
            .execute_batch(
                "CREATE TRIGGER fail_desktop_plugin_completion
                 BEFORE INSERT ON plugin_permission_events
                 WHEN NEW.event_type = 'call_completed'
                 BEGIN SELECT RAISE(FAIL, 'injected desktop completion failure'); END;",
            )
            .unwrap();
        assert!(
            registry
                .invoke_plugin(
                    &context,
                    "org.example.plugin",
                    serde_json::json!({}),
                    &mut store,
                )
                .is_err()
        );
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("active"))
                .unwrap()
                .len(),
            1
        );
        injection
            .execute_batch("DROP TRIGGER fail_desktop_plugin_completion;")
            .unwrap();
        let retry = registry
            .invoke_plugin(
                &context,
                "org.example.plugin",
                serde_json::json!({}),
                &mut store,
            )
            .unwrap();
        assert_eq!(retry.status, "completed");
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("consumed"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn guest_resume_trap_records_failed_delivery_and_quarantines_session() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "project.fs.read",
                "paths": ["data/**/*.csv"],
                "maxBytes": 1024
            }]),
        );
        install_file_broker_module_with_resume(directory.path(), true);
        fs::create_dir_all(directory.path().join("data")).unwrap();
        fs::write(directory.path().join("data/input.csv"), b"abcde").unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = deterministic_registry();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_once".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        assert!(
            registry
                .invoke_plugin(
                    &context,
                    "org.example.plugin",
                    serde_json::json!({}),
                    &mut store,
                )
                .is_err()
        );
        assert!(
            registry
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .active
                .is_empty()
        );
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("consumed"))
                .unwrap()
                .len(),
            1
        );
        let events = PluginPermissionQueryService::new(&store)
            .list_events(&context.project_root, Some(100))
            .unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "call_completed")
        );
        assert!(events.iter().any(|event| {
            event.event_type == "call_failed"
                && event.reason_code.as_deref() == Some("guest_resume_failed")
        }));
    }

    #[tokio::test]
    async fn workspace_inspection_uses_fixed_request_consumes_once_and_strips_untrusted_source() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "workspace.r.inspect",
                "operations": ["preview"],
                "maxBytes": 262144
            }]),
        );
        install_workspace_broker_module(directory.path());
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let registry = deterministic_registry();
        let context = context(directory.path());
        let references = registry
            .issue_workspace_object_references(&context, &workspace_snapshot(&context))
            .unwrap();
        assert_eq!(references.len(), 1);
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_once".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        drop(store);
        let dispatcher = MockWorkspaceDispatcher {
            response: workspace_inspection_response(&context),
            current_workspace: protocol_workspace(&context),
            fail: false,
        };
        let result = registry
            .invoke_workspace_plugin(
                &context,
                "org.example.plugin",
                serde_json::json!({"contribution": "test"}),
                &database,
                &dispatcher,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(result.result, Some(serde_json::json!({"received": true})));
        let store = Store::open(&database).unwrap();
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("consumed"))
                .unwrap()
                .len(),
            1
        );
        let events = PluginPermissionQueryService::new(&store)
            .list_events(&context.project_root, Some(100))
            .unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "call_completed")
        );
        assert!(
            !serde_json::to_string(&events)
                .unwrap()
                .contains("function_source")
        );
    }

    #[tokio::test]
    async fn workspace_late_completion_and_crash_return_typed_errors_without_false_completion() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "workspace.r.inspect",
                "operations": ["preview"],
                "maxBytes": 262144
            }]),
        );
        install_workspace_broker_module(directory.path());
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let registry = deterministic_registry();
        let context = context(directory.path());
        registry
            .issue_workspace_object_references(&context, &workspace_snapshot(&context))
            .unwrap();
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_project".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        drop(store);

        let mut late_workspace = protocol_workspace(&context);
        late_workspace.state_revision += 1;
        let mut late_response = workspace_inspection_response(&context);
        late_response["workspace"] = serde_json::to_value(&late_workspace).unwrap();
        let late = MockWorkspaceDispatcher {
            response: late_response,
            current_workspace: late_workspace,
            fail: false,
        };
        let result = registry
            .invoke_workspace_plugin(
                &context,
                "org.example.plugin",
                serde_json::json!({}),
                &database,
                &late,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "completed");

        let crashing = MockWorkspaceDispatcher {
            response: serde_json::Value::Null,
            current_workspace: protocol_workspace(&context),
            fail: true,
        };
        let result = registry
            .invoke_workspace_plugin(
                &context,
                "org.example.plugin",
                serde_json::json!({}),
                &database,
                &crashing,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "completed");
        let store = Store::open(&database).unwrap();
        let events = PluginPermissionQueryService::new(&store)
            .list_events(&context.project_root, Some(100))
            .unwrap();
        assert!(events.iter().any(|event| {
            event.event_type == "call_denied"
                && event.reason_code.as_deref() == Some("stale_workspace")
        }));
        assert!(events.iter().any(|event| {
            event.event_type == "call_failed"
                && event.reason_code.as_deref() == Some("workspace_dispatch_failed")
        }));
        assert!(
            !events
                .iter()
                .any(|event| event.event_type == "call_completed")
        );
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("active"))
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn network_fetch_consumes_once_and_persists_only_bounded_metadata() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "network.fetch",
                "schemes": ["https"],
                "hosts": ["api.example.org"],
                "methods": ["GET"],
                "maxResponseBytes": 16
            }]),
        );
        install_network_broker_module(directory.path());
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let registry = deterministic_registry_with_network(network_engine(
            vec!["93.184.216.34".parse().unwrap()],
            b"hello",
            Duration::ZERO,
            Duration::from_secs(1),
        ));
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_once".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        drop(store);
        let result = registry
            .invoke_network_plugin(
                &context,
                "org.example.plugin",
                serde_json::json!({}),
                &database,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "completed");
        let store = Store::open(&database).unwrap();
        assert_eq!(
            PluginPermissionQueryService::new(&store)
                .list_grants(&context.project_root, None, Some("consumed"))
                .unwrap()
                .len(),
            1
        );
        let events = PluginPermissionQueryService::new(&store)
            .list_events(&context.project_root, Some(100))
            .unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "call_completed")
        );
        let encoded = serde_json::to_string(&events).unwrap();
        assert!(!encoded.contains("api.example.org"));
        assert!(!encoded.contains("set-cookie"));
        assert!(!encoded.contains("handle."));
    }

    #[tokio::test]
    async fn network_timeout_consumes_once_uncertain_while_private_dns_remains_retryable() {
        for (addresses, delay, timeout, expected_status, expected_event, reason) in [
            (
                vec!["93.184.216.34".parse().unwrap()],
                Duration::from_millis(20),
                Duration::from_millis(1),
                "consumed",
                "completion_uncertain",
                "network_timeout",
            ),
            (
                vec!["127.0.0.1".parse().unwrap()],
                Duration::ZERO,
                Duration::from_secs(1),
                "active",
                "call_failed",
                "non_public_address",
            ),
        ] {
            let directory = tempdir().unwrap();
            write_plugin(
                directory.path(),
                serde_json::json!([{
                    "name": "network.fetch",
                    "schemes": ["https"],
                    "hosts": ["api.example.org"],
                    "methods": ["GET"],
                    "maxResponseBytes": 16
                }]),
            );
            install_network_broker_module(directory.path());
            let database = directory.path().join("rho.sqlite");
            let mut store = Store::open(&database).unwrap();
            let registry = deterministic_registry_with_network(network_engine(
                addresses, b"ok", delay, timeout,
            ));
            let context = context(directory.path());
            let requested = registry
                .request_enable(&context, "org.example.plugin", &mut store)
                .unwrap();
            registry
                .respond(
                    &context,
                    PluginPermissionDecisionInput {
                        request_id: requested.request_ids[0].clone(),
                        decision: "allow_once".to_string(),
                        expected_project_revision: 3,
                    },
                    &mut store,
                )
                .unwrap();
            drop(store);
            let result = registry
                .invoke_network_plugin(
                    &context,
                    "org.example.plugin",
                    serde_json::json!({}),
                    &database,
                )
                .await
                .unwrap();
            assert_eq!(result.status, "completed");
            let store = Store::open(&database).unwrap();
            assert_eq!(
                PluginPermissionQueryService::new(&store)
                    .list_grants(&context.project_root, None, Some(expected_status))
                    .unwrap()
                    .len(),
                1
            );
            let events = PluginPermissionQueryService::new(&store)
                .list_events(&context.project_root, Some(100))
                .unwrap();
            assert!(events.iter().any(|event| {
                event.event_type == expected_event && event.reason_code.as_deref() == Some(reason)
            }));
            assert!(
                !events
                    .iter()
                    .any(|event| event.event_type == "call_completed")
            );
        }
    }

    #[test]
    fn live_network_authorizer_observes_durable_revoke_between_hops() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "network.fetch",
                "schemes": ["https"],
                "hosts": ["api.example.org"],
                "methods": ["GET"],
                "maxResponseBytes": 16
            }]),
        );
        install_network_broker_module(directory.path());
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = deterministic_registry();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_project".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        let key = registry_key(&context.project_root, "org.example.plugin");
        let template = {
            let mut state = registry
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let identity = state.active[&key].host.identity().clone();
            let request = RevalidationRequest {
                handle_id: format!("handle.{}", "07".repeat(32)),
                plugin_id: identity.plugin_id().clone(),
                host_instance_id: identity.host_instance_id().clone(),
                package_digest: identity.package_digest().clone(),
                project_id: identity.project_id().clone(),
                scope_id: identity.project_id().clone(),
                generation: identity.activation_generation(),
                permission: PermissionKind::NetworkFetch,
                permission_use: PermissionUse::NetworkFetch {
                    scheme: "https".to_string(),
                    host: "api.example.org".to_string(),
                    method: "GET".to_string(),
                    requested_response_bytes: 16,
                },
                workspace: None,
            };
            assert_eq!(
                state.grants.revalidate(request.clone()),
                Revalidation::Allowed
            );
            request
        };
        let authorizer = LiveNetworkAuthorizer {
            registry: &registry,
            key: &key,
            template,
        };
        let hop = NetworkHopAuthorization {
            scheme: "https".to_string(),
            host: "api.example.org".to_string(),
            method: "GET".to_string(),
            requested_response_bytes: 16,
        };
        assert!(authorizer.authorize(&hop).is_ok());
        let grant_id = PluginPermissionQueryService::new(&store)
            .list_grants(&context.project_root, None, Some("active"))
            .unwrap()[0]
            .grant_id
            .clone();
        registry.revoke(&context, &grant_id, &mut store).unwrap();
        assert_eq!(
            authorizer.authorize(&hop).unwrap_err().code,
            NetworkFetchErrorCode::AuthorizationDenied
        );
    }

    #[test]
    fn concurrent_top_level_call_is_rejected_without_quarantining_inflight_guest() {
        let directory = tempdir().unwrap();
        write_plugin(
            directory.path(),
            serde_json::json!([{
                "name": "project.fs.read",
                "paths": ["data/**/*.csv"],
                "maxBytes": 1024
            }]),
        );
        install_file_broker_module(directory.path());
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = deterministic_registry();
        let context = context(directory.path());
        let requested = registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry
            .respond(
                &context,
                PluginPermissionDecisionInput {
                    request_id: requested.request_ids[0].clone(),
                    decision: "allow_project".to_string(),
                    expected_project_revision: 3,
                },
                &mut store,
            )
            .unwrap();
        let key = registry_key(&context.project_root, "org.example.plugin");
        let inflight = HostRequestId::new("request.inflight").unwrap();
        {
            let mut state = registry
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .active
                .get_mut(&key)
                .unwrap()
                .host
                .begin_broker_call(inflight.clone(), serde_json::json!({}))
                .unwrap();
        }
        let error = registry
            .invoke_plugin(
                &context,
                "org.example.plugin",
                serde_json::json!({}),
                &mut store,
            )
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("already has an active broker call")
        );
        let mut state = registry
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let host = &mut state.active.get_mut(&key).unwrap().host;
        assert_eq!(
            host.state(),
            rho_extension_runtime::HostInstanceState::Active
        );
        assert!(host.broker_call_active());
        assert!(host.cancel_broker_call(&inflight).unwrap());
    }

    #[test]
    fn project_invalidation_removes_sessions_and_handles() {
        let directory = tempdir().unwrap();
        write_plugin(directory.path(), serde_json::json!([]));
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let registry = PendingPluginPermissionRegistry::default();
        let context = context(directory.path());
        registry
            .request_enable(&context, "org.example.plugin", &mut store)
            .unwrap();
        registry.invalidate_project(&context.project_root);
        let state = registry
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(state.active.is_empty());
        assert!(state.pending.is_empty());
    }
}
