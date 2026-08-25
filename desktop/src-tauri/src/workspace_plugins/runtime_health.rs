use super::*;

impl PendingPluginPermissionRegistry {
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

    pub(super) fn crash_identity(&self, key: &str) -> Option<ActiveCrashIdentity> {
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

    pub(super) fn persist_crash_if_needed(
        &self,
        context: &PluginRuntimeContext,
        key: &str,
        identity: &ActiveCrashIdentity,
        reason_code: &str,
        store: &mut Store<impl StoreConnection>,
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
