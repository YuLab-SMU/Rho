use std::{fmt, str::FromStr};

use chrono::DateTime;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use thiserror::Error;

use crate::{DataClass, ProjectId, ProjectRevision, StateRevision};

pub const AUTHORITY_CONTRACT_VERSION: u16 = 1;
pub const MAX_AUTHORITY_ID_BYTES: usize = 256;
pub const MAX_AUTHORITY_LABEL_BYTES: usize = 1_024;
pub const MAX_AUTHORITY_LIMITATIONS: usize = 32;
pub const MAX_AUTHORITY_LIMITATION_BYTES: usize = 2_048;
pub const MAX_SOURCE_PATH_BYTES: usize = 4_096;
pub const MAX_SOURCE_EXCERPT_BYTES: usize = 16 * 1_024;
pub const MAX_RECEIPT_BATCH_ITEMS: usize = 500;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityKindV1 {
    Run,
    Job,
    Artifact,
    Approval,
    Patch,
    Revision,
    EnvironmentSnapshot,
    SourceAnchor,
    CheckFinding,
    AgentTurn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityStatusV1 {
    Pending,
    Running,
    Present,
    Succeeded,
    Failed,
    Uncertain,
    Cancelled,
    Committed,
    Approved,
    Rejected,
    Missing,
    Stale,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AuthorityContractError {
    #[error("authority contract version is unsupported")]
    UnsupportedVersion,
    #[error("authority {field} must not be empty")]
    Empty { field: &'static str },
    #[error("authority {field} exceeds {max} bytes")]
    TooLong { field: &'static str, max: usize },
    #[error("authority {field} contains leading, trailing, or control characters")]
    InvalidText { field: &'static str },
    #[error("authority digest must use sha256:<64 lowercase hex chars>")]
    InvalidDigest,
    #[error("authority timestamp is not RFC 3339")]
    InvalidTimestamp,
    #[error("authority reference kind mismatch: expected {expected:?}, actual {actual:?}")]
    KindMismatch {
        expected: AuthorityKindV1,
        actual: AuthorityKindV1,
    },
    #[error("authority receipt status is invalid for {kind:?}: {status:?}")]
    InvalidStatus {
        kind: AuthorityKindV1,
        status: AuthorityStatusV1,
    },
    #[error("source anchor path or range is invalid")]
    InvalidSourceAnchor,
    #[error("authority limitation count exceeds {max}")]
    TooManyLimitations { max: usize },
    #[error("authority receipt batch exceeds {max} items")]
    BatchTooLarge { max: usize },
    #[error("authority receipt batch cursor is invalid")]
    InvalidCursor,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AuthorityDigest(String);

impl AuthorityDigest {
    pub fn new(value: impl Into<String>) -> Result<Self, AuthorityContractError> {
        let value = value.into();
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err(AuthorityContractError::InvalidDigest);
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(AuthorityContractError::InvalidDigest);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Debug for AuthorityDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AuthorityDigest")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for AuthorityDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for AuthorityDigest {
    type Err = AuthorityContractError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl Serialize for AuthorityDigest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for AuthorityDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct AuthorityRefV1 {
    pub contract_version: u16,
    pub project_id: ProjectId,
    pub kind: AuthorityKindV1,
    pub authority_id: String,
}

impl AuthorityRefV1 {
    pub fn new(
        project_id: ProjectId,
        kind: AuthorityKindV1,
        authority_id: impl Into<String>,
    ) -> Result<Self, AuthorityContractError> {
        let value = Self {
            contract_version: AUTHORITY_CONTRACT_VERSION,
            project_id,
            kind,
            authority_id: authority_id.into(),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        if self.contract_version != AUTHORITY_CONTRACT_VERSION {
            return Err(AuthorityContractError::UnsupportedVersion);
        }
        validate_text(&self.authority_id, "authority_id", MAX_AUTHORITY_ID_BYTES)
    }

    pub fn expect_kind(&self, expected: AuthorityKindV1) -> Result<(), AuthorityContractError> {
        self.validate()?;
        if self.kind != expected {
            return Err(AuthorityContractError::KindMismatch {
                expected,
                actual: self.kind,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RevisionRefV1 {
    pub reference: AuthorityRefV1,
    pub state_revision: Option<StateRevision>,
    pub project_revision: ProjectRevision,
}

impl RevisionRefV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.expect_kind(AuthorityKindV1::Revision)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceAnchorV1 {
    pub reference: AuthorityRefV1,
    pub path: String,
    pub start_line: u32,
    pub start_column: Option<u32>,
    pub end_line: u32,
    pub end_column: Option<u32>,
    pub content_digest: AuthorityDigest,
    pub bounded_excerpt: String,
    pub project_revision: ProjectRevision,
    pub captured_at: String,
}

impl SourceAnchorV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.expect_kind(AuthorityKindV1::SourceAnchor)?;
        if normalize_relative_path(&self.path).as_deref() != Some(self.path.as_str())
            || self.path.len() > MAX_SOURCE_PATH_BYTES
            || self.start_line == 0
            || self.end_line < self.start_line
            || self.end_line.saturating_sub(self.start_line) >= 200
            || self.start_column == Some(0)
            || self.end_column == Some(0)
            || (self.start_line == self.end_line
                && self.start_column.is_some()
                && self.end_column.is_some()
                && self.start_column > self.end_column)
            || self.bounded_excerpt.len() > MAX_SOURCE_EXCERPT_BYTES
        {
            return Err(AuthorityContractError::InvalidSourceAnchor);
        }
        validate_timestamp(&self.captured_at)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorityObservationV1 {
    pub reference: AuthorityRefV1,
    pub status: AuthorityStatusV1,
    pub digest: Option<AuthorityDigest>,
    pub project_revision: Option<ProjectRevision>,
    pub state_revision: Option<StateRevision>,
    pub observed_at: String,
    pub limitations: Vec<String>,
}

impl AuthorityObservationV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.validate()?;
        validate_timestamp(&self.observed_at)?;
        validate_limitations(&self.limitations)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunReceiptV1 {
    pub reference: AuthorityRefV1,
    pub status: AuthorityStatusV1,
    pub revision_before: Option<RevisionRefV1>,
    pub revision_after: Option<RevisionRefV1>,
    pub environment_ref: Option<AuthorityRefV1>,
    pub source_anchor_ref: Option<AuthorityRefV1>,
    pub captured_at: String,
}

impl RunReceiptV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.expect_kind(AuthorityKindV1::Run)?;
        validate_status(
            AuthorityKindV1::Run,
            self.status,
            &[
                AuthorityStatusV1::Pending,
                AuthorityStatusV1::Running,
                AuthorityStatusV1::Succeeded,
                AuthorityStatusV1::Failed,
                AuthorityStatusV1::Uncertain,
                AuthorityStatusV1::Cancelled,
            ],
        )?;
        validate_same_project_refs(
            &self.reference,
            self.environment_ref
                .iter()
                .chain(self.source_anchor_ref.iter()),
        )?;
        if let Some(reference) = &self.environment_ref {
            reference.expect_kind(AuthorityKindV1::EnvironmentSnapshot)?;
        }
        if let Some(reference) = &self.source_anchor_ref {
            reference.expect_kind(AuthorityKindV1::SourceAnchor)?;
        }
        for revision in [&self.revision_before, &self.revision_after]
            .into_iter()
            .flatten()
        {
            revision.validate()?;
            ensure_same_project(&self.reference, &revision.reference)?;
        }
        validate_timestamp(&self.captured_at)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactReceiptV1 {
    pub reference: AuthorityRefV1,
    pub digest: AuthorityDigest,
    pub byte_size: u64,
    pub media_type: String,
    pub producing_run_ref: Option<AuthorityRefV1>,
    pub revision: RevisionRefV1,
    pub captured_at: String,
}

impl ArtifactReceiptV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.expect_kind(AuthorityKindV1::Artifact)?;
        validate_text(&self.media_type, "media_type", MAX_AUTHORITY_LABEL_BYTES)?;
        self.revision.validate()?;
        ensure_same_project(&self.reference, &self.revision.reference)?;
        if let Some(reference) = &self.producing_run_ref {
            reference.expect_kind(AuthorityKindV1::Run)?;
            ensure_same_project(&self.reference, reference)?;
        }
        validate_timestamp(&self.captured_at)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalReceiptV1 {
    pub reference: AuthorityRefV1,
    pub status: AuthorityStatusV1,
    pub agent_turn_ref: Option<AuthorityRefV1>,
    pub effect_digest: AuthorityDigest,
    pub captured_at: String,
}

impl ApprovalReceiptV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.expect_kind(AuthorityKindV1::Approval)?;
        validate_status(
            AuthorityKindV1::Approval,
            self.status,
            &[
                AuthorityStatusV1::Pending,
                AuthorityStatusV1::Approved,
                AuthorityStatusV1::Rejected,
                AuthorityStatusV1::Cancelled,
                AuthorityStatusV1::Committed,
            ],
        )?;
        if let Some(reference) = &self.agent_turn_ref {
            reference.expect_kind(AuthorityKindV1::AgentTurn)?;
            ensure_same_project(&self.reference, reference)?;
        }
        validate_timestamp(&self.captured_at)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentReceiptV1 {
    pub reference: AuthorityRefV1,
    pub digest: AuthorityDigest,
    pub captured_at: String,
}

impl EnvironmentReceiptV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference
            .expect_kind(AuthorityKindV1::EnvironmentSnapshot)?;
        validate_timestamp(&self.captured_at)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FindingReceiptV1 {
    pub reference: AuthorityRefV1,
    pub rule_id: String,
    pub source_refs: Vec<AuthorityRefV1>,
    pub captured_at: String,
}

impl FindingReceiptV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.expect_kind(AuthorityKindV1::CheckFinding)?;
        validate_text(&self.rule_id, "rule_id", MAX_AUTHORITY_LABEL_BYTES)?;
        if self.source_refs.len() > MAX_RECEIPT_BATCH_ITEMS {
            return Err(AuthorityContractError::BatchTooLarge {
                max: MAX_RECEIPT_BATCH_ITEMS,
            });
        }
        validate_same_project_refs(&self.reference, self.source_refs.iter())?;
        validate_timestamp(&self.captured_at)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTurnRefV1 {
    pub reference: AuthorityRefV1,
    pub status: AuthorityStatusV1,
    pub captured_at: String,
}

impl AgentTurnRefV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.expect_kind(AuthorityKindV1::AgentTurn)?;
        validate_status(
            AuthorityKindV1::AgentTurn,
            self.status,
            &[
                AuthorityStatusV1::Pending,
                AuthorityStatusV1::Running,
                AuthorityStatusV1::Succeeded,
                AuthorityStatusV1::Failed,
                AuthorityStatusV1::Cancelled,
                AuthorityStatusV1::Uncertain,
            ],
        )?;
        validate_timestamp(&self.captured_at)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "receipt", rename_all = "snake_case")]
pub enum AuthorityReceiptV1 {
    Run(RunReceiptV1),
    Artifact(ArtifactReceiptV1),
    Approval(ApprovalReceiptV1),
    Environment(EnvironmentReceiptV1),
    SourceAnchor(SourceAnchorV1),
    Finding(FindingReceiptV1),
    AgentTurn(AgentTurnRefV1),
}

impl AuthorityReceiptV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        match self {
            Self::Run(value) => value.validate(),
            Self::Artifact(value) => value.validate(),
            Self::Approval(value) => value.validate(),
            Self::Environment(value) => value.validate(),
            Self::SourceAnchor(value) => value.validate(),
            Self::Finding(value) => value.validate(),
            Self::AgentTurn(value) => value.validate(),
        }
    }

    pub fn reference(&self) -> &AuthorityRefV1 {
        match self {
            Self::Run(value) => &value.reference,
            Self::Artifact(value) => &value.reference,
            Self::Approval(value) => &value.reference,
            Self::Environment(value) => &value.reference,
            Self::SourceAnchor(value) => &value.reference,
            Self::Finding(value) => &value.reference,
            Self::AgentTurn(value) => &value.reference,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorityReceiptBatchV1 {
    pub contract_version: u16,
    pub feed_id: String,
    pub after_cursor: u64,
    pub next_cursor: u64,
    pub has_more: bool,
    pub receipts: Vec<AuthorityReceiptV1>,
}

impl AuthorityReceiptBatchV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        if self.contract_version != AUTHORITY_CONTRACT_VERSION {
            return Err(AuthorityContractError::UnsupportedVersion);
        }
        validate_text(&self.feed_id, "feed_id", MAX_AUTHORITY_ID_BYTES)?;
        if self.receipts.len() > MAX_RECEIPT_BATCH_ITEMS {
            return Err(AuthorityContractError::BatchTooLarge {
                max: MAX_RECEIPT_BATCH_ITEMS,
            });
        }
        if self.next_cursor < self.after_cursor
            || (!self.receipts.is_empty() && self.next_cursor == self.after_cursor)
        {
            return Err(AuthorityContractError::InvalidCursor);
        }
        for receipt in &self.receipts {
            receipt.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProvenanceRefV1 {
    pub reference: AuthorityRefV1,
    pub digest: Option<AuthorityDigest>,
    pub project_revision: Option<ProjectRevision>,
    pub state_revision: Option<StateRevision>,
    pub captured_at: String,
    pub bounded_excerpt: Option<String>,
    pub data_class: DataClass,
}

impl ProvenanceRefV1 {
    pub fn validate(&self) -> Result<(), AuthorityContractError> {
        self.reference.validate()?;
        validate_timestamp(&self.captured_at)?;
        if self
            .bounded_excerpt
            .as_ref()
            .is_some_and(|value| value.len() > MAX_SOURCE_EXCERPT_BYTES)
        {
            return Err(AuthorityContractError::TooLong {
                field: "bounded_excerpt",
                max: MAX_SOURCE_EXCERPT_BYTES,
            });
        }
        Ok(())
    }
}

fn validate_text(
    value: &str,
    field: &'static str,
    max: usize,
) -> Result<(), AuthorityContractError> {
    if value.is_empty() {
        return Err(AuthorityContractError::Empty { field });
    }
    if value.len() > max {
        return Err(AuthorityContractError::TooLong { field, max });
    }
    if value.trim() != value || value.chars().any(char::is_control) {
        return Err(AuthorityContractError::InvalidText { field });
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> Result<(), AuthorityContractError> {
    validate_text(value, "timestamp", 128)?;
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| AuthorityContractError::InvalidTimestamp)
}

fn validate_limitations(values: &[String]) -> Result<(), AuthorityContractError> {
    if values.len() > MAX_AUTHORITY_LIMITATIONS {
        return Err(AuthorityContractError::TooManyLimitations {
            max: MAX_AUTHORITY_LIMITATIONS,
        });
    }
    for value in values {
        validate_text(value, "limitation", MAX_AUTHORITY_LIMITATION_BYTES)?;
    }
    Ok(())
}

fn validate_status(
    kind: AuthorityKindV1,
    status: AuthorityStatusV1,
    allowed: &[AuthorityStatusV1],
) -> Result<(), AuthorityContractError> {
    if !allowed.contains(&status) {
        return Err(AuthorityContractError::InvalidStatus { kind, status });
    }
    Ok(())
}

fn ensure_same_project(
    owner: &AuthorityRefV1,
    referenced: &AuthorityRefV1,
) -> Result<(), AuthorityContractError> {
    referenced.validate()?;
    if owner.project_id != referenced.project_id {
        return Err(AuthorityContractError::InvalidText {
            field: "cross_project_reference",
        });
    }
    Ok(())
}

fn validate_same_project_refs<'a>(
    owner: &AuthorityRefV1,
    refs: impl IntoIterator<Item = &'a AuthorityRefV1>,
) -> Result<(), AuthorityContractError> {
    for reference in refs {
        ensure_same_project(owner, reference)?;
    }
    Ok(())
}

fn normalize_relative_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains(':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        parts.push(part);
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(value: &str) -> ProjectId {
        ProjectId::new(value).unwrap()
    }

    fn authority_ref(kind: AuthorityKindV1, id: &str) -> AuthorityRefV1 {
        AuthorityRefV1::new(project("project:a"), kind, id).unwrap()
    }

    fn revision() -> RevisionRefV1 {
        RevisionRefV1 {
            reference: authority_ref(AuthorityKindV1::Revision, "revision:7"),
            state_revision: Some(StateRevision(3)),
            project_revision: ProjectRevision(7),
        }
    }

    #[test]
    fn validates_typed_receipts_and_batch_cursor() {
        let run = RunReceiptV1 {
            reference: authority_ref(AuthorityKindV1::Run, "run:1"),
            status: AuthorityStatusV1::Succeeded,
            revision_before: Some(revision()),
            revision_after: Some(revision()),
            environment_ref: Some(authority_ref(
                AuthorityKindV1::EnvironmentSnapshot,
                "environment:1",
            )),
            source_anchor_ref: None,
            captured_at: "2026-08-31T21:00:00Z".to_string(),
        };
        run.validate().unwrap();
        AuthorityReceiptBatchV1 {
            contract_version: AUTHORITY_CONTRACT_VERSION,
            feed_id: "authority-feed:project-a".to_string(),
            after_cursor: 4,
            next_cursor: 5,
            has_more: false,
            receipts: vec![AuthorityReceiptV1::Run(run)],
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn rejects_kind_status_and_project_mismatches() {
        let mut run = RunReceiptV1 {
            reference: authority_ref(AuthorityKindV1::Artifact, "artifact:1"),
            status: AuthorityStatusV1::Committed,
            revision_before: None,
            revision_after: None,
            environment_ref: None,
            source_anchor_ref: None,
            captured_at: "2026-08-31T21:00:00Z".to_string(),
        };
        assert!(matches!(
            run.validate(),
            Err(AuthorityContractError::KindMismatch { .. })
        ));
        run.reference = authority_ref(AuthorityKindV1::Run, "run:1");
        assert!(matches!(
            run.validate(),
            Err(AuthorityContractError::InvalidStatus { .. })
        ));
        run.status = AuthorityStatusV1::Succeeded;
        run.environment_ref = Some(
            AuthorityRefV1::new(
                project("project:b"),
                AuthorityKindV1::EnvironmentSnapshot,
                "environment:1",
            )
            .unwrap(),
        );
        assert!(run.validate().is_err());
    }

    #[test]
    fn source_anchor_is_relative_bounded_and_digest_bound() {
        let valid = SourceAnchorV1 {
            reference: authority_ref(AuthorityKindV1::SourceAnchor, "source:1"),
            path: "analysis/model.R".to_string(),
            start_line: 2,
            start_column: Some(1),
            end_line: 8,
            end_column: Some(20),
            content_digest: AuthorityDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            bounded_excerpt: "fit <- lm(y ~ x)".to_string(),
            project_revision: ProjectRevision(7),
            captured_at: "2026-08-31T21:00:00Z".to_string(),
        };
        valid.validate().unwrap();
        let mut escaping = valid.clone();
        escaping.path = "../outside.R".to_string();
        assert!(matches!(
            escaping.validate(),
            Err(AuthorityContractError::InvalidSourceAnchor)
        ));
        assert!(AuthorityDigest::new("a".repeat(64)).is_err());
    }

    #[test]
    fn rejects_oversized_batches_without_partial_semantics() {
        let batch = AuthorityReceiptBatchV1 {
            contract_version: AUTHORITY_CONTRACT_VERSION,
            feed_id: "feed".to_string(),
            after_cursor: 0,
            next_cursor: 1,
            has_more: true,
            receipts: (0..=MAX_RECEIPT_BATCH_ITEMS)
                .map(|index| {
                    AuthorityReceiptV1::AgentTurn(AgentTurnRefV1 {
                        reference: authority_ref(
                            AuthorityKindV1::AgentTurn,
                            &format!("turn:{index}"),
                        ),
                        status: AuthorityStatusV1::Succeeded,
                        captured_at: "2026-08-31T21:00:00Z".to_string(),
                    })
                })
                .collect(),
        };
        assert!(matches!(
            batch.validate(),
            Err(AuthorityContractError::BatchTooLarge { .. })
        ));
    }
}
