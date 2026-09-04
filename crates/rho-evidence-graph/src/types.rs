use rho_protocol::{AuthorityRefV1, DataClass, ProjectId, ProvenanceRefV1};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const EVIDENCE_GRAPH_SCHEMA_VERSION: i64 = 1;
pub const MAX_NODE_LABEL_BYTES: usize = 1_024;
pub const MAX_NODE_PAYLOAD_BYTES: usize = 64 * 1_024;
pub const MAX_GRAPH_EVENT_BYTES: usize = 128 * 1_024;
pub const MAX_GAP_BASIS_BYTES: usize = 64 * 1_024;
pub const MAX_GRAPH_PAGE_SIZE: usize = 200;
pub const MAX_GRAPH_TRAVERSAL_NODES: usize = 500;
pub const MAX_GRAPH_TRAVERSAL_EDGES: usize = 2_000;
pub const MAX_GRAPH_TRAVERSAL_DEPTH: u8 = 8;
pub const MAX_AUTHORITY_RECONCILIATION_ITEMS: usize = 500;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Claim,
    SourceRange,
    Run,
    Artifact,
    EnvironmentSnapshot,
    CheckFinding,
    ExternalCitation,
    AgentTurn,
}

impl NodeKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claim => "claim",
            Self::SourceRange => "source_range",
            Self::Run => "run",
            Self::Artifact => "artifact",
            Self::EnvironmentSnapshot => "environment_snapshot",
            Self::CheckFinding => "check_finding",
            Self::ExternalCitation => "external_citation",
            Self::AgentTurn => "agent_turn",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EdgePredicate {
    Supports,
    Contradicts,
    DerivedFrom,
    GeneratedBy,
    ObservedIn,
    UsesEnvironment,
    Cites,
    StaleAfter,
    RequiresRecheck,
}

impl EdgePredicate {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Supports => "supports",
            Self::Contradicts => "contradicts",
            Self::DerivedFrom => "derived_from",
            Self::GeneratedBy => "generated_by",
            Self::ObservedIn => "observed_in",
            Self::UsesEnvironment => "uses_environment",
            Self::Cites => "cites",
            Self::StaleAfter => "stale_after",
            Self::RequiresRecheck => "requires_recheck",
        }
    }

    pub fn polarity(self) -> EdgePolarity {
        match self {
            Self::Supports | Self::Cites => EdgePolarity::Support,
            Self::Contradicts => EdgePolarity::Conflict,
            _ => EdgePolarity::Neutral,
        }
    }

    pub fn is_system_derived(self) -> bool {
        matches!(self, Self::StaleAfter | Self::RequiresRecheck)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EdgePolarity {
    Support,
    Conflict,
    Neutral,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RecordStatus {
    Active,
    Stale,
    Disputed,
    Retired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PromotionState {
    Draft,
    Promoted,
    Managed,
    Retired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum GraphActorKind {
    User,
    Agent,
    System,
    TrustedPolicy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum GraphRecordKind {
    Node,
    Edge,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum GapStatus {
    Open,
    Acknowledged,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphNode {
    pub node_id: String,
    pub project_id: ProjectId,
    pub kind: NodeKind,
    pub stable_key: String,
    pub label: String,
    pub payload: Value,
    pub data_class: DataClass,
    pub promotion_state: PromotionState,
    pub status: RecordStatus,
    pub authority_ref: Option<AuthorityRefV1>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphEdge {
    pub edge_id: String,
    pub project_id: ProjectId,
    pub from_node: String,
    pub to_node: String,
    pub predicate: EdgePredicate,
    pub polarity: EdgePolarity,
    pub status: RecordStatus,
    pub promotion_state: PromotionState,
    pub provenance_ref_id: Option<String>,
    pub confidence: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphProvenanceRef {
    pub ref_id: String,
    pub project_id: ProjectId,
    pub value: ProvenanceRefV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphGap {
    pub gap_id: String,
    pub project_id: ProjectId,
    pub subject_node: Option<String>,
    pub rule_id: String,
    pub status: GapStatus,
    pub basis: Value,
    pub detected_revision: u64,
    pub resolved_revision: Option<u64>,
    pub detected_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphEvent {
    pub event_id: String,
    pub project_id: ProjectId,
    pub graph_revision: u64,
    pub event_type: String,
    pub actor_kind: GraphActorKind,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphSnapshot {
    pub snapshot_id: String,
    pub project_id: ProjectId,
    pub schema_version: i64,
    pub event_start: u64,
    pub event_end: u64,
    pub graph_digest: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphHealth {
    pub project_id: ProjectId,
    pub available: bool,
    pub schema_version: i64,
    pub graph_revision: u64,
    pub authority_cursor: u64,
    pub last_ingest_success_at: Option<String>,
    pub last_ingest_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GapRebuildOutcome {
    pub graph_revision: u64,
    pub changed_gaps: usize,
    pub open_gaps: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphPage<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimTrace {
    pub claim: GraphNode,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub gaps: Vec<GraphGap>,
    pub authority_refs: Vec<AuthorityRefV1>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvidenceSubgraph {
    pub root_node: GraphNode,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}
