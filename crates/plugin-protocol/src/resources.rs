use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const RESOURCE_CHANNEL_VERSION: u32 = 1;
pub const MAX_RESOURCE_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_RESOURCE_READ_BYTES: u32 = 256 * 1024;

/// An ephemeral, instance-only data transport. Never a general Host credential.
/// Connect once per transfer; send a BE u32 JSON length, the header, then raw
/// upload bytes, and close the write half. Responses use the same header framing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourceChannel {
    pub version: u32,
    pub socket: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourceDeclaration {
    pub digest: ContentDigest,
    pub media_type: String,
    pub bytes: u64,
}
impl ResourceDeclaration {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(
            self.bytes <= MAX_RESOURCE_BYTES,
            "resource exceeds byte limit",
        )?;
        bounded_text(&self.media_type, 128, "resource media type")?;
        let essence = self.media_type.split(';').next().unwrap_or("");
        let parts: Vec<_> = essence.split('/').collect();
        require(
            parts.len() == 2
                && parts.iter().all(|part| {
                    !part.is_empty()
                        && part
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
                }),
            "invalid resource media type",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourceRead {
    pub reference: ResourceReference,
    pub offset: u64,
    pub limit: u32,
}
impl ResourceRead {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        ResourceDeclaration {
            digest: self.reference.digest.clone(),
            media_type: self.reference.media_type.clone(),
            bytes: self.reference.bytes,
        }
        .validate()?;
        require(
            self.limit > 0 && self.limit <= MAX_RESOURCE_READ_BYTES,
            "resource read limit must be 1–262144 bytes",
        )?;
        require(
            self.offset <= self.reference.bytes,
            "resource offset exceeds length",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourceInspect {
    pub reference: ResourceReference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourceList {
    pub owner: Option<InstanceRef>,
    pub after: Option<ResourceId>,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourcePage {
    pub items: Vec<ResourceReference>,
    pub next: Option<ResourceId>,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourceChunk {
    pub reference: ResourceReference,
    pub offset: u64,
    pub base64: String,
    pub next: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ResourceTransfer {
    Put(ResourceDeclaration),
    Read(ResourceRead),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourceTransferRequest {
    pub version: u32,
    pub token: String,
    pub parent_request: RequestId,
    pub transfer: ResourceTransfer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ResourceTransferResponse {
    Stored(ResourceReference),
    /// Exactly `bytes` raw bytes follow this header, then EOF.
    Data {
        reference: ResourceReference,
        offset: u64,
        bytes: u32,
        next: Option<u64>,
    },
    Error {
        message: String,
    },
}
