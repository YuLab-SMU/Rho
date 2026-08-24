use std::collections::{BTreeSet, VecDeque};
use std::sync::{Mutex as StdMutex, MutexGuard};

use anyhow::{Result, anyhow, ensure};
use rho_ui_contract::{
    LayoutAxisV1, LayoutNodeId, LayoutNodeV1, ProjectId, RSR_CONTRACT_MAJOR,
    STUDIO_RUNTIME_SNAPSHOT_CONTRACT, SceneEditRequestV1, SceneId, SceneStateV1,
    StudioRevisionRequestV1, StudioRuntimeSnapshotV1, SurfaceInstanceId, SurfaceRuntimeSnapshotV1,
    Validate, apply_scene_edit, collect_scene_instance_ids, next_revision,
    reconcile_scene_instances,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::surface_runtime::SurfaceTransition;
use crate::{AppState, display_error};

pub(crate) const STUDIO_RUNTIME_CHANGED_EVENT: &str = "rho://studio-runtime-changed";
const MAX_STUDIO_HISTORY: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectCursor {
    project_id: ProjectId,
    project_revision: u64,
}

#[derive(Clone, Default)]
struct StudioRuntimeInner {
    snapshot_revision: u64,
    project: Option<ProjectCursor>,
    scene: Option<SceneStateV1>,
    undo: VecDeque<SceneStateV1>,
    redo: VecDeque<SceneStateV1>,
    available_instance_ids: BTreeSet<String>,
}

#[derive(Default)]
pub(crate) struct StudioRuntimeState {
    inner: StdMutex<StudioRuntimeInner>,
}

#[derive(Clone)]
pub(crate) struct StudioRuntimeCheckpoint(StudioRuntimeInner);

#[derive(Debug, Clone)]
pub(crate) struct StudioTransition {
    pub(crate) snapshot: StudioRuntimeSnapshotV1,
    pub(crate) reason: &'static str,
    pub(crate) changed: bool,
}

#[derive(Clone, Serialize)]
struct StudioChangedEvent<'a> {
    reason: &'a str,
    snapshot_revision: u64,
    project_id: &'a ProjectId,
    project_revision: u64,
    layout_revision: u64,
}

fn next_node_id() -> LayoutNodeId {
    LayoutNodeId::new(format!("layout-node:{}", Uuid::new_v4().simple()))
        .expect("host-generated layout node ID must be valid")
}

fn next_scene_id() -> SceneId {
    SceneId::new(format!("studio-scene:{}", Uuid::new_v4().simple()))
        .expect("host-generated Scene ID must be valid")
}

fn empty_scene(project_id: ProjectId) -> SceneStateV1 {
    SceneStateV1 {
        scene_id: next_scene_id(),
        project_id,
        label: "Studio".to_string(),
        layout_revision: 1,
        root: LayoutNodeV1::Container {
            node_id: next_node_id(),
            axis: LayoutAxisV1::Horizontal,
            children: Vec::new(),
        },
        focused_surface_instance_id: None,
        utility_tray: None,
    }
}

fn available_instance_ids(surface: &SurfaceRuntimeSnapshotV1) -> BTreeSet<String> {
    surface
        .catalog
        .instances
        .iter()
        .map(|instance| instance.instance_id.to_string())
        .collect()
}

fn snapshot_from_inner(
    inner: &StudioRuntimeInner,
    available: &BTreeSet<String>,
) -> Result<StudioRuntimeSnapshotV1> {
    let project = inner
        .project
        .as_ref()
        .ok_or_else(|| anyhow!("Studio Runtime has no project context"))?;
    let scene = inner
        .scene
        .as_ref()
        .ok_or_else(|| anyhow!("Studio Runtime has no Scene"))?;
    let mut placed = BTreeSet::new();
    collect_scene_instance_ids(scene, &mut placed);
    let unplaced_instance_ids = available
        .iter()
        .filter(|instance_id| !placed.contains(instance_id.as_str()))
        .map(|instance_id| SurfaceInstanceId::new(instance_id.clone()))
        .collect::<Result<Vec<_>, _>>()?;
    let snapshot = StudioRuntimeSnapshotV1 {
        contract: STUDIO_RUNTIME_SNAPSHOT_CONTRACT.to_string(),
        contract_major: RSR_CONTRACT_MAJOR,
        snapshot_revision: inner.snapshot_revision,
        project_id: project.project_id.clone(),
        project_revision: project.project_revision,
        scene: scene.clone(),
        unplaced_instance_ids,
        can_undo: !inner.undo.is_empty(),
        can_redo: !inner.redo.is_empty(),
    };
    snapshot.validate()?;
    Ok(snapshot)
}

fn validate_scene_instances(scene: &SceneStateV1, available: &BTreeSet<String>) -> Result<()> {
    let mut placed = BTreeSet::new();
    collect_scene_instance_ids(scene, &mut placed);
    if let Some(missing) = placed
        .into_iter()
        .find(|instance_id| !available.contains(*instance_id))
    {
        return Err(anyhow!(
            "Studio edit references unavailable Surface instance {missing}"
        ));
    }
    Ok(())
}

impl StudioRuntimeState {
    fn inner(&self) -> MutexGuard<'_, StudioRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn push_bounded(history: &mut VecDeque<SceneStateV1>, scene: SceneStateV1) {
        if history.len() == MAX_STUDIO_HISTORY {
            history.pop_front();
        }
        history.push_back(scene);
    }

    pub(crate) fn reconcile(
        &self,
        project_id: ProjectId,
        project_revision: u64,
        available: &BTreeSet<String>,
        desired_scene: Option<&SceneStateV1>,
    ) -> Result<StudioTransition> {
        let mut inner = self.inner();
        let next_project = ProjectCursor {
            project_id: project_id.clone(),
            project_revision,
        };
        let project_changed = inner
            .project
            .as_ref()
            .is_none_or(|current| current.project_id != project_id);
        let available_changed = inner.available_instance_ids != *available;
        let mut changed = inner.snapshot_revision == 0
            || inner.project.as_ref() != Some(&next_project)
            || project_changed
            || available_changed;
        let mut reason = if project_changed {
            "project_reconciled"
        } else {
            "project_revision_reconciled"
        };

        if project_changed {
            let scene = desired_scene
                .cloned()
                .unwrap_or_else(|| empty_scene(project_id.clone()));
            ensure!(
                scene.project_id == project_id,
                "Persisted Studio Scene belongs to another project"
            );
            scene.validate()?;
            inner.scene = Some(scene);
            inner.undo.clear();
            inner.redo.clear();
        } else if let Some(desired) = desired_scene
            && inner.scene.as_ref() != Some(desired)
        {
            ensure!(
                desired.project_id == project_id,
                "Persisted Studio Scene belongs to another project"
            );
            desired.validate()?;
            inner.scene = Some(desired.clone());
            inner.undo.clear();
            inner.redo.clear();
            changed = true;
            reason = "profile_scene_reconciled";
        } else if let Some(scene) = inner.scene.as_ref() {
            let mut allocate = next_node_id;
            if let Some(pruned) = reconcile_scene_instances(scene, available, &mut allocate)? {
                inner.scene = Some(pruned);
                inner.undo.clear();
                inner.redo.clear();
                changed = true;
                reason = "surface_instances_reconciled";
            }
        }
        inner.project = Some(next_project);
        inner.available_instance_ids = available.clone();
        if changed {
            inner.snapshot_revision =
                next_revision("studio_runtime.snapshot_revision", inner.snapshot_revision)?;
        }
        Ok(StudioTransition {
            snapshot: snapshot_from_inner(&inner, available)?,
            reason,
            changed,
        })
    }

    pub(crate) fn checkpoint(&self) -> StudioRuntimeCheckpoint {
        StudioRuntimeCheckpoint(self.inner().clone())
    }

    pub(crate) fn restore_checkpoint(&self, checkpoint: StudioRuntimeCheckpoint) {
        *self.inner() = checkpoint.0;
    }

    fn ensure_request(inner: &StudioRuntimeInner, request: &StudioRevisionRequestV1) -> Result<()> {
        let project = inner
            .project
            .as_ref()
            .ok_or_else(|| anyhow!("Studio Runtime has no project context"))?;
        ensure!(
            project.project_id == request.project_id,
            "Studio request belongs to another project"
        );
        ensure!(
            project.project_revision == request.expected_project_revision,
            "Studio request project revision is stale"
        );
        let scene = inner
            .scene
            .as_ref()
            .ok_or_else(|| anyhow!("Studio Runtime has no Scene"))?;
        ensure!(
            scene.layout_revision == request.expected_layout_revision,
            "Studio request layout revision is stale"
        );
        Ok(())
    }

    pub(crate) fn apply(
        &self,
        request: SceneEditRequestV1,
        available: &BTreeSet<String>,
    ) -> Result<StudioTransition> {
        request.validate()?;
        let mut inner = self.inner();
        Self::ensure_request(
            &inner,
            &StudioRevisionRequestV1 {
                project_id: request.project_id,
                expected_project_revision: request.expected_project_revision,
                expected_layout_revision: request.expected_layout_revision,
            },
        )?;
        let current = inner.scene.clone().unwrap();
        let mut allocate = next_node_id;
        let candidate = apply_scene_edit(
            &current,
            request.expected_layout_revision,
            request.edit,
            &mut allocate,
        )?;
        validate_scene_instances(&candidate, available)?;
        Self::push_bounded(&mut inner.undo, current);
        inner.redo.clear();
        inner.scene = Some(candidate);
        inner.snapshot_revision =
            next_revision("studio_runtime.snapshot_revision", inner.snapshot_revision)?;
        Ok(StudioTransition {
            snapshot: snapshot_from_inner(&inner, available)?,
            reason: "scene_edited",
            changed: true,
        })
    }

    fn history(
        &self,
        request: StudioRevisionRequestV1,
        available: &BTreeSet<String>,
        undo: bool,
    ) -> Result<StudioTransition> {
        let mut inner = self.inner();
        Self::ensure_request(&inner, &request)?;
        let current = inner.scene.clone().unwrap();
        let mut target = if undo {
            inner.undo.pop_back()
        } else {
            inner.redo.pop_back()
        }
        .ok_or_else(|| {
            anyhow!(if undo {
                "Studio undo history is empty"
            } else {
                "Studio redo history is empty"
            })
        })?;
        target.layout_revision = next_revision("scene.layout_revision", current.layout_revision)?;
        target.project_id = current.project_id.clone();
        target.validate()?;
        validate_scene_instances(&target, available)?;
        if undo {
            Self::push_bounded(&mut inner.redo, current);
        } else {
            Self::push_bounded(&mut inner.undo, current);
        }
        inner.scene = Some(target);
        inner.snapshot_revision =
            next_revision("studio_runtime.snapshot_revision", inner.snapshot_revision)?;
        Ok(StudioTransition {
            snapshot: snapshot_from_inner(&inner, available)?,
            reason: if undo { "scene_undo" } else { "scene_redo" },
            changed: true,
        })
    }

    pub(crate) fn undo(
        &self,
        request: StudioRevisionRequestV1,
        available: &BTreeSet<String>,
    ) -> Result<StudioTransition> {
        self.history(request, available, true)
    }

    pub(crate) fn redo(
        &self,
        request: StudioRevisionRequestV1,
        available: &BTreeSet<String>,
    ) -> Result<StudioTransition> {
        self.history(request, available, false)
    }
}

pub(crate) fn reconcile_with_surface_snapshot(
    state: &AppState,
    surface: &SurfaceRuntimeSnapshotV1,
) -> Result<StudioTransition> {
    let profile = state.ui_profile.snapshot()?;
    state.studio_runtime.reconcile(
        surface.project_id.clone(),
        surface.project_revision,
        &available_instance_ids(surface),
        profile.profile.active_scene(),
    )
}

pub(crate) fn emit_transition(app: &AppHandle, transition: &StudioTransition) {
    if !transition.changed {
        return;
    }
    let snapshot = &transition.snapshot;
    let _ = app.emit(
        STUDIO_RUNTIME_CHANGED_EVENT,
        StudioChangedEvent {
            reason: transition.reason,
            snapshot_revision: snapshot.snapshot_revision,
            project_id: &snapshot.project_id,
            project_revision: snapshot.project_revision,
            layout_revision: snapshot.scene.layout_revision,
        },
    );
}

async fn prepare(
    app: &AppHandle,
    state: &AppState,
) -> Result<(SurfaceTransition, StudioTransition)> {
    let surface = crate::surface_runtime::reconcile_for_state(state).await?;
    crate::surface_runtime::emit_transition(app, &surface);
    let studio = reconcile_with_surface_snapshot(state, &surface.snapshot)?;
    emit_transition(app, &studio);
    Ok((surface, studio))
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn studio_scene(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StudioRuntimeSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    prepare(&app, &state)
        .await
        .map(|(_, studio)| studio.snapshot)
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn studio_apply(
    request: SceneEditRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StudioRuntimeSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let (surface, _) = prepare(&app, &state).await.map_err(display_error)?;
    let checkpoint = state.studio_runtime.checkpoint();
    let transition = state
        .studio_runtime
        .apply(request, &available_instance_ids(&surface.snapshot))
        .map_err(display_error)?;
    let profile = match crate::ui_profile::commit_runtime_state(
        &state,
        Some(transition.snapshot.scene.clone()),
        &surface.snapshot,
    ) {
        Ok(profile) => profile,
        Err(error) => {
            state.studio_runtime.restore_checkpoint(checkpoint);
            return Err(display_error(error));
        }
    };
    crate::ui_profile::emit_snapshot(&app, &profile);
    emit_transition(&app, &transition);
    Ok(transition.snapshot)
}

async fn mutate_history(
    request: StudioRevisionRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
    undo: bool,
) -> Result<StudioRuntimeSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let (surface, _) = prepare(&app, &state).await.map_err(display_error)?;
    let available = available_instance_ids(&surface.snapshot);
    let checkpoint = state.studio_runtime.checkpoint();
    let transition = if undo {
        state.studio_runtime.undo(request, &available)
    } else {
        state.studio_runtime.redo(request, &available)
    }
    .map_err(display_error)?;
    let profile = match crate::ui_profile::commit_runtime_state(
        &state,
        Some(transition.snapshot.scene.clone()),
        &surface.snapshot,
    ) {
        Ok(profile) => profile,
        Err(error) => {
            state.studio_runtime.restore_checkpoint(checkpoint);
            return Err(display_error(error));
        }
    };
    crate::ui_profile::emit_snapshot(&app, &profile);
    emit_transition(&app, &transition);
    Ok(transition.snapshot)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn studio_undo(
    request: StudioRevisionRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StudioRuntimeSnapshotV1, String> {
    mutate_history(request, app, state, true).await
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn studio_redo(
    request: StudioRevisionRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StudioRuntimeSnapshotV1, String> {
    mutate_history(request, app, state, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_ui_contract::{LayoutBasisV1, SceneEditV1};

    fn instance(value: &str) -> String {
        SurfaceInstanceId::new(value).unwrap().to_string()
    }

    fn request(snapshot: &StudioRuntimeSnapshotV1, edit: SceneEditV1) -> SceneEditRequestV1 {
        SceneEditRequestV1 {
            project_id: snapshot.project_id.clone(),
            expected_project_revision: snapshot.project_revision,
            expected_layout_revision: snapshot.scene.layout_revision,
            edit,
        }
    }

    #[test]
    fn edits_are_stale_safe_transactional_and_undoable() {
        let runtime = StudioRuntimeState::default();
        let project_id = ProjectId::new("project:a").unwrap();
        let available = BTreeSet::from([instance("instance:a"), instance("instance:b")]);
        let initial = runtime
            .reconcile(project_id, 3, &available, None)
            .unwrap()
            .snapshot;
        let root_id = initial.scene.root.node_id().clone();
        let inserted = runtime
            .apply(
                request(
                    &initial,
                    SceneEditV1::InsertSurface {
                        target_container_node_id: root_id.clone(),
                        child_index: 0,
                        instance_id: SurfaceInstanceId::new("instance:a").unwrap(),
                        basis: LayoutBasisV1::Fraction { weight: 3 },
                    },
                ),
                &available,
            )
            .unwrap()
            .snapshot;
        assert!(inserted.can_undo);
        assert_eq!(inserted.unplaced_instance_ids.len(), 1);

        let stale = request(
            &initial,
            SceneEditV1::InsertSurface {
                target_container_node_id: root_id,
                child_index: 0,
                instance_id: SurfaceInstanceId::new("instance:b").unwrap(),
                basis: LayoutBasisV1::Auto,
            },
        );
        assert!(runtime.apply(stale, &available).is_err());
        assert_eq!(
            snapshot_from_inner(&runtime.inner(), &available).unwrap(),
            inserted
        );

        let undone = runtime
            .undo(
                StudioRevisionRequestV1 {
                    project_id: inserted.project_id.clone(),
                    expected_project_revision: inserted.project_revision,
                    expected_layout_revision: inserted.scene.layout_revision,
                },
                &available,
            )
            .unwrap()
            .snapshot;
        assert!(undone.can_redo);
        assert_eq!(undone.unplaced_instance_ids.len(), 2);
        let redone = runtime
            .redo(
                StudioRevisionRequestV1 {
                    project_id: undone.project_id.clone(),
                    expected_project_revision: undone.project_revision,
                    expected_layout_revision: undone.scene.layout_revision,
                },
                &available,
            )
            .unwrap()
            .snapshot;
        assert_eq!(redone.unplaced_instance_ids.len(), 1);
        assert!(redone.scene.layout_revision > inserted.scene.layout_revision);
    }

    #[test]
    fn missing_instances_are_pruned_and_projects_are_isolated() {
        let runtime = StudioRuntimeState::default();
        let project_a = ProjectId::new("project:a").unwrap();
        let available = BTreeSet::from([instance("instance:a")]);
        let initial = runtime
            .reconcile(project_a, 1, &available, None)
            .unwrap()
            .snapshot;
        let placed = runtime
            .apply(
                request(
                    &initial,
                    SceneEditV1::InsertSurface {
                        target_container_node_id: initial.scene.root.node_id().clone(),
                        child_index: 0,
                        instance_id: SurfaceInstanceId::new("instance:a").unwrap(),
                        basis: LayoutBasisV1::Intrinsic,
                    },
                ),
                &available,
            )
            .unwrap()
            .snapshot;
        let pruned = runtime
            .reconcile(placed.project_id.clone(), 2, &BTreeSet::new(), None)
            .unwrap()
            .snapshot;
        assert!(pruned.unplaced_instance_ids.is_empty());
        assert!(!pruned.can_undo);

        let project_b = runtime
            .reconcile(
                ProjectId::new("project:b").unwrap(),
                1,
                &BTreeSet::from([instance("instance:b")]),
                None,
            )
            .unwrap()
            .snapshot;
        assert_eq!(project_b.project_id.as_str(), "project:b");
        assert!(project_b.scene.layout_revision == 1);
        assert!(project_b.unplaced_instance_ids.len() == 1);
    }
}
