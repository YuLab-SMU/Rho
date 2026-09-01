use std::collections::BTreeMap;

use lbug::{Connection, Value};
use rho_protocol::{
    AuthorityKindV1, AuthorityObservationV1, AuthorityReceiptV1, AuthorityStatusV1, ProjectId,
    ProvenanceRefV1,
};
use serde_json::{Value as JsonValue, json};

use crate::{
    EdgePredicate, GapRebuildOutcome, GapRebuildRequest, GapStatus, GraphActorKind, GraphEdge,
    GraphError, GraphNode, MAX_GAP_BASIS_BYTES, NodeKind, PromotionState,
};

use super::query::{EDGE_PROJECTION, NODE_PROJECTION, edge_from_row, node_from_row};
use super::{
    EvidenceGraph, append_event, current_revision_on, ensure_json_bound, execute, expect_i64,
    expect_string, now, optional_i64_value, optional_string_value, sha256_prefixed, transaction,
};

#[derive(Debug, Clone)]
struct DesiredGap {
    subject_node: Option<String>,
    rule_id: &'static str,
    basis: JsonValue,
}

#[derive(Debug)]
struct ExistingGap {
    gap_id: String,
    subject_key: String,
    rule_id: String,
    status: GapStatus,
    basis_json: String,
}

impl EvidenceGraph {
    pub fn rebuild_gaps(
        &mut self,
        request: GapRebuildRequest,
    ) -> Result<GapRebuildOutcome, GraphError> {
        request.validate(&self.project_id)?;
        let project_id = self.project_id.clone();
        let connection = self.connection()?;
        transaction(&connection, |connection| {
            let nodes = load_active_nodes(connection, &project_id)?;
            let edges = load_active_edges(connection, &project_id)?;
            let provenance = load_provenance(connection, &project_id)?;
            let desired = detect_gaps(
                connection,
                &project_id,
                &nodes,
                &edges,
                &provenance,
                &request,
            )?;
            let existing = load_existing_gaps(connection, &project_id)?;
            let current_revision = current_revision_on(connection)?;
            let anticipated_revision = current_revision.checked_add(1).ok_or_else(|| {
                GraphError::Invariant("graph revision overflow during gap rebuild".to_string())
            })?;
            let changed = apply_gap_diff(
                connection,
                &project_id,
                &desired,
                &existing,
                anticipated_revision,
            )?;
            if changed == 0 {
                return Ok(GapRebuildOutcome {
                    graph_revision: current_revision,
                    changed_gaps: 0,
                    open_gaps: desired.len(),
                });
            }
            let revision = append_event(
                connection,
                &project_id,
                "evidence_gaps_rebuilt",
                GraphActorKind::System,
                &json!({
                    "changed_gaps": changed,
                    "open_gaps": desired.len(),
                    "authority_observation_count": request.authority_observations.len(),
                }),
            )?;
            if revision != anticipated_revision {
                return Err(GraphError::Invariant(
                    "gap projection revision diverged from event revision".to_string(),
                ));
            }
            Ok(GapRebuildOutcome {
                graph_revision: revision,
                changed_gaps: changed,
                open_gaps: desired.len(),
            })
        })
    }
}

fn detect_gaps(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    nodes: &[GraphNode],
    edges: &[GraphEdge],
    provenance: &BTreeMap<String, ProvenanceRefV1>,
    request: &GapRebuildRequest,
) -> Result<BTreeMap<(String, String), DesiredGap>, GraphError> {
    let node_by_id = nodes
        .iter()
        .map(|node| (node.node_id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let observations = request
        .authority_observations
        .iter()
        .map(|observation| (authority_key(&observation.reference), observation))
        .collect::<BTreeMap<_, _>>();
    let formal_edges = edges
        .iter()
        .filter(|edge| edge.promotion_state == PromotionState::Promoted)
        .collect::<Vec<_>>();
    let managed_edges = edges
        .iter()
        .filter(|edge| edge.promotion_state == PromotionState::Managed)
        .collect::<Vec<_>>();
    let mut desired = BTreeMap::new();

    for node in nodes {
        match node.kind {
            NodeKind::Claim if node.promotion_state == PromotionState::Promoted => {
                let support = formal_edges.iter().any(|edge| {
                    incident(edge, &node.node_id)
                        && matches!(
                            edge.predicate,
                            EdgePredicate::Supports | EdgePredicate::Cites
                        )
                });
                let conflict = formal_edges.iter().any(|edge| {
                    incident(edge, &node.node_id) && edge.predicate == EdgePredicate::Contradicts
                });
                if !support {
                    add_gap(
                        &mut desired,
                        Some(&node.node_id),
                        "unlinked_claim",
                        json!({ "claim_id": node.node_id }),
                    );
                }
                if support && conflict {
                    add_gap(
                        &mut desired,
                        Some(&node.node_id),
                        "conflicting_evidence",
                        json!({ "claim_id": node.node_id }),
                    );
                }
                if node.payload.get("claim_kind").and_then(JsonValue::as_str)
                    == Some("agent_conclusion")
                    && !support
                {
                    add_gap(
                        &mut desired,
                        Some(&node.node_id),
                        "unverified_agent_conclusion",
                        json!({ "claim_id": node.node_id }),
                    );
                }
                if supporting_observation_is_old(
                    &formal_edges,
                    &node.node_id,
                    provenance,
                    request.current_project_revision,
                    request.current_state_revision,
                ) {
                    add_gap(
                        &mut desired,
                        Some(&node.node_id),
                        "needs_reobserve",
                        json!({
                            "claim_id": node.node_id,
                            "current_project_revision": request.current_project_revision,
                            "current_state_revision": request.current_state_revision,
                        }),
                    );
                }
            }
            NodeKind::Artifact => {
                let producing_run = managed_edges.iter().any(|edge| {
                    edge.from_node == node.node_id
                        && edge.predicate == EdgePredicate::GeneratedBy
                        && node_by_id
                            .get(edge.to_node.as_str())
                            .is_some_and(|target| target.kind == NodeKind::Run)
                });
                if !producing_run {
                    add_gap(
                        &mut desired,
                        Some(&node.node_id),
                        "missing_run_provenance",
                        json!({ "artifact_id": node.stable_key }),
                    );
                }
            }
            NodeKind::Run => {
                let environment = managed_edges.iter().any(|edge| {
                    edge.from_node == node.node_id
                        && edge.predicate == EdgePredicate::UsesEnvironment
                        && node_by_id
                            .get(edge.to_node.as_str())
                            .is_some_and(|target| target.kind == NodeKind::EnvironmentSnapshot)
                });
                if !environment {
                    add_gap(
                        &mut desired,
                        Some(&node.node_id),
                        "missing_environment",
                        json!({ "run_id": node.stable_key }),
                    );
                }
            }
            NodeKind::SourceRange => {
                if source_is_stale(node, &observations)? {
                    add_gap(
                        &mut desired,
                        Some(&node.node_id),
                        "stale_source_anchor",
                        json!({ "source_anchor_id": node.stable_key }),
                    );
                }
            }
            _ => {}
        }

        if let Some(reference) = &node.authority_ref {
            if observations
                .get(&authority_key(reference))
                .is_some_and(|observation| observation.status == AuthorityStatusV1::Missing)
            {
                add_gap(
                    &mut desired,
                    Some(&node.node_id),
                    "unresolved_authority_ref",
                    json!({
                        "authority_kind": format!("{:?}", reference.kind),
                        "authority_id": reference.authority_id,
                    }),
                );
            }
        }
    }

    if let Some(head) = request.authority_head_cursor {
        let cursor = current_authority_cursor(connection, project_id)?;
        if cursor < head {
            add_gap(
                &mut desired,
                None,
                "sidecar_ingest_lag",
                json!({ "authority_cursor": cursor, "authority_head_cursor": head }),
            );
        }
    }
    Ok(desired)
}

fn source_is_stale(
    node: &GraphNode,
    observations: &BTreeMap<String, &AuthorityObservationV1>,
) -> Result<bool, GraphError> {
    let Some(reference) = &node.authority_ref else {
        return Ok(false);
    };
    if reference.kind != AuthorityKindV1::SourceAnchor {
        return Ok(false);
    }
    let Some(observation) = observations.get(&authority_key(reference)) else {
        return Ok(false);
    };
    if observation.status == AuthorityStatusV1::Stale {
        return Ok(true);
    }
    let Some(receipt_value) = node.payload.get("receipt") else {
        return Ok(false);
    };
    let receipt: AuthorityReceiptV1 = serde_json::from_value(receipt_value.clone())?;
    let AuthorityReceiptV1::SourceAnchor(anchor) = receipt else {
        return Ok(false);
    };
    Ok(observation
        .digest
        .as_ref()
        .is_some_and(|digest| digest != &anchor.content_digest))
}

fn supporting_observation_is_old(
    edges: &[&GraphEdge],
    claim_id: &str,
    provenance: &BTreeMap<String, ProvenanceRefV1>,
    current_project_revision: Option<u64>,
    current_state_revision: Option<u64>,
) -> bool {
    edges.iter().any(|edge| {
        if !incident(edge, claim_id)
            || !matches!(
                edge.predicate,
                EdgePredicate::Supports | EdgePredicate::Cites
            )
        {
            return false;
        }
        let Some(reference) = edge
            .provenance_ref_id
            .as_ref()
            .and_then(|id| provenance.get(id))
        else {
            return false;
        };
        current_project_revision.is_some_and(|current| {
            reference
                .project_revision
                .is_some_and(|captured| captured.0 < current)
        }) || current_state_revision.is_some_and(|current| {
            reference
                .state_revision
                .is_some_and(|captured| captured.0 < current)
        })
    })
}

fn incident(edge: &GraphEdge, node_id: &str) -> bool {
    edge.from_node == node_id || edge.to_node == node_id
}

fn add_gap(
    desired: &mut BTreeMap<(String, String), DesiredGap>,
    subject_node: Option<&str>,
    rule_id: &'static str,
    basis: JsonValue,
) {
    let subject_key = subject_node.unwrap_or("global").to_string();
    desired.insert(
        (subject_key, rule_id.to_string()),
        DesiredGap {
            subject_node: subject_node.map(str::to_string),
            rule_id,
            basis,
        },
    );
}

fn apply_gap_diff(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    desired: &BTreeMap<(String, String), DesiredGap>,
    existing: &BTreeMap<(String, String), ExistingGap>,
    revision: u64,
) -> Result<usize, GraphError> {
    let revision = i64::try_from(revision)
        .map_err(|_| GraphError::Invariant("gap revision exceeds INT64".to_string()))?;
    let timestamp = now();
    let mut changed = 0;
    for (key, gap) in desired {
        let basis_json = ensure_json_bound(&gap.basis, "gap.basis", MAX_GAP_BASIS_BYTES)?;
        match existing.get(key) {
            None => {
                let gap_id = gap_id(project_id, &key.0, gap.rule_id);
                execute(
                    connection,
                    "CREATE (:GraphGap {
                        gap_id: $gap_id,
                        project_id: $project_id,
                        subject_node: $subject_node,
                        subject_key: $subject_key,
                        rule_id: $rule_id,
                        status: 'open',
                        basis_json: $basis_json,
                        detected_revision: $detected_revision,
                        detected_at: $detected_at
                    })",
                    vec![
                        ("gap_id", Value::String(gap_id)),
                        ("project_id", Value::String(project_id.as_str().to_string())),
                        (
                            "subject_node",
                            optional_string_value(gap.subject_node.as_deref()),
                        ),
                        ("subject_key", Value::String(key.0.clone())),
                        ("rule_id", Value::String(gap.rule_id.to_string())),
                        ("basis_json", Value::String(basis_json)),
                        ("detected_revision", Value::Int64(revision)),
                        ("detected_at", Value::String(timestamp.clone())),
                    ],
                )?;
                changed += 1;
            }
            Some(current) if current.status == GapStatus::Resolved => {
                execute(
                    connection,
                    "MATCH (gap:GraphGap)
                     WHERE gap.gap_id = $gap_id AND gap.project_id = $project_id
                     SET gap.status = 'open',
                         gap.basis_json = $basis_json,
                         gap.detected_revision = $detected_revision,
                         gap.resolved_revision = $resolved_revision,
                         gap.detected_at = $detected_at,
                         gap.resolved_at = $resolved_at",
                    vec![
                        ("gap_id", Value::String(current.gap_id.clone())),
                        ("project_id", Value::String(project_id.as_str().to_string())),
                        ("basis_json", Value::String(basis_json)),
                        ("detected_revision", Value::Int64(revision)),
                        ("resolved_revision", optional_i64_value(None)),
                        ("detected_at", Value::String(timestamp.clone())),
                        ("resolved_at", optional_string_value(None)),
                    ],
                )?;
                changed += 1;
            }
            Some(current) if current.basis_json != basis_json => {
                execute(
                    connection,
                    "MATCH (gap:GraphGap)
                     WHERE gap.gap_id = $gap_id AND gap.project_id = $project_id
                     SET gap.basis_json = $basis_json",
                    vec![
                        ("gap_id", Value::String(current.gap_id.clone())),
                        ("project_id", Value::String(project_id.as_str().to_string())),
                        ("basis_json", Value::String(basis_json)),
                    ],
                )?;
                changed += 1;
            }
            Some(_) => {}
        }
    }
    for (key, current) in existing {
        if !desired.contains_key(key) && current.status != GapStatus::Resolved {
            execute(
                connection,
                "MATCH (gap:GraphGap)
                 WHERE gap.gap_id = $gap_id AND gap.project_id = $project_id
                 SET gap.status = 'resolved',
                     gap.resolved_revision = $resolved_revision,
                     gap.resolved_at = $resolved_at",
                vec![
                    ("gap_id", Value::String(current.gap_id.clone())),
                    ("project_id", Value::String(project_id.as_str().to_string())),
                    ("resolved_revision", Value::Int64(revision)),
                    ("resolved_at", Value::String(timestamp.clone())),
                ],
            )?;
            changed += 1;
        }
    }
    Ok(changed)
}

fn load_active_nodes(
    connection: &Connection<'_>,
    project_id: &ProjectId,
) -> Result<Vec<GraphNode>, GraphError> {
    let query = format!(
        "MATCH (node:GraphNode)
         WHERE node.project_id = $project_id AND node.status <> 'retired'
         RETURN {NODE_PROJECTION}
         ORDER BY node.node_id"
    );
    execute(
        connection,
        &query,
        vec![("project_id", Value::String(project_id.as_str().to_string()))],
    )?
    .into_iter()
    .map(node_from_row)
    .collect()
}

fn load_active_edges(
    connection: &Connection<'_>,
    project_id: &ProjectId,
) -> Result<Vec<GraphEdge>, GraphError> {
    let query = format!(
        "MATCH (source:GraphNode)-[edge:GraphLink]->(target:GraphNode)
         WHERE edge.project_id = $project_id AND edge.status <> 'retired'
         RETURN {EDGE_PROJECTION}
         ORDER BY edge.edge_id"
    );
    execute(
        connection,
        &query,
        vec![("project_id", Value::String(project_id.as_str().to_string()))],
    )?
    .into_iter()
    .map(edge_from_row)
    .collect()
}

fn load_provenance(
    connection: &Connection<'_>,
    project_id: &ProjectId,
) -> Result<BTreeMap<String, ProvenanceRefV1>, GraphError> {
    execute(
        connection,
        "MATCH (provenance:GraphProvenance)
         WHERE provenance.project_id = $project_id
         RETURN provenance.ref_id, provenance.value_json",
        vec![("project_id", Value::String(project_id.as_str().to_string()))],
    )?
    .into_iter()
    .map(|row| {
        let id = expect_string(row.first(), "provenance.ref_id")?;
        let value = serde_json::from_str(&expect_string(row.get(1), "provenance.value_json")?)?;
        Ok((id, value))
    })
    .collect()
}

fn load_existing_gaps(
    connection: &Connection<'_>,
    project_id: &ProjectId,
) -> Result<BTreeMap<(String, String), ExistingGap>, GraphError> {
    execute(
        connection,
        "MATCH (gap:GraphGap)
         WHERE gap.project_id = $project_id
         RETURN gap.gap_id,
                gap.subject_key,
                gap.rule_id,
                gap.status,
                gap.basis_json",
        vec![("project_id", Value::String(project_id.as_str().to_string()))],
    )?
    .into_iter()
    .map(|row| {
        let value = ExistingGap {
            gap_id: expect_string(row.first(), "gap.gap_id")?,
            subject_key: expect_string(row.get(1), "gap.subject_key")?,
            rule_id: expect_string(row.get(2), "gap.rule_id")?,
            status: super::parse_enum(&expect_string(row.get(3), "gap.status")?)?,
            basis_json: expect_string(row.get(4), "gap.basis_json")?,
        };
        Ok(((value.subject_key.clone(), value.rule_id.clone()), value))
    })
    .collect()
}

fn current_authority_cursor(
    connection: &Connection<'_>,
    project_id: &ProjectId,
) -> Result<u64, GraphError> {
    let rows = execute(
        connection,
        "MATCH (cursor:IngestCursor)
         WHERE cursor.project_id = $project_id
         RETURN cursor.authority_cursor
         ORDER BY cursor.authority_cursor DESC
         LIMIT 1",
        vec![("project_id", Value::String(project_id.as_str().to_string()))],
    )?;
    let Some(row) = rows.first() else {
        return Ok(0);
    };
    let value = expect_i64(row.first(), "cursor.authority_cursor")?;
    u64::try_from(value).map_err(|_| GraphError::Invariant("negative ingest cursor".to_string()))
}

fn gap_id(project_id: &ProjectId, subject_key: &str, rule_id: &str) -> String {
    let digest =
        sha256_prefixed(format!("{}\0{}\0{}", project_id, subject_key, rule_id).as_bytes());
    format!("gap_{}", digest.trim_start_matches("sha256:"))
}

fn authority_key(reference: &rho_protocol::AuthorityRefV1) -> String {
    format!("{:?}:{}", reference.kind, reference.authority_id)
}
