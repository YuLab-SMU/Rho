use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use anyhow::{Context, Result, anyhow, ensure};
use rho_kernel::{ArkLaunchConfig, ArkSession, CorrelatedKernelEvent, KernelEvent};
use rho_server::coordinator::redact_agent_context_text;
use rho_store::{
    RuntimeExecution, RuntimeExecutionDeleteResult, RuntimeExecutionDraft, RuntimeExecutionFinish,
    RuntimeExecutionMutationOutcome, RuntimeOutputChunk, RuntimeOutputDraft, RuntimeOutputPage,
    RuntimeOutputPayload, RuntimeOutputPolicy, RuntimeOutputPolicyUpdate, RuntimeOutputPruneResult,
    RuntimeOutputSearchResult,
};
use rho_ui_contract::{
    RSR_CONTRACT_MAJOR, RUNTIME_REGISTRY_SNAPSHOT_CONTRACT, RuntimeAttachmentRequestV1,
    RuntimeCreateRequestV1, RuntimeDescriptorV1, RuntimeDetachRequestV1, RuntimeExecuteRequestV1,
    RuntimeInstanceId, RuntimeInstanceRequestV1, RuntimePersistenceClassV1, RuntimeProviderId,
    RuntimeProviderRegistrationV1, RuntimeRegistrySnapshotV1, RuntimeStatusV1,
    SurfaceInstanceMutationV1, UpdateSurfaceRequestV1, Validate, next_revision,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, ipc::Channel};
use tokio::sync::{Mutex, RwLock, broadcast};
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
    active_executions: Arc<AtomicUsize>,
    output_notifications: StdMutex<BTreeMap<(String, String), broadcast::Sender<()>>>,
    recovered_output_projects: StdMutex<BTreeSet<String>>,
}

struct RuntimeExecutionLease {
    active_executions: Arc<AtomicUsize>,
}

impl Drop for RuntimeExecutionLease {
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

const DEFAULT_RUNTIME_OUTPUT_PAGE_SIZE: usize = 100;
const DEFAULT_RUNTIME_OUTPUT_PAGE_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RuntimeExecutionStartResponse {
    execution: RuntimeExecution,
    committed_through: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct RuntimeExecutionIdentityRequest {
    execution_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct RuntimeExecutionListRequest {
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    limit: Option<usize>,
    before_started_at: Option<String>,
    before_execution_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct RuntimeOutputSearchRequest {
    query: String,
    console_instance_id: Option<String>,
    started_after: Option<String>,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct RuntimeOutputPolicyView {
    policy: RuntimeOutputPolicy,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    project_output_bytes: i64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    project_execution_count: i64,
    warning_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct RuntimeOutputPageRequest {
    execution_id: String,
    #[serde(default)]
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    after_sequence: i64,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    before_sequence: Option<i64>,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    page_size: Option<usize>,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    byte_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct RuntimeOutputFollowRequest {
    execution_id: String,
    #[serde(default)]
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    after_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct RuntimeOutputReferenceRequest {
    pub(crate) execution_id: String,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    pub(crate) start_sequence: Option<i64>,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    pub(crate) end_sequence: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub(crate) struct RuntimeOutputReference {
    pub(crate) project_id: String,
    pub(crate) execution_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) start_sequence: i64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) end_sequence: i64,
    pub(crate) range_sha256: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) payload_bytes: i64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) chunk_count: i64,
    #[specta(type = rho_store::RuntimeExecutionStatus)]
    pub(crate) status: String,
    #[specta(type = rho_store::RuntimeOutputState)]
    pub(crate) output_state: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedRuntimeOutputContext {
    pub(crate) reference: RuntimeOutputReference,
    pub(crate) content: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum RuntimeOutputFollowFrame {
    Admitted {
        project_id: String,
        execution_id: String,
        #[specta(type = rho_store::RuntimeOutputIpcNumber)]
        committed_through: i64,
        execution: RuntimeExecution,
    },
    Chunks {
        project_id: String,
        execution_id: String,
        #[specta(type = rho_store::RuntimeOutputIpcNumber)]
        first_sequence: i64,
        #[specta(type = rho_store::RuntimeOutputIpcNumber)]
        last_sequence: i64,
        chunks: Vec<RuntimeOutputChunk>,
    },
    Gap {
        project_id: String,
        execution_id: String,
        #[specta(type = rho_store::RuntimeOutputIpcNumber)]
        expected_sequence: i64,
        #[specta(type = rho_store::RuntimeOutputIpcNumber)]
        committed_through: i64,
    },
    Checkpoint {
        project_id: String,
        execution_id: String,
        #[specta(type = rho_store::RuntimeOutputIpcNumber)]
        committed_through: i64,
    },
    Terminal {
        project_id: String,
        execution_id: String,
        #[specta(type = rho_store::RuntimeOutputIpcNumber)]
        committed_through: i64,
        execution: RuntimeExecution,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectedOutput {
    kind: &'static str,
    text: String,
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

    fn begin_execution(&self) -> RuntimeExecutionLease {
        self.active_executions.fetch_add(1, Ordering::AcqRel);
        RuntimeExecutionLease {
            active_executions: Arc::clone(&self.active_executions),
        }
    }

    pub(crate) fn active_execution_count(&self) -> usize {
        self.active_executions.load(Ordering::Acquire)
    }

    fn output_sender(&self, project_root: &str, execution_id: &str) -> broadcast::Sender<()> {
        let key = (project_root.to_string(), execution_id.to_string());
        let mut notifications = self
            .output_notifications
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        notifications
            .entry(key)
            .or_insert_with(|| broadcast::channel(32).0)
            .clone()
    }

    fn notify_output(&self, project_root: &str, execution_id: &str) {
        let _ = self.output_sender(project_root, execution_id).send(());
    }

    fn forget_output_sender(&self, project_root: &str, execution_id: &str) {
        let mut notifications = self
            .output_notifications
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        notifications.remove(&(project_root.to_string(), execution_id.to_string()));
    }

    fn claim_output_recovery(&self, project_root: &str) -> bool {
        self.recovered_output_projects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(project_root.to_string())
    }

    fn release_output_recovery(&self, project_root: &str) {
        self.recovered_output_projects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(project_root);
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

async fn admit_runtime_execution(
    request: &RuntimeExecuteRequestV1,
    app: &AppHandle,
    state: &AppState,
) -> Result<(RuntimeEntry, RuntimeExecutionLease)> {
    request.validate()?;
    let _project_transition = state.project_transition_gate.lock().await;
    prepare(app, state).await?;
    crate::validate_runtime_execute_source(request, state).await?;
    let admitted = {
        let inner = state.runtime_registry.inner();
        RuntimeRegistryState::target(&inner, &request.runtime, true)?
    };
    let surfaces = crate::surface_runtime::reconcile_for_state(state).await?;
    let console = surfaces
        .snapshot
        .catalog
        .instances
        .iter()
        .find(|instance| instance.instance_id == request.console_instance_id)
        .context("Console Surface instance was not found")?;
    ensure!(
        console.surface_id.as_str() == "rho.console"
            && console.surface_revision == request.expected_console_revision,
        "Console Surface request is stale or targets another Surface"
    );
    let binding = console
        .runtime_binding
        .as_ref()
        .context("Console Surface is not attached to a runtime")?;
    ensure!(
        binding.runtime_instance_id == admitted.descriptor.runtime_instance_id
            && binding.activation_generation == admitted.descriptor.activation_generation,
        "Console Surface is attached to another Runtime generation"
    );
    Ok((admitted, state.runtime_registry.begin_execution()))
}

async fn active_project_scope(state: &AppState) -> Result<(String, String)> {
    let project_root = state
        .project_root
        .read()
        .await
        .to_string_lossy()
        .replace('\\', "/");
    let project_id = {
        let inner = state.runtime_registry.inner();
        inner
            .project
            .as_ref()
            .context("Runtime Registry has no project context")?
            .project_id
            .to_string()
    };
    Ok((project_root, project_id))
}

fn reconcile_persisted_output_once(state: &AppState, project_root: &str) -> Result<()> {
    if !state.runtime_registry.claim_output_recovery(project_root) {
        return Ok(());
    }
    let result = crate::read_store(state)?
        .reconcile_interrupted_runtime_executions(project_root)
        .context("reconciling interrupted Runtime executions");
    if result.is_err() {
        state.runtime_registry.release_output_recovery(project_root);
    }
    result.map(|_| ())
}

fn append_utf8_prefix(target: &mut String, value: &str, limit: usize) {
    if target.len() >= limit {
        return;
    }
    let remaining = limit - target.len();
    let mut end = remaining.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    target.push_str(&value[..end]);
}

fn keep_utf8_suffix(value: &mut String, limit: usize) {
    if value.len() <= limit {
        return;
    }
    let mut start = value.len() - limit;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value.drain(..start);
}

fn context_chunk_text(chunk: &RuntimeOutputChunk) -> String {
    match chunk.storage_kind.as_str() {
        "inline_text" => chunk.text_payload.clone().unwrap_or_default(),
        "inline_json" => chunk.json_payload.clone().unwrap_or_default(),
        "record_ref" => format!(
            "{} reference: {}",
            chunk.reference_kind.as_deref().unwrap_or("output"),
            chunk.reference_id.as_deref().unwrap_or("unavailable")
        ),
        "tombstone" => {
            "[This output payload is unavailable or was omitted by retention policy.]".to_string()
        }
        _ => "[Unsupported output record.]".to_string(),
    }
}

pub(crate) async fn resolve_runtime_output_context(
    state: &AppState,
    request: &RuntimeOutputReferenceRequest,
    expected_project_id: Option<&str>,
    expected_digest: Option<&str>,
) -> Result<ResolvedRuntimeOutputContext> {
    let (project_root, project_id) = active_project_scope(state).await?;
    if let Some(expected_project_id) = expected_project_id {
        ensure!(
            expected_project_id == project_id,
            "Runtime output reference belongs to another project"
        );
    }
    reconcile_persisted_output_once(state, &project_root)?;
    let store = crate::read_store(state)?;
    let execution = store
        .get_runtime_execution(&project_root, &request.execution_id)?
        .context("Runtime execution is unavailable in the active project")?;
    ensure!(
        execution.output_state != "pruned",
        "The selected Runtime output was pruned and cannot be attached to Agent"
    );
    let start_sequence = request.start_sequence.unwrap_or(1);
    let end_sequence = request.end_sequence.unwrap_or(execution.last_sequence);
    ensure!(
        start_sequence > 0 && end_sequence >= start_sequence,
        "Runtime output reference range is invalid"
    );
    ensure!(
        end_sequence <= execution.last_sequence,
        "Runtime output reference exceeds the committed transcript"
    );

    let mut cursor = start_sequence - 1;
    let mut expected_sequence = start_sequence;
    let mut hasher = Sha256::new();
    let mut head = String::new();
    let mut tail = String::new();
    let mut important = String::new();
    let mut payload_bytes = 0i64;
    let mut chunk_count = 0i64;
    while cursor < end_sequence {
        let page = store.runtime_output_page(
            &project_root,
            &request.execution_id,
            cursor,
            200,
            1024 * 1024,
        )?;
        let selected = page
            .chunks
            .into_iter()
            .filter(|chunk| chunk.sequence <= end_sequence)
            .collect::<Vec<_>>();
        ensure!(
            !selected.is_empty(),
            "Runtime output reference has a missing durable range"
        );
        for chunk in selected {
            ensure!(
                chunk.sequence == expected_sequence,
                "Runtime output reference is missing sequence {expected_sequence}"
            );
            let canonical = serde_json::to_vec(&(
                chunk.sequence,
                &chunk.source_kind,
                &chunk.presentation_kind,
                &chunk.storage_kind,
                &chunk.payload_sha256,
                &chunk.reference_kind,
                &chunk.reference_id,
            ))?;
            hasher.update((canonical.len() as u64).to_be_bytes());
            hasher.update(canonical);
            let rendered = format!(
                "[{} · {}]\n{}\n",
                chunk.sequence,
                chunk.presentation_kind,
                context_chunk_text(&chunk)
            );
            append_utf8_prefix(&mut head, &rendered, 24 * 1024);
            tail.push_str(&rendered);
            keep_utf8_suffix(&mut tail, 24 * 1024);
            if matches!(chunk.presentation_kind.as_str(), "warning" | "error") {
                append_utf8_prefix(&mut important, &rendered, 24 * 1024);
            }
            payload_bytes = payload_bytes.saturating_add(chunk.payload_bytes);
            chunk_count += 1;
            cursor = chunk.sequence;
            expected_sequence += 1;
        }
    }
    ensure!(
        cursor == end_sequence,
        "Runtime output reference range is incomplete"
    );
    let range_sha256 = format!("{:x}", hasher.finalize());
    if let Some(expected_digest) = expected_digest {
        ensure!(
            expected_digest == range_sha256,
            "Runtime output changed after it was selected; review Agent context again"
        );
    }
    let content = if payload_bytes <= 24 * 1024 {
        head
    } else {
        format!(
            "Head of selected output:\n{head}\nImportant warnings and errors:\n{important}\nTail of selected output:\n{tail}\n[Projected {chunk_count} chunks from sequences {start_sequence}-{end_sequence}; exact range digest {range_sha256}.]"
        )
    };
    let content = redact_agent_context_text(&content);
    Ok(ResolvedRuntimeOutputContext {
        reference: RuntimeOutputReference {
            project_id,
            execution_id: request.execution_id.clone(),
            start_sequence,
            end_sequence,
            range_sha256,
            payload_bytes,
            chunk_count,
            status: execution.status,
            output_state: execution.output_state,
        },
        content,
    })
}

fn normalize_console_text(value: &Value) -> Option<String> {
    let direct = value.as_str().or_else(|| {
        value
            .as_object()
            .and_then(|record| record.get("message").or_else(|| record.get("text")))
            .and_then(Value::as_str)
    })?;
    let mut text = direct.replace("\r\n", "\n").replace('\r', "\n");
    if text.starts_with('"')
        && text.ends_with('"')
        && let Ok(decoded) = serde_json::from_str::<String>(&text)
    {
        text = decoded;
    }
    let text = text.trim_matches('\n').to_string();
    (!text.trim().is_empty()).then_some(text)
}

fn push_projected(output: &mut Vec<ProjectedOutput>, kind: &'static str, text: Option<String>) {
    let Some(text) = text else {
        return;
    };
    if output
        .last()
        .is_some_and(|previous| previous.kind == kind && previous.text == text)
    {
        return;
    }
    output.push(ProjectedOutput { kind, text });
}

fn workspace_projected_output(payload: &Value) -> Vec<ProjectedOutput> {
    let Some(execution) = payload.get("execution").and_then(Value::as_object) else {
        return vec![ProjectedOutput {
            kind: "status",
            text: "Runtime returned an unrecognized output.".to_string(),
        }];
    };
    let mut projected = Vec::new();
    let stdout = execution.get("stdout").and_then(normalize_console_text);
    push_projected(&mut projected, "stdout", stdout.clone());
    let value = execution.get("value").and_then(normalize_console_text);
    if value != stdout {
        push_projected(&mut projected, "value", value);
    }
    for (field, kind) in [("messages", "message"), ("warnings", "warning")] {
        let Some(value) = execution.get(field) else {
            continue;
        };
        if let Some(items) = value.as_array() {
            for item in items {
                push_projected(&mut projected, kind, normalize_console_text(item));
            }
        } else {
            push_projected(&mut projected, kind, normalize_console_text(value));
        }
    }
    if let Some(error) = execution.get("error")
        && let Some(mut text) = normalize_console_text(error)
    {
        if let Some(call) = error
            .as_object()
            .and_then(|record| record.get("call"))
            .and_then(normalize_console_text)
        {
            text.push_str("\nIn: ");
            text.push_str(&call);
        }
        push_projected(&mut projected, "error", Some(text));
    }
    push_projected(
        &mut projected,
        "message",
        execution.get("help").and_then(normalize_console_text),
    );
    if projected.is_empty() {
        projected.push(ProjectedOutput {
            kind: if execution.get("ok") == Some(&Value::Bool(false)) {
                "error"
            } else {
                "status"
            },
            text: if execution.get("ok") == Some(&Value::Bool(false)) {
                "Execution failed."
            } else if execution.get("ok") == Some(&Value::Bool(true)) {
                "Completed"
            } else {
                "Runtime returned an unrecognized output."
            }
            .to_string(),
        });
    }
    projected
}

fn kernel_projected_output(event: &CorrelatedKernelEvent) -> Vec<ProjectedOutput> {
    let projected = match &event.event {
        KernelEvent::Stream { name, text } => Some((
            if name == "stderr" {
                "warning"
            } else {
                "stdout"
            },
            text.clone(),
        )),
        KernelEvent::DisplayData { data } => data
            .get("text/plain")
            .or_else(|| data.get("text/markdown"))
            .and_then(normalize_console_text)
            .map(|text| ("value", text))
            .or_else(|| Some(("status", "Rich output produced.".to_string()))),
        KernelEvent::Error { traceback } => Some(("error", traceback.clone())),
        KernelEvent::Banner { text } => Some(("message", text.clone())),
        KernelEvent::InputRequest { prompt, .. } => Some((
            "warning",
            if prompt.trim().is_empty() {
                "The Runtime requested interactive input.".to_string()
            } else {
                prompt.clone()
            },
        )),
        KernelEvent::InterruptRequested => Some(("status", "Interrupt requested".to_string())),
        KernelEvent::KernelExited => {
            Some(("error", "The Runtime stopped unexpectedly.".to_string()))
        }
        KernelEvent::Idle
        | KernelEvent::Busy
        | KernelEvent::ExecuteInput { .. }
        | KernelEvent::ExecuteReply
        | KernelEvent::Other => None,
    };
    projected
        .and_then(|(kind, text)| {
            let text = normalize_console_text(&Value::String(text))?;
            Some(vec![ProjectedOutput { kind, text }])
        })
        .unwrap_or_default()
}

fn output_drafts(
    producer_sequence: i64,
    source_kind: &str,
    projected: Vec<ProjectedOutput>,
) -> Vec<RuntimeOutputDraft> {
    projected
        .into_iter()
        .enumerate()
        .map(|(slot, block)| RuntimeOutputDraft {
            producer_sequence,
            projection_slot: i64::try_from(slot).expect("projection slot must fit i64"),
            source_kind: source_kind.to_string(),
            presentation_kind: block.kind.to_string(),
            media_type: Some("text/plain; charset=utf-8".to_string()),
            payload: RuntimeOutputPayload::InlineText { text: block.text },
        })
        .collect()
}

fn workspace_output_drafts(producer_sequence: i64, payload: &Value) -> Vec<RuntimeOutputDraft> {
    let mut drafts = output_drafts(
        producer_sequence,
        "workspace_result",
        workspace_projected_output(payload),
    );
    let mut append_references = |items: Option<&Vec<Value>>, reference_kind: &str, id_key: &str| {
        for item in items.into_iter().flatten() {
            let Some(reference_id) = item.get(id_key).and_then(Value::as_str) else {
                continue;
            };
            let Some(payload_bytes) = item.get("payload_bytes").and_then(Value::as_u64) else {
                continue;
            };
            let Some(payload_sha256) = item.get("payload_sha256").and_then(Value::as_str) else {
                continue;
            };
            let Ok(payload_bytes) = i64::try_from(payload_bytes) else {
                continue;
            };
            drafts.push(RuntimeOutputDraft {
                producer_sequence,
                projection_slot: i64::try_from(drafts.len()).unwrap_or(i64::MAX),
                source_kind: "workspace_result".to_string(),
                presentation_kind: "display_ref".to_string(),
                media_type: item
                    .get("media_type")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                payload: RuntimeOutputPayload::RecordRef {
                    reference_kind: reference_kind.to_string(),
                    reference_id: reference_id.to_string(),
                    payload_bytes,
                    payload_sha256: payload_sha256.to_string(),
                },
            });
        }
    };
    append_references(
        payload.get("plot_references").and_then(Value::as_array),
        "plot",
        "plot_id",
    );
    append_references(
        payload.get("artifact_references").and_then(Value::as_array),
        "artifact",
        "artifact_id",
    );
    drafts
}

fn runtime_output_capture_limit(
    store: &rho_store::Store,
    project_root: &str,
) -> Result<Option<i64>> {
    Ok(store
        .get_runtime_output_policy(project_root)?
        .max_runtime_output_bytes_per_execution)
}

fn append_projected_output(
    state: &AppState,
    store: &mut rho_store::Store,
    project_root: &str,
    execution_id: &str,
    drafts: &[RuntimeOutputDraft],
) -> Result<()> {
    if drafts.is_empty() {
        return Ok(());
    }
    let capture_limit = runtime_output_capture_limit(store, project_root)?;
    let result = store.append_runtime_output(project_root, execution_id, drafts, capture_limit)?;
    if !result.committed.is_empty() {
        state
            .runtime_registry
            .notify_output(project_root, execution_id);
    }
    Ok(())
}

async fn finish_runtime_descriptor(
    app: &AppHandle,
    state: &AppState,
    request: &RuntimeExecuteRequestV1,
    succeeded: bool,
    cancelled: bool,
) {
    let transition = {
        let _project_transition = state.project_transition_gate.lock().await;
        state.runtime_registry.finish_execution(
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
    };
    match transition {
        Ok((transition, _)) => emit_transition(app, &transition),
        Err(error) => crate::write_startup_event(serde_json::json!({
            "kind": "runtime_execution_descriptor_finish_failed",
            "execution_runtime": request.runtime.runtime_instance_id.to_string(),
            "message": error.to_string(),
        })),
    }
}

async fn run_supervised_execution(
    app: AppHandle,
    request: RuntimeExecuteRequestV1,
    admitted: RuntimeEntry,
    execution_lease: RuntimeExecutionLease,
    execution_id: String,
    project_root: String,
) {
    let state = app.state::<AppState>();
    let _execution_lease = execution_lease;
    let _queue = admitted.execution_gate.lock().await;
    let mut store = match crate::read_store(&state) {
        Ok(store) => store,
        Err(error) => {
            finish_runtime_descriptor(&app, &state, &request, false, false).await;
            crate::write_startup_event(serde_json::json!({
                "kind": "runtime_execution_store_unavailable",
                "execution_id": execution_id,
                "message": error.to_string(),
            }));
            return;
        }
    };
    if !matches!(
        store.mark_runtime_execution_running(&project_root, &execution_id),
        Ok(RuntimeExecutionMutationOutcome::Applied | RuntimeExecutionMutationOutcome::Unchanged)
    ) {
        let _ = store.finish_runtime_execution(
            &project_root,
            &execution_id,
            &RuntimeExecutionFinish {
                status: "failed".to_string(),
                terminal_reason: Some("runtime_output_admission_lost".to_string()),
                output_state: "unavailable".to_string(),
            },
        );
        state
            .runtime_registry
            .notify_output(&project_root, &execution_id);
        finish_runtime_descriptor(&app, &state, &request, false, false).await;
        return;
    }

    let running = {
        let _project_transition = state.project_transition_gate.lock().await;
        let still_current = {
            let inner = state.runtime_registry.inner();
            RuntimeRegistryState::target(&inner, &request.runtime, false)
        };
        match still_current.and_then(|_| {
            admitted
                .cancellation_requested
                .store(false, Ordering::Release);
            state
                .runtime_registry
                .set_status(
                    &request.runtime,
                    RuntimeStatusV1::Busy,
                    "runtime_busy",
                    false,
                )
                .map(|(transition, running)| {
                    emit_transition(&app, &transition);
                    running
                })
        }) {
            Ok(running) => running,
            Err(error) => {
                let _ = store.finish_runtime_execution(
                    &project_root,
                    &execution_id,
                    &RuntimeExecutionFinish {
                        status: "failed".to_string(),
                        terminal_reason: Some(error.to_string()),
                        output_state: "unavailable".to_string(),
                    },
                );
                state
                    .runtime_registry
                    .notify_output(&project_root, &execution_id);
                if let Ok((transition, _)) = state.runtime_registry.finish_execution(
                    &request.runtime.runtime_instance_id,
                    request.runtime.activation_generation,
                    RuntimeStatusV1::Failed,
                    "runtime_execution_admission_lost",
                ) {
                    emit_transition(&app, &transition);
                }
                return;
            }
        }
    };

    let mut output_failure: Option<String> = None;
    let execution = if running.descriptor.primary_scientific_runtime {
        let result = crate::execute_workspace_runtime(&request, &state, &execution_id).await;
        if result.is_ok()
            && let Err(error) =
                store.link_runtime_execution_run(&project_root, &execution_id, &execution_id)
        {
            output_failure = Some(error.to_string());
        }
        match &result {
            Ok(payload) => {
                let drafts = workspace_output_drafts(1, payload);
                if let Err(error) = append_projected_output(
                    &state,
                    &mut store,
                    &project_root,
                    &execution_id,
                    &drafts,
                ) {
                    output_failure.get_or_insert_with(|| error.to_string());
                }
            }
            Err(error) => {
                let drafts = output_drafts(
                    1,
                    "runtime_error",
                    vec![ProjectedOutput {
                        kind: "error",
                        text: error.to_string(),
                    }],
                );
                if let Err(append_error) = append_projected_output(
                    &state,
                    &mut store,
                    &project_root,
                    &execution_id,
                    &drafts,
                ) {
                    output_failure.get_or_insert_with(|| append_error.to_string());
                }
            }
        }
        result.map(|_| ())
    } else {
        let session = running
            .session
            .clone()
            .context("auxiliary Runtime session is unavailable");
        match session {
            Ok(session) => {
                let mut producer_sequence = 0_i64;
                session
                    .read()
                    .await
                    .execute(request.code.clone(), |event| {
                        producer_sequence = producer_sequence.saturating_add(1);
                        if output_failure.is_none() {
                            let drafts = output_drafts(
                                producer_sequence,
                                "kernel_event",
                                kernel_projected_output(&event),
                            );
                            if let Err(error) = append_projected_output(
                                &state,
                                &mut store,
                                &project_root,
                                &execution_id,
                                &drafts,
                            ) {
                                output_failure = Some(error.to_string());
                            }
                        }
                        Ok(())
                    })
                    .await
            }
            Err(error) => Err(error),
        }
    };

    let cancelled = running.cancellation_requested.load(Ordering::Acquire);
    let succeeded = execution.is_ok() && !cancelled;
    if cancelled && output_failure.is_none() {
        let producer_sequence = store
            .get_runtime_execution(&project_root, &execution_id)
            .ok()
            .flatten()
            .map_or(1, |record| record.last_sequence.saturating_add(1));
        let drafts = output_drafts(
            producer_sequence,
            "cancelled",
            vec![ProjectedOutput {
                kind: "status",
                text: "Execution interrupted".to_string(),
            }],
        );
        if let Err(error) =
            append_projected_output(&state, &mut store, &project_root, &execution_id, &drafts)
        {
            output_failure = Some(error.to_string());
        }
    }

    finish_runtime_descriptor(&app, &state, &request, succeeded, cancelled).await;
    let current_output = store
        .get_runtime_execution(&project_root, &execution_id)
        .ok()
        .flatten();
    let output_state = if output_failure.is_some() {
        if current_output
            .as_ref()
            .is_some_and(|record| record.last_sequence > 0)
        {
            "partial"
        } else {
            "unavailable"
        }
    } else if current_output
        .as_ref()
        .is_some_and(|record| record.output_state == "partial")
    {
        "partial"
    } else {
        "complete"
    };
    let terminal_reason = if cancelled {
        Some("interrupted_by_owner".to_string())
    } else if let Some(error) = output_failure {
        Some(format!("runtime_output_incomplete: {error}"))
    } else {
        execution.as_ref().err().map(ToString::to_string)
    };
    let _ = store.finish_runtime_execution(
        &project_root,
        &execution_id,
        &RuntimeExecutionFinish {
            status: if cancelled {
                "interrupted"
            } else if succeeded {
                "completed"
            } else {
                "failed"
            }
            .to_string(),
            terminal_reason,
            output_state: output_state.to_string(),
        },
    );
    state
        .runtime_registry
        .notify_output(&project_root, &execution_id);
}

#[tauri::command]
pub(crate) async fn runtime_execution_start(
    request: RuntimeExecuteRequestV1,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeExecutionStartResponse, String> {
    let (admitted, execution_lease) = admit_runtime_execution(&request, &app, &state)
        .await
        .map_err(display_error)?;
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    reconcile_persisted_output_once(&state, &project_root).map_err(display_error)?;
    let execution_id = format!("runtime-execution:{}", Uuid::new_v4().simple());
    let mut store = crate::read_store(&state).map_err(display_error)?;
    let execution = store
        .create_runtime_execution(&RuntimeExecutionDraft {
            execution_id: execution_id.clone(),
            project_root: project_root.clone(),
            run_id: None,
            runtime_provider_id: request.runtime.runtime_provider_id.to_string(),
            runtime_instance_id: request.runtime.runtime_instance_id.to_string(),
            runtime_activation_generation: i64::try_from(request.runtime.activation_generation)
                .map_err(display_error)?,
            console_instance_id: request.console_instance_id.to_string(),
            submitted_code: request.code.clone(),
            workspace_id: crate::active_workspace_id(&state).await,
            source_path: request
                .source_context
                .as_ref()
                .map(|context| context.source_path.clone()),
            execution_mode: request
                .source_context
                .as_ref()
                .map(|context| context.execution_mode.clone()),
            document_version: request
                .source_context
                .as_ref()
                .and_then(|context| context.document_version)
                .map(i64::try_from)
                .transpose()
                .map_err(display_error)?,
        })
        .map_err(display_error)?;
    state
        .runtime_registry
        .notify_output(&project_root, &execution_id);
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_supervised_execution(
            task_app,
            request,
            admitted,
            execution_lease,
            execution_id,
            project_root,
        )
        .await;
    });
    Ok(RuntimeExecutionStartResponse {
        execution,
        committed_through: 0,
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_execution_get(
    request: RuntimeExecutionIdentityRequest,
    state: State<'_, AppState>,
) -> Result<RuntimeExecution, String> {
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    reconcile_persisted_output_once(&state, &project_root).map_err(display_error)?;
    crate::read_store(&state)
        .map_err(display_error)?
        .get_runtime_execution(&project_root, &request.execution_id)
        .map_err(display_error)?
        .context("Runtime execution is unavailable in the active project")
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_execution_list(
    request: RuntimeExecutionListRequest,
    state: State<'_, AppState>,
) -> Result<Vec<RuntimeExecution>, String> {
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    reconcile_persisted_output_once(&state, &project_root).map_err(display_error)?;
    let before = match (
        request.before_started_at.as_deref(),
        request.before_execution_id.as_deref(),
    ) {
        (Some(started_at), Some(execution_id)) => Some((started_at, execution_id)),
        (None, None) => None,
        _ => {
            return Err(
                "Runtime execution cursor requires both timestamp and execution ID.".to_string(),
            );
        }
    };
    crate::read_store(&state)
        .map_err(display_error)?
        .list_runtime_executions_before(&project_root, request.limit, before)
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_output_search(
    request: RuntimeOutputSearchRequest,
    state: State<'_, AppState>,
) -> Result<RuntimeOutputSearchResult, String> {
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    reconcile_persisted_output_once(&state, &project_root).map_err(display_error)?;
    crate::read_store(&state)
        .map_err(display_error)?
        .search_runtime_output(
            &project_root,
            &request.query,
            request.console_instance_id.as_deref(),
            request.started_after.as_deref(),
            request.limit.unwrap_or(100),
        )
        .map_err(display_error)
}

fn runtime_output_policy_view(
    store: &rho_store::Store,
    project_root: &str,
) -> Result<RuntimeOutputPolicyView> {
    let policy = store.get_runtime_output_policy(project_root)?;
    let summary = store.project_retention_summary(project_root, None)?;
    let project_output_bytes = summary
        .project
        .runtime_inline_output_bytes
        .saturating_add(summary.project.runtime_referenced_artifact_bytes);
    let project_execution_count = summary.project.runtime_execution_count;
    let warning_active = policy
        .runtime_output_project_warning_bytes
        .is_some_and(|limit| project_output_bytes >= limit)
        || policy
            .max_runtime_execution_rows
            .is_some_and(|limit| project_execution_count >= limit);
    Ok(RuntimeOutputPolicyView {
        policy,
        project_output_bytes,
        project_execution_count,
        warning_active,
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_output_policy_get(
    state: State<'_, AppState>,
) -> Result<RuntimeOutputPolicyView, String> {
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    runtime_output_policy_view(
        &crate::read_store(&state).map_err(display_error)?,
        &project_root,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_output_policy_update(
    request: RuntimeOutputPolicyUpdate,
    state: State<'_, AppState>,
) -> Result<RuntimeOutputPolicyView, String> {
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    let mut store = crate::read_store(&state).map_err(display_error)?;
    store
        .update_runtime_output_policy(&project_root, &request)
        .map_err(display_error)?;
    runtime_output_policy_view(&store, &project_root).map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_output_page(
    request: RuntimeOutputPageRequest,
    state: State<'_, AppState>,
) -> Result<RuntimeOutputPage, String> {
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    reconcile_persisted_output_once(&state, &project_root).map_err(display_error)?;
    let store = crate::read_store(&state).map_err(display_error)?;
    let page_size = request
        .page_size
        .unwrap_or(DEFAULT_RUNTIME_OUTPUT_PAGE_SIZE);
    let byte_limit = request
        .byte_limit
        .unwrap_or(DEFAULT_RUNTIME_OUTPUT_PAGE_BYTES);
    if let Some(before_sequence) = request.before_sequence {
        if request.after_sequence != 0 {
            return Err(
                "Runtime output page request cannot combine forward and reverse cursors."
                    .to_string(),
            );
        }
        store
            .runtime_output_page_before(
                &project_root,
                &request.execution_id,
                before_sequence,
                page_size,
                byte_limit,
            )
            .map_err(display_error)
    } else {
        store
            .runtime_output_page(
                &project_root,
                &request.execution_id,
                request.after_sequence,
                page_size,
                byte_limit,
            )
            .map_err(display_error)
    }
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_output_reference(
    request: RuntimeOutputReferenceRequest,
    state: State<'_, AppState>,
) -> Result<RuntimeOutputReference, String> {
    resolve_runtime_output_context(&state, &request, None, None)
        .await
        .map(|resolved| resolved.reference)
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_output_prune(
    request: RuntimeExecutionIdentityRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeOutputPruneResult, String> {
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    let result = crate::read_store(&state)
        .map_err(display_error)?
        .prune_runtime_output_payloads(&project_root, &request.execution_id)
        .map_err(display_error)?;
    app.emit(RUNTIME_REGISTRY_CHANGED_EVENT, "runtime_output_pruned")
        .map_err(display_error)?;
    Ok(result)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_execution_delete(
    request: RuntimeExecutionIdentityRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeExecutionDeleteResult, String> {
    let (project_root, _) = active_project_scope(&state).await.map_err(display_error)?;
    let result = crate::read_store(&state)
        .map_err(display_error)?
        .delete_runtime_execution_record(&project_root, &request.execution_id)
        .map_err(display_error)?;
    app.emit(RUNTIME_REGISTRY_CHANGED_EVENT, "runtime_execution_deleted")
        .map_err(display_error)?;
    Ok(result)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn runtime_output_follow(
    request: RuntimeOutputFollowRequest,
    channel: Channel<RuntimeOutputFollowFrame>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if request.after_sequence < 0 {
        return Err("Runtime output cursor cannot be negative".to_string());
    }
    let (project_root, project_id) = active_project_scope(&state).await.map_err(display_error)?;
    let sender = state
        .runtime_registry
        .output_sender(&project_root, &request.execution_id);
    let mut notifications = sender.subscribe();
    let mut cursor = request.after_sequence;
    let admitted = crate::read_store(&state)
        .map_err(display_error)?
        .get_runtime_execution(&project_root, &request.execution_id)
        .map_err(display_error)?
        .context("Runtime execution is unavailable in the active project")
        .map_err(display_error)?;
    channel
        .send(RuntimeOutputFollowFrame::Admitted {
            project_id: project_id.clone(),
            execution_id: request.execution_id.clone(),
            committed_through: admitted.last_sequence,
            execution: admitted,
        })
        .map_err(display_error)?;
    loop {
        let page = crate::read_store(&state)
            .map_err(display_error)?
            .runtime_output_page(
                &project_root,
                &request.execution_id,
                cursor,
                DEFAULT_RUNTIME_OUTPUT_PAGE_SIZE,
                DEFAULT_RUNTIME_OUTPUT_PAGE_BYTES,
            )
            .map_err(display_error)?;
        if let (Some(first), Some(last)) = (page.chunks.first(), page.chunks.last()) {
            if first.sequence > cursor + 1 {
                channel
                    .send(RuntimeOutputFollowFrame::Gap {
                        project_id: project_id.clone(),
                        execution_id: request.execution_id.clone(),
                        expected_sequence: cursor + 1,
                        committed_through: page.next_sequence,
                    })
                    .map_err(display_error)?;
            }
            cursor = last.sequence;
            channel
                .send(RuntimeOutputFollowFrame::Chunks {
                    project_id: project_id.clone(),
                    execution_id: request.execution_id.clone(),
                    first_sequence: first.sequence,
                    last_sequence: last.sequence,
                    chunks: page.chunks,
                })
                .map_err(display_error)?;
            continue;
        }
        let execution = crate::read_store(&state)
            .map_err(display_error)?
            .get_runtime_execution(&project_root, &request.execution_id)
            .map_err(display_error)?
            .context("Runtime execution is unavailable in the active project")
            .map_err(display_error)?;
        if matches!(
            execution.status.as_str(),
            "completed" | "failed" | "interrupted"
        ) {
            channel
                .send(RuntimeOutputFollowFrame::Terminal {
                    project_id,
                    execution_id: request.execution_id.clone(),
                    committed_through: execution.last_sequence,
                    execution,
                })
                .map_err(display_error)?;
            state
                .runtime_registry
                .forget_output_sender(&project_root, &request.execution_id);
            return Ok(());
        }
        channel
            .send(RuntimeOutputFollowFrame::Checkpoint {
                project_id: project_id.clone(),
                execution_id: request.execution_id.clone(),
                committed_through: cursor,
            })
            .map_err(display_error)?;
        match notifications.recv().await {
            Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {}
            Err(broadcast::error::RecvError::Closed) => {
                notifications = state
                    .runtime_registry
                    .output_sender(&project_root, &request.execution_id)
                    .subscribe();
            }
        }
    }
}

#[cfg(test)]
#[path = "runtime_registry/runtime_output_contract_tests.rs"]
mod runtime_output_contract_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use rho_store::RuntimeOutputPolicyUpdate;
    use rho_ui_contract::{
        ApplicationComponentId, ProjectId, RuntimeCapabilityId, RuntimeKindId,
        RuntimeProviderDefinitionV1,
    };
    use tempfile::TempDir;

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

    #[test]
    fn workspace_projector_keeps_human_output_and_drops_bridge_envelope_noise() {
        let blocks = workspace_projected_output(&serde_json::json!({
            "execution_id": "internal-id",
            "execution": {
                "ok": false,
                "stdout": "first\r\nsecond\n",
                "value": {"text": "42"},
                "messages": [{"message": "attached package"}],
                "warnings": ["deprecated"],
                "error": {"message": "object not found", "call": "print(x)"},
                "events": [{"type": "busy"}],
                "bridge_command": "large internal implementation detail"
            }
        }));
        assert_eq!(
            blocks,
            vec![
                ProjectedOutput {
                    kind: "stdout",
                    text: "first\nsecond".to_string(),
                },
                ProjectedOutput {
                    kind: "value",
                    text: "42".to_string(),
                },
                ProjectedOutput {
                    kind: "message",
                    text: "attached package".to_string(),
                },
                ProjectedOutput {
                    kind: "warning",
                    text: "deprecated".to_string(),
                },
                ProjectedOutput {
                    kind: "error",
                    text: "object not found\nIn: print(x)".to_string(),
                },
            ]
        );
        assert!(
            blocks
                .iter()
                .all(|block| !block.text.contains("bridge_command"))
        );
    }

    #[test]
    fn workspace_output_journal_uses_typed_plot_and_artifact_references() {
        let payload = serde_json::json!({
            "execution": {"stdout": "done", "ok": true},
            "plot_references": [{
                "plot_id": "plot_run_1_1",
                "media_type": "image/png",
                "payload_bytes": 4096,
                "payload_sha256": "a".repeat(64)
            }],
            "artifact_references": [{
                "artifact_id": "artifact_run_1_file_1",
                "media_type": "text/csv",
                "payload_bytes": 8192,
                "payload_sha256": "b".repeat(64)
            }]
        });
        let drafts = workspace_output_drafts(7, &payload);
        assert!(matches!(
            drafts[1].payload,
            RuntimeOutputPayload::RecordRef {
                ref reference_kind,
                ref reference_id,
                payload_bytes: 4096,
                ..
            } if reference_kind == "plot" && reference_id == "plot_run_1_1"
        ));
        assert!(matches!(
            drafts[2].payload,
            RuntimeOutputPayload::RecordRef {
                ref reference_kind,
                ref reference_id,
                payload_bytes: 8192,
                ..
            } if reference_kind == "artifact" && reference_id == "artifact_run_1_file_1"
        ));
    }

    #[test]
    fn runtime_capture_reads_the_revisioned_project_policy() {
        let directory = TempDir::new().unwrap();
        let mut store = rho_store::Store::open(directory.path().join("rho.sqlite")).unwrap();
        assert_eq!(
            runtime_output_capture_limit(&store, "D:/project").unwrap(),
            Some(128 * 1024 * 1024)
        );
        store
            .update_runtime_output_policy(
                "D:/project",
                &RuntimeOutputPolicyUpdate {
                    expected_revision: 0,
                    max_runtime_output_bytes_per_execution: None,
                    runtime_output_project_warning_bytes: Some(1024),
                    max_runtime_execution_rows: Some(10),
                    auto_prune_enabled: false,
                },
            )
            .unwrap();
        assert_eq!(
            runtime_output_capture_limit(&store, "D:/project").unwrap(),
            None
        );
    }

    #[test]
    fn kernel_projector_ignores_protocol_chatter_without_truncating_streams() {
        let long = "x".repeat(70 * 1024);
        let stream = kernel_projected_output(&CorrelatedKernelEvent {
            parent_id: Some("parent".to_string()),
            event: KernelEvent::Stream {
                name: "stdout".to_string(),
                text: long.clone(),
            },
        });
        assert_eq!(stream[0].kind, "stdout");
        assert_eq!(stream[0].text, long);
        assert!(
            kernel_projected_output(&CorrelatedKernelEvent {
                parent_id: None,
                event: KernelEvent::Busy,
            })
            .is_empty()
        );
    }

    #[test]
    fn output_notification_without_followers_never_changes_execution_lease_truth() {
        let registry = RuntimeRegistryState::default();
        let lease = registry.begin_execution();
        registry.notify_output("D:/project", "execution.one");
        assert_eq!(registry.active_execution_count(), 1);
        drop(lease);
        assert_eq!(registry.active_execution_count(), 0);
    }
}
