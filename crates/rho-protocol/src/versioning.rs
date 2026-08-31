use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use thiserror::Error;

pub const CANONICAL_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Versioned<T> {
    pub schema_version: u16,
    pub body: T,
}

impl<T> Versioned<T> {
    pub fn new(body: T) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            body,
        }
    }
}

#[derive(Debug, Error)]
pub enum VersionError {
    #[error("canonical JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("schema_version is missing")]
    MissingSchemaVersion,
    #[error("schema_version must be an unsigned integer")]
    InvalidSchemaVersion,
    #[error("unsupported schema_version {actual}; expected {expected}")]
    UnsupportedSchemaVersion { actual: u16, expected: u16 },
    #[error("versioned body is missing")]
    MissingBody,
}

pub fn decode_versioned_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, VersionError> {
    let value: Value = serde_json::from_slice(bytes)?;
    decode_versioned_value(value)
}

pub fn decode_versioned_value<T: DeserializeOwned>(value: Value) -> Result<T, VersionError> {
    let schema_version = value
        .get("schema_version")
        .ok_or(VersionError::MissingSchemaVersion)?
        .as_u64()
        .ok_or(VersionError::InvalidSchemaVersion)?;
    let schema_version =
        u16::try_from(schema_version).map_err(|_| VersionError::InvalidSchemaVersion)?;
    if schema_version != CANONICAL_SCHEMA_VERSION {
        return Err(VersionError::UnsupportedSchemaVersion {
            actual: schema_version,
            expected: CANONICAL_SCHEMA_VERSION,
        });
    }
    let body = value.get("body").ok_or(VersionError::MissingBody)?.clone();
    Ok(serde_json::from_value(body)?)
}
