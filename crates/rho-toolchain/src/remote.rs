use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    CommandSpec, ComputeHost, ComputeTarget, EnvironmentReceipt, OperationJournal,
    RemoteOperationMirror, RemoteOperationMirrorStatus, ToolchainError,
    create_remote_operation_mirror, update_remote_operation_mirror, validate_target_id,
};

const MAX_REMOTE_FRAME_BYTES: usize = 1024 * 1024;
const REMOTE_HELPER_PROTOCOL: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteHelperOperation {
    Doctor,
    InspectOperation,
    Run,
    Live,
    Sync,
    Lock,
}

impl RemoteHelperOperation {
    pub fn is_effect(self) -> bool {
        matches!(self, Self::Run | Self::Live | Self::Sync | Self::Lock)
    }
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
pub struct RemoteEffectPayload {
    pub operation_id: String,
    pub confirmed: bool,
    pub command: CommandSpec,
    pub environment: EnvironmentReceipt,
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
        .map_err(|error| remote_transport(false, error.to_string()))?;
    child
        .stdin
        .as_mut()
        .expect("piped SSH stdin is available")
        .write_all(&request_bytes)
        .map_err(|error| remote_transport(true, error.to_string()))?;
    let output = child
        .wait_with_output()
        .map_err(|error| remote_transport(true, error.to_string()))?;
    if !output.status.success() {
        return Err(remote_transport(
            true,
            format!(
                "SSH exited with {}: {}",
                output
                    .status
                    .code()
                    .map_or_else(|| "signal".to_string(), |code| code.to_string()),
                bounded_transport_detail(&output.stderr)
            ),
        ));
    }
    if output.stdout.len() > MAX_REMOTE_FRAME_BYTES {
        return Err(remote_transport(
            true,
            "remote helper output exceeded its frame bound",
        ));
    }
    let response: RemoteHelperResponse =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            remote_transport(true, format!("remote helper response was invalid: {error}"))
        })?;
    if response.protocol != REMOTE_HELPER_PROTOCOL
        || response.request_id != request.request_id
        || response.target_id != target_id
    {
        return Err(remote_transport(
            true,
            "remote helper response identity is invalid",
        ));
    }
    Ok(response)
}

/// Invoke one mutating request with a durable local mirror. Once SSH has been
/// spawned, every transport failure is conservatively recorded as uncertain.
pub fn invoke_remote_effect(
    local_project_root: &Path,
    target_id: &str,
    target: &ComputeTarget,
    request: &RemoteHelperRequest,
) -> Result<RemoteHelperResponse, ToolchainError> {
    invoke_remote_effect_with(local_project_root, request, || {
        invoke_remote_helper(target_id, target, request)
    })
}

fn invoke_remote_effect_with<F>(
    local_project_root: &Path,
    request: &RemoteHelperRequest,
    invoke: F,
) -> Result<RemoteHelperResponse, ToolchainError>
where
    F: FnOnce() -> Result<RemoteHelperResponse, ToolchainError>,
{
    if !request.operation.is_effect() {
        return Err(ToolchainError::InvalidJournal(
            "remote operation mirror requires an effect request".to_string(),
        ));
    }
    let operation_id = request
        .payload
        .get("operation_id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            ToolchainError::InvalidJournal(
                "remote effect payload requires operation_id".to_string(),
            )
        })?;
    let mut mirror = create_remote_operation_mirror(local_project_root, operation_id, request)?;
    mirror.status = RemoteOperationMirrorStatus::Dispatching;
    mirror.updated_at = Utc::now().to_rfc3339();
    update_remote_operation_mirror(local_project_root, &mirror)?;

    match invoke() {
        Ok(response) => {
            complete_mirror_from_response(&mut mirror, &response);
            update_remote_operation_mirror(local_project_root, &mirror)?;
            Ok(response)
        }
        Err(error) => {
            let detail = error.to_string();
            mirror.updated_at = Utc::now().to_rfc3339();
            mirror.error = Some(detail.clone());
            if error.completion_uncertain() {
                mirror.status = RemoteOperationMirrorStatus::Uncertain;
                mirror.partial_effects_possible = true;
                mirror.remote_status = Some("transport_disconnected".to_string());
            } else {
                mirror.status = RemoteOperationMirrorStatus::Failed;
                mirror.finished_at = Some(mirror.updated_at.clone());
                mirror.remote_status = Some("not_dispatched".to_string());
            }
            if let Err(mirror_error) = update_remote_operation_mirror(local_project_root, &mirror) {
                return Err(ToolchainError::InvalidJournal(format!(
                    "could not persist remote transport outcome ({mirror_error}); original error: {detail}"
                )));
            }
            Err(error)
        }
    }
}

fn complete_mirror_from_response(
    mirror: &mut RemoteOperationMirror,
    response: &RemoteHelperResponse,
) {
    let now = Utc::now().to_rfc3339();
    mirror.updated_at = now.clone();
    mirror.finished_at = Some(now);
    mirror.remote_status = Some(response.status.clone());
    mirror.partial_effects_possible = response.partial_effects_possible;
    mirror.error = response.error.clone();
    mirror.remote_journal =
        serde_json::from_value::<OperationJournal>(response.payload.clone()).ok();
    mirror.status = if response.ok {
        RemoteOperationMirrorStatus::Succeeded
    } else {
        RemoteOperationMirrorStatus::Failed
    };
}

fn remote_transport(completion_uncertain: bool, detail: impl Into<String>) -> ToolchainError {
    ToolchainError::RemoteTransport {
        completion_uncertain,
        detail: detail.into(),
    }
}

fn bounded_transport_detail(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(4_096)]).into_owned()
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

    #[test]
    fn ssh_disconnect_after_dispatch_marks_the_local_mirror_uncertain() {
        let root = tempfile::tempdir().unwrap();
        let request = RemoteHelperRequest {
            protocol: 1,
            request_id: "request-disconnect".to_string(),
            target_id: "lab".to_string(),
            project_root: "/remote/project".to_string(),
            rho_toml_sha256: "a".repeat(64),
            target_registry_sha256: "b".repeat(64),
            operation: RemoteHelperOperation::Run,
            payload: serde_json::json!({"operation_id": "run-disconnect"}),
        };
        let result = invoke_remote_effect_with(root.path(), &request, || {
            Err(remote_transport(
                true,
                "SSH connection closed after request dispatch",
            ))
        });
        assert!(result.unwrap_err().completion_uncertain());
        let mirror = crate::read_remote_operation_mirror(root.path(), "run-disconnect").unwrap();
        assert_eq!(mirror.status, RemoteOperationMirrorStatus::Uncertain);
        assert!(mirror.partial_effects_possible);
        assert!(mirror.finished_at.is_none());
        assert_eq!(
            mirror.remote_status.as_deref(),
            Some("transport_disconnected")
        );
    }

    #[test]
    fn ssh_spawn_failure_is_terminal_and_known_not_dispatched() {
        let root = tempfile::tempdir().unwrap();
        let request = RemoteHelperRequest {
            protocol: 1,
            request_id: "request-spawn-failure".to_string(),
            target_id: "lab".to_string(),
            project_root: "/remote/project".to_string(),
            rho_toml_sha256: "a".repeat(64),
            target_registry_sha256: "b".repeat(64),
            operation: RemoteHelperOperation::Run,
            payload: serde_json::json!({"operation_id": "run-spawn-failure"}),
        };
        let result = invoke_remote_effect_with(root.path(), &request, || {
            Err(remote_transport(false, "SSH executable was not found"))
        });
        assert!(!result.unwrap_err().completion_uncertain());
        let mirror = crate::read_remote_operation_mirror(root.path(), "run-spawn-failure").unwrap();
        assert_eq!(mirror.status, RemoteOperationMirrorStatus::Failed);
        assert_eq!(mirror.remote_status.as_deref(), Some("not_dispatched"));
        assert!(mirror.finished_at.is_some());
    }
}
