use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{
    ExecutionId, ExecutionSpec, ExecutionState, ExecutorKind, JobId, JobObservation,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::resource::EffectiveResourceAllocation;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OciImageIdentity {
    pub repository: String,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OciMount {
    pub handle_id: String,
    pub destination: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OciSecurityConfig {
    pub uid: u32,
    pub gid: u32,
    pub user_namespace: bool,
    pub seccomp_profile_digest: String,
    pub dropped_capabilities: BTreeSet<String>,
    pub added_capabilities: BTreeSet<String>,
    pub no_new_privileges: bool,
    pub privileged: bool,
    pub host_network: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OciPlatformSupport {
    pub runtime: String,
    pub rootless: bool,
    pub user_namespace: bool,
    pub seccomp: bool,
    pub resource_enforcement: bool,
    pub network_namespace: bool,
}

impl OciPlatformSupport {
    pub fn verified(&self) -> bool {
        self.rootless
            && self.user_namespace
            && self.seccomp
            && self.resource_enforcement
            && self.network_namespace
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreparedOciSpec {
    pub execution: ExecutionSpec,
    pub image: OciImageIdentity,
    pub environment_digest: String,
    pub mounts: Vec<OciMount>,
    pub security: OciSecurityConfig,
    pub resources: EffectiveResourceAllocation,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OciRuntimeState {
    Created,
    Running,
    ExitedSuccess,
    ExitedFailure,
    Killed,
    Missing,
    StaleIdentity,
    DaemonUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OciRuntimeHandle {
    pub container_id: String,
    pub execution_id: ExecutionId,
    pub image_digest: String,
    pub created_unix_ms: u64,
}

pub trait OciRuntime {
    fn create(&mut self, spec: &PreparedOciSpec) -> Result<OciRuntimeHandle, OciRuntimeError>;
    fn start(&mut self, handle: &OciRuntimeHandle) -> Result<(), OciRuntimeError>;
    fn inspect(&mut self, handle: &OciRuntimeHandle) -> Result<OciRuntimeState, OciRuntimeError>;
    fn kill(&mut self, handle: &OciRuntimeHandle) -> Result<(), OciRuntimeError>;
    fn delete(&mut self, handle: &OciRuntimeHandle) -> Result<(), OciRuntimeError>;
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum OciRuntimeError {
    #[error("OCI runtime daemon is unavailable")]
    DaemonUnavailable,
    #[error("OCI runtime operation timed out")]
    Timeout,
    #[error("OCI runtime rejected the operation")]
    Rejected,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum OciExecutorError {
    #[error("OCI image must be pinned by immutable sha256 digest")]
    MutableImage,
    #[error("OCI execution spec is not canonical OCI")]
    WrongExecutor,
    #[error("OCI mount is not on the exact allowlist")]
    UnsafeMount,
    #[error("OCI security config is privileged or lacks required isolation")]
    UnsafeSecurity,
    #[error("OCI platform guarantees are unavailable")]
    UnsupportedPlatform,
    #[error("OCI environment digest is invalid")]
    InvalidEnvironmentDigest,
    #[error("OCI runtime error: {0}")]
    Runtime(#[from] OciRuntimeError),
    #[error("OCI execution {0} is unknown")]
    UnknownExecution(ExecutionId),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum OciSubmitOutcome {
    Running {
        handle: OciRuntimeHandle,
    },
    Uncertain {
        handle: OciRuntimeHandle,
        reason_code: String,
    },
}

pub fn prepare_oci_spec(
    execution: ExecutionSpec,
    image: OciImageIdentity,
    environment_digest: String,
    mounts: Vec<OciMount>,
    resources: EffectiveResourceAllocation,
    support: &OciPlatformSupport,
) -> Result<PreparedOciSpec, OciExecutorError> {
    if execution.executor != ExecutorKind::Oci {
        return Err(OciExecutorError::WrongExecutor);
    }
    if !valid_digest(&image.digest)
        || image.repository.contains('@')
        || image.repository.contains(':')
        || image.repository.is_empty()
    {
        return Err(OciExecutorError::MutableImage);
    }
    if !valid_digest(&environment_digest) {
        return Err(OciExecutorError::InvalidEnvironmentDigest);
    }
    if !support.verified() {
        return Err(OciExecutorError::UnsupportedPlatform);
    }
    validate_mounts(&mounts)?;
    let security = OciSecurityConfig {
        uid: 65532,
        gid: 65532,
        user_namespace: true,
        seccomp_profile_digest:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_string(),
        dropped_capabilities: ["all".to_string()].into(),
        added_capabilities: BTreeSet::new(),
        no_new_privileges: true,
        privileged: false,
        host_network: false,
    };
    validate_security(&security)?;
    Ok(PreparedOciSpec {
        execution,
        image,
        environment_digest,
        mounts,
        security,
        resources,
    })
}

#[derive(Default)]
pub struct OciExecutor {
    handles: BTreeMap<ExecutionId, OciRuntimeHandle>,
}

impl OciExecutor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn submit(
        &mut self,
        spec: &PreparedOciSpec,
        runtime: &mut impl OciRuntime,
    ) -> Result<OciSubmitOutcome, OciExecutorError> {
        if let Some(handle) = self.handles.get(&spec.execution.execution_id) {
            return Ok(OciSubmitOutcome::Running {
                handle: handle.clone(),
            });
        }
        let handle = runtime.create(spec)?;
        self.handles
            .insert(spec.execution.execution_id.clone(), handle.clone());
        match runtime.start(&handle) {
            Ok(()) => Ok(OciSubmitOutcome::Running { handle }),
            Err(OciRuntimeError::DaemonUnavailable | OciRuntimeError::Timeout) => {
                Ok(OciSubmitOutcome::Uncertain {
                    handle,
                    reason_code: "oci_start_unknown_reconcile".to_string(),
                })
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn reconcile(
        &mut self,
        execution_id: &ExecutionId,
        job_id: JobId,
        runtime: &mut impl OciRuntime,
    ) -> Result<JobObservation, OciExecutorError> {
        let handle = self
            .handles
            .get(execution_id)
            .cloned()
            .ok_or_else(|| OciExecutorError::UnknownExecution(execution_id.clone()))?;
        let state = match runtime.inspect(&handle) {
            Ok(OciRuntimeState::Created | OciRuntimeState::Running) => ExecutionState::Running,
            Ok(OciRuntimeState::ExitedSuccess) => ExecutionState::Succeeded,
            Ok(OciRuntimeState::ExitedFailure) => ExecutionState::Failed,
            Ok(OciRuntimeState::Killed) => ExecutionState::Cancelled,
            Ok(
                OciRuntimeState::Missing
                | OciRuntimeState::StaleIdentity
                | OciRuntimeState::DaemonUnavailable,
            )
            | Err(OciRuntimeError::DaemonUnavailable | OciRuntimeError::Timeout) => {
                ExecutionState::Uncertain
            }
            Err(error) => return Err(error.into()),
        };
        Ok(JobObservation {
            job_id,
            execution_id: execution_id.clone(),
            state,
            scheduler_id: Some(handle.container_id),
            message: Some(
                match state {
                    ExecutionState::Uncertain => {
                        "OCI daemon/container identity requires reconciliation"
                    }
                    ExecutionState::Succeeded => "OCI process exited successfully",
                    ExecutionState::Failed => "OCI process exited with failure",
                    ExecutionState::Cancelled => "OCI process tree was killed",
                    _ => "OCI process is running",
                }
                .to_string(),
            ),
        })
    }

    pub fn cancel(
        &mut self,
        execution_id: &ExecutionId,
        runtime: &mut impl OciRuntime,
    ) -> Result<(), OciExecutorError> {
        let handle = self
            .handles
            .get(execution_id)
            .ok_or_else(|| OciExecutorError::UnknownExecution(execution_id.clone()))?;
        runtime.kill(handle)?;
        runtime.delete(handle)?;
        Ok(())
    }
}

fn validate_mounts(mounts: &[OciMount]) -> Result<(), OciExecutorError> {
    let mut destinations = BTreeSet::new();
    for mount in mounts {
        if mount.handle_id.is_empty()
            || !destinations.insert(mount.destination.clone())
            || !matches!(mount.destination.as_str(), "/workspace" | "/staging")
            || (mount.destination == "/workspace" && !mount.read_only)
            || (mount.destination == "/staging" && mount.read_only)
        {
            return Err(OciExecutorError::UnsafeMount);
        }
    }
    if !destinations.contains("/workspace") || !destinations.contains("/staging") {
        return Err(OciExecutorError::UnsafeMount);
    }
    Ok(())
}

fn validate_security(security: &OciSecurityConfig) -> Result<(), OciExecutorError> {
    if security.uid == 0
        || security.gid == 0
        || !security.user_namespace
        || !valid_digest(&security.seccomp_profile_digest)
        || !security.added_capabilities.is_empty()
        || security.dropped_capabilities != BTreeSet::from(["all".to_string()])
        || !security.no_new_privileges
        || security.privileged
        || security.host_network
    {
        return Err(OciExecutorError::UnsafeSecurity);
    }
    Ok(())
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.chars().all(|character| character.is_ascii_hexdigit())
    })
}

pub fn oci_provenance(spec: &PreparedOciSpec) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("image_digest".to_string(), spec.image.digest.clone()),
        (
            "environment_digest".to_string(),
            spec.environment_digest.clone(),
        ),
    ])
}

pub fn oci_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "pinned_image",
            "canonical_spec",
            "rootless_security",
            "runtime_lifecycle",
            "uncertain_reconcile",
        ],
        &[
            "mutable_tag_identity",
            "host_socket",
            "host_network",
            "privileged_container",
            "authoritative_project_mount",
            "secret_store_mount",
        ],
    )
}
