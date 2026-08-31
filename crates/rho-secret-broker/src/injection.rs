use std::{collections::BTreeMap, io::Write};

use rho_protocol::SecretPurpose;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{ChildEnvironment, SecretLeaseScope, SecretMaterial};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InjectionPurpose {
    ProviderApi,
    Ssh,
    OAuth,
    Database,
    Signing,
    UserDefined,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InjectionMethod {
    StdinPipe,
    InheritedFd,
    LocalSocket,
    TargetChildEnvironment,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InjectionPolicy {
    pub preferred: Vec<InjectionMethod>,
    pub allow_environment_fallback: bool,
    pub terminate_child_on_revoke: bool,
}

impl Default for InjectionPolicy {
    fn default() -> Self {
        Self {
            preferred: vec![
                InjectionMethod::StdinPipe,
                InjectionMethod::InheritedFd,
                InjectionMethod::LocalSocket,
            ],
            allow_environment_fallback: false,
            terminate_child_on_revoke: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InjectionReceipt {
    pub method: InjectionMethod,
    pub audience: String,
    pub purpose: InjectionPurpose,
    pub material_persisted: bool,
    pub residual_risk: String,
    pub termination_required_on_revoke: bool,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum InjectionError {
    #[error("injection purpose does not match SecretRef purpose")]
    PurposeMismatch,
    #[error("environment fallback is forbidden for this secret")]
    EnvironmentForbidden,
    #[error("environment key does not match the injection purpose")]
    EnvironmentKeyMismatch,
    #[error("secret channel write failed")]
    ChannelWrite,
    #[error("secret audience is empty")]
    EmptyAudience,
}

pub fn inject_via_channel(
    mut writer: impl Write,
    material: SecretMaterial,
    scope: &SecretLeaseScope,
    purpose: InjectionPurpose,
    method: InjectionMethod,
) -> Result<InjectionReceipt, InjectionError> {
    if scope.audience.is_empty() {
        return Err(InjectionError::EmptyAudience);
    }
    validate_purpose(scope.purpose, purpose)?;
    if method == InjectionMethod::TargetChildEnvironment {
        return Err(InjectionError::EnvironmentForbidden);
    }
    writer
        .write_all(material.expose_to_child_process())
        .and_then(|_| writer.flush())
        .map_err(|_| InjectionError::ChannelWrite)?;
    Ok(InjectionReceipt {
        method,
        audience: scope.audience.clone(),
        purpose,
        material_persisted: false,
        residual_risk: "target process may retain material until it exits".to_string(),
        termination_required_on_revoke: true,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvironmentInjectionHandle {
    key: String,
    pub receipt: InjectionReceipt,
}

impl EnvironmentInjectionHandle {
    pub fn cleanup(self, environment: &mut ChildEnvironment) {
        environment.vars.remove(&self.key);
    }
}

pub fn inject_target_child_environment(
    environment: &mut ChildEnvironment,
    key: &str,
    material: SecretMaterial,
    scope: &SecretLeaseScope,
    purpose: InjectionPurpose,
    policy: &InjectionPolicy,
) -> Result<EnvironmentInjectionHandle, InjectionError> {
    if !policy.allow_environment_fallback || purpose == InjectionPurpose::Signing {
        return Err(InjectionError::EnvironmentForbidden);
    }
    validate_purpose(scope.purpose, purpose)?;
    if expected_environment_key(purpose) != Some(key) {
        return Err(InjectionError::EnvironmentKeyMismatch);
    }
    environment.vars.insert(
        key.to_string(),
        String::from_utf8_lossy(material.expose_to_child_process()).to_string(),
    );
    Ok(EnvironmentInjectionHandle {
        key: key.to_string(),
        receipt: InjectionReceipt {
            method: InjectionMethod::TargetChildEnvironment,
            audience: scope.audience.clone(),
            purpose,
            material_persisted: false,
            residual_risk:
                "environment material remains in the already-started target child until termination"
                    .to_string(),
            termination_required_on_revoke: policy.terminate_child_on_revoke,
        },
    })
}

pub fn redact_secret_forms(text: &str, secrets: impl IntoIterator<Item = Vec<u8>>) -> String {
    let mut output = text.to_string();
    for bytes in secrets {
        if bytes.is_empty() {
            continue;
        }
        let raw = String::from_utf8_lossy(&bytes).to_string();
        let forms = [
            raw.clone(),
            base64_encode(&bytes),
            hex_encode(&bytes),
            percent_encode(&bytes),
            serde_json::to_string(&raw)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string(),
        ];
        for form in forms {
            if !form.is_empty() {
                output = output.replace(&form, "[REDACTED_SECRET]");
            }
        }
    }
    output
}

pub fn scan_for_secret_canary(
    sinks: &BTreeMap<String, String>,
    canary_forms: &[String],
) -> Vec<String> {
    sinks
        .iter()
        .filter(|(_, value)| canary_forms.iter().any(|canary| value.contains(canary)))
        .map(|(sink, _)| sink.clone())
        .collect()
}

fn validate_purpose(
    secret_purpose: SecretPurpose,
    injection_purpose: InjectionPurpose,
) -> Result<(), InjectionError> {
    let valid = match secret_purpose {
        SecretPurpose::ProviderCredential => matches!(
            injection_purpose,
            InjectionPurpose::ProviderApi | InjectionPurpose::OAuth
        ),
        SecretPurpose::RemoteExecutionCredential => injection_purpose == InjectionPurpose::Ssh,
        SecretPurpose::SigningKey => injection_purpose == InjectionPurpose::Signing,
        SecretPurpose::UserDefined => matches!(
            injection_purpose,
            InjectionPurpose::Database | InjectionPurpose::UserDefined
        ),
    };
    if valid {
        Ok(())
    } else {
        Err(InjectionError::PurposeMismatch)
    }
}

fn expected_environment_key(purpose: InjectionPurpose) -> Option<&'static str> {
    match purpose {
        InjectionPurpose::ProviderApi => Some("AISDK_PROVIDER_TOKEN"),
        InjectionPurpose::Ssh => Some("RHO_SSH_CREDENTIAL"),
        InjectionPurpose::OAuth => Some("RHO_OAUTH_TOKEN"),
        InjectionPurpose::Database => Some("RHO_DATABASE_CREDENTIAL"),
        InjectionPurpose::UserDefined => Some("RHO_USER_SECRET"),
        InjectionPurpose::Signing => None,
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = (a << 16) | (b << 8) | c;
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn percent_encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
                (*byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

pub fn injection_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "scoped_channel",
            "target_env_fallback",
            "structured_redaction",
        ],
        &[
            "long_lived_prompt_material",
            "token_passthrough",
            "broad_child_environment",
            "plaintext_persistence",
        ],
    )
}
