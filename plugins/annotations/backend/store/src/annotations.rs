//! Append-only annotation storage: evidence, captures and revisions plus receipts.
//! Every write re-checks its receipt, CAS head and project byte budget in one transaction.
use crate::AnnotationStore;
use rho_annotation_api::*;
use rho_annotation_owner::*;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};

fn error(e: impl std::fmt::Display) -> AnnotationError {
    AnnotationError::Storage(e.to_string())
}
fn decode<T: DeserializeOwned>(value: String) -> Result<T, AnnotationError> {
    serde_json::from_str(&value).map_err(error)
}
fn encode(value: &impl Serialize) -> Result<String, AnnotationError> {
    serde_json::to_string(value).map_err(error)
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS annotation_receipts(
        project TEXT NOT NULL, principal TEXT NOT NULL, request_id TEXT NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal,request_id));
    CREATE TABLE IF NOT EXISTS annotation_evidence(
        project TEXT NOT NULL, principal TEXT NOT NULL, evidence_id TEXT NOT NULL,
        source_id TEXT NOT NULL, source_version TEXT NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(project,principal,evidence_id));
    CREATE TABLE IF NOT EXISTS annotation_captures(
        project TEXT NOT NULL, principal TEXT NOT NULL, capture_id TEXT NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)), data BLOB NOT NULL,
        PRIMARY KEY(project,principal,capture_id));
    CREATE TABLE IF NOT EXISTS annotation_revisions(
        project TEXT NOT NULL, principal TEXT NOT NULL, annotation_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>=1), evidence_id TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), created_at INTEGER NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(project,principal,annotation_id,revision));
    CREATE TABLE IF NOT EXISTS annotation_heads(
        project TEXT NOT NULL, principal TEXT NOT NULL, annotation_id TEXT NOT NULL,
        revision INTEGER NOT NULL, evidence_id TEXT NOT NULL, source_id TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), created_at INTEGER NOT NULL,
        PRIMARY KEY(project,principal,annotation_id));
    CREATE INDEX IF NOT EXISTS annotation_heads_source ON annotation_heads(project,principal,source_id,created_at,annotation_id);
    CREATE INDEX IF NOT EXISTS annotation_heads_order ON annotation_heads(project,principal,created_at,annotation_id);",
        )
        .map_err(|e| e.to_string())
}

fn receipt(
    connection: &Connection,
    scope: &AnnotationScope,
    request_id: &str,
) -> Result<Option<StoredAnnotationReceipt>, AnnotationError> {
    connection
        .query_row(
            "SELECT value FROM annotation_receipts WHERE project=?1 AND principal=?2 AND request_id=?3",
            params![scope.project, scope.principal, request_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error)?
        .map(decode)
        .transpose()
}

fn evidence(
    connection: &Connection,
    scope: &AnnotationScope,
    evidence_id: &str,
) -> Result<Option<AnnotationEvidence>, AnnotationError> {
    connection
        .query_row(
            "SELECT value FROM annotation_evidence WHERE project=?1 AND principal=?2 AND evidence_id=?3",
            params![scope.project, scope.principal, evidence_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error)?
        .map(decode)
        .transpose()
}

fn head(
    connection: &Connection,
    scope: &AnnotationScope,
    annotation_id: &str,
) -> Result<Option<AnnotationRevision>, AnnotationError> {
    connection
        .query_row(
            "SELECT r.value FROM annotation_heads h JOIN annotation_revisions r
             ON r.project=h.project AND r.principal=h.principal AND r.annotation_id=h.annotation_id AND r.revision=h.revision
             WHERE h.project=?1 AND h.principal=?2 AND h.annotation_id=?3",
            params![scope.project, scope.principal, annotation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error)?
        .map(decode)
        .transpose()
}

/// Annotation bytes charged to the project: every retained row, including tombstones.
fn charged_bytes(connection: &Connection, project: &str) -> Result<u64, AnnotationError> {
    connection
        .query_row(
            "SELECT
              (SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM annotation_revisions WHERE project=?1)
            + (SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM annotation_evidence WHERE project=?1)
            + (SELECT COALESCE(SUM(length(data)+length(CAST(value AS BLOB))),0) FROM annotation_captures WHERE project=?1)
            + (SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM annotation_receipts WHERE project=?1)",
            params![project],
            |row| row.get::<_, i64>(0),
        )
        .map_err(error)
        .map(|bytes| bytes.max(0) as u64)
}

fn cursor(created_at: u64, annotation_id: &str) -> String {
    format!("{created_at:020}:{annotation_id}")
}

fn parse_cursor(after: &str) -> Result<(i64, String), AnnotationError> {
    let (time, id) = after
        .split_once(':')
        .ok_or_else(|| AnnotationError::InvalidInput("Invalid annotation cursor".into()))?;
    let time: i64 = time
        .parse()
        .map_err(|_| AnnotationError::InvalidInput("Invalid annotation cursor".into()))?;
    Ok((time, id.into()))
}

impl AnnotationRepository for AnnotationStore {
    fn annotation_receipt(
        &self,
        scope: &AnnotationScope,
        request_id: &str,
    ) -> Result<Option<StoredAnnotationReceipt>, AnnotationError> {
        let connection = self.0.lock().map_err(error)?;
        receipt(&connection, scope, request_id)
    }

    fn annotation_evidence(
        &self,
        scope: &AnnotationScope,
        evidence_id: &str,
    ) -> Result<Option<AnnotationEvidence>, AnnotationError> {
        let connection = self.0.lock().map_err(error)?;
        evidence(&connection, scope, evidence_id)
    }

    fn annotation_capture(
        &self,
        scope: &AnnotationScope,
        capture_id: &str,
    ) -> Result<Option<(AnnotationCaptureRef, Vec<u8>)>, AnnotationError> {
        let connection = self.0.lock().map_err(error)?;
        let row: Option<(String, Vec<u8>)> = connection
            .query_row(
                "SELECT value,data FROM annotation_captures WHERE project=?1 AND principal=?2 AND capture_id=?3",
                params![scope.project, scope.principal, capture_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        let Some((value, data)) = row else {
            return Ok(None);
        };
        let capture: AnnotationCaptureRef = decode(value)?;
        if capture.byte_size != data.len() as u64
            || capture.sha256 != rho_annotation_owner::sha256(&data)
        {
            return Err(AnnotationError::Storage(
                "stored capture does not match its reference".into(),
            ));
        }
        Ok(Some((capture, data)))
    }

    fn annotation_head(
        &self,
        scope: &AnnotationScope,
        annotation_id: &str,
    ) -> Result<Option<AnnotationRevision>, AnnotationError> {
        let connection = self.0.lock().map_err(error)?;
        head(&connection, scope, annotation_id)
    }

    fn annotation_revision(
        &self,
        scope: &AnnotationScope,
        reference: &AnnotationRevisionRef,
    ) -> Result<Option<AnnotationRevision>, AnnotationError> {
        let connection = self.0.lock().map_err(error)?;
        connection
            .query_row(
                "SELECT value FROM annotation_revisions WHERE project=?1 AND principal=?2 AND annotation_id=?3 AND revision=?4",
                params![scope.project, scope.principal, reference.annotation_id, reference.revision as i64],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(error)?
            .map(decode)
            .transpose()
    }

    fn annotation_list(
        &self,
        scope: &AnnotationScope,
        source_id: Option<&str>,
        after: Option<&str>,
        limit: u32,
        include_deleted: bool,
    ) -> Result<(Vec<AnnotationListItem>, Option<String>), AnnotationError> {
        let connection = self.0.lock().map_err(error)?;
        let (time, id) = match after {
            Some(after) => parse_cursor(after)?,
            None => (i64::MAX, String::new()),
        };
        let mut statement = connection
            .prepare(
                "SELECT r.value, e.value FROM annotation_heads h
                 JOIN annotation_revisions r ON r.project=h.project AND r.principal=h.principal AND r.annotation_id=h.annotation_id AND r.revision=h.revision
                 JOIN annotation_evidence e ON e.project=h.project AND e.principal=h.principal AND e.evidence_id=h.evidence_id
                 WHERE h.project=?1 AND h.principal=?2
                   AND (?3 IS NULL OR h.source_id=?3)
                   AND (?6=1 OR h.deleted=0)
                   AND (h.created_at<?4 OR (h.created_at=?4 AND h.annotation_id<?5))
                 ORDER BY h.created_at DESC, h.annotation_id DESC LIMIT ?7",
            )
            .map_err(error)?;
        let rows = statement
            .query_map(
                params![
                    scope.project,
                    scope.principal,
                    source_id,
                    time,
                    id,
                    include_deleted as i64,
                    (limit + 1) as i64
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(error)?;
        let mut items = Vec::new();
        for row in rows {
            let (revision, evidence) = row.map_err(error)?;
            let revision: AnnotationRevision = decode(revision)?;
            let evidence: AnnotationEvidence = decode(evidence)?;
            items.push(AnnotationListItem {
                revision,
                source: evidence.source,
                anchor: evidence.anchor,
            });
        }
        let next_after = (items.len() > limit as usize).then(|| {
            let last = &items[limit as usize - 1].revision;
            cursor(last.created_at_ms, &last.annotation.annotation_id)
        });
        items.truncate(limit as usize);
        Ok((items, next_after))
    }

    fn commit_annotation(
        &self,
        scope: &AnnotationScope,
        request_id: &str,
        input_digest: &str,
        write: AnnotationWrite<'_>,
        receipt_value: &AnnotationCommandReceipt,
    ) -> Result<AnnotationCommandReceipt, AnnotationError> {
        let mut connection = self.0.lock().map_err(error)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        if receipt_value.request_id != request_id {
            return Err(AnnotationError::Conflict);
        }
        if let Some(previous) = receipt(&tx, scope, request_id)? {
            if previous.input_digest != input_digest {
                return Err(AnnotationError::RequestConflict);
            }
            return Ok(previous.receipt);
        }
        let before = charged_bytes(&tx, &scope.project)?;
        match write {
            AnnotationWrite::Evidence(evidence) => {
                if !matches!(&receipt_value.outcome, AnnotationCommandOutcome::Evidence { evidence_id } if *evidence_id == evidence.evidence_id)
                {
                    return Err(AnnotationError::Conflict);
                }
                if let AnnotationAnchor::CapturedView { capture } = &evidence.anchor {
                    let stored: Option<String> = tx
                        .query_row(
                            "SELECT value FROM annotation_captures WHERE project=?1 AND principal=?2 AND capture_id=?3",
                            params![scope.project, scope.principal, capture.capture_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(error)?;
                    let stored: AnnotationCaptureRef =
                        decode(stored.ok_or(AnnotationError::NotFound)?)?;
                    if stored != *capture {
                        return Err(AnnotationError::Conflict);
                    }
                }
                tx.execute(
                    "INSERT INTO annotation_evidence(project,principal,evidence_id,source_id,source_version,value) VALUES(?1,?2,?3,?4,?5,?6)",
                    params![scope.project, scope.principal, evidence.evidence_id, evidence.source.source_id, evidence.source.source_version, encode(evidence)?],
                ).map_err(error)?;
            }
            AnnotationWrite::Capture(capture) => {
                if !matches!(&receipt_value.outcome, AnnotationCommandOutcome::Capture { capture: reference } if reference == capture.capture)
                    || capture.capture.byte_size != capture.bytes.len() as u64
                    || capture.capture.sha256 != rho_annotation_owner::sha256(capture.bytes)
                {
                    return Err(AnnotationError::Conflict);
                }
                tx.execute(
                    "INSERT INTO annotation_captures(project,principal,capture_id,value,data) VALUES(?1,?2,?3,?4,?5)",
                    params![scope.project, scope.principal, capture.capture.capture_id, encode(capture.capture)?, capture.bytes],
                ).map_err(error)?;
            }
            AnnotationWrite::Revision(write) => {
                let revision = write.revision;
                if !matches!(&receipt_value.outcome, AnnotationCommandOutcome::Annotation { annotation } if *annotation == revision.annotation)
                {
                    return Err(AnnotationError::Conflict);
                }
                let stored_evidence = evidence(&tx, scope, &revision.evidence_id)?
                    .ok_or(AnnotationError::NotFound)?;
                let current = head(&tx, scope, &revision.annotation.annotation_id)?;
                match (write.expected, &current) {
                    (None, None) => {
                        if revision.annotation.revision != 1 {
                            return Err(AnnotationError::Conflict);
                        }
                        tx.execute(
                            "INSERT INTO annotation_heads(project,principal,annotation_id,revision,evidence_id,source_id,deleted,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                            params![scope.project, scope.principal, revision.annotation.annotation_id, revision.annotation.revision as i64, revision.evidence_id, stored_evidence.source.source_id, revision.deleted as i64, revision.created_at_ms as i64],
                        ).map_err(error)?;
                    }
                    (Some(expected), Some(current)) => {
                        if current.deleted
                            || current.annotation != *expected
                            || current.evidence_id != revision.evidence_id
                            || revision.annotation.revision != expected.revision + 1
                        {
                            return Err(AnnotationError::Conflict);
                        }
                        tx.execute(
                            "UPDATE annotation_heads SET revision=?4,deleted=?5 WHERE project=?1 AND principal=?2 AND annotation_id=?3",
                            params![scope.project, scope.principal, revision.annotation.annotation_id, revision.annotation.revision as i64, revision.deleted as i64],
                        ).map_err(error)?;
                    }
                    _ => return Err(AnnotationError::Conflict),
                }
                tx.execute(
                    "INSERT INTO annotation_revisions(project,principal,annotation_id,revision,evidence_id,deleted,created_at,value) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![scope.project, scope.principal, revision.annotation.annotation_id, revision.annotation.revision as i64, revision.evidence_id, revision.deleted as i64, revision.created_at_ms as i64, encode(revision)?],
                ).map_err(error)?;
            }
        }
        let saved = StoredAnnotationReceipt {
            input_digest: input_digest.into(),
            receipt: receipt_value.clone(),
        };
        tx.execute(
            "INSERT INTO annotation_receipts(project,principal,request_id,value) VALUES(?1,?2,?3,?4)",
            params![scope.project, scope.principal, request_id, encode(&saved)?],
        ).map_err(error)?;
        let after = charged_bytes(&tx, &scope.project)?;
        if after > MAX_PROJECT_ANNOTATION_BYTES && after > before {
            return Err(AnnotationError::Budget(
                "Project annotation storage is full (64 MiB); existing notes and captures are retained".into(),
            ));
        }
        tx.commit().map_err(error)?;
        Ok(receipt_value.clone())
    }
}
