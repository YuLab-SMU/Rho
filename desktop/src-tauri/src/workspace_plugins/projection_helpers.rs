use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn plugin_view(
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

pub(super) fn missing_workspace_plugin_view(
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

pub(super) fn discover_exact_plugin(
    project_root: &Path,
    plugin_id: &str,
) -> Result<DiscoveredPlugin> {
    PluginId::new(plugin_id.to_string()).context("validating workspace plugin id")?;
    let report = discover_workspace_plugins(project_root)?
        .context("this project has no .rho/plugins directory")?;
    report
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id.as_str() == plugin_id)
        .with_context(|| format!("workspace plugin {plugin_id} was not discovered"))
}

pub(super) fn registry_key(project_root: &str, plugin_id: &str) -> String {
    format!("{}\0{plugin_id}", normalize_project_root(project_root))
}

pub(super) fn contribution_kind_name(kind: ContributionKind) -> &'static str {
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

pub(super) fn validate_command_result_artifacts(
    store: &Store<impl StoreConnection>,
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

pub(super) fn validate_viewer_artifacts(
    store: &Store<impl StoreConnection>,
    context: &PluginRuntimeContext,
    document: &ViewerDocumentV1,
) -> Result<()> {
    for (artifact_id, media_type) in document.artifact_image_refs() {
        validate_same_project_artifact(store, context, artifact_id, Some(media_type))?;
    }
    Ok(())
}

pub(crate) fn validate_surface_artifacts(
    store: &Store<impl StoreConnection>,
    context: &PluginRuntimeContext,
    document: &rho_extension_runtime::SurfaceDocumentV1,
) -> Result<()> {
    for (artifact_id, media_type) in document.artifact_image_refs() {
        validate_same_project_artifact(store, context, artifact_id, Some(media_type))?;
    }
    Ok(())
}

pub(crate) fn validate_surface_command_result(
    store: &Store<impl StoreConnection>,
    context: &PluginRuntimeContext,
    result: &PluginCommandResultV1,
) -> Result<()> {
    validate_command_result_artifacts(store, context, result)
}

pub(super) fn validate_same_project_artifact(
    store: &Store<impl StoreConnection>,
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

pub(super) fn agent_plugin_tool_name(contribution_id: &str, package_digest: &str) -> String {
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

pub(super) fn push_agent_plugin_context(
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

pub(super) fn validate_agent_tool_schema(schema: &serde_json::Value) -> Result<()> {
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

pub(super) fn read_plugin_skill(
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
