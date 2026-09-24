use crate::{PluginError, PluginRepository, backend, ensure, validate_archive};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_protocol::*;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}},
    time::Duration,
};
use tempfile::TempDir;
use uuid::Uuid;

pub const MAX_PLUGIN_INSTANCES: usize = 64;
pub const MAX_PENDING_PLUGIN_CALLS: usize = 128;
pub const MAX_BACKEND_LOG_BYTES: usize = 64 * 1024;

/// Filled by a validated Host port, never by a backend's own initialization data.
pub struct PluginActivation {
    pub revision: RevisionId,
    pub artifact: ArtifactId,
    pub target: String,
    pub project: ProjectId,
    /// Trusted Host project root, never taken from plugin configuration.
    pub project_root: Option<PathBuf>,
    pub principal: PrincipalId,
    pub alias: InstanceAlias,
    pub configuration: Value,
    pub grants: Vec<CapabilityRequirement>,
}

#[derive(Debug, Clone)]
pub struct BackendPolicy {
    pub initialize_timeout: Duration,
    pub write_timeout: Duration,
    pub release_timeout: Duration,
}
impl Default for BackendPolicy {
    fn default() -> Self {
        Self {
            initialize_timeout: Duration::from_secs(15),
            write_timeout: Duration::from_secs(5),
            release_timeout: Duration::from_secs(5),
        }
    }
}

/// A reverse call inherits this complete, fixed caller context. A Host service
/// must additionally resolve the capability and enforce native preconditions.
/// `query_only` prevents a query backend from delegating a scientific write.
#[derive(Debug, Clone)]
pub struct DelegatedPluginCall {
    pub request: RequestId,
    pub provider: InstanceRef,
    pub parent: PluginCall,
    pub grant: CapabilityRequirement,
    pub query_only: bool,
    pub arguments: Value,
}

#[async_trait]
pub trait PluginHostServices: Send + Sync {
    fn resources(&self) -> Option<Arc<crate::PluginResources>> { None }
    async fn call(&self, call: DelegatedPluginCall) -> Result<Value, String>;
}

pub struct NoPluginHostServices;
#[async_trait]
impl PluginHostServices for NoPluginHostServices {
    async fn call(&self, _call: DelegatedPluginCall) -> Result<Value, String> {
        Err("no delegated Host service is available".into())
    }
}

#[derive(Debug, Clone)]
pub struct BackendObservation {
    pub instance: PluginInstance,
    pub process_id: Option<u32>,
    pub retained_calls: usize,
    pub pending_messages: usize,
    pub stderr: String,
}

pub(crate) struct BackendState {
    pub record: PluginInstance,
    pub pid: Option<u32>,
    pub pins: usize,
    pub pending: usize,
    pub log: Vec<u8>,
}
pub(crate) type SharedBackendState = Arc<Mutex<BackendState>>;

struct Entry {
    published: AtomicBool,
    manifest: PluginManifest,
    state: SharedBackendState,
    process: OnceLock<backend::ProcessClient>,
}

/// The registry publishes every contribution of an instance in one lock only
/// after Ready. Several exact revisions may provide the same contract; resolve
/// refuses ambiguity. This owner never records or commits a scientific result.
pub struct PluginRuntime {
    repository: Arc<Mutex<PluginRepository>>,
    entries: Mutex<BTreeMap<PluginInstanceId, Arc<Entry>>>,
    policy: BackendPolicy,
    services: Arc<dyn PluginHostServices>,
    lifecycle: tokio::sync::watch::Sender<u64>,
}

impl PluginRuntime {
    pub fn new(
        repository: Arc<Mutex<PluginRepository>>,
        services: Arc<dyn PluginHostServices>,
        policy: BackendPolicy,
    ) -> Self {
        Self {
            repository,
            entries: Mutex::new(BTreeMap::new()),
            policy,
            services,
            lifecycle: tokio::sync::watch::channel(0).0,
        }
    }

    pub(crate) fn subscribe_lifecycle(&self) -> tokio::sync::watch::Receiver<u64> { self.lifecycle.subscribe() }

    pub async fn activate(
        &self,
        request: PluginActivation,
    ) -> Result<PluginInstance, PluginError> {
        self.activate_identified(request, PluginInstanceId::new(format!("plugin-{}", Uuid::new_v4().simple()))?, true).await
    }

    /// Host publication stages readiness before exposing any new invocation route.
    pub async fn activate_identified(&self, request: PluginActivation, identity: PluginInstanceId, publish: bool) -> Result<PluginInstance, PluginError> {
        let mut prepared = PreparedInstance::new(&self.repository, request, identity)?;
        prepared.lifecycle = Some(self.lifecycle.clone());
        let identity = prepared.record.identity.clone();
        // Failure before readiness has no published registrations. The prepared
        // lease keeps the revision while native code is being initialized.
        let manifest = prepared.manifest.clone();
        let state = Arc::new(Mutex::new(BackendState {
            record: prepared.record.clone(),
            pid: None,
            pins: 0,
            pending: 0,
            log: vec![],
        }));
        let entry = Arc::new(Entry {
            published: AtomicBool::new(publish),
            manifest,
            state: state.clone(),
            process: OnceLock::new(),
        });
        {
            let mut entries = self.entries.lock().unwrap();
            // Released processes remain in durable history, not in the live quota.
            entries.retain(|_, entry| {
                entry.state.lock().unwrap().record.state != InstanceState::Released
            });
            ensure(
                entries.len() < MAX_PLUGIN_INSTANCES,
                "plugin instance quota reached",
            )?;
            entries.insert(identity.instance.clone(), entry.clone());
        }
        struct ActivationGuard {
            state: SharedBackendState,
            repository: Arc<Mutex<PluginRepository>>,
        }
        impl Drop for ActivationGuard {
            fn drop(&mut self) {
                let mut state = self.state.lock().unwrap();
                if state.record.state == InstanceState::Preparing {
                    state.record.state = InstanceState::Failed;
                    state.record.diagnostic = Some(
                        "activation was interrupted before publication; cleanup is unconfirmed"
                            .into(),
                    );
                    let _ = self
                        .repository
                        .lock()
                        .unwrap()
                        .record_instance(&state.record);
                }
            }
        }
        let _activation_guard = ActivationGuard {
            state: state.clone(),
            repository: self.repository.clone(),
        };
        if prepared.manifest.backend.is_none() {
            // UI-only instances own the same durable identity and revision lease.
            // They never spawn a process merely to publish view contributions.
            prepared.retain_after_drop = true;
            let mut current = state.lock().unwrap();
            let mut record = current.record.clone();
            record.state = InstanceState::Active;
            self.repository.lock().unwrap().record_instance(&record)?;
            current.record = record.clone();
            return Ok(record);
        }
        let process = match backend::start(
            prepared,
            state.clone(),
            self.services.clone(),
            self.policy.clone(),
        )
        .await
        {
            Ok(process) => process,
            Err(error) => {
                let mut state = state.lock().unwrap();
                if state.record.state == InstanceState::Preparing {
                    state.record.state = InstanceState::Failed;
                }
                state
                    .record
                    .diagnostic
                    .get_or_insert_with(|| error.to_string());
                let _ = self
                    .repository
                    .lock()
                    .unwrap()
                    .record_instance(&state.record);
                return Err(error);
            }
        };
        let _ = entry.process.set(process);
        let publish = {
            let entries = self.entries.lock().unwrap();
            let compatible = entries.values().all(|other| {
                let state = other.state.lock().unwrap();
                !matches!(
                    state.record.state,
                    InstanceState::Active | InstanceState::Draining
                ) || compatible_contracts(&entry.manifest, &other.manifest)
            });
            if compatible {
                // The process can exit after Ready. Never resurrect an instance
                // whose reader has already observed failure during publication.
                let mut state = entry.state.lock().unwrap();
                if state.record.state == InstanceState::Preparing {
                    state.record.state = InstanceState::Active;
                    self.repository
                        .lock()
                        .unwrap()
                        .record_instance(&state.record)
                        .map(|()| state.record.clone())
                } else {
                    Err(PluginError::Unavailable(
                        "backend exited before publication".into(),
                    ))
                }
            } else {
                Err(PluginError::Invalid(
                    "capability version has a different registered contract".into(),
                ))
            }
        };
        if publish.is_err() {
            let _ = entry.process.get().unwrap().release().await;
        }
        publish
    }

    /// Bounded observations do not create processes, reconnect, or recover work.
    pub fn observe(&self) -> Vec<BackendObservation> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .map(|entry| {
                let state = entry.state.lock().unwrap();
                BackendObservation {
                    instance: state.record.clone(),
                    process_id: state.pid,
                    retained_calls: state.pins,
                    pending_messages: state.pending,
                    stderr: String::from_utf8_lossy(&state.log).into_owned(),
                }
            })
            .collect()
    }

    pub fn contributions(&self, project: &ProjectId) -> Vec<CapabilityContribution> {
        self.contributions_including(project, None)
    }
    pub(crate) fn contributions_including(&self, project: &ProjectId, pending: Option<&InstanceRef>) -> Vec<CapabilityContribution> {
        let mut capabilities = BTreeMap::new();
        for entry in self.entries.lock().unwrap().values() {
            let state = entry.state.lock().unwrap();
            if &state.record.project == project && matches!(state.record.state, InstanceState::Active | InstanceState::Draining)
                && (entry.published.load(Ordering::Acquire) || pending == Some(&state.record.identity)) {
                for contribution in &entry.manifest.capabilities {
                    // A draining owner must remain observable and able to answer
                    // existing native requests. New scientific work is withdrawn.
                    if state.record.state == InstanceState::Draining
                        && !matches!(contribution.kind, CapabilityKind::Query | CapabilityKind::Control) { continue; }
                    capabilities.entry(contribution.capability.clone()).or_insert_with(|| contribution.clone());
                }
            }
        }
        capabilities.into_values().collect()
    }

    pub(crate) fn publish_instance(&self, identity: &InstanceRef) -> Result<(), PluginError> {
        let entries = self.entries.lock().unwrap();
        let entry = entries.get(&identity.instance).ok_or_else(|| PluginError::Missing(identity.instance.to_string()))?;
        let state = entry.state.lock().unwrap();
        ensure(state.record.identity == *identity && state.record.state == InstanceState::Active, "ready instance ended before Host publication")?;
        entry.published.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) fn hold_operation(&self, identity: &InstanceRef, operation: &str) -> Result<(), PluginError> {
        self.repository.lock().unwrap().retain("operation", &format!("{}:{operation}",identity.instance), &identity.revision)
    }
    pub(crate) fn release_operation(&self, identity: &InstanceRef, operation: &str) -> Result<(), PluginError> {
        self.repository.lock().unwrap().release_reference("operation", &format!("{}:{operation}",identity.instance), &identity.revision)
    }

    /// Pin before Operation admission; retain this lease through the journal's
    /// terminal commit (including a pending commit). Scene/view changes cannot
    /// redirect or release it. Only the existing Operation owner executes writes.
    pub fn resolve(
        &self,
        capability: &CapabilityKey,
        project: &ProjectId,
        principal: &PrincipalId,
        selected: Option<&InstanceRef>,
    ) -> Result<ProviderLease, PluginError> {
        let entries = self.entries.lock().unwrap();
        let mut candidates = entries.values().filter(|entry| {
            let state = entry.state.lock().unwrap();
            (state.record.state == InstanceState::Active
                || (state.record.state == InstanceState::Draining && selected.is_some()
                    && entry.manifest.capabilities.iter().any(|cap| &cap.capability == capability
                        && matches!(cap.kind, CapabilityKind::Query | CapabilityKind::Control))))
                && entry.published.load(Ordering::Acquire)
                && &state.record.project == project
                && &state.record.principal == principal
                && selected.is_none_or(|id| id == &state.record.identity)
                && entry
                    .manifest
                    .capabilities
                    .iter()
                    .any(|cap| &cap.capability == capability)
        });
        let entry = candidates
            .next()
            .cloned()
            .ok_or_else(|| PluginError::Unavailable("no active provider in this scope".into()))?;
        ensure(
            candidates.next().is_none(),
            "capability has several providers; select an exact binding",
        )?;
        let contribution = entry
            .manifest
            .capabilities
            .iter()
            .find(|cap| &cap.capability == capability)
            .unwrap()
            .clone();
        let mut state = entry.state.lock().unwrap();
        ensure(
            state.record.state == InstanceState::Active
                || (state.record.state == InstanceState::Draining && selected.is_some()
                    && matches!(contribution.kind, CapabilityKind::Query | CapabilityKind::Control)),
            "provider stopped receiving new work",
        )?;
        state.pins += 1;
        let identity = state.record.identity.clone();
        drop(state);
        Ok(ProviderLease {
            entry,
            contribution,
            identity,
        })
    }

    /// Drain is visible immediately, even when an admitted operation still pins
    /// the instance. Retry release after its owner commits; never cancel it here.
    pub async fn release(&self, identity: &InstanceRef) -> Result<(), PluginError> {
        let entry = self
            .entries
            .lock()
            .unwrap()
            .get(&identity.instance)
            .cloned()
            .ok_or_else(|| PluginError::Missing(identity.instance.to_string()))?;
        {
            let mut state = entry.state.lock().unwrap();
            ensure(
                &state.record.identity == identity,
                "instance revision does not match",
            )?;
            if state.record.state == InstanceState::Released {
                return Ok(());
            }
            ensure(
                state.record.state == InstanceState::Active
                    || state.record.state == InstanceState::Draining,
                "instance requires explicit failure recovery; release is not confirmed",
            )?;
            state.record.state = InstanceState::Draining;
            self.repository
                .lock()
                .unwrap()
                .record_instance(&state.record)?;
            ensure(
                state.pins == 0 && state.pending == 0,
                "instance still owns accepted calls",
            )?;
            let view_prefix = format!("view:{}:", identity.instance);
            ensure(!self.repository.lock().unwrap().references(&identity.revision)?.iter().any(|reference| reference.starts_with(&view_prefix)),
                "instance still has open views; close those views before releasing it")?;
            let prefix = format!("operation:{}:", identity.instance);
            ensure(!self.repository.lock().unwrap().references(&identity.revision)?.iter().any(|reference| reference.starts_with(&prefix)),
                "instance has an operation awaiting authoritative completion")?;
        }
        if let Some(process) = entry.process.get() {
            process.release().await
        } else {
            ensure(entry.manifest.backend.is_none(), "backend release is unconfirmed")?;
            let mut state = entry.state.lock().unwrap();
            state.record.state = InstanceState::Released;
            self.repository.lock().unwrap().record_instance(&state.record)?;
            self.lifecycle.send_modify(|revision| *revision = revision.wrapping_add(1));
            Ok(())
        }
    }
}

pub struct ProviderLease {
    entry: Arc<Entry>,
    contribution: CapabilityContribution,
    identity: InstanceRef,
}
impl ProviderLease {
    pub fn binding(&self, target: Option<String>) -> ProviderBinding {
        ProviderBinding {
            capability: self.contribution.capability.clone(),
            provider: self.identity.clone(),
            project: self.entry.state.lock().unwrap().record.project.clone(),
            target,
        }
    }
    pub fn contribution(&self) -> &CapabilityContribution {
        &self.contribution
    }

    /// The Host has already admitted an invocation in Operation before calling
    /// here. Errors after dispatch are uncertain, and must not be replayed.
    pub async fn call(&self, call: PluginCall) -> Result<RpcBody, PluginError> {
        {
            let state = self.entry.state.lock().unwrap();
            ensure(
                matches!(
                    state.record.state,
                    InstanceState::Active | InstanceState::Draining
                ),
                "provider connection is unavailable",
            )?;
            ensure(
                call.binding.provider == self.identity
                    && call.binding.capability == self.contribution.capability
                    && call.binding.project == state.record.project
                    && call.principal == state.record.principal,
                "call does not match its fixed provider and caller",
            )?;
        }
        ensure(
            self.contribution.required_scopes.is_subset(&call.scopes),
            "call lacks required scopes",
        )?;
        validate_value(&self.contribution.input_schema, &call.arguments, "input")?;
        let kind = self.contribution.kind;
        let operation = matches!(kind, CapabilityKind::Operation | CapabilityKind::Runtime);
        ensure(
            operation == call.operation_id.is_some(),
            "queries and admitted operations must remain distinct",
        )?;
        preflight_control(
            &self.identity.instance,
            match kind {
                CapabilityKind::Query => RpcBody::Query(call.clone()),
                CapabilityKind::Control => RpcBody::Control(call.clone()),
                _ => RpcBody::Invoke(call.clone()),
            },
        )?;
        let reply = self.entry.process.get().unwrap().call(call, kind).await?;
        if let Err(error) = validate_reply(&self.contribution, &self.identity, &reply) {
            return Err(PluginError::InvalidResponse {message:error.to_string(),response:Box::new(reply)});
        }
        Ok(reply)
    }

    pub async fn cancel(&self, operation_id: &str) -> Result<bool, PluginError> {
        ensure(
            self.contribution.cancellation == CancellationSupport::Request,
            "provider does not support cancellation",
        )?;
        self.entry
            .process
            .get()
            .unwrap()
            .cancel(operation_id, &self.contribution.capability)
            .await
    }
}
impl Drop for ProviderLease {
    fn drop(&mut self) {
        self.entry.state.lock().unwrap().pins -= 1;
    }
}

fn compatible_contracts(a: &PluginManifest, b: &PluginManifest) -> bool {
    a.capabilities.iter().all(|cap| {
        b.capabilities.iter().all(|other| {
            if cap.capability != other.capability {
                return true;
            }
            let mut cap = cap.clone();
            let mut other = other.clone();
            cap.title.clear();
            cap.description.clear();
            other.title.clear();
            other.description.clear();
            cap == other
        })
    })
}

pub(crate) fn validate_value(
    schema: &Value,
    value: &Value,
    label: &str,
) -> Result<(), PluginError> {
    let validator =
        jsonschema::validator_for(schema).map_err(|e| PluginError::Invalid(e.to_string()))?;
    ensure(
        validator.is_valid(value),
        format!("plugin {label} violates its declared schema"),
    )
}

fn validate_reply(
    cap: &CapabilityContribution,
    identity: &InstanceRef,
    body: &RpcBody,
) -> Result<(), PluginError> {
    match body {
        RpcBody::QueryResult { data, source, .. } if cap.kind == CapabilityKind::Query => {
            validate_value(&cap.output_schema, data, "query result")?;
            if let Some(source) = source {
                ensure(
                    &source.owner == identity,
                    "query evidence belongs to another instance",
                )?;
            }
        }
        RpcBody::ControlResult { data } if cap.kind == CapabilityKind::Control => {
            validate_value(&cap.output_schema, data, "control result")?;
        }
        RpcBody::CommitPlan(plan) if matches!(cap.kind, CapabilityKind::Operation | CapabilityKind::Runtime) => {
            if let Some(output) = &plan.output {
                validate_value(&cap.output_schema, output, "operation output")?;
            }
            if let Some(recovery) = &plan.recovery {
                validate_value(&cap.recovery_schema, recovery, "recovery")?;
            }
            ensure(
                plan.facts.len() <= 256 && plan.evidence.len() <= 256,
                "commit plan exceeds reference limit",
            )?;
            ensure(
                plan.outcome != PluginOutcome::Succeeded
                    || (plan.output.is_some() && plan.error.is_none()),
                "invalid successful commit plan",
            )?;
            ensure(
                (plan.outcome == PluginOutcome::Cancelled) == plan.cancellation_confirmed,
                "cancellation has no matching native confirmation",
            )?;
            ensure(
                plan.outcome != PluginOutcome::Uncertain || plan.recovery.is_some(),
                "uncertain result must retain recovery information",
            )?;
            ensure(
                plan.evidence
                    .iter()
                    .all(|reference| &reference.owner == identity),
                "commit evidence belongs to another instance",
            )?;
            // Facts still require the Operation owner's namespace/schema and
            // resource-digest checks before the single scientific commit.
        }
        RpcBody::Error { recovery, .. } => {
            if let Some(recovery) = recovery {
                validate_value(&cap.recovery_schema, recovery, "error recovery")?;
            }
        }
        _ => {
            return Err(PluginError::Invalid(
                "backend response kind does not match the call".into(),
            ));
        }
    }
    Ok(())
}

fn preflight_control(instance: &PluginInstanceId, body: RpcBody) -> Result<(), PluginError> {
    // Reserve the maximum public identity lengths before touching a live pipe.
    // Bad user input must not fence an otherwise healthy backend connection.
    RpcFrame {
        protocol_version: PLUGIN_PROTOCOL_VERSION,
        connection: ConnectionId::new("x".repeat(128))?,
        instance: instance.clone(),
        sequence: u32::MAX,
        request: RequestId::new("x".repeat(128))?,
        body,
    }
    .encode()?;
    Ok(())
}

pub(crate) struct PreparedInstance {
    pub record: PluginInstance,
    pub manifest: PluginManifest,
    pub grants: Vec<CapabilityRequirement>,
    pub environment: Option<BackendEnvironment>,
    pub directory: TempDir,
    pub executable: Option<PathBuf>,
    pub repository: Arc<Mutex<PluginRepository>>,
    pub retain_after_drop: bool,
    lifecycle: Option<tokio::sync::watch::Sender<u64>>,
}
impl PreparedInstance {
    fn new(
        repository: &Arc<Mutex<PluginRepository>>,
        request: PluginActivation,
        identity: PluginInstanceId,
    ) -> Result<Self, PluginError> {
        let mut repo = repository.lock().unwrap();
        let archive = repo.export(&request.revision)?;
        validate_archive(&archive)?;
        let manifest = archive.revision.manifest.clone();
        let artifact = archive
            .artifacts
            .iter()
            .find(|a| a.id == request.artifact)
            .ok_or_else(|| PluginError::Missing(request.artifact.to_string()))?;
        ensure(
            artifact.target == request.target,
            "artifact target does not match this activation",
        )?;
        validate_value(
            &manifest.configuration_schema,
            &request.configuration,
            "configuration",
        )?;
        ensure(
            request.grants.len() == manifest.requires.len()
                && manifest.requires.iter().all(|required| {
                    request
                        .grants
                        .iter()
                        .filter(|granted| *granted == required)
                        .count()
                        == 1
                }),
            "activation grants do not match declared requirements",
        )?;
        for dependency in manifest.dependencies.values() {
            ensure(
                repo.revision(&dependency.revision)?.manifest.id == dependency.plugin,
                "dependency identity mismatch",
            )?;
        }
        let directory = tempfile::Builder::new()
            .prefix("rho-plugin-instance-")
            .tempdir()?;
        for (path, file) in &artifact.files {
            let destination = directory.path().join(path.as_str());
            fs::create_dir_all(destination.parent().unwrap())?;
            let bytes = STANDARD
                .decode(&archive.blobs[&file.digest])
                .map_err(|e| PluginError::Invalid(e.to_string()))?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)?;
            output.write_all(&bytes)?;
            output.sync_all()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                output.set_permissions(fs::Permissions::from_mode(if file.executable {
                    0o500
                } else {
                    0o400
                }))?;
            }
        }
        let executable = manifest.backend.as_ref().map(|backend| directory.path().join(backend.executable.as_str()));
        let record = PluginInstance {
            identity: InstanceRef {
                instance: identity,
                plugin: manifest.id.clone(),
                revision: request.revision,
                artifact: request.artifact,
            },
            project: request.project,
            principal: request.principal,
            alias: request.alias,
            configuration: request.configuration,
            state: InstanceState::Preparing,
            diagnostic: None,
        };
        let environment = request.project_root.as_ref().filter(|_| manifest.backend.is_some())
            .map(|project| prepare_environment(repo.root(), project, &record.identity.instance))
            .transpose()?;
        preflight_control(
            &record.identity.instance,
            RpcBody::Initialize {
                instance: record.clone(),
                grants: request.grants.clone(),
                environment: environment.clone(),
                resource_channel: Some(ResourceChannel {
                    version: RESOURCE_CHANNEL_VERSION,
                    socket: "x".repeat(104),
                    token: "x".repeat(64),
                }),
            },
        )?;
        repo.register_instance(&record)?;
        Ok(Self {
            record,
            manifest,
            grants: request.grants,
            environment,
            directory,
            executable,
            repository: repository.clone(),
            retain_after_drop: false,
            lifecycle: None,
        })
    }
    pub fn release_reference(&mut self) -> Result<(), PluginError> {
        let mut record = self.record.clone();
        record.state = InstanceState::Released;
        self.repository.lock().unwrap().record_instance(&record)?;
        self.record = record;
        self.retain_after_drop = false;
        Ok(())
    }
    pub fn persist_state(&self, state: &SharedBackendState) {
        if let Some(lifecycle)=&self.lifecycle { lifecycle.send_modify(|revision| *revision=revision.wrapping_add(1)); }
        let record = state.lock().unwrap().record.clone();
        if let Err(error) = self.repository.lock().unwrap().record_instance(&record) {
            state.lock().unwrap().record.diagnostic = Some(format!(
                "{}; lifecycle record could not be persisted: {error}",
                record.diagnostic.unwrap_or_default()
            ));
        }
    }
}

fn prepare_environment(root: &std::path::Path, project: &std::path::Path, instance: &PluginInstanceId) -> Result<BackendEnvironment, PluginError> {
    let project = project.canonicalize()?;
    ensure(project.is_dir(), "native project root must be a directory")?;
    let parent = root.join("instance-data-v1");
    match fs::create_dir(&parent) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(error) => return Err(error.into()),
    }
    let metadata = parent.symlink_metadata()?;
    ensure(metadata.is_dir() && !metadata.file_type().is_symlink() && parent.canonicalize()? == parent,
        "instance data parent must be a contained directory")?;
    // Never reuse an old instance's files, including after a failed activation.
    let data = parent.join(format!("instance-{instance}"));
    fs::create_dir(&data)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
    }
    Ok(BackendEnvironment {
        project_root: project.to_str().ok_or_else(|| PluginError::Invalid("project root must be UTF-8".into()))?.into(),
        data_root: data.to_str().ok_or_else(|| PluginError::Invalid("instance data root must be UTF-8".into()))?.into(),
    })
}
impl Drop for PreparedInstance {
    fn drop(&mut self) {
        if !self.retain_after_drop {
            if self.record.state == InstanceState::Preparing {
                self.record.state = InstanceState::Failed;
                self.record.diagnostic =
                    Some("activation ended before a backend process was started".into());
                let _ = self
                    .repository
                    .lock()
                    .unwrap()
                    .record_instance(&self.record);
            }
            let _ = self.repository.lock().unwrap().release_reference(
                "instance",
                self.record.identity.instance.as_str(),
                &self.record.identity.revision,
            );
        }
    }
}
