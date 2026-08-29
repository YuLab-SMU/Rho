use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

use rho_toolchain::{
    ComputeTarget, EnvironmentReceiptMode, OperationJournal, OperationKind, OperationStatus,
    RemoteEffectPayload, RemoteHelperOperation, RemoteHelperRequest, RemoteHelperResponse,
    RemoteInspectPayload, TargetRegistry, TargetRegistryDocument, doctor_local_realization,
    execute_journaled_operation, load_toolchain_config, read_operation_journal,
    write_environment_receipt,
};

const MAX_FRAME_BYTES: u64 = 1024 * 1024;

fn execute_effect(request: &RemoteHelperRequest, kind: OperationKind) -> RemoteHelperResponse {
    let result = (|| {
        let payload: RemoteEffectPayload = serde_json::from_value(request.payload.clone())?;
        let config = load_toolchain_config(Path::new(&request.project_root))?;
        if config.sha256 != request.rho_toml_sha256 {
            return Err(rho_toolchain::ToolchainError::InvalidConfig(
                "remote rho.toml digest changed before execution".to_string(),
            ));
        }
        let expected_mode = match kind {
            OperationKind::Run => EnvironmentReceiptMode::Run,
            OperationKind::Live => EnvironmentReceiptMode::Live,
            _ => unreachable!("remote helper admits only Run/Live here"),
        };
        if payload.environment.execution_id != payload.operation_id
            || payload.environment.mode != expected_mode
        {
            return Err(rho_toolchain::ToolchainError::InvalidReceipt(
                "remote environment receipt identity does not match the operation".to_string(),
            ));
        }
        write_environment_receipt(&config, &payload.environment)?;
        let mut realization = ComputeTarget::local_native();
        realization.capabilities = config.config.compute.required_capabilities.clone();
        let targets = TargetRegistryDocument {
            rho_home: config.project_root.clone(),
            path: config.project_root.join("targets.yaml"),
            sha256: Some(request.target_registry_sha256.clone()),
            registry: TargetRegistry {
                targets: BTreeMap::from([(request.target_id.clone(), realization)]),
            },
        };
        let journal = execute_journaled_operation(
            &config,
            &payload.operation_id,
            kind,
            &[payload.command],
            &targets,
            payload.confirmed,
        )?;
        Ok::<OperationJournal, rho_toolchain::ToolchainError>(journal)
    })();
    match result {
        Ok(journal) => RemoteHelperResponse {
            protocol: request.protocol,
            request_id: request.request_id.clone(),
            target_id: request.target_id.clone(),
            ok: true,
            status: "completed".to_string(),
            payload: serde_json::to_value(journal).unwrap_or(serde_json::Value::Null),
            error: None,
            partial_effects_possible: false,
        },
        Err(error) => {
            let partial = serde_json::from_value::<RemoteEffectPayload>(request.payload.clone())
                .ok()
                .and_then(|payload| {
                    read_operation_journal(Path::new(&request.project_root), &payload.operation_id)
                        .ok()
                })
                .is_some_and(|journal| journal.partial_effects_possible);
            RemoteHelperResponse {
                protocol: request.protocol,
                request_id: request.request_id.clone(),
                target_id: request.target_id.clone(),
                ok: false,
                status: "failed".to_string(),
                payload: serde_json::Value::Null,
                error: Some(error.to_string()),
                partial_effects_possible: partial,
            }
        }
    }
}

fn inspect_operation(request: &RemoteHelperRequest) -> RemoteHelperResponse {
    let result = (|| {
        let payload: RemoteInspectPayload = serde_json::from_value(request.payload.clone())?;
        let config = load_toolchain_config(Path::new(&request.project_root))?;
        if config.sha256 != request.rho_toml_sha256
            || config.config.compute.default_target != request.target_id
        {
            return Err(rho_toolchain::ToolchainError::InvalidConfig(
                "remote operation identity changed before inspection".to_string(),
            ));
        }
        let journal = read_operation_journal(&config.project_root, &payload.operation_id)?;
        if journal.target_id != request.target_id
            || journal.target_registry_sha256.as_deref()
                != Some(request.target_registry_sha256.as_str())
        {
            return Err(rho_toolchain::ToolchainError::InvalidJournal(
                "remote operation target identity differs from the inspection request".to_string(),
            ));
        }
        Ok::<OperationJournal, rho_toolchain::ToolchainError>(journal)
    })();
    match result {
        Ok(journal) => RemoteHelperResponse {
            protocol: request.protocol,
            request_id: request.request_id.clone(),
            target_id: request.target_id.clone(),
            ok: true,
            status: match journal.status {
                OperationStatus::Running => "running",
                OperationStatus::Succeeded => "succeeded",
                OperationStatus::Failed => "failed",
            }
            .to_string(),
            payload: serde_json::to_value(&journal).unwrap(),
            error: None,
            partial_effects_possible: journal.partial_effects_possible,
        },
        Err(error) => {
            let status = if matches!(
                &error,
                rho_toolchain::ToolchainError::Io(io_error)
                    if io_error.kind() == std::io::ErrorKind::NotFound
            ) {
                "not_found"
            } else {
                "failed"
            };
            RemoteHelperResponse {
                protocol: request.protocol,
                request_id: request.request_id.clone(),
                target_id: request.target_id.clone(),
                ok: false,
                status: status.to_string(),
                payload: serde_json::Value::Null,
                error: Some(error.to_string()),
                partial_effects_possible: false,
            }
        }
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() != Some("--stdio") {
        eprintln!("rho-toolchain-helper requires --stdio");
        std::process::exit(2);
    }
    let mut bytes = Vec::new();
    if std::io::stdin()
        .take(MAX_FRAME_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_FRAME_BYTES
    {
        eprintln!("remote helper request exceeded its frame bound");
        std::process::exit(2);
    }
    let request: RemoteHelperRequest = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(_) => {
            eprintln!("remote helper request was invalid");
            std::process::exit(2);
        }
    };
    let response = match request.operation {
        RemoteHelperOperation::Doctor => {
            match doctor_local_realization(Path::new(&request.project_root)) {
                Ok(report) => RemoteHelperResponse {
                    protocol: request.protocol,
                    request_id: request.request_id,
                    target_id: request.target_id,
                    ok: true,
                    status: "completed".to_string(),
                    payload: serde_json::to_value(report).unwrap_or(serde_json::Value::Null),
                    error: None,
                    partial_effects_possible: false,
                },
                Err(error) => RemoteHelperResponse {
                    protocol: request.protocol,
                    request_id: request.request_id,
                    target_id: request.target_id,
                    ok: false,
                    status: "failed".to_string(),
                    payload: serde_json::Value::Null,
                    error: Some(error.to_string()),
                    partial_effects_possible: false,
                },
            }
        }
        RemoteHelperOperation::InspectOperation => inspect_operation(&request),
        RemoteHelperOperation::Run => execute_effect(&request, OperationKind::Run),
        RemoteHelperOperation::Live => execute_effect(&request, OperationKind::Live),
        _ => RemoteHelperResponse {
            protocol: request.protocol,
            request_id: request.request_id,
            target_id: request.target_id,
            ok: false,
            status: "unsupported".to_string(),
            payload: serde_json::Value::Null,
            error: Some("remote effect operation is not admitted yet".to_string()),
            partial_effects_possible: false,
        },
    };
    let encoded = serde_json::to_vec(&response).unwrap();
    if encoded.len() as u64 > MAX_FRAME_BYTES {
        eprintln!("remote helper response exceeded its frame bound");
        std::process::exit(2);
    }
    std::io::stdout().write_all(&encoded).unwrap();
}
