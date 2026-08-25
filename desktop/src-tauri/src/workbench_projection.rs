use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Result, anyhow};
use rho_ui_contract::{
    ProjectUiProfileSnapshotV1, ResourceRegistrySnapshotV1, RuntimeRegistrySnapshotV1,
    StudioRuntimeSnapshotV1, SurfaceRuntimeSnapshotV1, UiKernelSnapshotV1, Validate,
    WORKBENCH_PROJECTION_CONTRACT, WorkbenchProjectionV1, WorkbenchRevisionVectorV1,
};
use tauri::State;

use crate::AppState;

#[derive(Default)]
pub(crate) struct WorkbenchProjectionState {
    generation: AtomicU64,
}

impl WorkbenchProjectionState {
    fn next_generation(&self) -> Result<u64> {
        self.generation
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| anyhow!("Workbench projection generation overflow"))
    }
}

fn assemble_projection(
    projection_generation: u64,
    kernel: UiKernelSnapshotV1,
    surfaces: SurfaceRuntimeSnapshotV1,
    studio: StudioRuntimeSnapshotV1,
    runtimes: RuntimeRegistrySnapshotV1,
    resources: ResourceRegistrySnapshotV1,
    profile: ProjectUiProfileSnapshotV1,
) -> Result<WorkbenchProjectionV1> {
    let revisions = WorkbenchRevisionVectorV1::from_snapshots(
        &kernel, &surfaces, &studio, &runtimes, &resources, &profile,
    );
    let projection = WorkbenchProjectionV1 {
        contract: WORKBENCH_PROJECTION_CONTRACT.to_string(),
        contract_major: rho_ui_contract::RSR_CONTRACT_MAJOR,
        projection_generation,
        project_id: kernel.project.project_id.clone(),
        revisions,
        kernel,
        surfaces,
        studio,
        runtimes,
        resources,
        profile,
    };
    projection.validate()?;
    Ok(projection)
}

pub(crate) async fn capture_for_state(state: &AppState) -> Result<WorkbenchProjectionV1> {
    // The caller owns project_transition_gate for this complete sequence. Each
    // domain may reconcile its in-memory projection, but no independent
    // project-scoped mutation can interleave with the revision vector capture.
    let resources = crate::resource_registry::reconcile_for_state(state)
        .await?
        .snapshot;
    let surfaces = crate::surface_runtime::reconcile_for_state(state)
        .await?
        .snapshot;
    let studio = crate::studio_runtime::reconcile_with_surface_snapshot(state, &surfaces)?.snapshot;
    let runtimes = crate::runtime_registry::reconcile_for_state(state)
        .await?
        .snapshot;
    let factories = crate::surface_runtime::available_factories(state).await?;
    let profile = crate::ui_profile::reconcile_for_state(state, &factories, &runtimes).await?;
    let kernel = crate::ui_runtime::snapshot_for_state(state).await?;
    let generation = state.workbench_projection.next_generation()?;
    assemble_projection(
        generation,
        kernel.as_ref().clone(),
        surfaces,
        studio,
        runtimes,
        resources,
        profile,
    )
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn workbench_projection_snapshot(
    state: State<'_, AppState>,
) -> Result<WorkbenchProjectionV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    capture_for_state(&state)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_projection(generation: u64) -> Result<WorkbenchProjectionV1> {
        let fixture = rho_ui_contract::golden_contract_fixture();
        assemble_projection(
            generation,
            fixture.kernel_snapshot,
            fixture.surface_runtime_snapshot,
            fixture.studio_runtime_snapshot,
            fixture.runtime_registry_snapshot,
            fixture.resource_registry_snapshot,
            fixture.project_ui_profile_snapshot,
        )
    }

    #[test]
    fn workbench_projection_generation_is_monotonic_and_project_drift_is_rejected() {
        let state = WorkbenchProjectionState::default();
        assert_eq!(state.next_generation().unwrap(), 1);
        assert_eq!(state.next_generation().unwrap(), 2);

        let first = fixture_projection(1).unwrap();
        assert_eq!(first.revisions.project_revision, 7);

        let fixture = rho_ui_contract::golden_contract_fixture();
        let mut resources = fixture.resource_registry_snapshot;
        resources.project_id = rho_ui_contract::ProjectId::new("project:other").unwrap();
        assert!(
            assemble_projection(
                2,
                fixture.kernel_snapshot,
                fixture.surface_runtime_snapshot,
                fixture.studio_runtime_snapshot,
                fixture.runtime_registry_snapshot,
                resources,
                fixture.project_ui_profile_snapshot,
            )
            .is_err()
        );
    }

    #[test]
    fn workbench_projection_ipc_serialization_preserves_revision_vector() {
        let value = serde_json::to_value(fixture_projection(11).unwrap()).unwrap();
        assert_eq!(value["contract"], WORKBENCH_PROJECTION_CONTRACT);
        assert_eq!(value["projection_generation"], 11);
        assert_eq!(value["project_id"], "project:fixture");
        assert_eq!(value["revisions"]["project_revision"], 7);
        assert_eq!(
            value["revisions"]["layout_revision"],
            value["studio"]["scene"]["layout_revision"]
        );
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn workbench_projection_typescript_export() {
        let output_path = std::env::var_os("RHO_WORKBENCH_PROJECTION_BINDINGS_PATH")
            .expect("RHO_WORKBENCH_PROJECTION_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                super::workbench_projection_snapshot,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Workbench projection TypeScript export must succeed");
    }
}
