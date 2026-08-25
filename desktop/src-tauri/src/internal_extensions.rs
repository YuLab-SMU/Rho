mod facades;
mod plugins;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, ensure};
use rho_extension_runtime::{
    CapabilityDeclaration, DiagnosticSink, ExtensionDiagnostic, ExtensionHost,
    InternalExtensionRuntimeMode, LifecycleDeadlines, ScopeId, ScopeSnapshot,
    WorkspaceGrantIdentity,
};
use rho_kernel::ArkSession;
use rho_server::workspace_lane::WorkspaceBrokerLane;
use serde_json::json;

use crate::startup_runtime::write_startup_event;
use crate::{AppState, store_executor, text_sha256, workspace_plugins};

pub(crate) use facades::{RunHistoryBrokerFacade, WorkspaceSnapshotBrokerFacade};
#[cfg(test)]
pub(crate) use plugins::{
    ProjectFileViewerPlugin, RunHistoryPlugin, WorkspaceSnapshotPlugin, runs_broker_operation_id,
};
pub(crate) use plugins::{
    WorkspaceOperation, internal_plugins_for_scope, project_file_viewer_capability_id,
    run_history_source_capability_id, runs_broker_capability_id,
    workspace_probe_broker_capability_id, workspace_snapshot_tool_capability_id,
};

pub(crate) fn extension_project_scope_id(normalized_project_root: &str) -> Result<ScopeId> {
    ScopeId::new(format!("project.{}", text_sha256(normalized_project_root)))
        .map_err(|error| anyhow!("creating extension project scope identity failed: {error}"))
}

pub(crate) fn workspace_plugin_runtime_context(
    data_dir: PathBuf,
    project_root: String,
    identity: &rho_protocol::WorkspaceIdentity,
) -> Result<workspace_plugins::PluginRuntimeContext> {
    Ok(workspace_plugins::PluginRuntimeContext {
        app_data_dir: data_dir,
        project_revision: i64::try_from(identity.project_revision)
            .context("project revision exceeds plugin recovery range")?,
        project_scope_id: extension_project_scope_id(&project_root)?,
        project_root,
        workspace: Some(WorkspaceGrantIdentity {
            workspace_id: identity.workspace_id.clone(),
            kernel_instance_id: identity.kernel_instance_id.clone(),
            state_revision: identity.state_revision,
            project_revision: identity.project_revision,
        }),
    })
}

pub(crate) fn extension_workspace_scope_id(
    project: &ScopeSnapshot,
    workspace: &rho_protocol::WorkspaceIdentity,
) -> Result<ScopeId> {
    ScopeId::new(format!(
        "workspace.{}",
        text_sha256(&format!(
            "{}\0{}\0{}",
            project.identity().id,
            workspace.workspace_id,
            workspace.kernel_instance_id
        ))
    ))
    .map_err(|error| anyhow!("creating extension Workspace scope identity failed: {error}"))
}

pub(crate) async fn ensure_extension_project_scope(
    state: &AppState,
    normalized_project_root: &str,
) -> Result<Option<Arc<ScopeSnapshot>>> {
    if state.extension_host.mode() == InternalExtensionRuntimeMode::Legacy {
        return Ok(None);
    }
    let expected = state.extension_host.scopes().project();
    let scope_id = extension_project_scope_id(normalized_project_root)?;
    if let Some(current) = expected.as_ref()
        && current.identity().id == scope_id
    {
        return Ok(expected);
    }
    ensure!(
        state.extension_host.scopes().workspace().is_none(),
        "Cannot replace an extension project scope while its Workspace child is active"
    );
    let run_repository = store_executor(state).await?.run_repository();
    let candidate = state
        .extension_host
        .build_project_candidate(
            scope_id,
            internal_plugins_for_scope(&rho_extension_runtime::ScopePolicy::project_kind()),
            Arc::new(RunHistoryBrokerFacade::new(
                run_repository,
                normalized_project_root.to_string(),
            )),
        )
        .await
        .context("building extension project scope for Workspace startup")?;
    state
        .extension_host
        .publish_project_candidate(expected, candidate.clone())
        .await
        .context("publishing extension project scope for Workspace startup")?;
    Ok(Some(candidate))
}

pub(crate) async fn build_extension_workspace_candidate(
    state: &AppState,
    parent: &Arc<ScopeSnapshot>,
    session: Arc<ArkSession>,
    context: Arc<WorkspaceBrokerLane>,
) -> Result<Option<Arc<ScopeSnapshot>>> {
    if state.extension_host.mode() == InternalExtensionRuntimeMode::Legacy {
        return Ok(None);
    }
    let identity = context.identity();
    let candidate = state
        .extension_host
        .build_workspace_candidate(
            parent,
            extension_workspace_scope_id(parent, identity.as_ref())?,
            internal_plugins_for_scope(&rho_extension_runtime::ScopePolicy::workspace_kind()),
            Arc::new(WorkspaceSnapshotBrokerFacade { session, context }),
        )
        .await
        .context("building extension Workspace candidate")?;
    Ok(Some(candidate))
}

pub(crate) async fn publish_extension_workspace_scope(
    state: &AppState,
    parent: &Arc<ScopeSnapshot>,
    session: Arc<ArkSession>,
    context: Arc<WorkspaceBrokerLane>,
) -> Result<Option<Arc<ScopeSnapshot>>> {
    let expected = state.extension_host.scopes().workspace();
    let candidate = build_extension_workspace_candidate(state, parent, session, context).await?;
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    state
        .extension_host
        .publish_workspace_candidate(expected, candidate.clone())
        .await
        .context("publishing extension Workspace scope")?;
    Ok(Some(candidate))
}

pub(crate) async fn build_extension_host(
    mode_value: Option<&str>,
    diagnostics: Arc<dyn DiagnosticSink>,
) -> Result<Arc<ExtensionHost>> {
    let mode = InternalExtensionRuntimeMode::parse(mode_value, diagnostics.as_ref());
    let host_capabilities = vec![
        CapabilityDeclaration::new(runs_broker_capability_id(), 1),
        CapabilityDeclaration::new(workspace_probe_broker_capability_id(), 1),
    ];
    let host = if mode == InternalExtensionRuntimeMode::Legacy {
        ExtensionHost::new_with_host_capabilities(
            mode,
            host_capabilities,
            diagnostics,
            LifecycleDeadlines::default(),
        )
        .context("creating legacy internal extension host")?
    } else {
        ExtensionHost::new_with_application_plugins(
            mode,
            host_capabilities,
            internal_plugins_for_scope(&rho_extension_runtime::ScopePolicy::application_kind()),
            Arc::new(rho_extension_runtime::RejectingBrokerFacade),
            diagnostics,
            LifecycleDeadlines::default(),
        )
        .await
        .context("creating candidate internal extension host")?
    };
    Ok(Arc::new(host))
}

pub(crate) async fn desktop_extension_host() -> Result<Arc<ExtensionHost>> {
    let diagnostics: Arc<dyn DiagnosticSink> = Arc::new(|diagnostic: ExtensionDiagnostic| {
        write_startup_event(json!({
            "kind": "internal_extension_runtime",
            "diagnostic": diagnostic,
        }));
    });
    let mode = match std::env::var("RHO_INTERNAL_EXTENSION_RUNTIME") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => Some("invalid_non_unicode".to_string()),
    };
    build_extension_host(mode.as_deref(), diagnostics).await
}
