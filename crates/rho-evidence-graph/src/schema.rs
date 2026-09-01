use std::collections::BTreeSet;

use lbug::{Connection, Value};
use rho_protocol::ProjectId;

use crate::store::{execute, expect_i64, expect_string, transaction};
use crate::{EVIDENCE_GRAPH_SCHEMA_VERSION, GraphError};

pub(crate) const REQUIRED_TABLES: [&str; 8] = [
    "GraphMetadata",
    "GraphNode",
    "GraphLink",
    "GraphProvenance",
    "GraphEvent",
    "GraphSnapshot",
    "GraphGap",
    "IngestCursor",
];

const SCHEMA_QUERIES: [&str; 8] = [
    "CREATE NODE TABLE GraphMetadata(
        metadata_key STRING PRIMARY KEY,
        schema_version INT64,
        engine_version STRING,
        engine_storage_version UINT64,
        project_id STRING,
        project_root_digest STRING,
        graph_revision INT64
    )",
    "CREATE NODE TABLE GraphNode(
        node_id STRING PRIMARY KEY,
        project_id STRING,
        kind STRING,
        stable_key STRING,
        label STRING,
        payload_json STRING,
        data_class STRING,
        promotion_state STRING,
        status STRING,
        authority_ref_json STRING,
        created_at STRING,
        updated_at STRING
    )",
    "CREATE REL TABLE GraphLink(
        FROM GraphNode TO GraphNode,
        edge_id STRING,
        project_id STRING,
        predicate STRING,
        polarity STRING,
        status STRING,
        promotion_state STRING,
        provenance_ref_id STRING,
        confidence DOUBLE,
        created_at STRING,
        updated_at STRING
    )",
    "CREATE NODE TABLE GraphProvenance(
        ref_id STRING PRIMARY KEY,
        project_id STRING,
        authority_kind STRING,
        authority_id STRING,
        digest STRING,
        project_revision INT64,
        state_revision INT64,
        captured_at STRING,
        bounded_excerpt STRING,
        data_class STRING,
        value_json STRING
    )",
    "CREATE NODE TABLE GraphEvent(
        event_id STRING PRIMARY KEY,
        project_id STRING,
        graph_revision INT64,
        event_type STRING,
        actor_kind STRING,
        payload_json STRING,
        created_at STRING
    )",
    "CREATE NODE TABLE GraphSnapshot(
        snapshot_id STRING PRIMARY KEY,
        project_id STRING,
        schema_version INT64,
        event_start INT64,
        event_end INT64,
        graph_digest STRING,
        created_at STRING
    )",
    "CREATE NODE TABLE GraphGap(
        gap_id STRING PRIMARY KEY,
        project_id STRING,
        subject_node STRING,
        subject_key STRING,
        rule_id STRING,
        status STRING,
        basis_json STRING,
        detected_revision INT64,
        resolved_revision INT64,
        detected_at STRING,
        resolved_at STRING
    )",
    "CREATE NODE TABLE IngestCursor(
        feed_id STRING PRIMARY KEY,
        project_id STRING,
        authority_cursor INT64,
        last_success_at STRING,
        last_error_code STRING
    )",
];

pub(crate) fn initialize_or_validate(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    project_root_digest: &str,
) -> Result<(), GraphError> {
    if table_names(connection)?.is_empty() {
        initialize(connection, project_id, project_root_digest)?;
    }
    assert_current(connection, project_id, project_root_digest)
}

fn initialize(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    project_root_digest: &str,
) -> Result<(), GraphError> {
    transaction(connection, |connection| {
        for query in SCHEMA_QUERIES {
            connection.query(query)?;
        }
        execute(
            connection,
            "CREATE (:GraphMetadata {
                metadata_key: 'singleton',
                schema_version: $schema_version,
                engine_version: $engine_version,
                engine_storage_version: $engine_storage_version,
                project_id: $project_id,
                project_root_digest: $project_root_digest,
                graph_revision: 0
            })",
            vec![
                (
                    "schema_version",
                    Value::Int64(EVIDENCE_GRAPH_SCHEMA_VERSION),
                ),
                ("engine_version", Value::String(lbug::VERSION.to_string())),
                (
                    "engine_storage_version",
                    Value::UInt64(lbug::get_storage_version()),
                ),
                ("project_id", Value::String(project_id.as_str().to_string())),
                (
                    "project_root_digest",
                    Value::String(project_root_digest.to_string()),
                ),
            ],
        )?;
        Ok(())
    })
}

pub(crate) fn assert_current(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    project_root_digest: &str,
) -> Result<(), GraphError> {
    let tables = table_names(connection)?;
    for required in REQUIRED_TABLES {
        if !tables.contains(required) {
            return Err(GraphError::Invariant(format!(
                "required graph table is missing: {required}"
            )));
        }
    }

    let rows = connection
        .query(
            "MATCH (metadata:GraphMetadata)
             WHERE metadata.metadata_key = 'singleton'
             RETURN metadata.schema_version,
                    metadata.project_id,
                    metadata.project_root_digest",
        )?
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Err(GraphError::SchemaResetRequired {
            found: None,
            required: EVIDENCE_GRAPH_SCHEMA_VERSION,
        });
    }
    let row = &rows[0];
    let version = expect_i64(row.first(), "metadata.schema_version")?;
    if version != EVIDENCE_GRAPH_SCHEMA_VERSION {
        return Err(GraphError::SchemaResetRequired {
            found: Some(version),
            required: EVIDENCE_GRAPH_SCHEMA_VERSION,
        });
    }
    let stored_project = expect_string(row.get(1), "metadata.project_id")?;
    let stored_root = expect_string(row.get(2), "metadata.project_root_digest")?;
    if stored_project != project_id.as_str() || stored_root != project_root_digest {
        return Err(GraphError::DatabaseProjectMismatch);
    }
    assert_projection_invariants(connection, project_id)?;
    Ok(())
}

fn assert_projection_invariants(
    connection: &Connection<'_>,
    project_id: &ProjectId,
) -> Result<(), GraphError> {
    let checks = [
        (
            "MATCH (node:GraphNode)
             WHERE node.project_id <> $project_id
             RETURN count(node)",
            "graph nodes contain a foreign project identity",
        ),
        (
            "MATCH (source:GraphNode)-[edge:GraphLink]->(target:GraphNode)
             WHERE edge.project_id <> $project_id
                OR source.project_id <> $project_id
                OR target.project_id <> $project_id
             RETURN count(edge)",
            "graph links contain a foreign project identity",
        ),
        (
            "MATCH ()-[edge:GraphLink]->()
             WHERE (edge.predicate IN ['supports', 'cites'] AND edge.polarity <> 'support')
                OR (edge.predicate = 'contradicts' AND edge.polarity <> 'conflict')
                OR (edge.predicate IN ['derived_from', 'generated_by', 'observed_in',
                                       'approved_by', 'uses_environment', 'stale_after',
                                       'requires_recheck'] AND edge.polarity <> 'neutral')
                OR (edge.predicate <> 'supports'
                    AND edge.predicate <> 'cites'
                    AND edge.predicate <> 'contradicts'
                    AND edge.predicate <> 'derived_from'
                    AND edge.predicate <> 'generated_by'
                    AND edge.predicate <> 'observed_in'
                    AND edge.predicate <> 'approved_by'
                    AND edge.predicate <> 'uses_environment'
                    AND edge.predicate <> 'stale_after'
                    AND edge.predicate <> 'requires_recheck')
             RETURN count(edge)",
            "graph predicate and polarity are inconsistent",
        ),
        (
            "MATCH ()-[edge:GraphLink]->()
             WHERE edge.promotion_state = 'promoted'
               AND edge.polarity IN ['support', 'conflict']
               AND edge.provenance_ref_id IS NULL
             RETURN count(edge)",
            "formal support or conflict link is missing provenance",
        ),
        (
            "MATCH ()-[edge:GraphLink]->()
             WHERE edge.confidence IS NOT NULL
               AND (edge.confidence < 0.0 OR edge.confidence > 1.0)
             RETURN count(edge)",
            "graph confidence is outside the bounded range",
        ),
        (
            "MATCH (provenance:GraphProvenance)
             WHERE provenance.project_id <> $project_id
             RETURN count(provenance)",
            "graph provenance contains a foreign project identity",
        ),
    ];
    for (query, message) in checks {
        let rows = execute(
            connection,
            query,
            vec![("project_id", Value::String(project_id.as_str().to_string()))],
        )?;
        let count = expect_i64(
            rows.first().and_then(|row| row.first()),
            "graph invariant count",
        )?;
        if count != 0 {
            return Err(GraphError::Invariant(message.to_string()));
        }
    }
    Ok(())
}

pub(crate) fn table_names(connection: &Connection<'_>) -> Result<BTreeSet<String>, GraphError> {
    connection
        .query("CALL SHOW_TABLES() RETURN name")?
        .map(|row| expect_string(row.first(), "show_tables.name"))
        .collect()
}
