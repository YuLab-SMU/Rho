use std::collections::BTreeSet;

use rho_protocol::{AgentProviderSnapshot, CapabilityId, ProviderId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSupportTier {
    VerifiedFull,
    ObserverOnly,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderObservedCapabilities {
    pub streaming: bool,
    pub plan: bool,
    pub permission_hint: bool,
    pub resume: bool,
    pub close: bool,
    pub list: bool,
    pub config: bool,
    pub mcp: bool,
    pub filesystem: bool,
    pub terminal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderMatrixEntry {
    pub provider_id: String,
    pub executable_name: String,
    pub executable_sha256: String,
    pub version: String,
    pub protocol: String,
    pub live_probe_passed: bool,
    pub support_tier: ProviderSupportTier,
    #[serde(default)]
    pub commercial: bool,
    pub observed: ProviderObservedCapabilities,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveProviderMatrix {
    pub schema: String,
    pub generated_at_policy: String,
    pub providers: Vec<ProviderMatrixEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatrixLifecycleState {
    Unavailable,
    Starting,
    Ready,
    Crashed,
    ConfigInvalid,
    Closed,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProviderMatrixError {
    #[error("provider matrix schema is invalid")]
    Schema,
    #[error("provider matrix entry is invalid or contradicts live behavior")]
    ContradictoryEntry,
    #[error("provider matrix contains duplicate provider identity")]
    DuplicateProvider,
}

impl LiveProviderMatrix {
    pub fn parse(bytes: &[u8]) -> Result<Self, ProviderMatrixError> {
        let matrix: Self =
            serde_json::from_slice(bytes).map_err(|_| ProviderMatrixError::Schema)?;
        matrix.validate()?;
        Ok(matrix)
    }

    pub fn validate(&self) -> Result<(), ProviderMatrixError> {
        if self.schema != "rho.provider-matrix.live.v1" || self.providers.is_empty() {
            return Err(ProviderMatrixError::Schema);
        }
        let mut ids = BTreeSet::new();
        for entry in &self.providers {
            if !ids.insert(entry.provider_id.clone()) {
                return Err(ProviderMatrixError::DuplicateProvider);
            }
            if entry.provider_id.is_empty()
                || entry.executable_name.is_empty()
                || entry.version.is_empty()
                || !valid_digest(&entry.executable_sha256)
            {
                return Err(ProviderMatrixError::ContradictoryEntry);
            }
            match entry.support_tier {
                ProviderSupportTier::VerifiedFull | ProviderSupportTier::ObserverOnly => {
                    if !entry.live_probe_passed || entry.protocol != "acp/1" {
                        return Err(ProviderMatrixError::ContradictoryEntry);
                    }
                }
                ProviderSupportTier::Unsupported => {
                    if entry.live_probe_passed
                        || entry.observed.streaming
                        || entry.observed.resume
                        || entry.observed.filesystem
                        || entry.observed.terminal
                        || entry.reason.as_deref().unwrap_or("").is_empty()
                    {
                        return Err(ProviderMatrixError::ContradictoryEntry);
                    }
                }
            }
            if entry.support_tier == ProviderSupportTier::ObserverOnly
                && (entry.observed.filesystem || entry.observed.terminal)
            {
                return Err(ProviderMatrixError::ContradictoryEntry);
            }
        }
        Ok(())
    }

    pub fn entry(&self, provider_id: &str) -> Option<&ProviderMatrixEntry> {
        self.providers
            .iter()
            .find(|entry| entry.provider_id == provider_id)
    }
}

impl ProviderMatrixEntry {
    pub fn canonical_snapshot(&self) -> Option<AgentProviderSnapshot> {
        if self.support_tier == ProviderSupportTier::Unsupported {
            return None;
        }
        let capability_ids = if self.support_tier == ProviderSupportTier::ObserverOnly {
            vec![
                CapabilityId::new("workspace.inspect").unwrap(),
                CapabilityId::new("workspace.inspect_object").unwrap(),
                CapabilityId::new("snapshot.read").unwrap(),
                CapabilityId::new("history.errors").unwrap(),
            ]
        } else {
            vec![
                CapabilityId::new("workspace.inspect").unwrap(),
                CapabilityId::new(rho_protocol::RUN_R_CAPABILITY).unwrap(),
                CapabilityId::new("project.apply_patch").unwrap(),
                CapabilityId::new("artifact.commit").unwrap(),
            ]
        };
        Some(AgentProviderSnapshot {
            provider_id: ProviderId::new(format!("provider_{}", self.provider_id)).unwrap(),
            provider_version: self.version.clone(),
            capability_ids,
            supports_resume: self.observed.resume,
            supports_cancel: true,
            max_payload_bytes: crate::protocol::acp::v1::MAX_ACP_FRAME_BYTES as u64,
        })
    }

    pub fn lifecycle_after(
        &self,
        available: bool,
        crashed: bool,
        config_valid: bool,
    ) -> MatrixLifecycleState {
        if !available || self.support_tier == ProviderSupportTier::Unsupported {
            MatrixLifecycleState::Unavailable
        } else if !config_valid {
            MatrixLifecycleState::ConfigInvalid
        } else if crashed {
            MatrixLifecycleState::Crashed
        } else {
            MatrixLifecycleState::Ready
        }
    }
}

pub fn downgrade_incorrect_declaration(mut entry: ProviderMatrixEntry) -> ProviderMatrixEntry {
    if matches!(
        entry.support_tier,
        ProviderSupportTier::VerifiedFull | ProviderSupportTier::ObserverOnly
    ) && (!entry.live_probe_passed || entry.protocol != "acp/1")
    {
        entry.support_tier = ProviderSupportTier::Unsupported;
        entry.observed = ProviderObservedCapabilities::default();
        entry.reason = Some("Live behavior contradicted capability declaration".to_string());
    }
    entry
}

pub fn canonical_transcript_behavior_key(
    events: &[crate::ProviderRuntimeEvent],
) -> Vec<&'static str> {
    events
        .iter()
        .map(|event| match event {
            crate::ProviderRuntimeEvent::MessageDelta { .. } => "message_delta",
            crate::ProviderRuntimeEvent::PlanReplaced { .. } => "plan_replaced",
            crate::ProviderRuntimeEvent::CapabilityRequest { .. } => "capability_request",
            crate::ProviderRuntimeEvent::Terminal { .. } => "terminal",
            crate::ProviderRuntimeEvent::Diagnostic { .. } => "diagnostic",
        })
        .collect()
}

pub fn provider_matrix_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "live_digest_version_probe",
            "capability_truth",
            "support_tier",
            "canonical_transcript_comparison",
        ],
        &[
            "broker_provider_branch",
            "store_provider_branch",
            "ui_provider_branch",
            "provider_authority",
            "model_answer_quality_gate",
        ],
    )
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.chars().all(|character| character.is_ascii_hexdigit())
    })
}
