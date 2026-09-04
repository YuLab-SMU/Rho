use lbug::{Connection, Value};
use rho_protocol::{
    AuthorityKindV1, AuthorityObservationV1, AuthorityReceiptBatchV1, AuthorityReceiptV1,
    AuthorityRefV1, DataClass, ProjectId,
};
use serde_json::{Value as JsonValue, json};

use crate::requests::validate_text;
use crate::{
    AuthorityIngestOutcome, EdgePredicate, GraphActorKind, GraphError, GraphMutationResult,
    MAX_NODE_PAYLOAD_BYTES, NodeKind,
};

use super::mutate::validate_observations;
use super::{
    EvidenceGraph, append_event, current_revision_on, ensure_json_bound, ensure_project_text,
    enum_text, execute, expect_i64, expect_optional_string, expect_string, now,
    optional_string_value, sha256_prefixed, transaction,
};

impl EvidenceGraph {
    pub fn apply_authority_batch(
        &mut self,
        batch: &AuthorityReceiptBatchV1,
    ) -> Result<AuthorityIngestOutcome, GraphError> {
        batch.validate()?;
        for receipt in &batch.receipts {
            if receipt.reference().project_id != self.project_id {
                return Err(GraphError::ProjectMismatch);
            }
        }
        let project_id = self.project_id.clone();
        let connection = self.connection()?;
        let current_cursor = read_cursor(&connection, &project_id, &batch.feed_id)?;
        if batch.next_cursor <= current_cursor {
            return Ok(AuthorityIngestOutcome {
                applied_receipts: 0,
                graph_revision: current_revision_on(&connection)?,
                authority_cursor: current_cursor,
            });
        }
        if batch.after_cursor != current_cursor {
            return Err(GraphError::StaleAuthorityCursor {
                feed_id: batch.feed_id.clone(),
                expected: current_cursor,
                actual: batch.after_cursor,
            });
        }
        let batch_json = serde_json::to_vec(batch)?;
        let batch_digest = sha256_prefixed(&batch_json);
        transaction(&connection, |connection| {
            for receipt in &batch.receipts {
                apply_receipt(connection, &project_id, receipt)?;
            }
            let revision = append_event(
                connection,
                &project_id,
                "authority_batch_applied",
                GraphActorKind::System,
                &json!({
                    "feed_id": batch.feed_id,
                    "after_cursor": batch.after_cursor,
                    "next_cursor": batch.next_cursor,
                    "receipt_count": batch.receipts.len(),
                    "batch_digest": batch_digest,
                    "has_more": batch.has_more,
                }),
            )?;
            write_cursor(
                connection,
                &project_id,
                &batch.feed_id,
                batch.next_cursor,
                Some(&now()),
                None,
            )?;
            Ok(AuthorityIngestOutcome {
                applied_receipts: batch.receipts.len(),
                graph_revision: revision,
                authority_cursor: batch.next_cursor,
            })
        })
    }

    pub fn reconcile_authority_refs(
        &mut self,
        observations: &[AuthorityObservationV1],
    ) -> Result<GraphMutationResult, GraphError> {
        validate_observations(
            &self.project_id,
            observations,
            "reconciliation.authority_observations",
        )?;
        if observations.is_empty() {
            return Ok(GraphMutationResult {
                record_id: "authority_reconciliation".to_string(),
                graph_revision: self.graph_revision()?,
            });
        }
        let project_id = self.project_id.clone();
        let digest = sha256_prefixed(&serde_json::to_vec(observations)?);
        let connection = self.connection()?;
        transaction(&connection, |connection| {
            for observation in observations {
                let Some(kind) = authority_node_kind(observation.reference.kind) else {
                    continue;
                };
                let node_id = authority_node_id(&observation.reference)?;
                let existing_payload = managed_node_payload(connection, &node_id)?
                    .unwrap_or_else(|| json!({ "authority_status": "unresolved" }));
                let mut payload = existing_payload.as_object().cloned().ok_or_else(|| {
                    GraphError::Invariant("managed authority payload is not an object".to_string())
                })?;
                payload.insert(
                    "cached_observation".to_string(),
                    serde_json::to_value(observation)?,
                );
                upsert_managed_node(
                    connection,
                    &project_id,
                    &observation.reference,
                    kind,
                    &observation.reference.authority_id,
                    &JsonValue::Object(payload),
                )?;
            }
            let revision = append_event(
                connection,
                &project_id,
                "authority_refs_reconciled",
                GraphActorKind::System,
                &json!({
                    "observation_count": observations.len(),
                    "observation_digest": digest,
                }),
            )?;
            Ok(GraphMutationResult {
                record_id: "authority_reconciliation".to_string(),
                graph_revision: revision,
            })
        })
    }

    pub fn record_ingest_error(
        &mut self,
        feed_id: &str,
        error_code: &str,
    ) -> Result<GraphMutationResult, GraphError> {
        validate_text(feed_id, "feed_id", 256)?;
        validate_text(error_code, "ingest_error_code", 256)?;
        let project_id = self.project_id.clone();
        let connection = self.connection()?;
        let cursor = read_cursor(&connection, &project_id, feed_id)?;
        transaction(&connection, |connection| {
            let revision = append_event(
                connection,
                &project_id,
                "authority_ingest_failed",
                GraphActorKind::System,
                &json!({ "feed_id": feed_id, "error_code": error_code }),
            )?;
            write_cursor(
                connection,
                &project_id,
                feed_id,
                cursor,
                None,
                Some(error_code),
            )?;
            Ok(GraphMutationResult {
                record_id: feed_id.to_string(),
                graph_revision: revision,
            })
        })
    }
}

fn apply_receipt(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    receipt: &AuthorityReceiptV1,
) -> Result<(), GraphError> {
    let payload = json!({ "receipt": receipt });
    match receipt {
        AuthorityReceiptV1::Run(value) => {
            let run = upsert_managed_node(
                connection,
                project_id,
                &value.reference,
                NodeKind::Run,
                &value.reference.authority_id,
                &payload,
            )?;
            if let Some(reference) = &value.environment_ref {
                let environment = upsert_placeholder(connection, project_id, reference)?;
                upsert_managed_edge(
                    connection,
                    project_id,
                    &run,
                    &environment,
                    EdgePredicate::UsesEnvironment,
                )?;
            }
            if let Some(reference) = &value.source_anchor_ref {
                let source = upsert_placeholder(connection, project_id, reference)?;
                upsert_managed_edge(
                    connection,
                    project_id,
                    &run,
                    &source,
                    EdgePredicate::ObservedIn,
                )?;
            }
        }
        AuthorityReceiptV1::Artifact(value) => {
            let artifact = upsert_managed_node(
                connection,
                project_id,
                &value.reference,
                NodeKind::Artifact,
                &value.reference.authority_id,
                &payload,
            )?;
            if let Some(reference) = &value.producing_run_ref {
                let run = upsert_placeholder(connection, project_id, reference)?;
                upsert_managed_edge(
                    connection,
                    project_id,
                    &artifact,
                    &run,
                    EdgePredicate::GeneratedBy,
                )?;
            }
        }
        AuthorityReceiptV1::Environment(value) => {
            upsert_managed_node(
                connection,
                project_id,
                &value.reference,
                NodeKind::EnvironmentSnapshot,
                &value.reference.authority_id,
                &payload,
            )?;
        }
        AuthorityReceiptV1::SourceAnchor(value) => {
            upsert_managed_node(
                connection,
                project_id,
                &value.reference,
                NodeKind::SourceRange,
                &value.path,
                &payload,
            )?;
        }
        AuthorityReceiptV1::Finding(value) => {
            let finding = upsert_managed_node(
                connection,
                project_id,
                &value.reference,
                NodeKind::CheckFinding,
                &value.rule_id,
                &payload,
            )?;
            for reference in &value.source_refs {
                if authority_node_kind(reference.kind).is_none() {
                    continue;
                }
                let source = upsert_placeholder(connection, project_id, reference)?;
                upsert_managed_edge(
                    connection,
                    project_id,
                    &finding,
                    &source,
                    EdgePredicate::ObservedIn,
                )?;
            }
        }
        AuthorityReceiptV1::AgentTurn(value) => {
            upsert_managed_node(
                connection,
                project_id,
                &value.reference,
                NodeKind::AgentTurn,
                &value.reference.authority_id,
                &payload,
            )?;
        }
    }
    Ok(())
}

fn upsert_placeholder(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    reference: &AuthorityRefV1,
) -> Result<String, GraphError> {
    let kind = authority_node_kind(reference.kind).ok_or_else(|| {
        GraphError::Validation(format!(
            "authority kind {:?} has no evidence graph node projection",
            reference.kind
        ))
    })?;
    upsert_managed_node(
        connection,
        project_id,
        reference,
        kind,
        &reference.authority_id,
        &json!({ "authority_status": "unresolved" }),
    )
}

pub(crate) fn upsert_managed_node(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    reference: &AuthorityRefV1,
    kind: NodeKind,
    label: &str,
    payload: &JsonValue,
) -> Result<String, GraphError> {
    reference.validate()?;
    if &reference.project_id != project_id {
        return Err(GraphError::ProjectMismatch);
    }
    let node_id = authority_node_id(reference)?;
    let payload_json = ensure_json_bound(payload, "managed_node.payload", MAX_NODE_PAYLOAD_BYTES)?;
    let authority_ref_json = serde_json::to_string(reference)?;
    let timestamp = now();
    let existing = execute(
        connection,
        "MATCH (node:GraphNode)
         WHERE node.node_id = $node_id
         RETURN node.project_id, node.promotion_state, node.authority_ref_json",
        vec![("node_id", Value::String(node_id.clone()))],
    )?;
    if let Some(row) = existing.first() {
        ensure_project_text(
            project_id,
            &expect_string(row.first(), "managed_node.project_id")?,
        )?;
        if expect_string(row.get(1), "managed_node.promotion_state")? != "managed"
            || expect_optional_string(row.get(2), "managed_node.authority_ref_json")?.as_deref()
                != Some(authority_ref_json.as_str())
        {
            return Err(GraphError::Invariant(
                "managed authority node identity collides with a graph-owned record".to_string(),
            ));
        }
        execute(
            connection,
            "MATCH (node:GraphNode)
             WHERE node.node_id = $node_id AND node.project_id = $project_id
             SET node.kind = $kind,
                 node.stable_key = $stable_key,
                 node.label = $label,
                 node.payload_json = $payload_json,
                 node.data_class = $data_class,
                 node.status = 'active',
                 node.updated_at = $updated_at",
            vec![
                ("node_id", Value::String(node_id.clone())),
                ("project_id", Value::String(project_id.as_str().to_string())),
                ("kind", Value::String(kind.as_str().to_string())),
                ("stable_key", Value::String(reference.authority_id.clone())),
                ("label", Value::String(label.to_string())),
                ("payload_json", Value::String(payload_json)),
                (
                    "data_class",
                    Value::String(enum_text(DataClass::ProjectInternal)?),
                ),
                ("updated_at", Value::String(timestamp)),
            ],
        )?;
        return Ok(node_id);
    }
    execute(
        connection,
        "CREATE (:GraphNode {
            node_id: $node_id,
            project_id: $project_id,
            kind: $kind,
            stable_key: $stable_key,
            label: $label,
            payload_json: $payload_json,
            data_class: $data_class,
            promotion_state: 'managed',
            status: 'active',
            authority_ref_json: $authority_ref_json,
            created_at: $created_at,
            updated_at: $updated_at
        })",
        vec![
            ("node_id", Value::String(node_id.clone())),
            ("project_id", Value::String(project_id.as_str().to_string())),
            ("kind", Value::String(kind.as_str().to_string())),
            ("stable_key", Value::String(reference.authority_id.clone())),
            ("label", Value::String(label.to_string())),
            ("payload_json", Value::String(payload_json)),
            (
                "data_class",
                Value::String(enum_text(DataClass::ProjectInternal)?),
            ),
            ("authority_ref_json", Value::String(authority_ref_json)),
            ("created_at", Value::String(timestamp.clone())),
            ("updated_at", Value::String(timestamp)),
        ],
    )?;
    Ok(node_id)
}

fn upsert_managed_edge(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    from_node: &str,
    to_node: &str,
    predicate: EdgePredicate,
) -> Result<String, GraphError> {
    let key = format!(
        "{}\0{}\0{}\0managed",
        from_node,
        to_node,
        predicate.as_str()
    );
    let digest = sha256_prefixed(key.as_bytes());
    let edge_id = format!("managed_edge_{}", digest.trim_start_matches("sha256:"));
    let existing = execute(
        connection,
        "MATCH (source:GraphNode)-[edge:GraphLink]->(target:GraphNode)
         WHERE edge.edge_id = $edge_id
         RETURN edge.project_id, source.node_id, target.node_id, edge.predicate",
        vec![("edge_id", Value::String(edge_id.clone()))],
    )?;
    if let Some(row) = existing.first() {
        ensure_project_text(
            project_id,
            &expect_string(row.first(), "managed_edge.project_id")?,
        )?;
        if expect_string(row.get(1), "managed_edge.from_node")? != from_node
            || expect_string(row.get(2), "managed_edge.to_node")? != to_node
            || expect_string(row.get(3), "managed_edge.predicate")? != predicate.as_str()
        {
            return Err(GraphError::Invariant(
                "managed edge digest collision".to_string(),
            ));
        }
        execute(
            connection,
            "MATCH ()-[edge:GraphLink]->()
             WHERE edge.edge_id = $edge_id AND edge.project_id = $project_id
             SET edge.status = 'active', edge.updated_at = $updated_at",
            vec![
                ("edge_id", Value::String(edge_id.clone())),
                ("project_id", Value::String(project_id.as_str().to_string())),
                ("updated_at", Value::String(now())),
            ],
        )?;
        return Ok(edge_id);
    }
    let timestamp = now();
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
            promotion_state: 'managed',
            created_at: $created_at,
            updated_at: $updated_at
         }]->(target)",
        vec![
            ("from_node", Value::String(from_node.to_string())),
            ("to_node", Value::String(to_node.to_string())),
            ("edge_id", Value::String(edge_id.clone())),
            ("project_id", Value::String(project_id.as_str().to_string())),
            ("predicate", Value::String(predicate.as_str().to_string())),
            ("polarity", Value::String(enum_text(predicate.polarity())?)),
            ("created_at", Value::String(timestamp.clone())),
            ("updated_at", Value::String(timestamp)),
        ],
    )?;
    Ok(edge_id)
}

fn managed_node_payload(
    connection: &Connection<'_>,
    node_id: &str,
) -> Result<Option<JsonValue>, GraphError> {
    let rows = execute(
        connection,
        "MATCH (node:GraphNode)
         WHERE node.node_id = $node_id
         RETURN node.payload_json",
        vec![("node_id", Value::String(node_id.to_string()))],
    )?;
    match rows.len() {
        0 => Ok(None),
        1 => Ok(Some(serde_json::from_str(&expect_string(
            rows[0].first(),
            "managed_node.payload_json",
        )?)?)),
        _ => Err(GraphError::Invariant(format!(
            "managed node identifier is duplicated: {node_id}"
        ))),
    }
}

fn authority_node_id(reference: &AuthorityRefV1) -> Result<String, GraphError> {
    reference.validate()?;
    let key = format!(
        "{}\0{}\0{}",
        reference.project_id,
        enum_text(reference.kind)?,
        reference.authority_id
    );
    let digest = sha256_prefixed(key.as_bytes());
    Ok(format!(
        "authority_{}",
        digest.trim_start_matches("sha256:")
    ))
}

fn authority_node_kind(kind: AuthorityKindV1) -> Option<NodeKind> {
    match kind {
        AuthorityKindV1::Run => Some(NodeKind::Run),
        AuthorityKindV1::Artifact => Some(NodeKind::Artifact),
        AuthorityKindV1::EnvironmentSnapshot => Some(NodeKind::EnvironmentSnapshot),
        AuthorityKindV1::SourceAnchor => Some(NodeKind::SourceRange),
        AuthorityKindV1::CheckFinding => Some(NodeKind::CheckFinding),
        AuthorityKindV1::AgentTurn => Some(NodeKind::AgentTurn),
        AuthorityKindV1::Job | AuthorityKindV1::Patch | AuthorityKindV1::Revision => None,
    }
}

fn read_cursor(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    feed_id: &str,
) -> Result<u64, GraphError> {
    let rows = execute(
        connection,
        "MATCH (cursor:IngestCursor)
         WHERE cursor.feed_id = $feed_id
         RETURN cursor.project_id, cursor.authority_cursor",
        vec![("feed_id", Value::String(feed_id.to_string()))],
    )?;
    match rows.len() {
        0 => Ok(0),
        1 => {
            ensure_project_text(
                project_id,
                &expect_string(rows[0].first(), "cursor.project_id")?,
            )?;
            let cursor = expect_i64(rows[0].get(1), "cursor.authority_cursor")?;
            u64::try_from(cursor)
                .map_err(|_| GraphError::Invariant("negative ingest cursor".to_string()))
        }
        _ => Err(GraphError::Invariant(format!(
            "ingest cursor is duplicated: {feed_id}"
        ))),
    }
}

fn write_cursor(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    feed_id: &str,
    cursor: u64,
    success_at: Option<&str>,
    error_code: Option<&str>,
) -> Result<(), GraphError> {
    let cursor = i64::try_from(cursor)
        .map_err(|_| GraphError::Invariant("ingest cursor exceeds INT64".to_string()))?;
    let existing = execute(
        connection,
        "MATCH (value:IngestCursor)
         WHERE value.feed_id = $feed_id
         RETURN value.project_id, value.last_success_at",
        vec![("feed_id", Value::String(feed_id.to_string()))],
    )?;
    if let Some(row) = existing.first() {
        ensure_project_text(
            project_id,
            &expect_string(row.first(), "cursor.project_id")?,
        )?;
        let retained_success = success_at.map(str::to_string).or(expect_optional_string(
            row.get(1),
            "cursor.last_success_at",
        )?);
        execute(
            connection,
            "MATCH (value:IngestCursor)
             WHERE value.feed_id = $feed_id AND value.project_id = $project_id
             SET value.authority_cursor = $authority_cursor,
                 value.last_success_at = $last_success_at,
                 value.last_error_code = $last_error_code",
            vec![
                ("feed_id", Value::String(feed_id.to_string())),
                ("project_id", Value::String(project_id.as_str().to_string())),
                ("authority_cursor", Value::Int64(cursor)),
                (
                    "last_success_at",
                    optional_string_value(retained_success.as_deref()),
                ),
                ("last_error_code", optional_string_value(error_code)),
            ],
        )?;
    } else {
        execute(
            connection,
            "CREATE (:IngestCursor {
                feed_id: $feed_id,
                project_id: $project_id,
                authority_cursor: $authority_cursor,
                last_success_at: $last_success_at,
                last_error_code: $last_error_code
            })",
            vec![
                ("feed_id", Value::String(feed_id.to_string())),
                ("project_id", Value::String(project_id.as_str().to_string())),
                ("authority_cursor", Value::Int64(cursor)),
                ("last_success_at", optional_string_value(success_at)),
                ("last_error_code", optional_string_value(error_code)),
            ],
        )?;
    }
    Ok(())
}
