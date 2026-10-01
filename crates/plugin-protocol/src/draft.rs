//! Generic synchronized drafts. Bytes and metadata have no file, language or
//! runtime semantics. A draft version is not a filesystem or execution receipt.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const MAX_DRAFT_CHUNK_BYTES: u32 = 64 * 1024;
pub const MAX_DRAFT_BYTES: u32 = 8 * 1024 * 1024;
pub const MAX_DRAFT_METADATA_BYTES: usize = 32 * 1024;
pub const MAX_DRAFT_PAGE_SIZE: u16 = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DraftSource {
    pub revision: RevisionId,
    pub contribution: ContributionId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DraftChunkReference {
    pub digest: ContentDigest,
    pub bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DraftContent {
    pub digest: ContentDigest,
    pub bytes: u32,
    /// Canonical 64 KiB chunks, except for the final chunk. Empty content has
    /// no chunks. Full content and every chunk are verified before publication.
    pub chunks: Vec<DraftChunkReference>,
}
impl DraftContent {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(self.bytes <= MAX_DRAFT_BYTES, "draft exceeds 8 MiB")?;
        require(
            self.chunks.len() <= (MAX_DRAFT_BYTES / MAX_DRAFT_CHUNK_BYTES) as usize,
            "draft has too many chunks",
        )?;
        let mut bytes = 0u32;
        for (index, chunk) in self.chunks.iter().enumerate() {
            require(
                chunk.bytes > 0 && chunk.bytes <= MAX_DRAFT_CHUNK_BYTES,
                "draft chunk must contain 1–65536 bytes",
            )?;
            require(
                index + 1 == self.chunks.len() || chunk.bytes == MAX_DRAFT_CHUNK_BYTES,
                "only the last draft chunk may be short",
            )?;
            bytes += chunk.bytes;
        }
        require(
            bytes == self.bytes,
            "draft chunk lengths do not match the content",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DocumentDraft {
    pub draft: DraftId,
    pub project: ProjectId,
    pub principal: PrincipalId,
    pub window: WindowId,
    pub source: DraftSource,
    /// One draft's compare-and-swap version, never a scientific revision.
    pub version: u32,
    pub content: DraftContent,
    pub metadata: Value,
    /// Explicit discard releases content and its source revision. The tombstone
    /// prevents a delayed first save from recreating the discarded identity.
    pub discarded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct StageDraftChunk {
    pub window: WindowId,
    pub draft: DraftId,
    /// One captured save attempt. Concurrent captures retain separate staging
    /// leases even when their byte chunks are identical.
    pub upload: RequestId,
    pub digest: ContentDigest,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SaveDocumentDraft {
    pub window: WindowId,
    pub draft: DraftId,
    pub upload: RequestId,
    pub source: DraftSource,
    /// None creates a new identity; Some updates only that existing version.
    pub expected_version: Option<u32>,
    pub content: DraftContent,
    pub metadata: Value,
}
impl SaveDocumentDraft {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.content.validate()?;
        require(
            serde_json::to_vec(&self.metadata)
                .map_err(|e| ProtocolError(e.to_string()))?
                .len()
                <= MAX_DRAFT_METADATA_BYTES,
            "draft metadata exceeds 32 KiB",
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DocumentDraftArguments {
    pub window: WindowId,
    pub draft: DraftId,
}

/// Enumerate retained, non-discarded drafts in one explicit window. Each page
/// is a current observation, not an immutable snapshot across subsequent reads.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ListDocumentDrafts {
    pub window: WindowId,
    pub source: Option<DraftSource>,
    /// Exclusive identity cursor, independent of the cursor draft's existence.
    pub after: Option<DraftId>,
    #[schemars(range(min = 1, max = 20))]
    pub limit: u16,
}
impl ListDocumentDrafts {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(
            (1..=MAX_DRAFT_PAGE_SIZE).contains(&self.limit),
            "draft page limit must be 1–20",
        )
    }
}

/// Opaque synchronized metadata; content is read separately at this version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DocumentDraftSummary {
    pub draft: DraftId,
    pub source: DraftSource,
    pub version: u32,
    pub digest: ContentDigest,
    pub bytes: u32,
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DocumentDraftPage {
    #[schemars(length(max = 20))]
    pub drafts: Vec<DocumentDraftSummary>,
    pub next: Option<DraftId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadDocumentDraft {
    pub window: WindowId,
    pub draft: DraftId,
    pub expected_version: u32,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DocumentDraftChunk {
    pub draft: DraftId,
    pub version: u32,
    pub digest: ContentDigest,
    pub offset: u32,
    pub base64: String,
    pub next: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DiscardDocumentDraft {
    pub window: WindowId,
    pub draft: DraftId,
    pub source: DraftSource,
    pub expected_version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reference(bytes: u32) -> DraftChunkReference {
        DraftChunkReference {
            digest: ContentDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            bytes,
        }
    }
    #[test]
    fn content_bounds_are_canonical_and_metadata_is_byte_bounded() {
        let chunk = reference(MAX_DRAFT_CHUNK_BYTES);
        let mut content = DraftContent {
            digest: chunk.digest.clone(),
            bytes: MAX_DRAFT_BYTES,
            chunks: vec![chunk.clone(); 128],
        };
        assert!(content.validate().is_ok());
        content.chunks.push(chunk.clone());
        assert!(content.validate().is_err());
        content.chunks = vec![reference(1), chunk];
        content.bytes = MAX_DRAFT_CHUNK_BYTES + 1;
        assert!(content.validate().is_err());
        content.chunks.reverse();
        assert!(content.validate().is_ok());
        content.bytes += 1;
        assert!(content.validate().is_err());
        content.chunks.clear();
        content.bytes = 0;
        assert!(content.validate().is_ok());
        content.chunks.push(reference(0));
        assert!(content.validate().is_err());
        content.chunks.clear();
        let mut save = SaveDocumentDraft {
            window: WindowId::new("window").unwrap(),
            draft: DraftId::new("draft").unwrap(),
            upload: RequestId::new("upload").unwrap(),
            source: DraftSource {
                revision: RevisionId::new(content.digest.to_string()).unwrap(),
                contribution: ContributionId::new("editor").unwrap(),
            },
            expected_version: None,
            content,
            metadata: Value::String("中".repeat(MAX_DRAFT_METADATA_BYTES / 3 + 1)),
        };
        assert!(save.validate().is_err());
        save.metadata = Value::Null;
        assert!(save.validate().is_ok());
    }
}
