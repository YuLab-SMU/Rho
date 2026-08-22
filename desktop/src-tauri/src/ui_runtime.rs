use std::collections::BTreeSet;
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::{Result, anyhow};
use rho_ui_contract::{
    ActiveOperationStateV1, ActiveOperationV1, CommandAvailabilityV1, CommandDefinitionV1,
    CommandId, CommandPlacementTagV1, CommandRegistrationV1, CommandRegistryV1, ContractError,
    HealthStateV1, MAX_COMMAND_REGISTRY_BYTES, MAX_REGISTERED_COMMANDS, OperationId,
    PREDICATE_PLUGIN_READY, PackageDigest, PluginId, PredicateId, ProjectId, RSR_CONTRACT_MAJOR,
    SurfaceOriginV1, UI_KERNEL_SNAPSHOT_CONTRACT, UiContextV1, UiHealthDetailV1,
    UiHealthSnapshotV1, UiKernelSnapshotV1, UiProjectV1, UiSelectionV1, Validate,
    application_command_registry_v1, encoded_json_len, next_revision,
};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::workspace_plugins::{PluginContributionList, PluginContributionView};
use crate::{
    AgentRuntimeStatus, AppState, StartupView, bounded_diagnostic, current_startup_view,
    display_error, normalize_project_root, read_store, text_sha256,
    workspace_plugin_runtime_context,
};

pub(crate) const UI_SNAPSHOT_INVALIDATED_EVENT: &str = "rho://ui-snapshot-invalidated";

#[derive(Debug, Clone)]
struct SelectionRecord {
    project_id: ProjectId,
    selection: Option<UiSelectionV1>,
}

#[derive(Default)]
struct UiRuntimeInner {
    next_snapshot_revision: u64,
    cached: Option<Arc<UiKernelSnapshotV1>>,
    selection: Option<SelectionRecord>,
}

#[derive(Default)]
pub(crate) struct UiRuntimeState {
    inner: StdMutex<UiRuntimeInner>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SetUiSelectionRequest {
    project_id: ProjectId,
    expected_project_revision: u64,
    expected_snapshot_revision: u64,
    selection: Option<UiSelectionV1>,
}

fn same_projection(left: &UiKernelSnapshotV1, right: &UiKernelSnapshotV1) -> bool {
    left.contract == right.contract
        && left.contract_major == right.contract_major
        && left.project == right.project
        && left.context == right.context
        && left.health == right.health
        && left.command_registry == right.command_registry
}

impl UiRuntimeState {
    fn inner(&self) -> std::sync::MutexGuard<'_, UiRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn selection_for(&self, project_id: &ProjectId) -> Option<UiSelectionV1> {
        self.inner()
            .selection
            .as_ref()
            .filter(|record| &record.project_id == project_id)
            .and_then(|record| record.selection.clone())
    }

    fn project(
        &self,
        mut candidate: UiKernelSnapshotV1,
    ) -> Result<Arc<UiKernelSnapshotV1>, ContractError> {
        let mut inner = self.inner();
        if let Some(cached) = &inner.cached
            && same_projection(cached, &candidate)
        {
            return Ok(cached.clone());
        }
        if inner
            .cached
            .as_ref()
            .is_some_and(|cached| cached.project.project_id != candidate.project.project_id)
            && inner
                .selection
                .as_ref()
                .is_some_and(|record| record.project_id != candidate.project.project_id)
        {
            inner.selection = None;
        }
        inner.next_snapshot_revision = next_revision(
            "ui_kernel_snapshot.snapshot_revision",
            inner.next_snapshot_revision,
        )?;
        candidate.snapshot_revision = inner.next_snapshot_revision;
        candidate.validate()?;
        let snapshot = Arc::new(candidate);
        inner.cached = Some(snapshot.clone());
        Ok(snapshot)
    }

    fn set_selection(
        &self,
        request: SetUiSelectionRequest,
        current: &UiKernelSnapshotV1,
    ) -> Result<Option<SelectionRecord>, ContractError> {
        if request.project_id != current.project.project_id {
            return Err(ContractError::InvalidValue {
                path: "ui_selection.project_id".to_string(),
                reason: "selection belongs to a different project".to_string(),
            });
        }
        if request.expected_project_revision != current.context.project_revision {
            return Err(ContractError::StaleRevision {
                path: "ui_selection.project_revision".to_string(),
                expected: request.expected_project_revision,
                actual: current.context.project_revision,
            });
        }
        if request.expected_snapshot_revision != current.snapshot_revision {
            return Err(ContractError::StaleRevision {
                path: "ui_selection.snapshot_revision".to_string(),
                expected: request.expected_snapshot_revision,
                actual: current.snapshot_revision,
            });
        }
        if let Some(selection) = &request.selection {
            selection.validate()?;
        }
        let mut inner = self.inner();
        let previous = inner.selection.clone();
        inner.selection = Some(SelectionRecord {
            project_id: request.project_id,
            selection: request.selection,
        });
        Ok(previous)
    }

    fn restore_selection(&self, selection: Option<SelectionRecord>) {
        self.inner().selection = selection;
    }
}

fn safe_bounded_text(value: &str, maximum_bytes: usize, fallback: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        let character = if character.is_control()
            || matches!(
                character,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            ) {
            '\u{fffd}'
        } else {
            character
        };
        if output.len() + character.len_utf8() > maximum_bytes {
            break;
        }
        output.push(character);
    }
    if output.is_empty() {
        fallback.to_string()
    } else {
        output
    }
}

fn project_view(root: &std::path::Path) -> Result<UiProjectV1> {
    let normalized = normalize_project_root(root.to_string_lossy().as_ref());
    let display_path = safe_bounded_text(&normalized, 4_096, "Project");
    let display_label = root
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| safe_bounded_text(value, 512, "Project"))
        .unwrap_or_else(|| "Project".to_string());
    Ok(UiProjectV1 {
        project_id: ProjectId::new(format!("project.{}", text_sha256(&normalized)))?,
        display_label,
        display_path,
    })
}

fn workspace_health(
    startup: &StartupView,
    has_session: bool,
    has_context: bool,
) -> UiHealthDetailV1 {
    if startup.busy {
        return UiHealthDetailV1 {
            state: HealthStateV1::Restarting,
            label: "Preparing Workspace R".to_string(),
            detail: None,
        };
    }
    match (has_session, has_context) {
        (true, true) => UiHealthDetailV1 {
            state: HealthStateV1::Ready,
            label: "Workspace R ready".to_string(),
            detail: None,
        },
        (true, false) | (false, true) => UiHealthDetailV1 {
            state: HealthStateV1::Degraded,
            label: "Workspace R state is inconsistent".to_string(),
            detail: Some(
                "Restart Workspace R to restore one authoritative session and broker context."
                    .to_string(),
            ),
        },
        (false, false) => UiHealthDetailV1 {
            state: HealthStateV1::Unavailable,
            label: startup
                .issue
                .as_ref()
                .map(|issue| safe_bounded_text(&issue.title, 512, "Workspace R unavailable"))
                .unwrap_or_else(|| "Workspace R is not running".to_string()),
            detail: startup.issue.as_ref().map(|issue| {
                safe_bounded_text(&issue.message, 2_048, "Review startup diagnostics.")
            }),
        },
    }
}

fn agent_dependency_detail(runtime: &AgentRuntimeStatus) -> Option<String> {
    let mut details = runtime
        .dependencies
        .iter()
        .filter(|dependency| dependency.status != "ready")
        .map(|dependency| {
            let installed = dependency.installed_version.as_deref().unwrap_or("missing");
            format!(
                "{}: {} (installed {}, required {}).",
                dependency.package, dependency.status, installed, dependency.required_version
            )
        })
        .collect::<Vec<_>>();
    if let Some(error) = &runtime.error {
        details.push(bounded_diagnostic(error));
    }
    (!details.is_empty()).then(|| safe_bounded_text(&details.join(" "), 2_048, "Agent unavailable"))
}

fn agent_health(startup: &StartupView) -> UiHealthDetailV1 {
    let Some(runtime) = startup
        .runtime
        .as_ref()
        .map(|runtime| &runtime.agent_runtime)
    else {
        return UiHealthDetailV1 {
            state: HealthStateV1::Unavailable,
            label: "Agent runtime is not configured".to_string(),
            detail: Some(
                "Editor, Console, and Workspace capabilities remain independent.".to_string(),
            ),
        };
    };
    if runtime.available {
        return UiHealthDetailV1 {
            state: HealthStateV1::Ready,
            label: "Agent runtime ready".to_string(),
            detail: runtime
                .aisdk_version
                .as_ref()
                .map(|version| format!("aisdk {version}")),
        };
    }
    if runtime.status == "checking" {
        return UiHealthDetailV1 {
            state: HealthStateV1::Restarting,
            label: "Checking Agent dependencies".to_string(),
            detail: agent_dependency_detail(runtime),
        };
    }
    UiHealthDetailV1 {
        state: HealthStateV1::Degraded,
        label: "Agent runtime needs attention".to_string(),
        detail: agent_dependency_detail(runtime),
    }
}

fn operation_id(prefix: &str, raw: &str) -> OperationId {
    OperationId::new(format!("{prefix}:{raw}"))
        .unwrap_or_else(|_| OperationId::new(format!("{prefix}:{}", text_sha256(raw))).unwrap())
}

fn operation_label(prefix: &str, raw: &str) -> String {
    safe_bounded_text(&format!("{prefix} {raw}"), 512, prefix)
}

fn active_state(status: &str) -> ActiveOperationStateV1 {
    match status {
        "queued" | "submitted" => ActiveOperationStateV1::Queued,
        "waiting" => ActiveOperationStateV1::Waiting,
        "cancel_requested" | "cancelling" => ActiveOperationStateV1::Cancelling,
        _ => ActiveOperationStateV1::Running,
    }
}

async fn active_operations(state: &AppState, project_root: &str) -> Vec<ActiveOperationV1> {
    let mut operations = Vec::new();
    if let Ok(store) = read_store(state)
        && let Ok(runs) = store.list_runs(project_root, Some(64))
    {
        for run in runs
            .into_iter()
            .filter(|run| matches!(run.status.as_str(), "queued" | "running" | "waiting"))
        {
            operations.push(ActiveOperationV1 {
                operation_id: operation_id("run", &run.run_id),
                label: operation_label("Scientific run", &run.run_id),
                state: active_state(&run.status),
            });
        }
    }
    {
        let jobs = state.render_jobs.lock().await;
        for job in jobs.values().filter(|job| {
            job.project_root == project_root && !crate::render_job_is_terminal(&job.status)
        }) {
            operations.push(ActiveOperationV1 {
                operation_id: operation_id("render", &job.job_id),
                label: operation_label("Render", &job.path),
                state: active_state(&job.status),
            });
        }
    }
    {
        let tasks = state.agent_tasks.lock().await;
        for turn_id in tasks.keys() {
            operations.push(ActiveOperationV1 {
                operation_id: operation_id("agent", turn_id),
                label: operation_label("Agent turn", turn_id),
                state: ActiveOperationStateV1::Running,
            });
        }
    }
    for (claim_id, claim) in state.agent_file_mutations.snapshot(project_root) {
        operations.push(ActiveOperationV1 {
            operation_id: operation_id("file", &claim_id),
            label: operation_label("Agent file change", &claim.path),
            state: active_state(&claim.status),
        });
    }
    let approval_count = state.approvals.count().await;
    if approval_count > 0 {
        operations.push(ActiveOperationV1 {
            operation_id: OperationId::new("approval:agent").unwrap(),
            label: format!("Agent approvals waiting ({approval_count})"),
            state: ActiveOperationStateV1::Waiting,
        });
    }
    let environment_count = state.environment_approvals.count().await;
    if environment_count > 0 {
        operations.push(ActiveOperationV1 {
            operation_id: OperationId::new("approval:environment").unwrap(),
            label: format!("Environment approvals waiting ({environment_count})"),
            state: ActiveOperationStateV1::Waiting,
        });
    }
    operations.sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
    operations.truncate(rho_ui_contract::MAX_ACTIVE_OPERATIONS);
    operations
}

fn plugin_command_registration(
    contribution: PluginContributionView,
) -> Result<Option<CommandRegistrationV1>, ContractError> {
    if contribution.kind != "command"
        || contribution.contract_major != u64::from(RSR_CONTRACT_MAJOR)
    {
        return Ok(None);
    }
    let Some(input_schema) = contribution.input_schema else {
        return Ok(None);
    };
    let availability = if contribution.available {
        CommandAvailabilityV1::Available
    } else {
        CommandAvailabilityV1::Unavailable {
            reason: match contribution.status.as_str() {
                "host_unavailable" => "The workspace plugin host is unavailable.",
                "permission_unavailable" => {
                    "The workspace plugin is waiting for required permission."
                }
                _ => "The workspace plugin command is unavailable.",
            }
            .to_string(),
        }
    };
    Ok(Some(CommandRegistrationV1 {
        definition: CommandDefinitionV1 {
            command_id: CommandId::new(contribution.contribution_id)?,
            label: contribution.label,
            purpose: contribution.purpose,
            input_schema,
            consequence: "Runs this workspace plugin command through broker admission.".to_string(),
            availability_predicate_id: PredicateId::new(PREDICATE_PLUGIN_READY)?,
            placement_tags: vec![
                CommandPlacementTagV1::Palette,
                CommandPlacementTagV1::SurfaceLocal,
            ],
            origin: SurfaceOriginV1::WorkspacePlugin {
                plugin_id: PluginId::new(contribution.plugin_id)?,
                package_digest: PackageDigest::new(contribution.package_digest)?,
            },
        },
        activation_generation: contribution.activation_generation,
        availability,
    }))
}

fn add_plugin_commands(
    registry: &mut CommandRegistryV1,
    contributions: PluginContributionList,
) -> Result<(), ContractError> {
    let mut command_ids = registry
        .registrations
        .iter()
        .map(|registration| registration.definition.command_id.to_string())
        .collect::<BTreeSet<_>>();
    let mut encoded_bytes = encoded_json_len("command_registry", registry)?;
    for contribution in contributions.contributions {
        let Ok(Some(registration)) = plugin_command_registration(contribution) else {
            continue;
        };
        if registration.validate().is_err()
            || registry.registrations.len() >= MAX_REGISTERED_COMMANDS
            || command_ids.contains(registration.definition.command_id.as_str())
        {
            continue;
        }
        let registration_bytes = encoded_json_len("command_registration", &registration)?;
        let separator_bytes = usize::from(!registry.registrations.is_empty());
        let Some(next_encoded_bytes) = encoded_bytes
            .checked_add(separator_bytes)
            .and_then(|bytes| bytes.checked_add(registration_bytes))
        else {
            continue;
        };
        if next_encoded_bytes > MAX_COMMAND_REGISTRY_BYTES {
            continue;
        }
        command_ids.insert(registration.definition.command_id.to_string());
        registry.registrations.push(registration);
        encoded_bytes = next_encoded_bytes;
    }
    registry
        .registrations
        .sort_by(|left, right| left.definition.command_id.cmp(&right.definition.command_id));
    registry.validate()
}

async fn candidate_for_state(state: &AppState) -> Result<UiKernelSnapshotV1> {
    let root = state.project_root.read().await.clone();
    let project = project_view(&root)?;
    let normalized_root = normalize_project_root(root.to_string_lossy().as_ref());
    let startup = current_startup_view(state);
    let has_session = state.session.read().await.is_some();
    let context_handle = state.context.lock().await.clone();
    let has_context = context_handle.is_some();
    let identity = if let Some(context) = context_handle {
        Some(context.lock().await.broker.identity().clone())
    } else {
        None
    };
    let workspace = workspace_health(&startup, has_session, has_context);
    let agent = agent_health(&startup);
    let context = UiContextV1 {
        project_id: project.project_id.clone(),
        project_revision: identity
            .as_ref()
            .map(|identity| identity.project_revision)
            .unwrap_or(0),
        scene_id: None,
        page_id: None,
        focused_surface_instance_id: None,
        selection: state.ui_runtime.selection_for(&project.project_id),
        workspace_health: workspace.state,
        agent_health: agent.state,
        active_operations: active_operations(state, &normalized_root).await,
    };
    let mut command_registry = application_command_registry_v1(&context)?;
    if let Some(identity) = identity {
        let plugin_context =
            workspace_plugin_runtime_context(state.data_dir.clone(), normalized_root, &identity)?;
        add_plugin_commands(
            &mut command_registry,
            state.plugin_permissions.list_contributions(&plugin_context),
        )?;
    }
    Ok(UiKernelSnapshotV1 {
        contract: UI_KERNEL_SNAPSHOT_CONTRACT.to_string(),
        contract_major: RSR_CONTRACT_MAJOR,
        snapshot_revision: 1,
        project,
        context,
        health: UiHealthSnapshotV1 { workspace, agent },
        command_registry,
    })
}

pub(crate) async fn snapshot_for_state(state: &AppState) -> Result<Arc<UiKernelSnapshotV1>> {
    let candidate = candidate_for_state(state).await?;
    state
        .ui_runtime
        .project(candidate)
        .map_err(|error| anyhow!(error))
}

pub(crate) fn emit_snapshot_invalidated(app: &AppHandle, reason: &str) {
    let _ = app.emit(
        UI_SNAPSHOT_INVALIDATED_EVENT,
        json!({"reason": safe_bounded_text(reason, 512, "state_changed")}),
    );
}

#[tauri::command]
pub(crate) async fn ui_kernel_snapshot(
    state: State<'_, AppState>,
) -> Result<UiKernelSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    snapshot_for_state(&state)
        .await
        .map(|snapshot| snapshot.as_ref().clone())
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn ui_set_selection(
    request: SetUiSelectionRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UiKernelSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let current = snapshot_for_state(&state).await.map_err(display_error)?;
    let previous_selection = state
        .ui_runtime
        .set_selection(request, &current)
        .map_err(display_error)?;
    let updated = match snapshot_for_state(&state).await {
        Ok(updated) => updated,
        Err(error) => {
            state.ui_runtime.restore_selection(previous_selection);
            return Err(display_error(error));
        }
    };
    emit_snapshot_invalidated(&app, "selection_changed");
    Ok(updated.as_ref().clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_ui_contract::{ResourceBindingV1, ResourceKindId, UiSelectionV1};

    fn snapshot(project: &str, project_revision: u64) -> UiKernelSnapshotV1 {
        let mut snapshot = rho_ui_contract::golden_contract_fixture().kernel_snapshot;
        let project_id = ProjectId::new(project).unwrap();
        snapshot.project.project_id = project_id.clone();
        snapshot.project.display_label = project.to_string();
        snapshot.project.display_path = format!("/tmp/{project}");
        snapshot.context.project_id = project_id;
        snapshot.context.project_revision = project_revision;
        snapshot.context.selection = None;
        snapshot.snapshot_revision = 1;
        snapshot
    }

    fn selection_request(snapshot: &UiKernelSnapshotV1) -> SetUiSelectionRequest {
        SetUiSelectionRequest {
            project_id: snapshot.project.project_id.clone(),
            expected_project_revision: snapshot.context.project_revision,
            expected_snapshot_revision: snapshot.snapshot_revision,
            selection: Some(UiSelectionV1::Resource {
                binding: ResourceBindingV1 {
                    resource_provider_id: rho_ui_contract::ResourceProviderId::new(
                        "rho.project-files",
                    )
                    .unwrap(),
                    resource_kind: ResourceKindId::new("project_file").unwrap(),
                    resource_id: "analysis.R".to_string(),
                    resource_revision: Some(8),
                },
            }),
        }
    }

    fn plugin_contribution(id: &str, schema: serde_json::Value) -> PluginContributionView {
        PluginContributionView {
            contribution_id: id.to_string(),
            kind: "command".to_string(),
            label: "Plugin command".to_string(),
            purpose: "Exercise one bounded plugin command projection.".to_string(),
            contract_major: 1,
            plugin_id: "fixture-plugin".to_string(),
            package_digest: "b".repeat(64),
            activation_generation: 4,
            short_digest: "b".repeat(12),
            status: "ready".to_string(),
            available: true,
            accepts_empty_input: true,
            input_schema: Some(schema),
        }
    }

    #[test]
    fn snapshot_cache_is_stable_and_a_b_a_is_monotonic() {
        let runtime = UiRuntimeState::default();
        let a1 = runtime.project(snapshot("project:a", 1)).unwrap();
        let a1_again = runtime.project(snapshot("project:a", 1)).unwrap();
        assert!(Arc::ptr_eq(&a1, &a1_again));
        assert_eq!(a1.snapshot_revision, 1);

        let b = runtime.project(snapshot("project:b", 1)).unwrap();
        assert_eq!(b.snapshot_revision, 2);
        let a2 = runtime.project(snapshot("project:a", 2)).unwrap();
        assert_eq!(a2.snapshot_revision, 3);
        assert_ne!(a1.context.project_revision, a2.context.project_revision);
    }

    #[test]
    fn selection_rejects_stale_or_cross_project_without_mutation() {
        let runtime = UiRuntimeState::default();
        let current = runtime.project(snapshot("project:a", 5)).unwrap();
        let mut stale = selection_request(&current);
        stale.expected_snapshot_revision -= 1;
        assert!(matches!(
            runtime.set_selection(stale, &current),
            Err(ContractError::StaleRevision { .. })
        ));
        assert_eq!(runtime.selection_for(&current.project.project_id), None);

        let mut cross_project = selection_request(&current);
        cross_project.project_id = ProjectId::new("project:b").unwrap();
        assert!(matches!(
            runtime.set_selection(cross_project, &current),
            Err(ContractError::InvalidValue { .. })
        ));
        assert_eq!(runtime.selection_for(&current.project.project_id), None);
    }

    #[test]
    fn selection_success_changes_snapshot_once_and_is_recoverable() {
        let runtime = UiRuntimeState::default();
        let current = runtime.project(snapshot("project:a", 5)).unwrap();
        let previous = runtime
            .set_selection(selection_request(&current), &current)
            .unwrap();
        assert!(previous.is_none());
        let mut next = snapshot("project:a", 5);
        next.context.selection = runtime.selection_for(&next.project.project_id);
        let updated = runtime.project(next).unwrap();
        assert_eq!(updated.snapshot_revision, 2);
        assert!(updated.context.selection.is_some());

        let clear = SetUiSelectionRequest {
            project_id: updated.project.project_id.clone(),
            expected_project_revision: updated.context.project_revision,
            expected_snapshot_revision: updated.snapshot_revision,
            selection: None,
        };
        let previous = runtime.set_selection(clear, &updated).unwrap();
        assert!(previous.is_some());
        let mut recovered = snapshot("project:a", 5);
        recovered.context.selection = runtime.selection_for(&recovered.project.project_id);
        let recovered = runtime.project(recovered).unwrap();
        assert_eq!(recovered.snapshot_revision, 3);
        assert_eq!(recovered.context.selection, None);
    }

    #[test]
    fn failed_selection_projection_can_restore_the_exact_previous_value() {
        let runtime = UiRuntimeState::default();
        let current = runtime.project(snapshot("project:a", 5)).unwrap();
        let previous = runtime
            .set_selection(selection_request(&current), &current)
            .unwrap();
        assert!(runtime.selection_for(&current.project.project_id).is_some());
        runtime.restore_selection(previous);
        assert_eq!(runtime.selection_for(&current.project.project_id), None);
        assert!(Arc::ptr_eq(
            &current,
            &runtime.project(snapshot("project:a", 5)).unwrap()
        ));
    }

    #[test]
    fn placements_project_one_registry_without_execution_authority() {
        let snapshot = snapshot("project:a", 1);
        let registry = &snapshot.command_registry;
        let keyboard = registry
            .for_placement(CommandPlacementTagV1::Keyboard)
            .map(|registration| registration.definition.command_id.as_str())
            .collect::<Vec<_>>();
        let palette = registry
            .for_placement(CommandPlacementTagV1::Palette)
            .map(|registration| registration.definition.command_id.as_str())
            .collect::<Vec<_>>();
        assert!(keyboard.contains(&"rho.workspace.interrupt"));
        assert!(palette.contains(&"rho.workspace.interrupt"));
        assert!(matches!(
            registry
                .registrations
                .iter()
                .find(|registration| {
                    registration.definition.command_id.as_str() == "rho.agent.new-conversation"
                })
                .unwrap()
                .availability,
            CommandAvailabilityV1::Unavailable { .. }
        ));
    }

    #[test]
    fn malformed_or_oversized_plugin_commands_cannot_break_application_commands() {
        let context = snapshot("project:a", 1).context;
        let mut registry = application_command_registry_v1(&context).unwrap();
        let mut unsupported = plugin_contribution(
            "ui.command.unsupported",
            json!({"type": "object", "properties": {}}),
        );
        unsupported.contract_major = 2;
        let mut missing_schema = plugin_contribution(
            "ui.command.missing-schema",
            json!({"type": "object", "properties": {}}),
        );
        missing_schema.input_schema = None;
        let mut contributions = vec![
            plugin_contribution(
                "bad command id",
                json!({"type": "object", "properties": {}}),
            ),
            unsupported,
            missing_schema,
        ];
        contributions.extend((0..20).map(|index| {
            plugin_contribution(
                &format!("ui.command.large-{index}"),
                json!({"type": "object", "description": "x".repeat(60_000)}),
            )
        }));
        add_plugin_commands(
            &mut registry,
            PluginContributionList {
                project_root: "/tmp/project-a".to_string(),
                project_revision: 1,
                contributions,
            },
        )
        .unwrap();
        registry.validate().unwrap();
        assert!(registry.registrations.iter().any(|registration| {
            registration.definition.command_id.as_str() == "rho.command.search"
        }));
        for omitted in [
            "bad command id",
            "ui.command.unsupported",
            "ui.command.missing-schema",
        ] {
            assert!(
                registry
                    .registrations
                    .iter()
                    .all(|registration| { registration.definition.command_id.as_str() != omitted })
            );
        }
        assert!(registry.registrations.len() < 25);
    }
}
