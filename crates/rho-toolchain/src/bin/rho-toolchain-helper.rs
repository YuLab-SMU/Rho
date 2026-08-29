use std::io::{Read, Write};
use std::path::Path;

use rho_toolchain::{
    RemoteHelperOperation, RemoteHelperRequest, RemoteHelperResponse, doctor_local_realization,
};

const MAX_FRAME_BYTES: u64 = 1024 * 1024;

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
