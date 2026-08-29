use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::{ComputeHost, ComputeTarget, ToolchainError, validate_target_id};

const MAX_REMOTE_FRAME_BYTES: usize = 1024 * 1024;
const REMOTE_HELPER_PROTOCOL: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteHelperOperation {
    Doctor,
    Run,
    Live,
    Sync,
    Lock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteHelperRequest {
    pub protocol: u16,
    pub request_id: String,
    pub target_id: String,
    pub project_root: String,
    pub rho_toml_sha256: String,
    pub target_registry_sha256: String,
    pub operation: RemoteHelperOperation,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteHelperResponse {
    pub protocol: u16,
    pub request_id: String,
    pub target_id: String,
    pub ok: bool,
    pub status: String,
    pub payload: serde_json::Value,
    pub error: Option<String>,
    pub partial_effects_possible: bool,
}

pub fn verify_ssh_host_fingerprint(target: &ComputeTarget) -> Result<(), ToolchainError> {
    let ComputeHost::Ssh {
        host,
        port,
        host_fingerprint,
        ..
    } = &target.host
    else {
        return Err(ToolchainError::InvalidTarget(
            "SSH fingerprint verification requires an SSH host".to_string(),
        ));
    };
    let scan = Command::new("ssh-keyscan")
        .args(["-p", &port.to_string(), "--", host])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| ToolchainError::CommandStart(error.to_string()))?;
    if !scan.status.success()
        || scan.stdout.is_empty()
        || scan.stdout.len() > MAX_REMOTE_FRAME_BYTES
    {
        return Err(ToolchainError::CommandFailed(
            "ssh-keyscan did not return a bounded host key".to_string(),
        ));
    }
    let mut child = Command::new("ssh-keygen")
        .args(["-lf", "-", "-E", "sha256"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ToolchainError::CommandStart(error.to_string()))?;
    child.stdin.as_mut().unwrap().write_all(&scan.stdout)?;
    let output = child
        .wait_with_output()
        .map_err(|error| ToolchainError::CommandStart(error.to_string()))?;
    if !output.status.success() || !fingerprints(&output.stdout).contains(host_fingerprint) {
        return Err(ToolchainError::CommandFailed(
            "SSH host fingerprint does not match targets.yaml".to_string(),
        ));
    }
    Ok(())
}

pub fn invoke_remote_helper(
    target_id: &str,
    target: &ComputeTarget,
    request: &RemoteHelperRequest,
) -> Result<RemoteHelperResponse, ToolchainError> {
    validate_target_id(target_id)?;
    let ComputeHost::Ssh {
        host,
        username,
        port,
        remote_root,
        ..
    } = &target.host
    else {
        return Err(ToolchainError::InvalidTarget(
            "remote helper requires an SSH host".to_string(),
        ));
    };
    if request.protocol != REMOTE_HELPER_PROTOCOL
        || request.target_id != target_id
        || request.project_root != *remote_root
    {
        return Err(ToolchainError::InvalidTarget(
            "remote helper request identity is inconsistent".to_string(),
        ));
    }
    verify_ssh_host_fingerprint(target)?;
    let destination = username
        .as_ref()
        .map_or_else(|| host.clone(), |username| format!("{username}@{host}"));
    let request_bytes = serde_json::to_vec(request)?;
    if request_bytes.len() > MAX_REMOTE_FRAME_BYTES {
        return Err(ToolchainError::InvalidTarget(
            "remote helper request exceeds the frame bound".to_string(),
        ));
    }
    let mut child = Command::new("ssh")
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-p",
            &port.to_string(),
            "--",
            &destination,
            "rho-toolchain-helper",
            "--stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ToolchainError::CommandStart(error.to_string()))?;
    child.stdin.as_mut().unwrap().write_all(&request_bytes)?;
    let output = child
        .wait_with_output()
        .map_err(|error| ToolchainError::CommandStart(error.to_string()))?;
    if !output.status.success() || output.stdout.len() > MAX_REMOTE_FRAME_BYTES {
        return Err(ToolchainError::CommandFailed(
            "remote helper transport failed or exceeded its output bound".to_string(),
        ));
    }
    let response: RemoteHelperResponse = serde_json::from_slice(&output.stdout)?;
    if response.protocol != REMOTE_HELPER_PROTOCOL
        || response.request_id != request.request_id
        || response.target_id != target_id
    {
        return Err(ToolchainError::CommandFailed(
            "remote helper response identity is invalid".to_string(),
        ));
    }
    Ok(response)
}

fn fingerprints(output: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1).map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_parser_accepts_only_the_exact_sha256_field() {
        let output = b"256 SHA256:abc host (ED25519)\n2048 SHA256:def host (RSA)\n";
        assert_eq!(fingerprints(output), ["SHA256:abc", "SHA256:def"]);
    }

    #[test]
    fn request_and_response_identity_are_bounded_and_explicit() {
        let request = RemoteHelperRequest {
            protocol: 1,
            request_id: "request-1".to_string(),
            target_id: "lab".to_string(),
            project_root: "/data/projects/demo".to_string(),
            rho_toml_sha256: "a".repeat(64),
            target_registry_sha256: "b".repeat(64),
            operation: RemoteHelperOperation::Doctor,
            payload: serde_json::json!({}),
        };
        let encoded = serde_json::to_vec(&request).unwrap();
        assert!(encoded.len() < MAX_REMOTE_FRAME_BYTES);
        assert_eq!(
            serde_json::from_slice::<RemoteHelperRequest>(&encoded).unwrap(),
            request
        );
    }
}
