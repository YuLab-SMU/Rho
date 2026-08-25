use super::*;

impl PendingPluginPermissionRegistry {
    pub(crate) fn disable(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        store: &mut Store<impl StoreConnection>,
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
        store: &mut Store<impl StoreConnection>,
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
        store: &mut Store<impl StoreConnection>,
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
        store: &mut Store<impl StoreConnection>,
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
}
