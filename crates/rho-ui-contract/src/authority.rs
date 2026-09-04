//! Typed renderer projections for current Authority facts.
//!
//! These contracts resolve or list facts owned by Store, Execution, CAS,
//! Broker, Workspace and environment authorities. They contain no Claim,
//! support, conflict, promotion or graph semantics.

use serde::{Deserialize, Serialize};

use crate::{ContractError, ProjectId, Validate, validate_opaque_text};

pub const MAX_AUTHORITY_PAGE_SIZE: usize = 200;
pub const MAX_AUTHORITY_RESOLVE_REFS: usize = 500;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityKindViewV1 {
    Run,
    Job,
    Artifact,
    Patch,
    Revision,
    EnvironmentSnapshot,
    SourceAnchor,
    CheckFinding,
    AgentTurn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityStatusViewV1 {
    Pending,
    Running,
    Present,
    Succeeded,
    Failed,
    Uncertain,
    Cancelled,
    Committed,
    Missing,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct AuthorityReferenceViewV1 {
    pub kind: AuthorityKindViewV1,
    pub authority_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct AuthorityObservationViewV1 {
    pub reference: AuthorityReferenceViewV1,
    pub status: AuthorityStatusViewV1,
    pub digest: Option<String>,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub project_revision: Option<u64>,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub state_revision: Option<u64>,
    pub observed_at: String,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct AuthorityResolveRequestV1 {
    pub references: Vec<AuthorityReferenceViewV1>,
}

impl Validate for AuthorityResolveRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.references.len() > MAX_AUTHORITY_RESOLVE_REFS {
            return Err(ContractError::LimitExceeded {
                path: "authority_resolve.references".to_string(),
                limit: MAX_AUTHORITY_RESOLVE_REFS,
                actual: self.references.len(),
            });
        }
        for reference in &self.references {
            validate_authority_id(&reference.authority_id)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct AuthorityResolveResponseV1 {
    pub project_id: ProjectId,
    pub observations: Vec<AuthorityObservationViewV1>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct AuthorityReceiptListRequestV1 {
    pub kind: AuthorityKindViewV1,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub cursor: Option<u64>,
    #[specta(type = crate::UiIpcNumber)]
    pub limit: usize,
}

impl Validate for AuthorityReceiptListRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.limit == 0 || self.limit > MAX_AUTHORITY_PAGE_SIZE {
            return Err(ContractError::LimitExceeded {
                path: "authority_receipt_list.limit".to_string(),
                limit: MAX_AUTHORITY_PAGE_SIZE,
                actual: self.limit,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct AuthorityReceiptSummaryV1 {
    pub reference: AuthorityReferenceViewV1,
    pub status: AuthorityStatusViewV1,
    pub label: String,
    pub digest: Option<String>,
    pub captured_at: String,
    pub related_refs: Vec<AuthorityReferenceViewV1>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct AuthorityReceiptPageV1 {
    pub project_id: ProjectId,
    pub items: Vec<AuthorityReceiptSummaryV1>,
    #[specta(type = crate::UiIpcNumber)]
    pub next_cursor: u64,
    pub has_more: bool,
}

pub(crate) fn validate_authority_id(value: &str) -> Result<(), ContractError> {
    validate_opaque_text(value, "authority_reference.authority_id")?;
    if value.len() > 256 {
        return Err(ContractError::LimitExceeded {
            path: "authority_reference.authority_id".to_string(),
            limit: 256,
            actual: value.len(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_reads_are_bounded() {
        assert!(
            AuthorityReceiptListRequestV1 {
                kind: AuthorityKindViewV1::Run,
                cursor: None,
                limit: MAX_AUTHORITY_PAGE_SIZE + 1,
            }
            .validate()
            .is_err()
        );
        assert!(
            AuthorityResolveRequestV1 {
                references: vec![AuthorityReferenceViewV1 {
                    kind: AuthorityKindViewV1::Run,
                    authority_id: "r".repeat(257),
                }],
            }
            .validate()
            .is_err()
        );
    }
}
