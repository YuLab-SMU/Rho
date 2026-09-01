//! Typed renderer projections for the project Evidence Graph.
//!
//! These contracts carry bounded projections and user intent only. They do not
//! expose a project root, arbitrary graph query, database handle, or promotion
//! capability to Agent-only callers.

use serde::{Deserialize, Serialize};

use crate::{
    AuthorityReferenceViewV1, ContractError, EvidenceEdgeId, EvidenceGapId, EvidenceNodeId,
    ProjectId, Validate, authority::validate_authority_id, validate_id, validate_label,
    validate_opaque_text, validate_purpose,
};

pub const EVIDENCE_GRAPH_VIEW_CONTRACT: &str = "rho.ui.evidence-graph.v1";
pub const MAX_EVIDENCE_PAGE_SIZE: usize = 200;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceNodeKindV1 {
    Claim,
    SourceRange,
    Run,
    Artifact,
    EnvironmentSnapshot,
    Approval,
    CheckFinding,
    ExternalCitation,
    AgentTurn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EvidencePredicateV1 {
    Supports,
    Contradicts,
    DerivedFrom,
    GeneratedBy,
    ObservedIn,
    ApprovedBy,
    UsesEnvironment,
    Cites,
    StaleAfter,
    RequiresRecheck,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EvidencePolarityV1 {
    Support,
    Conflict,
    Neutral,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRecordStatusV1 {
    Active,
    Stale,
    Disputed,
    Retired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EvidencePromotionStateV1 {
    Draft,
    Promoted,
    Managed,
    Retired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceGapStatusV1 {
    Open,
    Acknowledged,
    Resolved,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceDataClassV1 {
    Public,
    ProjectInternal,
    ProjectConfidential,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRecordKindV1 {
    Node,
    Edge,
}

#[derive(Debug, Clone, Serialize, PartialEq, specta::Type)]
pub struct EvidenceNodeViewV1 {
    pub node_id: EvidenceNodeId,
    pub kind: EvidenceNodeKindV1,
    pub stable_key: String,
    pub label: String,
    pub summary: Option<String>,
    pub claim_kind: Option<String>,
    pub data_class: EvidenceDataClassV1,
    pub promotion_state: EvidencePromotionStateV1,
    pub status: EvidenceRecordStatusV1,
    pub authority_ref: Option<AuthorityReferenceViewV1>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, specta::Type)]
pub struct EvidenceEdgeViewV1 {
    pub edge_id: EvidenceEdgeId,
    pub from_node: EvidenceNodeId,
    pub to_node: EvidenceNodeId,
    pub predicate: EvidencePredicateV1,
    pub polarity: EvidencePolarityV1,
    pub status: EvidenceRecordStatusV1,
    pub promotion_state: EvidencePromotionStateV1,
    pub provenance: Option<AuthorityReferenceViewV1>,
    pub confidence: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidenceGapFactV1 {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidenceGapViewV1 {
    pub gap_id: EvidenceGapId,
    pub subject_node: Option<EvidenceNodeId>,
    pub rule_id: String,
    pub status: EvidenceGapStatusV1,
    pub basis: Vec<EvidenceGapFactV1>,
    #[specta(type = crate::UiIpcNumber)]
    pub detected_revision: u64,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub resolved_revision: Option<u64>,
    pub detected_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, specta::Type)]
pub struct ClaimPageV1 {
    pub contract: String,
    pub project_id: ProjectId,
    pub items: Vec<EvidenceNodeViewV1>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidenceGapPageV1 {
    pub contract: String,
    pub project_id: ProjectId,
    pub items: Vec<EvidenceGapViewV1>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, specta::Type)]
pub struct EvidenceSubgraphViewV1 {
    pub contract: String,
    pub project_id: ProjectId,
    pub root_node: EvidenceNodeViewV1,
    pub nodes: Vec<EvidenceNodeViewV1>,
    pub edges: Vec<EvidenceEdgeViewV1>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, specta::Type)]
pub struct ClaimTraceViewV1 {
    pub contract: String,
    pub project_id: ProjectId,
    pub claim: EvidenceNodeViewV1,
    pub nodes: Vec<EvidenceNodeViewV1>,
    pub edges: Vec<EvidenceEdgeViewV1>,
    pub gaps: Vec<EvidenceGapViewV1>,
    pub authority_refs: Vec<AuthorityReferenceViewV1>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidenceGraphHealthViewV1 {
    pub contract: String,
    pub project_id: ProjectId,
    pub engine: String,
    pub available: bool,
    #[specta(type = crate::UiIpcNumber)]
    pub schema_version: i64,
    #[specta(type = crate::UiIpcNumber)]
    pub graph_revision: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub authority_cursor: u64,
    pub last_ingest_success_at: Option<String>,
    pub last_ingest_error_code: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct ClaimListRequestV1 {
    pub cursor: Option<String>,
    #[specta(type = crate::UiIpcNumber)]
    pub limit: usize,
    pub include_drafts: bool,
}

impl Validate for ClaimListRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_page(self.cursor.as_deref(), self.limit, "evidence_claim_list")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidenceGapListRequestV1 {
    pub cursor: Option<String>,
    #[specta(type = crate::UiIpcNumber)]
    pub limit: usize,
    pub include_resolved: bool,
}

impl Validate for EvidenceGapListRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_page(self.cursor.as_deref(), self.limit, "evidence_gap_list")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidenceSubgraphRequestV1 {
    pub root_node: EvidenceNodeId,
    #[specta(type = crate::UiIpcNumber)]
    pub max_depth: u8,
    #[specta(type = crate::UiIpcNumber)]
    pub max_nodes: usize,
}

impl Validate for EvidenceSubgraphRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.max_depth == 0 || self.max_depth > 8 {
            return Err(ContractError::LimitExceeded {
                path: "evidence_subgraph.max_depth".to_string(),
                limit: 8,
                actual: usize::from(self.max_depth),
            });
        }
        if self.max_nodes == 0 || self.max_nodes > 500 {
            return Err(ContractError::LimitExceeded {
                path: "evidence_subgraph.max_nodes".to_string(),
                limit: 500,
                actual: self.max_nodes,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct CreateDraftClaimRequestV1 {
    pub label: String,
    pub summary: String,
    pub claim_kind: String,
    pub data_class: EvidenceDataClassV1,
}

impl Validate for CreateDraftClaimRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "draft_claim.label")?;
        validate_purpose(&self.summary, "draft_claim.summary")?;
        validate_id(&self.claim_kind, "draft_claim.claim_kind")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct ReviseDraftClaimRequestV1 {
    pub claim_id: EvidenceNodeId,
    #[specta(type = crate::UiIpcNumber)]
    pub expected_graph_revision: u64,
    pub label: String,
    pub summary: String,
    pub claim_kind: String,
}

impl Validate for ReviseDraftClaimRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "draft_claim.label")?;
        validate_purpose(&self.summary, "draft_claim.summary")?;
        validate_id(&self.claim_kind, "draft_claim.claim_kind")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct DraftProvenanceRequestV1 {
    pub reference: AuthorityReferenceViewV1,
    pub digest: Option<String>,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub project_revision: Option<u64>,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub state_revision: Option<u64>,
    pub bounded_excerpt: Option<String>,
    pub data_class: EvidenceDataClassV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, specta::Type)]
pub struct CreateDraftLinkRequestV1 {
    pub from_node: EvidenceNodeId,
    pub to_node: EvidenceNodeId,
    pub predicate: EvidencePredicateV1,
    pub provenance: Option<DraftProvenanceRequestV1>,
    pub confidence: Option<f64>,
}

impl Validate for CreateDraftLinkRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.from_node == self.to_node {
            return Err(ContractError::InvalidValue {
                path: "draft_link.endpoints".to_string(),
                reason: "self links are not allowed".to_string(),
            });
        }
        if matches!(
            self.predicate,
            EvidencePredicateV1::StaleAfter | EvidencePredicateV1::RequiresRecheck
        ) {
            return Err(ContractError::InvalidValue {
                path: "draft_link.predicate".to_string(),
                reason: "system-derived predicates cannot be authored".to_string(),
            });
        }
        if self
            .confidence
            .is_some_and(|value| !(0.0..=1.0).contains(&value))
        {
            return Err(ContractError::InvalidValue {
                path: "draft_link.confidence".to_string(),
                reason: "confidence must be between zero and one".to_string(),
            });
        }
        if let Some(provenance) = &self.provenance {
            validate_authority_id(&provenance.reference.authority_id)?;
            if let Some(digest) = &provenance.digest {
                validate_digest(digest)?;
            }
            if let Some(excerpt) = &provenance.bounded_excerpt {
                validate_opaque_text(excerpt, "draft_link.provenance.bounded_excerpt")?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidencePromotionRequestV1 {
    pub record_kind: EvidenceRecordKindV1,
    pub record_id: String,
    #[specta(type = crate::UiIpcNumber)]
    pub expected_graph_revision: u64,
}

impl Validate for EvidencePromotionRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_id(&self.record_id, "evidence_promotion.record_id")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidenceRetirementRequestV1 {
    pub record_kind: EvidenceRecordKindV1,
    pub record_id: String,
    #[specta(type = crate::UiIpcNumber)]
    pub expected_graph_revision: u64,
}

impl Validate for EvidenceRetirementRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_id(&self.record_id, "evidence_retirement.record_id")
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, specta::Type)]
pub struct EvidenceMutationViewV1 {
    pub record_id: String,
    #[specta(type = crate::UiIpcNumber)]
    pub graph_revision: u64,
}

fn validate_page(cursor: Option<&str>, limit: usize, path: &str) -> Result<(), ContractError> {
    if limit == 0 || limit > MAX_EVIDENCE_PAGE_SIZE {
        return Err(ContractError::LimitExceeded {
            path: format!("{path}.limit"),
            limit: MAX_EVIDENCE_PAGE_SIZE,
            actual: limit,
        });
    }
    if let Some(cursor) = cursor {
        validate_id(cursor, &format!("{path}.cursor"))?;
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), ContractError> {
    let valid = value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if valid {
        Ok(())
    } else {
        Err(ContractError::InvalidValue {
            path: "draft_link.provenance.digest".to_string(),
            reason: "digest must use sha256:<64 hex chars>".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_and_query_requests_are_bounded() {
        assert!(
            ClaimListRequestV1 {
                cursor: None,
                limit: 201,
                include_drafts: false,
            }
            .validate()
            .is_err()
        );
        assert!(
            CreateDraftLinkRequestV1 {
                from_node: EvidenceNodeId::new("node:a").unwrap(),
                to_node: EvidenceNodeId::new("node:b").unwrap(),
                predicate: EvidencePredicateV1::StaleAfter,
                provenance: None,
                confidence: None,
            }
            .validate()
            .is_err()
        );
    }
}
