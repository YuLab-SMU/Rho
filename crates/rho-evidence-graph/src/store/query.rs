use std::collections::{BTreeMap, BTreeSet};

use lbug::{LogicalType, Value};
use rho_protocol::{AuthorityRefV1, ProjectId, ProvenanceRefV1};

use crate::requests::validate_id;
use crate::{
    ClaimListRequest, ClaimTrace, EvidenceSubgraph, GapListRequest, GraphEdge, GraphError,
    GraphGap, GraphNode, GraphPage, GraphProvenanceRef, GraphRecordKind,
    MAX_AUTHORITY_RECONCILIATION_ITEMS, MAX_GRAPH_TRAVERSAL_EDGES, MAX_GRAPH_TRAVERSAL_NODES,
    NodeKind, SubgraphRequest,
};

use super::{
    EvidenceGraph, execute, expect_i64, expect_optional_f64, expect_optional_i64,
    expect_optional_string, expect_string, parse_enum,
};

pub(crate) const NODE_PROJECTION: &str = "node.node_id,
    node.project_id,
    node.kind,
    node.stable_key,
    node.label,
    node.payload_json,
    node.data_class,
    node.promotion_state,
    node.status,
    node.authority_ref_json,
    node.created_at,
    node.updated_at";

pub(crate) const EDGE_PROJECTION: &str = "edge.edge_id,
    edge.project_id,
    source.node_id,
    target.node_id,
    edge.predicate,
    edge.polarity,
    edge.status,
    edge.promotion_state,
    edge.provenance_ref_id,
    edge.confidence,
    edge.created_at,
    edge.updated_at";

pub(crate) const GAP_PROJECTION: &str = "gap.gap_id,
    gap.project_id,
    gap.subject_node,
    gap.rule_id,
    gap.status,
    gap.basis_json,
    gap.detected_revision,
    gap.resolved_revision,
    gap.detected_at,
    gap.resolved_at";

impl EvidenceGraph {
    pub fn list_claims(
        &self,
        request: ClaimListRequest,
    ) -> Result<GraphPage<GraphNode>, GraphError> {
        let limit = request.bounded_limit()?;
        let cursor = request.cursor.unwrap_or_default();
        if !cursor.is_empty() {
            validate_id(&cursor, "claim_list.cursor")?;
        }
        let states = if request.include_drafts {
            "node.promotion_state IN ['draft', 'promoted']"
        } else {
            "node.promotion_state = 'promoted'"
        };
        let query = format!(
            "MATCH (node:GraphNode)
             WHERE node.project_id = $project_id
               AND node.kind = 'claim'
               AND node.status <> 'retired'
               AND {states}
               AND node.node_id > $cursor
             RETURN {NODE_PROJECTION}
             ORDER BY node.node_id
             LIMIT {}",
            limit + 1
        );
        let connection = self.connection()?;
        let rows = execute(
            &connection,
            &query,
            vec![
                (
                    "project_id",
                    Value::String(self.project_id.as_str().to_string()),
                ),
                ("cursor", Value::String(cursor)),
            ],
        )?;
        page(rows, limit, node_from_row, |node| node.node_id.clone())
    }

    pub fn list_gaps(&self, request: GapListRequest) -> Result<GraphPage<GraphGap>, GraphError> {
        let limit = request.bounded_limit()?;
        let cursor = request.cursor.unwrap_or_default();
        if !cursor.is_empty() {
            validate_id(&cursor, "gap_list.cursor")?;
        }
        let status = if request.include_resolved {
            "gap.status IN ['open', 'acknowledged', 'resolved']"
        } else {
            "gap.status IN ['open', 'acknowledged']"
        };
        let query = format!(
            "MATCH (gap:GraphGap)
             WHERE gap.project_id = $project_id
               AND {status}
               AND gap.gap_id > $cursor
             RETURN {GAP_PROJECTION}
             ORDER BY gap.gap_id
             LIMIT {}",
            limit + 1
        );
        let connection = self.connection()?;
        let rows = execute(
            &connection,
            &query,
            vec![
                (
                    "project_id",
                    Value::String(self.project_id.as_str().to_string()),
                ),
                ("cursor", Value::String(cursor)),
            ],
        )?;
        page(rows, limit, gap_from_row, |gap| gap.gap_id.clone())
    }

    pub fn get_subgraph(&self, request: SubgraphRequest) -> Result<EvidenceSubgraph, GraphError> {
        request.validate()?;
        let root_node = self.get_node(&request.root_node)?;
        let connection = self.connection()?;
        let path_query = format!(
            "MATCH path = (root:GraphNode)-[:GraphLink*1..{}]-(other:GraphNode)
             WHERE root.node_id = $root_node
               AND root.project_id = $project_id
               AND other.project_id = $project_id
               AND other.status <> 'retired'
             RETURN DISTINCT other.node_id
             ORDER BY other.node_id
             LIMIT {}",
            request.max_depth, request.max_nodes
        );
        let neighbor_rows = execute(
            &connection,
            &path_query,
            vec![
                ("root_node", Value::String(request.root_node.clone())),
                (
                    "project_id",
                    Value::String(self.project_id.as_str().to_string()),
                ),
            ],
        )?;
        let mut neighbor_ids = neighbor_rows
            .iter()
            .map(|row| expect_string(row.first(), "subgraph.node_id"))
            .collect::<Result<Vec<_>, _>>()?;
        let mut truncated = neighbor_ids.len() >= request.max_nodes;
        neighbor_ids.truncate(request.max_nodes.saturating_sub(1));

        let mut node_ids = vec![request.root_node.clone()];
        node_ids.extend(neighbor_ids);
        node_ids.sort();
        node_ids.dedup();
        let mut nodes = load_nodes(&connection, &self.project_id, &node_ids)?;
        nodes.sort_by(|left, right| left.node_id.cmp(&right.node_id));
        let mut edges = load_edges(&connection, &self.project_id, &node_ids)?;
        if edges.len() > MAX_GRAPH_TRAVERSAL_EDGES {
            edges.truncate(MAX_GRAPH_TRAVERSAL_EDGES);
            truncated = true;
        }
        Ok(EvidenceSubgraph {
            root_node,
            nodes,
            edges,
            truncated,
        })
    }

    pub fn get_claim_trace(&self, claim_id: &str) -> Result<ClaimTrace, GraphError> {
        validate_id(claim_id, "claim_id")?;
        let subgraph = self.get_subgraph(SubgraphRequest {
            root_node: claim_id.to_string(),
            max_depth: 4,
            max_nodes: MAX_GRAPH_TRAVERSAL_NODES,
        })?;
        if subgraph.root_node.kind != NodeKind::Claim {
            return Err(GraphError::InvalidState(
                "claim trace root is not a claim".to_string(),
            ));
        }
        let connection = self.connection()?;
        let node_ids = subgraph
            .nodes
            .iter()
            .map(|node| node.node_id.clone())
            .collect::<Vec<_>>();
        let gaps = load_trace_gaps(&connection, &self.project_id, &node_ids)?;
        let authority_refs =
            load_trace_authority_refs(&connection, &subgraph.nodes, &subgraph.edges)?;
        Ok(ClaimTrace {
            claim: subgraph.root_node.clone(),
            nodes: subgraph
                .nodes
                .into_iter()
                .filter(|node| node.node_id != claim_id)
                .collect(),
            edges: subgraph.edges,
            gaps,
            authority_refs,
            truncated: subgraph.truncated,
        })
    }

    pub fn trace_artifact(&self, artifact_id: &str) -> Result<EvidenceSubgraph, GraphError> {
        let node_id = self.resolve_authority_node(NodeKind::Artifact, artifact_id)?;
        self.get_subgraph(SubgraphRequest {
            root_node: node_id,
            max_depth: 6,
            max_nodes: MAX_GRAPH_TRAVERSAL_NODES,
        })
    }

    pub fn list_agent_turn_evidence(&self, turn_id: &str) -> Result<EvidenceSubgraph, GraphError> {
        let node_id = self.resolve_authority_node(NodeKind::AgentTurn, turn_id)?;
        self.get_subgraph(SubgraphRequest {
            root_node: node_id,
            max_depth: 4,
            max_nodes: MAX_GRAPH_TRAVERSAL_NODES,
        })
    }

    pub fn get_node(&self, node_id: &str) -> Result<GraphNode, GraphError> {
        validate_id(node_id, "node_id")?;
        let connection = self.connection()?;
        let query = format!(
            "MATCH (node:GraphNode)
             WHERE node.node_id = $node_id
             RETURN {NODE_PROJECTION}"
        );
        let rows = execute(
            &connection,
            &query,
            vec![("node_id", Value::String(node_id.to_string()))],
        )?;
        match rows.len() {
            0 => Err(GraphError::NotFound(node_id.to_string())),
            1 => {
                let node = node_from_row(rows.into_iter().next().unwrap())?;
                if node.project_id != self.project_id {
                    return Err(GraphError::ProjectMismatch);
                }
                Ok(node)
            }
            _ => Err(GraphError::Invariant(format!(
                "node identifier is duplicated: {node_id}"
            ))),
        }
    }

    pub fn get_authority_node(&self, reference: &AuthorityRefV1) -> Result<GraphNode, GraphError> {
        reference.validate()?;
        if reference.project_id != self.project_id {
            return Err(GraphError::ProjectMismatch);
        }
        let connection = self.connection()?;
        let query = format!(
            "MATCH (node:GraphNode)
             WHERE node.project_id = $project_id
               AND node.authority_ref_json = $authority_ref_json
             RETURN {NODE_PROJECTION}"
        );
        let rows = execute(
            &connection,
            &query,
            vec![
                (
                    "project_id",
                    Value::String(self.project_id.as_str().to_string()),
                ),
                (
                    "authority_ref_json",
                    Value::String(serde_json::to_string(reference)?),
                ),
            ],
        )?;
        match rows.len() {
            0 => Err(GraphError::NotFound(reference.authority_id.clone())),
            1 => node_from_row(rows.into_iter().next().unwrap()),
            _ => Err(GraphError::Invariant(format!(
                "authority reference is duplicated: {}",
                reference.authority_id
            ))),
        }
    }

    pub fn get_provenance_refs(
        &self,
        ref_ids: &[String],
    ) -> Result<Vec<GraphProvenanceRef>, GraphError> {
        if ref_ids.len() > MAX_AUTHORITY_RECONCILIATION_ITEMS {
            return Err(GraphError::LimitExceeded {
                field: "provenance_refs",
                limit: MAX_AUTHORITY_RECONCILIATION_ITEMS,
            });
        }
        if ref_ids.is_empty() {
            return Ok(Vec::new());
        }
        for ref_id in ref_ids {
            validate_id(ref_id, "provenance_ref_id")?;
        }
        let connection = self.connection()?;
        execute(
            &connection,
            "MATCH (provenance:GraphProvenance)
             WHERE provenance.project_id = $project_id AND provenance.ref_id IN $ref_ids
             RETURN provenance.ref_id, provenance.project_id, provenance.value_json
             ORDER BY provenance.ref_id",
            vec![
                (
                    "project_id",
                    Value::String(self.project_id.as_str().to_string()),
                ),
                ("ref_ids", string_list(ref_ids)),
            ],
        )?
        .into_iter()
        .map(|row| {
            let stored_project =
                parse_project(&expect_string(row.get(1), "provenance.project_id")?)?;
            if stored_project != self.project_id {
                return Err(GraphError::ProjectMismatch);
            }
            Ok(GraphProvenanceRef {
                ref_id: expect_string(row.first(), "provenance.ref_id")?,
                project_id: stored_project,
                value: serde_json::from_str(&expect_string(row.get(2), "provenance.value_json")?)?,
            })
        })
        .collect()
    }

    pub fn promotion_authority_refs(
        &self,
        record_kind: GraphRecordKind,
        record_id: &str,
    ) -> Result<Vec<AuthorityRefV1>, GraphError> {
        validate_id(record_id, "record_id")?;
        match record_kind {
            GraphRecordKind::Node => Ok(self
                .get_node(record_id)?
                .authority_ref
                .into_iter()
                .collect()),
            GraphRecordKind::Edge => {
                let connection = self.connection()?;
                let rows = execute(
                    &connection,
                    "MATCH ()-[edge:GraphLink]->()
                     WHERE edge.edge_id = $edge_id AND edge.project_id = $project_id
                     RETURN edge.provenance_ref_id",
                    vec![
                        ("edge_id", Value::String(record_id.to_string())),
                        (
                            "project_id",
                            Value::String(self.project_id.as_str().to_string()),
                        ),
                    ],
                )?;
                if rows.is_empty() {
                    return Err(GraphError::NotFound(record_id.to_string()));
                }
                let Some(ref_id) =
                    expect_optional_string(rows[0].first(), "edge.provenance_ref_id")?
                else {
                    return Ok(Vec::new());
                };
                Ok(self
                    .get_provenance_refs(&[ref_id])?
                    .into_iter()
                    .map(|value| value.value.reference)
                    .collect())
            }
        }
    }

    pub fn all_authority_refs(&self) -> Result<Vec<AuthorityRefV1>, GraphError> {
        let connection = self.connection()?;
        let mut refs = BTreeMap::new();
        for row in execute(
            &connection,
            "MATCH (node:GraphNode)
             WHERE node.project_id = $project_id AND node.authority_ref_json IS NOT NULL
             RETURN node.authority_ref_json",
            vec![(
                "project_id",
                Value::String(self.project_id.as_str().to_string()),
            )],
        )? {
            let value: AuthorityRefV1 =
                serde_json::from_str(&expect_string(row.first(), "node.authority_ref_json")?)?;
            refs.insert(authority_key(&value), value);
        }
        for row in execute(
            &connection,
            "MATCH (provenance:GraphProvenance)
             WHERE provenance.project_id = $project_id
             RETURN provenance.value_json",
            vec![(
                "project_id",
                Value::String(self.project_id.as_str().to_string()),
            )],
        )? {
            let value: ProvenanceRefV1 =
                serde_json::from_str(&expect_string(row.first(), "provenance.value_json")?)?;
            refs.insert(authority_key(&value.reference), value.reference);
        }
        if refs.len() > MAX_AUTHORITY_RECONCILIATION_ITEMS {
            return Err(GraphError::LimitExceeded {
                field: "all_authority_refs",
                limit: MAX_AUTHORITY_RECONCILIATION_ITEMS,
            });
        }
        Ok(refs.into_values().collect())
    }

    fn resolve_authority_node(
        &self,
        kind: NodeKind,
        authority_id: &str,
    ) -> Result<String, GraphError> {
        validate_id(authority_id, "authority_id")?;
        let connection = self.connection()?;
        let rows = execute(
            &connection,
            "MATCH (node:GraphNode)
             WHERE node.project_id = $project_id
               AND node.kind = $kind
               AND (node.node_id = $authority_id OR node.stable_key = $authority_id)
             RETURN node.node_id",
            vec![
                (
                    "project_id",
                    Value::String(self.project_id.as_str().to_string()),
                ),
                ("kind", Value::String(kind.as_str().to_string())),
                ("authority_id", Value::String(authority_id.to_string())),
            ],
        )?;
        match rows.len() {
            0 => Err(GraphError::NotFound(authority_id.to_string())),
            1 => expect_string(rows[0].first(), "authority_node.node_id"),
            _ => Err(GraphError::Invariant(format!(
                "authority node is duplicated: {authority_id}"
            ))),
        }
    }
}

fn page<T>(
    rows: Vec<Vec<Value>>,
    limit: usize,
    parse: impl Fn(Vec<Value>) -> Result<T, GraphError>,
    cursor: impl Fn(&T) -> String,
) -> Result<GraphPage<T>, GraphError> {
    let has_more = rows.len() > limit;
    let items = rows
        .into_iter()
        .take(limit)
        .map(parse)
        .collect::<Result<Vec<_>, _>>()?;
    let next_cursor = has_more.then(|| items.last().map(&cursor)).flatten();
    Ok(GraphPage {
        items,
        next_cursor,
        has_more,
    })
}

fn load_nodes(
    connection: &lbug::Connection<'_>,
    project_id: &ProjectId,
    node_ids: &[String],
) -> Result<Vec<GraphNode>, GraphError> {
    if node_ids.is_empty() {
        return Ok(Vec::new());
    }
    let query = format!(
        "MATCH (node:GraphNode)
         WHERE node.project_id = $project_id AND node.node_id IN $node_ids
         RETURN {NODE_PROJECTION}
         ORDER BY node.node_id"
    );
    execute(
        connection,
        &query,
        vec![
            ("project_id", Value::String(project_id.as_str().to_string())),
            ("node_ids", string_list(node_ids)),
        ],
    )?
    .into_iter()
    .map(node_from_row)
    .collect()
}

fn load_edges(
    connection: &lbug::Connection<'_>,
    project_id: &ProjectId,
    node_ids: &[String],
) -> Result<Vec<GraphEdge>, GraphError> {
    if node_ids.is_empty() {
        return Ok(Vec::new());
    }
    let query = format!(
        "MATCH (source:GraphNode)-[edge:GraphLink]->(target:GraphNode)
         WHERE edge.project_id = $project_id
           AND edge.status <> 'retired'
           AND source.node_id IN $node_ids
           AND target.node_id IN $node_ids
         RETURN {EDGE_PROJECTION}
         ORDER BY edge.edge_id
         LIMIT {}",
        MAX_GRAPH_TRAVERSAL_EDGES + 1
    );
    execute(
        connection,
        &query,
        vec![
            ("project_id", Value::String(project_id.as_str().to_string())),
            ("node_ids", string_list(node_ids)),
        ],
    )?
    .into_iter()
    .map(edge_from_row)
    .collect()
}

fn load_trace_gaps(
    connection: &lbug::Connection<'_>,
    project_id: &ProjectId,
    node_ids: &[String],
) -> Result<Vec<GraphGap>, GraphError> {
    let query = format!(
        "MATCH (gap:GraphGap)
         WHERE gap.project_id = $project_id
           AND gap.status IN ['open', 'acknowledged']
           AND (gap.subject_node IS NULL OR gap.subject_node IN $node_ids)
         RETURN {GAP_PROJECTION}
         ORDER BY gap.gap_id"
    );
    execute(
        connection,
        &query,
        vec![
            ("project_id", Value::String(project_id.as_str().to_string())),
            ("node_ids", string_list(node_ids)),
        ],
    )?
    .into_iter()
    .map(gap_from_row)
    .collect()
}

fn load_trace_authority_refs(
    connection: &lbug::Connection<'_>,
    nodes: &[GraphNode],
    edges: &[GraphEdge],
) -> Result<Vec<AuthorityRefV1>, GraphError> {
    let mut refs = BTreeMap::new();
    for reference in nodes.iter().filter_map(|node| node.authority_ref.clone()) {
        refs.insert(authority_key(&reference), reference);
    }
    let provenance_ids = edges
        .iter()
        .filter_map(|edge| edge.provenance_ref_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if !provenance_ids.is_empty() {
        let rows = execute(
            connection,
            "MATCH (provenance:GraphProvenance)
             WHERE provenance.ref_id IN $ref_ids
             RETURN provenance.value_json
             ORDER BY provenance.ref_id",
            vec![("ref_ids", string_list(&provenance_ids))],
        )?;
        for row in rows {
            let value: ProvenanceRefV1 =
                serde_json::from_str(&expect_string(row.first(), "provenance.value_json")?)?;
            refs.insert(authority_key(&value.reference), value.reference);
        }
    }
    Ok(refs.into_values().collect())
}

fn authority_key(reference: &AuthorityRefV1) -> String {
    format!("{:?}:{}", reference.kind, reference.authority_id)
}

pub(crate) fn node_from_row(row: Vec<Value>) -> Result<GraphNode, GraphError> {
    if row.len() != 12 {
        return Err(GraphError::Invariant(format!(
            "node projection returned {} columns",
            row.len()
        )));
    }
    let project_id = parse_project(&expect_string(row.get(1), "node.project_id")?)?;
    let authority_ref_json = expect_optional_string(row.get(9), "node.authority_ref_json")?;
    Ok(GraphNode {
        node_id: expect_string(row.first(), "node.node_id")?,
        project_id,
        kind: parse_enum(&expect_string(row.get(2), "node.kind")?)?,
        stable_key: expect_string(row.get(3), "node.stable_key")?,
        label: expect_string(row.get(4), "node.label")?,
        payload: serde_json::from_str(&expect_string(row.get(5), "node.payload_json")?)?,
        data_class: parse_enum(&expect_string(row.get(6), "node.data_class")?)?,
        promotion_state: parse_enum(&expect_string(row.get(7), "node.promotion_state")?)?,
        status: parse_enum(&expect_string(row.get(8), "node.status")?)?,
        authority_ref: authority_ref_json
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        created_at: expect_string(row.get(10), "node.created_at")?,
        updated_at: expect_string(row.get(11), "node.updated_at")?,
    })
}

pub(crate) fn edge_from_row(row: Vec<Value>) -> Result<GraphEdge, GraphError> {
    if row.len() != 12 {
        return Err(GraphError::Invariant(format!(
            "edge projection returned {} columns",
            row.len()
        )));
    }
    Ok(GraphEdge {
        edge_id: expect_string(row.first(), "edge.edge_id")?,
        project_id: parse_project(&expect_string(row.get(1), "edge.project_id")?)?,
        from_node: expect_string(row.get(2), "edge.from_node")?,
        to_node: expect_string(row.get(3), "edge.to_node")?,
        predicate: parse_enum(&expect_string(row.get(4), "edge.predicate")?)?,
        polarity: parse_enum(&expect_string(row.get(5), "edge.polarity")?)?,
        status: parse_enum(&expect_string(row.get(6), "edge.status")?)?,
        promotion_state: parse_enum(&expect_string(row.get(7), "edge.promotion_state")?)?,
        provenance_ref_id: expect_optional_string(row.get(8), "edge.provenance_ref_id")?,
        confidence: expect_optional_f64(row.get(9), "edge.confidence")?,
        created_at: expect_string(row.get(10), "edge.created_at")?,
        updated_at: expect_string(row.get(11), "edge.updated_at")?,
    })
}

pub(crate) fn gap_from_row(row: Vec<Value>) -> Result<GraphGap, GraphError> {
    if row.len() != 10 {
        return Err(GraphError::Invariant(format!(
            "gap projection returned {} columns",
            row.len()
        )));
    }
    let detected_revision = expect_i64(row.get(6), "gap.detected_revision")?;
    let resolved_revision = expect_optional_i64(row.get(7), "gap.resolved_revision")?;
    Ok(GraphGap {
        gap_id: expect_string(row.first(), "gap.gap_id")?,
        project_id: parse_project(&expect_string(row.get(1), "gap.project_id")?)?,
        subject_node: expect_optional_string(row.get(2), "gap.subject_node")?,
        rule_id: expect_string(row.get(3), "gap.rule_id")?,
        status: parse_enum(&expect_string(row.get(4), "gap.status")?)?,
        basis: serde_json::from_str(&expect_string(row.get(5), "gap.basis_json")?)?,
        detected_revision: u64::try_from(detected_revision)
            .map_err(|_| GraphError::Invariant("negative gap detected revision".to_string()))?,
        resolved_revision: resolved_revision
            .map(u64::try_from)
            .transpose()
            .map_err(|_| GraphError::Invariant("negative gap resolved revision".to_string()))?,
        detected_at: expect_string(row.get(8), "gap.detected_at")?,
        resolved_at: expect_optional_string(row.get(9), "gap.resolved_at")?,
    })
}

fn string_list(values: &[String]) -> Value {
    Value::List(
        LogicalType::String,
        values.iter().cloned().map(Value::String).collect(),
    )
}

fn parse_project(value: &str) -> Result<ProjectId, GraphError> {
    ProjectId::new(value).map_err(|error| {
        GraphError::Invariant(format!("invalid project id stored in graph: {error}"))
    })
}
