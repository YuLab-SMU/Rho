use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result, ensure};
use rho_core::ExecutionOrigin;
use rho_extension_runtime::{BoundedJson, ExtensionHost, InternalExtensionRuntimeMode};
use rho_server::coordinator::{AgentPluginContributionAdapter, WorkspaceSnapshotAdapter};
use rho_server::workspace_lane::{WorkspaceBrokerLane, WorkspaceBrokerState};
use rho_store::StoreExecutor;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

use crate::project::project_path;
use crate::{
    AppState, WorkspaceOperation, active_context, active_session, dispatch_workspace_request,
    dispatch_workspace_request_with_execution_id, display_error, extension_workspace_scope_id,
    workspace_plugins, workspace_snapshot_tool_capability_id,
};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub(crate) struct ExecuteSourceRange {
    pub(crate) start_line: u32,
    pub(crate) start_column: u32,
    pub(crate) end_line: u32,
    pub(crate) end_column: u32,
}

#[derive(Deserialize)]
pub(crate) struct ExecuteRequest {
    pub(crate) code: String,
    pub(crate) source_path: Option<String>,
    pub(crate) execution_mode: Option<String>,
    pub(crate) document_version: Option<i64>,
    pub(crate) source_range: Option<ExecuteSourceRange>,
}

#[derive(Deserialize)]
pub(crate) struct InspectObjectRequest {
    name: String,
}

#[derive(Deserialize)]
pub(crate) struct InspectDataObjectRequest {
    object_name: String,
}

#[derive(Deserialize)]
pub(crate) struct ViewerWorkspaceRequest {
    pub(crate) kernel_instance_id: Option<String>,
    pub(crate) state_revision: Option<u64>,
    pub(crate) project_revision: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct ReadDataViewRequest {
    object_name: String,
    view_token: String,
    view_kind: String,
    view_key: String,
    row_offset: Option<usize>,
    row_limit: Option<usize>,
    column_offset: Option<usize>,
    column_limit: Option<usize>,
    query: Option<String>,
    sort_column: Option<usize>,
    sort_direction: Option<String>,
    workspace: ViewerWorkspaceRequest,
}

#[tauri::command]
pub(crate) async fn execute_r(
    request: ExecuteRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if request.code.trim().is_empty() {
        return Err("R code is empty".to_string());
    }
    validate_execute_source_range(&request, &state)
        .await
        .map_err(display_error)?;
    dispatch_workspace_execution(request, &state)
        .await
        .map_err(display_error)
}

async fn dispatch_workspace_execution(request: ExecuteRequest, state: &AppState) -> Result<Value> {
    dispatch_workspace_execution_with_id(request, state, None).await
}

async fn dispatch_workspace_execution_with_id(
    request: ExecuteRequest,
    state: &AppState,
    execution_id: Option<&str>,
) -> Result<Value> {
    let session = active_session(state).await?;
    let context = active_context(state).await?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {
            "code": request.code,
            "source_path": request.source_path,
            "execution_mode": request.execution_mode,
            "document_version": request.document_version,
            "source_range": request.source_range
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request_with_execution_id(
        "workspace.execute",
        &payload,
        ExecutionOrigin::User,
        session.as_ref(),
        broker,
        executor,
        execution_id,
    )
    .await
}

fn runtime_workspace_execute_request(
    request: &rho_ui_contract::RuntimeExecuteRequestV1,
) -> Result<ExecuteRequest> {
    let Some(context) = request.source_context.as_ref() else {
        return Ok(ExecuteRequest {
            code: request.code.clone(),
            source_path: Some("<console>".to_string()),
            execution_mode: Some("console".to_string()),
            document_version: None,
            source_range: None,
        });
    };
    Ok(ExecuteRequest {
        code: request.code.clone(),
        source_path: Some(context.source_path.clone()),
        execution_mode: Some(context.execution_mode.clone()),
        document_version: context.document_version.map(i64::try_from).transpose()?,
        source_range: Some(ExecuteSourceRange {
            start_line: context.source_range.start_line,
            start_column: context.source_range.start_column,
            end_line: context.source_range.end_line,
            end_column: context.source_range.end_column,
        }),
    })
}

pub(crate) async fn validate_runtime_execute_source(
    request: &rho_ui_contract::RuntimeExecuteRequestV1,
    state: &AppState,
) -> Result<()> {
    let execute = runtime_workspace_execute_request(request)?;
    validate_execute_source_range(&execute, state).await
}

pub(crate) async fn execute_workspace_runtime(
    request: &rho_ui_contract::RuntimeExecuteRequestV1,
    state: &AppState,
    execution_id: &str,
) -> Result<Value> {
    let execute = runtime_workspace_execute_request(request)?;
    validate_execute_source_range(&execute, state).await?;
    dispatch_workspace_execution_with_id(execute, state, Some(execution_id)).await
}

async fn validate_execute_source_range(request: &ExecuteRequest, state: &AppState) -> Result<()> {
    validate_execute_source_range_shape(request)?;
    if request.source_range.is_none() {
        return Ok(());
    }
    let source_path = request.source_path.as_deref().unwrap();
    let root = state.project_root.read().await.clone();
    project_path(&root, source_path)?;
    Ok(())
}

pub(crate) fn validate_execute_source_range_shape(request: &ExecuteRequest) -> Result<()> {
    const MAX_DIAGNOSTIC_LINE: u32 = 10_000_000;
    const MAX_DIAGNOSTIC_COLUMN: u32 = 1_000_000;
    let Some(range) = request.source_range else {
        return Ok(());
    };
    ensure!(
        range.start_line > 0
            && range.start_column > 0
            && range.end_line > 0
            && range.end_column > 0
            && range.start_line <= MAX_DIAGNOSTIC_LINE
            && range.end_line <= MAX_DIAGNOSTIC_LINE
            && range.start_column <= MAX_DIAGNOSTIC_COLUMN
            && range.end_column <= MAX_DIAGNOSTIC_COLUMN,
        "Execution source range is out of bounds."
    );
    let ordered = range.end_line > range.start_line
        || (range.end_line == range.start_line && range.end_column > range.start_column);
    ensure!(ordered, "Execution source range is empty or inverted.");
    let source_path = request
        .source_path
        .as_deref()
        .context("Execution source range requires a project file path.")?;
    ensure!(
        !source_path.starts_with('<'),
        "Execution source range requires a real project file."
    );
    let code_lines = request.code.split('\n').collect::<Vec<_>>();
    let expected_end_line = range
        .start_line
        .checked_add(u32::try_from(code_lines.len().saturating_sub(1))?)
        .context("Execution source range line count overflowed.")?;
    let last_line_width = u32::try_from(
        code_lines
            .last()
            .map_or(0, |line| line.encode_utf16().count()),
    )?;
    let expected_end_column = if code_lines.len() == 1 {
        range
            .start_column
            .checked_add(last_line_width)
            .context("Execution source range column overflowed.")?
    } else {
        last_line_width
            .checked_add(1)
            .context("Execution source range column overflowed.")?
    };
    ensure!(
        range.end_line == expected_end_line && range.end_column == expected_end_column,
        "Execution source range does not match the submitted code."
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn snapshot_workspace(state: State<'_, AppState>) -> Result<Value, String> {
    snapshot_workspace_with_state(&state).await
}

pub(crate) fn expected_workspace(
    identity: &rho_protocol::WorkspaceIdentity,
) -> rho_protocol::ExpectedWorkspace {
    rho_protocol::ExpectedWorkspace {
        kernel_instance_id: Some(identity.kernel_instance_id.clone()),
        state_revision: Some(identity.state_revision),
        project_revision: Some(identity.project_revision),
    }
}

async fn call_extension_workspace_snapshot(
    extension_host: &ExtensionHost,
    context: Arc<WorkspaceBrokerLane>,
    expected_workspace: rho_protocol::ExpectedWorkspace,
    origin: ExecutionOrigin,
    execution_id: Option<String>,
) -> Result<Value, String> {
    let scope = extension_host
        .scopes()
        .workspace()
        .context("Workspace Snapshot extension scope is unavailable")
        .map_err(display_error)?;
    let operation = WorkspaceOperation::Snapshot {
        expected_workspace,
        origin,
        execution_id,
    };
    let request = BoundedJson::generic(serde_json::to_value(operation).map_err(display_error)?)
        .map_err(display_error)?;
    let result = scope
        .registry()
        .call_workspace_tool(&workspace_snapshot_tool_capability_id(), request)
        .await
        .map_err(display_error)?;
    extension_host
        .scopes()
        .validate_workspace_current(&result.scope)
        .map_err(display_error)?;
    let project = extension_host
        .scopes()
        .project()
        .context("Workspace Snapshot project extension scope is unavailable")
        .map_err(display_error)?;
    if result.scope.parent_id.as_ref() != Some(&project.identity().id) {
        return Err("Workspace Snapshot extension scope belongs to a stale project".to_string());
    }
    let identity = context.identity();
    let expected_scope_id =
        extension_workspace_scope_id(&project, identity.as_ref()).map_err(display_error)?;
    if result.scope.id != expected_scope_id {
        return Err(
            "Workspace Snapshot extension scope belongs to a stale kernel lineage".to_string(),
        );
    }
    let completed_workspace: rho_protocol::WorkspaceIdentity = serde_json::from_value(
        result
            .payload
            .value()
            .get("workspace")
            .cloned()
            .context("Workspace Snapshot result omitted workspace identity")
            .map_err(display_error)?,
    )
    .map_err(display_error)?;
    if completed_workspace.workspace_id != identity.workspace_id
        || completed_workspace.kernel_instance_id != identity.kernel_instance_id
        || completed_workspace.state_revision != identity.state_revision
        || completed_workspace.project_revision != identity.project_revision
    {
        return Err("Workspace Snapshot result is stale after Workspace state changed".to_string());
    }
    Ok(result.payload.into_value())
}

pub(crate) struct ExtensionWorkspaceSnapshotAdapter {
    extension_host: Arc<ExtensionHost>,
    context: Arc<WorkspaceBrokerLane>,
}

impl ExtensionWorkspaceSnapshotAdapter {
    pub(crate) fn new(
        extension_host: Arc<ExtensionHost>,
        context: Arc<WorkspaceBrokerLane>,
    ) -> Self {
        Self {
            extension_host,
            context,
        }
    }
}

impl WorkspaceSnapshotAdapter for ExtensionWorkspaceSnapshotAdapter {
    fn snapshot<'a>(
        &'a self,
        payload: Value,
        execution_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
        Box::pin(async move {
            let expected_workspace = serde_json::from_value(
                payload
                    .get("expected_workspace")
                    .cloned()
                    .context("Agent Workspace Snapshot omitted expected_workspace")?,
            )
            .context("decoding Agent Workspace Snapshot expected_workspace")?;
            call_extension_workspace_snapshot(
                self.extension_host.as_ref(),
                Arc::clone(&self.context),
                expected_workspace,
                ExecutionOrigin::Agent,
                Some(execution_id),
            )
            .await
            .map_err(anyhow::Error::msg)
        })
    }
}

pub(crate) struct WorkspacePluginAgentAdapter {
    registry: Arc<workspace_plugins::PendingPluginPermissionRegistry>,
    context: workspace_plugins::PluginRuntimeContext,
    store_executor: StoreExecutor,
}

impl WorkspacePluginAgentAdapter {
    pub(crate) fn new(
        registry: Arc<workspace_plugins::PendingPluginPermissionRegistry>,
        context: workspace_plugins::PluginRuntimeContext,
        store_executor: StoreExecutor,
    ) -> Self {
        Self {
            registry,
            context,
            store_executor,
        }
    }
}

impl AgentPluginContributionAdapter for WorkspacePluginAgentAdapter {
    fn invoke<'a>(
        &'a self,
        contribution_id: &'a str,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
        let registry = Arc::clone(&self.registry);
        let context = self.context.clone();
        let store_executor = self.store_executor.clone();
        let contribution_id = contribution_id.to_string();
        Box::pin(async move {
            workspace_plugins::run_store_service(&store_executor, move |store| {
                registry.invoke_file_contribution(
                    &context,
                    &contribution_id,
                    rho_extension_runtime::ContributionInvocationOrigin::AgentTool,
                    input,
                    store,
                )
            })
            .await
        })
    }
}

pub(crate) async fn snapshot_workspace_with_state(state: &AppState) -> Result<Value, String> {
    if state.extension_host.mode() == InternalExtensionRuntimeMode::Candidate {
        let context = active_context(state).await.map_err(display_error)?;
        let identity = context.identity();
        return call_extension_workspace_snapshot(
            state.extension_host.as_ref(),
            context,
            expected_workspace(identity.as_ref()),
            ExecutionOrigin::System,
            None,
        )
        .await;
    }
    let session = active_session(state).await.map_err(display_error)?;
    let context = active_context(state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {},
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.snapshot",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn inspect_object(
    request: InspectObjectRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": { "name": request.name },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.inspect_object",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)
}

pub(crate) fn viewer_expected_workspace(
    workspace: &ViewerWorkspaceRequest,
) -> rho_protocol::ExpectedWorkspace {
    rho_protocol::ExpectedWorkspace {
        kernel_instance_id: workspace.kernel_instance_id.clone(),
        state_revision: workspace.state_revision,
        project_revision: workspace.project_revision,
    }
}

#[tauri::command]
pub(crate) async fn inspect_data_object(
    request: InspectDataObjectRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": { "object_name": request.object_name },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.inspect_data_object",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn read_data_view(
    request: ReadDataViewRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {
            "object_name": request.object_name,
            "view_token": request.view_token,
            "view_kind": request.view_kind,
            "view_key": request.view_key,
            "row_offset": request.row_offset.unwrap_or(0),
            "row_limit": request.row_limit.unwrap_or(50),
            "column_offset": request.column_offset.unwrap_or(0),
            "column_limit": request.column_limit.unwrap_or(20),
            "query": request.query,
            "sort_column": request.sort_column,
            "sort_direction": request.sort_direction
        },
        "expected_workspace": viewer_expected_workspace(&request.workspace)
    });
    dispatch_workspace_request(
        "workspace.read_data_view",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)
}
