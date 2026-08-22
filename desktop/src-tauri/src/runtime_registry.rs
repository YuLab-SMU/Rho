use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use anyhow::{Context, Result, anyhow, ensure};
use rho_kernel::{ArkLaunchConfig, ArkSession, CorrelatedKernelEvent};
use rho_ui_contract::{
    RSR_CONTRACT_MAJOR, RUNTIME_REGISTRY_SNAPSHOT_CONTRACT, RuntimeAttachmentRequestV1,
    RuntimeCreateRequestV1, RuntimeDescriptorV1, RuntimeDetachRequestV1, RuntimeExecuteRequestV1,
    RuntimeExecutionResultV1, RuntimeInstanceId, RuntimeInstanceRequestV1, RuntimeOutputEventV1,
    RuntimePersistenceClassV1, RuntimeProviderId, RuntimeProviderRegistrationV1,
    RuntimeRegistrySnapshotV1, RuntimeStatusV1, SurfaceInstanceMutationV1, UpdateSurfaceRequestV1,
    Validate, next_revision,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::{AppState, display_error};

pub(crate) const RUNTIME_REGISTRY_CHANGED_EVENT: &str = "rho://runtime-registry-changed";
type RetiredRuntimeSessions = Vec<Arc<RwLock<ArkSession>>>;
type AuxiliaryRetirement = (Option<RuntimeTransition>, RetiredRuntimeSessions);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectCursor {
    project_id: rho_ui_contract::ProjectId,
    project_revision: u64,
}

#[derive(Clone)]
struct RuntimeEntry {
    descriptor: RuntimeDescriptorV1,
    provider_activation_generation: u64,
    session: Option<Arc<RwLock<ArkSession>>>,
    execution_gate: Arc<Mutex<()>>,
    cancellation_requested: Arc<AtomicBool>,
}

#[derive(Default)]
struct RuntimeRegistryInner {
    snapshot_revision: u64,
    project: Option<ProjectCursor>,
    providers: Vec<RuntimeProviderRegistrationV1>,
    instances: BTreeMap<RuntimeInstanceId, RuntimeEntry>,
    workspace_kernel_instance_id: Option<String>,
    workspace_runtime_generation: u64,
}

#[derive(Default)]
pub(crate) struct RuntimeRegistryState {
    inner: StdMutex<RuntimeRegistryInner>,
    operation_gate: Mutex<()>,
    active_executions: AtomicUsize,
}

struct RuntimeExecutionLease<'a> {
    active_executions: &'a AtomicUsize,
}

impl Drop for RuntimeExecutionLease<'_> {
    fn drop(&mut self) {
        self.active_executions.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Clone)]
pub(crate) struct RuntimeTransition {
    pub(crate) snapshot: RuntimeRegistrySnapshotV1,
    pub(crate) reason: &'static str,
    pub(crate) changed: bool,
}

#[derive(Clone, Serialize)]
struct RuntimeRegistryChangedEvent<'a> {
    reason: &'a str,
    snapshot_revision: u64,
    project_id: &'a rho_ui_contract::ProjectId,
    project_revision: u64,
}

fn provider_for<'a>(
    providers: &'a [RuntimeProviderRegistrationV1],
    provider_id: &RuntimeProviderId,
) -> Result<&'a RuntimeProviderRegistrationV1> {
    providers
        .iter()
        .find(|provider| &provider.definition.runtime_provider_id == provider_id)
        .ok_or_else(|| anyhow!("Runtime Provider {provider_id} is unavailable"))
}

fn snapshot_from_inner(inner: &RuntimeRegistryInner) -> Result<RuntimeRegistrySnapshotV1> {
    let project = inner
        .project
        .as_ref()
        .ok_or_else(|| anyhow!("Runtime Registry has no project context"))?;
    let snapshot = RuntimeRegistrySnapshotV1 {
        contract: RUNTIME_REGISTRY_SNAPSHOT_CONTRACT.to_string(),
        contract_major: RSR_CONTRACT_MAJOR,
        snapshot_revision: inner.snapshot_revision,
        project_id: project.project_id.clone(),
        project_revision: project.project_revision,
        providers: inner.providers.clone(),
        instances: inner
            .instances
            .values()
            .map(|entry| entry.descriptor.clone())
            .collect(),
    };
    snapshot.validate()?;
    Ok(snapshot)
}

fn next_runtime_instance_id() -> RuntimeInstanceId {
    RuntimeInstanceId::new(format!("runtime:ark-r-{}", Uuid::new_v4().simple()))
        .expect("host-generated Runtime instance ID must be valid")
}

impl RuntimeRegistryState {
    fn inner(&self) -> MutexGuard<'_, RuntimeRegistryInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn bump(inner: &mut RuntimeRegistryInner) -> Result<()> {
        inner.snapshot_revision = next_revision(
            "runtime_registry.snapshot_revision",
            inner.snapshot_revision,
        )?;
        Ok(())
    }

    fn begin_execution(&self) -> RuntimeExecutionLease<'_> {
        self.active_executions.fetch_add(1, Ordering::AcqRel);
        RuntimeExecutionLease {
            active_executions: &self.active_executions,
        }
    }

    pub(crate) fn active_execution_count(&self) -> usize {
        self.active_executions.load(Ordering::Acquire)
    }

    fn ensure_project(
        inner: &RuntimeRegistryInner,
        request: &RuntimeInstanceRequestV1,
    ) -> Result<()> {
        request.validate()?;
        let project = inner
            .project
            .as_ref()
            .ok_or_else(|| anyhow!("Runtime Registry has no project context"))?;
        ensure!(
            project.project_id == request.project_id,
            "Runtime request belongs to another project"
        );
        ensure!(
            project.project_revision == request.expected_project_revision,
            "Runtime request project revision is stale"
        );
        Ok(())
    }

    fn target(
        inner: &RuntimeRegistryInner,
        request: &RuntimeInstanceRequestV1,
        enforce_state_revision: bool,
    ) -> Result<RuntimeEntry> {
        Self::ensure_project(inner, request)?;
        let entry = inner
            .instances
            .get(&request.runtime_instance_id)
            .ok_or_else(|| {
                anyhow!(
                    "Runtime instance {} was not found",
                    request.runtime_instance_id
                )
            })?;
        ensure!(
            entry.descriptor.runtime_provider_id == request.runtime_provider_id
                && entry.descriptor.activation_generation == request.activation_generation,
            "Runtime request generation is stale"
        );
        if enforce_state_revision {
            ensure!(
                entry.descriptor.state_revision == request.expected_state_revision,
                "Runtime request state revision is stale"
            );
        }
        Ok(entry.clone())
    }

    fn transition(
        inner: &RuntimeRegistryInner,
        reason: &'static str,
        changed: bool,
    ) -> Result<RuntimeTransition> {
        Ok(RuntimeTransition {
            snapshot: snapshot_from_inner(inner)?,
            reason,
            changed,
        })
    }

    fn reconcile(
        &self,
        project_id: rho_ui_contract::ProjectId,
        project_revision: u64,
        providers: Vec<RuntimeProviderRegistrationV1>,
        workspace: Option<&rho_protocol::WorkspaceIdentity>,
    ) -> Result<(RuntimeTransition, Vec<Arc<RwLock<ArkSession>>>)> {
        let mut inner = self.inner();
        let next_project = ProjectCursor {
            project_id: project_id.clone(),
            project_revision,
        };
        let project_changed = inner
            .project
            .as_ref()
            .is_none_or(|current| current.project_id != project_id);
        let project_cursor_changed = inner.project.as_ref() != Some(&next_project);
        let providers_changed = inner.providers != providers;
        let mut retired = Vec::new();
        if project_changed {
            for entry in inner.instances.values() {
                if let Some(session) = &entry.session {
                    retired.push(Arc::clone(session));
                }
            }
            inner.instances.clear();
            inner.workspace_kernel_instance_id = None;
            inner.workspace_runtime_generation = 0;
        } else if providers_changed {
            inner.instances.retain(|_, entry| {
                let retained = providers.iter().any(|provider| {
                    provider.definition.runtime_provider_id == entry.descriptor.runtime_provider_id
                        && provider.activation_generation == entry.provider_activation_generation
                });
                if !retained && let Some(session) = &entry.session {
                    retired.push(Arc::clone(session));
                }
                retained
            });
        }
        inner.project = Some(next_project.clone());
        inner.providers = providers;

        let workspace_id = RuntimeInstanceId::new("runtime:workspace-r")?;
        let before_workspace = inner
            .instances
            .get(&workspace_id)
            .map(|entry| entry.descriptor.clone());
        if let Some(workspace) = workspace {
            let provider =
                provider_for(&inner.providers, &RuntimeProviderId::new("rho.ark-r")?)?.clone();
            if inner.workspace_kernel_instance_id.as_deref()
                != Some(workspace.kernel_instance_id.as_str())
            {
                inner.workspace_runtime_generation = next_revision(
                    "workspace_runtime.activation_generation",
                    inner.workspace_runtime_generation,
                )?;
                inner.workspace_kernel_instance_id = Some(workspace.kernel_instance_id.clone());
            }
            let descriptor = RuntimeDescriptorV1 {
                runtime_provider_id: provider.definition.runtime_provider_id.clone(),
                runtime_instance_id: workspace_id.clone(),
                runtime_kind: provider.definition.runtime_kind.clone(),
                project_id,
                activation_generation: inner.workspace_runtime_generation,
                state_revision: workspace.state_revision.saturating_add(1),
                status: RuntimeStatusV1::Ready,
                attach_capabilities: provider.definition.attach_capabilities.clone(),
                persistence_class: RuntimePersistenceClassV1::ProjectPersistent,
                display_label: "Workspace R".to_string(),
                primary_scientific_runtime: true,
            };
            descriptor.validate()?;
            let execution_gate = inner.instances.get(&workspace_id).map_or_else(
                || Arc::new(Mutex::new(())),
                |entry| Arc::clone(&entry.execution_gate),
            );
            let cancellation_requested = inner.instances.get(&workspace_id).map_or_else(
                || Arc::new(AtomicBool::new(false)),
                |entry| Arc::clone(&entry.cancellation_requested),
            );
            inner.instances.insert(
                workspace_id.clone(),
                RuntimeEntry {
                    descriptor,
                    provider_activation_generation: provider.activation_generation,
                    session: None,
                    execution_gate,
                    cancellation_requested,
                },
            );
        } else {
            inner.instances.remove(&workspace_id);
        }
        let workspace_changed = before_workspace
            != inner
                .instances
                .get(&workspace_id)
                .map(|entry| entry.descriptor.clone());
        let changed = inner.snapshot_revision == 0
            || project_cursor_changed
            || project_changed
            || providers_changed
            || workspace_changed;
        if changed {
            Self::bump(&mut inner)?;
        }
        Ok((
            Self::transition(
                &inner,
                if project_changed {
                    "project_reconciled"
                } else {
                    "runtime_reconciled"
                },
                changed,
            )?,
            retired,
        ))
    }

    fn begin_create(
        &self,
        request: &RuntimeCreateRequestV1,
    ) -> Result<(RuntimeTransition, RuntimeEntry)> {
        request.validate()?;
        let mut inner = self.inner();
        let project = inner
            .project
            .as_ref()
            .ok_or_else(|| anyhow!("Runtime Registry has no project context"))?;
        ensure!(
            project.project_id == request.project_id,
            "Runtime create belongs to another project"
        );
        ensure!(
            project.project_revision == request.expected_project_revision,
            "Runtime create project revision is stale"
        );
        ensure!(
            inner.snapshot_revision == request.expected_snapshot_revision,
            "Runtime create snapshot revision is stale"
        );
        let provider = provider_for(&inner.providers, &request.runtime_provider_id)?.clone();
        ensure!(
            provider.definition.create_supported,
            "Runtime Provider does not create auxiliary runtimes"
        );
        let count = inner
            .instances
            .values()
            .filter(|entry| {
                entry.descriptor.runtime_provider_id == request.runtime_provider_id
                    && !entry.descriptor.primary_scientific_runtime
            })
            .count();
        ensure!(
            count < usize::from(provider.definition.max_instances),
            "Runtime Provider instance budget is exhausted"
        );
        let descriptor = RuntimeDescriptorV1 {
            runtime_provider_id: request.runtime_provider_id.clone(),
            runtime_instance_id: next_runtime_instance_id(),
            runtime_kind: provider.definition.runtime_kind.clone(),
            project_id: request.project_id.clone(),
            activation_generation: 1,
            state_revision: 1,
            status: RuntimeStatusV1::Starting,
            attach_capabilities: provider.definition.attach_capabilities.clone(),
            persistence_class: RuntimePersistenceClassV1::ExplicitLease,
            display_label: request
                .display_label
                .clone()
                .unwrap_or_else(|| format!("Auxiliary R {}", count + 1)),
            primary_scientific_runtime: false,
        };
        descriptor.validate()?;
        let entry = RuntimeEntry {
            descriptor: descriptor.clone(),
            provider_activation_generation: provider.activation_generation,
            session: None,
            execution_gate: Arc::new(Mutex::new(())),
            cancellation_requested: Arc::new(AtomicBool::new(false)),
        };
        inner
            .instances
            .insert(descriptor.runtime_instance_id.clone(), entry.clone());
        Self::bump(&mut inner)?;
        Ok((Self::transition(&inner, "runtime_starting", true)?, entry))
    }

    fn complete_start(
        &self,
        runtime_instance_id: &RuntimeInstanceId,
        session: Arc<RwLock<ArkSession>>,
    ) -> Result<RuntimeTransition> {
        let mut inner = self.inner();
        let entry = inner
            .instances
            .get_mut(runtime_instance_id)
            .ok_or_else(|| anyhow!("Runtime start reservation disappeared"))?;
        entry.descriptor.state_revision =
            next_revision("runtime.state_revision", entry.descriptor.state_revision)?;
        entry.session = Some(session);
        entry.descriptor.status = RuntimeStatusV1::Ready;
        Self::bump(&mut inner)?;
        Self::transition(&inner, "runtime_ready", true)
    }

    fn set_status(
        &self,
        request: &RuntimeInstanceRequestV1,
        status: RuntimeStatusV1,
        reason: &'static str,
        enforce_state_revision: bool,
    ) -> Result<(RuntimeTransition, RuntimeEntry)> {
        let mut inner = self.inner();
        let current = Self::target(&inner, request, enforce_state_revision)?;
        let entry = inner
            .instances
            .get_mut(&request.runtime_instance_id)
            .unwrap();
        entry.descriptor.status = status;
        entry.descriptor.state_revision =
            next_revision("runtime.state_revision", entry.descriptor.state_revision)?;
        let next = entry.clone();
        Self::bump(&mut inner)?;
        let transition = Self::transition(&inner, reason, true)?;
        let _ = current;
        Ok((transition, next))
    }

    fn finish_status(
        &self,
        runtime_instance_id: &RuntimeInstanceId,
        status: RuntimeStatusV1,
        reason: &'static str,
    ) -> Result<RuntimeTransition> {
        let mut inner = self.inner();
        let entry = inner
            .instances
            .get_mut(runtime_instance_id)
            .ok_or_else(|| anyhow!("Runtime instance disappeared"))?;
        entry.descriptor.status = status;
        entry.descriptor.state_revision =
            next_revision("runtime.state_revision", entry.descriptor.state_revision)?;
        Self::bump(&mut inner)?;
        Self::transition(&inner, reason, true)
    }

    fn finish_execution(
        &self,
        runtime_instance_id: &RuntimeInstanceId,
        activation_generation: u64,
        status: RuntimeStatusV1,
        reason: &'static str,
    ) -> Result<(RuntimeTransition, Option<RuntimeDescriptorV1>)> {
        let mut inner = self.inner();
        let Some(entry) = inner.instances.get_mut(runtime_instance_id) else {
            return Ok((Self::transition(&inner, reason, false)?, None));
        };
        if entry.descriptor.activation_generation != activation_generation {
            return Ok((Self::transition(&inner, reason, false)?, None));
        }
        entry.descriptor.status = status;
        entry.descriptor.state_revision =
            next_revision("runtime.state_revision", entry.descriptor.state_revision)?;
        let descriptor = entry.descriptor.clone();
        Self::bump(&mut inner)?;
        Ok((Self::transition(&inner, reason, true)?, Some(descriptor)))
    }

    fn install_restarted_session(
        &self,
        runtime_instance_id: &RuntimeInstanceId,
        session: Arc<RwLock<ArkSession>>,
    ) -> Result<RuntimeTransition> {
        let mut inner = self.inner();
        let entry = inner
            .instances
            .get_mut(runtime_instance_id)
            .ok_or_else(|| anyhow!("Runtime instance disappeared"))?;
        entry.session = Some(session);
        entry.descriptor.activation_generation = next_revision(
            "runtime.activation_generation",
            entry.descriptor.activation_generation,
        )?;
        entry.descriptor.state_revision =
            next_revision("runtime.state_revision", entry.descriptor.state_revision)?;
        entry.descriptor.status = RuntimeStatusV1::Ready;
        Self::bump(&mut inner)?;
        Self::transition(&inner, "runtime_restarted", true)
    }

    fn remove(
        &self,
        request: &RuntimeInstanceRequestV1,
    ) -> Result<(RuntimeTransition, RuntimeEntry)> {
        let mut inner = self.inner();
        let entry = Self::target(&inner, request, true)?;
        ensure!(
            !entry.descriptor.primary_scientific_runtime,
            "Workspace R is project-owned and cannot be stopped through the auxiliary Runtime command"
        );
        inner.instances.remove(&request.runtime_instance_id);
        Self::bump(&mut inner)?;
        Ok((Self::transition(&inner, "runtime_stopped", true)?, entry))
    }

    fn retire_auxiliary(&self) -> Result<AuxiliaryRetirement> {
        let mut inner = self.inner();
        let auxiliary_ids = inner
            .instances
            .iter()
            .filter(|(_, entry)| !entry.descriptor.primary_scientific_runtime)
            .map(|(runtime_instance_id, _)| runtime_instance_id.clone())
            .collect::<Vec<_>>();
        if auxiliary_ids.is_empty() {
            return Ok((None, Vec::new()));
        }
        let mut retired = Vec::with_capacity(auxiliary_ids.len());
        for runtime_instance_id in auxiliary_ids {
            if let Some(entry) = inner.instances.remove(&runtime_instance_id)
                && let Some(session) = entry.session
            {
                retired.push(session);
            }
        }
        Self::bump(&mut inner)?;
        Ok((
            Some(Self::transition(
                &inner,
                "auxiliary_runtimes_retired",
                true,
            )?),
            retired,
        ))
    }
}

fn application_providers(state: &AppState) -> Result<Vec<RuntimeProviderRegistrationV1>> {
    let application = state.extension_host.scopes().application();
    let resolution = application
        .registry()
        .resolve_application_runtime_providers()?;
    Ok(resolution.providers().to_vec())
}

async fn workspace_identity(state: &AppState) -> Option<rho_protocol::WorkspaceIdentity> {
    let context = state.context.lock().await.clone()?;
    Some(context.lock().await.broker.identity().clone())
}

async fn shutdown_session(session: Arc<RwLock<ArkSession>>) {
    if let Ok(mut guard) =
        tokio::time::timeout(std::time::Duration::from_secs(12), session.write()).await
    {
        let _ = guard.shutdown().await;
    }
}

pub(crate) async fn reconcile_for_state(state: &AppState) -> Result<RuntimeTransition> {
    let kernel = crate::ui_runtime::snapshot_for_state(state).await?;
    let (transition, retired) = state.runtime_registry.reconcile(
        kernel.project.project_id.clone(),
        kernel.context.project_revision,
        application_providers(state)?,
        workspace_identity(state).await.as_ref(),
    )?;
    for session in retired {
        shutdown_session(session).await;
    }
    Ok(transition)
}

pub(crate) fn emit_transition(app: &AppHandle, transition: &RuntimeTransition) {
    if !transition.changed {
        return;
    }
    let snapshot = &transition.snapshot;
    let _ = app.emit(
        RUNTIME_REGISTRY_CHANGED_EVENT,
        RuntimeRegistryChangedEvent {
            reason: transition.reason,
            snapshot_revision: snapshot.snapshot_revision,
            project_id: &snapshot.project_id,
            project_revision: snapshot.project_revision,
        },
    );
}

pub(crate) async fn teardown_auxiliary_runtimes(
    app: Option<&AppHandle>,
    state: &AppState,
) -> Result<()> {
    let (transition, retired) = state.runtime_registry.retire_auxiliary()?;
    if let (Some(app), Some(transition)) = (app, transition.as_ref()) {
        emit_transition(app, transition);
    }
    for session in retired {
        let _ = session.read().await.interrupt().await;
        shutdown_session(session).await;
    }
    Ok(())
}

async fn prepare(app: &AppHandle, state: &AppState) -> Result<RuntimeTransition> {
    let transition = reconcile_for_state(state).await?;
    emit_transition(app, &transition);
    Ok(transition)
}

async fn launch_auxiliary(
    state: &AppState,
    entry: &RuntimeEntry,
) -> Result<Arc<RwLock<ArkSession>>> {
    let config = crate::runtime_config(state)?;
    let mut launch = ArkLaunchConfig::new(&config.kernelspec);
    launch.session_name = entry.descriptor.runtime_instance_id.to_string();
    let session = ArkSession::launch(&launch)
        .await
        .context("starting auxiliary Ark R runtime")?;
    let project_root = state.project_root.read().await.clone();
    session
        .execute(crate::workspace_project_root_code(&project_root)?, |_| {
            Ok(())
        })
        .await
        .context("binding auxiliary R runtime to the active project")?;
    Ok(Arc::new(RwLock::new(session)))
}

#[tauri::command]
pub(crate) async fn runtime_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeRegistrySnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    prepare(&app, &state)
        .await
        .map(|transition| transition.snapshot)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn runtime_create(
    request: RuntimeCreateRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeRegistrySnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let _operation = state.runtime_registry.operation_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let (starting, entry) = state
        .runtime_registry
        .begin_create(&request)
        .map_err(display_error)?;
    emit_transition(&app, &starting);
    match launch_auxiliary(&state, &entry).await {
        Ok(session) => {
            let ready = state
                .runtime_registry
                .complete_start(&entry.descriptor.runtime_instance_id, session)
                .map_err(display_error)?;
            emit_transition(&app, &ready);
            Ok(ready.snapshot)
        }
        Err(error) => {
            let failed = state
                .runtime_registry
                .finish_status(
                    &entry.descriptor.runtime_instance_id,
                    RuntimeStatusV1::Failed,
                    "runtime_start_failed",
                )
                .map_err(display_error)?;
            emit_transition(&app, &failed);
            Err(display_error(error))
        }
    }
}

fn rebind_restarted_runtime(
    app: &AppHandle,
    state: &AppState,
    snapshot: &RuntimeRegistrySnapshotV1,
    runtime_instance_id: &RuntimeInstanceId,
) -> Result<()> {
    let descriptor = snapshot
        .instances
        .iter()
        .find(|runtime| &runtime.runtime_instance_id == runtime_instance_id)
        .context("restarted Runtime disappeared before Surface rebinding")?;
    let transition = state
        .surface_runtime
        .rebind_runtime_generation(descriptor)?;
    crate::surface_runtime::emit_transition(app, &transition);
    Ok(())
}

#[tauri::command]
pub(crate) async fn runtime_attach(
    request: RuntimeAttachmentRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<rho_ui_contract::SurfaceRuntimeSnapshotV1, String> {
    request.validate().map_err(display_error)?;
    let _project_transition = state.project_transition_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let descriptor = {
        let inner = state.runtime_registry.inner();
        RuntimeRegistryState::target(&inner, &request.runtime, true)
            .map_err(display_error)?
            .descriptor
    };
    if !descriptor
        .attach_capabilities
        .iter()
        .any(|capability| capability.as_str() == "console.attach")
    {
        return Err("Runtime does not support Console attachment".to_string());
    }
    let reconciled = crate::surface_runtime::reconcile_for_state(&state)
        .await
        .map_err(display_error)?;
    crate::surface_runtime::emit_transition(&app, &reconciled);
    let studio =
        crate::studio_runtime::reconcile_with_surface_snapshot(&state, &reconciled.snapshot)
            .map_err(display_error)?;
    crate::studio_runtime::emit_transition(&app, &studio);
    let surface_checkpoint = state.surface_runtime.checkpoint();
    let studio_checkpoint = state.studio_runtime.checkpoint();
    let transition = state
        .surface_runtime
        .update(UpdateSurfaceRequestV1 {
            target: request.surface,
            mutation: SurfaceInstanceMutationV1::BindRuntime {
                binding: Some(descriptor.binding()),
            },
        })
        .map_err(display_error)?;
    let studio = crate::surface_runtime::persist_surface_state(
        &app,
        &state,
        surface_checkpoint,
        studio_checkpoint,
        &transition,
    )?;
    crate::surface_runtime::emit_transition(&app, &transition);
    crate::studio_runtime::emit_transition(&app, &studio);
    Ok(transition.snapshot)
}

#[tauri::command]
pub(crate) async fn runtime_detach(
    request: RuntimeDetachRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<rho_ui_contract::SurfaceRuntimeSnapshotV1, String> {
    request.surface.validate().map_err(display_error)?;
    let _project_transition = state.project_transition_gate.lock().await;
    let reconciled = crate::surface_runtime::reconcile_for_state(&state)
        .await
        .map_err(display_error)?;
    crate::surface_runtime::emit_transition(&app, &reconciled);
    let studio =
        crate::studio_runtime::reconcile_with_surface_snapshot(&state, &reconciled.snapshot)
            .map_err(display_error)?;
    crate::studio_runtime::emit_transition(&app, &studio);
    let surface_checkpoint = state.surface_runtime.checkpoint();
    let studio_checkpoint = state.studio_runtime.checkpoint();
    let transition = state
        .surface_runtime
        .update(UpdateSurfaceRequestV1 {
            target: request.surface,
            mutation: SurfaceInstanceMutationV1::BindRuntime { binding: None },
        })
        .map_err(display_error)?;
    let studio = crate::surface_runtime::persist_surface_state(
        &app,
        &state,
        surface_checkpoint,
        studio_checkpoint,
        &transition,
    )?;
    crate::surface_runtime::emit_transition(&app, &transition);
    crate::studio_runtime::emit_transition(&app, &studio);
    Ok(transition.snapshot)
}

async fn target_and_mark(
    app: &AppHandle,
    state: &AppState,
    request: &RuntimeInstanceRequestV1,
    status: RuntimeStatusV1,
    reason: &'static str,
) -> Result<RuntimeEntry> {
    let (transition, entry) = state
        .runtime_registry
        .set_status(request, status, reason, true)?;
    emit_transition(app, &transition);
    Ok(entry)
}

#[tauri::command]
pub(crate) async fn runtime_interrupt(
    request: RuntimeInstanceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeRegistrySnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let entry = target_and_mark(
        &app,
        &state,
        &request,
        RuntimeStatusV1::Interrupting,
        "runtime_interrupting",
    )
    .await
    .map_err(display_error)?;
    entry.cancellation_requested.store(true, Ordering::Release);
    let result = if entry.descriptor.primary_scientific_runtime {
        let session = crate::active_session(&state).await.map_err(display_error)?;
        session.interrupt().await
    } else {
        let session = entry
            .session
            .context("auxiliary Runtime session is unavailable")
            .map_err(display_error)?;
        session.read().await.interrupt().await
    };
    let status = if result.is_ok() {
        RuntimeStatusV1::Ready
    } else {
        RuntimeStatusV1::Failed
    };
    let transition = state
        .runtime_registry
        .finish_status(
            &request.runtime_instance_id,
            status,
            if result.is_ok() {
                "runtime_interrupt_requested"
            } else {
                "runtime_interrupt_failed"
            },
        )
        .map_err(display_error)?;
    emit_transition(&app, &transition);
    result.map_err(display_error)?;
    Ok(transition.snapshot)
}

#[tauri::command]
pub(crate) async fn runtime_restart(
    request: RuntimeInstanceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeRegistrySnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let _operation = state.runtime_registry.operation_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let entry = target_and_mark(
        &app,
        &state,
        &request,
        RuntimeStatusV1::Restarting,
        "runtime_restarting",
    )
    .await
    .map_err(display_error)?;
    entry.cancellation_requested.store(true, Ordering::Release);
    if entry.descriptor.primary_scientific_runtime {
        if let Ok(session) = crate::active_session(&state).await {
            let _ = session.interrupt().await;
        }
        return match crate::restart_workspace_locked(&state).await {
            Ok(_) => {
                let ready = prepare(&app, &state).await.map_err(display_error)?;
                rebind_restarted_runtime(
                    &app,
                    &state,
                    &ready.snapshot,
                    &request.runtime_instance_id,
                )
                .map_err(display_error)?;
                Ok(ready.snapshot)
            }
            Err(error) => {
                let failed = state
                    .runtime_registry
                    .finish_status(
                        &request.runtime_instance_id,
                        RuntimeStatusV1::Failed,
                        "runtime_restart_failed",
                    )
                    .map_err(display_error)?;
                emit_transition(&app, &failed);
                Err(error)
            }
        };
    }
    if let Some(old) = entry.session.as_ref() {
        let _ = old.read().await.interrupt().await;
        shutdown_session(Arc::clone(old)).await;
    }
    match launch_auxiliary(&state, &entry).await {
        Ok(session) => {
            let transition = state
                .runtime_registry
                .install_restarted_session(&request.runtime_instance_id, session)
                .map_err(display_error)?;
            emit_transition(&app, &transition);
            rebind_restarted_runtime(
                &app,
                &state,
                &transition.snapshot,
                &request.runtime_instance_id,
            )
            .map_err(display_error)?;
            Ok(transition.snapshot)
        }
        Err(error) => {
            let failed = state
                .runtime_registry
                .finish_status(
                    &request.runtime_instance_id,
                    RuntimeStatusV1::Failed,
                    "runtime_restart_failed",
                )
                .map_err(display_error)?;
            emit_transition(&app, &failed);
            Err(display_error(error))
        }
    }
}

#[tauri::command]
pub(crate) async fn runtime_stop(
    request: RuntimeInstanceRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeRegistrySnapshotV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let _operation = state.runtime_registry.operation_gate.lock().await;
    prepare(&app, &state).await.map_err(display_error)?;
    let (transition, entry) = state
        .runtime_registry
        .remove(&request)
        .map_err(display_error)?;
    entry.cancellation_requested.store(true, Ordering::Release);
    emit_transition(&app, &transition);
    if let Some(session) = entry.session {
        let _ = session.read().await.interrupt().await;
        shutdown_session(session).await;
    }
    Ok(transition.snapshot)
}

fn output_event(
    sequence: u64,
    request: &RuntimeExecuteRequestV1,
    kind: &str,
    payload: Value,
) -> Result<RuntimeOutputEventV1> {
    let event = RuntimeOutputEventV1 {
        sequence,
        runtime_instance_id: request.runtime.runtime_instance_id.clone(),
        console_instance_id: request.console_instance_id.clone(),
        kind: kind.to_string(),
        payload,
    };
    event.validate()?;
    Ok(event)
}

fn kernel_output(
    event: CorrelatedKernelEvent,
    request: &RuntimeExecuteRequestV1,
    output: &mut Vec<RuntimeOutputEventV1>,
) -> Result<()> {
    ensure!(
        output.len() < rho_ui_contract::MAX_RUNTIME_OUTPUT_EVENTS,
        "Runtime output event budget exceeded"
    );
    output.push(output_event(
        u64::try_from(output.len())? + 1,
        request,
        "kernel_event",
        serde_json::to_value(event)?,
    )?);
    Ok(())
}

#[tauri::command]
pub(crate) async fn runtime_execute(
    request: RuntimeExecuteRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeExecutionResultV1, String> {
    request.validate().map_err(display_error)?;
    let (admitted, _execution_lease) = {
        let _project_transition = state.project_transition_gate.lock().await;
        prepare(&app, &state).await.map_err(display_error)?;
        let admitted = {
            let inner = state.runtime_registry.inner();
            RuntimeRegistryState::target(&inner, &request.runtime, true).map_err(display_error)?
        };
        let surfaces = crate::surface_runtime::reconcile_for_state(&state)
            .await
            .map_err(display_error)?;
        let console = surfaces
            .snapshot
            .catalog
            .instances
            .iter()
            .find(|instance| instance.instance_id == request.console_instance_id)
            .context("Console Surface instance was not found")
            .map_err(display_error)?;
        if console.surface_id.as_str() != "rho.console"
            || console.surface_revision != request.expected_console_revision
        {
            return Err("Console Surface request is stale or targets another Surface".to_string());
        }
        let binding = console
            .runtime_binding
            .as_ref()
            .context("Console Surface is not attached to a runtime")
            .map_err(display_error)?;
        if binding.runtime_instance_id != admitted.descriptor.runtime_instance_id
            || binding.activation_generation != admitted.descriptor.activation_generation
        {
            return Err("Console Surface is attached to another Runtime generation".to_string());
        }
        (admitted, state.runtime_registry.begin_execution())
    };
    let _queue = admitted.execution_gate.lock().await;
    let running = {
        let _project_transition = state.project_transition_gate.lock().await;
        {
            let inner = state.runtime_registry.inner();
            RuntimeRegistryState::target(&inner, &request.runtime, false).map_err(display_error)?;
        }
        admitted
            .cancellation_requested
            .store(false, Ordering::Release);
        let (busy, running) = state
            .runtime_registry
            .set_status(
                &request.runtime,
                RuntimeStatusV1::Busy,
                "runtime_busy",
                false,
            )
            .map_err(display_error)?;
        emit_transition(&app, &busy);
        running
    };
    let execution_id = format!("runtime-execution:{}", Uuid::new_v4().simple());
    let execution = if running.descriptor.primary_scientific_runtime {
        crate::execute_workspace_console(request.code.clone(), &state)
            .await
            .and_then(|payload| {
                Ok(vec![output_event(
                    1,
                    &request,
                    "workspace_result",
                    payload,
                )?])
            })
    } else {
        let session = running
            .session
            .context("auxiliary Runtime session is unavailable");
        match session {
            Ok(session) => {
                let mut output = Vec::new();
                session
                    .read()
                    .await
                    .execute(request.code.clone(), |event| {
                        kernel_output(event, &request, &mut output)
                    })
                    .await
                    .map(|_| output)
            }
            Err(error) => Err(error),
        }
    };
    let cancelled = running.cancellation_requested.load(Ordering::Acquire);
    let succeeded = execution.is_ok() && !cancelled;
    let (finished, descriptor) = {
        let _project_transition = state.project_transition_gate.lock().await;
        state
            .runtime_registry
            .finish_execution(
                &request.runtime.runtime_instance_id,
                request.runtime.activation_generation,
                if succeeded || cancelled {
                    RuntimeStatusV1::Ready
                } else {
                    RuntimeStatusV1::Failed
                },
                if succeeded {
                    "runtime_ready"
                } else if cancelled {
                    "runtime_execution_cancelled"
                } else {
                    "runtime_execution_failed"
                },
            )
            .map_err(display_error)?
    };
    emit_transition(&app, &finished);
    let mut events = match execution {
        Ok(events) => events,
        Err(error) if cancelled => vec![
            output_event(
                1,
                &request,
                "cancelled",
                Value::String(error.to_string().chars().take(2_048).collect()),
            )
            .map_err(display_error)?,
        ],
        Err(error) => return Err(display_error(error)),
    };
    if cancelled
        && !events.iter().any(|event| event.kind == "cancelled")
        && events.len() < rho_ui_contract::MAX_RUNTIME_OUTPUT_EVENTS
    {
        events.push(
            output_event(
                u64::try_from(events.len()).map_err(display_error)? + 1,
                &request,
                "cancelled",
                Value::String("Execution interrupted by the Runtime owner.".to_string()),
            )
            .map_err(display_error)?,
        );
    }
    let state_revision_after = descriptor
        .as_ref()
        .map_or(running.descriptor.state_revision, |value| {
            value.state_revision
        });
    let result = RuntimeExecutionResultV1 {
        execution_id,
        runtime_instance_id: request.runtime.runtime_instance_id.clone(),
        runtime_activation_generation: request.runtime.activation_generation,
        console_instance_id: request.console_instance_id,
        state_revision_after,
        status: if cancelled { "cancelled" } else { "completed" }.to_string(),
        events,
    };
    result.validate().map_err(display_error)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_ui_contract::{
        ApplicationComponentId, ProjectId, RuntimeCapabilityId, RuntimeKindId,
        RuntimeProviderDefinitionV1,
    };

    fn provider(generation: u64) -> RuntimeProviderRegistrationV1 {
        RuntimeProviderRegistrationV1 {
            definition: RuntimeProviderDefinitionV1 {
                runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
                runtime_kind: RuntimeKindId::new("r").unwrap(),
                display_label: "Ark R".to_string(),
                create_supported: true,
                max_instances: 8,
                attach_capabilities: vec![RuntimeCapabilityId::new("console.attach").unwrap()],
                application_component_id: ApplicationComponentId::new("rho.runtime.ark-r").unwrap(),
            },
            activation_generation: generation,
        }
    }

    fn workspace(kernel: &str, revision: u64) -> rho_protocol::WorkspaceIdentity {
        rho_protocol::WorkspaceIdentity {
            workspace_id: "workspace:test".to_string(),
            kernel_instance_id: kernel.to_string(),
            execution_seq: 0,
            state_revision: revision,
            project_revision: 3,
        }
    }

    #[test]
    fn workspace_generation_tracks_kernel_restart_and_projects_are_isolated() {
        let registry = RuntimeRegistryState::default();
        let project_a = ProjectId::new("project:a").unwrap();
        let first = registry
            .reconcile(
                project_a.clone(),
                3,
                vec![provider(1)],
                Some(&workspace("kernel:a", 2)),
            )
            .unwrap()
            .0
            .snapshot;
        let stable = registry
            .reconcile(
                project_a.clone(),
                3,
                vec![provider(1)],
                Some(&workspace("kernel:a", 2)),
            )
            .unwrap()
            .0
            .snapshot;
        assert_eq!(first, stable);
        let restarted = registry
            .reconcile(
                project_a,
                3,
                vec![provider(1)],
                Some(&workspace("kernel:b", 3)),
            )
            .unwrap()
            .0
            .snapshot;
        assert!(
            restarted.instances[0].activation_generation > first.instances[0].activation_generation
        );
        let project_b = registry
            .reconcile(
                ProjectId::new("project:b").unwrap(),
                1,
                vec![provider(1)],
                None,
            )
            .unwrap()
            .0
            .snapshot;
        assert!(project_b.instances.is_empty());
    }

    #[test]
    fn create_admission_is_stale_safe_and_bounded_before_process_launch() {
        let registry = RuntimeRegistryState::default();
        let project = ProjectId::new("project:a").unwrap();
        let initial = registry
            .reconcile(project.clone(), 3, vec![provider(1)], None)
            .unwrap()
            .0
            .snapshot;
        let request = RuntimeCreateRequestV1 {
            project_id: project,
            runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
            expected_project_revision: 3,
            expected_snapshot_revision: initial.snapshot_revision,
            display_label: Some("Analysis R".to_string()),
        };
        let (starting, _) = registry.begin_create(&request).unwrap();
        assert_eq!(
            starting.snapshot.instances[0].status,
            RuntimeStatusV1::Starting
        );
        assert!(registry.begin_create(&request).is_err());
        assert_eq!(
            snapshot_from_inner(&registry.inner()).unwrap(),
            starting.snapshot
        );
    }

    #[test]
    fn auxiliary_budget_and_retirement_preserve_the_primary_runtime() {
        let registry = RuntimeRegistryState::default();
        let project = ProjectId::new("project:a").unwrap();
        let mut snapshot = registry
            .reconcile(
                project.clone(),
                3,
                vec![provider(1)],
                Some(&workspace("kernel:a", 2)),
            )
            .unwrap()
            .0
            .snapshot;
        for index in 0..rho_ui_contract::MAX_AUXILIARY_RUNTIMES {
            snapshot = registry
                .begin_create(&RuntimeCreateRequestV1 {
                    project_id: project.clone(),
                    runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
                    expected_project_revision: 3,
                    expected_snapshot_revision: snapshot.snapshot_revision,
                    display_label: Some(format!("Auxiliary R {}", index + 1)),
                })
                .unwrap()
                .0
                .snapshot;
        }
        assert_eq!(
            snapshot
                .instances
                .iter()
                .filter(|runtime| !runtime.primary_scientific_runtime)
                .count(),
            usize::from(rho_ui_contract::MAX_AUXILIARY_RUNTIMES)
        );
        assert!(
            registry
                .begin_create(&RuntimeCreateRequestV1 {
                    project_id: project,
                    runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
                    expected_project_revision: 3,
                    expected_snapshot_revision: snapshot.snapshot_revision,
                    display_label: None,
                })
                .is_err()
        );
        let (retired, sessions) = registry.retire_auxiliary().unwrap();
        assert!(sessions.is_empty());
        let retired = retired.unwrap().snapshot;
        assert_eq!(retired.instances.len(), 1);
        assert!(retired.instances[0].primary_scientific_runtime);
    }

    #[test]
    fn stopping_an_auxiliary_runtime_is_generation_and_revision_safe() {
        let registry = RuntimeRegistryState::default();
        let project = ProjectId::new("project:a").unwrap();
        let initial = registry
            .reconcile(project.clone(), 3, vec![provider(1)], None)
            .unwrap()
            .0
            .snapshot;
        let starting = registry
            .begin_create(&RuntimeCreateRequestV1 {
                project_id: project.clone(),
                runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
                expected_project_revision: 3,
                expected_snapshot_revision: initial.snapshot_revision,
                display_label: None,
            })
            .unwrap()
            .0
            .snapshot;
        let auxiliary = starting.instances[0].clone();
        let exact = RuntimeInstanceRequestV1 {
            project_id: project,
            runtime_provider_id: auxiliary.runtime_provider_id.clone(),
            runtime_instance_id: auxiliary.runtime_instance_id.clone(),
            activation_generation: auxiliary.activation_generation,
            expected_project_revision: 3,
            expected_state_revision: auxiliary.state_revision,
        };
        let mut stale = exact.clone();
        stale.expected_state_revision += 1;
        assert!(registry.remove(&stale).is_err());
        assert_eq!(snapshot_from_inner(&registry.inner()).unwrap(), starting);
        let (stopped, _) = registry.remove(&exact).unwrap();
        assert!(stopped.snapshot.instances.is_empty());
    }

    #[test]
    fn queued_execution_leases_block_project_transition_until_every_waiter_exits() {
        let registry = RuntimeRegistryState::default();
        assert_eq!(registry.active_execution_count(), 0);
        let first = registry.begin_execution();
        let second = registry.begin_execution();
        assert_eq!(registry.active_execution_count(), 2);
        drop(first);
        assert_eq!(registry.active_execution_count(), 1);
        drop(second);
        assert_eq!(registry.active_execution_count(), 0);
    }

    #[test]
    fn failed_execution_and_late_old_generation_completion_cannot_corrupt_recovery() {
        let registry = RuntimeRegistryState::default();
        let project = ProjectId::new("project:a").unwrap();
        let initial = registry
            .reconcile(project.clone(), 3, vec![provider(1)], None)
            .unwrap()
            .0
            .snapshot;
        let starting = registry
            .begin_create(&RuntimeCreateRequestV1 {
                project_id: project,
                runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
                expected_project_revision: 3,
                expected_snapshot_revision: initial.snapshot_revision,
                display_label: None,
            })
            .unwrap()
            .0
            .snapshot;
        let runtime_id = starting.instances[0].runtime_instance_id.clone();
        let failed = registry
            .finish_execution(&runtime_id, 1, RuntimeStatusV1::Failed, "injected_crash")
            .unwrap()
            .0
            .snapshot;
        assert_eq!(failed.instances[0].status, RuntimeStatusV1::Failed);
        {
            let mut inner = registry.inner();
            let entry = inner.instances.get_mut(&runtime_id).unwrap();
            entry.descriptor.activation_generation = 2;
            entry.descriptor.state_revision += 1;
            entry.descriptor.status = RuntimeStatusV1::Ready;
            RuntimeRegistryState::bump(&mut inner).unwrap();
        }
        let recovered = snapshot_from_inner(&registry.inner()).unwrap();
        let (late, descriptor) = registry
            .finish_execution(
                &runtime_id,
                1,
                RuntimeStatusV1::Failed,
                "late_old_generation",
            )
            .unwrap();
        assert!(!late.changed);
        assert!(descriptor.is_none());
        assert_eq!(late.snapshot, recovered);
        assert_eq!(late.snapshot.instances[0].status, RuntimeStatusV1::Ready);
    }
}
