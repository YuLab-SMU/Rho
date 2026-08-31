use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    artifacts::{ArtifactDigest, ArtifactRef},
    ids::{ArtifactId, ExecutionId, JobId, OperationId},
    secrets::SecretRef,
    taxonomy::{NetworkPolicy, RetryClass},
};

pub const EXECUTION_SPEC_V1: u16 = 1;
pub const MAX_EXECUTION_SPEC_BYTES: usize = 512 * 1024;
pub const MAX_EXECUTION_ARGV_ITEMS: usize = 256;
pub const MAX_EXECUTION_ARG_BYTES: usize = 128 * 1024;
pub const MAX_EXECUTION_ENV_REFS: usize = 128;
pub const MAX_EXECUTION_OUTPUTS: usize = 256;
pub const MAX_EXECUTION_EXTENSIONS: usize = 32;
pub const MAX_EXECUTION_JSON_DEPTH: usize = 24;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutorKind {
    Workspace,
    LocalProcess,
    Oci,
    SshRunner,
    Slurm,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Prepared,
    Queued,
    Submitted,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

impl ExecutionState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Uncertain
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_cores: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wall_time_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvVarRef {
    pub name: String,
    pub secret_ref: SecretRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExpectedOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<ArtifactId>,
    pub path_hint: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkingSetManifestV1 {
    pub manifest_digest: ArtifactDigest,
    pub inputs: Vec<ArtifactRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_working_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentManifestV1 {
    pub manifest_digest: ArtifactDigest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_digest: Option<ArtifactDigest>,
    pub project_profile_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_env: Vec<EnvVarRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionProvenanceV1 {
    pub requested_by: String,
    pub capability_id: String,
    pub policy_decision_id: String,
    pub source_revision: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrepareSemanticsV1 {
    SafeToRetryBeforeSpawn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubmitSemanticsV1 {
    QueryOperationMarkerAfterAckLoss,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSpec {
    pub schema_version: u16,
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub idempotency_key: String,
    pub executor: ExecutorKind,
    pub argv: Vec<String>,
    pub working_set: WorkingSetManifestV1,
    pub environment: EnvironmentManifestV1,
    pub network: NetworkPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resources: Option<ResourceRequest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expected_outputs: Vec<ExpectedOutput>,
    pub provenance: ExecutionProvenanceV1,
    pub retry_class: RetryClass,
    pub prepare_semantics: PrepareSemanticsV1,
    pub submit_semantics: SubmitSemanticsV1,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<String, Value>,
}

impl ExecutionSpec {
    pub fn new(
        execution_id: ExecutionId,
        operation_id: OperationId,
        executor: ExecutorKind,
        argv: Vec<String>,
    ) -> Self {
        Self {
            schema_version: EXECUTION_SPEC_V1,
            idempotency_key: format!("idempotency_{}", operation_id.as_str()),
            execution_id,
            operation_id,
            executor,
            argv,
            working_set: WorkingSetManifestV1 {
                manifest_digest: placeholder_digest('a'),
                inputs: Vec::new(),
                relative_working_directory: None,
            },
            environment: EnvironmentManifestV1 {
                manifest_digest: placeholder_digest('b'),
                image_digest: None,
                project_profile_id: "environment_profile_default".to_string(),
                secret_env: Vec::new(),
            },
            network: NetworkPolicy::Deny,
            resources: None,
            expected_outputs: Vec::new(),
            provenance: ExecutionProvenanceV1 {
                requested_by: "system".to_string(),
                capability_id: "execution.run".to_string(),
                policy_decision_id: "policy_decision_default".to_string(),
                source_revision: "revision_unknown".to_string(),
            },
            retry_class: RetryClass::NonIdempotent,
            prepare_semantics: PrepareSemanticsV1::SafeToRetryBeforeSpawn,
            submit_semantics: SubmitSemanticsV1::QueryOperationMarkerAfterAckLoss,
            extensions: BTreeMap::new(),
        }
    }

    pub fn validate(
        &self,
        negotiated_extensions: &BTreeSet<String>,
    ) -> Result<(), ExecutionSpecError> {
        if self.schema_version != EXECUTION_SPEC_V1 {
            return Err(ExecutionSpecError::Version(self.schema_version));
        }
        if self.idempotency_key.is_empty() || self.idempotency_key.len() > 256 {
            return Err(ExecutionSpecError::Identity);
        }
        if self.argv.is_empty()
            || self.argv.len() > MAX_EXECUTION_ARGV_ITEMS
            || self.argv.iter().map(String::len).sum::<usize>() > MAX_EXECUTION_ARG_BYTES
            || self.argv.iter().any(|arg| arg.contains('\0'))
        {
            return Err(ExecutionSpecError::ArgvBounds);
        }
        if self.environment.secret_env.len() > MAX_EXECUTION_ENV_REFS
            || self.expected_outputs.len() > MAX_EXECUTION_OUTPUTS
            || self.extensions.len() > MAX_EXECUTION_EXTENSIONS
        {
            return Err(ExecutionSpecError::CountBounds);
        }
        validate_relative_path_opt(self.working_set.relative_working_directory.as_deref())?;
        let mut env_names = BTreeSet::new();
        for env in &self.environment.secret_env {
            if !valid_env_name(&env.name) || !env_names.insert(env.name.clone()) {
                return Err(ExecutionSpecError::EnvironmentManifest);
            }
        }
        if self.environment.project_profile_id.is_empty()
            || self.environment.project_profile_id.starts_with('/')
            || self.environment.project_profile_id.contains("..")
        {
            return Err(ExecutionSpecError::EnvironmentManifest);
        }
        for output in &self.expected_outputs {
            validate_relative_path_opt(Some(&output.path_hint))?;
        }
        if let Some(resources) = &self.resources {
            validate_resources(resources)?;
        }
        for extension in self.extensions.keys() {
            if !negotiated_extensions.contains(extension) {
                return Err(ExecutionSpecError::UnknownExtension(extension.clone()));
            }
        }
        let value = serde_json::to_value(self).map_err(|_| ExecutionSpecError::Encoding)?;
        if json_depth(&value) > MAX_EXECUTION_JSON_DEPTH {
            return Err(ExecutionSpecError::DepthBounds);
        }
        let encoded = serde_json::to_vec(self).map_err(|_| ExecutionSpecError::Encoding)?;
        if encoded.len() > MAX_EXECUTION_SPEC_BYTES {
            return Err(ExecutionSpecError::ByteBounds);
        }
        let lowered = String::from_utf8_lossy(&encoded).to_ascii_lowercase();
        for forbidden in [
            "plaintext_secret",
            "secret_value",
            "host_project_path",
            "acp_method",
            "private_thinking",
            "login_script",
            "shell_command",
        ] {
            if lowered.contains(forbidden) {
                return Err(ExecutionSpecError::ForbiddenSurface(forbidden));
            }
        }
        Ok(())
    }

    pub fn canonical_bytes(
        &self,
        negotiated_extensions: &BTreeSet<String>,
    ) -> Result<Vec<u8>, ExecutionSpecError> {
        self.validate(negotiated_extensions)?;
        let mut normalized = self.clone();
        normalized.working_set.relative_working_directory = normalized
            .working_set
            .relative_working_directory
            .as_deref()
            .map(normalize_relative_path)
            .transpose()?;
        for output in &mut normalized.expected_outputs {
            output.path_hint = normalize_relative_path(&output.path_hint)?;
        }
        normalized.working_set.inputs.sort_by(|left, right| {
            left.artifact_id
                .cmp(&right.artifact_id)
                .then(left.digest.cmp(&right.digest))
        });
        normalized
            .expected_outputs
            .sort_by(|left, right| left.path_hint.cmp(&right.path_hint));
        normalized
            .environment
            .secret_env
            .sort_by(|left, right| left.name.cmp(&right.name));
        serde_json::to_vec(&normalized).map_err(|_| ExecutionSpecError::Encoding)
    }

    pub fn digest(
        &self,
        negotiated_extensions: &BTreeSet<String>,
    ) -> Result<ArtifactDigest, ExecutionSpecError> {
        let bytes = self.canonical_bytes(negotiated_extensions)?;
        ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
            .map_err(|_| ExecutionSpecError::Encoding)
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ExecutionSpecError {
    #[error("unsupported ExecutionSpec schema version {0}")]
    Version(u16),
    #[error("ExecutionSpec operation/idempotency identity is invalid")]
    Identity,
    #[error("ExecutionSpec argv exceeds count/byte bounds")]
    ArgvBounds,
    #[error("ExecutionSpec count bound exceeded")]
    CountBounds,
    #[error("ExecutionSpec contains unsafe or absolute path")]
    UnsafePath,
    #[error("ExecutionSpec environment manifest is invalid")]
    EnvironmentManifest,
    #[error("ExecutionSpec resource request is invalid")]
    ResourceRequest,
    #[error("ExecutionSpec unknown extension was not negotiated: {0}")]
    UnknownExtension(String),
    #[error("ExecutionSpec JSON depth exceeds bound")]
    DepthBounds,
    #[error("ExecutionSpec byte size exceeds bound")]
    ByteBounds,
    #[error("ExecutionSpec encoding failed")]
    Encoding,
    #[error("ExecutionSpec contains forbidden surface {0}")]
    ForbiddenSurface(&'static str),
}

pub fn decode_execution_spec_v1(
    bytes: &[u8],
    negotiated_extensions: &BTreeSet<String>,
) -> Result<ExecutionSpec, ExecutionSpecError> {
    if bytes.len() > MAX_EXECUTION_SPEC_BYTES {
        return Err(ExecutionSpecError::ByteBounds);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ExecutionSpecError::Encoding)?;
    if json_depth(&value) > MAX_EXECUTION_JSON_DEPTH {
        return Err(ExecutionSpecError::DepthBounds);
    }
    let spec: ExecutionSpec =
        serde_json::from_value(value).map_err(|_| ExecutionSpecError::Encoding)?;
    spec.validate(negotiated_extensions)?;
    Ok(spec)
}

fn validate_resources(resources: &ResourceRequest) -> Result<(), ExecutionSpecError> {
    if resources.cpu_cores == Some(0)
        || resources.memory_bytes == Some(0)
        || resources.wall_time_seconds == Some(0)
        || resources.gpu_count.is_some_and(|value| value > 64)
        || resources
            .partition
            .as_ref()
            .is_some_and(|value| !valid_profile_name(value))
        || resources
            .account
            .as_ref()
            .is_some_and(|value| !valid_profile_name(value))
    {
        return Err(ExecutionSpecError::ResourceRequest);
    }
    Ok(())
}

fn valid_profile_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, character)| {
            character == '_'
                || character.is_ascii_uppercase()
                || (index > 0 && character.is_ascii_digit())
        })
}

fn validate_relative_path_opt(path: Option<&str>) -> Result<(), ExecutionSpecError> {
    if let Some(path) = path {
        normalize_relative_path(path)?;
    }
    Ok(())
}

fn normalize_relative_path(path: &str) -> Result<String, ExecutionSpecError> {
    if path.is_empty()
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path.starts_with('/')
        || path.contains(':')
    {
        return Err(ExecutionSpecError::UnsafePath);
    }
    let components = path
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .collect::<Vec<_>>();
    if components.is_empty() || components.contains(&"..") {
        return Err(ExecutionSpecError::UnsafePath);
    }
    Ok(components.join("/"))
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(values) => 1 + values.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(values) => 1 + values.values().map(json_depth).max().unwrap_or(0),
        _ => 1,
    }
}

fn placeholder_digest(character: char) -> ArtifactDigest {
    ArtifactDigest::new(format!("sha256:{}", character.to_string().repeat(64)))
        .expect("placeholder digest")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JobObservation {
    pub job_id: JobId,
    pub execution_id: ExecutionId,
    pub state: ExecutionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduler_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CancelOutcome {
    Cancelled,
    AlreadyTerminal,
    Requested,
    Unknown,
}
