//! Isolated first-party aisdk adapter.
//!
//! This module translates a provider-owned wire transcript into the canonical
//! runtime contract. It has no authority, Workspace/project path, Store append,
//! or secret-resolution API.

use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{AgentProviderSnapshot, CapabilityId, OperationId, ProviderId, TurnId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{
    AgentProvider, AgentTurnRequest, ProviderCancelReply, ProviderRuntimeEvent, TurnTerminalOutcome,
};

pub const AISDK_MAX_EVENT_BYTES: usize = 128 * 1024;
pub const AISDK_MAX_CONTEXT_ITEMS: usize = 64;
pub const AISDK_MAX_PLAN_STEPS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AisdkCapabilities {
    pub resume: bool,
    pub plan: bool,
    pub config: bool,
    pub streaming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AisdkConfig {
    pub model: String,
    pub endpoint_origin: String,
    pub capabilities: AisdkCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AisdkWireEvent {
    TextDelta {
        cursor: u64,
        text: String,
    },
    MissionPlan {
        mission_id: String,
        steps: Vec<String>,
    },
    ToolRequest {
        tool: String,
        call_id: String,
        arguments: Value,
    },
    Complete,
    Failed {
        code: String,
    },
    PrivateThinking {
        text: String,
    },
    Diagnostic {
        code: String,
        detail: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum AisdkTranslation {
    Canonical(ProviderRuntimeEvent),
    IgnoredPrivate,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AisdkAdapterError {
    #[error("aisdk event exceeds byte bound")]
    EventTooLarge,
    #[error("aisdk mission plan exceeds step bound")]
    PlanTooLarge,
    #[error("aisdk tool {0} is not exposed by the canonical snapshot")]
    UnsupportedTool(String),
    #[error("aisdk transcript JSON is invalid: {0}")]
    InvalidTranscript(String),
    #[error("secret material must be supplied only through an allowlisted child key")]
    InvalidSecretEnvironment,
}

#[derive(Debug, Clone)]
pub struct AisdkAdapter {
    config: AisdkConfig,
    capability_ids: BTreeSet<CapabilityId>,
    tool_map: BTreeMap<String, CapabilityId>,
    transcript: Vec<AisdkWireEvent>,
    cancelled: BTreeSet<TurnId>,
}

impl AisdkAdapter {
    pub fn new(config: AisdkConfig) -> Self {
        let tool_map = BTreeMap::from([
            (
                "inspect_workspace".to_string(),
                CapabilityId::new("workspace.inspect").unwrap(),
            ),
            (
                "run_r".to_string(),
                CapabilityId::new(rho_protocol::RUN_R_CAPABILITY).unwrap(),
            ),
            (
                "apply_project_patch".to_string(),
                CapabilityId::new("project.apply_patch").unwrap(),
            ),
            (
                "fetch_external".to_string(),
                CapabilityId::new("network.fetch").unwrap(),
            ),
            (
                "read_artifact".to_string(),
                CapabilityId::new("artifact.read").unwrap(),
            ),
        ]);
        let capability_ids = tool_map.values().cloned().collect();
        Self {
            config,
            capability_ids,
            tool_map,
            transcript: Vec::new(),
            cancelled: BTreeSet::new(),
        }
    }

    pub fn with_transcript(mut self, transcript: Vec<AisdkWireEvent>) -> Self {
        self.transcript = transcript;
        self
    }

    pub fn snapshot(&self) -> AgentProviderSnapshot {
        AgentProviderSnapshot {
            provider_id: ProviderId::new("provider_aisdk_first_party").unwrap(),
            provider_version: "aisdk-adapter-v1".to_string(),
            capability_ids: self.capability_ids.iter().cloned().collect(),
            supports_resume: self.config.capabilities.resume,
            supports_cancel: true,
            max_payload_bytes: AISDK_MAX_EVENT_BYTES as u64,
        }
    }

    pub fn translate(&self, event: AisdkWireEvent) -> Result<AisdkTranslation, AisdkAdapterError> {
        let encoded = serde_json::to_vec(&event)
            .map_err(|error| AisdkAdapterError::InvalidTranscript(error.to_string()))?;
        if encoded.len() > AISDK_MAX_EVENT_BYTES {
            return Err(AisdkAdapterError::EventTooLarge);
        }
        Ok(match event {
            AisdkWireEvent::TextDelta { cursor, text } => {
                AisdkTranslation::Canonical(ProviderRuntimeEvent::MessageDelta { cursor, text })
            }
            AisdkWireEvent::MissionPlan { mission_id, steps } => {
                if steps.len() > AISDK_MAX_PLAN_STEPS {
                    return Err(AisdkAdapterError::PlanTooLarge);
                }
                AisdkTranslation::Canonical(ProviderRuntimeEvent::PlanReplaced {
                    plan_id: mission_id,
                })
            }
            AisdkWireEvent::ToolRequest {
                tool,
                call_id,
                arguments,
            } => {
                let capability_id = self
                    .tool_map
                    .get(&tool)
                    .cloned()
                    .ok_or_else(|| AisdkAdapterError::UnsupportedTool(tool.clone()))?;
                AisdkTranslation::Canonical(ProviderRuntimeEvent::CapabilityRequest {
                    capability_id,
                    operation_id: OperationId::new(format!("operation_aisdk_{call_id}"))
                        .unwrap_or_else(|_| OperationId::generate()),
                    normalized_arguments: arguments,
                })
            }
            AisdkWireEvent::Complete => {
                AisdkTranslation::Canonical(ProviderRuntimeEvent::Terminal {
                    outcome: TurnTerminalOutcome::Completed,
                })
            }
            AisdkWireEvent::Failed { code: _ } => {
                AisdkTranslation::Canonical(ProviderRuntimeEvent::Terminal {
                    outcome: TurnTerminalOutcome::Failed,
                })
            }
            AisdkWireEvent::PrivateThinking { .. } => AisdkTranslation::IgnoredPrivate,
            AisdkWireEvent::Diagnostic { code, detail } => {
                AisdkTranslation::Canonical(ProviderRuntimeEvent::Diagnostic {
                    code,
                    detail: detail.chars().take(2048).collect(),
                })
            }
        })
    }

    pub fn translate_transcript_json_lines(
        &self,
        lines: &str,
    ) -> Result<Vec<AisdkTranslation>, AisdkAdapterError> {
        lines
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let event = serde_json::from_str::<AisdkWireEvent>(line)
                    .map_err(|error| AisdkAdapterError::InvalidTranscript(error.to_string()))?;
                self.translate(event)
            })
            .collect()
    }

    pub fn child_environment(
        &self,
        injected: BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, AisdkAdapterError> {
        const ALLOWED: [&str; 2] = ["AISDK_PROVIDER_TOKEN", "AISDK_CA_BUNDLE"];
        if injected.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
            return Err(AisdkAdapterError::InvalidSecretEnvironment);
        }
        Ok(injected)
    }

    pub fn bounded_context<T: Clone>(&self, items: &[T]) -> Vec<T> {
        items
            .iter()
            .take(AISDK_MAX_CONTEXT_ITEMS)
            .cloned()
            .collect()
    }
}

impl AgentProvider for AisdkAdapter {
    fn snapshot(&self) -> AgentProviderSnapshot {
        AisdkAdapter::snapshot(self)
    }

    fn start_turn(&mut self, _request: AgentTurnRequest) -> Vec<ProviderRuntimeEvent> {
        self.transcript
            .clone()
            .into_iter()
            .filter_map(|event| match self.translate(event) {
                Ok(AisdkTranslation::Canonical(event)) => Some(event),
                Ok(AisdkTranslation::IgnoredPrivate) | Err(_) => None,
            })
            .collect()
    }

    fn request_cancel(&mut self, turn_id: &TurnId) -> ProviderCancelReply {
        self.cancelled.insert(turn_id.clone());
        ProviderCancelReply::Accepted
    }
}

pub fn adapter_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &["wire_translation", "capability_snapshot", "bounded_context"],
        &[
            "workspace_mutation",
            "project_write",
            "store_append",
            "policy_authority",
            "secret_resolution",
        ],
    )
}
