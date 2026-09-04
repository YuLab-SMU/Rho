#![forbid(unsafe_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use rho_control_plane::canonical_capabilities;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_RHO_MCP_CONTEXT_BYTES: u64 = 16 * 1024 * 1024;

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

#[derive(Debug, Clone)]
struct GatewayConfig {
    address: String,
    token: String,
}

impl GatewayConfig {
    fn from_environment() -> Option<Self> {
        let address = std::env::var("RHO_AGENT_GATEWAY_ADDR").ok()?;
        let token = std::env::var("RHO_AGENT_GATEWAY_TOKEN").ok()?;
        (!address.is_empty() && !token.is_empty()).then_some(Self { address, token })
    }
}

fn tool_list(gateway_available: bool) -> Value {
    let mut tools = vec![
        json!({
            "name": "rho_capabilities",
            "description": "List every typed Rho capability, including its input schema and execution metadata.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        }),
        json!({
            "name": "rho_state",
            "description": "Read the bounded Rho Workspace, project and snapshot state captured for this Agent turn.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        }),
    ];
    if gateway_available {
        tools.push(json!({
            "name": "rho_execute",
            "description": "Execute a typed Rho capability against the live Workspace and return its authoritative result.",
            "inputSchema": {
                "type": "object",
                "required": ["capability_id", "arguments"],
                "additionalProperties": false,
                "properties": {
                    "capability_id": {"type": "string", "minLength": 1},
                    "arguments": {"type": "object"}
                }
            }
        }));
    }
    json!({"tools": tools})
}

fn text_result(value: &Value) -> Value {
    json!({"content": [{
        "type": "text",
        "text": serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
    }], "isError": false})
}

fn tool_error(message: impl Into<String>) -> Value {
    json!({"content": [{"type": "text", "text": message.into()}], "isError": true})
}

fn execute_through_gateway(config: &GatewayConfig, arguments: &Value) -> Result<Value> {
    let capability_id = arguments
        .get("capability_id")
        .and_then(Value::as_str)
        .context("rho_execute requires capability_id")?;
    let capability_arguments = arguments
        .get("arguments")
        .cloned()
        .context("rho_execute requires arguments")?;
    ensure!(
        capability_arguments.is_object(),
        "rho_execute arguments must be an object"
    );
    let mut stream =
        TcpStream::connect(&config.address).context("connecting to Rho Agent Gateway")?;
    stream.set_read_timeout(Some(Duration::from_secs(300)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    exchange_with_gateway(&mut stream, config, capability_id, capability_arguments)
}

fn exchange_with_gateway(
    stream: &mut (impl Read + Write),
    config: &GatewayConfig,
    capability_id: &str,
    capability_arguments: Value,
) -> Result<Value> {
    serde_json::to_writer(
        &mut *stream,
        &json!({
            "token": config.token,
            "capability_id": capability_id,
            "arguments": capability_arguments,
        }),
    )?;
    writeln!(&mut *stream)?;
    stream.flush()?;
    let mut response = String::new();
    BufReader::new(stream)
        .take(MAX_RHO_MCP_CONTEXT_BYTES + 1)
        .read_line(&mut response)?;
    ensure!(
        response.len() as u64 <= MAX_RHO_MCP_CONTEXT_BYTES,
        "Rho Agent Gateway response exceeds its byte bound"
    );
    serde_json::from_str(&response).context("decoding Rho Agent Gateway response")
}

fn dispatch(
    request: JsonRpcRequest,
    state: &Value,
    gateway: Option<&GatewayConfig>,
) -> JsonRpcResponse {
    let result = match request.method.as_str() {
        "initialize" => Some(json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": "rho-mcp", "version": env!("CARGO_PKG_VERSION")}
        })),
        "tools/list" => Some(tool_list(gateway.is_some())),
        "tools/call"
            if request.params.get("name").and_then(Value::as_str) == Some("rho_capabilities") =>
        {
            Some(text_result(&json!({
                "capabilities": serde_json::to_value(canonical_capabilities())
                    .unwrap_or_else(|_| Value::Array(Vec::new())),
                "live_capabilities": state
                    .pointer("/state/live_capabilities")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
            })))
        }
        "tools/call" if request.params.get("name").and_then(Value::as_str) == Some("rho_state") => {
            Some(text_result(state))
        }
        "tools/call"
            if request.params.get("name").and_then(Value::as_str) == Some("rho_execute") =>
        {
            Some(match gateway {
                Some(gateway) => match execute_through_gateway(
                    gateway,
                    request.params.get("arguments").unwrap_or(&Value::Null),
                ) {
                    Ok(response) if response.get("ok").and_then(Value::as_bool) == Some(true) => {
                        text_result(response.get("result").unwrap_or(&Value::Null))
                    }
                    Ok(response) => tool_error(
                        response
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Rho capability execution failed"),
                    ),
                    Err(error) => tool_error(error.to_string()),
                },
                None => tool_error("Rho live capability gateway is unavailable"),
            })
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
            error: Some(json!({"code": -32601, "message": "method not found"})),
        }
    }
}

pub fn read_context_file(path: &Path) -> Result<Value> {
    let metadata = std::fs::symlink_metadata(path).context("reading Rho MCP context metadata")?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Rho MCP context is not a regular file"
    );
    ensure!(
        metadata.len() <= MAX_RHO_MCP_CONTEXT_BYTES,
        "Rho MCP context exceeds its byte bound"
    );
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(path)
        .context("opening Rho MCP context")?
        .take(MAX_RHO_MCP_CONTEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("reading Rho MCP context")?;
    ensure!(
        bytes.len() as u64 <= MAX_RHO_MCP_CONTEXT_BYTES,
        "Rho MCP context exceeds its byte bound"
    );
    serde_json::from_slice(&bytes).context("parsing Rho MCP context")
}

fn serve_with_gateway(
    reader: impl Read,
    mut writer: impl Write,
    state: Value,
    gateway: Option<GatewayConfig>,
) -> Result<()> {
    for line in BufReader::new(reader).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) if request.id.is_null() => continue,
            Ok(request) => dispatch(request, &state, gateway.as_ref()),
            Err(error) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: Value::Null,
                result: None,
                error: Some(json!({"code": -32700, "message": error.to_string()})),
            },
        };
        serde_json::to_writer(&mut writer, &response)?;
        writeln!(writer)?;
        writer.flush()?;
    }
    Ok(())
}

pub fn serve(reader: impl Read, writer: impl Write, state: Value) -> Result<()> {
    serve_with_gateway(reader, writer, state, None)
}

pub fn serve_stdio(context_path: Option<&Path>) -> Result<()> {
    let state = match context_path {
        Some(path) => read_context_file(path)?,
        None => json!({"schema": "rho.agent-state.v1", "status": "no_live_context"}),
    };
    serve_with_gateway(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        state,
        GatewayConfig::from_environment(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_exposes_complete_capability_schemas_and_bounded_turn_state() {
        let input = [
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rho_capabilities","arguments":{}}}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rho_state","arguments":{}}}"#,
        ]
        .join("\n");
        let mut output = Vec::new();
        serve(
            input.as_bytes(),
            &mut output,
            json!({"workspace": {"project_revision": 7}}),
        )
        .unwrap();
        let lines = String::from_utf8(output).unwrap();
        assert!(lines.contains("rho_capabilities"));
        assert!(lines.contains("rho_state"));
        assert!(lines.contains("workspace.run_r"));
        assert!(lines.contains("project.apply_patch"));
        assert!(lines.contains("input_schema"));
        assert!(lines.contains("project_revision"));
    }

    #[test]
    fn mcp_forwards_live_capability_calls_through_the_turn_gateway() {
        struct MemoryGateway {
            response: std::io::Cursor<Vec<u8>>,
            request: Vec<u8>,
        }
        impl Read for MemoryGateway {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.response.read(bytes)
            }
        }
        impl Write for MemoryGateway {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.request.extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let config = GatewayConfig {
            address: "127.0.0.1:1".to_string(),
            token: "turn-token".to_string(),
        };
        let mut stream = MemoryGateway {
            response: std::io::Cursor::new(
                format!("{}\n", json!({"ok": true, "result": {"objects": 3}})).into_bytes(),
            ),
            request: Vec::new(),
        };
        let response = exchange_with_gateway(
            &mut stream,
            &config,
            "workspace.inspect",
            json!({"query": "everything"}),
        )
        .unwrap();
        assert_eq!(response["result"]["objects"], 3);
        let request: Value = serde_json::from_slice(&stream.request).unwrap();
        assert_eq!(request["token"], "turn-token");
        assert_eq!(request["capability_id"], "workspace.inspect");
        assert!(tool_list(true).to_string().contains("rho_execute"));
    }
}
