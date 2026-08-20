//! Trusted application coordination for project-local workspace plugins.
//!
//! P2-2B owns discovery projection, explicit enable requests, the dedicated
//! permission lane, and fresh in-memory handles. It intentionally exposes no
//! filesystem, network, Workspace R, contribution, install, or update call.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow, bail, ensure};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rho_extension_runtime::{
    ActivationGeneration, CapabilityHandle, DiscoveredPlugin, GrantRequest, GrantSource,
    GrantStore, HOST_PROTOCOL_VERSION, HostFrame, HostInstanceId, HostMessage, HostResponse,
    MAX_WASM_MODULE_BYTES, PermissionConstraints, PermissionKind, PluginId, RuntimeKind, ScopeId,
    WasmHostIdentity, WasmPluginHost, WorkspaceGrantIdentity, discover_workspace_plugins,
};
use rho_store::{
    PluginPermissionDecision, PluginPermissionDecisionDraft, PluginPermissionGrant,
    PluginPermissionMutationOutcome, PluginPermissionMutationService, PluginPermissionQueryService,
    PluginPermissionRequest, PluginPermissionRequestDraft, Store, normalize_project_root,
};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone)]
pub(crate) struct PluginRuntimeContext {
    pub project_root: String,
    pub project_revision: i64,
    pub project_scope_id: ScopeId,
    pub workspace: Option<WorkspaceGrantIdentity>,
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
    _host: WasmPluginHost,
    handles: BTreeMap<String, CapabilityHandle>,
}

struct RegistryState {
    next_generation: u64,
    pending: BTreeMap<String, PendingEnable>,
    active: BTreeMap<String, ActivePlugin>,
    grants: GrantStore,
}

impl Default for RegistryState {
    fn default() -> Self {
        Self {
            next_generation: 1,
            pending: BTreeMap::new(),
            active: BTreeMap::new(),
            grants: GrantStore::new(),
        }
    }
}

#[derive(Default)]
pub(crate) struct PendingPluginPermissionRegistry {
    state: Mutex<RegistryState>,
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

        activate_plugin(&mut state, context, &plugin, reusable_grants.values())
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
        invalidated
    }
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
    store: &Store,
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
    )?;
    state.pending.remove(&key);
    Ok((result.status, result.active_grant_count))
}

fn activate_plugin<'a>(
    state: &mut RegistryState,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
    durable_grants: impl IntoIterator<Item = &'a PluginPermissionGrant>,
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
    let mut host = WasmPluginHost::from_bytes(identity, &module_bytes)
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
            _host: host,
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
    use rho_extension_runtime::P2_1_SMOKE_WASM;
    use tempfile::tempdir;

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
        let root = normalize_project_root(project.to_string_lossy().as_ref());
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

    #[test]
    fn zero_permission_plugin_enables_without_live_authority() {
        let directory = tempdir().unwrap();
        write_plugin(directory.path(), serde_json::json!([]));
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
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
