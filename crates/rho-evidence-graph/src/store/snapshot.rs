use lbug::{Connection, Value};
use rho_protocol::{ProjectId, ProvenanceRefV1};
use serde::Serialize;
use serde_json::json;

use crate::{
    EVIDENCE_GRAPH_SCHEMA_VERSION, GraphActorKind, GraphEdge, GraphError, GraphGap, GraphNode,
    GraphProvenanceRef, GraphSnapshot,
};

use super::query::{
    EDGE_PROJECTION, GAP_PROJECTION, NODE_PROJECTION, edge_from_row, gap_from_row, node_from_row,
};
use super::{
    EvidenceGraph, append_event, execute, expect_i64, expect_optional_string, expect_string,
    new_id, now, sha256_prefixed, transaction,
};

#[derive(Serialize)]
struct CanonicalGraph<'a> {
    schema_version: i64,
    project_id: &'a str,
    nodes: &'a [GraphNode],
    edges: &'a [GraphEdge],
    provenance: &'a [GraphProvenanceRef],
    gaps: &'a [GraphGap],
    cursors: &'a [CanonicalCursor],
}

#[derive(Debug, Serialize)]
struct CanonicalCursor {
    feed_id: String,
    project_id: String,
    authority_cursor: u64,
    last_success_at: Option<String>,
    last_error_code: Option<String>,
}

impl EvidenceGraph {
    pub fn snapshot_graph(&mut self) -> Result<GraphSnapshot, GraphError> {
        let project_id = self.project_id.clone();
        let connection = self.connection()?;
        transaction(&connection, |connection| {
            let (nodes, edges, provenance, gaps, cursors) =
                canonical_content(connection, &project_id)?;
            let canonical = CanonicalGraph {
                schema_version: EVIDENCE_GRAPH_SCHEMA_VERSION,
                project_id: project_id.as_str(),
                nodes: &nodes,
                edges: &edges,
                provenance: &provenance,
                gaps: &gaps,
                cursors: &cursors,
            };
            let graph_digest = sha256_prefixed(&serde_json::to_vec(&canonical)?);
            let event_start = next_snapshot_event(connection, &project_id)?;
            let snapshot_id = new_id("snapshot");
            let event_end = append_event(
                connection,
                &project_id,
                "graph_snapshotted",
                GraphActorKind::System,
                &json!({
                    "snapshot_id": snapshot_id,
                    "graph_digest": graph_digest,
                }),
            )?;
            let created_at = now();
            execute(
                connection,
                "CREATE (:GraphSnapshot {
                    snapshot_id: $snapshot_id,
                    project_id: $project_id,
                    schema_version: $schema_version,
                    event_start: $event_start,
                    event_end: $event_end,
                    graph_digest: $graph_digest,
                    created_at: $created_at
                })",
                vec![
                    ("snapshot_id", Value::String(snapshot_id.clone())),
                    ("project_id", Value::String(project_id.as_str().to_string())),
                    (
                        "schema_version",
                        Value::Int64(EVIDENCE_GRAPH_SCHEMA_VERSION),
                    ),
                    (
                        "event_start",
                        Value::Int64(i64::try_from(event_start).map_err(|_| {
                            GraphError::Invariant("snapshot event start exceeds INT64".to_string())
                        })?),
                    ),
                    (
                        "event_end",
                        Value::Int64(i64::try_from(event_end).map_err(|_| {
                            GraphError::Invariant("snapshot event end exceeds INT64".to_string())
                        })?),
                    ),
                    ("graph_digest", Value::String(graph_digest.clone())),
                    ("created_at", Value::String(created_at.clone())),
                ],
            )?;
            Ok(GraphSnapshot {
                snapshot_id,
                project_id: project_id.clone(),
                schema_version: EVIDENCE_GRAPH_SCHEMA_VERSION,
                event_start,
                event_end,
                graph_digest,
                created_at,
            })
        })
    }
}

type CanonicalContent = (
    Vec<GraphNode>,
    Vec<GraphEdge>,
    Vec<GraphProvenanceRef>,
    Vec<GraphGap>,
    Vec<CanonicalCursor>,
);

fn canonical_content(
    connection: &Connection<'_>,
    project_id: &ProjectId,
) -> Result<CanonicalContent, GraphError> {
    let project_param = || vec![("project_id", Value::String(project_id.as_str().to_string()))];
    let node_query = format!(
        "MATCH (node:GraphNode)
         WHERE node.project_id = $project_id
         RETURN {NODE_PROJECTION}
         ORDER BY node.node_id"
    );
    let nodes = execute(connection, &node_query, project_param())?
        .into_iter()
        .map(node_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let edge_query = format!(
        "MATCH (source:GraphNode)-[edge:GraphLink]->(target:GraphNode)
         WHERE edge.project_id = $project_id
         RETURN {EDGE_PROJECTION}
         ORDER BY edge.edge_id"
    );
    let edges = execute(connection, &edge_query, project_param())?
        .into_iter()
        .map(edge_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let provenance = execute(
        connection,
        "MATCH (value:GraphProvenance)
         WHERE value.project_id = $project_id
         RETURN value.ref_id, value.project_id, value.value_json
         ORDER BY value.ref_id",
        project_param(),
    )?
    .into_iter()
    .map(|row| -> Result<GraphProvenanceRef, GraphError> {
        let stored_project = expect_string(row.get(1), "provenance.project_id")?;
        if stored_project != project_id.as_str() {
            return Err(GraphError::ProjectMismatch);
        }
        Ok(GraphProvenanceRef {
            ref_id: expect_string(row.first(), "provenance.ref_id")?,
            project_id: project_id.clone(),
            value: serde_json::from_str::<ProvenanceRefV1>(&expect_string(
                row.get(2),
                "provenance.value_json",
            )?)?,
        })
    })
    .collect::<Result<Vec<_>, _>>()?;
    let gap_query = format!(
        "MATCH (gap:GraphGap)
         WHERE gap.project_id = $project_id
         RETURN {GAP_PROJECTION}
         ORDER BY gap.gap_id"
    );
    let gaps = execute(connection, &gap_query, project_param())?
        .into_iter()
        .map(gap_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let cursors = execute(
        connection,
        "MATCH (cursor:IngestCursor)
         WHERE cursor.project_id = $project_id
         RETURN cursor.feed_id,
                cursor.project_id,
                cursor.authority_cursor,
                cursor.last_success_at,
                cursor.last_error_code
         ORDER BY cursor.feed_id",
        project_param(),
    )?
    .into_iter()
    .map(|row| -> Result<CanonicalCursor, GraphError> {
        let cursor = expect_i64(row.get(2), "cursor.authority_cursor")?;
        Ok(CanonicalCursor {
            feed_id: expect_string(row.first(), "cursor.feed_id")?,
            project_id: expect_string(row.get(1), "cursor.project_id")?,
            authority_cursor: u64::try_from(cursor)
                .map_err(|_| GraphError::Invariant("negative ingest cursor".to_string()))?,
            last_success_at: expect_optional_string(row.get(3), "cursor.last_success_at")?,
            last_error_code: expect_optional_string(row.get(4), "cursor.last_error_code")?,
        })
    })
    .collect::<Result<Vec<_>, _>>()?;
    Ok((nodes, edges, provenance, gaps, cursors))
}

fn next_snapshot_event(
    connection: &Connection<'_>,
    project_id: &ProjectId,
) -> Result<u64, GraphError> {
    let rows = execute(
        connection,
        "MATCH (snapshot:GraphSnapshot)
         WHERE snapshot.project_id = $project_id
         RETURN snapshot.event_end
         ORDER BY snapshot.event_end DESC
         LIMIT 1",
        vec![("project_id", Value::String(project_id.as_str().to_string()))],
    )?;
    let Some(row) = rows.first() else {
        return Ok(1);
    };
    let previous = expect_i64(row.first(), "snapshot.event_end")?;
    u64::try_from(previous)
        .map_err(|_| GraphError::Invariant("negative snapshot event end".to_string()))?
        .checked_add(1)
        .ok_or_else(|| GraphError::Invariant("snapshot event range overflow".to_string()))
}
