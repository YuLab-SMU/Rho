use super::*;

impl PendingPluginPermissionRegistry {
    pub(crate) fn request_enable(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        store: &mut Store<impl StoreConnection>,
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
        store: &mut Store<impl StoreConnection>,
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
}
