//! Package bytes use bounded, scoped transfers rather than inline operations or
//! caller-supplied filesystem paths. Staging never installs or executes a package.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const ARCHIVE_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_PLUGIN_ARCHIVE_BYTES: u64 = MAX_PACKAGE_BYTES * 4 / 3 + 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchiveReference {
    pub archive: ArchiveId,
    pub digest: ContentDigest,
    pub bytes: u64,
}
impl PluginArchiveReference {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(
            self.bytes > 0 && self.bytes <= MAX_PLUGIN_ARCHIVE_BYTES,
            "archive size exceeds its bound",
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct StagePluginArchive {
    pub reference: PluginArchiveReference,
    pub offset: u64,
    pub base64: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchiveProgress {
    pub reference: PluginArchiveReference,
    pub received: u64,
    /// All ranges are staged. This alone is not package validation or import.
    pub complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchiveArguments {
    pub reference: PluginArchiveReference,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadPluginArchive {
    pub reference: PluginArchiveReference,
    pub offset: u64,
    pub limit: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchiveChunk {
    pub reference: PluginArchiveReference,
    pub offset: u64,
    pub base64: String,
    pub next: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ExportPluginArchive {
    pub revision: RevisionId,
    /// Exact artifact identities, sorted and unique. Empty exports source only.
    pub artifacts: Vec<ArtifactId>,
}
impl ExportPluginArchive {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(
            self.artifacts.len() <= 32 && self.artifacts.windows(2).all(|pair| pair[0] < pair[1]),
            "export artifacts must be sorted, unique and bounded",
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchiveReceipt {
    pub reference: PluginArchiveReference,
    pub revision: RevisionId,
    pub plugin: PluginId,
    pub artifacts: Vec<ArtifactId>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchiveInspection {
    pub reference: PluginArchiveReference,
    pub revision: RevisionId,
    pub plugin: PluginId,
    pub name: String,
    pub version: String,
    pub description: String,
    pub source_files: u32,
    pub artifacts: Vec<PluginArtifactSummary>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchiveOperationArguments {
    pub operation_id: OperationId,
}

/// Explicit transient-byte cleanup. Receipts, revisions and artifacts are retained.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchiveDiscarded {
    pub reference: PluginArchiveReference,
    pub discarded: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn archive_contract_rejects_implicit_artifacts_paths_and_unbounded_sizes() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let mut reference = PluginArchiveReference {
            archive: ArchiveId::new("archive").unwrap(),
            digest: ContentDigest::new(&digest).unwrap(),
            bytes: 1,
        };
        reference.validate().unwrap();
        reference.bytes = MAX_PLUGIN_ARCHIVE_BYTES;
        reference.validate().unwrap();
        reference.bytes += 1;
        assert!(reference.validate().is_err());
        reference.bytes = 0;
        assert!(reference.validate().is_err());
        assert!(
            serde_json::from_value::<PluginArchiveArguments>(json!({"path":"/package"})).is_err()
        );
        assert!(serde_json::from_value::<ExportPluginArchive>(json!({"revision":digest})).is_err());
        let mut export = ExportPluginArchive {
            revision: RevisionId::new(&digest).unwrap(),
            artifacts: vec![],
        };
        export.validate().unwrap();
        export.artifacts = vec![ArtifactId::new(&digest).unwrap(); 2];
        assert!(export.validate().is_err());
        let mut foreign = json!({"archive":"archive","digest":digest,"bytes":1});
        foreign["project"] = json!("other");
        assert!(serde_json::from_value::<PluginArchiveReference>(foreign).is_err());
    }
}
