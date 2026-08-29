use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Context, Result, anyhow, ensure};
use rho_core::ExecutionOrigin;
use rho_extension_runtime::{InternalExtensionRuntimeMode, ScopeSnapshot};
use rho_server::coordinator::dispatch_workspace_request;
use rho_server::workspace_lane::WorkspaceBrokerState;
use rho_store::{ProjectTransitionSnapshot, normalize_project_root};
use serde_json::json;
use tauri::AppHandle;

use crate::application_state::{active_context, active_session, store_executor};
use crate::commands::agent_files::{
    AgentFileMutationRecoverySummary, recover_incomplete_agent_file_mutations,
};
use crate::commands::render::render_job_is_terminal;
use crate::internal_extensions::{
    RunHistoryBrokerFacade, build_extension_workspace_candidate, extension_project_scope_id,
    internal_plugins_for_scope,
};
use crate::project::{
    ProjectRestoreResponse, ProjectSessionSnapshot, ProjectSwitchBlocker, ProjectSwitchBlockerKind,
    ProjectWatcherControl, display_path, list_project_files, start_project_watcher,
};
use crate::startup_runtime::{bounded_diagnostic, write_startup_event, write_startup_log};
use crate::workspace_lifecycle::{
    reconcile_workspace_plugins_for_boundary, teardown_workspace_plugins_for_boundary,
};
use crate::{AppState, runtime_registry, ui_runtime};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum SwitchTestStep {
    BuildExtensionCandidate,
    ActivateExtensionCandidate,
    SyncWorkspace,
    SetActiveProjectRoot,
    SaveLastOpenedProject,
    RestoreWorkspace,
    RestoreActiveProjectRoot,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug)]
pub(crate) enum SwitchTestDirective {
    SucceedWithoutRunning,
    Fail(String),
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Default)]
pub(crate) struct SwitchTestControl {
    pub(crate) directives: Arc<StdMutex<HashMap<SwitchTestStep, SwitchTestDirective>>>,
}

impl SwitchTestControl {
    #[cfg(test)]
    pub(crate) fn succeed_without_running(&self, step: SwitchTestStep) {
        self.directives
            .lock()
            .unwrap()
            .insert(step, SwitchTestDirective::SucceedWithoutRunning);
    }

    #[cfg(test)]
    pub(crate) fn fail(&self, step: SwitchTestStep, message: impl Into<String>) {
        self.directives
            .lock()
            .unwrap()
            .insert(step, SwitchTestDirective::Fail(message.into()));
    }

    pub(crate) fn take(&self, step: SwitchTestStep) -> Option<SwitchTestDirective> {
        self.directives.lock().unwrap().remove(&step)
    }
}

pub(crate) struct PreparedExtensionProjectCandidate {
    pub(crate) expected_project: Option<Arc<ScopeSnapshot>>,
    pub(crate) project_candidate: Option<Arc<ScopeSnapshot>>,
    pub(crate) expected_workspace: Option<Arc<ScopeSnapshot>>,
    pub(crate) workspace_candidate: Option<Arc<ScopeSnapshot>>,
}

pub(crate) async fn prepare_extension_project_candidate(
    state: &AppState,
    normalized_project_root: &str,
) -> Result<PreparedExtensionProjectCandidate> {
    if state.extension_host.mode() == InternalExtensionRuntimeMode::Legacy {
        return Ok(PreparedExtensionProjectCandidate {
            expected_project: None,
            project_candidate: None,
            expected_workspace: None,
            workspace_candidate: None,
        });
    }
    let _ = maybe_handle_switch_test_directive(state, SwitchTestStep::BuildExtensionCandidate)?;
    let expected_project = state.extension_host.scopes().project();
    maybe_handle_switch_test_directive(state, SwitchTestStep::ActivateExtensionCandidate)
        .context("activating required extension project candidate")?;
    let run_repository = store_executor(state).await?.run_repository();
    let project_candidate = state
        .extension_host
        .build_project_candidate(
            extension_project_scope_id(normalized_project_root)?,
            internal_plugins_for_scope(&rho_extension_runtime::ScopePolicy::project_kind()),
            Arc::new(RunHistoryBrokerFacade::new(
                run_repository,
                normalized_project_root.to_string(),
            )),
        )
        .await
        .context("building required extension project candidate")?;
    Ok(PreparedExtensionProjectCandidate {
        expected_project,
        project_candidate: Some(project_candidate),
        expected_workspace: state.extension_host.scopes().workspace(),
        workspace_candidate: None,
    })
}

pub(crate) async fn rollback_extension_project_candidates(
    state: &AppState,
    project_candidate: Option<&Arc<ScopeSnapshot>>,
    workspace_candidate: Option<&Arc<ScopeSnapshot>>,
    reason_code: &str,
) {
    for candidate in [workspace_candidate, project_candidate]
        .into_iter()
        .flatten()
    {
        let report = state.extension_host.rollback_candidate(candidate).await;
        write_startup_event(json!({
            "kind": "internal_extension_candidate_rollback",
            "reason_code": reason_code,
            "scope_id": candidate.identity().id,
            "generation": candidate.identity().generation,
            "outcome": report.outcome,
        }));
    }
}

pub(crate) async fn switch_project(
    root: PathBuf,
    session_snapshot: Option<ProjectSessionSnapshot>,
    app: AppHandle,
    state: &AppState,
) -> Result<ProjectRestoreResponse> {
    let result = switch_project_with_watcher_factory(root, session_snapshot, state, |watch_root| {
        start_project_watcher(app.clone(), watch_root.to_path_buf())
    })
    .await;
    if result
        .as_ref()
        .is_ok_and(|response| response.status == "ready")
    {
        ui_runtime::emit_snapshot_invalidated(&app, "project_switched");
    }
    result
}

pub(crate) async fn switch_project_with_watcher_factory<F>(
    root: PathBuf,
    session_snapshot: Option<ProjectSessionSnapshot>,
    state: &AppState,
    start_watcher: F,
) -> Result<ProjectRestoreResponse>
where
    F: FnOnce(&Path) -> Result<ProjectWatcherControl>,
{
    let _project_transition = state.project_transition_gate.lock().await;
    ensure!(
        !state.shutdown_started.load(Ordering::SeqCst),
        "Rho is closing; project switching is unavailable"
    );
    let target_session =
        session_snapshot.unwrap_or_else(|| state.project_store.load_session_or_default(&root));
    if let Some(blocker) = project_switch_blocker(state).await? {
        write_project_switch_event(
            "project_switch_blocked",
            &root,
            None,
            Some("project_switch_blocked"),
            Some(blocker.message.as_str()),
        );
        return Ok(ProjectRestoreResponse::blocked(target_session, blocker));
    }

    let project = list_project_files(&root)?;
    let normalized_root = normalize_project_root(root.to_string_lossy().as_ref());
    let previous_ui_root = state.project_root.read().await.clone();
    let previous_normalized_root =
        normalize_project_root(previous_ui_root.to_string_lossy().as_ref());
    let previous_session = state
        .project_store
        .load_session_or_default(&previous_ui_root);
    let previous_store_root = store_executor(state)
        .await?
        .project_transition_repository()
        .active_project_root()
        .await?;
    let next_target_admission =
        crate::commands::toolchain::prepare_workspace_target_admission_for(state, &root).await?;
    let mut prepared_extension =
        prepare_extension_project_candidate(state, &normalized_root).await?;

    if let Err(error) =
        sync_workspace_project_root(state, &root, SwitchTestStep::SyncWorkspace).await
    {
        rollback_extension_project_candidates(
            state,
            prepared_extension.project_candidate.as_ref(),
            prepared_extension.workspace_candidate.as_ref(),
            "project_switch_workspace_failed",
        )
        .await;
        return Err(error);
    }

    if let Some(project_candidate) = prepared_extension.project_candidate.as_ref() {
        let session = state.session.read().await.clone();
        let context = state.context.lock().await.clone();
        let workspace_candidate = match (session, context) {
            (Some(session), Some(context)) => {
                build_extension_workspace_candidate(state, project_candidate, session, context)
                    .await
            }
            (None, None) => Ok(None),
            _ => Err(anyhow!(
                "Workspace session/context ownership is inconsistent during project switch"
            )),
        };
        match workspace_candidate {
            Ok(candidate) => prepared_extension.workspace_candidate = candidate,
            Err(error) => {
                return recover_failed_project_switch(
                    state,
                    &previous_ui_root,
                    previous_store_root.as_deref(),
                    previous_session,
                    prepared_extension.project_candidate.as_ref(),
                    prepared_extension.workspace_candidate.as_ref(),
                    "project_switch_extension_workspace_failed",
                    format!(
                        "Target extension Workspace activation failed after workspace sync: {error:#}"
                    ),
                )
                .await;
            }
        }
    }

    let next_watcher = start_watcher(&root)
        .map_err(|error| anyhow!("starting target project watcher failed: {error:#}"));

    let next_watcher = match next_watcher {
        Ok(next_watcher) => next_watcher,
        Err(error) => {
            return recover_failed_project_switch(
                state,
                &previous_ui_root,
                previous_store_root.as_deref(),
                previous_session,
                prepared_extension.project_candidate.as_ref(),
                prepared_extension.workspace_candidate.as_ref(),
                "project_switch_watcher_failed",
                format!("Target project watcher failed after workspace sync: {error:#}"),
            )
            .await;
        }
    };

    if previous_normalized_root != normalized_root {
        teardown_workspace_plugins_for_boundary(
            state,
            &previous_normalized_root,
            "project_teardown",
            "project_switched",
        )
        .await;
    }

    if let Err(error) = set_store_active_project_root(
        state,
        Some(&normalized_root),
        SwitchTestStep::SetActiveProjectRoot,
    )
    .await
    {
        return recover_failed_project_switch(
            state,
            &previous_ui_root,
            previous_store_root.as_deref(),
            previous_session,
            prepared_extension.project_candidate.as_ref(),
            prepared_extension.workspace_candidate.as_ref(),
            "project_switch_store_root_failed",
            format!("Project identity could not be committed: {error:#}"),
        )
        .await;
    }

    if let Err(error) =
        save_last_opened_project(state, &root, SwitchTestStep::SaveLastOpenedProject)
    {
        return recover_failed_project_switch(
            state,
            &previous_ui_root,
            previous_store_root.as_deref(),
            previous_session,
            prepared_extension.project_candidate.as_ref(),
            prepared_extension.workspace_candidate.as_ref(),
            "project_switch_last_opened_failed",
            format!("Last opened project could not be committed: {error:#}"),
        )
        .await;
    }

    *state.project_root.write().await = root.clone();
    *state.target_admission.write().await = next_target_admission;
    *state.resource_governance.write().await = None;
    let mut watcher = state.project_watcher.lock().await;
    let previous_watcher = watcher.replace(next_watcher);
    drop(watcher);
    if let Some(previous) = previous_watcher {
        previous.stop();
    }

    match (
        prepared_extension.project_candidate,
        prepared_extension.workspace_candidate,
    ) {
        (Some(project_candidate), Some(workspace_candidate)) => {
            if let Err(error) = state
                .extension_host
                .publish_project_tree_candidates(
                    prepared_extension.expected_project,
                    project_candidate,
                    prepared_extension.expected_workspace,
                    workspace_candidate,
                )
                .await
            {
                write_startup_event(json!({
                    "kind": "internal_extension_tree_publish_rejected",
                    "reason_code": error.reason,
                    "rejected_project_scope_id": error.rejected_project.id,
                    "rejected_workspace_scope_id": error.rejected_workspace.id,
                    "actual_project_scope_id": error.actual_project.as_ref().map(|identity| &identity.id),
                    "actual_workspace_scope_id": error.actual_workspace.as_ref().map(|identity| &identity.id),
                }));
            }
        }
        (Some(project_candidate), None) => {
            if let Err(error) = state
                .extension_host
                .publish_project_candidate(prepared_extension.expected_project, project_candidate)
                .await
            {
                write_startup_event(json!({
                    "kind": "internal_extension_candidate_publish_rejected",
                    "reason_code": error.reason,
                    "rejected_scope_id": error.rejected.id,
                    "rejected_generation": error.rejected.generation,
                    "actual_scope_id": error.actual.as_ref().map(|identity| &identity.id),
                    "actual_generation": error.actual.as_ref().map(|identity| identity.generation),
                }));
            }
        }
        (None, None) => {}
        (None, Some(workspace_candidate)) => {
            let report = state
                .extension_host
                .rollback_candidate(&workspace_candidate)
                .await;
            write_startup_event(json!({
                "kind": "internal_extension_orphan_workspace_rollback",
                "outcome": report.outcome,
            }));
        }
    }

    reconcile_workspace_plugins_for_boundary(state, &normalized_root, "project_switch").await;
    if previous_normalized_root != normalized_root
        && let Err(error) = runtime_registry::teardown_auxiliary_runtimes(None, state).await
    {
        write_startup_log(&format!(
            "Auxiliary Runtime project-switch teardown failed: {error:#}"
        ));
    }

    write_project_switch_event(
        "project_switch_succeeded",
        &root,
        None,
        None,
        Some("project switch committed"),
    );

    Ok(ProjectRestoreResponse::ready(project, target_session))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn recover_failed_project_switch(
    state: &AppState,
    previous_ui_root: &Path,
    previous_store_root: Option<&str>,
    previous_session: ProjectSessionSnapshot,
    extension_project_candidate: Option<&Arc<ScopeSnapshot>>,
    extension_workspace_candidate: Option<&Arc<ScopeSnapshot>>,
    reason_code: &str,
    message: String,
) -> Result<ProjectRestoreResponse> {
    rollback_extension_project_candidates(
        state,
        extension_project_candidate,
        extension_workspace_candidate,
        reason_code,
    )
    .await;
    let restore_result = async {
        sync_workspace_project_root(state, previous_ui_root, SwitchTestStep::RestoreWorkspace)
            .await?;
        set_store_active_project_root(
            state,
            previous_store_root,
            SwitchTestStep::RestoreActiveProjectRoot,
        )
        .await?;
        Result::<()>::Ok(())
    }
    .await;

    match restore_result {
        Ok(()) => {
            let restored_root = previous_ui_root.to_string_lossy().replace('\\', "/");
            let normalized_restored_root =
                normalize_project_root(previous_ui_root.to_string_lossy().as_ref());
            reconcile_workspace_plugins_for_boundary(
                state,
                &normalized_restored_root,
                "project_switch_restored",
            )
            .await;
            write_project_switch_event(
                "project_switch_failed_restored",
                previous_ui_root,
                Some(previous_ui_root),
                Some(reason_code),
                Some(message.as_str()),
            );
            Ok(ProjectRestoreResponse::failed_restored(
                previous_session,
                restored_root,
                reason_code,
                message,
            ))
        }
        Err(restore_error) => {
            let fatal_message =
                format!("{message}; restore failed and restart is required: {restore_error:#}");
            write_project_switch_event(
                "project_switch_fatal",
                previous_ui_root,
                None,
                Some("project_switch_restore_failed"),
                Some(fatal_message.as_str()),
            );
            Ok(ProjectRestoreResponse::fatal(
                previous_session,
                "project_switch_restore_failed",
                fatal_message,
            ))
        }
    }
}

pub(crate) async fn project_switch_blocker(
    state: &AppState,
) -> Result<Option<ProjectSwitchBlocker>> {
    let fallback_root = {
        let root = state.project_root.read().await.clone();
        normalize_project_root(root.to_string_lossy().as_ref())
    };
    let approval_count = state.approvals.count().await;
    let environment_approval_count = state.environment_approvals.count().await;
    let durable = store_executor(state)
        .await?
        .project_transition_repository()
        .snapshot(fallback_root)
        .await?;
    let current_root = durable.active_project_root.clone();

    let runtime_execution_count = state.runtime_registry.active_execution_count();
    if runtime_execution_count > 0 {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::ActiveRun,
            message: "Finish or interrupt active Console execution before switching projects."
                .to_string(),
            pending_count: runtime_execution_count,
            run_id: None,
            turn_id: None,
            request_id: None,
            operation_status: Some("runtime_execution".to_string()),
        }));
    }

    if let Some(run_id) = durable.active_run_id.as_ref() {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::ActiveRun,
            message: "Finish or interrupt the active scientific run before switching projects."
                .to_string(),
            pending_count: 1,
            run_id: Some(run_id.clone()),
            turn_id: None,
            request_id: None,
            operation_status: Some("running".to_string()),
        }));
    }

    let render_jobs = state.render_jobs.lock().await;
    if let Some(job) = render_jobs
        .values()
        .find(|job| job.project_root == current_root && !render_job_is_terminal(&job.status))
    {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::ActiveRun,
            message: "Cancel the submitted document render before switching projects.".to_string(),
            pending_count: 1,
            run_id: Some(job.job_id.clone()),
            turn_id: None,
            request_id: None,
            operation_status: Some(job.status.clone()),
        }));
    }
    drop(render_jobs);

    let agent_tasks = state.agent_tasks.lock().await;
    if let Some(turn_id) = agent_tasks.keys().next().cloned() {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::AgentTurn,
            message: "Stop the active Agent turn before switching projects.".to_string(),
            pending_count: agent_tasks.len(),
            run_id: None,
            turn_id: Some(turn_id),
            request_id: None,
            operation_status: Some("running".to_string()),
        }));
    }
    drop(agent_tasks);

    if let Some((pending_count, claim)) = state.agent_file_mutations.blocker(&current_root) {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::AgentFileMutation,
            message: "Wait for the Agent file change to finish before switching projects."
                .to_string(),
            pending_count,
            run_id: None,
            turn_id: Some(claim.turn_id),
            request_id: None,
            operation_status: Some(format!("{}:{}", claim.status, claim.path)),
        }));
    }

    let waiting_approvals = &durable.waiting_approvals;
    if approval_count > 0 || !waiting_approvals.is_empty() {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::Approval,
            message: "Resolve the waiting approval before switching projects.".to_string(),
            pending_count: approval_count.max(waiting_approvals.len()),
            run_id: None,
            turn_id: waiting_approvals
                .first()
                .map(|approval| approval.turn_id.clone()),
            request_id: waiting_approvals
                .first()
                .map(|approval| approval.request_id.clone()),
            operation_status: Some("waiting".to_string()),
        }));
    }

    if let Some(blocker) =
        environment_operation_switch_blocker(&durable, environment_approval_count)
    {
        return Ok(Some(blocker));
    }

    Ok(None)
}

pub(crate) fn environment_operation_switch_blocker(
    durable: &ProjectTransitionSnapshot,
    environment_approval_count: usize,
) -> Option<ProjectSwitchBlocker> {
    if let Some(status) = durable.environment_status.as_deref() {
        let message = match status {
            "running" => {
                "Wait for the active direct environment operation to finish before switching projects."
            }
            _ => "Resolve the direct environment operation decision before switching projects.",
        };
        return Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::EnvironmentOperation,
            message: message.to_string(),
            pending_count: environment_approval_count.max(durable.environment_requests.len()),
            run_id: durable
                .environment_requests
                .first()
                .and_then(|request| request.run_id.clone()),
            turn_id: durable
                .environment_requests
                .first()
                .and_then(|request| request.turn_id.clone()),
            request_id: durable
                .environment_requests
                .first()
                .map(|request| request.request_id.clone()),
            operation_status: Some(status.to_string()),
        });
    }
    if environment_approval_count > 0 {
        return Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::EnvironmentOperation,
            message: "Resolve the direct environment operation decision before switching projects."
                .to_string(),
            pending_count: environment_approval_count,
            run_id: None,
            turn_id: None,
            request_id: None,
            operation_status: Some("requested".to_string()),
        });
    }
    None
}

pub(crate) fn maybe_handle_switch_test_directive(
    state: &AppState,
    step: SwitchTestStep,
) -> Result<bool> {
    match state.switch_test_control.take(step) {
        Some(SwitchTestDirective::SucceedWithoutRunning) => Ok(true),
        Some(SwitchTestDirective::Fail(message)) => Err(anyhow!(message)),
        None => Ok(false),
    }
}

pub(crate) async fn set_store_active_project_root(
    state: &AppState,
    project_root: Option<&str>,
    step: SwitchTestStep,
) -> Result<()> {
    if maybe_handle_switch_test_directive(state, step)? {
        return Ok(());
    }
    store_executor(state)
        .await?
        .project_transition_repository()
        .set_active_project_root(project_root.map(str::to_string))
        .await?;
    Ok(())
}

pub(crate) fn save_last_opened_project(
    state: &AppState,
    root: &Path,
    step: SwitchTestStep,
) -> Result<()> {
    if maybe_handle_switch_test_directive(state, step)? {
        return Ok(());
    }
    state.project_store.save_last_opened_project(root)
}

pub(crate) async fn sync_workspace_project_root(
    state: &AppState,
    root: &Path,
    step: SwitchTestStep,
) -> Result<()> {
    if maybe_handle_switch_test_directive(state, step)? {
        return Ok(());
    }
    let session = active_session(state).await?;
    let context = active_context(state).await?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {"code": workspace_project_root_code(root)?},
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.set_project_root",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await?;
    let normalized_root = normalize_project_root(root.to_string_lossy().as_ref());
    let file_recovery =
        recover_incomplete_agent_file_mutations(executor, root, &normalized_root).await?;
    if file_recovery != AgentFileMutationRecoverySummary::default() {
        write_startup_event(json!({
            "kind": "agent_file_mutation_recovery",
            "project_root": normalized_root,
            "recovered": file_recovery.recovered,
            "not_applied": file_recovery.not_applied,
            "uncertain": file_recovery.uncertain
        }));
    }
    Ok(())
}

pub(crate) fn workspace_project_root_code(root: &Path) -> Result<String> {
    Ok(format!(
        "setwd({})",
        serde_json::to_string(&display_path(root))?
    ))
}

pub(crate) fn write_project_switch_event(
    kind: &str,
    target_root: &Path,
    restored_root: Option<&Path>,
    reason_code: Option<&str>,
    message: Option<&str>,
) {
    write_startup_event(json!({
        "kind": kind,
        "target_root": bounded_diagnostic(&target_root.to_string_lossy()),
        "restored_root": restored_root.map(|value| bounded_diagnostic(&value.to_string_lossy())),
        "reason_code": reason_code.map(bounded_diagnostic),
        "message": message.map(bounded_diagnostic),
    }));
}
