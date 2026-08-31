use rho_protocol::{EventValidationError, OperationId, SemanticEvent, StreamId, StreamSeq};
use rusqlite::{OptionalExtension, Transaction, params};
use thiserror::Error;

use crate::{
    SemanticStore,
    events::{event_type_key, payload_json, priority_key, semantic_event_json},
    projections::{apply_semantic_projection, projection_snapshot},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendCrashPoint {
    BeforeTransaction,
    AfterEventInsert,
    AfterProjectionUpdate,
    AfterCommit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppendOutcome {
    Appended {
        event_id: String,
        stream_seq: StreamSeq,
    },
    DuplicateOperation {
        operation_id: OperationId,
        existing_event_id: String,
    },
}

#[derive(Debug, Error)]
pub enum SemanticAppendError {
    #[error("stream sequence mismatch for {stream_id}: expected {expected:?}, actual {actual:?}")]
    StreamSequenceMismatch {
        stream_id: StreamId,
        expected: StreamSeq,
        actual: StreamSeq,
    },
    #[error("event metadata stream sequence {event:?} does not match append sequence {expected:?}")]
    EventSequenceMismatch {
        expected: StreamSeq,
        event: StreamSeq,
    },
    #[error("crash injected at {0:?}")]
    CrashInjected(AppendCrashPoint),
    #[error("event validation error: {0}")]
    EventValidation(#[from] EventValidationError),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Debug, Error)]
pub enum ProjectionRebuildError {
    #[error("event {event_id} in stream {stream_id} blocked rebuild: {source}")]
    Event {
        event_id: String,
        stream_id: String,
        source: EventValidationError,
    },
    #[error("event {event_id} in stream {stream_id} could not be decoded: {reason}")]
    Decode {
        event_id: String,
        stream_id: String,
        reason: String,
    },
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

impl SemanticStore {
    pub fn append_semantic_event(
        &mut self,
        expected_next_seq: StreamSeq,
        event: &SemanticEvent,
    ) -> Result<AppendOutcome, SemanticAppendError> {
        self.append_semantic_event_with_crash(expected_next_seq, event, None)
    }

    pub fn append_semantic_event_with_crash(
        &mut self,
        expected_next_seq: StreamSeq,
        event: &SemanticEvent,
        crash: Option<AppendCrashPoint>,
    ) -> Result<AppendOutcome, SemanticAppendError> {
        event.validate()?;
        if crash == Some(AppendCrashPoint::BeforeTransaction) {
            return Err(SemanticAppendError::CrashInjected(
                AppendCrashPoint::BeforeTransaction,
            ));
        }
        if event.metadata.stream_seq != expected_next_seq {
            return Err(SemanticAppendError::EventSequenceMismatch {
                expected: expected_next_seq,
                event: event.metadata.stream_seq,
            });
        }
        let tx = self.conn.transaction()?;
        if let Some(outcome) = duplicate_operation(&tx, event)? {
            tx.commit()?;
            return Ok(outcome);
        }
        let actual_next_seq = next_stream_seq(&tx, &event.metadata.stream_id)?;
        if actual_next_seq != expected_next_seq {
            return Err(SemanticAppendError::StreamSequenceMismatch {
                stream_id: event.metadata.stream_id.clone(),
                expected: expected_next_seq,
                actual: actual_next_seq,
            });
        }
        insert_event(&tx, event)?;
        if crash == Some(AppendCrashPoint::AfterEventInsert) {
            return Err(SemanticAppendError::CrashInjected(
                AppendCrashPoint::AfterEventInsert,
            ));
        }
        apply_semantic_projection(&tx, event)?;
        if crash == Some(AppendCrashPoint::AfterProjectionUpdate) {
            return Err(SemanticAppendError::CrashInjected(
                AppendCrashPoint::AfterProjectionUpdate,
            ));
        }
        tx.commit()?;
        if crash == Some(AppendCrashPoint::AfterCommit) {
            return Err(SemanticAppendError::CrashInjected(
                AppendCrashPoint::AfterCommit,
            ));
        }
        Ok(AppendOutcome::Appended {
            event_id: event.metadata.event_id.as_str().to_string(),
            stream_seq: event.metadata.stream_seq,
        })
    }

    pub fn current_projection_value(
        &self,
        key: &str,
    ) -> Result<Option<serde_json::Value>, rusqlite::Error> {
        let value_json: Option<String> = self
            .conn
            .query_row(
                "SELECT value_json FROM current_projection WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        value_json
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()
    }

    pub fn projection_snapshot(
        &self,
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, rusqlite::Error> {
        projection_snapshot(&self.conn)
    }

    pub fn rebuild_projection(
        &mut self,
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, ProjectionRebuildError> {
        let events = load_event_json(&self.conn)?;
        let tx = self.conn.transaction()?;
        clear_projections(&tx)?;
        for row in events {
            let event: SemanticEvent = serde_json::from_str(&row.event_json).map_err(|error| {
                ProjectionRebuildError::Decode {
                    event_id: row.event_id.clone(),
                    stream_id: row.stream_id.clone(),
                    reason: error.to_string(),
                }
            })?;
            event
                .validate()
                .map_err(|source| ProjectionRebuildError::Event {
                    event_id: row.event_id.clone(),
                    stream_id: row.stream_id.clone(),
                    source,
                })?;
            apply_semantic_projection(&tx, &event)?;
        }
        tx.commit()?;
        projection_snapshot(&self.conn).map_err(ProjectionRebuildError::Sqlite)
    }
}

struct StoredEventJson {
    event_id: String,
    stream_id: String,
    event_json: String,
}

fn load_event_json(conn: &rusqlite::Connection) -> Result<Vec<StoredEventJson>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT event_id, stream_id, event_json FROM events ORDER BY stream_id, stream_seq",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(StoredEventJson {
            event_id: row.get(0)?,
            stream_id: row.get(1)?,
            event_json: row.get(2)?,
        })
    })?;
    let mut events = Vec::new();
    for row in rows {
        events.push(row?);
    }
    Ok(events)
}

fn clear_projections(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute("DELETE FROM current_projection", [])?;
    tx.execute("DELETE FROM artifacts", [])?;
    tx.execute("DELETE FROM revisions", [])?;
    tx.execute("DELETE FROM sessions", [])?;
    Ok(())
}

fn next_stream_seq(
    tx: &Transaction<'_>,
    stream_id: &StreamId,
) -> Result<StreamSeq, rusqlite::Error> {
    let max_seq: Option<i64> = tx.query_row(
        "SELECT MAX(stream_seq) FROM events WHERE stream_id = ?1",
        params![stream_id.as_str()],
        |row| row.get(0),
    )?;
    Ok(StreamSeq(max_seq.map_or(0, |value| value as u64 + 1)))
}

fn duplicate_operation(
    tx: &Transaction<'_>,
    event: &SemanticEvent,
) -> Result<Option<AppendOutcome>, rusqlite::Error> {
    let Some(operation_id) = &event.metadata.operation_id else {
        return Ok(None);
    };
    let existing_event_id: Option<String> = tx
        .query_row(
            "SELECT event_id FROM events WHERE operation_id = ?1 LIMIT 1",
            params![operation_id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    Ok(
        existing_event_id.map(|existing_event_id| AppendOutcome::DuplicateOperation {
            operation_id: operation_id.clone(),
            existing_event_id,
        }),
    )
}

fn insert_event(tx: &Transaction<'_>, event: &SemanticEvent) -> Result<(), SemanticAppendError> {
    let payload_json = payload_json(event)?;
    let event_json = semantic_event_json(event)?;
    let payload_bytes = event.encoded_payload_len()? as i64;
    tx.execute(
        "INSERT INTO events(
            event_id, stream_id, stream_seq, schema_version, event_type, priority, channel,
            actor_kind, actor_id, workspace_id, kernel_instance_id, session_id, run_id, turn_id,
            tool_call_id, execution_id, job_id, operation_id, correlation_id, causation_id,
            trace_id, state_revision_before, state_revision_after, project_revision_before,
            project_revision_after, sensitivity, payload_json, event_json, payload_bytes,
            occurred_at_ms, committed_at_ms
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, 'semantic_durable', ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
            ?29, ?29
         )",
        params![
            event.metadata.event_id.as_str(),
            event.metadata.stream_id.as_str(),
            event.metadata.stream_seq.0 as i64,
            event.schema_version as i64,
            event_type_key(event.event_type),
            priority_key(event.priority),
            actor_kind_key(event.metadata.actor.kind),
            event.metadata.actor.id.as_str(),
            event.metadata.workspace_id.as_ref().map(|id| id.as_str()),
            event
                .metadata
                .kernel_instance_id
                .as_ref()
                .map(|id| id.as_str()),
            event.metadata.session_id.as_ref().map(|id| id.as_str()),
            event.metadata.run_id.as_ref().map(|id| id.as_str()),
            event.metadata.turn_id.as_ref().map(|id| id.as_str()),
            event.metadata.tool_call_id.as_ref().map(|id| id.as_str()),
            event.metadata.execution_id.as_ref().map(|id| id.as_str()),
            event.metadata.job_id.as_ref().map(|id| id.as_str()),
            event.metadata.operation_id.as_ref().map(|id| id.as_str()),
            event.metadata.correlation_id.as_str(),
            event.metadata.causation_id.as_ref().map(|id| id.as_str()),
            event.metadata.trace_id.as_str(),
            event
                .metadata
                .state_revision_before
                .map(|revision| revision.0 as i64),
            event
                .metadata
                .state_revision_after
                .map(|revision| revision.0 as i64),
            event
                .metadata
                .project_revision_before
                .map(|revision| revision.0 as i64),
            event
                .metadata
                .project_revision_after
                .map(|revision| revision.0 as i64),
            sensitivity_key(event.sensitivity),
            payload_json,
            event_json,
            payload_bytes,
            event.metadata.occurred_at.timestamp_millis(),
        ],
    )?;
    Ok(())
}

fn actor_kind_key(value: rho_protocol::ActorKind) -> String {
    serde_json::to_value(value)
        .expect("actor kind serializes")
        .as_str()
        .expect("actor kind serializes to string")
        .to_string()
}

fn sensitivity_key(value: rho_protocol::DataClass) -> String {
    serde_json::to_value(value)
        .expect("data class serializes")
        .as_str()
        .expect("data class serializes to string")
        .to_string()
}
