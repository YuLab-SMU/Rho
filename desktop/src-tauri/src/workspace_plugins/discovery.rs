use super::*;

impl PendingPluginPermissionRegistry {
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
}
