use rho_protocol::{ExecutionId, ExecutionSpec, OperationId, RunnerStagingManifestV1};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const RUNNER_PROTOCOL_VERSION: u16 = 1;
pub const MAX_RUNNER_FRAME_BYTES: usize = 512 * 1024;
pub const MAX_RUNNER_REQUEST_ID_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunnerRequest {
    Handshake {
        client_version: u16,
    },
    Prepare {
        spec: Box<ExecutionSpec>,
        staging: Box<RunnerStagingManifestV1>,
    },
    Submit {
        operation_id: OperationId,
    },
    Status {
        execution_id: ExecutionId,
    },
    Cancel {
        execution_id: ExecutionId,
    },
    Collect {
        execution_id: ExecutionId,
    },
    Reconcile {
        execution_id: ExecutionId,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthenticatedRunnerRequest {
    pub protocol_version: u16,
    pub request_id: String,
    pub auth_tag: String,
    pub request: RunnerRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunnerCapabilities {
    pub protocol_version: u16,
    pub execution_spec_versions: Vec<u16>,
    pub supports_cancel: bool,
    pub supports_collect: bool,
    pub supports_reconcile: bool,
    pub resource_profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RunnerResponse {
    Handshake {
        capabilities: RunnerCapabilities,
    },
    Prepared {
        execution_id: ExecutionId,
        operation_id: OperationId,
        spec_digest: String,
    },
    Job {
        execution_id: ExecutionId,
        job_id: String,
        state: String,
        duplicate: bool,
    },
    Status {
        execution_id: ExecutionId,
        state: String,
        reason_code: String,
    },
    Rejected {
        reason_code: String,
    },
}

pub struct RunnerAuthKey(Vec<u8>);

impl RunnerAuthKey {
    pub fn new(bytes: Vec<u8>) -> Result<Self, RunnerProtocolError> {
        if bytes.len() < 32 || bytes.len() > 4096 {
            return Err(RunnerProtocolError::InvalidAuthKey);
        }
        Ok(Self(bytes))
    }
}

impl std::fmt::Debug for RunnerAuthKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RunnerAuthKey(REDACTED)")
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RunnerProtocolError {
    #[error("runner frame exceeds byte bound")]
    FrameTooLarge,
    #[error("runner frame is malformed")]
    Malformed,
    #[error("runner protocol version is unsupported")]
    UnsupportedVersion,
    #[error("runner request identity is invalid")]
    InvalidRequestId,
    #[error("runner authentication failed")]
    Authentication,
    #[error("runner authentication key is invalid")]
    InvalidAuthKey,
}

pub fn decode_authenticated_request(
    bytes: &[u8],
    key: &RunnerAuthKey,
) -> Result<AuthenticatedRunnerRequest, RunnerProtocolError> {
    if bytes.len() > MAX_RUNNER_FRAME_BYTES {
        return Err(RunnerProtocolError::FrameTooLarge);
    }
    let request: AuthenticatedRunnerRequest =
        serde_json::from_slice(bytes).map_err(|_| RunnerProtocolError::Malformed)?;
    if request.protocol_version != RUNNER_PROTOCOL_VERSION {
        return Err(RunnerProtocolError::UnsupportedVersion);
    }
    if request.request_id.is_empty()
        || request.request_id.len() > MAX_RUNNER_REQUEST_ID_BYTES
        || request.request_id.chars().any(char::is_control)
    {
        return Err(RunnerProtocolError::InvalidRequestId);
    }
    let expected = request_auth_tag(&request.request_id, &request.request, key)?;
    if !constant_time_eq(expected.as_bytes(), request.auth_tag.as_bytes()) {
        return Err(RunnerProtocolError::Authentication);
    }
    Ok(request)
}

pub fn encode_authenticated_request(
    request_id: impl Into<String>,
    request: RunnerRequest,
    key: &RunnerAuthKey,
) -> Result<Vec<u8>, RunnerProtocolError> {
    let request_id = request_id.into();
    let auth_tag = request_auth_tag(&request_id, &request, key)?;
    let envelope = AuthenticatedRunnerRequest {
        protocol_version: RUNNER_PROTOCOL_VERSION,
        request_id,
        auth_tag,
        request,
    };
    let bytes = serde_json::to_vec(&envelope).map_err(|_| RunnerProtocolError::Malformed)?;
    if bytes.len() > MAX_RUNNER_FRAME_BYTES {
        return Err(RunnerProtocolError::FrameTooLarge);
    }
    Ok(bytes)
}

fn request_auth_tag(
    request_id: &str,
    request: &RunnerRequest,
    key: &RunnerAuthKey,
) -> Result<String, RunnerProtocolError> {
    let request_bytes = serde_json::to_vec(request).map_err(|_| RunnerProtocolError::Malformed)?;
    let mut message = Vec::new();
    message.extend_from_slice(b"rho-runner-auth-v1\0");
    message.extend_from_slice(&(request_id.len() as u64).to_be_bytes());
    message.extend_from_slice(request_id.as_bytes());
    message.extend_from_slice(&request_bytes);
    Ok(format!("sha256:{}", hex(&hmac_sha256(&key.0, &message))))
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut normalized = [0_u8; BLOCK];
    if key.len() > BLOCK {
        normalized[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK];
    let mut outer_pad = [0x5c_u8; BLOCK];
    for index in 0..BLOCK {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner);
    outer.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

pub fn capabilities(resource_profile: impl Into<String>) -> RunnerCapabilities {
    RunnerCapabilities {
        protocol_version: RUNNER_PROTOCOL_VERSION,
        execution_spec_versions: vec![rho_protocol::EXECUTION_SPEC_V1],
        supports_cancel: true,
        supports_collect: true,
        supports_reconcile: true,
        resource_profile: resource_profile.into(),
    }
}
