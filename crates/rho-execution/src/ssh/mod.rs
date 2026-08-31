use std::collections::BTreeMap;

use rho_protocol::{DestinationClass, ExecutionId, SecretPurpose, SecretRef};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_SSH_FRAME_BYTES: usize = 512 * 1024;
pub const MAX_SSH_DIAGNOSTIC_BYTES: usize = 4096;
pub const MAX_SSH_POOL_CONNECTIONS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshTargetAdmission {
    pub target_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub expected_host_key_sha256: String,
    pub runner_path: String,
    pub runner_sha256: String,
    pub runner_protocol_version: u16,
    pub credential_ref: SecretRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshBootstrapCommand {
    pub executable: String,
    pub argv: Vec<String>,
    pub credential_lease_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshDiagnostic {
    pub code: String,
    pub detail: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SshTransportOutcome {
    Response(Vec<u8>),
    Disconnected {
        execution_id: Option<ExecutionId>,
        state: String,
        reason_code: String,
    },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SshTransportError {
    #[error("SSH target admission is invalid")]
    InvalidTarget,
    #[error("SSH host key mismatch")]
    HostKeyMismatch,
    #[error("remote runner digest mismatch")]
    RunnerDigestMismatch,
    #[error("remote runner version is unsupported")]
    RunnerVersionMismatch,
    #[error("SSH credential reference or lease is invalid")]
    CredentialRejected,
    #[error("SSH frame exceeds bound")]
    FrameTooLarge,
    #[error("SSH connection failed")]
    ConnectionFailed,
    #[error("SSH channel failed")]
    ChannelFailed,
    #[error("SSH pool capacity exceeded")]
    PoolCapacity,
}

pub trait SshRunnerChannel {
    fn peer_host_key_sha256(&self) -> &str;
    fn runner_sha256(&mut self, runner_path: &str) -> Result<String, SshTransportError>;
    fn runner_protocol_version(&mut self) -> Result<u16, SshTransportError>;
    fn send_frame(&mut self, bytes: &[u8]) -> Result<(), SshTransportError>;
    fn receive_frame(&mut self) -> Result<Option<Vec<u8>>, SshTransportError>;
    fn take_stderr(&mut self) -> Vec<u8>;
    fn keepalive(&mut self) -> Result<(), SshTransportError>;
}

pub trait SshConnector {
    type Channel: SshRunnerChannel;

    fn connect(
        &mut self,
        admission: &SshTargetAdmission,
        bootstrap: &SshBootstrapCommand,
    ) -> Result<Self::Channel, SshTransportError>;
}

pub struct SshRunnerTransport<C: SshConnector> {
    connector: C,
    pool: BTreeMap<String, C::Channel>,
    diagnostics: Vec<SshDiagnostic>,
}

impl<C: SshConnector> SshRunnerTransport<C> {
    pub fn new(connector: C) -> Self {
        Self {
            connector,
            pool: BTreeMap::new(),
            diagnostics: Vec::new(),
        }
    }

    pub fn request(
        &mut self,
        admission: &SshTargetAdmission,
        credential_lease_id: &str,
        frame: &[u8],
        execution_id: Option<ExecutionId>,
    ) -> Result<SshTransportOutcome, SshTransportError> {
        validate_admission(admission, credential_lease_id)?;
        if frame.is_empty() || frame.len() > MAX_SSH_FRAME_BYTES {
            return Err(SshTransportError::FrameTooLarge);
        }
        let key = pool_key(admission);
        if !self.pool.contains_key(&key) {
            if self.pool.len() >= MAX_SSH_POOL_CONNECTIONS {
                return Err(SshTransportError::PoolCapacity);
            }
            let bootstrap = bootstrap_command(admission, credential_lease_id)?;
            let mut channel = self.connector.connect(admission, &bootstrap)?;
            validate_channel(admission, &mut channel)?;
            self.pool.insert(key.clone(), channel);
        }
        let channel = self.pool.get_mut(&key).expect("inserted channel");
        channel.keepalive()?;
        channel.send_frame(frame)?;
        let response = channel.receive_frame();
        let stderr = channel.take_stderr();
        if !stderr.is_empty() {
            self.diagnostics.push(bound_diagnostic(&stderr));
        }
        match response {
            Ok(Some(bytes)) if bytes.len() <= MAX_SSH_FRAME_BYTES => {
                Ok(SshTransportOutcome::Response(bytes))
            }
            Ok(Some(_)) => Err(SshTransportError::FrameTooLarge),
            Ok(None) | Err(SshTransportError::ChannelFailed) => {
                self.pool.remove(&key);
                Ok(SshTransportOutcome::Disconnected {
                    execution_id,
                    state: "uncertain".to_string(),
                    reason_code: "ssh_eof_is_not_job_terminal_reconcile_runner".to_string(),
                })
            }
            Err(error) => Err(error),
        }
    }

    pub fn reconnect_reconcile(
        &mut self,
        admission: &SshTargetAdmission,
        credential_lease_id: &str,
        authenticated_reconcile_frame: &[u8],
        execution_id: ExecutionId,
    ) -> Result<SshTransportOutcome, SshTransportError> {
        self.request(
            admission,
            credential_lease_id,
            authenticated_reconcile_frame,
            Some(execution_id),
        )
    }

    pub fn diagnostics(&self) -> &[SshDiagnostic] {
        &self.diagnostics
    }

    pub fn pool_size(&self) -> usize {
        self.pool.len()
    }
}

pub fn bootstrap_command(
    admission: &SshTargetAdmission,
    credential_lease_id: &str,
) -> Result<SshBootstrapCommand, SshTransportError> {
    validate_admission(admission, credential_lease_id)?;
    Ok(SshBootstrapCommand {
        executable: "ssh".to_string(),
        argv: vec![
            "-T".to_string(),
            "-p".to_string(),
            admission.port.to_string(),
            "-o".to_string(),
            "BatchMode=yes".to_string(),
            "-o".to_string(),
            "StrictHostKeyChecking=yes".to_string(),
            format!("{}@{}", admission.user, admission.host),
            admission.runner_path.clone(),
            "--stdio".to_string(),
            "--protocol=1".to_string(),
        ],
        credential_lease_id: credential_lease_id.to_string(),
    })
}

fn validate_admission(
    admission: &SshTargetAdmission,
    credential_lease_id: &str,
) -> Result<(), SshTransportError> {
    if admission.target_id.is_empty()
        || admission.host.is_empty()
        || admission
            .host
            .chars()
            .any(|character| !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-')))
        || admission.port == 0
        || admission.user.is_empty()
        || !admission
            .user
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        || !valid_digest(&admission.expected_host_key_sha256)
        || !valid_digest(&admission.runner_sha256)
        || !admission.runner_path.starts_with('/')
        || admission.runner_path.contains("..")
        || admission.runner_protocol_version != 1
    {
        return Err(SshTransportError::InvalidTarget);
    }
    if admission.credential_ref.purpose != SecretPurpose::RemoteExecutionCredential
        || admission.credential_ref.destination_scope != DestinationClass::RemoteExecutor
        || credential_lease_id.is_empty()
        || credential_lease_id.len() > 256
    {
        return Err(SshTransportError::CredentialRejected);
    }
    Ok(())
}

fn validate_channel(
    admission: &SshTargetAdmission,
    channel: &mut impl SshRunnerChannel,
) -> Result<(), SshTransportError> {
    if channel.peer_host_key_sha256() != admission.expected_host_key_sha256 {
        return Err(SshTransportError::HostKeyMismatch);
    }
    if channel.runner_sha256(&admission.runner_path)? != admission.runner_sha256 {
        return Err(SshTransportError::RunnerDigestMismatch);
    }
    if channel.runner_protocol_version()? != admission.runner_protocol_version {
        return Err(SshTransportError::RunnerVersionMismatch);
    }
    Ok(())
}

fn pool_key(admission: &SshTargetAdmission) -> String {
    format!(
        "{}:{}:{}:{}",
        admission.host, admission.port, admission.user, admission.runner_sha256
    )
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.chars().all(|character| character.is_ascii_hexdigit())
    })
}

fn bound_diagnostic(bytes: &[u8]) -> SshDiagnostic {
    let text = String::from_utf8_lossy(bytes);
    let lowered = text.to_ascii_lowercase();
    let detail = if ["secret", "token", "private key", "authorization"]
        .iter()
        .any(|needle| lowered.contains(needle))
    {
        "SSH diagnostic redacted".to_string()
    } else {
        text.chars().take(MAX_SSH_DIAGNOSTIC_BYTES).collect()
    };
    SshDiagnostic {
        code: "ssh_stderr".to_string(),
        detail,
        truncated: bytes.len() > MAX_SSH_DIAGNOSTIC_BYTES,
    }
}

pub fn ssh_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "host_key_admission",
            "fixed_runner_bootstrap",
            "framed_channel",
            "disconnect_reconcile",
        ],
        &[
            "job_shell_command",
            "secret_argv",
            "spec_in_command_line",
            "transport_eof_terminal",
            "general_child_environment",
        ],
    )
}
