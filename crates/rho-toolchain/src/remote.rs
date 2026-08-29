use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    CommandSpec, ComputeHost, ComputeTarget, EnvironmentReceipt, OperationJournal, OperationKind,
    OperationStatus, RemoteOperationMirror, RemoteOperationMirrorStatus, ToolchainError,
    create_remote_operation_mirror, read_remote_operation_mirror, remote_operation_mirror_path,
    update_remote_operation_mirror, validate_target_id,
};

const MAX_REMOTE_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_REMOTE_RESPONSE_BYTES: usize = 3 * 1024 * 1024;
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
    pub commands: Vec<CommandSpec>,
    pub environment: Option<EnvironmentReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteInspectPayload {
    pub operation_id: String,
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
        || scan.stdout.len() > MAX_REMOTE_REQUEST_BYTES
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
    if request_bytes.len() > MAX_REMOTE_REQUEST_BYTES {
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
    if output.stdout.len() > MAX_REMOTE_RESPONSE_BYTES {
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

/// Read the durable remote journal and converge a dispatching or uncertain
/// local mirror. This operation is read-only and never reruns the effect.
pub fn reconcile_remote_operation(
    local_project_root: &Path,
    target_id: &str,
    target: &ComputeTarget,
    operation_id: &str,
) -> Result<RemoteOperationMirror, ToolchainError> {
    reconcile_remote_operation_with(local_project_root, operation_id, |request| {
        invoke_remote_helper(target_id, target, request)
    })
}

fn reconcile_remote_operation_with<F>(
    local_project_root: &Path,
    operation_id: &str,
    inspect: F,
) -> Result<RemoteOperationMirror, ToolchainError>
where
    F: FnOnce(&RemoteHelperRequest) -> Result<RemoteHelperResponse, ToolchainError>,
{
    let mut mirror = read_remote_operation_mirror(local_project_root, operation_id)?;
    if mirror.status.is_terminal() {
        return Ok(mirror);
    }
    if mirror.status == RemoteOperationMirrorStatus::Prepared {
        return Err(ToolchainError::InvalidJournal(
            "a prepared remote operation was never dispatched and cannot be inspected".to_string(),
        ));
    }
    let request = RemoteHelperRequest {
        protocol: REMOTE_HELPER_PROTOCOL,
        request_id: format!("inspect-{}", &mirror.request_sha256[..32]),
        target_id: mirror.target_id.clone(),
        project_root: mirror.remote_project_root.clone(),
        rho_toml_sha256: mirror.rho_toml_sha256.clone(),
        target_registry_sha256: mirror.target_registry_sha256.clone(),
        operation: RemoteHelperOperation::InspectOperation,
        payload: serde_json::to_value(RemoteInspectPayload {
            operation_id: mirror.operation_id.clone(),
        })?,
    };
    let response = match inspect(&request) {
        Ok(response) => response,
        Err(error) => {
            preserve_reconciliation_uncertainty(
                local_project_root,
                &mut mirror,
                format!("InspectOperation transport failed: {error}"),
            )?;
            return Err(error);
        }
    };
    if !response.ok {
        if response.status == "not_found" && !response.partial_effects_possible {
            let now = Utc::now().to_rfc3339();
            mirror.status = RemoteOperationMirrorStatus::Failed;
            mirror.updated_at = now.clone();
            mirror.finished_at = Some(now);
            mirror.partial_effects_possible = false;
            mirror.remote_status = Some(response.status);
            mirror.remote_journal = None;
            mirror.error = Some(response.error.unwrap_or_else(|| {
                "remote operation journal was not created; no command was admitted".to_string()
            }));
            update_remote_operation_mirror(local_project_root, &mirror)?;
            return Ok(mirror);
        }
        let detail = response
            .error
            .unwrap_or_else(|| format!("InspectOperation returned {}", response.status));
        preserve_reconciliation_uncertainty(local_project_root, &mut mirror, detail.clone())?;
        return Err(ToolchainError::CommandFailed(detail));
    }
    let journal: OperationJournal = match serde_json::from_value(response.payload) {
        Ok(journal) => journal,
        Err(error) => {
            let error = ToolchainError::InvalidJournal(format!(
                "InspectOperation returned an invalid journal: {error}"
            ));
            preserve_reconciliation_uncertainty(
                local_project_root,
                &mut mirror,
                error.to_string(),
            )?;
            return Err(error);
        }
    };
    if let Err(error) = validate_reconciled_journal(&mirror, &journal, &response.status) {
        preserve_reconciliation_uncertainty(local_project_root, &mut mirror, error.to_string())?;
        return Err(error);
    }
    mirror.updated_at = Utc::now().to_rfc3339();
    mirror.remote_status = Some(response.status);
    mirror.remote_journal = Some(journal.clone());
    match journal.status {
        OperationStatus::Running => {
            mirror.status = RemoteOperationMirrorStatus::Uncertain;
            mirror.finished_at = None;
            mirror.partial_effects_possible = true;
            mirror.error = Some("remote operation is still running".to_string());
        }
        OperationStatus::Succeeded => {
            mirror.status = RemoteOperationMirrorStatus::Succeeded;
            mirror.finished_at = journal
                .finished_at
                .clone()
                .or_else(|| Some(mirror.updated_at.clone()));
            mirror.partial_effects_possible = false;
            mirror.error = None;
        }
        OperationStatus::Failed => {
            mirror.status = RemoteOperationMirrorStatus::Failed;
            mirror.finished_at = journal
                .finished_at
                .clone()
                .or_else(|| Some(mirror.updated_at.clone()));
            mirror.partial_effects_possible = journal.partial_effects_possible;
            mirror.error = journal
                .error
                .clone()
                .or_else(|| Some("remote operation failed".to_string()));
        }
    }
    update_remote_operation_mirror(local_project_root, &mirror)?;
    Ok(mirror)
}

fn preserve_reconciliation_uncertainty(
    local_project_root: &Path,
    mirror: &mut RemoteOperationMirror,
    detail: String,
) -> Result<(), ToolchainError> {
    mirror.status = RemoteOperationMirrorStatus::Uncertain;
    mirror.updated_at = Utc::now().to_rfc3339();
    mirror.finished_at = None;
    mirror.partial_effects_possible = true;
    mirror.remote_status = Some("inspection_unavailable".to_string());
    mirror.error = Some(detail);
    update_remote_operation_mirror(local_project_root, mirror)
}

fn validate_reconciled_journal(
    mirror: &RemoteOperationMirror,
    journal: &OperationJournal,
    response_status: &str,
) -> Result<(), ToolchainError> {
    let expected_kind = match mirror.operation {
        RemoteHelperOperation::Run => OperationKind::Run,
        RemoteHelperOperation::Live => OperationKind::Live,
        RemoteHelperOperation::Sync => OperationKind::Sync,
        RemoteHelperOperation::Lock => OperationKind::Lock,
        RemoteHelperOperation::Doctor | RemoteHelperOperation::InspectOperation => {
            return Err(ToolchainError::InvalidJournal(
                "local mirror contains a non-effect operation".to_string(),
            ));
        }
    };
    let expected_status = match journal.status {
        OperationStatus::Running => "running",
        OperationStatus::Succeeded => "succeeded",
        OperationStatus::Failed => "failed",
    };
    if journal.operation_id != mirror.operation_id
        || journal.kind != expected_kind
        || journal.project_root != Path::new(&mirror.remote_project_root)
        || journal.rho_toml_sha256 != mirror.rho_toml_sha256
        || journal.target_id != mirror.target_id
        || journal.target_registry_sha256.as_deref() != Some(mirror.target_registry_sha256.as_str())
        || response_status != expected_status
    {
        return Err(ToolchainError::InvalidJournal(
            "InspectOperation journal identity or status differs from the local mirror".to_string(),
        ));
    }
    Ok(())
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
    let mirror_path = remote_operation_mirror_path(local_project_root, operation_id)?;
    if mirror_path.exists() {
        let existing = read_remote_operation_mirror(local_project_root, operation_id)?;
        if !existing.matches_request(request)? {
            return Err(ToolchainError::InvalidJournal(format!(
                "remote operation identity {operation_id} is already bound to another request"
            )));
        }
        if matches!(
            existing.status,
            RemoteOperationMirrorStatus::Dispatching | RemoteOperationMirrorStatus::Uncertain
        ) {
            return Err(ToolchainError::RemoteOperationUncertain(
                operation_id.to_string(),
            ));
        }
        return Err(ToolchainError::InvalidJournal(format!(
            "remote operation identity already exists in {:?} state: {operation_id}; use a new operation identity",
            existing.status
        )));
    }
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
    mirror.remote_status = Some(response.status.clone());
    mirror.partial_effects_possible = response.partial_effects_possible;
    mirror.error = response.error.clone();
    mirror.remote_journal =
        serde_json::from_value::<OperationJournal>(response.payload.clone()).ok();
    mirror.status = if response.ok {
        mirror.finished_at = Some(now);
        RemoteOperationMirrorStatus::Succeeded
    } else if response.status == "uncertain" {
        mirror.finished_at = None;
        mirror.partial_effects_possible = true;
        if mirror.error.is_none() {
            mirror.error = Some("remote helper could not persist terminal truth".to_string());
        }
        RemoteOperationMirrorStatus::Uncertain
    } else {
        mirror.finished_at = Some(now);
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
        assert!(encoded.len() < MAX_REMOTE_REQUEST_BYTES);
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

    fn uncertain_request(operation_id: &str) -> RemoteHelperRequest {
        RemoteHelperRequest {
            protocol: 1,
            request_id: format!("request-{operation_id}"),
            target_id: "lab".to_string(),
            project_root: "/remote/project".to_string(),
            rho_toml_sha256: "a".repeat(64),
            target_registry_sha256: "b".repeat(64),
            operation: RemoteHelperOperation::Run,
            payload: serde_json::json!({"operation_id": operation_id}),
        }
    }

    fn inspected_journal(operation_id: &str, status: OperationStatus) -> OperationJournal {
        OperationJournal {
            schema_version: 1,
            operation_id: operation_id.to_string(),
            kind: OperationKind::Run,
            status,
            project_root: Path::new("/remote/project").to_path_buf(),
            rho_toml_sha256: "a".repeat(64),
            target_id: "lab".to_string(),
            target_registry_sha256: Some("b".repeat(64)),
            host_kind: "local".to_string(),
            isolation_kind: "native".to_string(),
            started_at: "2026-09-01T00:00:00Z".to_string(),
            finished_at: (status != OperationStatus::Running)
                .then(|| "2026-09-01T00:00:01Z".to_string()),
            partial_effects_possible: status == OperationStatus::Failed,
            effects: Vec::new(),
            error: (status == OperationStatus::Failed).then(|| "effect failed".to_string()),
        }
    }

    #[test]
    fn uncertain_operation_cannot_be_blindly_dispatched_again() {
        let root = tempfile::tempdir().unwrap();
        let request = uncertain_request("run-no-blind-retry");
        let _ = invoke_remote_effect_with(root.path(), &request, || {
            Err(remote_transport(true, "connection reset"))
        });
        let error = invoke_remote_effect_with(root.path(), &request, || {
            panic!("uncertain operation reached the SSH transport twice")
        })
        .unwrap_err();
        assert!(matches!(
            error,
            ToolchainError::RemoteOperationUncertain(ref id) if id == "run-no-blind-retry"
        ));
        assert!(error.completion_uncertain());
        let mirror =
            crate::read_remote_operation_mirror(root.path(), "run-no-blind-retry").unwrap();
        assert_eq!(mirror.status, RemoteOperationMirrorStatus::Uncertain);
        assert!(mirror.finished_at.is_none());
    }

    #[test]
    fn inspect_operation_converges_uncertain_mirror_to_remote_success() {
        let root = tempfile::tempdir().unwrap();
        let request = uncertain_request("run-reconciled");
        let _ = invoke_remote_effect_with(root.path(), &request, || {
            Err(remote_transport(true, "connection reset"))
        });
        let mirror = reconcile_remote_operation_with(root.path(), "run-reconciled", |inspect| {
            assert_eq!(inspect.operation, RemoteHelperOperation::InspectOperation);
            assert_eq!(inspect.payload["operation_id"], "run-reconciled");
            Ok(RemoteHelperResponse {
                protocol: 1,
                request_id: inspect.request_id.clone(),
                target_id: "lab".to_string(),
                ok: true,
                status: "succeeded".to_string(),
                payload: serde_json::to_value(inspected_journal(
                    "run-reconciled",
                    OperationStatus::Succeeded,
                ))
                .unwrap(),
                error: None,
                partial_effects_possible: false,
            })
        })
        .unwrap();
        assert_eq!(mirror.status, RemoteOperationMirrorStatus::Succeeded);
        assert!(mirror.finished_at.is_some());
        assert!(mirror.remote_journal.is_some());
        assert!(!mirror.partial_effects_possible);
    }

    #[test]
    fn inspect_not_found_converges_to_known_no_command_admission() {
        let root = tempfile::tempdir().unwrap();
        let request = uncertain_request("run-not-found");
        let _ = invoke_remote_effect_with(root.path(), &request, || {
            Err(remote_transport(true, "connection reset"))
        });
        let mirror = reconcile_remote_operation_with(root.path(), "run-not-found", |inspect| {
            Ok(RemoteHelperResponse {
                protocol: 1,
                request_id: inspect.request_id.clone(),
                target_id: "lab".to_string(),
                ok: false,
                status: "not_found".to_string(),
                payload: serde_json::Value::Null,
                error: Some("journal does not exist".to_string()),
                partial_effects_possible: false,
            })
        })
        .unwrap();
        assert_eq!(mirror.status, RemoteOperationMirrorStatus::Failed);
        assert!(!mirror.partial_effects_possible);
        assert_eq!(mirror.remote_status.as_deref(), Some("not_found"));
    }
}
