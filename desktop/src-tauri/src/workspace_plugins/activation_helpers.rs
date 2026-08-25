use super::*;

pub(super) fn remove_active_plugin(state: &mut RegistryState, key: &str) -> Option<ActivePlugin> {
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

pub(super) fn revoke_exact_durable_grants(
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

pub(super) fn matching_project_grants(
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

pub(super) fn plan_plugin_permissions(
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

pub(super) fn plan_fresh_plugin_permissions(
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

pub(super) fn discovered_from_cache(
    directory_name: &str,
    cached: &CachedPluginPackage,
) -> DiscoveredPlugin {
    DiscoveredPlugin {
        directory: directory_name.to_string(),
        manifest: cached.snapshot.manifest.clone(),
        digest: cached.snapshot.digest.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn advance_enable_transition(
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

pub(super) fn fail_enable_transition(
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

pub(super) fn push_teardown_error(errors: &mut Vec<String>, code: &str) {
    if errors.len() < 16 && !errors.iter().any(|existing| existing == code) {
        errors.push(code.to_string());
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_disable_phase(
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

pub(super) fn try_activate_pending(
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

pub(super) fn activate_plugin_durable<'a>(
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

pub(super) fn activate_plugin_replacement_durable<'a>(
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

pub(super) fn grant_view(
    grant: PluginPermissionGrant,
    grants: &GrantStore,
) -> Result<PluginGrantView> {
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
