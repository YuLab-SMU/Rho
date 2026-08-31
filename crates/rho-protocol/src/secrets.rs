use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    ids::{ProviderId, SecretId},
    taxonomy::DestinationClass,
    versioning::CANONICAL_SCHEMA_VERSION,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SecretPurpose {
    ProviderCredential,
    RemoteExecutionCredential,
    SigningKey,
    UserDefined,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretRef {
    pub schema_version: u16,
    pub secret_id: SecretId,
    pub purpose: SecretPurpose,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderId>,
    pub destination_scope: DestinationClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

impl SecretRef {
    pub fn new(
        secret_id: SecretId,
        purpose: SecretPurpose,
        destination_scope: DestinationClass,
    ) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            secret_id,
            purpose,
            provider: None,
            destination_scope,
            expires_at: None,
        }
    }
}

pub struct SecretValue {
    bytes: Vec<u8>,
}

impl SecretValue {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    pub fn expose_to_secret_backend(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretValue(REDACTED)")
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        for byte in &mut self.bytes {
            *byte = 0;
        }
    }
}
