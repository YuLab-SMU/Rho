use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{ContractError, Validate, validate_label, validate_opaque_text, validate_unique};

pub const PROVIDER_CAPABILITY_CONTRACT: &str = "rho.ui.provider-capabilities.v1";
pub const MAX_PROVIDER_FEATURES: usize = 32;
pub const MAX_PROVIDER_OPTIONS: usize = 32;
pub const MAX_OPTION_VALUES: usize = 128;

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFeatureV1 {
    Streaming,
    Plan,
    Resume,
    Config,
    ModelSelection,
    ReasoningEffort,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSupportTierV1 {
    FirstPartyFull,
    ExternalObserver,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAvailabilityV1 {
    Ready,
    Offline,
    Crashed,
    Disabled,
    Uninstalled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ProviderConfigKindV1 {
    Select,
    Boolean,
    Number,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct ProviderConfigOptionV1 {
    pub option_id: String,
    pub label: String,
    pub kind: ProviderConfigKindV1,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_values: Vec<String>,
}

impl Validate for ProviderConfigOptionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.option_id, "provider.option_id")?;
        validate_label(&self.label, "provider.option.label")?;
        if self.allowed_values.len() > MAX_OPTION_VALUES {
            return Err(ContractError::LimitExceeded {
                path: "provider.option.allowed_values".to_string(),
                limit: MAX_OPTION_VALUES,
                actual: self.allowed_values.len(),
            });
        }
        validate_unique(
            "provider.option.allowed_values",
            self.allowed_values.iter().map(String::as_str),
        )?;
        if self.kind == ProviderConfigKindV1::Select && self.allowed_values.is_empty() {
            return Err(ContractError::InvalidValue {
                path: "provider.option.allowed_values".to_string(),
                reason: "select option requires allowed values".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct NegotiatedProviderCapabilitiesV1 {
    pub contract: String,
    #[specta(type = crate::UiIpcNumber)]
    pub contract_major: u16,
    pub capability_snapshot_id: String,
    pub provider_label: String,
    pub availability: ProviderAvailabilityV1,
    pub provider_version: String,
    pub executable_digest: String,
    pub read_only: bool,
    pub support_tier: ProviderSupportTierV1,
    pub features: Vec<ProviderFeatureV1>,
    pub config_options: Vec<ProviderConfigOptionV1>,
    pub permission_posture: String,
    pub data_egress: String,
}

impl Validate for NegotiatedProviderCapabilitiesV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != PROVIDER_CAPABILITY_CONTRACT || self.contract_major != 1 {
            return Err(ContractError::InvalidValue {
                path: "provider.contract".to_string(),
                reason: "unsupported provider capability contract".to_string(),
            });
        }
        validate_opaque_text(
            &self.capability_snapshot_id,
            "provider.capability_snapshot_id",
        )?;
        validate_label(&self.provider_label, "provider.label")?;
        validate_opaque_text(&self.provider_version, "provider.version")?;
        if !self.executable_digest.starts_with("sha256:") {
            return Err(ContractError::InvalidValue {
                path: "provider.executable_digest".to_string(),
                reason: "provider digest must be sha256".to_string(),
            });
        }
        if self.features.len() > MAX_PROVIDER_FEATURES {
            return Err(ContractError::LimitExceeded {
                path: "provider.features".to_string(),
                limit: MAX_PROVIDER_FEATURES,
                actual: self.features.len(),
            });
        }
        let unique_features = self.features.iter().copied().collect::<BTreeSet<_>>();
        if unique_features.len() != self.features.len() {
            return Err(ContractError::InvalidValue {
                path: "provider.features".to_string(),
                reason: "provider features must be unique".to_string(),
            });
        }
        if self.config_options.len() > MAX_PROVIDER_OPTIONS {
            return Err(ContractError::LimitExceeded {
                path: "provider.config_options".to_string(),
                limit: MAX_PROVIDER_OPTIONS,
                actual: self.config_options.len(),
            });
        }
        validate_unique(
            "provider.config_options",
            self.config_options
                .iter()
                .map(|option| option.option_id.as_str()),
        )?;
        for option in &self.config_options {
            option.validate()?;
        }
        if !self.features.contains(&ProviderFeatureV1::Config) && !self.config_options.is_empty() {
            return Err(ContractError::InvalidValue {
                path: "provider.config_options".to_string(),
                reason: "provider without config feature cannot expose options".to_string(),
            });
        }
        if self.support_tier == ProviderSupportTierV1::ExternalObserver && !self.read_only {
            return Err(ContractError::InvalidValue {
                path: "provider.read_only".to_string(),
                reason: "external observer must remain read-only".to_string(),
            });
        }
        if !matches!(
            self.permission_posture.as_str(),
            "ask_before_changes" | "auto_within_policy"
        ) {
            return Err(ContractError::InvalidValue {
                path: "provider.permission_posture".to_string(),
                reason: "invalid permission posture".to_string(),
            });
        }
        if !matches!(
            self.data_egress.as_str(),
            "deny"
                | "configured_provider_only"
                | "allowlisted_destinations"
                | "ask_for_unrestricted_destination"
        ) {
            return Err(ContractError::InvalidValue {
                path: "provider.data_egress".to_string(),
                reason: "invalid data egress posture".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct ProviderConfigUpdateV1 {
    pub expected_capability_snapshot_id: String,
    #[specta(type = crate::UiIpcUnknown)]
    pub values: serde_json::Value,
}

impl ProviderConfigUpdateV1 {
    pub fn validate_against(
        &self,
        capabilities: &NegotiatedProviderCapabilitiesV1,
    ) -> Result<(), ContractError> {
        if self.expected_capability_snapshot_id != capabilities.capability_snapshot_id {
            return Err(ContractError::InvalidValue {
                path: "provider.config.expected_capability_snapshot_id".to_string(),
                reason: "stale capability snapshot".to_string(),
            });
        }
        let object = self
            .values
            .as_object()
            .ok_or_else(|| ContractError::InvalidValue {
                path: "provider.config.values".to_string(),
                reason: "provider config must be an object".to_string(),
            })?;
        for key in object.keys() {
            if !capabilities
                .config_options
                .iter()
                .any(|option| &option.option_id == key)
            {
                return Err(ContractError::InvalidValue {
                    path: format!("provider.config.values.{key}"),
                    reason: "unknown provider option".to_string(),
                });
            }
        }
        Ok(())
    }
}

pub fn first_party_provider_capabilities_fixture() -> NegotiatedProviderCapabilitiesV1 {
    NegotiatedProviderCapabilitiesV1 {
        contract: PROVIDER_CAPABILITY_CONTRACT.to_string(),
        contract_major: 1,
        capability_snapshot_id: "capability_snapshot_first_party_1".to_string(),
        provider_label: "First-party provider".to_string(),
        availability: ProviderAvailabilityV1::Ready,
        provider_version: "aisdk-adapter-v1".to_string(),
        executable_digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        read_only: false,
        support_tier: ProviderSupportTierV1::FirstPartyFull,
        features: vec![
            ProviderFeatureV1::Streaming,
            ProviderFeatureV1::Plan,
            ProviderFeatureV1::Resume,
            ProviderFeatureV1::Config,
            ProviderFeatureV1::ModelSelection,
            ProviderFeatureV1::ReasoningEffort,
        ],
        config_options: vec![
            ProviderConfigOptionV1 {
                option_id: "model".to_string(),
                label: "Model".to_string(),
                kind: ProviderConfigKindV1::Select,
                required: true,
                allowed_values: vec!["default".to_string(), "fast".to_string()],
            },
            ProviderConfigOptionV1 {
                option_id: "reasoning_effort".to_string(),
                label: "Reasoning effort".to_string(),
                kind: ProviderConfigKindV1::Select,
                required: false,
                allowed_values: vec!["low".to_string(), "medium".to_string(), "high".to_string()],
            },
        ],
        permission_posture: "ask_before_changes".to_string(),
        data_egress: "configured_provider_only".to_string(),
    }
}

pub fn external_observer_capabilities_fixture() -> NegotiatedProviderCapabilitiesV1 {
    NegotiatedProviderCapabilitiesV1 {
        contract: PROVIDER_CAPABILITY_CONTRACT.to_string(),
        contract_major: 1,
        capability_snapshot_id: "capability_snapshot_external_1".to_string(),
        provider_label: "External scientific observer".to_string(),
        availability: ProviderAvailabilityV1::Ready,
        provider_version: "1.2.3".to_string(),
        executable_digest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        read_only: true,
        support_tier: ProviderSupportTierV1::ExternalObserver,
        features: vec![ProviderFeatureV1::Streaming],
        config_options: Vec::new(),
        permission_posture: "ask_before_changes".to_string(),
        data_egress: "configured_provider_only".to_string(),
    }
}
