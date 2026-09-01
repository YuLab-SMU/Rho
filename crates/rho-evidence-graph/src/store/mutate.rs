use lbug::{Connection, Value};
use rho_protocol::{AuthorityObservationV1, AuthorityStatusV1, ProjectId, ProvenanceRefV1};
use serde_json::json;

use crate::{
    ClaimDraft, ClaimRevision, EdgePolarity, GraphActorKind, GraphError, GraphMutationResult,
    GraphRecordKind, LinkDraft, MAX_AUTHORITY_RECONCILIATION_ITEMS, MAX_NODE_PAYLOAD_BYTES,
    NodeKind, PromotionRequest, PromotionState, RecordStatus, RetirementRequest,
};

use super::{
    EvidenceGraph, append_event, ensure_json_bound, ensure_project_text,
    ensure_storable_data_class, enum_text, execute, expect_i64, expect_optional_string,
    expect_string, new_id, now, optional_f64_value, optional_i64_value, optional_string_value,
    parse_enum, require_revision, sha256_prefixed, transaction,
};

impl EvidenceGraph {
    pub fn create_draft_claim(
        &mut self,
        draft: ClaimDraft,
    ) -> Result<GraphMutationResult, GraphError> {
        draft.validate()?;
        require_draft_actor(draft.actor)?;
        ensure_storable_data_class(draft.data_class)?;
        let payload_json =
            ensure_json_bound(&draft.payload(), "claim.payload", MAX_NODE_PAYLOAD_BYTES)?;
        let project_id = self.project_id.clone();
        let node_id = new_id("claim");
        let timestamp = now();
        let connection = self.connection()?;
        transaction(&connection, |connection| {
            execute(
                connection,
                "CREATE (:GraphNode {
                    node_id: $node_id,
                    project_id: $project_id,
                    kind: 'claim',
                    stable_key: $stable_key,
                    label: $label,
                    payload_json: $payload_json,
                    data_class: $data_class,
                    promotion_state: 'draft',
                    status: 'active',
                    created_at: $created_at,
                    updated_at: $updated_at
                })",
                vec![
                    ("node_id", Value::String(node_id.clone())),
                    ("project_id", Value::String(project_id.as_str().to_string())),
                    ("stable_key", Value::String(node_id.clone())),
                    ("label", Value::String(draft.label.clone())),
                    ("payload_json", Value::String(payload_json.clone())),
                    ("data_class", Value::String(enum_text(draft.data_class)?)),
                    ("created_at", Value::String(timestamp.clone())),
                    ("updated_at", Value::String(timestamp.clone())),
                ],
            )?;
            let revision = append_event(
                connection,
                &project_id,
                "draft_claim_created",
                draft.actor,
                &json!({ "node_id": node_id }),
            )?;
            Ok(GraphMutationResult {
                record_id: node_id.clone(),
                graph_revision: revision,
            })
        })
    }

    pub fn revise_draft_claim(
        &mut self,
        request: ClaimRevision,
    ) -> Result<GraphMutationResult, GraphError> {
        request.validate()?;
        require_draft_actor(request.actor)?;
        let payload_json = ensure_json_bound(
            &json!({
                "summary": request.summary,
                "claim_kind": request.claim_kind,
            }),
            "claim.payload",
            MAX_NODE_PAYLOAD_BYTES,
        )?;
        let project_id = self.project_id.clone();
        let timestamp = now();
        let connection = self.connection()?;
        transaction(&connection, |connection| {
            require_revision(connection, request.expected_graph_revision)?;
            require_node_state(
                connection,
                &project_id,
                &request.claim_id,
                Some(NodeKind::Claim),
                PromotionState::Draft,
            )?;
            execute(
                connection,
                "MATCH (node:GraphNode)
                 WHERE node.node_id = $node_id AND node.project_id = $project_id
                 SET node.label = $label,
                     node.payload_json = $payload_json,
                     node.updated_at = $updated_at",
                vec![
                    ("node_id", Value::String(request.claim_id.clone())),
                    ("project_id", Value::String(project_id.as_str().to_string())),
                    ("label", Value::String(request.label.clone())),
                    ("payload_json", Value::String(payload_json.clone())),
                    ("updated_at", Value::String(timestamp.clone())),
                ],
            )?;
            let revision = append_event(
                connection,
                &project_id,
                "draft_claim_revised",
                request.actor,
                &json!({ "node_id": request.claim_id }),
            )?;
            Ok(GraphMutationResult {
                record_id: request.claim_id.clone(),
                graph_revision: revision,
            })
        })
    }

    pub fn create_draft_link(
        &mut self,
        draft: LinkDraft,
    ) -> Result<GraphMutationResult, GraphError> {
        draft.validate(&self.project_id)?;
        require_draft_actor(draft.actor)?;
        if let Some(provenance) = &draft.provenance {
            ensure_storable_data_class(provenance.data_class)?;
        }
        let project_id = self.project_id.clone();
        let edge_id = new_id("edge");
        let timestamp = now();
        let connection = self.connection()?;
        transaction(&connection, |connection| {
            require_active_endpoint(connection, &project_id, &draft.from_node)?;
            require_active_endpoint(connection, &project_id, &draft.to_node)?;
            let duplicate = execute(
                connection,
                "MATCH (source:GraphNode)-[edge:GraphLink]->(target:GraphNode)
                 WHERE source.node_id = $from_node
                   AND target.node_id = $to_node
                   AND edge.project_id = $project_id
                   AND edge.predicate = $predicate
                   AND edge.promotion_state = 'draft'
                 RETURN count(edge)",
                vec![
                    ("from_node", Value::String(draft.from_node.clone())),
                    ("to_node", Value::String(draft.to_node.clone())),
                    ("project_id", Value::String(project_id.as_str().to_string())),
                    (
                        "predicate",
                        Value::String(draft.predicate.as_str().to_string()),
                    ),
                ],
            )?;
            if count_first(&duplicate, "draft_link.duplicate_count")? != 0 {
                return Err(GraphError::InvalidState(
                    "an equivalent draft link already exists".to_string(),
                ));
            }
            let provenance_ref_id = draft
                .provenance
                .as_ref()
                .map(|value| upsert_provenance(connection, &project_id, value))
                .transpose()?;
            execute(
                connection,
                "MATCH (source:GraphNode), (target:GraphNode)
                 WHERE source.node_id = $from_node AND target.node_id = $to_node
                 CREATE (source)-[:GraphLink {
                    edge_id: $edge_id,
                    project_id: $project_id,
                    predicate: $predicate,
                    polarity: $polarity,
                    status: 'active',
                    promotion_state: 'draft',
                    provenance_ref_id: $provenance_ref_id,
                    confidence: $confidence,
                    created_at: $created_at,
                    updated_at: $updated_at
                 }]->(target)",
                vec![
                    ("from_node", Value::String(draft.from_node.clone())),
                    ("to_node", Value::String(draft.to_node.clone())),
                    ("edge_id", Value::String(edge_id.clone())),
                    ("project_id", Value::String(project_id.as_str().to_string())),
                    (
                        "predicate",
                        Value::String(draft.predicate.as_str().to_string()),
                    ),
                    (
                        "polarity",
                        Value::String(enum_text(draft.predicate.polarity())?),
                    ),
                    (
                        "provenance_ref_id",
                        optional_string_value(provenance_ref_id.as_deref()),
                    ),
                    ("confidence", optional_f64_value(draft.confidence)),
                    ("created_at", Value::String(timestamp.clone())),
                    ("updated_at", Value::String(timestamp.clone())),
                ],
            )?;
            let revision = append_event(
                connection,
                &project_id,
                "draft_link_created",
                draft.actor,
                &json!({ "edge_id": edge_id }),
            )?;
            Ok(GraphMutationResult {
                record_id: edge_id.clone(),
                graph_revision: revision,
            })
        })
    }

    pub fn promote_draft(
        &mut self,
        request: PromotionRequest,
        authority_observations: &[AuthorityObservationV1],
    ) -> Result<GraphMutationResult, GraphError> {
        request.validate()?;
        validate_observations(
            &self.project_id,
            authority_observations,
            "promotion.authority_observations",
        )?;
        let project_id = self.project_id.clone();
        let timestamp = now();
        let connection = self.connection()?;
        transaction(&connection, |connection| {
            require_revision(connection, request.expected_graph_revision)?;
            match request.record_kind {
                GraphRecordKind::Node => {
                    require_node_state(
                        connection,
                        &project_id,
                        &request.record_id,
                        Some(NodeKind::Claim),
                        PromotionState::Draft,
                    )?;
                    execute(
                        connection,
                        "MATCH (node:GraphNode)
                         WHERE node.node_id = $record_id AND node.project_id = $project_id
                         SET node.promotion_state = 'promoted', node.updated_at = $updated_at",
                        vec![
                            ("record_id", Value::String(request.record_id.clone())),
                            ("project_id", Value::String(project_id.as_str().to_string())),
                            ("updated_at", Value::String(timestamp.clone())),
                        ],
                    )?;
                }
                GraphRecordKind::Edge => {
                    let edge = load_edge_admission(connection, &project_id, &request.record_id)?;
                    if edge.promotion_state != PromotionState::Draft {
                        return Err(GraphError::InvalidState(
                            "only a draft edge can be promoted".to_string(),
                        ));
                    }
                    if !matches!(
                        edge.source_state,
                        PromotionState::Promoted | PromotionState::Managed
                    ) || !matches!(
                        edge.target_state,
                        PromotionState::Promoted | PromotionState::Managed
                    ) {
                        return Err(GraphError::Admission(
                            "a promoted edge requires promoted or managed endpoints".to_string(),
                        ));
                    }
                    if edge.polarity != EdgePolarity::Neutral {
                        let provenance_ref_id = edge.provenance_ref_id.ok_or_else(|| {
                            GraphError::Admission(
                                "formal support and conflict links require provenance".to_string(),
                            )
                        })?;
                        require_current_provenance(
                            connection,
                            &project_id,
                            &provenance_ref_id,
                            authority_observations,
                        )?;
                    }
                    execute(
                        connection,
                        "MATCH ()-[edge:GraphLink]->()
                         WHERE edge.edge_id = $record_id AND edge.project_id = $project_id
                         SET edge.promotion_state = 'promoted', edge.updated_at = $updated_at",
                        vec![
                            ("record_id", Value::String(request.record_id.clone())),
                            ("project_id", Value::String(project_id.as_str().to_string())),
                            ("updated_at", Value::String(timestamp.clone())),
                        ],
                    )?;
                }
            }
            let revision = append_event(
                connection,
                &project_id,
                "draft_promoted",
                request.actor,
                &json!({
                    "record_kind": enum_text(request.record_kind)?,
                    "record_id": request.record_id,
                    "policy_id": request.policy_id,
                }),
            )?;
            Ok(GraphMutationResult {
                record_id: request.record_id.clone(),
                graph_revision: revision,
            })
        })
    }

    pub fn retire_draft(
        &mut self,
        request: RetirementRequest,
    ) -> Result<GraphMutationResult, GraphError> {
        request.validate()?;
        require_draft_actor(request.actor)?;
        self.retire_record(request, PromotionState::Draft, "draft_retired")
    }

    pub fn retire_promoted_record(
        &mut self,
        request: RetirementRequest,
    ) -> Result<GraphMutationResult, GraphError> {
        request.validate()?;
        if !matches!(
            request.actor,
            GraphActorKind::User | GraphActorKind::TrustedPolicy
        ) {
            return Err(GraphError::Admission(
                "only a user or trusted policy can retire promoted records".to_string(),
            ));
        }
        self.retire_record(request, PromotionState::Promoted, "promoted_record_retired")
    }

    fn retire_record(
        &mut self,
        request: RetirementRequest,
        expected_state: PromotionState,
        event_type: &str,
    ) -> Result<GraphMutationResult, GraphError> {
        let project_id = self.project_id.clone();
        let timestamp = now();
        let connection = self.connection()?;
        transaction(&connection, |connection| {
            require_revision(connection, request.expected_graph_revision)?;
            match request.record_kind {
                GraphRecordKind::Node => {
                    require_node_state(
                        connection,
                        &project_id,
                        &request.record_id,
                        None,
                        expected_state,
                    )?;
                    execute(
                        connection,
                        "MATCH (source:GraphNode)-[edge:GraphLink]->(target:GraphNode)
                         WHERE edge.project_id = $project_id
                           AND (source.node_id = $record_id OR target.node_id = $record_id)
                           AND edge.promotion_state <> 'managed'
                           AND edge.promotion_state <> 'retired'
                         SET edge.promotion_state = 'retired',
                             edge.status = 'retired',
                             edge.updated_at = $updated_at",
                        vec![
                            ("project_id", Value::String(project_id.as_str().to_string())),
                            ("record_id", Value::String(request.record_id.clone())),
                            ("updated_at", Value::String(timestamp.clone())),
                        ],
                    )?;
                    execute(
                        connection,
                        "MATCH (node:GraphNode)
                         WHERE node.node_id = $record_id AND node.project_id = $project_id
                         SET node.promotion_state = 'retired',
                             node.status = 'retired',
                             node.updated_at = $updated_at",
                        vec![
                            ("record_id", Value::String(request.record_id.clone())),
                            ("project_id", Value::String(project_id.as_str().to_string())),
                            ("updated_at", Value::String(timestamp.clone())),
                        ],
                    )?;
                }
                GraphRecordKind::Edge => {
                    let edge = load_edge_admission(connection, &project_id, &request.record_id)?;
                    if edge.promotion_state != expected_state {
                        return Err(GraphError::InvalidState(format!(
                            "record must be {} before retirement",
                            enum_text(expected_state)?
                        )));
                    }
                    execute(
                        connection,
                        "MATCH ()-[edge:GraphLink]->()
                         WHERE edge.edge_id = $record_id AND edge.project_id = $project_id
                         SET edge.promotion_state = 'retired',
                             edge.status = 'retired',
                             edge.updated_at = $updated_at",
                        vec![
                            ("record_id", Value::String(request.record_id.clone())),
                            ("project_id", Value::String(project_id.as_str().to_string())),
                            ("updated_at", Value::String(timestamp.clone())),
                        ],
                    )?;
                }
            }
            let revision = append_event(
                connection,
                &project_id,
                event_type,
                request.actor,
                &json!({
                    "record_kind": enum_text(request.record_kind)?,
                    "record_id": request.record_id,
                }),
            )?;
            Ok(GraphMutationResult {
                record_id: request.record_id.clone(),
                graph_revision: revision,
            })
        })
    }
}

pub(crate) fn upsert_provenance(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    provenance: &ProvenanceRefV1,
) -> Result<String, GraphError> {
    provenance.validate()?;
    if &provenance.reference.project_id != project_id {
        return Err(GraphError::ProjectMismatch);
    }
    ensure_storable_data_class(provenance.data_class)?;
    let value_json = ensure_json_bound(
        &serde_json::to_value(provenance)?,
        "provenance.value",
        MAX_NODE_PAYLOAD_BYTES,
    )?;
    let digest = sha256_prefixed(value_json.as_bytes());
    let ref_id = format!("provenance_{}", digest.trim_start_matches("sha256:"));
    let existing = execute(
        connection,
        "MATCH (provenance:GraphProvenance)
         WHERE provenance.ref_id = $ref_id
         RETURN provenance.project_id, provenance.value_json",
        vec![("ref_id", Value::String(ref_id.clone()))],
    )?;
    if let Some(row) = existing.first() {
        ensure_project_text(
            project_id,
            &expect_string(row.first(), "provenance.project_id")?,
        )?;
        if expect_string(row.get(1), "provenance.value_json")? != value_json {
            return Err(GraphError::Invariant(
                "provenance digest collision".to_string(),
            ));
        }
        return Ok(ref_id);
    }
    execute(
        connection,
        "CREATE (:GraphProvenance {
            ref_id: $ref_id,
            project_id: $project_id,
            authority_kind: $authority_kind,
            authority_id: $authority_id,
            digest: $digest,
            project_revision: $project_revision,
            state_revision: $state_revision,
            captured_at: $captured_at,
            bounded_excerpt: $bounded_excerpt,
            data_class: $data_class,
            value_json: $value_json
        })",
        vec![
            ("ref_id", Value::String(ref_id.clone())),
            ("project_id", Value::String(project_id.as_str().to_string())),
            (
                "authority_kind",
                Value::String(enum_text(provenance.reference.kind)?),
            ),
            (
                "authority_id",
                Value::String(provenance.reference.authority_id.clone()),
            ),
            (
                "digest",
                optional_string_value(provenance.digest.as_ref().map(|value| value.as_str())),
            ),
            (
                "project_revision",
                optional_i64_value(
                    provenance
                        .project_revision
                        .map(|value| i64::try_from(value.0))
                        .transpose()
                        .map_err(|_| {
                            GraphError::Invariant("project revision exceeds INT64".to_string())
                        })?,
                ),
            ),
            (
                "state_revision",
                optional_i64_value(
                    provenance
                        .state_revision
                        .map(|value| i64::try_from(value.0))
                        .transpose()
                        .map_err(|_| {
                            GraphError::Invariant("state revision exceeds INT64".to_string())
                        })?,
                ),
            ),
            ("captured_at", Value::String(provenance.captured_at.clone())),
            (
                "bounded_excerpt",
                optional_string_value(provenance.bounded_excerpt.as_deref()),
            ),
            (
                "data_class",
                Value::String(enum_text(provenance.data_class)?),
            ),
            ("value_json", Value::String(value_json)),
        ],
    )?;
    Ok(ref_id)
}

fn require_draft_actor(actor: GraphActorKind) -> Result<(), GraphError> {
    if !matches!(actor, GraphActorKind::User | GraphActorKind::Agent) {
        return Err(GraphError::Admission(
            "drafts can only be authored by a user or Agent".to_string(),
        ));
    }
    Ok(())
}

fn require_node_state(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    node_id: &str,
    expected_kind: Option<NodeKind>,
    expected_state: PromotionState,
) -> Result<(), GraphError> {
    let rows = execute(
        connection,
        "MATCH (node:GraphNode)
         WHERE node.node_id = $node_id
         RETURN node.project_id, node.kind, node.promotion_state, node.status",
        vec![("node_id", Value::String(node_id.to_string()))],
    )?;
    let row = only_row(rows, node_id)?;
    ensure_project_text(project_id, &expect_string(row.first(), "node.project_id")?)?;
    let kind: NodeKind = parse_enum(&expect_string(row.get(1), "node.kind")?)?;
    let state: PromotionState = parse_enum(&expect_string(row.get(2), "node.promotion_state")?)?;
    let status: RecordStatus = parse_enum(&expect_string(row.get(3), "node.status")?)?;
    if expected_kind.is_some_and(|expected| expected != kind)
        || state != expected_state
        || status == RecordStatus::Retired
    {
        return Err(GraphError::InvalidState(format!(
            "node must be an active {} record",
            enum_text(expected_state)?
        )));
    }
    Ok(())
}

fn require_active_endpoint(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    node_id: &str,
) -> Result<(), GraphError> {
    let rows = execute(
        connection,
        "MATCH (node:GraphNode)
         WHERE node.node_id = $node_id
         RETURN node.project_id, node.status",
        vec![("node_id", Value::String(node_id.to_string()))],
    )?;
    let row = only_row(rows, node_id)?;
    ensure_project_text(project_id, &expect_string(row.first(), "node.project_id")?)?;
    let status: RecordStatus = parse_enum(&expect_string(row.get(1), "node.status")?)?;
    if status == RecordStatus::Retired {
        return Err(GraphError::InvalidState(
            "retired nodes cannot be linked".to_string(),
        ));
    }
    Ok(())
}

struct EdgeAdmission {
    promotion_state: PromotionState,
    polarity: EdgePolarity,
    provenance_ref_id: Option<String>,
    source_state: PromotionState,
    target_state: PromotionState,
}

fn load_edge_admission(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    edge_id: &str,
) -> Result<EdgeAdmission, GraphError> {
    let rows = execute(
        connection,
        "MATCH (source:GraphNode)-[edge:GraphLink]->(target:GraphNode)
         WHERE edge.edge_id = $edge_id
         RETURN edge.project_id,
                edge.promotion_state,
                edge.polarity,
                edge.provenance_ref_id,
                source.promotion_state,
                target.promotion_state,
                source.status,
                target.status",
        vec![("edge_id", Value::String(edge_id.to_string()))],
    )?;
    let row = only_row(rows, edge_id)?;
    ensure_project_text(project_id, &expect_string(row.first(), "edge.project_id")?)?;
    let source_status: RecordStatus = parse_enum(&expect_string(row.get(6), "source.status")?)?;
    let target_status: RecordStatus = parse_enum(&expect_string(row.get(7), "target.status")?)?;
    if source_status == RecordStatus::Retired || target_status == RecordStatus::Retired {
        return Err(GraphError::Admission(
            "formal links cannot use retired endpoints".to_string(),
        ));
    }
    Ok(EdgeAdmission {
        promotion_state: parse_enum(&expect_string(row.get(1), "edge.promotion_state")?)?,
        polarity: parse_enum(&expect_string(row.get(2), "edge.polarity")?)?,
        provenance_ref_id: expect_optional_string(row.get(3), "edge.provenance_ref_id")?,
        source_state: parse_enum(&expect_string(row.get(4), "source.promotion_state")?)?,
        target_state: parse_enum(&expect_string(row.get(5), "target.promotion_state")?)?,
    })
}

fn require_current_provenance(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    provenance_ref_id: &str,
    observations: &[AuthorityObservationV1],
) -> Result<(), GraphError> {
    let rows = execute(
        connection,
        "MATCH (provenance:GraphProvenance)
         WHERE provenance.ref_id = $ref_id
         RETURN provenance.project_id, provenance.value_json",
        vec![("ref_id", Value::String(provenance_ref_id.to_string()))],
    )?;
    let row = only_row(rows, provenance_ref_id)?;
    ensure_project_text(
        project_id,
        &expect_string(row.first(), "provenance.project_id")?,
    )?;
    let provenance: ProvenanceRefV1 =
        serde_json::from_str(&expect_string(row.get(1), "provenance.value_json")?)?;
    let observation = observations
        .iter()
        .find(|value| value.reference == provenance.reference)
        .ok_or_else(|| {
            GraphError::UnresolvedAuthorityRef(provenance.reference.authority_id.clone())
        })?;
    if matches!(
        observation.status,
        AuthorityStatusV1::Missing | AuthorityStatusV1::Stale
    ) {
        return Err(GraphError::UnresolvedAuthorityRef(
            provenance.reference.authority_id,
        ));
    }
    Ok(())
}

pub(crate) fn validate_observations(
    project_id: &ProjectId,
    observations: &[AuthorityObservationV1],
    field: &'static str,
) -> Result<(), GraphError> {
    if observations.len() > MAX_AUTHORITY_RECONCILIATION_ITEMS {
        return Err(GraphError::LimitExceeded {
            field,
            limit: MAX_AUTHORITY_RECONCILIATION_ITEMS,
        });
    }
    for observation in observations {
        observation.validate()?;
        if &observation.reference.project_id != project_id {
            return Err(GraphError::ProjectMismatch);
        }
    }
    Ok(())
}

fn only_row(rows: Vec<Vec<Value>>, id: &str) -> Result<Vec<Value>, GraphError> {
    match rows.len() {
        0 => Err(GraphError::NotFound(id.to_string())),
        1 => Ok(rows.into_iter().next().unwrap()),
        _ => Err(GraphError::Invariant(format!(
            "record identifier is duplicated: {id}"
        ))),
    }
}

fn count_first(rows: &[Vec<Value>], field: &'static str) -> Result<i64, GraphError> {
    if rows.len() != 1 {
        return Err(GraphError::Invariant(format!(
            "count query returned {} rows for {field}",
            rows.len()
        )));
    }
    expect_i64(rows[0].first(), field)
}
