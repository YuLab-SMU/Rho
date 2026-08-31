//! Explicitly installed ACP v1 external observer provider.
//!
//! The selected release is intentionally read-only. It receives bounded
//! scientific observations through canonical capabilities and never receives a
//! project path, Workspace socket, terminal, general environment, or secret.

use std::{collections::BTreeMap, path::PathBuf};

use rho_control_plane::{
    CapabilityRegistry, CapabilitySupport, VerifiedMutationProfile,
    controlled_mutation_capabilities,
};
use rho_protocol::{
    AgentProviderSnapshot, CapabilityId, DataClass, DestinationClass, EffectClass, ProviderId,
    TargetClass, TurnId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{
    AgentProvider, AgentTurnRequest, ProviderCancelReply, ProviderRuntimeEvent,
    process::{ApprovedProviderProcess, ProviderProcessError, executable_digest},
};

pub const SELECTED_EXTERNAL_PROVIDER: &str = "rho-observer-acp";
pub const SELECTED_EXTERNAL_PROVIDER_VERSION: &str = "1.2.3";
pub const MAX_EXTERNAL_RESULT_BYTES: usize = 64 * 1024;
pub const MAX_EXTERNAL_RESULT_ITEMS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExternalProviderInstallManifest {
    pub provider_id: ProviderId,
    pub version: String,
    pub executable: PathBuf,
    pub executable_sha256: String,
    pub isolated_root: PathBuf,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalProviderAvailability {
    Uninstalled,
    Disabled,
    Offline,
    Ready,
    Crashed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExternalProviderStatus {
    pub availability: ExternalProviderAvailability,
    pub provider_label: String,
    pub version: Option<String>,
    pub executable_digest: Option<String>,
    pub read_only: bool,
    pub user_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BoundedExternalObservation {
    pub capability_id: CapabilityId,
    pub sensitivity: DataClass,
    pub revision_ref: String,
    pub items: Vec<Value>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExternalCapabilityDecision {
    AllowedRead,
    Denied { reason_code: String },
}

#[derive(Debug, Error)]
pub enum ExternalProviderError {
    #[error("external Provider installation is disabled")]
    Disabled,
    #[error("external Provider executable digest mismatch")]
    DigestMismatch,
    #[error("external Provider executable is outside isolated root")]
    OutsideRoot,
    #[error("external observation exceeds byte bound")]
    ResultTooLarge,
    #[error("external observation uses an unavailable capability")]
    UnsupportedCapability,
    #[error("process specification error: {0}")]
    Process(#[from] ProviderProcessError),
}

#[derive(Debug, Clone)]
pub struct ExternalObserverProvider {
    manifest: ExternalProviderInstallManifest,
    snapshot: AgentProviderSnapshot,
    transcript: Vec<ProviderRuntimeEvent>,
    availability: ExternalProviderAvailability,
}

impl ExternalObserverProvider {
    pub fn from_explicit_install(
        manifest: ExternalProviderInstallManifest,
    ) -> Result<Self, ExternalProviderError> {
        if !manifest.enabled {
            return Err(ExternalProviderError::Disabled);
        }
        let root = manifest
            .isolated_root
            .canonicalize()
            .map_err(|_| ExternalProviderError::OutsideRoot)?;
        let executable = manifest
            .executable
            .canonicalize()
            .map_err(|_| ExternalProviderError::OutsideRoot)?;
        if !executable.starts_with(&root) {
            return Err(ExternalProviderError::OutsideRoot);
        }
        if executable_digest(&executable)? != manifest.executable_sha256 {
            return Err(ExternalProviderError::DigestMismatch);
        }
        let capability_ids = external_observer_capabilities()
            .into_iter()
            .map(|description| description.id)
            .collect();
        let snapshot = AgentProviderSnapshot {
            provider_id: manifest.provider_id.clone(),
            provider_version: manifest.version.clone(),
            capability_ids,
            supports_resume: true,
            supports_cancel: true,
            max_payload_bytes: MAX_EXTERNAL_RESULT_BYTES as u64,
        };
        Ok(Self {
            manifest,
            snapshot,
            transcript: Vec::new(),
            availability: ExternalProviderAvailability::Ready,
        })
    }

    pub fn snapshot_for_security_profile(
        &self,
        profile: &VerifiedMutationProfile,
    ) -> AgentProviderSnapshot {
        let mut snapshot = self.snapshot.clone();
        snapshot.capability_ids =
            controlled_mutation_capabilities(snapshot.capability_ids, profile);
        snapshot
    }

    pub fn with_transcript(mut self, transcript: Vec<ProviderRuntimeEvent>) -> Self {
        self.transcript = transcript;
        self
    }

    pub fn status(&self) -> ExternalProviderStatus {
        ExternalProviderStatus {
            availability: self.availability,
            provider_label: "External scientific observer".to_string(),
            version: Some(self.manifest.version.clone()),
            executable_digest: Some(self.manifest.executable_sha256.clone()),
            read_only: true,
            user_summary: match self.availability {
                ExternalProviderAvailability::Ready => {
                    "External observer ready; Workspace mutation is unavailable"
                }
                ExternalProviderAvailability::Offline => {
                    "External observer offline; IDE and Workspace remain available"
                }
                ExternalProviderAvailability::Crashed => {
                    "External observer crashed; logical session can reconnect"
                }
                ExternalProviderAvailability::Disabled => "External observer disabled",
                ExternalProviderAvailability::Uninstalled => "External observer not installed",
            }
            .to_string(),
        }
    }

    pub fn mark_offline(&mut self) {
        self.availability = ExternalProviderAvailability::Offline;
    }

    pub fn mark_crashed(&mut self) {
        self.availability = ExternalProviderAvailability::Crashed;
    }

    pub fn process_spec(
        &self,
        empty_snapshot_sandbox: PathBuf,
    ) -> Result<ApprovedProviderProcess, ExternalProviderError> {
        let sandbox = empty_snapshot_sandbox
            .canonicalize()
            .map_err(|_| ExternalProviderError::OutsideRoot)?;
        let root = self
            .manifest
            .isolated_root
            .canonicalize()
            .map_err(|_| ExternalProviderError::OutsideRoot)?;
        if !sandbox.starts_with(&root) {
            return Err(ExternalProviderError::OutsideRoot);
        }
        Ok(ApprovedProviderProcess {
            executable: self.manifest.executable.clone(),
            executable_sha256: self.manifest.executable_sha256.clone(),
            argv: vec!["--stdio".to_string(), "--protocol=acp/1".to_string()],
            working_directory: sandbox,
            isolated_root: root,
            environment: BTreeMap::new(),
        })
    }

    pub fn assess_capability(
        &self,
        registry: &CapabilityRegistry,
        capability_id: &CapabilityId,
        arguments: &Value,
    ) -> ExternalCapabilityDecision {
        let Ok(capability) = registry.descriptor(capability_id) else {
            return ExternalCapabilityDecision::Denied {
                reason_code: "external_observer_unknown_capability".to_string(),
            };
        };
        if capability.descriptor.effect_class != EffectClass::Read
            || !self.snapshot.capability_ids.contains(capability_id)
        {
            return ExternalCapabilityDecision::Denied {
                reason_code: "external_observer_read_only".to_string(),
            };
        }
        if registry
            .validate_arguments(capability_id, arguments)
            .is_err()
        {
            return ExternalCapabilityDecision::Denied {
                reason_code: "external_observer_invalid_arguments".to_string(),
            };
        }
        ExternalCapabilityDecision::AllowedRead
    }

    pub fn bound_observation(
        &self,
        capability_id: CapabilityId,
        sensitivity: DataClass,
        revision_ref: impl Into<String>,
        items: Vec<Value>,
    ) -> Result<BoundedExternalObservation, ExternalProviderError> {
        if !self.snapshot.capability_ids.contains(&capability_id) {
            return Err(ExternalProviderError::UnsupportedCapability);
        }
        let truncated = items.len() > MAX_EXTERNAL_RESULT_ITEMS;
        let items = items
            .into_iter()
            .take(MAX_EXTERNAL_RESULT_ITEMS)
            .collect::<Vec<_>>();
        let observation = BoundedExternalObservation {
            capability_id,
            sensitivity,
            revision_ref: revision_ref.into(),
            items,
            truncated,
        };
        if serde_json::to_vec(&observation)
            .map(|bytes| bytes.len() > MAX_EXTERNAL_RESULT_BYTES)
            .unwrap_or(true)
        {
            return Err(ExternalProviderError::ResultTooLarge);
        }
        Ok(observation)
    }
}

impl AgentProvider for ExternalObserverProvider {
    fn snapshot(&self) -> AgentProviderSnapshot {
        self.snapshot.clone()
    }

    fn start_turn(&mut self, _request: AgentTurnRequest) -> Vec<ProviderRuntimeEvent> {
        if self.availability == ExternalProviderAvailability::Ready {
            self.transcript.clone()
        } else {
            Vec::new()
        }
    }

    fn request_cancel(&mut self, _turn_id: &TurnId) -> ProviderCancelReply {
        if self.availability == ExternalProviderAvailability::Ready {
            ProviderCancelReply::Accepted
        } else {
            ProviderCancelReply::AlreadyTerminal
        }
    }
}

pub fn external_observer_capabilities() -> Vec<rho_control_plane::ProviderCapabilityDescription> {
    let registry = CapabilityRegistry::canonical().expect("canonical registry");
    let support = CapabilitySupport {
        targets: [
            TargetClass::Workspace,
            TargetClass::ProjectFiles,
            TargetClass::LocalProcess,
        ]
        .into_iter()
        .collect(),
        destinations: [
            DestinationClass::LocalWorkspace,
            DestinationClass::LocalSandbox,
        ]
        .into_iter()
        .collect(),
    };
    registry.read_only_observer_snapshot(&support)
}

pub fn unavailable_external_status(
    availability: ExternalProviderAvailability,
) -> ExternalProviderStatus {
    ExternalProviderStatus {
        availability,
        provider_label: "External scientific observer".to_string(),
        version: None,
        executable_digest: None,
        read_only: true,
        user_summary: match availability {
            ExternalProviderAvailability::Uninstalled => {
                "External observer is not installed; install explicitly to enable"
            }
            ExternalProviderAvailability::Disabled => "External observer is disabled",
            ExternalProviderAvailability::Offline => {
                "External observer is offline; IDE and Workspace remain available"
            }
            ExternalProviderAvailability::Crashed => {
                "External observer crashed; control-plane truth is unchanged"
            }
            ExternalProviderAvailability::Ready => "External observer ready",
        }
        .to_string(),
    }
}

pub fn external_provider_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "explicit_install",
            "read_capability_snapshot",
            "bounded_observation",
            "availability_status",
        ],
        &[
            "registry_download",
            "workspace_socket",
            "authoritative_project_path",
            "terminal_capability",
            "general_environment",
            "effect_authority",
        ],
    )
}
