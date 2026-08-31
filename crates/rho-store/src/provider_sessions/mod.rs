use rho_protocol::{ProviderId, ProviderSessionId, SessionId};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::SemanticStore;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSessionLifecycle {
    Created,
    Active,
    Closed,
    Lost,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderContinuityMode {
    ExactResume,
    NewProviderSessionRehydrated,
    ModelContextReset,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderSessionProjection {
    pub provider_session_id: ProviderSessionId,
    pub logical_session_id: SessionId,
    pub provider_id: ProviderId,
    pub protocol: String,
    pub provider_version: String,
    pub external_session_id: String,
    pub capability_snapshot_digest: String,
    pub supports_resume: bool,
    pub lifecycle: ProviderSessionLifecycle,
    pub continuity_mode: ProviderContinuityMode,
    pub process_incarnation: u64,
    pub source_event_id: String,
    pub closed_event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderSessionCloseOutcome {
    Closed,
    AlreadyClosed,
}

#[derive(Debug, Error)]
pub enum ProviderSessionStoreError {
    #[error("provider session {0} is unknown")]
    Unknown(ProviderSessionId),
    #[error("provider session does not belong to the requested logical session")]
    WrongLogicalSession,
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid provider session row: {0}")]
    InvalidRow(String),
}

impl SemanticStore {
    pub fn upsert_provider_session(
        &self,
        projection: &ProviderSessionProjection,
    ) -> Result<(), ProviderSessionStoreError> {
        self.conn.execute(
            "INSERT INTO provider_sessions(
                provider_session_id, logical_session_id, provider_id, protocol, provider_version,
                external_session_id, capability_snapshot_digest, supports_resume, lifecycle,
                continuity_mode, process_incarnation, source_event_id, closed_event_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(provider_session_id) DO UPDATE SET
                lifecycle = excluded.lifecycle,
                continuity_mode = excluded.continuity_mode,
                capability_snapshot_digest = excluded.capability_snapshot_digest,
                source_event_id = excluded.source_event_id,
                closed_event_id = excluded.closed_event_id",
            params![
                projection.provider_session_id.as_str(),
                projection.logical_session_id.as_str(),
                projection.provider_id.as_str(),
                projection.protocol,
                projection.provider_version,
                projection.external_session_id,
                projection.capability_snapshot_digest,
                projection.supports_resume as i64,
                lifecycle_key(projection.lifecycle),
                continuity_key(projection.continuity_mode),
                projection.process_incarnation as i64,
                projection.source_event_id,
                projection.closed_event_id,
            ],
        )?;
        Ok(())
    }

    pub fn provider_session(
        &self,
        provider_session_id: &ProviderSessionId,
    ) -> Result<Option<ProviderSessionProjection>, ProviderSessionStoreError> {
        self.conn
            .query_row(
                "SELECT provider_session_id, logical_session_id, provider_id, protocol,
                        provider_version, external_session_id, capability_snapshot_digest,
                        supports_resume, lifecycle, continuity_mode, process_incarnation,
                        source_event_id, closed_event_id
                 FROM provider_sessions WHERE provider_session_id = ?1",
                params![provider_session_id.as_str()],
                decode_row,
            )
            .optional()
            .map_err(ProviderSessionStoreError::Sqlite)
    }

    pub fn list_provider_sessions(
        &self,
        logical_session_id: &SessionId,
    ) -> Result<Vec<ProviderSessionProjection>, ProviderSessionStoreError> {
        let mut statement = self.conn.prepare(
            "SELECT provider_session_id, logical_session_id, provider_id, protocol,
                    provider_version, external_session_id, capability_snapshot_digest,
                    supports_resume, lifecycle, continuity_mode, process_incarnation,
                    source_event_id, closed_event_id
             FROM provider_sessions WHERE logical_session_id = ?1
             ORDER BY process_incarnation, provider_session_id",
        )?;
        let rows = statement.query_map(params![logical_session_id.as_str()], decode_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(ProviderSessionStoreError::Sqlite)
    }

    pub fn close_provider_session(
        &self,
        logical_session_id: &SessionId,
        provider_session_id: &ProviderSessionId,
        closed_event_id: &str,
    ) -> Result<ProviderSessionCloseOutcome, ProviderSessionStoreError> {
        let existing = self
            .provider_session(provider_session_id)?
            .ok_or_else(|| ProviderSessionStoreError::Unknown(provider_session_id.clone()))?;
        if &existing.logical_session_id != logical_session_id {
            return Err(ProviderSessionStoreError::WrongLogicalSession);
        }
        if existing.lifecycle == ProviderSessionLifecycle::Closed {
            return Ok(ProviderSessionCloseOutcome::AlreadyClosed);
        }
        self.conn.execute(
            "UPDATE provider_sessions
             SET lifecycle = 'closed', closed_event_id = ?1, source_event_id = ?1
             WHERE provider_session_id = ?2 AND logical_session_id = ?3",
            params![
                closed_event_id,
                provider_session_id.as_str(),
                logical_session_id.as_str()
            ],
        )?;
        Ok(ProviderSessionCloseOutcome::Closed)
    }
}

fn decode_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderSessionProjection> {
    let provider_session_id =
        ProviderSessionId::new(row.get::<_, String>(0)?).map_err(invalid_row)?;
    let logical_session_id = SessionId::new(row.get::<_, String>(1)?).map_err(invalid_row)?;
    let provider_id = ProviderId::new(row.get::<_, String>(2)?).map_err(invalid_row)?;
    let lifecycle = parse_lifecycle(&row.get::<_, String>(8)?).map_err(invalid_row)?;
    let continuity_mode = parse_continuity(&row.get::<_, String>(9)?).map_err(invalid_row)?;
    Ok(ProviderSessionProjection {
        provider_session_id,
        logical_session_id,
        provider_id,
        protocol: row.get(3)?,
        provider_version: row.get(4)?,
        external_session_id: row.get(5)?,
        capability_snapshot_digest: row.get(6)?,
        supports_resume: row.get::<_, i64>(7)? != 0,
        lifecycle,
        continuity_mode,
        process_incarnation: row.get::<_, i64>(10)? as u64,
        source_event_id: row.get(11)?,
        closed_event_id: row.get(12)?,
    })
}

fn invalid_row(error: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error.to_string(),
        )),
    )
}

fn lifecycle_key(value: ProviderSessionLifecycle) -> &'static str {
    match value {
        ProviderSessionLifecycle::Created => "created",
        ProviderSessionLifecycle::Active => "active",
        ProviderSessionLifecycle::Closed => "closed",
        ProviderSessionLifecycle::Lost => "lost",
    }
}

fn parse_lifecycle(value: &str) -> Result<ProviderSessionLifecycle, String> {
    match value {
        "created" => Ok(ProviderSessionLifecycle::Created),
        "active" => Ok(ProviderSessionLifecycle::Active),
        "closed" => Ok(ProviderSessionLifecycle::Closed),
        "lost" => Ok(ProviderSessionLifecycle::Lost),
        other => Err(format!("unknown lifecycle {other}")),
    }
}

fn continuity_key(value: ProviderContinuityMode) -> &'static str {
    match value {
        ProviderContinuityMode::ExactResume => "exact_resume",
        ProviderContinuityMode::NewProviderSessionRehydrated => "new_provider_session_rehydrated",
        ProviderContinuityMode::ModelContextReset => "model_context_reset",
    }
}

fn parse_continuity(value: &str) -> Result<ProviderContinuityMode, String> {
    match value {
        "exact_resume" => Ok(ProviderContinuityMode::ExactResume),
        "new_provider_session_rehydrated" => {
            Ok(ProviderContinuityMode::NewProviderSessionRehydrated)
        }
        "model_context_reset" => Ok(ProviderContinuityMode::ModelContextReset),
        other => Err(format!("unknown continuity mode {other}")),
    }
}
