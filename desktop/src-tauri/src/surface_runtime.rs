use std::collections::BTreeMap;
use std::sync::{Mutex as StdMutex, MutexGuard};

use anyhow::{Result, anyhow, bail, ensure};
use rho_ui_contract::{
    ContractError, MAX_HEAVY_SURFACE_INSTANCES, MAX_STANDARD_SURFACE_INSTANCES,
    MAX_STRIP_SURFACE_INSTANCES, MAX_SURFACE_INSTANCES, OpenSurfaceRequestV1, ProjectId,
    RSR_CONTRACT_MAJOR, SURFACE_RUNTIME_SNAPSHOT_CONTRACT, SurfaceCatalogV1, SurfaceDefinitionV1,
    SurfaceFactoryRegistrationV1, SurfaceInstanceDispositionV1, SurfaceInstanceMutationV1,
    SurfaceInstancePolicyV1, SurfaceInstanceQuotaClassV1, SurfaceInstanceRequestV1,
    SurfaceInstanceV1, SurfaceLifecycleStateV1, SurfaceRuntimeEventKindV1, SurfaceRuntimeEventV1,
    SurfaceRuntimeSnapshotV1, UpdateSurfaceRequestV1, Validate, apply_surface_instance_mutation,
    next_revision,
};
#[cfg(test)]
use rho_ui_contract::{SurfaceEventKindV1, SurfaceEventV1};
#[cfg(test)]
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{AppState, display_error};

pub(crate) const SURFACE_RUNTIME_CHANGED_EVENT: &str = "rho://surface-runtime-changed";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectCursor {
    project_id: ProjectId,
    project_revision: u64,
}

#[derive(Default)]
struct SurfaceRuntimeInner {
    snapshot_revision: u64,
    event_revision: u64,
    project: Option<ProjectCursor>,
    factories: Vec<SurfaceFactoryRegistrationV1>,
    instances: BTreeMap<rho_ui_contract::SurfaceInstanceId, SurfaceInstanceV1>,
}

#[derive(Default)]
pub(crate) struct SurfaceRuntimeState {
    inner: StdMutex<SurfaceRuntimeInner>,
}

#[derive(Debug, Clone)]
struct SurfaceTransition {
    snapshot: SurfaceRuntimeSnapshotV1,
    event: Option<SurfaceRuntimeEventV1>,
}

fn snapshot_from_parts(
    snapshot_revision: u64,
    project: &ProjectCursor,
    factories: &[SurfaceFactoryRegistrationV1],
    instances: &BTreeMap<rho_ui_contract::SurfaceInstanceId, SurfaceInstanceV1>,
) -> Result<SurfaceRuntimeSnapshotV1> {
    let snapshot = SurfaceRuntimeSnapshotV1 {
        contract: SURFACE_RUNTIME_SNAPSHOT_CONTRACT.to_string(),
        contract_major: RSR_CONTRACT_MAJOR,
        snapshot_revision,
        project_id: project.project_id.clone(),
        project_revision: project.project_revision,
        catalog: SurfaceCatalogV1 {
            factories: factories.to_vec(),
            instances: instances.values().cloned().collect(),
        },
    };
    snapshot.validate()?;
    Ok(snapshot)
}

fn quota_limit(class: SurfaceInstanceQuotaClassV1) -> usize {
    match class {
        SurfaceInstanceQuotaClassV1::Strip => MAX_STRIP_SURFACE_INSTANCES,
        SurfaceInstanceQuotaClassV1::Standard => MAX_STANDARD_SURFACE_INSTANCES,
        SurfaceInstanceQuotaClassV1::Heavy => MAX_HEAVY_SURFACE_INSTANCES,
    }
}

fn validate_binding_against_factory(
    instance: &SurfaceInstanceV1,
    definition: &SurfaceDefinitionV1,
) -> Result<()> {
    if let Some(mode_id) = &instance.mode_id {
        ensure!(
            definition.modes.iter().any(|mode| &mode.mode_id == mode_id),
            "Surface factory {} does not provide mode {}",
            definition.surface_id,
            mode_id
        );
    }
    if let Some(binding) = &instance.resource_binding {
        ensure!(
            definition
                .resource_kinds
                .iter()
                .any(|kind| kind == &binding.resource_kind),
            "Surface factory {} does not accept resource kind {}",
            definition.surface_id,
            binding.resource_kind
        );
    }
    if let Some(binding) = &instance.runtime_binding {
        ensure!(
            binding.project_id == instance.project_id,
            "Runtime binding belongs to another project"
        );
    }
    Ok(())
}

impl SurfaceRuntimeState {
    fn inner(&self) -> MutexGuard<'_, SurfaceRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn next_event(
        inner: &SurfaceRuntimeInner,
        kind: SurfaceRuntimeEventKindV1,
        instance: Option<&SurfaceInstanceV1>,
    ) -> Result<SurfaceRuntimeEventV1> {
        let project = inner
            .project
            .as_ref()
            .ok_or_else(|| anyhow!("Surface Runtime has no project context"))?;
        let event = SurfaceRuntimeEventV1 {
            event_revision: next_revision("surface_runtime.event_revision", inner.event_revision)?,
            project_id: project.project_id.clone(),
            project_revision: project.project_revision,
            instance_id: instance.map(|value| value.instance_id.clone()),
            surface_revision: instance.map(|value| value.surface_revision),
            activation_generation: instance.map(|value| value.activation_generation),
            kind,
        };
        event.validate()?;
        Ok(event)
    }

    fn current_snapshot(inner: &SurfaceRuntimeInner) -> Result<SurfaceRuntimeSnapshotV1> {
        let project = inner
            .project
            .as_ref()
            .ok_or_else(|| anyhow!("Surface Runtime has no project context"))?;
        snapshot_from_parts(
            inner.snapshot_revision,
            project,
            &inner.factories,
            &inner.instances,
        )
    }

    fn reconcile(
        &self,
        project_id: ProjectId,
        project_revision: u64,
        mut factories: Vec<SurfaceFactoryRegistrationV1>,
    ) -> Result<SurfaceTransition> {
        factories
            .sort_by(|left, right| left.definition.surface_id.cmp(&right.definition.surface_id));
        SurfaceCatalogV1 {
            factories: factories.clone(),
            instances: Vec::new(),
        }
        .validate()?;

        let mut inner = self.inner();
        let next_project = ProjectCursor {
            project_id,
            project_revision,
        };
        let mut next_instances = inner.instances.clone();
        let mut changed = inner.project.as_ref() != Some(&next_project)
            || inner.factories != factories
            || inner.snapshot_revision == 0;

        if inner
            .project
            .as_ref()
            .is_some_and(|current| current.project_id != next_project.project_id)
        {
            next_instances.clear();
        } else {
            let by_id = factories
                .iter()
                .map(|factory| (factory.definition.surface_id.as_str(), factory))
                .collect::<BTreeMap<_, _>>();
            for instance in next_instances.values_mut() {
                let current_generation = by_id
                    .get(instance.surface_id.as_str())
                    .map(|factory| factory.activation_generation);
                if current_generation != Some(instance.activation_generation)
                    && instance.lifecycle_state != SurfaceLifecycleStateV1::Placeholder
                {
                    instance.lifecycle_state = SurfaceLifecycleStateV1::Placeholder;
                    instance.surface_revision = next_revision(
                        "surface_instance.surface_revision",
                        instance.surface_revision,
                    )?;
                    changed = true;
                }
            }
        }

        if !changed {
            return Ok(SurfaceTransition {
                snapshot: Self::current_snapshot(&inner)?,
                event: None,
            });
        }

        let next_snapshot_revision =
            next_revision("surface_runtime.snapshot_revision", inner.snapshot_revision)?;
        let candidate = snapshot_from_parts(
            next_snapshot_revision,
            &next_project,
            &factories,
            &next_instances,
        )?;
        let event = Self::next_event(
            &SurfaceRuntimeInner {
                snapshot_revision: next_snapshot_revision,
                event_revision: inner.event_revision,
                project: Some(next_project.clone()),
                factories: factories.clone(),
                instances: next_instances.clone(),
            },
            SurfaceRuntimeEventKindV1::Reconciled,
            None,
        )?;
        inner.snapshot_revision = next_snapshot_revision;
        inner.event_revision = event.event_revision;
        inner.project = Some(next_project);
        inner.factories = factories;
        inner.instances = next_instances;
        Ok(SurfaceTransition {
            snapshot: candidate,
            event: Some(event),
        })
    }

    fn factory_for(
        inner: &SurfaceRuntimeInner,
        surface_id: &rho_ui_contract::SurfaceId,
    ) -> Result<SurfaceFactoryRegistrationV1> {
        inner
            .factories
            .iter()
            .find(|factory| &factory.definition.surface_id == surface_id)
            .cloned()
            .ok_or_else(|| anyhow!("Surface factory {surface_id} is unavailable"))
    }

    fn ensure_project(
        inner: &SurfaceRuntimeInner,
        project_id: &ProjectId,
        revision: u64,
    ) -> Result<()> {
        let project = inner
            .project
            .as_ref()
            .ok_or_else(|| anyhow!("Surface Runtime has no project context"))?;
        ensure!(
            &project.project_id == project_id,
            "Surface request belongs to another project"
        );
        if project.project_revision != revision {
            return Err(anyhow!(ContractError::StaleRevision {
                path: "surface_request.project_revision".to_string(),
                expected: revision,
                actual: project.project_revision,
            }));
        }
        Ok(())
    }

    fn commit_instances(
        inner: &mut SurfaceRuntimeInner,
        instances: BTreeMap<rho_ui_contract::SurfaceInstanceId, SurfaceInstanceV1>,
        kind: SurfaceRuntimeEventKindV1,
        event_instance: Option<&SurfaceInstanceV1>,
    ) -> Result<SurfaceTransition> {
        let next_snapshot_revision =
            next_revision("surface_runtime.snapshot_revision", inner.snapshot_revision)?;
        let project = inner
            .project
            .clone()
            .ok_or_else(|| anyhow!("Surface Runtime has no project context"))?;
        let snapshot = snapshot_from_parts(
            next_snapshot_revision,
            &project,
            &inner.factories,
            &instances,
        )?;
        let event = Self::next_event(inner, kind, event_instance)?;
        inner.snapshot_revision = next_snapshot_revision;
        inner.event_revision = event.event_revision;
        inner.instances = instances;
        Ok(SurfaceTransition {
            snapshot,
            event: Some(event),
        })
    }

    fn open(&self, request: OpenSurfaceRequestV1) -> Result<SurfaceTransition> {
        request.validate()?;
        ensure!(
            request.expected_layout_revision == 0,
            "Studio layout revision is unavailable before Wave 4"
        );
        let mut inner = self.inner();
        Self::ensure_project(
            &inner,
            &request.project_id,
            request.expected_project_revision,
        )?;
        let factory = Self::factory_for(&inner, &request.surface_id)?;
        let candidate_shape = SurfaceInstanceV1 {
            instance_id: rho_ui_contract::SurfaceInstanceId::new("surface-instance:candidate")?,
            surface_id: request.surface_id.clone(),
            project_id: request.project_id.clone(),
            origin: factory.definition.origin.clone(),
            activation_generation: factory.activation_generation,
            surface_revision: 1,
            mode_id: request.mode_id.clone(),
            resource_binding: request.resource_binding.clone(),
            runtime_binding: request.runtime_binding.clone(),
            view_group_id: request.view_group_id.clone(),
            view_state: request.view_state.clone(),
            lifecycle_state: SurfaceLifecycleStateV1::Active,
        };
        validate_binding_against_factory(&candidate_shape, &factory.definition)?;

        if request.instance_disposition == SurfaceInstanceDispositionV1::ReuseExact
            && inner.instances.values().any(|instance| {
                instance.lifecycle_state != SurfaceLifecycleStateV1::Placeholder
                    && instance.surface_id == candidate_shape.surface_id
                    && instance.project_id == candidate_shape.project_id
                    && instance.origin == candidate_shape.origin
                    && instance.activation_generation == candidate_shape.activation_generation
                    && instance.mode_id == candidate_shape.mode_id
                    && instance.resource_binding == candidate_shape.resource_binding
                    && instance.runtime_binding == candidate_shape.runtime_binding
                    && instance.view_group_id == candidate_shape.view_group_id
                    && instance.view_state == candidate_shape.view_state
            })
        {
            return Ok(SurfaceTransition {
                snapshot: Self::current_snapshot(&inner)?,
                event: None,
            });
        }

        if factory.definition.instance_policy == SurfaceInstancePolicyV1::Singleton
            && inner.instances.values().any(|instance| {
                instance.surface_id == request.surface_id
                    && instance.activation_generation == factory.activation_generation
                    && instance.lifecycle_state != SurfaceLifecycleStateV1::Placeholder
            })
        {
            bail!(
                "Surface factory {} permits only one instance per project",
                request.surface_id
            );
        }
        ensure!(
            inner.instances.len() < MAX_SURFACE_INSTANCES,
            "Surface instance resource budget is exhausted"
        );
        let class_count = inner
            .instances
            .values()
            .filter(|instance| {
                inner.factories.iter().any(|current| {
                    current.definition.surface_id == instance.surface_id
                        && current.activation_generation == instance.activation_generation
                        && current.definition.instance_quota_class
                            == factory.definition.instance_quota_class
                })
            })
            .count();
        ensure!(
            class_count < quota_limit(factory.definition.instance_quota_class),
            "Surface {:?} resource budget is exhausted",
            factory.definition.instance_quota_class
        );

        let instance_id = loop {
            let candidate = rho_ui_contract::SurfaceInstanceId::new(format!(
                "surface-instance:{}",
                Uuid::new_v4().simple()
            ))?;
            if !inner.instances.contains_key(&candidate) {
                break candidate;
            }
        };
        let mut instance = candidate_shape;
        instance.instance_id = instance_id.clone();
        let event_instance = instance.clone();
        let mut instances = inner.instances.clone();
        instances.insert(instance_id.clone(), instance);
        Self::commit_instances(
            &mut inner,
            instances,
            SurfaceRuntimeEventKindV1::Opened,
            Some(&event_instance),
        )
    }

    fn validated_target(
        inner: &SurfaceRuntimeInner,
        request: &SurfaceInstanceRequestV1,
    ) -> Result<SurfaceInstanceV1> {
        request.validate()?;
        Self::ensure_project(
            inner,
            &request.project_id,
            request.expected_project_revision,
        )?;
        let instance = inner
            .instances
            .get(&request.instance_id)
            .cloned()
            .ok_or_else(|| anyhow!("Surface instance {} was not found", request.instance_id))?;
        ensure!(
            instance.activation_generation == request.activation_generation,
            "Surface request activation generation is stale"
        );
        if instance.surface_revision != request.expected_surface_revision {
            return Err(anyhow!(ContractError::StaleRevision {
                path: "surface_instance.surface_revision".to_string(),
                expected: request.expected_surface_revision,
                actual: instance.surface_revision,
            }));
        }
        Ok(instance)
    }

    fn update(&self, request: UpdateSurfaceRequestV1) -> Result<SurfaceTransition> {
        request.validate()?;
        let mut inner = self.inner();
        let current = Self::validated_target(&inner, &request.target)?;
        ensure!(
            current.lifecycle_state != SurfaceLifecycleStateV1::Placeholder,
            "Unavailable placeholder instances cannot be updated"
        );
        if let SurfaceInstanceMutationV1::SetLifecycle { state } = request.mutation {
            ensure!(
                matches!(
                    state,
                    SurfaceLifecycleStateV1::Active | SurfaceLifecycleStateV1::Hidden
                ),
                "Use suspend/resume for suspension; failed and placeholder states are host-owned"
            );
            return self.update_instance_locked(
                &mut inner,
                current,
                request.target.expected_surface_revision,
                SurfaceInstanceMutationV1::SetLifecycle { state },
                SurfaceRuntimeEventKindV1::Updated,
            );
        }
        self.update_instance_locked(
            &mut inner,
            current,
            request.target.expected_surface_revision,
            request.mutation,
            SurfaceRuntimeEventKindV1::Updated,
        )
    }

    fn update_instance_locked(
        &self,
        inner: &mut SurfaceRuntimeInner,
        current: SurfaceInstanceV1,
        expected_revision: u64,
        mutation: SurfaceInstanceMutationV1,
        kind: SurfaceRuntimeEventKindV1,
    ) -> Result<SurfaceTransition> {
        let updated = apply_surface_instance_mutation(&current, expected_revision, mutation)?;
        let factory = Self::factory_for(inner, &updated.surface_id)?;
        ensure!(
            factory.activation_generation == updated.activation_generation,
            "Surface factory generation was replaced"
        );
        validate_binding_against_factory(&updated, &factory.definition)?;
        let instance_id = updated.instance_id.clone();
        let event_instance = updated.clone();
        let mut instances = inner.instances.clone();
        instances.insert(instance_id.clone(), updated);
        Self::commit_instances(inner, instances, kind, Some(&event_instance))
    }

    fn close(&self, request: SurfaceInstanceRequestV1) -> Result<SurfaceTransition> {
        let mut inner = self.inner();
        let current = Self::validated_target(&inner, &request)?;
        let mut instances = inner.instances.clone();
        instances.remove(&request.instance_id);
        Self::commit_instances(
            &mut inner,
            instances,
            SurfaceRuntimeEventKindV1::Closed,
            Some(&current),
        )
    }

    fn set_suspension(
        &self,
        request: SurfaceInstanceRequestV1,
        suspend: bool,
    ) -> Result<SurfaceTransition> {
        let mut inner = self.inner();
        let current = Self::validated_target(&inner, &request)?;
        if suspend {
            ensure!(
                matches!(
                    current.lifecycle_state,
                    SurfaceLifecycleStateV1::Active | SurfaceLifecycleStateV1::Hidden
                ),
                "Only active or hidden Surface instances can be suspended"
            );
        } else {
            ensure!(
                current.lifecycle_state == SurfaceLifecycleStateV1::Suspended,
                "Only suspended Surface instances can be resumed"
            );
        }
        let state = if suspend {
            SurfaceLifecycleStateV1::Suspended
        } else {
            SurfaceLifecycleStateV1::Active
        };
        self.update_instance_locked(
            &mut inner,
            current,
            request.expected_surface_revision,
            SurfaceInstanceMutationV1::SetLifecycle { state },
            if suspend {
                SurfaceRuntimeEventKindV1::Suspended
            } else {
                SurfaceRuntimeEventKindV1::Resumed
            },
        )
    }

    #[cfg(test)]
    fn record_application_event(&self, event: SurfaceEventV1) -> Result<SurfaceTransition> {
        event.validate()?;
        let mut inner = self.inner();
        let project = inner
            .project
            .as_ref()
            .ok_or_else(|| anyhow!("Surface Runtime has no project context"))?;
        ensure!(
            event.project_id == project.project_id,
            "Surface event belongs to another project"
        );
        let current = inner
            .instances
            .get(&event.instance_id)
            .cloned()
            .ok_or_else(|| anyhow!("Surface event targets a closed instance"))?;
        ensure!(
            event.origin == current.origin,
            "Surface event origin is stale"
        );
        ensure!(
            event.activation_generation == current.activation_generation,
            "Surface event activation generation is stale"
        );
        ensure!(
            event.expected_surface_revision == current.surface_revision,
            "Surface event revision is stale"
        );
        ensure!(
            event.expected_resource_revision
                == current
                    .resource_binding
                    .as_ref()
                    .and_then(|binding| binding.resource_revision),
            "Surface event resource revision is stale"
        );
        ensure!(
            event.expected_runtime_state_revision
                == current
                    .runtime_binding
                    .as_ref()
                    .map(|binding| binding.state_revision),
            "Surface event runtime revision is stale"
        );
        let next_state = match event.kind {
            SurfaceEventKindV1::Failed => Some(SurfaceLifecycleStateV1::Failed),
            SurfaceEventKindV1::Ready
                if current.lifecycle_state == SurfaceLifecycleStateV1::Failed =>
            {
                Some(SurfaceLifecycleStateV1::Active)
            }
            _ => None,
        };
        let Some(state) = next_state else {
            return Ok(SurfaceTransition {
                snapshot: Self::current_snapshot(&inner)?,
                event: None,
            });
        };
        self.update_instance_locked(
            &mut inner,
            current.clone(),
            current.surface_revision,
            SurfaceInstanceMutationV1::SetLifecycle { state },
            SurfaceRuntimeEventKindV1::Updated,
        )
    }
}

fn application_factories(state: &AppState) -> Result<Vec<SurfaceFactoryRegistrationV1>> {
    let application = state.extension_host.scopes().application();
    let resolution = application
        .registry()
        .resolve_application_surfaces()
        .map_err(|error| anyhow!(error))?;
    Ok(resolution.factories().to_vec())
}

async fn reconcile_for_state(state: &AppState) -> Result<SurfaceTransition> {
    let kernel = crate::ui_runtime::snapshot_for_state(state).await?;
    state.surface_runtime.reconcile(
        kernel.project.project_id.clone(),
        kernel.context.project_revision,
        application_factories(state)?,
    )
}

fn emit_transition(app: &AppHandle, transition: &SurfaceTransition) {
    if let Some(event) = &transition.event {
        let _ = app.emit(SURFACE_RUNTIME_CHANGED_EVENT, event);
    }
}

#[tauri::command]
pub(crate) async fn surface_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SurfaceRuntimeSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let transition = reconcile_for_state(&state).await.map_err(display_error)?;
    emit_transition(&app, &transition);
    Ok(transition.snapshot)
}

#[tauri::command]
pub(crate) async fn surface_open(
    request: OpenSurfaceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SurfaceRuntimeSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let reconciled = reconcile_for_state(&state).await.map_err(display_error)?;
    emit_transition(&app, &reconciled);
    let transition = state.surface_runtime.open(request).map_err(display_error)?;
    emit_transition(&app, &transition);
    Ok(transition.snapshot)
}

#[tauri::command]
pub(crate) async fn surface_update(
    request: UpdateSurfaceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SurfaceRuntimeSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let reconciled = reconcile_for_state(&state).await.map_err(display_error)?;
    emit_transition(&app, &reconciled);
    let transition = state
        .surface_runtime
        .update(request)
        .map_err(display_error)?;
    emit_transition(&app, &transition);
    Ok(transition.snapshot)
}

async fn mutate_target(
    request: SurfaceInstanceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
    mutation: impl FnOnce(&SurfaceRuntimeState, SurfaceInstanceRequestV1) -> Result<SurfaceTransition>,
) -> Result<SurfaceRuntimeSnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let reconciled = reconcile_for_state(&state).await.map_err(display_error)?;
    emit_transition(&app, &reconciled);
    let transition = mutation(&state.surface_runtime, request).map_err(display_error)?;
    emit_transition(&app, &transition);
    Ok(transition.snapshot)
}

#[tauri::command]
pub(crate) async fn surface_close(
    request: SurfaceInstanceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SurfaceRuntimeSnapshotV1, String> {
    mutate_target(request, app, state, SurfaceRuntimeState::close).await
}

#[tauri::command]
pub(crate) async fn surface_suspend(
    request: SurfaceInstanceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SurfaceRuntimeSnapshotV1, String> {
    mutate_target(request, app, state, |runtime, request| {
        runtime.set_suspension(request, true)
    })
    .await
}

#[tauri::command]
pub(crate) async fn surface_resume(
    request: SurfaceInstanceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SurfaceRuntimeSnapshotV1, String> {
    mutate_target(request, app, state, |runtime, request| {
        runtime.set_suspension(request, false)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_ui_contract::{
        ApplicationComponentId, OperationId, ResourceBindingV1, ResourceKindId, SurfaceId,
        SurfaceInteractionKindV1, SurfaceModeId, SurfaceModeV1, SurfaceOriginV1,
        SurfacePlacementIntentV1, SurfacePresentationClassV1, SurfaceRendererKindV1,
        SurfaceScopeV1, SurfaceSizingHintsV1,
    };
    use serde_json::json;

    fn project(value: &str) -> ProjectId {
        ProjectId::new(value).unwrap()
    }

    fn factory(
        id: &str,
        generation: u64,
        policy: SurfaceInstancePolicyV1,
    ) -> SurfaceFactoryRegistrationV1 {
        SurfaceFactoryRegistrationV1 {
            definition: SurfaceDefinitionV1 {
                surface_id: SurfaceId::new(id).unwrap(),
                contract_major: 1,
                label: "Fixture Surface".to_string(),
                purpose: "Exercise the desktop Surface Runtime transaction boundary.".to_string(),
                renderer_kind: SurfaceRendererKindV1::TrustedHost,
                scope: SurfaceScopeV1::Project,
                instance_policy: policy,
                instance_quota_class: SurfaceInstanceQuotaClassV1::Standard,
                resource_kinds: vec![ResourceKindId::new("project_file").unwrap()],
                modes: vec![SurfaceModeV1 {
                    mode_id: SurfaceModeId::new("preview").unwrap(),
                    label: "Preview".to_string(),
                    interaction_kind: SurfaceInteractionKindV1::ReadOnly,
                }],
                sizing_hints: SurfaceSizingHintsV1 {
                    min_inline: 120,
                    min_block: 80,
                    ideal_inline: None,
                    ideal_block: None,
                    max_inline: None,
                    max_block: None,
                    stretch_inline: true,
                    stretch_block: true,
                    presentation_classes: vec![SurfacePresentationClassV1::Full],
                },
                accepted_contexts: vec!["project".to_string()],
                commands: vec![],
                origin: SurfaceOriginV1::Application {
                    component_id: ApplicationComponentId::new(id).unwrap(),
                },
            },
            activation_generation: generation,
        }
    }

    fn open_request(project_id: &ProjectId) -> OpenSurfaceRequestV1 {
        OpenSurfaceRequestV1 {
            surface_id: SurfaceId::new("rho.fixture").unwrap(),
            project_id: project_id.clone(),
            mode_id: Some(SurfaceModeId::new("preview").unwrap()),
            resource_binding: Some(ResourceBindingV1 {
                resource_kind: ResourceKindId::new("project_file").unwrap(),
                resource_id: "analysis.R".to_string(),
                resource_revision: Some(4),
            }),
            runtime_binding: None,
            view_group_id: None,
            view_state: json!({"draft": ""}),
            instance_disposition: SurfaceInstanceDispositionV1::NewInstance,
            placement_intent: SurfacePlacementIntentV1::Current,
            expected_project_revision: 7,
            expected_layout_revision: 0,
        }
    }

    fn target(snapshot: &SurfaceRuntimeSnapshotV1, index: usize) -> SurfaceInstanceRequestV1 {
        let instance = &snapshot.catalog.instances[index];
        SurfaceInstanceRequestV1 {
            project_id: snapshot.project_id.clone(),
            instance_id: instance.instance_id.clone(),
            activation_generation: instance.activation_generation,
            expected_project_revision: snapshot.project_revision,
            expected_surface_revision: instance.surface_revision,
        }
    }

    #[test]
    fn repeated_identical_views_are_independent_and_reuse_is_explicit() {
        let runtime = SurfaceRuntimeState::default();
        let project_id = project("project:a");
        runtime
            .reconcile(
                project_id.clone(),
                7,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap();
        let first = runtime.open(open_request(&project_id)).unwrap().snapshot;
        let second = runtime.open(open_request(&project_id)).unwrap().snapshot;
        assert_eq!(second.catalog.instances.len(), 2);
        assert_ne!(
            second.catalog.instances[0].instance_id,
            second.catalog.instances[1].instance_id
        );
        assert_eq!(
            second.catalog.instances[0].resource_binding,
            second.catalog.instances[1].resource_binding
        );

        let mut reuse = open_request(&project_id);
        reuse.instance_disposition = SurfaceInstanceDispositionV1::ReuseExact;
        let reused = runtime.open(reuse).unwrap().snapshot;
        assert_eq!(reused.snapshot_revision, second.snapshot_revision);
        assert_eq!(reused.catalog.instances.len(), 2);

        let closed_target = target(&second, 0);
        let closed_transition = runtime.close(closed_target.clone()).unwrap();
        assert_eq!(
            closed_transition
                .event
                .as_ref()
                .and_then(|event| event.instance_id.as_ref()),
            Some(&closed_target.instance_id)
        );
        let closed = closed_transition.snapshot;
        assert_eq!(closed.catalog.instances.len(), 1);
        assert_eq!(
            closed.catalog.instances[0].instance_id,
            second.catalog.instances[1].instance_id
        );
        assert!(first.snapshot_revision < closed.snapshot_revision);
    }

    #[test]
    fn singleton_and_resource_budgets_are_not_layout_shape_rules() {
        let runtime = SurfaceRuntimeState::default();
        let project_id = project("project:a");
        runtime
            .reconcile(
                project_id.clone(),
                7,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::Singleton,
                )],
            )
            .unwrap();
        runtime.open(open_request(&project_id)).unwrap();
        assert!(runtime.open(open_request(&project_id)).is_err());

        let scalable = SurfaceRuntimeState::default();
        scalable
            .reconcile(
                project_id.clone(),
                7,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap();
        for _ in 0..MAX_STANDARD_SURFACE_INSTANCES {
            scalable.open(open_request(&project_id)).unwrap();
        }
        assert!(scalable.open(open_request(&project_id)).is_err());
    }

    #[test]
    fn hidden_suspended_failed_and_reopen_are_distinct_states() {
        let runtime = SurfaceRuntimeState::default();
        let project_id = project("project:a");
        runtime
            .reconcile(
                project_id.clone(),
                7,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap();
        let opened = runtime.open(open_request(&project_id)).unwrap().snapshot;
        let hidden = runtime
            .update(UpdateSurfaceRequestV1 {
                target: target(&opened, 0),
                mutation: SurfaceInstanceMutationV1::SetLifecycle {
                    state: SurfaceLifecycleStateV1::Hidden,
                },
            })
            .unwrap()
            .snapshot;
        let suspended = runtime
            .set_suspension(target(&hidden, 0), true)
            .unwrap()
            .snapshot;
        assert_eq!(
            suspended.catalog.instances[0].lifecycle_state,
            SurfaceLifecycleStateV1::Suspended
        );
        let resumed = runtime
            .set_suspension(target(&suspended, 0), false)
            .unwrap()
            .snapshot;
        let instance = &resumed.catalog.instances[0];
        let failed = runtime
            .record_application_event(SurfaceEventV1 {
                event_id: OperationId::new("surface-event:failed").unwrap(),
                project_id: project_id.clone(),
                instance_id: instance.instance_id.clone(),
                origin: instance.origin.clone(),
                activation_generation: instance.activation_generation,
                expected_surface_revision: instance.surface_revision,
                expected_resource_revision: Some(4),
                expected_runtime_state_revision: None,
                expected_layout_revision: None,
                expected_page_revision: None,
                kind: SurfaceEventKindV1::Failed,
                payload: json!({"code": "fixture_crash"}),
            })
            .unwrap()
            .snapshot;
        assert_eq!(
            failed.catalog.instances[0].lifecycle_state,
            SurfaceLifecycleStateV1::Failed
        );
        let reopened = runtime.open(open_request(&project_id)).unwrap().snapshot;
        assert_eq!(reopened.catalog.instances.len(), 2);
        assert!(
            reopened
                .catalog
                .instances
                .iter()
                .any(|instance| { instance.lifecycle_state == SurfaceLifecycleStateV1::Active })
        );
        assert!(
            reopened
                .catalog
                .instances
                .iter()
                .any(|instance| { instance.lifecycle_state == SurfaceLifecycleStateV1::Failed })
        );
    }

    #[test]
    fn view_state_mutation_is_transactional_stale_safe_and_sibling_local() {
        let runtime = SurfaceRuntimeState::default();
        let project_id = project("project:a");
        runtime
            .reconcile(
                project_id.clone(),
                7,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap();
        runtime.open(open_request(&project_id)).unwrap();
        let opened = runtime.open(open_request(&project_id)).unwrap().snapshot;
        let first_id = opened.catalog.instances[0].instance_id.clone();
        let second_before = opened.catalog.instances[1].clone();
        let updated = runtime
            .update(UpdateSurfaceRequestV1 {
                target: target(&opened, 0),
                mutation: SurfaceInstanceMutationV1::SetViewState {
                    view_state: json!({"draft": "first only"}),
                },
            })
            .unwrap()
            .snapshot;
        let first_after = updated
            .catalog
            .instances
            .iter()
            .find(|instance| instance.instance_id == first_id)
            .unwrap();
        let second_after = updated
            .catalog
            .instances
            .iter()
            .find(|instance| instance.instance_id == second_before.instance_id)
            .unwrap();
        assert_eq!(first_after.view_state, json!({"draft": "first only"}));
        assert_eq!(second_after, &second_before);

        let before_stale = updated.clone();
        assert!(
            runtime
                .update(UpdateSurfaceRequestV1 {
                    target: target(&opened, 0),
                    mutation: SurfaceInstanceMutationV1::SetViewState {
                        view_state: json!({"draft": "stale overwrite"}),
                    },
                })
                .is_err()
        );
        assert_eq!(
            SurfaceRuntimeState::current_snapshot(&runtime.inner()).unwrap(),
            before_stale
        );
    }

    #[test]
    fn generation_replacement_creates_placeholder_and_rejects_late_events() {
        let runtime = SurfaceRuntimeState::default();
        let project_id = project("project:a");
        runtime
            .reconcile(
                project_id.clone(),
                7,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap();
        let opened = runtime.open(open_request(&project_id)).unwrap().snapshot;
        let old = opened.catalog.instances[0].clone();
        let replaced = runtime
            .reconcile(
                project_id.clone(),
                7,
                vec![factory(
                    "rho.fixture",
                    2,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap()
            .snapshot;
        assert_eq!(
            replaced.catalog.instances[0].lifecycle_state,
            SurfaceLifecycleStateV1::Placeholder
        );
        assert_eq!(replaced.catalog.instances[0].activation_generation, 1);
        assert!(
            runtime
                .record_application_event(SurfaceEventV1 {
                    event_id: OperationId::new("surface-event:late").unwrap(),
                    project_id: project_id.clone(),
                    instance_id: old.instance_id,
                    origin: old.origin,
                    activation_generation: old.activation_generation,
                    expected_surface_revision: old.surface_revision,
                    expected_resource_revision: Some(4),
                    expected_runtime_state_revision: None,
                    expected_layout_revision: None,
                    expected_page_revision: None,
                    kind: SurfaceEventKindV1::Changed,
                    payload: Value::Null,
                })
                .is_err()
        );
        let reopened = runtime.open(open_request(&project_id)).unwrap().snapshot;
        assert_eq!(reopened.catalog.instances.len(), 2);
        assert!(
            reopened
                .catalog
                .instances
                .iter()
                .any(|instance| instance.activation_generation == 2
                    && instance.lifecycle_state == SurfaceLifecycleStateV1::Active)
        );
    }

    #[test]
    fn project_switch_isolates_instances_and_stale_requests() {
        let runtime = SurfaceRuntimeState::default();
        let project_a = project("project:a");
        let project_b = project("project:b");
        runtime
            .reconcile(
                project_a.clone(),
                7,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap();
        let a = runtime.open(open_request(&project_a)).unwrap().snapshot;
        let b = runtime
            .reconcile(
                project_b.clone(),
                1,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap()
            .snapshot;
        assert!(b.catalog.instances.is_empty());
        assert!(runtime.close(target(&a, 0)).is_err());
        let a_again = runtime
            .reconcile(
                project_a,
                8,
                vec![factory(
                    "rho.fixture",
                    1,
                    SurfaceInstancePolicyV1::MultiInstance,
                )],
            )
            .unwrap()
            .snapshot;
        assert!(a_again.catalog.instances.is_empty());
        assert!(a_again.snapshot_revision > a.snapshot_revision);
    }
}
