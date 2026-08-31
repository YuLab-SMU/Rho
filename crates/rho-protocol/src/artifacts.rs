use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use thiserror::Error;

use crate::{
    ids::{ArtifactId, ExecutionId, JobId, RunId},
    revisions::RevisionStamp,
    versioning::CANONICAL_SCHEMA_VERSION,
};

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DigestError {
    #[error("artifact digest must use sha256:<64 lowercase hex chars>")]
    InvalidSha256,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ArtifactDigest(String);

impl ArtifactDigest {
    pub fn new(value: impl Into<String>) -> Result<Self, DigestError> {
        let value = value.into();
        let hex = value
            .strip_prefix("sha256:")
            .ok_or(DigestError::InvalidSha256)?;
        if hex.len() != 64
            || !hex
                .chars()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
        {
            return Err(DigestError::InvalidSha256);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ArtifactDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("ArtifactDigest").field(&self.0).finish()
    }
}

impl fmt::Display for ArtifactDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for ArtifactDigest {
    type Err = DigestError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl Serialize for ArtifactDigest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ArtifactDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactEdgeKind {
    Used,
    GeneratedBy,
    DerivedFrom,
    RenderedFrom,
    Supersedes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactRef {
    pub artifact_id: ArtifactId,
    pub digest: ArtifactDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactEdge {
    pub from: ArtifactId,
    pub to: ArtifactId,
    pub kind: ArtifactEdgeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactProducer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<ExecutionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<JobId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactManifest {
    pub schema_version: u16,
    pub artifact_id: ArtifactId,
    pub digest: ArtifactDigest,
    pub byte_size: u64,
    pub media_type: String,
    pub producer: ArtifactProducer,
    pub revision: RevisionStamp,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<ArtifactRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_digest: Option<ArtifactDigest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_digest: Option<ArtifactDigest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edges: Vec<ArtifactEdge>,
}

impl ArtifactManifest {
    pub fn new(
        artifact_id: ArtifactId,
        digest: ArtifactDigest,
        byte_size: u64,
        media_type: impl Into<String>,
        producer: ArtifactProducer,
        revision: RevisionStamp,
    ) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            artifact_id,
            digest,
            byte_size,
            media_type: media_type.into(),
            producer,
            revision,
            inputs: Vec::new(),
            code_digest: None,
            environment_digest: None,
            edges: Vec::new(),
        }
    }
}
