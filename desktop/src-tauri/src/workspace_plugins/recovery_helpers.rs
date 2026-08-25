use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReconciliationStatus {
    Reactivated,
    AlreadyActive,
    PermissionRequired,
    UpdatePending,
    Blocked,
    Skipped,
}

impl ReconciliationStatus {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Reactivated => "reactivated",
            Self::AlreadyActive => "already_active",
            Self::PermissionRequired => "permission_required",
            Self::UpdatePending => "update_pending",
            Self::Blocked => "blocked",
            Self::Skipped => "skipped",
        }
    }

    pub(super) fn reason_code(self) -> &'static str {
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

pub(super) fn increment_reconciliation_status(
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

pub(super) fn push_reconciliation_entry(
    report: &mut WorkspacePluginReconciliationReport,
    entry: WorkspacePluginReconciliationEntry,
) {
    if report.entries.len() < MAX_PLUGIN_RECONCILIATION_ENTRIES {
        report.entries.push(entry);
    } else {
        report.truncated = true;
    }
}

pub(super) fn push_boundary_teardown_entry(
    report: &mut WorkspacePluginBoundaryTeardownReport,
    entry: WorkspacePluginBoundaryTeardownEntry,
) {
    if report.entries.len() < MAX_PLUGIN_RECONCILIATION_ENTRIES {
        report.entries.push(entry);
    } else {
        report.truncated = true;
    }
}

pub(super) fn bounded_reconciliation_reason(message: &str) -> String {
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

pub(super) fn recover_project_plugin_files(
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

pub(super) fn reconcile_discovered_plugin(
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

pub(super) fn prepare_recovery_enable_transition(
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

pub(super) fn prepare_retry_transition(
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

pub(super) fn persist_missing_plugin_block(
    store: &mut Store,
    context: &PluginRuntimeContext,
    lifecycle: &WorkspacePluginState,
) -> Result<()> {
    persist_recovery_block(store, context, lifecycle, "package_missing")
}

pub(super) fn persist_recovery_block(
    store: &mut Store<impl StoreConnection>,
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
