use super::*;

impl PendingPluginPermissionRegistry {
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
}
