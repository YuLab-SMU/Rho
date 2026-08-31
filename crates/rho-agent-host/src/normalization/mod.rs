//! Explicit external-provider event normalization into canonical Rho surfaces.

use std::collections::BTreeSet;

use rho_protocol::{
    CapabilityId, ExpectedRevisions, HotEventPayload, OperationId, ProviderId,
    SemanticEventPayload, SessionId, TurnId,
};
use serde::{Deserialize, Serialize};

use crate::protocol::acp::v1::NeutralAcpEvent;

pub const MAX_NORMALIZED_USAGE_TOKENS: u64 = 10_000_000_000;
pub const MAX_NORMALIZED_DIAGNOSTIC_BYTES: usize = 2048;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedChannel {
    Hot,
    Durable,
    Interaction,
    ProviderObservation,
    Diagnostic,
    Ignored,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct MappingDescriptor {
    pub input_kind: &'static str,
    pub output_channel: NormalizedChannel,
    pub authoritative_execution: bool,
}

pub const NORMALIZATION_MAPPING_TABLE: &[MappingDescriptor] = &[
    MappingDescriptor {
        input_kind: "initialized",
        output_channel: NormalizedChannel::Diagnostic,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "session_created",
        output_channel: NormalizedChannel::Durable,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "session_closed",
        output_channel: NormalizedChannel::Durable,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "message_delta",
        output_channel: NormalizedChannel::Hot,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "plan_replaced",
        output_channel: NormalizedChannel::Durable,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "tool_requested",
        output_channel: NormalizedChannel::Durable,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "tool_reported_terminal",
        output_channel: NormalizedChannel::ProviderObservation,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "provider_permission_hint",
        output_channel: NormalizedChannel::Interaction,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "usage",
        output_channel: NormalizedChannel::Hot,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "terminal",
        output_channel: NormalizedChannel::Durable,
        authoritative_execution: false,
    },
    MappingDescriptor {
        input_kind: "diagnostic",
        output_channel: NormalizedChannel::Diagnostic,
        authoritative_execution: false,
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderInteractionRequest {
    pub capability_id: CapabilityId,
    pub operation_id: OperationId,
    pub provider_hint: String,
    pub broker_admission_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderToolObservation {
    pub operation_id: OperationId,
    pub provider_reported_outcome: String,
    pub authoritative_execution: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "channel", rename_all = "snake_case")]
pub enum NormalizationOutput {
    Hot {
        payload: HotEventPayload,
    },
    Durable {
        payload: SemanticEventPayload,
    },
    Interaction {
        request: ProviderInteractionRequest,
    },
    ProviderObservation {
        observation: ProviderToolObservation,
    },
    Diagnostic {
        code: String,
        detail: String,
    },
    Ignored {
        reason: String,
    },
}

#[derive(Debug, Clone)]
pub struct NormalizationContext {
    pub logical_session_id: SessionId,
    pub turn_id: TurnId,
    pub provider_id: ProviderId,
    pub expected_revisions: ExpectedRevisions,
}

#[derive(Debug, Default)]
pub struct ProviderEventNormalizer {
    seen: BTreeSet<String>,
    last_delta_cursor: Option<u64>,
    terminal_seen: bool,
}

impl ProviderEventNormalizer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn normalize(
        &mut self,
        context: &NormalizationContext,
        event: NeutralAcpEvent,
    ) -> Vec<NormalizationOutput> {
        let fingerprint = event_fingerprint(&event);
        if !self.seen.insert(fingerprint) {
            return vec![NormalizationOutput::Ignored {
                reason: "duplicate_provider_event".to_string(),
            }];
        }
        match event {
            NeutralAcpEvent::Initialized { negotiated } => {
                vec![NormalizationOutput::Diagnostic {
                    code: "provider_initialized".to_string(),
                    detail: format!(
                        "protocol {} provider version {}",
                        bounded(&negotiated.protocol),
                        bounded(&negotiated.provider_version)
                    ),
                }]
            }
            NeutralAcpEvent::SessionCreated { .. } => {
                vec![NormalizationOutput::Durable {
                    payload: SemanticEventPayload::SessionChanged {
                        session_id: context.logical_session_id.clone(),
                        state: "provider_session_active".to_string(),
                    },
                }]
            }
            NeutralAcpEvent::SessionClosed { .. } => {
                vec![NormalizationOutput::Durable {
                    payload: SemanticEventPayload::SessionChanged {
                        session_id: context.logical_session_id.clone(),
                        state: "provider_session_closed".to_string(),
                    },
                }]
            }
            NeutralAcpEvent::MessageDelta { cursor, text } => {
                let mut outputs = Vec::new();
                if let Some(previous) = self.last_delta_cursor {
                    if cursor <= previous {
                        return vec![NormalizationOutput::Diagnostic {
                            code: "provider_delta_reordered".to_string(),
                            detail: "provider delta cursor did not advance".to_string(),
                        }];
                    }
                    if cursor > previous.saturating_add(1) {
                        outputs.push(NormalizationOutput::Diagnostic {
                            code: "provider_delta_gap".to_string(),
                            detail:
                                "provider delta cursor gap; durable snapshot remains authoritative"
                                    .to_string(),
                        });
                    }
                }
                self.last_delta_cursor = Some(cursor);
                outputs.push(NormalizationOutput::Hot {
                    payload: HotEventPayload::MessageDelta {
                        turn_id: context.turn_id.clone(),
                        cursor,
                        text,
                    },
                });
                outputs
            }
            NeutralAcpEvent::PlanReplaced { plan_id } => {
                vec![NormalizationOutput::Durable {
                    payload: SemanticEventPayload::PlanReplaced {
                        turn_id: context.turn_id.clone(),
                        plan_id,
                    },
                }]
            }
            NeutralAcpEvent::ToolRequested {
                capability_id,
                operation_id,
                arguments,
            } => vec![NormalizationOutput::Durable {
                payload: SemanticEventPayload::CapabilityRequested {
                    capability_id,
                    operation_id,
                    expected_revisions: context.expected_revisions.clone(),
                    normalized_arguments: arguments,
                },
            }],
            NeutralAcpEvent::ToolReportedTerminal {
                operation_id,
                outcome,
            } => vec![NormalizationOutput::ProviderObservation {
                observation: ProviderToolObservation {
                    operation_id,
                    provider_reported_outcome: bounded(&outcome),
                    authoritative_execution: false,
                },
            }],
            NeutralAcpEvent::ProviderPermissionHint {
                capability_id,
                hint,
            } => {
                let operation_id = OperationId::generate();
                vec![
                    NormalizationOutput::Hot {
                        payload: HotEventPayload::ProviderPermissionHint {
                            capability_id: capability_id.clone(),
                            hint: bounded(&hint),
                        },
                    },
                    NormalizationOutput::Interaction {
                        request: ProviderInteractionRequest {
                            capability_id,
                            operation_id,
                            provider_hint: bounded(&hint),
                            broker_admission_required: true,
                        },
                    },
                ]
            }
            NeutralAcpEvent::Usage {
                input_tokens,
                output_tokens,
            } => vec![NormalizationOutput::Hot {
                payload: HotEventPayload::UsageUpdated {
                    provider_id: context.provider_id.clone(),
                    input_tokens: input_tokens.min(MAX_NORMALIZED_USAGE_TOKENS),
                    output_tokens: output_tokens.min(MAX_NORMALIZED_USAGE_TOKENS),
                },
            }],
            NeutralAcpEvent::Terminal { outcome } => {
                if self.terminal_seen {
                    return vec![NormalizationOutput::Ignored {
                        reason: "duplicate_terminal".to_string(),
                    }];
                }
                self.terminal_seen = true;
                if outcome == "completed" {
                    vec![NormalizationOutput::Durable {
                        payload: SemanticEventPayload::TurnCompleted {
                            turn_id: context.turn_id.clone(),
                        },
                    }]
                } else {
                    vec![NormalizationOutput::Durable {
                        payload: SemanticEventPayload::TurnFailed {
                            turn_id: context.turn_id.clone(),
                            reason_code: normalize_outcome(&outcome),
                        },
                    }]
                }
            }
            NeutralAcpEvent::Diagnostic { code, detail } => {
                vec![NormalizationOutput::Diagnostic {
                    code: bounded(&code),
                    detail: bounded_and_redacted(&detail),
                }]
            }
        }
    }
}

fn event_fingerprint(event: &NeutralAcpEvent) -> String {
    let encoded = serde_json::to_vec(event).unwrap_or_default();
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(encoded))
}

fn normalize_outcome(value: &str) -> String {
    match value {
        "cancelled" => "provider_cancelled",
        "crashed" => "provider_crashed",
        _ => "provider_failed",
    }
    .to_string()
}

fn bounded(value: &str) -> String {
    value
        .chars()
        .take(MAX_NORMALIZED_DIAGNOSTIC_BYTES)
        .collect()
}

fn bounded_and_redacted(value: &str) -> String {
    let lowered = value.to_ascii_lowercase();
    if [
        "secret",
        "token",
        "authorization",
        "private_thinking",
        "chain_of_thought",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
    {
        "provider diagnostic redacted".to_string()
    } else {
        bounded(value)
    }
}

pub fn normalization_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "explicit_mapping",
            "ordering",
            "sensitivity",
            "correlation_link",
        ],
        &[
            "execution_success_authority",
            "broker_bypass",
            "wire_payload_persistence",
            "provider_permission_authority",
        ],
    )
}
