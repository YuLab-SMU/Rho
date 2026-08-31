use std::io::{BufRead, BufReader, Write};

use anyhow::Result;
use clap::Parser;
use rho_control_plane::{CapabilityRegistry, CapabilitySupport};
use rho_protocol::{DestinationClass, TargetClass};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Parser)]
#[command(name = "rho-mcp", about = "Provider-neutral Rho capability facade")]
struct Cli {}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

fn tool_list() -> Value {
    json!({"tools": [{
        "name": "rho_capabilities",
        "description": "List policy-visible canonical capability descriptors. This facade has no effect authority.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
    }]})
}

fn capability_snapshot() -> Value {
    let registry = CapabilityRegistry::canonical().expect("canonical registry validates");
    let support = CapabilitySupport {
        targets: [
            TargetClass::Workspace,
            TargetClass::ProjectFiles,
            TargetClass::ExternalService,
            TargetClass::LocalProcess,
        ]
        .into_iter()
        .collect(),
        destinations: [
            DestinationClass::LocalWorkspace,
            DestinationClass::LocalSandbox,
            DestinationClass::AllowlistedDomain,
        ]
        .into_iter()
        .collect(),
    };
    serde_json::to_value(registry.read_only_observer_snapshot(&support))
        .expect("snapshot serializes")
}

fn dispatch(request: JsonRpcRequest) -> JsonRpcResponse {
    let result = match request.method.as_str() {
        "initialize" => Some(json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "rho-mcp", "version": env!("CARGO_PKG_VERSION")}
        })),
        "tools/list" => Some(tool_list()),
        "tools/call"
            if request.params.get("name").and_then(Value::as_str) == Some("rho_capabilities") =>
        {
            Some(json!({"content": [{
                "type": "text",
                "text": serde_json::to_string(&capability_snapshot()).unwrap()
            }], "isError": false}))
        }
        _ => None,
    };
    if let Some(result) = result {
        JsonRpcResponse {
            jsonrpc: "2.0",
            id: request.id,
            result: Some(result),
            error: None,
        }
    } else {
        JsonRpcResponse {
            jsonrpc: "2.0",
            id: request.id,
            result: None,
            error: Some(json!({"code": -32601, "message": "method not found or not authorized"})),
        }
    }
}

fn main() -> Result<()> {
    let _cli = Cli::parse();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in BufReader::new(stdin.lock()).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => dispatch(request),
            Err(error) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: Value::Null,
                result: None,
                error: Some(json!({"code": -32700, "message": error.to_string()})),
            },
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_facade_exposes_same_canonical_registry_without_store_or_effect_port() {
        let snapshot = capability_snapshot();
        assert!(snapshot.to_string().contains("workspace.inspect"));
        assert!(
            !snapshot
                .to_string()
                .contains(rho_protocol::RUN_R_CAPABILITY)
        );
        assert!(!snapshot.to_string().contains("network.fetch"));
        let source = include_str!("main.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(!source.contains("rho_store"));
        assert!(!source.contains("SemanticStore"));
        assert!(!source.contains("execute_workspace"));
    }
}
