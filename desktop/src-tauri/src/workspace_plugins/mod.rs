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
mod contracts;
mod contributions;
mod discovery;
mod lifecycle;
mod permissions;
mod runtime_calls;
mod upgrade;
mod workspace_dispatch;

pub(crate) use contracts::*;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReconciliationStatus {
    Reactivated,
    AlreadyActive,
    PermissionRequired,
    UpdatePending,
    Blocked,
    Skipped,
}

impl ReconciliationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Reactivated => "reactivated",
            Self::AlreadyActive => "already_active",
            Self::PermissionRequired => "permission_required",
            Self::UpdatePending => "update_pending",
            Self::Blocked => "blocked",
            Self::Skipped => "skipped",
        }
    }

    fn reason_code(self) -> &'static str {
        match self {
            Self::Reactivated => "exact_restart_reactivation",
            Self::AlreadyActive => "exact_route_already_active",
            Self::PermissionRequired => "fresh_permission_review_required",
            Self::UpdatePending => "package_digest_changed",
            Self::Blocked => "recovery_blocked",
            Self::Skipped => "durable_enable_not_eligible",
        }
    }
}

fn increment_reconciliation_status(
    report: &mut WorkspacePluginReconciliationReport,
    status: ReconciliationStatus,
) {
    match status {
        ReconciliationStatus::Reactivated => report.reactivated += 1,
        ReconciliationStatus::AlreadyActive => report.already_active += 1,
        ReconciliationStatus::PermissionRequired => report.permission_required += 1,
        ReconciliationStatus::UpdatePending => report.update_pending += 1,
        ReconciliationStatus::Blocked => report.blocked += 1,
        ReconciliationStatus::Skipped => report.skipped += 1,
    }
}

fn push_reconciliation_entry(
    report: &mut WorkspacePluginReconciliationReport,
    entry: WorkspacePluginReconciliationEntry,
) {
    if report.entries.len() < MAX_PLUGIN_RECONCILIATION_ENTRIES {
        report.entries.push(entry);
    } else {
        report.truncated = true;
    }
}

fn push_boundary_teardown_entry(
    report: &mut WorkspacePluginBoundaryTeardownReport,
    entry: WorkspacePluginBoundaryTeardownEntry,
) {
    if report.entries.len() < MAX_PLUGIN_RECONCILIATION_ENTRIES {
        report.entries.push(entry);
    } else {
        report.truncated = true;
    }
}

fn bounded_reconciliation_reason(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("permission") || lower.contains("grant") {
        "permission_recovery_failed"
    } else if lower.contains("cache") || lower.contains("package") || lower.contains("digest") {
        "package_recovery_failed"
    } else if lower.contains("sqlite")
        || lower.contains("store")
        || lower.contains("persist")
        || lower.contains("transition")
    {
        "persistence_recovery_failed"
    } else if lower.contains("host") || lower.contains("wasm") || lower.contains("activation") {
        "host_recovery_failed"
    } else {
        "plugin_recovery_failed"
    }
    .to_string()
}

fn recover_project_plugin_files(
    context: &PluginRuntimeContext,
    store: &mut Store,
    report: &mut WorkspacePluginReconciliationReport,
) {
    let transitions = match PluginLifecycleQueryService::new(store)
        .list_nonterminal_transitions(&context.project_root, Some(256))
    {
        Ok(transitions) => transitions,
        Err(error) => {
            report.recovery_required += 1;
            push_reconciliation_entry(
                report,
                WorkspacePluginReconciliationEntry {
                    plugin_id: None,
                    status: "recovery_required".to_string(),
                    reason_code: bounded_reconciliation_reason(&error.to_string()),
                },
            );
            return;
        }
    };
    for transition in transitions {
        if transition.kind == "uninstall" {
            let recovered = (|| -> Result<PluginPackageOwnershipOutcome> {
                let lifecycle = PluginLifecycleQueryService::new(store)
                    .get_state(&context.project_root, &transition.plugin_id)?
                    .context("Uninstall recovery lifecycle state is missing")?;
                let digest = transition
                    .expected_old_digest
                    .as_deref()
                    .context("Uninstall recovery expected digest is missing")?;
                let trash_key = transition
                    .backup_path_key
                    .as_deref()
                    .context("Uninstall recovery trash key is missing")?;
                ensure!(
                    lifecycle.desired_state == "uninstalled"
                        && lifecycle.accepted_digest.as_deref() == Some(digest)
                        && lifecycle.transition_id.as_deref()
                            == Some(transition.transition_id.as_str()),
                    "Uninstall recovery durable identity is stale"
                );
                let moved = PluginPackageTrash::new().move_exact(
                    Path::new(&context.project_root),
                    &lifecycle.directory_name,
                    &transition.plugin_id,
                    digest,
                    trash_key,
                )?;
                if transition.phase != "package_moved" {
                    record_disable_phase(
                        store,
                        context,
                        &transition.transition_id,
                        &transition.phase,
                        "package_moved",
                        "running",
                        "disposing",
                        "recovery",
                        "completed",
                        None,
                        serde_json::json!({"package_ownership":"trash","recovered":true}),
                    )?;
                }
                let mut hasher = Sha256::new();
                hasher.update(transition.transition_id.as_bytes());
                let tombstone_id = format!("tombstone.recovery.{:x}", hasher.finalize());
                let completed = PluginLifecycleMutationService::new(store).complete_uninstall(
                    &context.project_root,
                    &transition.transition_id,
                    &WorkspacePluginTombstoneDraft {
                        tombstone_id,
                        project_root: context.project_root.clone(),
                        plugin_id: transition.plugin_id.clone(),
                        package_digest: digest.to_string(),
                        backup_path_key: trash_key.to_string(),
                        original_directory_name: lifecycle.directory_name,
                        retention_class: "recoverable".to_string(),
                        reason_code: "user_uninstall".to_string(),
                    },
                )?;
                ensure!(
                    matches!(
                        completed.outcome,
                        PluginLifecycleMutationOutcome::Applied
                            | PluginLifecycleMutationOutcome::Unchanged
                    ),
                    "Uninstall recovery terminal completion was stale"
                );
                Ok(moved.outcome)
            })();
            match recovered {
                Ok(outcome) => {
                    report.recovered_uninstalls += 1;
                    report.project_files_changed |= outcome == PluginPackageOwnershipOutcome::Moved;
                    push_reconciliation_entry(
                        report,
                        WorkspacePluginReconciliationEntry {
                            plugin_id: Some(transition.plugin_id),
                            status: "recovered".to_string(),
                            reason_code: "uninstall_completed".to_string(),
                        },
                    );
                }
                Err(error) => {
                    report.recovery_required += 1;
                    let reason = bounded_reconciliation_reason(&error.to_string());
                    let _ = PluginLifecycleMutationService::new(store).record_recovery_required(
                        &context.project_root,
                        &transition.plugin_id,
                        Some(&transition.transition_id),
                        &reason,
                    );
                    push_reconciliation_entry(
                        report,
                        WorkspacePluginReconciliationEntry {
                            plugin_id: Some(transition.plugin_id),
                            status: "recovery_required".to_string(),
                            reason_code: reason,
                        },
                    );
                }
            }
        } else if matches!(transition.kind.as_str(), "upgrade" | "rollback") {
            match fail_enable_transition(
                store,
                context,
                &transition.transition_id,
                "broker_restart_reconciled",
                "disabled",
            ) {
                Ok(()) => report.recovered_replacements += 1,
                Err(error) => {
                    report.recovery_required += 1;
                    push_reconciliation_entry(
                        report,
                        WorkspacePluginReconciliationEntry {
                            plugin_id: Some(transition.plugin_id),
                            status: "recovery_required".to_string(),
                            reason_code: bounded_reconciliation_reason(&error.to_string()),
                        },
                    );
                }
            }
        }
    }

    let pending_purges = PluginLifecycleQueryService::new(store)
        .list_tombstones(&context.project_root, Some(200))
        .map(|tombstones| {
            tombstones
                .into_iter()
                .filter(|tombstone| {
                    tombstone.retention_class == "purge_pending"
                        && tombstone.deleted_at.is_none()
                        && tombstone.restored_at.is_none()
                })
                .collect::<Vec<_>>()
        });
    match pending_purges {
        Ok(tombstones) => {
            let retention = PluginTrashRetentionService::new();
            for tombstone in tombstones {
                match retention.purge_exact_tombstone(
                    store,
                    &context.project_root,
                    &tombstone.tombstone_id,
                ) {
                    Ok(purged) => {
                        report.recovered_purges += 1;
                        report.project_files_changed |=
                            purged.file_outcome == PluginPackageOwnershipOutcome::Purged;
                    }
                    Err(error) => {
                        report.recovery_required += 1;
                        push_reconciliation_entry(
                            report,
                            WorkspacePluginReconciliationEntry {
                                plugin_id: Some(tombstone.plugin_id),
                                status: "recovery_required".to_string(),
                                reason_code: bounded_reconciliation_reason(&error.to_string()),
                            },
                        );
                    }
                }
            }
        }
        Err(error) => {
            report.recovery_required += 1;
            push_reconciliation_entry(
                report,
                WorkspacePluginReconciliationEntry {
                    plugin_id: None,
                    status: "recovery_required".to_string(),
                    reason_code: bounded_reconciliation_reason(&error.to_string()),
                },
            );
        }
    }
}

fn reconcile_discovered_plugin(
    registry: &mut RegistryState,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
    store: &mut Store,
) -> Result<ReconciliationStatus> {
    let (_, lifecycle) = PluginLifecycleMutationService::new(store).discover(
        &context.project_root,
        &WorkspacePluginDiscoveredDraft {
            project_root: context.project_root.clone(),
            plugin_id: plugin.manifest.id.to_string(),
            directory_name: plugin.directory.clone(),
            plugin_version: plugin.manifest.version.to_string(),
            runtime_kind: plugin.manifest.runtime.kind.to_string(),
            discovered_digest: plugin.digest.to_string(),
        },
    )?;
    let key = registry_key(&context.project_root, plugin.manifest.id.as_str());
    if lifecycle.desired_state != "enabled" {
        remove_active_plugin(registry, &key);
        return Ok(ReconciliationStatus::Skipped);
    }
    if matches!(lifecycle.observed_state.as_str(), "crashed" | "blocked") {
        remove_active_plugin(registry, &key);
        return Ok(ReconciliationStatus::Blocked);
    }
    if registry.active.get(&key).is_some_and(|active| {
        active.package_digest == plugin.digest.as_str()
            && active.plugin_version == plugin.manifest.version.to_string()
    }) && lifecycle.observed_state == "active"
        && lifecycle.accepted_digest.as_deref() == Some(plugin.digest.as_str())
    {
        return Ok(ReconciliationStatus::AlreadyActive);
    }

    let prior_observed = lifecycle.observed_state.clone();
    let last_transition = lifecycle
        .transition_id
        .as_deref()
        .map(|transition_id| {
            PluginLifecycleQueryService::new(store)
                .get_transition(&context.project_root, transition_id)
        })
        .transpose()?
        .flatten();
    let stopped_by_boundary = prior_observed == "stopped"
        && last_transition.as_ref().is_some_and(|transition| {
            matches!(transition.kind.as_str(), "project_teardown" | "shutdown")
                && transition.status == "completed"
        });
    let nonterminal = last_transition.clone().filter(|transition| {
        matches!(
            transition.status.as_str(),
            "pending" | "running" | "completion_uncertain"
        )
    });
    let had_nonterminal = nonterminal.is_some();
    if let Some(transition) = nonterminal {
        fail_enable_transition(
            store,
            context,
            &transition.transition_id,
            "broker_restart_reconciled",
            "disabled",
        )?;
    }
    let lifecycle = PluginLifecycleQueryService::new(store)
        .get_state(&context.project_root, plugin.manifest.id.as_str())?
        .context("plugin lifecycle state disappeared during restart reconciliation")?;
    let mut recovery_plugin = plugin.clone();
    let mut recovery_cache = None;
    let mut rollback_cache_pair = false;
    let interrupted_replacement = last_transition.as_ref().is_some_and(|transition| {
        matches!(transition.kind.as_str(), "upgrade" | "rollback")
            && transition.status == "failed"
            && transition.reason_code.as_deref() == Some("broker_restart_reconciled")
            && transition.expected_old_digest == lifecycle.accepted_digest
            && transition.candidate_digest.as_deref() == Some(plugin.digest.as_str())
    });
    let target_digest = if let Some(accepted) = lifecycle.accepted_digest.as_deref() {
        if accepted != plugin.digest.as_str() {
            if lifecycle.rollback_digest.as_deref() == Some(plugin.digest.as_str())
                || interrupted_replacement
            {
                let cached = PluginPackageCache::new(&context.app_data_dir)
                    .load_exact(&context.project_root, plugin.manifest.id.as_str(), accepted)
                    .context("accepted Rollback cache is unavailable during restart")?;
                recovery_plugin = discovered_from_cache(&lifecycle.directory_name, &cached);
                ensure!(
                    recovery_plugin.manifest.id == plugin.manifest.id
                        && recovery_plugin.digest.as_str() == accepted,
                    "accepted Rollback cache identity changed during restart"
                );
                recovery_cache = Some(cached);
                rollback_cache_pair = true;
            } else {
                remove_active_plugin(registry, &key);
                return Ok(ReconciliationStatus::UpdatePending);
            }
        }
        if prior_observed != "active"
            && !had_nonterminal
            && !stopped_by_boundary
            && !rollback_cache_pair
        {
            remove_active_plugin(registry, &key);
            persist_recovery_block(store, context, &lifecycle, "unprovable_restart_state")?;
            return Ok(ReconciliationStatus::Blocked);
        }
        accepted.to_string()
    } else if had_nonterminal && lifecycle.pending_digest.as_deref() == Some(plugin.digest.as_str())
    {
        plugin.digest.to_string()
    } else {
        remove_active_plugin(registry, &key);
        return Ok(ReconciliationStatus::Skipped);
    };
    remove_active_plugin(registry, &key);
    let (transition_id, cached) = match prepare_recovery_enable_transition(
        store,
        context,
        &recovery_plugin,
        &target_digest,
        recovery_cache,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            if PluginLifecycleQueryService::new(store)
                .get_state(&context.project_root, plugin.manifest.id.as_str())?
                .is_some_and(|state| state.observed_state == "blocked")
            {
                return Ok(ReconciliationStatus::Blocked);
            }
            return Err(error);
        }
    };
    let (reusable_grants, requests) =
        match plan_plugin_permissions(store, context, &recovery_plugin) {
            Ok(plan) => plan,
            Err(error) => {
                if fail_enable_transition(
                    store,
                    context,
                    &transition_id,
                    "permission_plan_failed",
                    "blocked",
                )
                .is_ok()
                {
                    return Ok(ReconciliationStatus::Blocked);
                }
                return Err(error);
            }
        };
    if !requests.is_empty() {
        let created = match PluginPermissionMutationService::new(store)
            .create_requests(&context.project_root, &requests)
        {
            Ok(created) => created,
            Err(error) => {
                if fail_enable_transition(
                    store,
                    context,
                    &transition_id,
                    "permission_request_failed",
                    "blocked",
                )
                .is_ok()
                {
                    return Ok(ReconciliationStatus::Blocked);
                }
                return Err(error.into());
            }
        };
        let request_ids = created
            .into_iter()
            .map(|request| request.request_id)
            .collect::<Vec<_>>();
        registry.pending.insert(
            key,
            PendingEnable {
                kind: PendingActivationKind::Enable,
                plugin_id: recovery_plugin.manifest.id.to_string(),
                plugin_version: recovery_plugin.manifest.version.to_string(),
                package_digest: recovery_plugin.digest.to_string(),
                transition_id,
                request_ids,
                expected_project_revision: context.project_revision,
            },
        );
        return Ok(ReconciliationStatus::PermissionRequired);
    }
    activate_plugin_durable(
        registry,
        context,
        &recovery_plugin,
        &cached,
        &transition_id,
        reusable_grants.values(),
        store,
    )?;
    Ok(ReconciliationStatus::Reactivated)
}

fn prepare_recovery_enable_transition(
    store: &mut Store,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
    target_digest: &str,
    cached_override: Option<CachedPluginPackage>,
) -> Result<(String, CachedPluginPackage)> {
    ensure!(
        plugin.digest.as_str() == target_digest,
        "restart package digest changed before transition preparation"
    );
    let transition_id = format!("transition.recovery.{}", uuid::Uuid::new_v4().simple());
    let requested = PluginLifecycleMutationService::new(store).request_transition(
        &context.project_root,
        &WorkspacePluginTransitionDraft {
            transition_id: transition_id.clone(),
            project_root: context.project_root.clone(),
            plugin_id: plugin.manifest.id.to_string(),
            kind: "enable".to_string(),
            request_event_type: "recovery".to_string(),
            desired_state: "enabled".to_string(),
            expected_old_digest: None,
            candidate_digest: Some(target_digest.to_string()),
            rollback_digest: None,
            backup_path_key: None,
        },
    )?;
    ensure!(
        matches!(
            requested.outcome,
            PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
        ),
        "restart enable conflicts with another lifecycle transition"
    );
    advance_enable_transition(
        store,
        context,
        &transition_id,
        "requested",
        "preflight",
        "running",
        "resolving",
        None,
        false,
        None,
        "recovery",
        "completed",
        None,
    )?;
    let cached = if let Some(cached) = cached_override {
        ensure!(
            cached.plugin_id == plugin.manifest.id.as_str()
                && cached.package_digest == target_digest
                && cached.snapshot.manifest == plugin.manifest
                && cached.snapshot.digest == plugin.digest,
            "Rollback recovery cache does not match accepted target"
        );
        cached
    } else {
        match PluginPackageCache::new(&context.app_data_dir).prepare_exact(
            Path::new(&context.project_root),
            plugin.manifest.id.as_str(),
            target_digest,
        ) {
            Ok(cached) => cached,
            Err(error) => {
                let _ = fail_enable_transition(
                    store,
                    context,
                    &transition_id,
                    "package_cache_failed",
                    "blocked",
                );
                return Err(error.into());
            }
        }
    };
    advance_enable_transition(
        store,
        context,
        &transition_id,
        "preflight",
        "backup_prepared",
        "running",
        "resolving",
        None,
        false,
        None,
        "package_backed_up",
        "completed",
        None,
    )?;
    Ok((transition_id, cached))
}

fn prepare_retry_transition(
    store: &mut Store,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
) -> Result<(String, CachedPluginPackage)> {
    let transition_id = format!("transition.retry.{}", uuid::Uuid::new_v4().simple());
    let requested = PluginLifecycleMutationService::new(store).request_transition(
        &context.project_root,
        &WorkspacePluginTransitionDraft {
            transition_id: transition_id.clone(),
            project_root: context.project_root.clone(),
            plugin_id: plugin.manifest.id.to_string(),
            kind: "retry".to_string(),
            request_event_type: "user_requested".to_string(),
            desired_state: "enabled".to_string(),
            expected_old_digest: None,
            candidate_digest: Some(plugin.digest.to_string()),
            rollback_digest: None,
            backup_path_key: None,
        },
    )?;
    ensure!(
        matches!(
            requested.outcome,
            PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
        ),
        "plugin Retry conflicts with another lifecycle transition"
    );
    advance_enable_transition(
        store,
        context,
        &transition_id,
        "requested",
        "preflight",
        "running",
        "resolving",
        None,
        false,
        None,
        "preflight",
        "completed",
        None,
    )?;
    let cached = match PluginPackageCache::new(&context.app_data_dir).prepare_exact(
        Path::new(&context.project_root),
        plugin.manifest.id.as_str(),
        plugin.digest.as_str(),
    ) {
        Ok(cached) => cached,
        Err(error) => {
            let _ = fail_enable_transition(
                store,
                context,
                &transition_id,
                "retry_package_cache_failed",
                "crashed",
            );
            return Err(error.into());
        }
    };
    if let Err(error) = advance_enable_transition(
        store,
        context,
        &transition_id,
        "preflight",
        "backup_prepared",
        "running",
        "resolving",
        None,
        false,
        None,
        "package_backed_up",
        "completed",
        None,
    ) {
        let _ = fail_enable_transition(
            store,
            context,
            &transition_id,
            "retry_backup_journal_failed",
            "crashed",
        );
        return Err(error);
    }
    Ok((transition_id, cached))
}

fn persist_missing_plugin_block(
    store: &mut Store,
    context: &PluginRuntimeContext,
    lifecycle: &WorkspacePluginState,
) -> Result<()> {
    persist_recovery_block(store, context, lifecycle, "package_missing")
}

fn persist_recovery_block(
    store: &mut Store,
    context: &PluginRuntimeContext,
    lifecycle: &WorkspacePluginState,
    reason_code: &str,
) -> Result<()> {
    if lifecycle.observed_state == "blocked" {
        return Ok(());
    }
    if let Some(transition_id) = lifecycle.transition_id.as_deref()
        && let Some(transition) = PluginLifecycleQueryService::new(store)
            .get_transition(&context.project_root, transition_id)?
        && matches!(
            transition.status.as_str(),
            "pending" | "running" | "completion_uncertain"
        )
    {
        return fail_enable_transition(store, context, transition_id, reason_code, "blocked");
    }
    let candidate_digest = lifecycle
        .accepted_digest
        .as_ref()
        .or(lifecycle.pending_digest.as_ref())
        .context("blocked plugin recovery has no exact durable package digest")?;
    let transition_id = format!("transition.recovery.{}", uuid::Uuid::new_v4().simple());
    let requested = PluginLifecycleMutationService::new(store).request_transition(
        &context.project_root,
        &WorkspacePluginTransitionDraft {
            transition_id: transition_id.clone(),
            project_root: context.project_root.clone(),
            plugin_id: lifecycle.plugin_id.clone(),
            kind: "enable".to_string(),
            request_event_type: "recovery".to_string(),
            desired_state: "enabled".to_string(),
            expected_old_digest: None,
            candidate_digest: Some(candidate_digest.clone()),
            rollback_digest: None,
            backup_path_key: None,
        },
    )?;
    ensure!(
        matches!(
            requested.outcome,
            PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
        ),
        "blocked plugin recovery transition conflicted"
    );
    fail_enable_transition(store, context, &transition_id, reason_code, "blocked")
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
) -> Result<String> {
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
    lifecycle: Option<&WorkspacePluginState>,
    recoverable_tombstone_id: Option<&str>,
    purge_recovery_required: bool,
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
    let active = state
        .active
        .get(&registry_key(project_root, &plugin_id))
        .filter(|active| {
            active.project_root == project_root
                && active.package_digest == plugin.digest.as_str()
                && active.plugin_version == plugin.manifest.version.to_string()
        });
    let durable_active = lifecycle.is_some_and(|lifecycle| {
        lifecycle.desired_state == "enabled"
            && lifecycle.observed_state == "active"
            && lifecycle.accepted_digest.as_deref() == Some(plugin.digest.as_str())
    });
    let recovery_required = purge_recovery_required
        || lifecycle.is_some_and(|lifecycle| {
            lifecycle.observed_state == "blocked"
                && lifecycle
                    .last_error_code
                    .as_deref()
                    .is_some_and(|code| code.contains("recovery"))
        });
    let status = if recovery_required {
        "recovery_required"
    } else if active.is_some() && durable_active {
        "enabled"
    } else if pending_request_count > 0 {
        "permission_required"
    } else if lifecycle.is_some_and(|lifecycle| {
        lifecycle.desired_state == "enabled"
            && lifecycle.accepted_digest.is_some()
            && lifecycle.accepted_digest.as_deref() != Some(plugin.digest.as_str())
    }) {
        "update_pending"
    } else if lifecycle.is_some_and(|lifecycle| {
        lifecycle.desired_state == "enabled"
            && matches!(
                lifecycle.observed_state.as_str(),
                "resolving" | "activating"
            )
    }) {
        "enabling"
    } else if requests
        .iter()
        .filter(exact_request)
        .any(|request| request.status == "denied")
    {
        "denied"
    } else {
        match lifecycle.map(|lifecycle| lifecycle.observed_state.as_str()) {
            Some("update_pending") => "update_pending",
            Some("blocked") => "blocked",
            Some("crashed") => "crashed",
            Some("uninstalled") => "uninstalled",
            _ => "disabled",
        }
    };
    let desired_state = lifecycle
        .map(|lifecycle| lifecycle.desired_state.clone())
        .unwrap_or_else(|| "disabled".to_string());
    let observed_state = lifecycle
        .map(|lifecycle| lifecycle.observed_state.clone())
        .unwrap_or_else(|| "discovered".to_string());
    WorkspacePluginView {
        plugin_id,
        directory_name: plugin.directory.clone(),
        name: plugin.manifest.name.clone(),
        version: plugin.manifest.version.to_string(),
        package_digest: plugin.digest.to_string(),
        short_digest: plugin.digest.as_str()[..12].to_string(),
        runtime_kind: plugin.manifest.runtime.kind.to_string(),
        permission_count: plugin.manifest.permissions.len(),
        pending_request_count,
        active_grant_count,
        status: status.to_string(),
        desired_state,
        observed_state,
        accepted_digest: lifecycle.and_then(|lifecycle| lifecycle.accepted_digest.clone()),
        rollback_digest: lifecycle.and_then(|lifecycle| lifecycle.rollback_digest.clone()),
        transition_id: lifecycle.and_then(|lifecycle| lifecycle.transition_id.clone()),
        recoverable_tombstone_id: recoverable_tombstone_id.map(str::to_string),
        message: if plugin.manifest.runtime.kind != RuntimeKind::Wasm {
            Some("This runtime kind is not executable in Phase 2.".to_string())
        } else {
            match status {
                "enabling" => Some(
                    "The durable enable transition has not completed; no enabled result is claimed."
                        .to_string(),
                ),
                "update_pending" => Some(
                    "The package digest changed. Review the exact local Update before replacing the accepted runtime."
                        .to_string(),
                ),
                "blocked" => Some(
                    "The plugin is blocked and remains non-routable pending trusted recovery."
                        .to_string(),
                ),
                "crashed" => Some(
                    "The plugin crashed and remains non-routable. Use trusted Retry to create fresh authority."
                        .to_string(),
                ),
                "recovery_required" => Some(
                    "Rho could not prove one exact lifecycle recovery step. The plugin remains non-routable and no completion is claimed."
                        .to_string(),
                ),
                _ => None,
            }
        },
    }
}

fn missing_workspace_plugin_view(
    lifecycle: &WorkspacePluginState,
    requests: &[PluginPermissionRequest],
    grants: &[PluginPermissionGrant],
    recoverable_tombstone_id: Option<&str>,
    purge_recovery_required: bool,
) -> WorkspacePluginView {
    let package_digest = lifecycle
        .pending_digest
        .as_ref()
        .or(lifecycle.accepted_digest.as_ref())
        .cloned()
        .unwrap_or_default();
    let pending_request_count = requests
        .iter()
        .filter(|request| request.plugin_id == lifecycle.plugin_id && request.status == "pending")
        .count();
    let active_grant_count = grants
        .iter()
        .filter(|grant| grant.plugin_id == lifecycle.plugin_id && grant.status == "active")
        .count();
    WorkspacePluginView {
        plugin_id: lifecycle.plugin_id.clone(),
        directory_name: lifecycle.directory_name.clone(),
        name: lifecycle.plugin_id.clone(),
        version: lifecycle.plugin_version.clone(),
        short_digest: package_digest.chars().take(12).collect(),
        package_digest,
        runtime_kind: lifecycle.runtime_kind.clone(),
        permission_count: 0,
        pending_request_count,
        active_grant_count,
        status: if purge_recovery_required
            || (lifecycle.observed_state == "blocked"
                && lifecycle
                    .last_error_code
                    .as_deref()
                    .is_some_and(|code| code.contains("recovery")))
        {
            "recovery_required"
        } else {
            match lifecycle.observed_state.as_str() {
                "crashed" => "crashed",
                "update_pending" => "update_pending",
                "uninstalled" => "uninstalled",
                _ => "blocked",
            }
        }
        .to_string(),
        desired_state: lifecycle.desired_state.clone(),
        observed_state: lifecycle.observed_state.clone(),
        accepted_digest: lifecycle.accepted_digest.clone(),
        rollback_digest: lifecycle.rollback_digest.clone(),
        transition_id: lifecycle.transition_id.clone(),
        recoverable_tombstone_id: recoverable_tombstone_id.map(str::to_string),
        message: Some(
            if purge_recovery_required
                || lifecycle
                    .last_error_code
                    .as_deref()
                    .is_some_and(|code| code.contains("recovery"))
            {
                "Rho could not prove one exact lifecycle recovery step. The plugin remains non-routable and no completion is claimed."
                .to_string()
            } else if lifecycle.observed_state == "uninstalled" {
                "The exact package is in recoverable Rho trash. Restore returns it disabled and grants no authority."
                .to_string()
            } else {
                "The durable plugin identity is unavailable from the current discovery root and remains non-routable."
                .to_string()
            },
        ),
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

fn contribution_kind_name(kind: ContributionKind) -> &'static str {
    match kind {
        ContributionKind::Command => "command",
        ContributionKind::Viewer => "viewer",
        ContributionKind::Source => "source",
        ContributionKind::Tool => "tool",
        ContributionKind::Skill => "skill",
        ContributionKind::Panel => "panel",
        ContributionKind::Surface => "surface",
        ContributionKind::CheckRule => "check_rule",
    }
}

fn validate_command_result_artifacts(
    store: &Store,
    context: &PluginRuntimeContext,
    result: &PluginCommandResultV1,
) -> Result<()> {
    match result {
        PluginCommandResultV1::Notification { .. } => Ok(()),
        PluginCommandResultV1::ViewerDocument { document } => {
            validate_viewer_artifacts(store, context, document)
        }
        PluginCommandResultV1::ArtifactRef { artifact_id } => {
            validate_same_project_artifact(store, context, artifact_id, None)
        }
    }
}

fn validate_viewer_artifacts(
    store: &Store,
    context: &PluginRuntimeContext,
    document: &ViewerDocumentV1,
) -> Result<()> {
    for (artifact_id, media_type) in document.artifact_image_refs() {
        validate_same_project_artifact(store, context, artifact_id, Some(media_type))?;
    }
    Ok(())
}

pub(crate) fn validate_surface_artifacts(
    store: &Store,
    context: &PluginRuntimeContext,
    document: &rho_extension_runtime::SurfaceDocumentV1,
) -> Result<()> {
    for (artifact_id, media_type) in document.artifact_image_refs() {
        validate_same_project_artifact(store, context, artifact_id, Some(media_type))?;
    }
    Ok(())
}

pub(crate) fn validate_surface_command_result(
    store: &Store,
    context: &PluginRuntimeContext,
    result: &PluginCommandResultV1,
) -> Result<()> {
    validate_command_result_artifacts(store, context, result)
}

fn validate_same_project_artifact(
    store: &Store,
    context: &PluginRuntimeContext,
    artifact_id: &str,
    expected_media_type: Option<&str>,
) -> Result<()> {
    let artifact = store
        .get_artifact_record(&context.project_root, artifact_id)?
        .context("plugin Viewer referenced an unavailable same-project Artifact")?;
    ensure!(
        artifact.project_root == context.project_root,
        "plugin Viewer Artifact belongs to another project"
    );
    if let Some(expected_media_type) = expected_media_type {
        ensure!(
            artifact.media_type == expected_media_type,
            "plugin Viewer Artifact media type does not match its descriptor"
        );
    }
    ensure!(
        !artifact.output_path.trim().is_empty(),
        "plugin Viewer Artifact has no trusted output path"
    );
    Ok(())
}

fn agent_plugin_tool_name(contribution_id: &str, package_digest: &str) -> String {
    let stem = contribution_id
        .rsplit('.')
        .next()
        .unwrap_or("tool")
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                byte as char
            } else {
                '_'
            }
        })
        .take(32)
        .collect::<String>();
    let mut hasher = Sha256::new();
    hasher.update(contribution_id.as_bytes());
    hasher.update([0]);
    hasher.update(package_digest.as_bytes());
    let suffix = format!("{:x}", hasher.finalize());
    format!("plugin_{stem}_{}", &suffix[..10])
}

fn push_agent_plugin_context(
    items: &mut Vec<AgentPluginContextItem>,
    total_bytes: &mut usize,
    item: AgentPluginContextItem,
) -> Result<()> {
    *total_bytes = total_bytes
        .checked_add(serde_json::to_vec(&item)?.len())
        .filter(|total| *total <= MAX_AGENT_PLUGIN_CONTEXT_PROFILE_BYTES)
        .context("Agent plugin Source/Skill context exceeds its byte budget")?;
    items.push(item);
    Ok(())
}

fn validate_agent_tool_schema(schema: &serde_json::Value) -> Result<()> {
    let object = schema
        .as_object()
        .context("Agent plugin Tool schema node must be an object")?;
    for key in ["minLength", "maxLength", "minItems", "maxItems"] {
        if object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|value| value > i32::MAX as u64)
        {
            bail!("Agent plugin Tool schema bound {key} exceeds the aisdk R range");
        }
    }
    for key in ["minimum", "maximum"] {
        if object
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|value| value.abs() > 9_007_199_254_740_992_f64)
        {
            bail!("Agent plugin Tool numeric bound {key} exceeds exact R JSON precision");
        }
    }
    if object
        .get("enum")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|values| {
            values.iter().any(|value| {
                value
                    .as_f64()
                    .is_some_and(|value| value.abs() > 9_007_199_254_740_992_f64)
            })
        })
    {
        bail!("Agent plugin Tool enum exceeds exact R JSON precision");
    }
    if let Some(properties) = object
        .get("properties")
        .and_then(serde_json::Value::as_object)
    {
        for child in properties.values() {
            validate_agent_tool_schema(child)?;
        }
    }
    if let Some(items) = object.get("items") {
        validate_agent_tool_schema(items)?;
    }
    Ok(())
}

fn read_plugin_skill(
    state: &RegistryState,
    context: &PluginRuntimeContext,
    record: &rho_extension_runtime::ContributionRecord,
) -> Result<String> {
    let current = state
        .contributions
        .get(&record.project_id, &record.contribution.capability)
        .is_some_and(|current| {
            current.plugin_id == record.plugin_id
                && current.package_digest == record.package_digest
                && current.activation_generation == record.activation_generation
                && current.host_instance_id == record.host_instance_id
        });
    ensure!(current, "plugin Skill route changed while reading");
    let active = state
        .active
        .get(&registry_key(
            &context.project_root,
            record.plugin_id.as_str(),
        ))
        .context("plugin Skill host is not active")?;
    ensure!(
        active.package_digest == record.package_digest.as_str()
            && active.host_instance_id == record.host_instance_id,
        "plugin Skill host identity changed before Agent projection"
    );
    active
        .skill_instructions
        .get(record.contribution.capability.as_str())
        .cloned()
        .context("exact cached plugin Skill content is unavailable")
}

fn remove_active_plugin(state: &mut RegistryState, key: &str) -> Option<ActivePlugin> {
    let active = state.active.remove(key)?;
    if let Some(identity) = &active.contribution_identity {
        state.contributions.clear_instance(
            &identity.project_id,
            &identity.plugin_id,
            &identity.package_digest,
            identity.activation_generation,
            &identity.host_instance_id,
        );
    }
    state.grants.invalidate_host(&active.host_instance_id);
    Some(active)
}

fn revoke_exact_durable_grants(
    state: &mut RegistryState,
    store: &mut Store,
    context: &PluginRuntimeContext,
    plugin_id: &str,
    package_digest: &str,
    reason_code: &str,
) -> Result<usize> {
    let grants = PluginPermissionQueryService::new(store)
        .list_grants(&context.project_root, Some(200), Some("active"))?
        .into_iter()
        .filter(|grant| grant.plugin_id == plugin_id && grant.package_digest == package_digest)
        .collect::<Vec<_>>();
    for grant in &grants {
        let outcome = PluginPermissionMutationService::new(store).revoke_grant(
            &context.project_root,
            &grant.grant_id,
            reason_code,
        )?;
        ensure!(
            matches!(
                outcome,
                PluginPermissionMutationOutcome::Applied
                    | PluginPermissionMutationOutcome::Unchanged
            ),
            "exact old plugin grant revocation was stale"
        );
        state.grants.revoke_durable_grant(&grant.grant_id);
    }
    Ok(grants.len())
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

fn plan_plugin_permissions(
    store: &Store,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
) -> Result<(
    BTreeMap<String, PluginPermissionGrant>,
    Vec<PluginPermissionRequestDraft>,
)> {
    let durable_grants = matching_project_grants(store, context, plugin)?;
    let mut reusable_grants = BTreeMap::new();
    let mut requests = Vec::new();
    for permission in &plugin.manifest.permissions {
        let constraints = PermissionConstraints::from_manifest(permission)?;
        let constraints_digest = constraints.digest()?;
        if let Some(grant) =
            durable_grants.get(&(permission.name.clone(), constraints_digest.clone()))
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
            constraints_digest,
            purpose_text: permission.purpose.clone(),
            expected_project_revision: context.project_revision,
        });
    }
    Ok((reusable_grants, requests))
}

fn plan_fresh_plugin_permissions(
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
) -> Result<Vec<PluginPermissionRequestDraft>> {
    plugin
        .manifest
        .permissions
        .iter()
        .map(|permission| {
            let constraints = PermissionConstraints::from_manifest(permission)?;
            Ok(PluginPermissionRequestDraft {
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
            })
        })
        .collect()
}

fn discovered_from_cache(directory_name: &str, cached: &CachedPluginPackage) -> DiscoveredPlugin {
    DiscoveredPlugin {
        directory: directory_name.to_string(),
        manifest: cached.snapshot.manifest.clone(),
        digest: cached.snapshot.digest.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
fn advance_enable_transition(
    store: &mut Store,
    context: &PluginRuntimeContext,
    transition_id: &str,
    expected_phase: &str,
    next_phase: &str,
    status: &str,
    observed_state: &str,
    accepted_digest: Option<&str>,
    clear_pending_digest: bool,
    last_host_session_id: Option<&str>,
    event_type: &str,
    event_status: &str,
    reason_code: Option<&str>,
) -> Result<()> {
    let outcome = PluginLifecycleMutationService::new(store).advance_transition(
        &context.project_root,
        &WorkspacePluginTransitionAdvance {
            project_root: context.project_root.clone(),
            transition_id: transition_id.to_string(),
            expected_phase: expected_phase.to_string(),
            next_phase: next_phase.to_string(),
            status: status.to_string(),
            observed_state: observed_state.to_string(),
            accepted_digest: accepted_digest.map(str::to_string),
            pending_digest: None,
            rollback_digest: None,
            clear_pending_digest,
            last_host_session_id: last_host_session_id.map(str::to_string),
            last_error_code: reason_code.map(str::to_string),
            reason_code: reason_code.map(str::to_string),
            event_type: event_type.to_string(),
            event_status: event_status.to_string(),
            details_json: "{}".to_string(),
        },
    )?;
    ensure!(
        matches!(
            outcome,
            PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
        ),
        "plugin lifecycle transition advance was stale"
    );
    Ok(())
}

fn fail_enable_transition(
    store: &mut Store,
    context: &PluginRuntimeContext,
    transition_id: &str,
    reason_code: &str,
    observed_state: &str,
) -> Result<()> {
    let transition = PluginLifecycleQueryService::new(store)
        .get_transition(&context.project_root, transition_id)?
        .context("plugin enable transition disappeared before failure persistence")?;
    if matches!(
        transition.status.as_str(),
        "completed" | "failed" | "cancelled"
    ) {
        return Ok(());
    }
    advance_enable_transition(
        store,
        context,
        transition_id,
        &transition.phase,
        "completed",
        "failed",
        observed_state,
        None,
        false,
        None,
        "transition_failed",
        "failed",
        Some(reason_code),
    )
}

fn push_teardown_error(errors: &mut Vec<String>, code: &str) {
    if errors.len() < 16 && !errors.iter().any(|existing| existing == code) {
        errors.push(code.to_string());
    }
}

#[allow(clippy::too_many_arguments)]
fn record_disable_phase(
    store: &mut Store,
    context: &PluginRuntimeContext,
    transition_id: &str,
    expected_phase: &str,
    next_phase: &str,
    status: &str,
    observed_state: &str,
    event_type: &str,
    event_status: &str,
    reason_code: Option<&str>,
    details: serde_json::Value,
) -> Result<()> {
    let outcome = PluginLifecycleMutationService::new(store).advance_transition(
        &context.project_root,
        &WorkspacePluginTransitionAdvance {
            project_root: context.project_root.clone(),
            transition_id: transition_id.to_string(),
            expected_phase: expected_phase.to_string(),
            next_phase: next_phase.to_string(),
            status: status.to_string(),
            observed_state: observed_state.to_string(),
            accepted_digest: None,
            pending_digest: None,
            rollback_digest: None,
            clear_pending_digest: false,
            last_host_session_id: None,
            last_error_code: reason_code.map(str::to_string),
            reason_code: reason_code.map(str::to_string),
            event_type: event_type.to_string(),
            event_status: event_status.to_string(),
            details_json: details.to_string(),
        },
    )?;
    ensure!(
        matches!(
            outcome,
            PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
        ),
        "plugin disable transition phase was stale"
    );
    Ok(())
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
    let failure_observed_state = match &pending.kind {
        PendingActivationKind::Enable => "disabled",
        PendingActivationKind::Retry => "crashed",
        PendingActivationKind::Upgrade { .. } => "update_pending",
        PendingActivationKind::Rollback { .. } => "rollback_pending",
    };
    if requests.iter().any(|request| request.status != "granted") {
        let _ = fail_enable_transition(
            store,
            context,
            &pending.transition_id,
            "permission_denied",
            failure_observed_state,
        );
        state.pending.remove(&key);
        return Ok(("denied".to_string(), 0));
    }
    let (plugin, cached) = match &pending.kind {
        PendingActivationKind::Rollback {
            expected_old_digest,
        } => {
            let source_current = discover_exact_plugin(Path::new(&context.project_root), plugin_id)
                .is_ok_and(|plugin| plugin.digest.as_str() == expected_old_digest);
            if !source_current {
                let _ = fail_enable_transition(
                    store,
                    context,
                    &pending.transition_id,
                    "stale_digest",
                    "rollback_pending",
                );
                bail!("plugin package changed while permission review was open");
            }
            let cached = match PluginPackageCache::new(&context.app_data_dir).load_exact(
                &context.project_root,
                plugin_id,
                &pending.package_digest,
            ) {
                Ok(cached) => cached,
                Err(error) => {
                    let _ = fail_enable_transition(
                        store,
                        context,
                        &pending.transition_id,
                        "rollback_cache_failed",
                        "rollback_pending",
                    );
                    return Err(error.into());
                }
            };
            let lifecycle = PluginLifecycleQueryService::new(store)
                .get_state(&context.project_root, plugin_id)?
                .context("Rollback lifecycle state disappeared during permission review")?;
            let plugin = discovered_from_cache(&lifecycle.directory_name, &cached);
            if plugin.manifest.version.to_string() != pending.plugin_version
                || plugin.digest.as_str() != pending.package_digest
            {
                let _ = fail_enable_transition(
                    store,
                    context,
                    &pending.transition_id,
                    "rollback_cache_changed",
                    "rollback_pending",
                );
                bail!("plugin Rollback cache changed while permission review was open");
            }
            (plugin, cached)
        }
        PendingActivationKind::Enable
        | PendingActivationKind::Retry
        | PendingActivationKind::Upgrade { .. } => {
            let plugin = match discover_exact_plugin(Path::new(&context.project_root), plugin_id) {
                Ok(plugin)
                    if plugin.manifest.version.to_string() == pending.plugin_version
                        && plugin.digest.as_str() == pending.package_digest =>
                {
                    plugin
                }
                Ok(_) | Err(_) => {
                    let _ = fail_enable_transition(
                        store,
                        context,
                        &pending.transition_id,
                        "stale_digest",
                        "update_pending",
                    );
                    bail!("plugin package changed while permission review was open");
                }
            };
            let cached = match PluginPackageCache::new(&context.app_data_dir).prepare_exact(
                Path::new(&context.project_root),
                plugin_id,
                &pending.package_digest,
            ) {
                Ok(cached) => cached,
                Err(error) => {
                    let _ = fail_enable_transition(
                        store,
                        context,
                        &pending.transition_id,
                        "package_cache_failed",
                        failure_observed_state,
                    );
                    return Err(error.into());
                }
            };
            (plugin, cached)
        }
    };
    let durable_grants = PluginPermissionQueryService::new(store).list_grants(
        &context.project_root,
        Some(200),
        Some("active"),
    )?;
    let candidate_grants = durable_grants
        .iter()
        .filter(|grant| {
            grant.plugin_id == plugin_id
                && grant.plugin_version == pending.plugin_version
                && grant.package_digest == pending.package_digest
        })
        .collect::<Vec<_>>();
    let pending_is_rollback = matches!(&pending.kind, PendingActivationKind::Rollback { .. });
    let result = match &pending.kind {
        PendingActivationKind::Upgrade {
            expected_old_digest,
        }
        | PendingActivationKind::Rollback {
            expected_old_digest,
        } => {
            let result = activate_plugin_replacement_durable(
                state,
                context,
                &plugin,
                &cached,
                &pending.transition_id,
                expected_old_digest,
                candidate_grants.iter().copied(),
                store,
            )?;
            revoke_exact_durable_grants(
                state,
                store,
                context,
                plugin_id,
                expected_old_digest,
                if pending_is_rollback {
                    "plugin_rolled_back"
                } else {
                    "plugin_updated"
                },
            )?;
            result
        }
        PendingActivationKind::Enable | PendingActivationKind::Retry => activate_plugin_durable(
            state,
            context,
            &plugin,
            &cached,
            &pending.transition_id,
            candidate_grants.iter().copied(),
            store,
        )?,
    };
    state.pending.remove(&key);
    Ok((result.status, result.active_grant_count))
}

struct PreparedPluginActivation {
    contribution_candidate: ContributionCandidate,
    expected_old_contribution: Option<ContributionInstanceIdentity>,
    active: ActivePlugin,
    active_grant_count: usize,
}

fn activate_plugin_durable<'a>(
    state: &mut RegistryState,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
    cached: &CachedPluginPackage,
    transition_id: &str,
    durable_grants: impl IntoIterator<Item = &'a PluginPermissionGrant>,
    store: &mut Store,
) -> Result<WorkspacePluginEnableResult> {
    let retry_transition = PluginLifecycleQueryService::new(store)
        .get_transition(&context.project_root, transition_id)?
        .is_some_and(|transition| transition.kind == "retry");
    let failure_observed_state = if retry_transition {
        "crashed"
    } else {
        "disabled"
    };
    let prepared = match prepare_plugin_activation(
        state,
        context,
        plugin,
        cached,
        transition_id,
        durable_grants,
        None,
        store,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = fail_enable_transition(
                store,
                context,
                transition_id,
                "candidate_activation_failed",
                failure_observed_state,
            );
            return Err(error);
        }
    };
    let host_instance_id = prepared.active.host_instance_id.clone();
    if let Err(error) = advance_enable_transition(
        store,
        context,
        transition_id,
        "grants_ready",
        "candidate_activated",
        "running",
        "activating",
        None,
        false,
        Some(host_instance_id.as_str()),
        "activation",
        "completed",
        None,
    ) {
        state.grants.invalidate_host(&host_instance_id);
        let _ = fail_enable_transition(
            store,
            context,
            transition_id,
            "candidate_journal_failed",
            failure_observed_state,
        );
        return Err(error);
    }

    let key = registry_key(&context.project_root, plugin.manifest.id.as_str());
    if let Err(error) = state.contributions.publish(
        prepared.contribution_candidate,
        prepared.expected_old_contribution.as_ref(),
    ) {
        state.grants.invalidate_host(&host_instance_id);
        let _ = fail_enable_transition(
            store,
            context,
            transition_id,
            "contribution_publication_failed",
            failure_observed_state,
        );
        return Err(anyhow!(
            "workspace plugin contribution publication failed: {error:?}"
        ));
    }
    if let Some(previous) = state.active.insert(key.clone(), prepared.active) {
        state.grants.invalidate_host(&previous.host_instance_id);
    }
    if let Err(error) = advance_enable_transition(
        store,
        context,
        transition_id,
        "candidate_activated",
        "pointer_swapped",
        "running",
        "activating",
        None,
        false,
        Some(host_instance_id.as_str()),
        "routing_published",
        "completed",
        None,
    ) {
        remove_active_plugin(state, &key);
        return Err(error
            .context("plugin route was closed after routing publication could not be journaled"));
    }
    if let Err(error) = advance_enable_transition(
        store,
        context,
        transition_id,
        "pointer_swapped",
        "completed",
        "completed",
        "active",
        Some(plugin.digest.as_str()),
        true,
        Some(host_instance_id.as_str()),
        "transition_completed",
        "completed",
        None,
    ) {
        remove_active_plugin(state, &key);
        return Err(
            error.context("plugin route was closed because durable enable completion failed")
        );
    }

    Ok(WorkspacePluginEnableResult {
        status: "enabled".to_string(),
        plugin_id: plugin.manifest.id.to_string(),
        request_ids: Vec::new(),
        active_grant_count: prepared.active_grant_count,
        transition_id: Some(transition_id.to_string()),
        message: if prepared.active_grant_count == 0 {
            "The exact cached plugin package is durably enabled with zero privileged permissions."
        } else {
            "The exact cached plugin package is durably enabled with fresh session-bound handles."
        }
        .to_string(),
    })
}

fn activate_plugin_replacement_durable<'a>(
    state: &mut RegistryState,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
    cached: &CachedPluginPackage,
    transition_id: &str,
    expected_old_digest: &str,
    durable_grants: impl IntoIterator<Item = &'a PluginPermissionGrant>,
    store: &mut Store,
) -> Result<WorkspacePluginEnableResult> {
    let key = registry_key(&context.project_root, plugin.manifest.id.as_str());
    let expected_old_contribution = {
        let old = state
            .active
            .get(&key)
            .context("replacement requires an exact active plugin")?;
        ensure!(
            old.project_root == context.project_root
                && old.package_digest == expected_old_digest
                && old.host.identity().package_digest().as_str() == expected_old_digest,
            "replacement active plugin identity is stale"
        );
        old.contribution_identity.clone()
    };
    let prepared = match prepare_plugin_activation(
        state,
        context,
        plugin,
        cached,
        transition_id,
        durable_grants,
        expected_old_contribution.as_ref(),
        store,
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = fail_enable_transition(
                store,
                context,
                transition_id,
                "replacement_candidate_failed",
                "update_pending",
            );
            return Err(error);
        }
    };
    let candidate_host_id = prepared.active.host_instance_id.clone();
    if let Err(error) = advance_enable_transition(
        store,
        context,
        transition_id,
        "grants_ready",
        "candidate_activated",
        "running",
        "activating",
        None,
        false,
        Some(candidate_host_id.as_str()),
        "activation",
        "completed",
        None,
    ) {
        state.grants.invalidate_host(&candidate_host_id);
        return Err(error);
    }

    let old_host_id = {
        let old = state
            .active
            .get_mut(&key)
            .context("replacement active plugin disappeared before CAS")?;
        ensure!(
            old.package_digest == expected_old_digest
                && old.contribution_identity == prepared.expected_old_contribution,
            "replacement expected-old runtime identity changed"
        );
        if let Some(request_id) = old.host.active_broker_request_id() {
            old.host
                .cancel_broker_call(&request_id)
                .map_err(|error| anyhow!("cancelling old plugin call failed: {error:?}"))?;
        }
        let old_host_id = old.host_instance_id.clone();
        ensure!(
            matches!(
                old.host.handle_frame(HostFrame {
                    instance_id: old_host_id.clone(),
                    message: HostMessage::Quiesce,
                }),
                Ok(Some(HostResponse::Quiesced))
            ),
            "old plugin host did not quiesce before replacement CAS"
        );
        old_host_id
    };

    if let Err(error) = state.contributions.publish(
        prepared.contribution_candidate,
        prepared.expected_old_contribution.as_ref(),
    ) {
        state.grants.invalidate_host(&candidate_host_id);
        let _ = fail_enable_transition(
            store,
            context,
            transition_id,
            "replacement_cas_failed",
            "update_pending",
        );
        return Err(anyhow!(
            "workspace plugin replacement CAS failed: {error:?}"
        ));
    }
    let mut old = state
        .active
        .insert(key.clone(), prepared.active)
        .context("replacement lost the expected-old active plugin")?;
    if let Err(error) = advance_enable_transition(
        store,
        context,
        transition_id,
        "candidate_activated",
        "pointer_swapped",
        "running",
        "activating",
        None,
        false,
        Some(candidate_host_id.as_str()),
        "pointer_cas",
        "completed",
        None,
    ) {
        remove_active_plugin(state, &key);
        state.grants.invalidate_host(&old_host_id);
        let _ = fail_enable_transition(
            store,
            context,
            transition_id,
            "replacement_pointer_journal_failed",
            "update_pending",
        );
        return Err(error.context("replacement routes closed after pointer journal failure"));
    }
    if let Err(error) = PluginLifecycleMutationService::new(store).complete_replacement(
        &context.project_root,
        transition_id,
        candidate_host_id.as_str(),
    ) {
        remove_active_plugin(state, &key);
        state.grants.invalidate_host(&old_host_id);
        return Err(error.into());
    }

    state.grants.invalidate_host(&old_host_id);
    if matches!(old.host.state(), HostInstanceState::Quiescing) {
        let _ = old.host.handle_frame(HostFrame {
            instance_id: old_host_id,
            message: HostMessage::Dispose,
        });
    }
    Ok(WorkspacePluginEnableResult {
        status: "enabled".to_string(),
        plugin_id: plugin.manifest.id.to_string(),
        request_ids: Vec::new(),
        active_grant_count: prepared.active_grant_count,
        transition_id: Some(transition_id.to_string()),
        message: "The exact replacement package is durably active with a fresh host and expected-old routing CAS."
            .to_string(),
    })
}

fn prepare_plugin_activation<'a>(
    state: &mut RegistryState,
    context: &PluginRuntimeContext,
    plugin: &DiscoveredPlugin,
    cached: &CachedPluginPackage,
    transition_id: &str,
    durable_grants: impl IntoIterator<Item = &'a PluginPermissionGrant>,
    expected_old_contribution: Option<&ContributionInstanceIdentity>,
    store: &mut Store,
) -> Result<PreparedPluginActivation> {
    ensure!(
        cached.plugin_id == plugin.manifest.id.as_str()
            && cached.package_digest == plugin.digest.as_str()
            && cached.snapshot.manifest == plugin.manifest
            && cached.snapshot.digest == plugin.digest,
        "cached plugin package identity does not match the activation candidate"
    );
    let module_bytes = cached
        .file_bytes(&plugin.manifest.runtime.entry)
        .context("exact cached plugin entry is missing")?;
    ensure!(
        module_bytes.len() <= MAX_WASM_MODULE_BYTES,
        "cached plugin entry exceeds the Wasm module bound"
    );
    let mut skill_instructions = BTreeMap::new();
    let mut skill_bytes = 0usize;
    for contribution in &plugin.manifest.contributions {
        if contribution.kind != ContributionKind::Skill {
            continue;
        }
        let path = contribution
            .skill_path
            .as_deref()
            .context("Skill contribution has no exact cached path")?;
        let bytes = cached
            .file_bytes(path)
            .context("exact cached Skill content is missing")?;
        ensure!(
            bytes.len() <= MAX_PLUGIN_SKILL_BYTES,
            "plugin Skill exceeds {MAX_PLUGIN_SKILL_BYTES} bytes"
        );
        skill_bytes = skill_bytes
            .checked_add(bytes.len())
            .filter(|total| *total <= MAX_PLUGIN_SKILL_PACK_BYTES)
            .context("plugin Skill pack exceeds its byte budget")?;
        skill_instructions.insert(
            contribution.id.to_string(),
            std::str::from_utf8(bytes)
                .context("plugin Skill must be UTF-8 plain text")?
                .to_string(),
        );
    }
    let lifecycle = PluginLifecycleQueryService::new(store)
        .get_state(&context.project_root, plugin.manifest.id.as_str())?
        .context("durable plugin lifecycle state is missing")?;
    ensure!(
        lifecycle.transition_id.as_deref() == Some(transition_id),
        "plugin activation transition is no longer current"
    );
    let allocation = PluginLifecycleMutationService::new(store).allocate_generation(
        &context.project_root,
        plugin.manifest.id.as_str(),
        transition_id,
        lifecycle.last_activation_generation,
    )?;
    ensure!(
        allocation.outcome == PluginLifecycleMutationOutcome::Applied,
        "plugin activation generation allocation was stale"
    );
    let generation = ActivationGeneration::new(u64::try_from(allocation.generation)?)
        .context("allocating durable workspace plugin activation generation")?;
    advance_enable_transition(
        store,
        context,
        transition_id,
        "backup_prepared",
        "grants_ready",
        "running",
        "resolving",
        None,
        false,
        None,
        "grant_state",
        "completed",
        None,
    )?;
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
        module_bytes,
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

    let contribution_identity = ContributionInstanceIdentity::new(
        context.project_scope_id.clone(),
        plugin.manifest.id.clone(),
        plugin.digest.clone(),
        generation,
        host_instance_id.clone(),
    );
    if !plugin.manifest.contributions.is_empty() {
        ensure!(
            host.guest_abi_version() == rho_extension_runtime::GUEST_ABI_V2,
            "contributing workspace plugins require no-import Guest ABI V2"
        );
    }
    let contribution_candidate = ContributionStore::stage(
        contribution_identity.clone(),
        plugin.manifest.contributions.clone(),
    )
    .map_err(|error| anyhow!("workspace plugin contribution candidate is invalid: {error:?}"))?;
    let expected_old = state
        .contributions
        .current_identity(&context.project_scope_id, &plugin.manifest.id)
        .map_err(|error| anyhow!("reading current contribution identity: {error:?}"))?;
    ensure!(
        expected_old.as_ref() == expected_old_contribution,
        "plugin contribution replacement expectation is stale"
    );
    let mut preview = state.contributions.clone();
    preview
        .publish(contribution_candidate.clone(), expected_old_contribution)
        .map_err(|error| anyhow!("workspace plugin contribution candidate conflicts: {error:?}"))?;

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

    let active_grant_count = handles.len();
    let contribution_identity =
        (!plugin.manifest.contributions.is_empty()).then_some(contribution_identity);
    Ok(PreparedPluginActivation {
        contribution_candidate,
        expected_old_contribution: expected_old_contribution.cloned(),
        active: ActivePlugin {
            project_root: context.project_root.clone(),
            plugin_version: plugin.manifest.version.to_string(),
            package_digest: plugin.digest.to_string(),
            host_instance_id,
            host,
            handles,
            permission_count: plugin.manifest.permissions.len(),
            contribution_identity,
            skill_instructions,
        },
        active_grant_count,
    })
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
mod tests;
