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

mod contracts;
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

    pub(crate) fn list(
        &self,
        context: &PluginRuntimeContext,
        store: &mut Store,
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
        let lifecycle_states = PluginLifecycleQueryService::new(store)
            .list_states(&context.project_root, Some(100))?
            .into_iter()
            .map(|state| (state.plugin_id.clone(), state))
            .collect::<BTreeMap<_, _>>();
        let tombstones = PluginLifecycleQueryService::new(store)
            .list_tombstones(&context.project_root, Some(100))?;
        let purge_recovery_required = tombstones
            .iter()
            .filter(|tombstone| {
                tombstone.retention_class == "purge_pending"
                    && tombstone.deleted_at.is_none()
                    && tombstone.restored_at.is_none()
            })
            .map(|tombstone| tombstone.plugin_id.clone())
            .collect::<BTreeSet<_>>();
        let recoverable_tombstones = tombstones
            .into_iter()
            .filter(|tombstone| {
                tombstone.retention_class == "recoverable"
                    && tombstone.deleted_at.is_none()
                    && tombstone.restored_at.is_none()
            })
            .fold(BTreeMap::new(), |mut tombstones, tombstone| {
                tombstones
                    .entry(tombstone.plugin_id.clone())
                    .or_insert(tombstone.tombstone_id);
                tombstones
            });
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

        let mut plugins = report
            .plugins
            .iter()
            .map(|plugin| {
                plugin_view(
                    &context.project_root,
                    plugin,
                    &requests,
                    &grants,
                    lifecycle_states.get(plugin.manifest.id.as_str()),
                    recoverable_tombstones
                        .get(plugin.manifest.id.as_str())
                        .map(String::as_str),
                    purge_recovery_required.contains(plugin.manifest.id.as_str()),
                    &state,
                )
            })
            .collect::<Vec<_>>();
        let discovered_ids = plugins
            .iter()
            .map(|plugin| plugin.plugin_id.clone())
            .collect::<BTreeSet<_>>();
        plugins.extend(
            lifecycle_states
                .values()
                .filter(|lifecycle| !discovered_ids.contains(&lifecycle.plugin_id))
                .filter(|lifecycle| {
                    lifecycle.desired_state == "enabled"
                        || matches!(
                            lifecycle.observed_state.as_str(),
                            "blocked" | "crashed" | "update_pending" | "uninstalled"
                        )
                })
                .map(|lifecycle| {
                    missing_workspace_plugin_view(
                        lifecycle,
                        &requests,
                        &grants,
                        recoverable_tombstones
                            .get(&lifecycle.plugin_id)
                            .map(String::as_str),
                        purge_recovery_required.contains(&lifecycle.plugin_id),
                    )
                }),
        );
        plugins.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
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

    pub(crate) fn reconcile_project(
        &self,
        context: &PluginRuntimeContext,
        store: &mut Store,
    ) -> WorkspacePluginReconciliationReport {
        let mut report = WorkspacePluginReconciliationReport {
            project_root: context.project_root.clone(),
            reactivated: 0,
            already_active: 0,
            permission_required: 0,
            update_pending: 0,
            blocked: 0,
            skipped: 0,
            recovered_uninstalls: 0,
            recovered_purges: 0,
            recovered_replacements: 0,
            recovery_required: 0,
            project_files_changed: false,
            entries: Vec::new(),
            truncated: false,
        };
        recover_project_plugin_files(context, store, &mut report);
        let durable_states = match PluginLifecycleQueryService::new(store)
            .list_states(&context.project_root, Some(256))
        {
            Ok(states) => states,
            Err(error) => {
                push_reconciliation_entry(
                    &mut report,
                    WorkspacePluginReconciliationEntry {
                        plugin_id: None,
                        status: "failed".to_string(),
                        reason_code: bounded_reconciliation_reason(&error.to_string()),
                    },
                );
                return report;
            }
        };
        let discovery = match discover_workspace_plugins(Path::new(&context.project_root)) {
            Ok(Some(discovery)) => discovery,
            Ok(None) => rho_extension_runtime::DiscoveryReport {
                plugins: Vec::new(),
                failures: Vec::new(),
            },
            Err(error) => {
                self.invalidate_project(&context.project_root);
                for durable in durable_states
                    .iter()
                    .filter(|durable| durable.desired_state == "enabled")
                {
                    match persist_recovery_block(store, context, durable, "discovery_root_invalid")
                    {
                        Ok(()) => {
                            report.blocked += 1;
                            push_reconciliation_entry(
                                &mut report,
                                WorkspacePluginReconciliationEntry {
                                    plugin_id: Some(durable.plugin_id.clone()),
                                    status: "blocked".to_string(),
                                    reason_code: "discovery_root_invalid".to_string(),
                                },
                            );
                        }
                        Err(persistence_error) => push_reconciliation_entry(
                            &mut report,
                            WorkspacePluginReconciliationEntry {
                                plugin_id: Some(durable.plugin_id.clone()),
                                status: "failed".to_string(),
                                reason_code: bounded_reconciliation_reason(
                                    &persistence_error.to_string(),
                                ),
                            },
                        ),
                    }
                }
                if report.blocked == 0 {
                    push_reconciliation_entry(
                        &mut report,
                        WorkspacePluginReconciliationEntry {
                            plugin_id: None,
                            status: "failed".to_string(),
                            reason_code: bounded_reconciliation_reason(&error.to_string()),
                        },
                    );
                }
                return report;
            }
        };
        for failure in discovery.failures {
            push_reconciliation_entry(
                &mut report,
                WorkspacePluginReconciliationEntry {
                    plugin_id: None,
                    status: "discovery_failed".to_string(),
                    reason_code: bounded_reconciliation_reason(&failure.reason),
                },
            );
        }
        let discovered_ids = discovery
            .plugins
            .iter()
            .map(|plugin| plugin.manifest.id.to_string())
            .collect::<BTreeSet<_>>();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for plugin in discovery.plugins {
            let plugin_id = plugin.manifest.id.to_string();
            match reconcile_discovered_plugin(&mut state, context, &plugin, store) {
                Ok(status) => {
                    increment_reconciliation_status(&mut report, status);
                    push_reconciliation_entry(
                        &mut report,
                        WorkspacePluginReconciliationEntry {
                            plugin_id: Some(plugin_id),
                            status: status.as_str().to_string(),
                            reason_code: status.reason_code().to_string(),
                        },
                    );
                }
                Err(error) => push_reconciliation_entry(
                    &mut report,
                    WorkspacePluginReconciliationEntry {
                        plugin_id: Some(plugin_id),
                        status: "failed".to_string(),
                        reason_code: bounded_reconciliation_reason(&error.to_string()),
                    },
                ),
            }
        }
        for durable in durable_states
            .iter()
            .filter(|durable| !discovered_ids.contains(&durable.plugin_id))
        {
            if durable.desired_state != "enabled" {
                report.skipped += 1;
                continue;
            }
            remove_active_plugin(
                &mut state,
                &registry_key(&context.project_root, &durable.plugin_id),
            );
            match persist_missing_plugin_block(store, context, durable) {
                Ok(()) => {
                    report.blocked += 1;
                    push_reconciliation_entry(
                        &mut report,
                        WorkspacePluginReconciliationEntry {
                            plugin_id: Some(durable.plugin_id.clone()),
                            status: "blocked".to_string(),
                            reason_code: "package_missing".to_string(),
                        },
                    );
                }
                Err(error) => push_reconciliation_entry(
                    &mut report,
                    WorkspacePluginReconciliationEntry {
                        plugin_id: Some(durable.plugin_id.clone()),
                        status: "failed".to_string(),
                        reason_code: bounded_reconciliation_reason(&error.to_string()),
                    },
                ),
            }
        }
        report
    }

    pub(crate) fn agent_projection(
        &self,
        context: &PluginRuntimeContext,
        store: &mut Store,
    ) -> Result<WorkspacePluginAgentProjection> {
        let records = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state
                .contributions
                .list(&context.project_scope_id)
                .into_iter()
                .cloned()
                .collect::<Vec<_>>()
        };
        let active_grants = PluginPermissionQueryService::new(store).list_grants(
            &context.project_root,
            Some(100),
            Some("active"),
        )?;
        let mut tools = Vec::new();
        let mut tool_profile_bytes = 0usize;
        let mut prompt_context = Vec::new();
        let mut context_profile_bytes = 0usize;
        let mut skill_pack_bytes = 0usize;
        for record in records {
            match record.contribution.kind {
                ContributionKind::Tool => {
                    let input_schema = record
                        .contribution
                        .input_schema
                        .as_ref()
                        .context("published Tool contribution has no input schema")?
                        .value()
                        .clone();
                    validate_agent_tool_schema(&input_schema)?;
                    let definition = AgentPluginToolDefinition {
                        name: agent_plugin_tool_name(
                            record.contribution.capability.as_str(),
                            record.package_digest.as_str(),
                        ),
                        contribution_id: record.contribution.capability.to_string(),
                        label: record.contribution.label.clone(),
                        purpose: record.contribution.purpose.clone(),
                        input_schema,
                        plugin_id: record.plugin_id.to_string(),
                        package_digest: record.package_digest.to_string(),
                    };
                    tool_profile_bytes = tool_profile_bytes
                        .checked_add(serde_json::to_vec(&definition)?.len())
                        .filter(|total| *total <= MAX_AGENT_PLUGIN_TOOL_PROFILE_BYTES)
                        .context("Agent plugin Tool profile exceeds its byte budget")?;
                    tools.push(definition);
                }
                ContributionKind::Source => {
                    let has_allow_once = active_grants.iter().any(|grant| {
                        grant.plugin_id == record.plugin_id.as_str()
                            && grant.package_digest == record.package_digest.as_str()
                            && grant.grant_source == "allow_once"
                    });
                    let (status, content) = if has_allow_once {
                        (
                            "deferred_allow_once".to_string(),
                            serde_json::json!({
                                "reason": "Automatic Source context does not consume an allow-once grant."
                            }),
                        )
                    } else {
                        match self.invoke_file_contribution(
                            context,
                            record.contribution.capability.as_str(),
                            ContributionInvocationOrigin::TrustedSource,
                            serde_json::json!({}),
                            store,
                        ) {
                            Ok(value) => ("completed".to_string(), value),
                            Err(_) => (
                                "failed".to_string(),
                                serde_json::json!({"error_code": "source_unavailable"}),
                            ),
                        }
                    };
                    push_agent_plugin_context(
                        &mut prompt_context,
                        &mut context_profile_bytes,
                        AgentPluginContextItem {
                            kind: "source".to_string(),
                            contribution_id: record.contribution.capability.to_string(),
                            label: record.contribution.label.clone(),
                            plugin_id: record.plugin_id.to_string(),
                            package_digest: record.package_digest.to_string(),
                            status,
                            content,
                        },
                    )?;
                }
                ContributionKind::Skill => {
                    let loaded = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        read_plugin_skill(&state, context, &record)
                    };
                    let (status, content) = match loaded {
                        Ok(instructions)
                            if skill_pack_bytes
                                .checked_add(instructions.len())
                                .is_some_and(|total| total <= MAX_PLUGIN_SKILL_PACK_BYTES) =>
                        {
                            skill_pack_bytes += instructions.len();
                            (
                                "completed".to_string(),
                                serde_json::json!({
                                    "instructions": instructions,
                                    "trust": "untrusted_project_content"
                                }),
                            )
                        }
                        Ok(_) => (
                            "failed".to_string(),
                            serde_json::json!({"error_code": "skill_pack_too_large"}),
                        ),
                        Err(_) => (
                            "failed".to_string(),
                            serde_json::json!({"error_code": "skill_unavailable"}),
                        ),
                    };
                    push_agent_plugin_context(
                        &mut prompt_context,
                        &mut context_profile_bytes,
                        AgentPluginContextItem {
                            kind: "skill".to_string(),
                            contribution_id: record.contribution.capability.to_string(),
                            label: record.contribution.label.clone(),
                            plugin_id: record.plugin_id.to_string(),
                            package_digest: record.package_digest.to_string(),
                            status,
                            content,
                        },
                    )?;
                }
                ContributionKind::Command
                | ContributionKind::Viewer
                | ContributionKind::Panel
                | ContributionKind::Surface
                | ContributionKind::CheckRule => {}
            }
        }
        Ok(WorkspacePluginAgentProjection {
            tools,
            context: prompt_context,
        })
    }

    pub(crate) fn list_contributions(
        &self,
        context: &PluginRuntimeContext,
    ) -> PluginContributionList {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let contributions = state
            .contributions
            .list(&context.project_scope_id)
            .into_iter()
            .map(|record| {
                let key = registry_key(&context.project_root, record.plugin_id.as_str());
                let exact_active = state.active.get(&key).filter(|active| {
                    active.host.identity().project_id() == &record.project_id
                        && active.host.identity().plugin_id() == &record.plugin_id
                        && active.host.identity().package_digest() == &record.package_digest
                        && active.host.identity().activation_generation()
                            == record.activation_generation
                        && active.host.identity().host_instance_id() == &record.host_instance_id
                });
                let available = exact_active.is_some_and(|active| {
                    active.host.state() == HostInstanceState::Active
                        && (active.permission_count == 0
                            || active.handles.len() == active.permission_count)
                });
                let status = if available {
                    "ready"
                } else if exact_active
                    .is_some_and(|active| active.host.state() != HostInstanceState::Active)
                {
                    "host_unavailable"
                } else {
                    "permission_unavailable"
                };
                let accepts_empty_input = record
                    .contribution
                    .input_schema
                    .as_ref()
                    .is_some_and(|schema| schema.validate_instance(&serde_json::json!({})).is_ok());
                PluginContributionView {
                    contribution_id: record.contribution.capability.to_string(),
                    kind: contribution_kind_name(record.contribution.kind).to_string(),
                    label: record.contribution.label.clone(),
                    purpose: record.contribution.purpose.clone(),
                    contract_major: record.contribution.contract_major,
                    plugin_id: record.plugin_id.to_string(),
                    package_digest: record.package_digest.to_string(),
                    activation_generation: record.activation_generation.get(),
                    short_digest: record.package_digest.as_str()[..12].to_string(),
                    status: status.to_string(),
                    available,
                    accepts_empty_input,
                    input_schema: record
                        .contribution
                        .input_schema
                        .as_ref()
                        .map(|schema| schema.value().clone()),
                }
            })
            .collect();
        PluginContributionList {
            project_root: context.project_root.clone(),
            project_revision: context.project_revision,
            contributions,
        }
    }

    pub(crate) fn surface_factories(
        &self,
        context: &PluginRuntimeContext,
    ) -> Result<Vec<rho_ui_contract::SurfaceFactoryRegistrationV1>> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut factories = Vec::new();
        for record in state.contributions.list(&context.project_scope_id) {
            if record.contribution.kind != ContributionKind::Surface {
                continue;
            }
            let key = registry_key(&context.project_root, record.plugin_id.as_str());
            let Some(active) = state.active.get(&key) else {
                continue;
            };
            let exact_ready = active.host.state() == HostInstanceState::Active
                && active.host.identity().project_id() == &record.project_id
                && active.host.identity().plugin_id() == &record.plugin_id
                && active.host.identity().package_digest() == &record.package_digest
                && active.host.identity().activation_generation() == record.activation_generation
                && active.host.identity().host_instance_id() == &record.host_instance_id
                && (active.permission_count == 0
                    || active.handles.len() == active.permission_count);
            if !exact_ready {
                continue;
            }
            let projection =
                rho_extension_runtime::WorkspaceSurfaceProjectionV1::from_contribution(
                    &record.contribution,
                    &record.plugin_id,
                    &record.package_digest,
                )
                .map_err(|error| anyhow!(error))?;
            factories.push(rho_ui_contract::SurfaceFactoryRegistrationV1 {
                definition: projection.definition,
                activation_generation: record.activation_generation.get(),
            });
        }
        factories
            .sort_by(|left, right| left.definition.surface_id.cmp(&right.definition.surface_id));
        Ok(factories)
    }

    pub(crate) fn invoke_surface_contribution(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<serde_json::Value> {
        self.invoke_file_contribution(
            context,
            contribution_id,
            ContributionInvocationOrigin::TrustedSurface,
            input,
            store,
        )
    }

    pub(crate) fn check_rule_registrations(
        &self,
        context: &PluginRuntimeContext,
    ) -> Vec<WorkspaceCheckRuleRegistration> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut registrations = Vec::new();
        for record in state.contributions.list(&context.project_scope_id) {
            if record.contribution.kind != ContributionKind::CheckRule {
                continue;
            }
            let key = registry_key(&context.project_root, record.plugin_id.as_str());
            let Some(active) = state.active.get(&key) else {
                continue;
            };
            let exact_ready = active.host.state() == HostInstanceState::Active
                && active.host.identity().project_id() == &record.project_id
                && active.host.identity().plugin_id() == &record.plugin_id
                && active.host.identity().package_digest() == &record.package_digest
                && active.host.identity().activation_generation() == record.activation_generation
                && active.host.identity().host_instance_id() == &record.host_instance_id
                && (active.permission_count == 0
                    || active.handles.len() == active.permission_count);
            if exact_ready {
                registrations.push(WorkspaceCheckRuleRegistration {
                    contribution_id: record.contribution.capability.to_string(),
                    plugin_id: record.plugin_id.to_string(),
                    package_digest: record.package_digest.to_string(),
                    activation_generation: record.activation_generation.get(),
                });
            }
        }
        registrations.sort_by(|left, right| {
            left.plugin_id
                .cmp(&right.plugin_id)
                .then_with(|| left.contribution_id.cmp(&right.contribution_id))
        });
        registrations
    }

    pub(crate) fn invoke_check_rule(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<serde_json::Value> {
        self.invoke_file_contribution(
            context,
            contribution_id,
            ContributionInvocationOrigin::TrustedCheckRule,
            input,
            store,
        )
    }

    pub(crate) fn surface_route(
        &self,
        context: &PluginRuntimeContext,
        surface_id: &str,
    ) -> Result<WorkspaceSurfaceInvocationRoute> {
        let capability = rho_extension_runtime::CapabilityId::new(surface_id.to_string())?;
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let record = state
            .contributions
            .get(&context.project_scope_id, &capability)
            .context("workspace Surface is not published for this project")?;
        ensure!(
            record.contribution.kind == ContributionKind::Surface,
            "contribution is not a workspace Surface"
        );
        let key = registry_key(&context.project_root, record.plugin_id.as_str());
        let active = state
            .active
            .get(&key)
            .context("workspace Surface plugin host is unavailable")?;
        ensure!(
            active.host.state() == HostInstanceState::Active
                && active.host.identity().project_id() == &record.project_id
                && active.host.identity().plugin_id() == &record.plugin_id
                && active.host.identity().package_digest() == &record.package_digest
                && active.host.identity().activation_generation() == record.activation_generation
                && active.host.identity().host_instance_id() == &record.host_instance_id,
            "workspace Surface plugin route is stale"
        );
        Ok(WorkspaceSurfaceInvocationRoute {
            contribution_id: record.contribution.capability.to_string(),
            plugin_id: record.plugin_id.to_string(),
            package_digest: record.package_digest.to_string(),
            activation_generation: record.activation_generation.get(),
            host_instance_id: record.host_instance_id.as_str().to_string(),
        })
    }

    pub(crate) fn validate_surface_event(
        &self,
        context: &PluginRuntimeContext,
        surface_id: &str,
        event: &serde_json::Value,
    ) -> Result<()> {
        let capability = rho_extension_runtime::CapabilityId::new(surface_id.to_string())?;
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let record = state
            .contributions
            .get(&context.project_scope_id, &capability)
            .context("workspace Surface is not published for this project")?;
        ensure!(
            record.contribution.kind == ContributionKind::Surface,
            "contribution is not a workspace Surface"
        );
        record
            .contribution
            .surface
            .as_ref()
            .context("workspace Surface event schema is missing")?
            .event_schema
            .validate_instance(event)
            .context("workspace Surface event does not match its declared schema")
    }

    pub(crate) fn invoke_command_contribution(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<PluginCommandInvocationView> {
        let outcome = self.invoke_file_contribution(
            context,
            contribution_id,
            ContributionInvocationOrigin::UserCommand,
            input,
            store,
        )?;
        ensure!(
            outcome["status"] == "completed",
            "plugin Command returned a failed terminal result"
        );
        let result = PluginCommandResultV1::parse(outcome["result"].clone())?;
        validate_command_result_artifacts(store, context, &result)?;
        Ok(PluginCommandInvocationView {
            project_root: context.project_root.clone(),
            project_revision: context.project_revision,
            contribution_id: contribution_id.to_string(),
            result,
            provenance: outcome["provenance"].clone(),
        })
    }

    pub(crate) fn open_viewer_contribution(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<PluginViewerDocumentView> {
        let outcome = self.invoke_file_contribution(
            context,
            contribution_id,
            ContributionInvocationOrigin::TrustedViewer,
            input,
            store,
        )?;
        ensure!(
            outcome["status"] == "completed",
            "plugin Viewer returned a failed terminal result"
        );
        let document = ViewerDocumentV1::parse(outcome["result"].clone())?;
        validate_viewer_artifacts(store, context, &document)?;
        Ok(PluginViewerDocumentView {
            project_root: context.project_root.clone(),
            project_revision: context.project_revision,
            contribution_id: contribution_id.to_string(),
            document,
            provenance: outcome["provenance"].clone(),
        })
    }

    pub(crate) fn get_panel_contribution(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<PluginViewerDocumentView> {
        let outcome = self.invoke_file_contribution(
            context,
            contribution_id,
            ContributionInvocationOrigin::TrustedPanel,
            input,
            store,
        )?;
        ensure!(
            outcome["status"] == "completed",
            "plugin Panel returned a failed terminal result"
        );
        let document = ViewerDocumentV1::parse(outcome["result"].clone())?;
        validate_viewer_artifacts(store, context, &document)?;
        Ok(PluginViewerDocumentView {
            project_root: context.project_root.clone(),
            project_revision: context.project_revision,
            contribution_id: contribution_id.to_string(),
            document,
            provenance: outcome["provenance"].clone(),
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
        PluginLifecycleMutationService::new(store).discover(
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
        let key = registry_key(&context.project_root, plugin_id);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lifecycle = PluginLifecycleQueryService::new(store)
            .get_state(&context.project_root, plugin.manifest.id.as_str())?
            .context("durable plugin lifecycle state disappeared after discovery")?;

        if let Some(active) = state.active.get(&key)
            && active.package_digest == plugin.digest.as_str()
            && active.plugin_version == plugin.manifest.version.to_string()
            && lifecycle.desired_state == "enabled"
            && lifecycle.observed_state == "active"
            && lifecycle.accepted_digest.as_deref() == Some(plugin.digest.as_str())
        {
            return Ok(WorkspacePluginEnableResult {
                status: "enabled".to_string(),
                plugin_id: plugin_id.to_string(),
                request_ids: Vec::new(),
                active_grant_count: active.handles.len(),
                transition_id: lifecycle.transition_id,
                message: "The exact plugin package is already enabled.".to_string(),
            });
        }
        if lifecycle
            .accepted_digest
            .as_deref()
            .is_some_and(|accepted| accepted != plugin.digest.as_str())
            || state.active.get(&key).is_some_and(|active| {
                active.package_digest != plugin.digest.as_str()
                    || active.plugin_version != plugin.manifest.version.to_string()
            })
        {
            bail!(
                "plugin package changed after enablement; update review is not available until P2-4E"
            );
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
                transition_id: Some(pending.transition_id.clone()),
                message: "Review the requested permissions before this plugin can start."
                    .to_string(),
            });
        }

        remove_active_plugin(&mut state, &key);
        state.pending.remove(&key);

        let transition_id = format!("transition.enable.{}", uuid::Uuid::new_v4().simple());
        let requested = PluginLifecycleMutationService::new(store).request_transition(
            &context.project_root,
            &WorkspacePluginTransitionDraft {
                transition_id: transition_id.clone(),
                project_root: context.project_root.clone(),
                plugin_id: plugin.manifest.id.to_string(),
                kind: "enable".to_string(),
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
            "plugin enable conflicts with another durable lifecycle transition"
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
        let cache = PluginPackageCache::new(&context.app_data_dir);
        let cached = match cache.prepare_exact(
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
                    "package_cache_failed",
                    "disabled",
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
                "package_backup_journal_failed",
                "disabled",
            );
            return Err(error);
        }

        let (reusable_grants, requests) = match plan_plugin_permissions(store, context, &plugin) {
            Ok(plan) => plan,
            Err(error) => {
                let _ = fail_enable_transition(
                    store,
                    context,
                    &transition_id,
                    "permission_plan_failed",
                    "disabled",
                );
                return Err(error);
            }
        };

        if !requests.is_empty() {
            let created = match PluginPermissionMutationService::new(store)
                .create_requests(&context.project_root, &requests)
            {
                Ok(created) => created,
                Err(error) => {
                    let _ = fail_enable_transition(
                        store,
                        context,
                        &transition_id,
                        "permission_request_failed",
                        "disabled",
                    );
                    return Err(error.into());
                }
            };
            let request_ids = created
                .into_iter()
                .map(|request| request.request_id)
                .collect::<Vec<_>>();
            state.pending.insert(
                key,
                PendingEnable {
                    kind: PendingActivationKind::Enable,
                    plugin_id: plugin_id.to_string(),
                    plugin_version: plugin.manifest.version.to_string(),
                    package_digest: plugin.digest.to_string(),
                    transition_id: transition_id.clone(),
                    request_ids: request_ids.clone(),
                    expected_project_revision: context.project_revision,
                },
            );
            return Ok(WorkspacePluginEnableResult {
                status: "permission_required".to_string(),
                plugin_id: plugin_id.to_string(),
                request_ids,
                active_grant_count: reusable_grants.len(),
                transition_id: Some(transition_id),
                message: "Review the requested permissions before this plugin can start."
                    .to_string(),
            });
        }

        activate_plugin_durable(
            &mut state,
            context,
            &plugin,
            &cached,
            &transition_id,
            reusable_grants.values(),
            store,
        )
    }

    pub(crate) fn retry(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        store: &mut Store,
    ) -> Result<WorkspacePluginEnableResult> {
        ensure!(
            context.project_revision >= 0,
            "plugin Retry requires a current project revision"
        );
        PluginId::new(plugin_id.to_string()).context("validating workspace plugin id")?;
        let key = registry_key(&context.project_root, plugin_id);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let lifecycle = PluginLifecycleQueryService::new(store)
            .get_state(&context.project_root, plugin_id)?
            .context("workspace plugin has no durable lifecycle state")?;
        ensure!(
            lifecycle.desired_state == "enabled",
            "only a durably enabled plugin can be retried"
        );
        if lifecycle.observed_state == "blocked" {
            bail!("plugin Retry is blocked after repeated crashes; disable and review it first");
        }
        ensure!(
            lifecycle.observed_state == "crashed",
            "plugin Retry is available only for crashed plugins"
        );
        ensure!(
            !state.active.contains_key(&key),
            "crashed plugin still has a live host"
        );
        let accepted_digest = lifecycle
            .accepted_digest
            .as_deref()
            .context("crashed plugin has no accepted package digest")?;
        let plugin = discover_exact_plugin(Path::new(&context.project_root), plugin_id)?;
        ensure!(
            plugin.digest.as_str() == accepted_digest,
            "crashed plugin package changed before Retry"
        );
        let (transition_id, cached) = prepare_retry_transition(store, context, &plugin)?;
        let (reusable_grants, requests) = match plan_plugin_permissions(store, context, &plugin) {
            Ok(plan) => plan,
            Err(error) => {
                let _ = fail_enable_transition(
                    store,
                    context,
                    &transition_id,
                    "retry_permission_plan_failed",
                    "crashed",
                );
                return Err(error);
            }
        };
        if !requests.is_empty() {
            let created = match PluginPermissionMutationService::new(store)
                .create_requests(&context.project_root, &requests)
            {
                Ok(created) => created,
                Err(error) => {
                    let _ = fail_enable_transition(
                        store,
                        context,
                        &transition_id,
                        "retry_permission_request_failed",
                        "crashed",
                    );
                    return Err(error.into());
                }
            };
            let request_ids = created
                .into_iter()
                .map(|request| request.request_id)
                .collect::<Vec<_>>();
            state.pending.insert(
                key,
                PendingEnable {
                    kind: PendingActivationKind::Retry,
                    plugin_id: plugin_id.to_string(),
                    plugin_version: plugin.manifest.version.to_string(),
                    package_digest: plugin.digest.to_string(),
                    transition_id: transition_id.clone(),
                    request_ids: request_ids.clone(),
                    expected_project_revision: context.project_revision,
                },
            );
            return Ok(WorkspacePluginEnableResult {
                status: "permission_required".to_string(),
                plugin_id: plugin_id.to_string(),
                request_ids,
                active_grant_count: reusable_grants.len(),
                transition_id: Some(transition_id),
                message: "Retry requires fresh permission review before a new host can start."
                    .to_string(),
            });
        }
        activate_plugin_durable(
            &mut state,
            context,
            &plugin,
            &cached,
            &transition_id,
            reusable_grants.values(),
            store,
        )
    }

    pub(crate) fn request_update(
        &self,
        context: &PluginRuntimeContext,
        input: &WorkspacePluginUpdateInput,
        store: &mut Store,
    ) -> Result<WorkspacePluginEnableResult> {
        ensure!(
            input.expected_project_revision == context.project_revision,
            "workspace plugin Update is stale after a project change"
        );
        PluginId::new(input.plugin_id.clone()).context("validating workspace plugin id")?;
        ensure!(
            input.expected_old_digest != input.candidate_digest,
            "workspace plugin Update candidate must differ from accepted digest"
        );
        let plugin = discover_exact_plugin(Path::new(&context.project_root), &input.plugin_id)?;
        ensure!(
            plugin.digest.as_str() == input.candidate_digest,
            "workspace plugin Update candidate changed before review"
        );
        PluginLifecycleMutationService::new(store).discover(
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
        let lifecycle = PluginLifecycleQueryService::new(store)
            .get_state(&context.project_root, &input.plugin_id)?
            .context("workspace plugin has no durable lifecycle state")?;
        ensure!(
            lifecycle.desired_state == "enabled"
                && lifecycle.observed_state == "update_pending"
                && lifecycle.accepted_digest.as_deref() == Some(input.expected_old_digest.as_str())
                && lifecycle.pending_digest.as_deref() == Some(input.candidate_digest.as_str()),
            "workspace plugin Update pointers are stale"
        );
        let key = registry_key(&context.project_root, &input.plugin_id);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let active = state
            .active
            .get(&key)
            .context("workspace plugin Update requires the accepted runtime to be active")?;
        ensure!(
            active.package_digest == input.expected_old_digest,
            "workspace plugin Update expected-old runtime is stale"
        );
        ensure!(
            !state.pending.contains_key(&key),
            "workspace plugin Update already has pending permission review"
        );
        let transition_id = format!("transition.upgrade.{}", uuid::Uuid::new_v4().simple());
        let requested = PluginLifecycleMutationService::new(store).request_transition(
            &context.project_root,
            &WorkspacePluginTransitionDraft {
                transition_id: transition_id.clone(),
                project_root: context.project_root.clone(),
                plugin_id: input.plugin_id.clone(),
                kind: "upgrade".to_string(),
                request_event_type: "user_requested".to_string(),
                desired_state: "enabled".to_string(),
                expected_old_digest: Some(input.expected_old_digest.clone()),
                candidate_digest: Some(input.candidate_digest.clone()),
                rollback_digest: None,
                backup_path_key: None,
            },
        )?;
        ensure!(
            matches!(
                requested.outcome,
                PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
            ),
            "workspace plugin Update conflicts with another lifecycle transition"
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
            &input.plugin_id,
            &input.candidate_digest,
        ) {
            Ok(cached) => cached,
            Err(error) => {
                let _ = fail_enable_transition(
                    store,
                    context,
                    &transition_id,
                    "update_package_cache_failed",
                    "update_pending",
                );
                return Err(error.into());
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
        let (reusable_grants, requests) = plan_plugin_permissions(store, context, &plugin)?;
        if !requests.is_empty() {
            let created = match PluginPermissionMutationService::new(store)
                .create_requests(&context.project_root, &requests)
            {
                Ok(created) => created,
                Err(error) => {
                    let _ = fail_enable_transition(
                        store,
                        context,
                        &transition_id,
                        "update_permission_request_failed",
                        "update_pending",
                    );
                    return Err(error.into());
                }
            };
            let request_ids = created
                .into_iter()
                .map(|request| request.request_id)
                .collect::<Vec<_>>();
            state.pending.insert(
                key,
                PendingEnable {
                    kind: PendingActivationKind::Upgrade {
                        expected_old_digest: input.expected_old_digest.clone(),
                    },
                    plugin_id: input.plugin_id.clone(),
                    plugin_version: plugin.manifest.version.to_string(),
                    package_digest: input.candidate_digest.clone(),
                    transition_id: transition_id.clone(),
                    request_ids: request_ids.clone(),
                    expected_project_revision: context.project_revision,
                },
            );
            return Ok(WorkspacePluginEnableResult {
                status: "permission_required".to_string(),
                plugin_id: input.plugin_id.clone(),
                request_ids,
                active_grant_count: reusable_grants.len(),
                transition_id: Some(transition_id),
                message: "Review fresh permissions for the exact local Update candidate. The accepted old route remains active until CAS."
                    .to_string(),
            });
        }
        let result = activate_plugin_replacement_durable(
            &mut state,
            context,
            &plugin,
            &cached,
            &transition_id,
            &input.expected_old_digest,
            reusable_grants.values(),
            store,
        )?;
        revoke_exact_durable_grants(
            &mut state,
            store,
            context,
            &input.plugin_id,
            &input.expected_old_digest,
            "plugin_updated",
        )?;
        Ok(result)
    }

    pub(crate) fn request_rollback(
        &self,
        context: &PluginRuntimeContext,
        input: &WorkspacePluginRollbackInput,
        store: &mut Store,
    ) -> Result<WorkspacePluginEnableResult> {
        ensure!(
            input.expected_project_revision == context.project_revision,
            "workspace plugin Rollback is stale after a project change"
        );
        PluginId::new(input.plugin_id.clone()).context("validating workspace plugin id")?;
        ensure!(
            input.expected_current_digest != input.rollback_digest,
            "workspace plugin Rollback target must differ from current digest"
        );
        let lifecycle = PluginLifecycleQueryService::new(store)
            .get_state(&context.project_root, &input.plugin_id)?
            .context("workspace plugin has no durable lifecycle state")?;
        ensure!(
            lifecycle.desired_state == "enabled"
                && lifecycle.observed_state == "active"
                && lifecycle.accepted_digest.as_deref()
                    == Some(input.expected_current_digest.as_str())
                && lifecycle.rollback_digest.as_deref() == Some(input.rollback_digest.as_str()),
            "workspace plugin Rollback pointers are stale"
        );
        let current = discover_exact_plugin(Path::new(&context.project_root), &input.plugin_id)?;
        ensure!(
            current.digest.as_str() == input.expected_current_digest,
            "workspace plugin source changed before Rollback"
        );
        let cached = PluginPackageCache::new(&context.app_data_dir)
            .load_exact(
                &context.project_root,
                &input.plugin_id,
                &input.rollback_digest,
            )
            .context("verified Rollback cache target is unavailable")?;
        let target = discovered_from_cache(&lifecycle.directory_name, &cached);
        ensure!(
            target.manifest.id.as_str() == input.plugin_id
                && target.digest.as_str() == input.rollback_digest,
            "workspace plugin Rollback cache identity is stale"
        );
        let key = registry_key(&context.project_root, &input.plugin_id);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let active = state
            .active
            .get(&key)
            .context("workspace plugin Rollback requires the current runtime to be active")?;
        ensure!(
            active.package_digest == input.expected_current_digest,
            "workspace plugin Rollback expected-current runtime is stale"
        );
        ensure!(
            !state.pending.contains_key(&key),
            "workspace plugin Rollback already has pending permission review"
        );
        let transition_id = format!("transition.rollback.{}", uuid::Uuid::new_v4().simple());
        let requested = PluginLifecycleMutationService::new(store).request_transition(
            &context.project_root,
            &WorkspacePluginTransitionDraft {
                transition_id: transition_id.clone(),
                project_root: context.project_root.clone(),
                plugin_id: input.plugin_id.clone(),
                kind: "rollback".to_string(),
                request_event_type: "user_requested".to_string(),
                desired_state: "enabled".to_string(),
                expected_old_digest: Some(input.expected_current_digest.clone()),
                candidate_digest: Some(input.rollback_digest.clone()),
                rollback_digest: None,
                backup_path_key: None,
            },
        )?;
        ensure!(
            matches!(
                requested.outcome,
                PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
            ),
            "workspace plugin Rollback conflicts with another lifecycle transition"
        );
        advance_enable_transition(
            store,
            context,
            &transition_id,
            "requested",
            "preflight",
            "running",
            "rollback_pending",
            None,
            false,
            None,
            "preflight",
            "completed",
            None,
        )?;
        advance_enable_transition(
            store,
            context,
            &transition_id,
            "preflight",
            "backup_prepared",
            "running",
            "rollback_pending",
            None,
            false,
            None,
            "package_backed_up",
            "completed",
            None,
        )?;
        let requests = plan_fresh_plugin_permissions(context, &target)?;
        if !requests.is_empty() {
            let created = match PluginPermissionMutationService::new(store)
                .create_requests(&context.project_root, &requests)
            {
                Ok(created) => created,
                Err(error) => {
                    let _ = fail_enable_transition(
                        store,
                        context,
                        &transition_id,
                        "rollback_permission_request_failed",
                        "rollback_pending",
                    );
                    return Err(error.into());
                }
            };
            let request_ids = created
                .into_iter()
                .map(|request| request.request_id)
                .collect::<Vec<_>>();
            state.pending.insert(
                key,
                PendingEnable {
                    kind: PendingActivationKind::Rollback {
                        expected_old_digest: input.expected_current_digest.clone(),
                    },
                    plugin_id: input.plugin_id.clone(),
                    plugin_version: target.manifest.version.to_string(),
                    package_digest: input.rollback_digest.clone(),
                    transition_id: transition_id.clone(),
                    request_ids: request_ids.clone(),
                    expected_project_revision: context.project_revision,
                },
            );
            return Ok(WorkspacePluginEnableResult {
                status: "permission_required".to_string(),
                plugin_id: input.plugin_id.clone(),
                request_ids,
                active_grant_count: 0,
                transition_id: Some(transition_id),
                message: "Rollback requires fresh permission review for the exact cached target. No historical grant or handle is reused."
                    .to_string(),
            });
        }
        let result = activate_plugin_replacement_durable(
            &mut state,
            context,
            &target,
            &cached,
            &transition_id,
            &input.expected_current_digest,
            std::iter::empty(),
            store,
        )?;
        revoke_exact_durable_grants(
            &mut state,
            store,
            context,
            &input.plugin_id,
            &input.expected_current_digest,
            "plugin_rolled_back",
        )?;
        Ok(result)
    }

    pub(crate) fn disable(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        store: &mut Store,
    ) -> Result<WorkspacePluginDisableResult> {
        self.teardown_plugin(
            context,
            plugin_id,
            "disable",
            "user_requested",
            false,
            store,
        )
    }

    pub(crate) fn uninstall(
        &self,
        context: &PluginRuntimeContext,
        input: &WorkspacePluginUninstallInput,
        store: &mut Store,
    ) -> Result<WorkspacePluginUninstallResult> {
        ensure!(
            input.confirmed,
            "workspace plugin Uninstall was not confirmed"
        );
        ensure!(
            input.expected_project_revision == context.project_revision,
            "workspace plugin Uninstall is stale after a project change"
        );
        PluginId::new(input.plugin_id.clone()).context("validating workspace plugin id")?;
        let lifecycle = PluginLifecycleQueryService::new(store)
            .get_state(&context.project_root, &input.plugin_id)?
            .context("workspace plugin has no durable lifecycle state")?;
        ensure!(
            lifecycle.directory_name == input.directory_name
                && lifecycle.accepted_digest.as_deref() == Some(input.package_digest.as_str()),
            "workspace plugin Uninstall confirmation is stale for this directory or digest"
        );
        ensure!(
            lifecycle.desired_state != "uninstalled",
            "workspace plugin is already uninstalled"
        );

        let disabled = self.disable(context, &input.plugin_id, store)?;
        ensure!(
            disabled.route_closed && disabled.status != "completion_uncertain",
            "workspace plugin teardown did not reach durable non-routable truth"
        );

        let pending_requests = PluginPermissionQueryService::new(store)
            .list_requests(&context.project_root, Some(200), Some("pending"))?
            .into_iter()
            .filter(|request| {
                request.plugin_id == input.plugin_id
                    && request.package_digest == input.package_digest
            })
            .collect::<Vec<_>>();
        let mut pending_requests_cancelled = 0usize;
        for request in pending_requests {
            let outcome = PluginPermissionMutationService::new(store).cancel_request(
                &context.project_root,
                &request.request_id,
                request.expected_project_revision,
                "plugin_uninstalled",
            )?;
            ensure!(
                matches!(
                    outcome,
                    PluginPermissionMutationOutcome::Applied
                        | PluginPermissionMutationOutcome::Unchanged
                ),
                "workspace plugin pending permission cancellation was stale"
            );
            pending_requests_cancelled += 1;
        }
        let durable_grants = PluginPermissionQueryService::new(store)
            .list_grants(&context.project_root, Some(200), Some("active"))?
            .into_iter()
            .filter(|grant| {
                grant.plugin_id == input.plugin_id && grant.package_digest == input.package_digest
            })
            .collect::<Vec<_>>();
        let mut durable_grants_revoked = 0usize;
        for grant in durable_grants {
            let outcome = PluginPermissionMutationService::new(store).revoke_grant(
                &context.project_root,
                &grant.grant_id,
                "plugin_uninstalled",
            )?;
            ensure!(
                matches!(
                    outcome,
                    PluginPermissionMutationOutcome::Applied
                        | PluginPermissionMutationOutcome::Unchanged
                ),
                "workspace plugin durable grant revoke was stale"
            );
            self.state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .grants
                .revoke_durable_grant(&grant.grant_id);
            durable_grants_revoked += 1;
        }

        let plugin = discover_exact_plugin(Path::new(&context.project_root), &input.plugin_id)?;
        ensure!(
            plugin.directory == input.directory_name
                && plugin.digest.as_str() == input.package_digest,
            "workspace plugin package changed after Uninstall confirmation"
        );
        let lifecycle = PluginLifecycleQueryService::new(store)
            .get_state(&context.project_root, &input.plugin_id)?
            .context("workspace plugin lifecycle state disappeared before Uninstall")?;
        ensure!(
            lifecycle.desired_state == "disabled"
                && matches!(lifecycle.observed_state.as_str(), "disabled" | "stopped")
                && lifecycle.accepted_digest.as_deref() == Some(input.package_digest.as_str()),
            "workspace plugin is not durably disabled for the confirmed digest"
        );

        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let transition_id = format!("transition.uninstall.{suffix}");
        let trash_key = format!("trash.{suffix}");
        let tombstone_id = format!("tombstone.{suffix}");
        let requested = PluginLifecycleMutationService::new(store).request_transition(
            &context.project_root,
            &WorkspacePluginTransitionDraft {
                transition_id: transition_id.clone(),
                project_root: context.project_root.clone(),
                plugin_id: input.plugin_id.clone(),
                kind: "uninstall".to_string(),
                request_event_type: "user_requested".to_string(),
                desired_state: "uninstalled".to_string(),
                expected_old_digest: Some(input.package_digest.clone()),
                candidate_digest: None,
                rollback_digest: None,
                backup_path_key: Some(trash_key.clone()),
            },
        )?;
        ensure!(
            matches!(
                requested.outcome,
                PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
            ),
            "workspace plugin Uninstall conflicts with durable lifecycle truth"
        );

        PluginPackageTrash::new()
            .move_exact(
                Path::new(&context.project_root),
                &input.directory_name,
                &input.plugin_id,
                &input.package_digest,
                &trash_key,
            )
            .context("moving exact workspace plugin package into recoverable trash")?;
        record_disable_phase(
            store,
            context,
            &transition_id,
            "requested",
            "package_moved",
            "running",
            "disposing",
            "recovery",
            "completed",
            None,
            serde_json::json!({"package_ownership":"trash","recoverable":true}),
        )
        .context("recording recoverable workspace plugin package ownership")?;
        let completed = PluginLifecycleMutationService::new(store)
            .complete_uninstall(
                &context.project_root,
                &transition_id,
                &WorkspacePluginTombstoneDraft {
                    tombstone_id: tombstone_id.clone(),
                    project_root: context.project_root.clone(),
                    plugin_id: input.plugin_id.clone(),
                    package_digest: input.package_digest.clone(),
                    backup_path_key: trash_key,
                    original_directory_name: input.directory_name.clone(),
                    retention_class: "recoverable".to_string(),
                    reason_code: "user_uninstall".to_string(),
                },
            )
            .context(
                "exact package moved, but durable Uninstall completion failed; recovery is required",
            )?;
        ensure!(
            matches!(
                completed.outcome,
                PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
            ),
            "workspace plugin Uninstall completion was stale"
        );
        Ok(WorkspacePluginUninstallResult {
            status: "uninstalled".to_string(),
            plugin_id: input.plugin_id.clone(),
            transition_id,
            tombstone_id,
            project_revision: context.project_revision,
            route_closed: true,
            pending_requests_cancelled,
            durable_grants_revoked,
            message: "The exact package moved to recoverable Rho trash. It is uninstalled, non-routable, and has no durable grant.".to_string(),
        })
    }

    pub(crate) fn restore(
        &self,
        context: &PluginRuntimeContext,
        input: &WorkspacePluginRestoreInput,
        store: &mut Store,
    ) -> Result<WorkspacePluginRestoreResult> {
        ensure!(
            input.expected_project_revision == context.project_revision,
            "workspace plugin Restore is stale after a project change"
        );
        let tombstone = PluginLifecycleQueryService::new(store)
            .get_tombstone(&context.project_root, &input.tombstone_id)?
            .context("recoverable workspace plugin tombstone was not found")?;
        ensure!(
            tombstone.retention_class == "recoverable"
                && tombstone.deleted_at.is_none()
                && tombstone.restored_at.is_none(),
            "workspace plugin tombstone is not recoverable"
        );
        let lifecycle = PluginLifecycleQueryService::new(store)
            .get_state(&context.project_root, &tombstone.plugin_id)?
            .context("workspace plugin lifecycle state is missing for Restore")?;
        ensure!(
            lifecycle.desired_state == "uninstalled"
                && lifecycle.observed_state == "uninstalled"
                && lifecycle.directory_name == tombstone.original_directory_name
                && lifecycle.accepted_digest.as_deref() == Some(tombstone.package_digest.as_str()),
            "workspace plugin Restore identity is stale"
        );
        let exact_active_grants = PluginPermissionQueryService::new(store)
            .list_grants(&context.project_root, Some(200), Some("active"))?
            .into_iter()
            .filter(|grant| {
                grant.plugin_id == tombstone.plugin_id
                    && grant.package_digest == tombstone.package_digest
            })
            .count();
        ensure!(
            exact_active_grants == 0,
            "workspace plugin Restore refuses durable authority"
        );
        let key = registry_key(&context.project_root, &tombstone.plugin_id);
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        ensure!(
            !state.active.contains_key(&key) && !state.pending.contains_key(&key),
            "workspace plugin Restore refuses live or pending authority"
        );
        drop(state);

        PluginPackageTrash::new()
            .restore_exact(
                Path::new(&context.project_root),
                &tombstone.original_directory_name,
                &tombstone.plugin_id,
                &tombstone.package_digest,
                &tombstone.backup_path_key,
            )
            .context("restoring exact workspace plugin package from recoverable trash")?;
        let completed = PluginLifecycleMutationService::new(store)
            .complete_restore(&context.project_root, &tombstone.tombstone_id)
            .context(
                "exact package restored, but durable Restore completion failed; recovery is required",
            )?;
        ensure!(
            matches!(
                completed.outcome,
                PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
            ),
            "workspace plugin Restore completion was stale"
        );
        Ok(WorkspacePluginRestoreResult {
            status: "disabled".to_string(),
            plugin_id: tombstone.plugin_id,
            tombstone_id: tombstone.tombstone_id,
            project_revision: context.project_revision,
            message: "The exact package was restored to this project in Disabled state. No route, host, handle, or durable grant was created.".to_string(),
        })
    }

    fn teardown_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        transition_kind: &str,
        request_event_type: &str,
        preserve_desired_state: bool,
        store: &mut Store,
    ) -> Result<WorkspacePluginDisableResult> {
        ensure!(
            context.project_revision >= 0,
            "plugin teardown requires a current project revision"
        );
        PluginId::new(plugin_id.to_string()).context("validating workspace plugin id")?;
        let key = registry_key(&context.project_root, plugin_id);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut lifecycle = PluginLifecycleQueryService::new(store)
            .get_state(&context.project_root, plugin_id)?
            .context("workspace plugin has no durable lifecycle state")?;
        let already_terminal = if preserve_desired_state {
            lifecycle.observed_state == "stopped"
        } else {
            lifecycle.desired_state == "disabled"
                && matches!(lifecycle.observed_state.as_str(), "disabled" | "stopped")
        };
        if already_terminal && !state.active.contains_key(&key) && !state.pending.contains_key(&key)
        {
            let transition_nonterminal = lifecycle
                .transition_id
                .as_deref()
                .map(|transition_id| {
                    PluginLifecycleQueryService::new(store)
                        .get_transition(&context.project_root, transition_id)
                })
                .transpose()?
                .flatten()
                .is_some_and(|transition| {
                    matches!(
                        transition.status.as_str(),
                        "pending" | "running" | "completion_uncertain"
                    )
                });
            if transition_nonterminal {
                return Ok(WorkspacePluginDisableResult {
                    status: "completion_uncertain".to_string(),
                    plugin_id: plugin_id.to_string(),
                    transition_id: lifecycle.transition_id,
                    route_closed: true,
                    calls_cancelled: 0,
                    pending_requests_cancelled: 0,
                    handles_revoked: 0,
                    contributions_disposed: 0,
                    host_disposed: true,
                    errors: vec!["durable_teardown_nonterminal".to_string()],
                    message: "The plugin is non-routable, but durable teardown completion remains uncertain."
                        .to_string(),
                });
            }
            return Ok(WorkspacePluginDisableResult {
                status: if preserve_desired_state {
                    "stopped"
                } else {
                    "disabled"
                }
                .to_string(),
                plugin_id: plugin_id.to_string(),
                transition_id: lifecycle.transition_id,
                route_closed: true,
                calls_cancelled: 0,
                pending_requests_cancelled: 0,
                handles_revoked: 0,
                contributions_disposed: 0,
                host_disposed: true,
                errors: Vec::new(),
                message: if preserve_desired_state {
                    "The plugin runtime is already durably stopped."
                } else {
                    "The plugin is already durably disabled."
                }
                .to_string(),
            });
        }
        if let Some(current_transition_id) = lifecycle.transition_id.as_deref()
            && let Some(current) = PluginLifecycleQueryService::new(store)
                .get_transition(&context.project_root, current_transition_id)?
            && matches!(
                current.status.as_str(),
                "pending" | "running" | "completion_uncertain"
            )
        {
            fail_enable_transition(
                store,
                context,
                current_transition_id,
                if preserve_desired_state {
                    "boundary_teardown"
                } else {
                    "user_disabled"
                },
                "disabled",
            )?;
            lifecycle = PluginLifecycleQueryService::new(store)
                .get_state(&context.project_root, plugin_id)?
                .context("workspace plugin lifecycle state disappeared during disable")?;
        }
        let transition_id = format!(
            "transition.{}.{}",
            transition_kind.replace('_', "-"),
            uuid::Uuid::new_v4().simple()
        );
        let requested = PluginLifecycleMutationService::new(store).request_transition(
            &context.project_root,
            &WorkspacePluginTransitionDraft {
                transition_id: transition_id.clone(),
                project_root: context.project_root.clone(),
                plugin_id: plugin_id.to_string(),
                kind: transition_kind.to_string(),
                request_event_type: request_event_type.to_string(),
                desired_state: if preserve_desired_state {
                    lifecycle.desired_state.clone()
                } else {
                    "disabled".to_string()
                },
                expected_old_digest: lifecycle.accepted_digest.clone(),
                candidate_digest: None,
                rollback_digest: None,
                backup_path_key: None,
            },
        )?;
        ensure!(
            matches!(
                requested.outcome,
                PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
            ),
            "plugin disable conflicts with another durable lifecycle transition"
        );

        let mut errors = Vec::new();
        let mut persistence_failed = false;
        let pending_memory = state.pending.remove(&key);
        let mut active = state.active.remove(&key);
        let contributions_disposed = active
            .as_ref()
            .and_then(|active| active.contribution_identity.as_ref())
            .map(|identity| {
                let count = state
                    .contributions
                    .list(&identity.project_id)
                    .into_iter()
                    .filter(|record| {
                        record.plugin_id == identity.plugin_id
                            && record.package_digest == identity.package_digest
                            && record.activation_generation == identity.activation_generation
                            && record.host_instance_id == identity.host_instance_id
                    })
                    .count();
                state.contributions.clear_instance(
                    &identity.project_id,
                    &identity.plugin_id,
                    &identity.package_digest,
                    identity.activation_generation,
                    &identity.host_instance_id,
                );
                count
            })
            .unwrap_or(0);
        if record_disable_phase(
            store,
            context,
            &transition_id,
            "requested",
            "routing_closed",
            "running",
            "quiescing",
            "call_drain",
            "pending",
            None,
            serde_json::json!({"routes_closed": contributions_disposed}),
        )
        .is_err()
        {
            persistence_failed = true;
            push_teardown_error(&mut errors, "routing_close_persistence_failed");
        }

        let mut calls_cancelled = 0usize;
        if let Some(active) = active.as_mut()
            && let Some(request_id) = active.host.active_broker_request_id()
        {
            match active.host.cancel_broker_call(&request_id) {
                Ok(true) => calls_cancelled = 1,
                Ok(false) => {}
                Err(_) => {
                    push_teardown_error(&mut errors, "guest_call_cancel_failed");
                    active.host.quarantine_for_timeout();
                }
            }
        }
        if record_disable_phase(
            store,
            context,
            &transition_id,
            "routing_closed",
            "calls_drained",
            "running",
            "quiescing",
            "call_drain",
            "completed",
            None,
            serde_json::json!({"calls_cancelled": calls_cancelled}),
        )
        .is_err()
        {
            persistence_failed = true;
            push_teardown_error(&mut errors, "call_drain_persistence_failed");
        }

        let pending_requests = PluginPermissionQueryService::new(store)
            .list_requests(&context.project_root, Some(100), Some("pending"))?
            .into_iter()
            .filter(|request| request.plugin_id == plugin_id)
            .collect::<Vec<_>>();
        let mut pending_requests_cancelled = 0usize;
        for request in pending_requests {
            match PluginPermissionMutationService::new(store).cancel_request(
                &context.project_root,
                &request.request_id,
                request.expected_project_revision,
                "plugin_disabled",
            ) {
                Ok(PluginPermissionMutationOutcome::Applied)
                | Ok(PluginPermissionMutationOutcome::Unchanged) => {
                    pending_requests_cancelled += 1;
                }
                Ok(_) | Err(_) => {
                    persistence_failed = true;
                    push_teardown_error(&mut errors, "permission_cancel_failed");
                }
            }
        }
        if let Some(pending) = pending_memory {
            pending_requests_cancelled = pending_requests_cancelled.max(pending.request_ids.len());
        }
        let handles_revoked = active
            .as_ref()
            .map(|active| state.grants.invalidate_host(&active.host_instance_id))
            .unwrap_or(0);
        if record_disable_phase(
            store,
            context,
            &transition_id,
            "calls_drained",
            "handles_revoked",
            "running",
            "disposing",
            "handles_revoked",
            "completed",
            None,
            serde_json::json!({
                "revoked_count": handles_revoked,
                "requests_cancelled": pending_requests_cancelled
            }),
        )
        .is_err()
        {
            persistence_failed = true;
            push_teardown_error(&mut errors, "handle_revoke_persistence_failed");
        }
        if record_disable_phase(
            store,
            context,
            &transition_id,
            "handles_revoked",
            "contributions_disposed",
            "running",
            "disposing",
            "contributions_disposed",
            "completed",
            None,
            serde_json::json!({"contributions_disposed": contributions_disposed}),
        )
        .is_err()
        {
            persistence_failed = true;
            push_teardown_error(&mut errors, "contribution_dispose_persistence_failed");
        }

        let mut host_disposed = active.is_none();
        if let Some(active) = active.as_mut() {
            let instance_id = active.host_instance_id.clone();
            if matches!(
                active.host.state(),
                HostInstanceState::Active | HostInstanceState::Ready
            ) && !matches!(
                active.host.handle_frame(HostFrame {
                    instance_id: instance_id.clone(),
                    message: HostMessage::Quiesce,
                }),
                Ok(Some(HostResponse::Quiesced))
            ) {
                push_teardown_error(&mut errors, "guest_quiesce_failed");
            }
            if matches!(
                active.host.state(),
                HostInstanceState::Active | HostInstanceState::Ready | HostInstanceState::Quiescing
            ) {
                host_disposed = matches!(
                    active.host.handle_frame(HostFrame {
                        instance_id,
                        message: HostMessage::Dispose,
                    }),
                    Ok(Some(HostResponse::Disposed))
                );
            }
            if !host_disposed {
                active.host.quarantine_for_timeout();
                host_disposed = true;
                push_teardown_error(&mut errors, "guest_dispose_forced");
            }
        }
        drop(active);
        if record_disable_phase(
            store,
            context,
            &transition_id,
            "contributions_disposed",
            "host_disposed",
            "running",
            "stopped",
            "host_disposed",
            "completed",
            errors.first().map(String::as_str),
            serde_json::json!({"host_disposed": host_disposed}),
        )
        .is_err()
        {
            persistence_failed = true;
            push_teardown_error(&mut errors, "host_dispose_persistence_failed");
        }

        if !persistence_failed {
            let terminal_reason = (!errors.is_empty()).then_some("teardown_cleanup_error");
            if record_disable_phase(
                store,
                context,
                &transition_id,
                "host_disposed",
                "completed",
                "completed",
                if preserve_desired_state {
                    "stopped"
                } else {
                    "disabled"
                },
                "transition_completed",
                "completed",
                terminal_reason,
                serde_json::json!({"cleanup_errors": errors.len()}),
            )
            .is_err()
            {
                persistence_failed = true;
                push_teardown_error(&mut errors, "terminal_persistence_failed");
            }
        }
        if persistence_failed
            && let Ok(Some(current)) = PluginLifecycleQueryService::new(store)
                .get_transition(&context.project_root, &transition_id)
            && !matches!(
                current.status.as_str(),
                "completed" | "failed" | "cancelled"
            )
        {
            let _ = record_disable_phase(
                store,
                context,
                &transition_id,
                &current.phase,
                "durable_committed",
                "completion_uncertain",
                "stopped",
                "recovery",
                "uncertain",
                Some("teardown_persistence_failed"),
                serde_json::json!({"cleanup_errors": errors.len()}),
            );
        }
        let status = if persistence_failed {
            "completion_uncertain"
        } else if errors.is_empty() {
            if preserve_desired_state {
                "stopped"
            } else {
                "disabled"
            }
        } else {
            if preserve_desired_state {
                "stopped_with_errors"
            } else {
                "disabled_with_errors"
            }
        };
        Ok(WorkspacePluginDisableResult {
            status: status.to_string(),
            plugin_id: plugin_id.to_string(),
            transition_id: Some(transition_id),
            route_closed: true,
            calls_cancelled,
            pending_requests_cancelled,
            handles_revoked,
            contributions_disposed,
            host_disposed,
            errors,
            message: match status {
                "disabled" => "The plugin is durably disabled and no route or live handle remains.",
                "disabled_with_errors" => "The plugin is disabled and non-routable; cleanup diagnostics were recorded.",
                "stopped" => "The plugin runtime is durably stopped; enabled intent is preserved for exact reconstruction.",
                "stopped_with_errors" => "The plugin runtime is stopped and non-routable; cleanup diagnostics were recorded.",
                _ => "The plugin is non-routable, but durable teardown completion is uncertain and will be reconciled.",
            }
            .to_string(),
        })
    }

    pub(crate) fn teardown_project(
        &self,
        context: &PluginRuntimeContext,
        kind: &str,
        store: &mut Store,
    ) -> WorkspacePluginBoundaryTeardownReport {
        let kind = if matches!(kind, "project_teardown" | "shutdown") {
            kind
        } else {
            "project_teardown"
        };
        let mut plugin_ids = PluginLifecycleQueryService::new(store)
            .list_states(
                &context.project_root,
                Some(MAX_PLUGIN_RECONCILIATION_ENTRIES),
            )
            .unwrap_or_default()
            .into_iter()
            .filter(|plugin| plugin.desired_state != "uninstalled")
            .map(|plugin| plugin.plugin_id)
            .collect::<BTreeSet<_>>();
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let prefix = format!("{}\0", normalize_project_root(&context.project_root));
            for key in state.active.keys().chain(state.pending.keys()) {
                if let Some(plugin_id) = key.strip_prefix(&prefix) {
                    plugin_ids.insert(plugin_id.to_string());
                }
            }
        }
        let mut report = WorkspacePluginBoundaryTeardownReport {
            project_root: context.project_root.clone(),
            kind: kind.to_string(),
            attempted: 0,
            completed: 0,
            completion_uncertain: 0,
            forced: 0,
            entries: Vec::new(),
            truncated: false,
        };
        for plugin_id in plugin_ids {
            report.attempted += 1;
            match self.teardown_plugin(context, &plugin_id, kind, "recovery", true, store) {
                Ok(result) => {
                    if result.status == "completion_uncertain" {
                        report.completion_uncertain += 1;
                    } else {
                        report.completed += 1;
                    }
                    push_boundary_teardown_entry(
                        &mut report,
                        WorkspacePluginBoundaryTeardownEntry {
                            plugin_id,
                            status: result.status,
                            route_closed: result.route_closed,
                            error_codes: result.errors,
                        },
                    );
                }
                Err(_) => {
                    let key = registry_key(&context.project_root, &plugin_id);
                    let mut state = self
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    remove_active_plugin(&mut state, &key);
                    state.pending.remove(&key);
                    drop(state);
                    report.forced += 1;
                    push_boundary_teardown_entry(
                        &mut report,
                        WorkspacePluginBoundaryTeardownEntry {
                            plugin_id,
                            status: "forced_non_routable".to_string(),
                            route_closed: true,
                            error_codes: vec!["boundary_teardown_failed".to_string()],
                        },
                    );
                }
            }
        }
        report
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
                            remove_active_plugin(&mut state, &key);
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
                            remove_active_plugin(&mut state, &key);
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
        let crash_identity = self.crash_identity(&key);
        let result =
            self.invoke_plugin_with_hook_inner(context, plugin_id, request, store, after_read);
        if result.is_err()
            && let Some(identity) = crash_identity.as_ref()
        {
            let _ =
                self.persist_crash_if_needed(context, &key, identity, "guest_call_failed", store);
        }
        result
    }

    fn invoke_plugin_with_hook_inner(
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
                            remove_active_plugin(&mut state, &key);
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
                remove_active_plugin(&mut state, key);
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

    #[allow(dead_code)]
    pub(crate) fn begin_contribution_call(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        origin: ContributionInvocationOrigin,
        input: serde_json::Value,
    ) -> Result<(ContributionCallSession, GuestStep)> {
        let contribution_id = rho_extension_runtime::CapabilityId::new(contribution_id.to_string())
            .context("validating contribution id")?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let plugin_id = state
            .contributions
            .get(&context.project_scope_id, &contribution_id)
            .context("contribution is not published for the current project")?
            .plugin_id
            .to_string();
        let key = registry_key(&context.project_root, &plugin_id);
        let RegistryState {
            active,
            contributions,
            ..
        } = &mut *state;
        let active = active
            .get_mut(&key)
            .context("contribution host is not active for the current project")?;
        let handles = if origin == ContributionInvocationOrigin::TrustedCheckRule {
            BTreeMap::new()
        } else {
            active
                .handles
                .values()
                .map(|handle| {
                    (
                        handle.permission.as_static_str().to_string(),
                        handle.id.clone(),
                    )
                })
                .collect()
        };
        ContributionCallSession::begin(
            contributions,
            ContributionCallRequest {
                project_id: context.project_scope_id.clone(),
                contribution_id,
                origin,
                input,
                supplied_handles: handles,
            },
            &SystemContributionClock,
            &mut active.host,
        )
        .map_err(Into::into)
    }

    #[allow(dead_code)]
    pub(crate) fn resume_contribution_call(
        &self,
        context: &PluginRuntimeContext,
        session: &mut ContributionCallSession,
        broker_result: &serde_json::Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep> {
        ensure!(
            session.identity().project_id == context.project_scope_id,
            "contribution call belongs to another project"
        );
        let key = registry_key(&context.project_root, session.identity().plugin_id.as_str());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let result = {
            let RegistryState {
                active,
                contributions,
                ..
            } = &mut *state;
            let active = active
                .get_mut(&key)
                .context("contribution host became inactive before resume")?;
            session.resume(
                contributions,
                broker_result,
                raw_result_bytes,
                &SystemContributionClock,
                &mut active.host,
            )
        };
        if result.is_err()
            && state.active.get(&key).is_some_and(|active| {
                active.host.identity().project_id() == &session.identity().project_id
                    && active.host.identity().plugin_id() == &session.identity().plugin_id
                    && active.host.identity().package_digest() == &session.identity().package_digest
                    && active.host.identity().activation_generation()
                        == session.identity().activation_generation
                    && active.host.identity().host_instance_id()
                        == &session.identity().host_instance_id
            })
        {
            remove_active_plugin(&mut state, &key);
        }
        result.map_err(Into::into)
    }

    #[allow(dead_code)]
    pub(crate) fn finish_contribution_call(
        &self,
        context: &PluginRuntimeContext,
        session: &mut ContributionCallSession,
        step: &GuestStep,
    ) -> Result<ContributionCallOutcome> {
        ensure!(
            session.identity().project_id == context.project_scope_id,
            "contribution call belongs to another project"
        );
        let key = registry_key(&context.project_root, session.identity().plugin_id.as_str());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let RegistryState {
            active,
            contributions,
            grants,
            ..
        } = &mut *state;
        let active = active
            .get_mut(&key)
            .context("contribution host became inactive before completion")?;
        if !session.supplied_handles_are_live(|handle_id| {
            grants.handle_allows_admitted_completion(handle_id)
        }) {
            session.invalidate_before_publish();
            bail!("contribution handle was revoked or expired before completion");
        }
        session
            .finish(
                contributions,
                step,
                &SystemContributionClock,
                &mut active.host,
            )
            .map_err(Into::into)
    }

    pub(crate) fn invoke_file_contribution(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        origin: ContributionInvocationOrigin,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<serde_json::Value> {
        let crash_context = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            rho_extension_runtime::CapabilityId::new(contribution_id.to_string())
                .ok()
                .and_then(|capability| {
                    state
                        .contributions
                        .get(&context.project_scope_id, &capability)
                })
                .and_then(|record| {
                    let key = registry_key(&context.project_root, record.plugin_id.as_str());
                    state.active.get(&key).map(|active| {
                        (
                            key,
                            ActiveCrashIdentity {
                                plugin_id: record.plugin_id.to_string(),
                                package_digest: record.package_digest.to_string(),
                                host_instance_id: active.host_instance_id.clone(),
                            },
                        )
                    })
                })
        };
        let result =
            self.invoke_file_contribution_inner(context, contribution_id, origin, input, store);
        if result.is_err()
            && let Some((key, identity)) = crash_context.as_ref()
        {
            let _ = self.persist_crash_if_needed(
                context,
                key,
                identity,
                "contribution_host_failed",
                store,
            );
        }
        result
    }

    fn invoke_file_contribution_inner(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        origin: ContributionInvocationOrigin,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<serde_json::Value> {
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let capability = rho_extension_runtime::CapabilityId::new(contribution_id.to_string())?;
            let kind = state
                .contributions
                .get(&context.project_scope_id, &capability)
                .context("Agent contribution is not published for this project")?
                .contribution
                .kind;
            ensure!(
                matches!(
                    (origin, kind),
                    (
                        ContributionInvocationOrigin::AgentTool,
                        ContributionKind::Tool
                    ) | (
                        ContributionInvocationOrigin::TrustedSource,
                        ContributionKind::Source
                    ) | (
                        ContributionInvocationOrigin::UserCommand,
                        ContributionKind::Command
                    ) | (
                        ContributionInvocationOrigin::TrustedViewer,
                        ContributionKind::Viewer
                    ) | (
                        ContributionInvocationOrigin::TrustedPanel,
                        ContributionKind::Panel
                    ) | (
                        ContributionInvocationOrigin::TrustedSurface,
                        ContributionKind::Surface
                    ) | (
                        ContributionInvocationOrigin::TrustedCheckRule,
                        ContributionKind::CheckRule
                    )
                ),
                "contribution kind does not match its trusted invocation origin"
            );
        }
        let (mut call, mut step) =
            self.begin_contribution_call(context, contribution_id, origin, input)?;
        let mut permission_event_ids = Vec::new();
        loop {
            match step {
                GuestStep::Complete { .. } | GuestStep::Error { .. } => {
                    let outcome = self.finish_contribution_call(context, &mut call, &step)?;
                    let mut value = serde_json::to_value(outcome)?;
                    value["provenance"]["permission_event_ids"] =
                        serde_json::to_value(permission_event_ids)?;
                    return Ok(value);
                }
                GuestStep::BrokerRequest {
                    handle_id,
                    permission,
                    operation,
                    args,
                    ..
                } => {
                    if permission != "project.fs.read" || operation != "project.fs.read" {
                        step = self.resume_contribution_call(
                            context,
                            &mut call,
                            &serde_json::json!({
                                "ok": false,
                                "error": {"code": "operation_not_available"}
                            }),
                            0,
                        )?;
                        continue;
                    }
                    let file_request: ProjectFsReadRequest = match serde_json::from_value(args) {
                        Ok(request) => request,
                        Err(_) => {
                            step = self.resume_contribution_call(
                                context,
                                &mut call,
                                &serde_json::json!({
                                    "ok": false,
                                    "error": {"code": "invalid_arguments"}
                                }),
                                0,
                            )?;
                            continue;
                        }
                    };
                    let key =
                        registry_key(&context.project_root, call.identity().plugin_id.as_str());
                    let (revalidation, grant_id, plugin_id, package_digest, admitted) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let active = state
                            .active
                            .get(&key)
                            .context("contribution host disappeared before file admission")?;
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
                        let admitted = state.grants.revalidate(revalidation.clone());
                        let grant_id = state
                            .grants
                            .durable_grant_id_for_handle(&handle_id)
                            .map(str::to_string);
                        (
                            revalidation,
                            grant_id,
                            identity.plugin_id().to_string(),
                            identity.package_digest().to_string(),
                            admitted,
                        )
                    };
                    if let Revalidation::Denied(error) = admitted {
                        permission_event_ids.push(record_call_event(
                            store,
                            context,
                            &plugin_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "failed",
                            Some(grant_error_code(error)),
                            serde_json::json!({
                                "operation": "project.fs.read",
                                "contribution": contribution_id
                            }),
                            false,
                        )?);
                        self.cancel_contribution_call(context, &mut call);
                        bail!(
                            "plugin contribution permission was denied: {}",
                            grant_error_code(error)
                        );
                    }
                    let grant_id = grant_id
                        .context("admitted contribution handle has no durable grant identity")?;
                    match record_call_event(
                        store,
                        context,
                        &plugin_id,
                        &package_digest,
                        Some(&grant_id),
                        "call_admitted",
                        "completed",
                        None,
                        serde_json::json!({
                            "operation": "project.fs.read",
                            "contribution": contribution_id
                        }),
                        false,
                    ) {
                        Ok(event_id) => permission_event_ids.push(event_id),
                        Err(error) => {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_contribution_call(context, &mut call);
                            return Err(error);
                        }
                    }
                    let started = Instant::now();
                    let file_result = match read_project_file(
                        Path::new(&context.project_root),
                        u64::try_from(context.project_revision)
                            .context("current project revision is negative")?,
                        &file_request,
                    ) {
                        Ok(result) => result,
                        Err(error) => {
                            let code = project_file_error_code(error.code);
                            let event = record_call_event(
                                store,
                                context,
                                &plugin_id,
                                &package_digest,
                                Some(&grant_id),
                                "call_failed",
                                "failed",
                                Some(code),
                                serde_json::json!({
                                    "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                    "operation": "project.fs.read",
                                    "contribution": contribution_id
                                }),
                                false,
                            );
                            self.release_plugin_admission(&handle_id);
                            permission_event_ids.push(event?);
                            step = self.resume_contribution_call(
                                context,
                                &mut call,
                                &serde_json::json!({"ok": false, "error": {"code": code}}),
                                0,
                            )?;
                            continue;
                        }
                    };
                    let still_admitted = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.active.get(&key).is_some_and(|active| {
                            active.host.identity().host_instance_id()
                                == &revalidation.host_instance_id
                        }) && state.grants.revalidate_admitted(&revalidation)
                            == Revalidation::Allowed
                    };
                    if !still_admitted {
                        permission_event_ids.push(record_call_event(
                            store,
                            context,
                            &plugin_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "stale",
                            Some("stale_after_dispatch"),
                            serde_json::json!({
                                "operation": "project.fs.read",
                                "contribution": contribution_id
                            }),
                            false,
                        )?);
                        self.release_plugin_admission(&handle_id);
                        self.cancel_contribution_call(context, &mut call);
                        bail!("plugin contribution became stale after file dispatch");
                    }
                    let completion_event = record_call_event(
                        store,
                        context,
                        &plugin_id,
                        &package_digest,
                        Some(&grant_id),
                        "call_completed",
                        "completed",
                        None,
                        serde_json::json!({
                            "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                            "operation": "project.fs.read",
                            "sizeBytes": file_result.size_bytes,
                            "contribution": contribution_id
                        }),
                        true,
                    );
                    let completion_event = match completion_event {
                        Ok(event_id) => event_id,
                        Err(error) => {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_contribution_call(context, &mut call);
                            return Err(error);
                        }
                    };
                    permission_event_ids.push(completion_event);
                    {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if state.grants.revalidate_admitted(&revalidation) != Revalidation::Allowed
                        {
                            state.grants.complete_uncertain(&handle_id);
                            drop(state);
                            self.cancel_contribution_call(context, &mut call);
                            bail!(
                                "plugin contribution grant became stale after durable completion"
                            );
                        }
                        state.grants.complete_success(&handle_id);
                    }
                    let result_value = serde_json::to_value(&file_result)?;
                    let resumed = self.resume_contribution_call(
                        context,
                        &mut call,
                        &serde_json::json!({"ok": true, "value": result_value}),
                        file_result.size_bytes as usize,
                    );
                    step = match resumed {
                        Ok(step) => step,
                        Err(error) => {
                            record_call_event(
                                store,
                                context,
                                &plugin_id,
                                &package_digest,
                                None,
                                "call_failed",
                                "failed",
                                Some("guest_resume_failed"),
                                serde_json::json!({
                                    "operation": "project.fs.read",
                                    "contribution": contribution_id
                                }),
                                false,
                            )?;
                            return Err(error);
                        }
                    };
                }
            }
        }
    }

    fn cancel_contribution_call(
        &self,
        context: &PluginRuntimeContext,
        session: &mut ContributionCallSession,
    ) {
        let key = registry_key(&context.project_root, session.identity().plugin_id.as_str());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.active.get_mut(&key) {
            let _ = session.cancel(&mut active.host);
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
        let active_keys = state
            .active
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for key in active_keys {
            remove_active_plugin(&mut state, &key);
        }
        state.pending.retain(|key, _| !key.starts_with(&prefix));
        state.workspace_objects.invalidate_project(&project_root);
        invalidated
    }

    pub(crate) fn quarantine_timed_out_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        store: &mut Store,
    ) -> Result<WorkspacePluginCrashOutcome> {
        let key = registry_key(&context.project_root, plugin_id);
        let identity = self
            .crash_identity(&key)
            .context("timed-out plugin has no active host")?;
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(active) = state.active.get_mut(&key) {
                active.host.quarantine_for_timeout();
            }
            remove_active_plugin(&mut state, &key);
        }
        PluginLifecycleMutationService::new(store)
            .record_crash(
                &context.project_root,
                &identity.plugin_id,
                &identity.package_digest,
                identity.host_instance_id.as_str(),
                "heartbeat_timeout",
            )
            .map_err(Into::into)
    }

    pub(crate) fn sweep_project_heartbeats(
        &self,
        context: &PluginRuntimeContext,
        store: &mut Store,
    ) -> WorkspacePluginHeartbeatReport {
        let prefix = format!("{}\0", normalize_project_root(&context.project_root));
        let mut failed = Vec::new();
        let checked = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let keys = state
                .active
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            for key in &keys {
                let unhealthy = if let Some(active) = state.active.get_mut(key) {
                    let identity = active.host.identity().clone();
                    !matches!(
                        active.host.handle_frame(HostFrame {
                            instance_id: identity.host_instance_id().clone(),
                            message: HostMessage::Heartbeat,
                        }),
                        Ok(Some(HostResponse::HeartbeatAck))
                    )
                } else {
                    false
                };
                if unhealthy && let Some(active) = state.active.get(key) {
                    failed.push((
                        key.clone(),
                        ActiveCrashIdentity {
                            plugin_id: active.host.identity().plugin_id().to_string(),
                            package_digest: active.package_digest.clone(),
                            host_instance_id: active.host_instance_id.clone(),
                        },
                    ));
                }
            }
            for (key, _) in &failed {
                remove_active_plugin(&mut state, key);
            }
            keys.len()
        };
        let mut report = WorkspacePluginHeartbeatReport {
            project_root: context.project_root.clone(),
            checked,
            crashed: 0,
            blocked: 0,
            failures: 0,
        };
        for (_, identity) in failed {
            match PluginLifecycleMutationService::new(store).record_crash(
                &context.project_root,
                &identity.plugin_id,
                &identity.package_digest,
                identity.host_instance_id.as_str(),
                "heartbeat_failed",
            ) {
                Ok(crash) if crash.outcome == PluginLifecycleMutationOutcome::Applied => {
                    if crash.blocked {
                        report.blocked += 1;
                    } else {
                        report.crashed += 1;
                    }
                }
                Ok(_) => report.failures += 1,
                Err(_) => {
                    report.failures += 1;
                    if let Ok(Some(lifecycle)) = PluginLifecycleQueryService::new(store)
                        .get_state(&context.project_root, &identity.plugin_id)
                    {
                        let _ = persist_recovery_block(
                            store,
                            context,
                            &lifecycle,
                            "heartbeat_persistence_failed",
                        );
                    }
                }
            }
        }
        report
    }

    fn crash_identity(&self, key: &str) -> Option<ActiveCrashIdentity> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active.get(key).map(|active| ActiveCrashIdentity {
            plugin_id: active.host.identity().plugin_id().to_string(),
            package_digest: active.package_digest.clone(),
            host_instance_id: active.host_instance_id.clone(),
        })
    }

    fn persist_crash_if_needed(
        &self,
        context: &PluginRuntimeContext,
        key: &str,
        identity: &ActiveCrashIdentity,
        reason_code: &str,
        store: &mut Store,
    ) -> Result<bool> {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let exact = state.active.get(key).is_some_and(|active| {
                active.host_instance_id == identity.host_instance_id
                    && active.package_digest == identity.package_digest
            });
            if exact {
                let quarantined = state
                    .active
                    .get(key)
                    .is_some_and(|active| active.host.state() == HostInstanceState::Quarantined);
                if !quarantined {
                    return Ok(false);
                }
                remove_active_plugin(&mut state, key);
            }
        }
        let crash = PluginLifecycleMutationService::new(store).record_crash(
            &context.project_root,
            &identity.plugin_id,
            &identity.package_digest,
            identity.host_instance_id.as_str(),
            reason_code,
        );
        match crash {
            Ok(crash) => Ok(crash.outcome == PluginLifecycleMutationOutcome::Applied),
            Err(error) => {
                if let Ok(Some(lifecycle)) = PluginLifecycleQueryService::new(store)
                    .get_state(&context.project_root, &identity.plugin_id)
                {
                    let _ = persist_recovery_block(
                        store,
                        context,
                        &lifecycle,
                        "crash_persistence_failed",
                    );
                }
                Err(error.into())
            }
        }
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
