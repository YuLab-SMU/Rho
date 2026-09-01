use rho_protocol::{AuthorityObservationV1, DataClass, ProjectId, ProvenanceRefV1};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::GraphError;
use crate::{
    EdgePredicate, GraphActorKind, GraphRecordKind, MAX_GRAPH_PAGE_SIZE, MAX_GRAPH_TRAVERSAL_DEPTH,
    MAX_GRAPH_TRAVERSAL_NODES, MAX_NODE_LABEL_BYTES, MAX_NODE_PAYLOAD_BYTES,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimDraft {
    pub label: String,
    pub summary: String,
    pub claim_kind: String,
    pub data_class: DataClass,
    pub actor: GraphActorKind,
}

impl ClaimDraft {
    pub(crate) fn payload(&self) -> Value {
        serde_json::json!({
            "summary": self.summary,
            "claim_kind": self.claim_kind,
        })
    }

    pub(crate) fn validate(&self) -> Result<(), GraphError> {
        validate_text(&self.label, "claim.label", MAX_NODE_LABEL_BYTES)?;
        validate_text(&self.summary, "claim.summary", MAX_NODE_PAYLOAD_BYTES)?;
        validate_text(&self.claim_kind, "claim.kind", 128)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimRevision {
    pub claim_id: String,
    pub expected_graph_revision: u64,
    pub label: String,
    pub summary: String,
    pub claim_kind: String,
    pub actor: GraphActorKind,
}

impl ClaimRevision {
    pub(crate) fn validate(&self) -> Result<(), GraphError> {
        validate_id(&self.claim_id, "claim_id")?;
        validate_text(&self.label, "claim.label", MAX_NODE_LABEL_BYTES)?;
        validate_text(&self.summary, "claim.summary", MAX_NODE_PAYLOAD_BYTES)?;
        validate_text(&self.claim_kind, "claim.kind", 128)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinkDraft {
    pub from_node: String,
    pub to_node: String,
    pub predicate: EdgePredicate,
    pub provenance: Option<ProvenanceRefV1>,
    pub confidence: Option<f64>,
    pub actor: GraphActorKind,
}

impl LinkDraft {
    pub(crate) fn validate(&self, project_id: &ProjectId) -> Result<(), GraphError> {
        validate_id(&self.from_node, "from_node")?;
        validate_id(&self.to_node, "to_node")?;
        if self.from_node == self.to_node {
            return Err(GraphError::Validation(
                "self links are not allowed".to_string(),
            ));
        }
        if self.predicate.is_system_derived() && self.actor != GraphActorKind::System {
            return Err(GraphError::Admission(
                "system-derived predicates cannot be authored as drafts".to_string(),
            ));
        }
        if self
            .confidence
            .is_some_and(|value| !(0.0..=1.0).contains(&value))
        {
            return Err(GraphError::Validation(
                "confidence must be between zero and one".to_string(),
            ));
        }
        if let Some(provenance) = &self.provenance {
            provenance.validate()?;
            if &provenance.reference.project_id != project_id {
                return Err(GraphError::ProjectMismatch);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromotionRequest {
    pub record_kind: GraphRecordKind,
    pub record_id: String,
    pub expected_graph_revision: u64,
    pub actor: GraphActorKind,
    pub policy_id: Option<String>,
}

impl PromotionRequest {
    pub(crate) fn validate(&self) -> Result<(), GraphError> {
        validate_id(&self.record_id, "record_id")?;
        if !matches!(
            self.actor,
            GraphActorKind::User | GraphActorKind::TrustedPolicy
        ) {
            return Err(GraphError::Admission(
                "only a user or trusted policy can promote graph records".to_string(),
            ));
        }
        if self.actor == GraphActorKind::TrustedPolicy {
            validate_text(
                self.policy_id.as_deref().unwrap_or_default(),
                "policy_id",
                256,
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RetirementRequest {
    pub record_kind: GraphRecordKind,
    pub record_id: String,
    pub expected_graph_revision: u64,
    pub actor: GraphActorKind,
}

impl RetirementRequest {
    pub(crate) fn validate(&self) -> Result<(), GraphError> {
        validate_id(&self.record_id, "record_id")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaimListRequest {
    pub cursor: Option<String>,
    pub limit: usize,
    pub include_drafts: bool,
}

impl ClaimListRequest {
    pub(crate) fn bounded_limit(&self) -> Result<usize, GraphError> {
        if self.limit == 0 || self.limit > MAX_GRAPH_PAGE_SIZE {
            return Err(GraphError::LimitExceeded {
                field: "claim_list.limit",
                limit: MAX_GRAPH_PAGE_SIZE,
            });
        }
        Ok(self.limit)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GapListRequest {
    pub cursor: Option<String>,
    pub limit: usize,
    pub include_resolved: bool,
}

impl GapListRequest {
    pub(crate) fn bounded_limit(&self) -> Result<usize, GraphError> {
        if self.limit == 0 || self.limit > MAX_GRAPH_PAGE_SIZE {
            return Err(GraphError::LimitExceeded {
                field: "gap_list.limit",
                limit: MAX_GRAPH_PAGE_SIZE,
            });
        }
        Ok(self.limit)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubgraphRequest {
    pub root_node: String,
    pub max_depth: u8,
    pub max_nodes: usize,
}

impl SubgraphRequest {
    pub(crate) fn validate(&self) -> Result<(), GraphError> {
        validate_id(&self.root_node, "root_node")?;
        if self.max_depth == 0 || self.max_depth > MAX_GRAPH_TRAVERSAL_DEPTH {
            return Err(GraphError::LimitExceeded {
                field: "subgraph.max_depth",
                limit: MAX_GRAPH_TRAVERSAL_DEPTH as usize,
            });
        }
        if self.max_nodes == 0 || self.max_nodes > MAX_GRAPH_TRAVERSAL_NODES {
            return Err(GraphError::LimitExceeded {
                field: "subgraph.max_nodes",
                limit: MAX_GRAPH_TRAVERSAL_NODES,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphMutationResult {
    pub record_id: String,
    pub graph_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorityIngestOutcome {
    pub applied_receipts: usize,
    pub graph_revision: u64,
    pub authority_cursor: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GapRebuildRequest {
    pub authority_observations: Vec<AuthorityObservationV1>,
    pub current_project_revision: Option<u64>,
    pub current_state_revision: Option<u64>,
    pub authority_head_cursor: Option<u64>,
}

impl GapRebuildRequest {
    pub(crate) fn validate(&self, project_id: &ProjectId) -> Result<(), GraphError> {
        if self.authority_observations.len() > crate::MAX_AUTHORITY_RECONCILIATION_ITEMS {
            return Err(GraphError::LimitExceeded {
                field: "gap_rebuild.authority_observations",
                limit: crate::MAX_AUTHORITY_RECONCILIATION_ITEMS,
            });
        }
        for observation in &self.authority_observations {
            observation.validate()?;
            if &observation.reference.project_id != project_id {
                return Err(GraphError::ProjectMismatch);
            }
        }
        Ok(())
    }
}

pub(crate) fn validate_id(value: &str, field: &'static str) -> Result<(), GraphError> {
    validate_text(value, field, 256)
}

pub(crate) fn validate_text(
    value: &str,
    field: &'static str,
    max: usize,
) -> Result<(), GraphError> {
    if value.is_empty() || value.trim() != value || value.chars().any(char::is_control) {
        return Err(GraphError::Validation(format!("{field} is invalid")));
    }
    if value.len() > max {
        return Err(GraphError::LimitExceeded { field, limit: max });
    }
    Ok(())
}
