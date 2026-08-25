use super::*;

impl PendingPluginPermissionRegistry {
    pub(crate) fn request_update(
        &self,
        context: &PluginRuntimeContext,
        input: &WorkspacePluginUpdateInput,
        store: &mut Store<impl StoreConnection>,
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
        store: &mut Store<impl StoreConnection>,
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
}
