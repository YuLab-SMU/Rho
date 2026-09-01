mod gaps;
mod ingest;
mod mutate;
mod open;
mod query;
mod snapshot;

use std::path::PathBuf;

use chrono::Utc;
use lbug::{Connection, Database, LogicalType, Value};
use rho_protocol::ProjectId;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{GraphActorKind, GraphError, MAX_GRAPH_EVENT_BYTES};

#[derive(Debug)]
pub struct EvidenceGraph {
    database: Database,
    project_id: ProjectId,
    project_root: PathBuf,
    database_path: PathBuf,
}

impl EvidenceGraph {
    pub fn project_id(&self) -> &ProjectId {
        &self.project_id
    }

    pub fn project_root(&self) -> &std::path::Path {
        &self.project_root
    }

    pub fn database_path(&self) -> &std::path::Path {
        &self.database_path
    }

    pub fn graph_revision(&self) -> Result<u64, GraphError> {
        current_revision_on(&self.connection()?)
    }

    pub(crate) fn connection(&self) -> Result<Connection<'_>, GraphError> {
        let connection = Connection::new(&self.database)?;
        connection.set_query_timeout(5_000);
        Ok(connection)
    }
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::now_v7().simple())
}

pub(crate) fn sha256_prefixed(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(crate) fn enum_text<T: Serialize>(value: T) -> Result<String, GraphError> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| GraphError::Invariant("enum did not serialize as text".to_string()))
}

pub(crate) fn parse_enum<T: DeserializeOwned>(value: &str) -> Result<T, GraphError> {
    serde_json::from_value(JsonValue::String(value.to_string())).map_err(GraphError::from)
}

pub(crate) fn execute(
    connection: &Connection<'_>,
    query: &str,
    params: Vec<(&str, Value)>,
) -> Result<Vec<Vec<Value>>, GraphError> {
    let mut prepared = connection.prepare(query)?;
    Ok(connection.execute(&mut prepared, params)?.collect())
}

pub(crate) fn transaction<T>(
    connection: &Connection<'_>,
    operation: impl FnOnce(&Connection<'_>) -> Result<T, GraphError>,
) -> Result<T, GraphError> {
    connection.query("BEGIN TRANSACTION")?;
    match operation(connection) {
        Ok(value) => {
            connection.query("COMMIT")?;
            Ok(value)
        }
        Err(error) => match connection.query("ROLLBACK") {
            Ok(_) => Err(error),
            Err(rollback_error) => Err(GraphError::Invariant(format!(
                "graph operation failed ({error}); rollback also failed ({rollback_error})"
            ))),
        },
    }
}

pub(crate) fn current_revision_on(connection: &Connection<'_>) -> Result<u64, GraphError> {
    let rows = connection
        .query(
            "MATCH (metadata:GraphMetadata)
             WHERE metadata.metadata_key = 'singleton'
             RETURN metadata.graph_revision",
        )?
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Err(GraphError::Invariant(
            "graph metadata singleton is missing or duplicated".to_string(),
        ));
    }
    let revision = expect_i64(rows[0].first(), "metadata.graph_revision")?;
    u64::try_from(revision)
        .map_err(|_| GraphError::Invariant("negative graph revision".to_string()))
}

pub(crate) fn require_revision(
    connection: &Connection<'_>,
    expected: u64,
) -> Result<(), GraphError> {
    let actual = current_revision_on(connection)?;
    if expected != actual {
        return Err(GraphError::StaleRevision { expected, actual });
    }
    Ok(())
}

pub(crate) fn append_event(
    connection: &Connection<'_>,
    project_id: &ProjectId,
    event_type: &str,
    actor: GraphActorKind,
    payload: &JsonValue,
) -> Result<u64, GraphError> {
    let payload_json = ensure_json_bound(payload, "graph_event.payload", MAX_GRAPH_EVENT_BYTES)?;
    let current = current_revision_on(connection)?;
    let next = current
        .checked_add(1)
        .ok_or_else(|| GraphError::Invariant("graph revision overflow".to_string()))?;
    let next_i64 = i64::try_from(next)
        .map_err(|_| GraphError::Invariant("graph revision exceeds INT64".to_string()))?;
    execute(
        connection,
        "MATCH (metadata:GraphMetadata)
         WHERE metadata.metadata_key = 'singleton'
         SET metadata.graph_revision = $revision",
        vec![("revision", Value::Int64(next_i64))],
    )?;
    execute(
        connection,
        "CREATE (:GraphEvent {
            event_id: $event_id,
            project_id: $project_id,
            graph_revision: $graph_revision,
            event_type: $event_type,
            actor_kind: $actor_kind,
            payload_json: $payload_json,
            created_at: $created_at
        })",
        vec![
            ("event_id", Value::String(new_id("event"))),
            ("project_id", Value::String(project_id.as_str().to_string())),
            ("graph_revision", Value::Int64(next_i64)),
            ("event_type", Value::String(event_type.to_string())),
            ("actor_kind", Value::String(enum_text(actor)?)),
            ("payload_json", Value::String(payload_json)),
            ("created_at", Value::String(now())),
        ],
    )?;
    Ok(next)
}

pub(crate) fn ensure_project_text(expected: &ProjectId, actual: &str) -> Result<(), GraphError> {
    if expected.as_str() != actual {
        return Err(GraphError::ProjectMismatch);
    }
    Ok(())
}

pub(crate) fn ensure_storable_data_class(
    data_class: rho_protocol::DataClass,
) -> Result<(), GraphError> {
    if data_class == rho_protocol::DataClass::RestrictedSecret {
        return Err(GraphError::Admission(
            "restricted-secret content cannot be stored in the evidence graph".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn ensure_json_bound(
    value: &JsonValue,
    field: &'static str,
    limit: usize,
) -> Result<String, GraphError> {
    let encoded = serde_json::to_string(value)?;
    if encoded.len() > limit {
        return Err(GraphError::LimitExceeded { field, limit });
    }
    Ok(encoded)
}

pub(crate) fn expect_string(
    value: Option<&Value>,
    field: &'static str,
) -> Result<String, GraphError> {
    match value {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(GraphError::Invariant(format!(
            "LadybugDB returned a non-string {field}"
        ))),
    }
}

pub(crate) fn expect_optional_string(
    value: Option<&Value>,
    field: &'static str,
) -> Result<Option<String>, GraphError> {
    match value {
        Some(Value::Null(_)) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(GraphError::Invariant(format!(
            "LadybugDB returned an invalid optional string {field}"
        ))),
    }
}

pub(crate) fn expect_i64(value: Option<&Value>, field: &'static str) -> Result<i64, GraphError> {
    match value {
        Some(Value::Int64(value)) => Ok(*value),
        Some(Value::UInt64(value)) => i64::try_from(*value)
            .map_err(|_| GraphError::Invariant(format!("{field} exceeds INT64"))),
        _ => Err(GraphError::Invariant(format!(
            "LadybugDB returned a non-integer {field}"
        ))),
    }
}

pub(crate) fn expect_optional_i64(
    value: Option<&Value>,
    field: &'static str,
) -> Result<Option<i64>, GraphError> {
    match value {
        Some(Value::Null(_)) => Ok(None),
        value => expect_i64(value, field).map(Some),
    }
}

pub(crate) fn expect_optional_f64(
    value: Option<&Value>,
    field: &'static str,
) -> Result<Option<f64>, GraphError> {
    match value {
        Some(Value::Null(_)) => Ok(None),
        Some(Value::Double(value)) => Ok(Some(*value)),
        Some(Value::Float(value)) => Ok(Some(f64::from(*value))),
        _ => Err(GraphError::Invariant(format!(
            "LadybugDB returned an invalid optional number {field}"
        ))),
    }
}

pub(crate) fn optional_string_value(value: Option<&str>) -> Value {
    value
        .map(|value| Value::String(value.to_string()))
        .unwrap_or(Value::Null(LogicalType::String))
}

pub(crate) fn optional_i64_value(value: Option<i64>) -> Value {
    value
        .map(Value::Int64)
        .unwrap_or(Value::Null(LogicalType::Int64))
}

pub(crate) fn optional_f64_value(value: Option<f64>) -> Value {
    value
        .map(Value::Double)
        .unwrap_or(Value::Null(LogicalType::Double))
}
