use crate::OperationId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const OPERATION_EVIDENCE_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_OPERATION_COMMIT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_INLINE_CONTRACT_CANDIDATE_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OperationEvidenceReference {
    pub operation_id: OperationId,
    pub kind: OperationEvidenceKind,
    pub sha256: String,
    pub byte_size: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum OperationEvidenceKind {
    UncommittedOwnerResult,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OperationReadEvidenceArguments {
    pub reference: OperationEvidenceReference,
    /// Zero-based byte offset in the original UTF-8 JSON evidence document.
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "evidence_page_bytes")]
    #[schemars(range(min = 1, max = 65536))]
    pub limit_bytes: u32,
}
fn evidence_page_bytes() -> u32 {
    OPERATION_EVIDENCE_CHUNK_BYTES as u32
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OperationEvidencePage {
    pub reference: OperationEvidenceReference,
    pub offset: u64,
    /// Exact original JSON bytes. Reassemble before UTF-8 decoding or parsing.
    #[schemars(length(max = 65536))]
    pub bytes: Vec<u8>,
    pub next_offset: Option<u64>,
}
