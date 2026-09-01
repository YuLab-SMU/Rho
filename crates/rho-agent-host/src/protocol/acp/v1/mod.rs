//! Isolated ACP v1 JSON-RPC codec.
//!
//! Wire DTOs are private to this module. Consumers receive only neutral decoded
//! events, so an SDK/wire revision cannot enter canonical Rho contracts.

use std::collections::{BTreeSet, VecDeque};

use rho_protocol::{CapabilityId, OperationId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

pub const ACP_V1_PROTOCOL: &str = "1";
pub const ACP_SDK_PIN: &str = "agent-client-protocol@0.8.1";
pub const MAX_ACP_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_ACP_DEPTH: usize = 24;
pub const MAX_ACP_STRING_BYTES: usize = 64 * 1024;
pub const MAX_ACP_ARRAY_ITEMS: usize = 1024;
pub const MAX_ACP_QUEUE: usize = 256;
pub const MAX_ACP_DIAGNOSTIC_BYTES: usize = 2048;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NegotiatedAcpV1 {
    pub protocol: String,
    pub provider_version: String,
    pub supports_resume: bool,
    pub supports_cancel: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NeutralAcpEvent {
    Initialized {
        negotiated: NegotiatedAcpV1,
    },
    SessionCreated {
        external_session_id: String,
    },
    SessionClosed {
        external_session_id: String,
    },
    MessageDelta {
        cursor: u64,
        text: String,
    },
    PlanReplaced {
        plan_id: String,
    },
    ToolRequested {
        capability_id: CapabilityId,
        operation_id: OperationId,
        arguments: Value,
    },
    ToolReportedTerminal {
        operation_id: OperationId,
        outcome: String,
    },
    ProviderPermissionHint {
        capability_id: CapabilityId,
        hint: String,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    Terminal {
        outcome: String,
    },
    Diagnostic {
        code: String,
        detail: String,
    },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AcpV1CodecError {
    #[error("ACP frame exceeds byte bound")]
    FrameTooLarge,
    #[error("ACP partial-frame buffer exceeds byte bound")]
    PartialFrameTooLarge,
    #[error("ACP JSON is malformed")]
    Malformed,
    #[error("ACP JSON exceeds nesting, string, array, or object bound")]
    JsonBounds,
    #[error("ACP JSON-RPC version is not 2.0")]
    JsonRpcVersion,
    #[error("ACP v1 negotiation rejected protocol {0}")]
    UnsupportedProtocol(String),
    #[error("ACP message id is duplicated")]
    DuplicateId,
    #[error("ACP response id is out of order")]
    OutOfOrderResponse,
    #[error("ACP decoded event queue exceeds bound")]
    QueueOverflow,
    #[error("ACP request id cannot be empty")]
    InvalidRequestId,
}

#[derive(Debug, Clone, Deserialize)]
struct WireMessage {
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Value,
}

#[derive(Debug, Serialize)]
struct WireRequest<'a> {
    jsonrpc: &'static str,
    id: &'a str,
    method: &'a str,
    params: Value,
}

#[derive(Debug, Default)]
pub struct AcpV1Codec {
    partial: Vec<u8>,
    seen_inbound_ids: BTreeSet<String>,
    pending_response_ids: VecDeque<String>,
    decoded: VecDeque<NeutralAcpEvent>,
    negotiated: Option<NegotiatedAcpV1>,
}

impl AcpV1Codec {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn encode_request(
        &mut self,
        id: &str,
        method: &str,
        params: Value,
    ) -> Result<Vec<u8>, AcpV1CodecError> {
        if id.is_empty() {
            return Err(AcpV1CodecError::InvalidRequestId);
        }
        validate_json_bounds(&params)?;
        let mut bytes = serde_json::to_vec(&WireRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        })
        .map_err(|_| AcpV1CodecError::Malformed)?;
        if bytes.len() > MAX_ACP_FRAME_BYTES {
            return Err(AcpV1CodecError::FrameTooLarge);
        }
        bytes.push(b'\n');
        self.pending_response_ids.push_back(id.to_string());
        if self.pending_response_ids.len() > MAX_ACP_QUEUE {
            return Err(AcpV1CodecError::QueueOverflow);
        }
        Ok(bytes)
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Result<(), AcpV1CodecError> {
        if self.partial.len().saturating_add(chunk.len()) > MAX_ACP_FRAME_BYTES {
            return Err(AcpV1CodecError::PartialFrameTooLarge);
        }
        self.partial.extend_from_slice(chunk);
        while let Some(newline) = self.partial.iter().position(|byte| *byte == b'\n') {
            let line = self.partial.drain(..=newline).collect::<Vec<_>>();
            let frame = &line[..line.len().saturating_sub(1)];
            if frame.is_empty() {
                continue;
            }
            self.decode_frame(frame)?;
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<(), AcpV1CodecError> {
        if self.partial.is_empty() {
            Ok(())
        } else {
            Err(AcpV1CodecError::Malformed)
        }
    }

    pub fn pop_event(&mut self) -> Option<NeutralAcpEvent> {
        self.decoded.pop_front()
    }

    pub fn negotiated(&self) -> Option<&NegotiatedAcpV1> {
        self.negotiated.as_ref()
    }

    fn decode_frame(&mut self, frame: &[u8]) -> Result<(), AcpV1CodecError> {
        if frame.len() > MAX_ACP_FRAME_BYTES {
            return Err(AcpV1CodecError::FrameTooLarge);
        }
        let raw: Value = serde_json::from_slice(frame).map_err(|_| AcpV1CodecError::Malformed)?;
        validate_json_bounds(&raw)?;
        let wire: WireMessage =
            serde_json::from_value(raw).map_err(|_| AcpV1CodecError::Malformed)?;
        if wire.jsonrpc != "2.0" {
            return Err(AcpV1CodecError::JsonRpcVersion);
        }
        if let Some(id) = &wire.id {
            let id = scalar_id(id).ok_or(AcpV1CodecError::Malformed)?;
            if !self.seen_inbound_ids.insert(id.clone()) {
                return Err(AcpV1CodecError::DuplicateId);
            }
            if wire.method.is_none() && (!wire.result.is_null() || !wire.error.is_null()) {
                let expected = self
                    .pending_response_ids
                    .pop_front()
                    .ok_or(AcpV1CodecError::OutOfOrderResponse)?;
                if expected != id {
                    return Err(AcpV1CodecError::OutOfOrderResponse);
                }
            }
        }
        let Some(method) = wire.method.as_deref() else {
            if !wire.error.is_null() {
                self.push(NeutralAcpEvent::Diagnostic {
                    code: "provider_error".to_string(),
                    detail: "provider returned a bounded protocol error".to_string(),
                })?;
            }
            return Ok(());
        };
        let event = map_method(method, &wire.params)?;
        if let NeutralAcpEvent::Initialized { negotiated } = &event {
            self.negotiated = Some(negotiated.clone());
        }
        self.push(event)
    }

    fn push(&mut self, event: NeutralAcpEvent) -> Result<(), AcpV1CodecError> {
        if self.decoded.len() >= MAX_ACP_QUEUE {
            return Err(AcpV1CodecError::QueueOverflow);
        }
        self.decoded.push_back(event);
        Ok(())
    }
}

fn map_method(method: &str, params: &Value) -> Result<NeutralAcpEvent, AcpV1CodecError> {
    Ok(match method {
        "initialized" => {
            let protocol = text(params, "protocolVersion").unwrap_or(ACP_V1_PROTOCOL);
            if protocol != ACP_V1_PROTOCOL {
                return Err(AcpV1CodecError::UnsupportedProtocol(protocol.to_string()));
            }
            NeutralAcpEvent::Initialized {
                negotiated: NegotiatedAcpV1 {
                    protocol: protocol.to_string(),
                    provider_version: bounded_text(params, "providerVersion", "unknown"),
                    supports_resume: boolean(params, "supportsResume"),
                    supports_cancel: boolean(params, "supportsCancel"),
                },
            }
        }
        "session/created" => NeutralAcpEvent::SessionCreated {
            external_session_id: bounded_text(params, "sessionId", "missing"),
        },
        "session/closed" => NeutralAcpEvent::SessionClosed {
            external_session_id: bounded_text(params, "sessionId", "missing"),
        },
        "session/update" if text(params, "updateType") == Some("message_delta") => {
            NeutralAcpEvent::MessageDelta {
                cursor: integer(params, "cursor"),
                text: bounded_text(params, "text", ""),
            }
        }
        "session/update" if text(params, "updateType") == Some("plan") => {
            NeutralAcpEvent::PlanReplaced {
                plan_id: bounded_text(params, "planId", "provider_plan"),
            }
        }
        "session/update" if text(params, "updateType") == Some("tool_request") => {
            let tool = bounded_text(params, "tool", "unsupported");
            NeutralAcpEvent::ToolRequested {
                capability_id: map_tool(&tool),
                operation_id: OperationId::new(format!(
                    "operation_acp_{}",
                    bounded_text(params, "callId", "missing")
                ))
                .unwrap_or_else(|_| OperationId::generate()),
                arguments: params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            }
        }
        "session/update" if text(params, "updateType") == Some("tool_terminal") => {
            NeutralAcpEvent::ToolReportedTerminal {
                operation_id: OperationId::new(format!(
                    "operation_acp_{}",
                    bounded_text(params, "callId", "missing")
                ))
                .unwrap_or_else(|_| OperationId::generate()),
                outcome: bounded_text(params, "outcome", "unknown"),
            }
        }
        "session/update" if text(params, "updateType") == Some("permission") => {
            NeutralAcpEvent::ProviderPermissionHint {
                capability_id: map_tool(&bounded_text(params, "tool", "unsupported")),
                hint: bounded_text(params, "hint", "provider requested permission"),
            }
        }
        "session/update" if text(params, "updateType") == Some("usage") => NeutralAcpEvent::Usage {
            input_tokens: integer(params, "inputTokens"),
            output_tokens: integer(params, "outputTokens"),
        },
        "session/update" if text(params, "updateType") == Some("terminal") => {
            NeutralAcpEvent::Terminal {
                outcome: bounded_text(params, "outcome", "failed"),
            }
        }
        _ => NeutralAcpEvent::Diagnostic {
            code: "unsupported_extension".to_string(),
            detail: format!("unsupported ACP extension {}", bounded(method)),
        },
    })
}

fn validate_json_bounds(value: &Value) -> Result<(), AcpV1CodecError> {
    fn visit(value: &Value, depth: usize) -> Result<(), AcpV1CodecError> {
        if depth > MAX_ACP_DEPTH {
            return Err(AcpV1CodecError::JsonBounds);
        }
        match value {
            Value::String(value) if value.len() > MAX_ACP_STRING_BYTES => {
                Err(AcpV1CodecError::JsonBounds)
            }
            Value::Array(values) => {
                if values.len() > MAX_ACP_ARRAY_ITEMS {
                    return Err(AcpV1CodecError::JsonBounds);
                }
                for value in values {
                    visit(value, depth + 1)?;
                }
                Ok(())
            }
            Value::Object(values) => {
                if values.len() > MAX_ACP_ARRAY_ITEMS {
                    return Err(AcpV1CodecError::JsonBounds);
                }
                for (key, value) in values {
                    if key.len() > MAX_ACP_STRING_BYTES {
                        return Err(AcpV1CodecError::JsonBounds);
                    }
                    visit(value, depth + 1)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    visit(value, 0)
}

fn scalar_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn text<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

fn bounded_text(params: &Value, key: &str, default: &str) -> String {
    bounded(text(params, key).unwrap_or(default))
}

fn bounded(value: &str) -> String {
    value.chars().take(MAX_ACP_DIAGNOSTIC_BYTES).collect()
}

fn boolean(params: &Value, key: &str) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn integer(params: &Value, key: &str) -> u64 {
    params.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn map_tool(tool: &str) -> CapabilityId {
    CapabilityId::new(match tool {
        "inspect_workspace" => "workspace.inspect",
        "inspect_object" => "workspace.inspect_object",
        "read_snapshot" => "snapshot.read",
        "error_history" => "history.errors",
        "inspect_environment" => rho_protocol::ENVIRONMENT_INSPECT_CAPABILITY,
        "explain_environment_incident" => rho_protocol::ENVIRONMENT_EXPLAIN_INCIDENT_CAPABILITY,
        "propose_environment_change" => rho_protocol::ENVIRONMENT_PROPOSE_CHANGE_CAPABILITY,
        "request_environment_plan_apply" => rho_protocol::ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY,
        "inspect_environment_operation" => rho_protocol::ENVIRONMENT_OPERATION_INSPECT_CAPABILITY,
        other => other,
    })
    .unwrap_or_else(|_| CapabilityId::new("unsupported.provider_tool").unwrap())
}

pub fn codec_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &["stdio_jsonrpc_framing", "acp_v1_negotiation", "wire_bounds"],
        &[
            "canonical_event_authority",
            "ui_dto",
            "store_dto",
            "draft_v2_semantics",
        ],
    )
}
