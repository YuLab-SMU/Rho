use std::collections::BTreeMap;

use rho_protocol::{SemanticEvent, SemanticEventPayload};
use rusqlite::{Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::events::event_type_key;

pub fn apply_semantic_projection(
    tx: &Transaction<'_>,
    event: &SemanticEvent,
) -> Result<(), rusqlite::Error> {
    let event_id = event.metadata.event_id.as_str();
    let projection_key = format!("event:{}", event_type_key(event.event_type));
    let projection_value = encode_json(&json!({
        "event_id": event_id,
        "event_type": event_type_key(event.event_type),
        "stream_id": event.metadata.stream_id.as_str(),
        "stream_seq": event.metadata.stream_seq.0,
    }))?;
    tx.execute(
        "INSERT OR REPLACE INTO current_projection(key, value_json, source_event_id) VALUES (?1, ?2, ?3)",
        params![projection_key, projection_value, event_id],
    )?;

    match &event.payload {
        SemanticEventPayload::RevisionAdvanced { transition } => {
            tx.execute(
                "INSERT OR REPLACE INTO revisions(
                    workspace_id, kernel_instance_id, state_revision, project_revision, source_event_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    transition.after.workspace_id.as_str(),
                    transition.after.kernel_instance_id.as_str(),
                    transition.after.state_revision.0 as i64,
                    transition.after.project_revision.0 as i64,
                    event_id,
                ],
            )?;
            let value = encode_json(&json!({
                "workspace_id": transition.after.workspace_id.as_str(),
                "kernel_instance_id": transition.after.kernel_instance_id.as_str(),
                "state_revision": transition.after.state_revision.0,
                "project_revision": transition.after.project_revision.0,
            }))?;
            tx.execute(
                "INSERT OR REPLACE INTO current_projection(key, value_json, source_event_id) VALUES ('workspace_revision', ?1, ?2)",
                params![value, event_id],
            )?;
        }
        SemanticEventPayload::ArtifactCommitted {
            artifact_id,
            digest,
            revision: _,
        } => {
            tx.execute(
                "INSERT OR REPLACE INTO artifacts(
                    artifact_id, digest, byte_size, media_type, producer_execution_id, revision_event_id, source_event_id
                 ) VALUES (?1, ?2, 0, 'application/octet-stream', NULL, ?3, ?3)",
                params![artifact_id.as_str(), digest.as_str(), event_id],
            )?;
            let value = encode_json(&json!({
                "artifact_id": artifact_id.as_str(),
                "digest": digest.as_str(),
            }))?;
            tx.execute(
                "INSERT OR REPLACE INTO current_projection(key, value_json, source_event_id) VALUES ('latest_artifact', ?1, ?2)",
                params![value, event_id],
            )?;
        }
        SemanticEventPayload::SessionChanged { session_id, state } => {
            tx.execute(
                "INSERT OR REPLACE INTO sessions(session_id, current_state, created_event_id) VALUES (?1, ?2, ?3)",
                params![session_id.as_str(), state, event_id],
            )?;
        }
        _ => {}
    }
    Ok(())
}

pub fn projection_snapshot(
    conn: &rusqlite::Connection,
) -> Result<BTreeMap<String, Value>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT key, value_json FROM current_projection ORDER BY key")?;
    let rows = stmt.query_map([], |row| {
        let key: String = row.get(0)?;
        let value_json: String = row.get(1)?;
        let value = serde_json::from_str(&value_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        Ok((key, value))
    })?;
    let mut snapshot = BTreeMap::new();
    for row in rows {
        let (key, value) = row?;
        snapshot.insert(key, value);
    }
    Ok(snapshot)
}

fn encode_json<T: Serialize>(value: &T) -> Result<String, rusqlite::Error> {
    serde_json::to_string(value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}
