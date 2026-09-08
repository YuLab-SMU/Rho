#![forbid(unsafe_code)]
mod application;
pub use application::ApplicationStore;

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use async_trait::async_trait;
use rho_contract::{
    CallerIdentity, CallerKind, ContractFailureRecovery, MAX_OPERATION_COMMIT_BYTES,
    OPERATION_EVIDENCE_CHUNK_BYTES, Operation, OperationEventRecord, OperationEvidencePage,
    OperationId, OperationOutcome, OperationReadEvidenceArguments, OperationRecord,
    OperationStatus, OutboxRecord, UncommittedCandidate,
};
use rho_operation::{
    Admission, CancellationRequestOutcome, CommitPlan, OperationError, OperationJournal,
    OperationOutputPage, StoredDomainFact,
};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior, params,
};
use serde_json::{Value, json};

const MAX_OUTBOX_PAGE: usize = 1_000;
const MAX_PLAN_BYTES: usize = MAX_OPERATION_COMMIT_BYTES;
const APPLICATION_ID: i64 = 0x52484f4e;
const SCHEMA_VERSION: i64 = 1;

// Checkpoints and event pages must select the same visible set before pagination.
// An unbound read-only/demo Host passes NULL; project Hosts bind their canonical root.
const OPERATION_VISIBILITY: &str = "
    (?1 IS NULL OR json_extract(op.operation_json, '$.idempotency_scope') = ?1)
    AND COALESCE(json_extract(op.operation_json, '$.principal.kind'), op.caller_kind) = ?2
    AND COALESCE(json_extract(op.operation_json, '$.principal.id'), op.caller_id) = ?3";

pub struct SqliteOperationJournal {
    connection: Mutex<Connection>,
    // The OS releases this lock if the host exits or crashes. Readers never hold it.
    _writer_lock: Option<File>,
}

impl SqliteOperationJournal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, OperationError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(storage)?;
        }
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(storage)?;
        let path = std::fs::canonicalize(path).map_err(storage)?;
        // A separate file avoids conflicting with SQLite's own advisory locks.
        // Keep its inode in place; unlinking a lock file could admit a second host.
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".host.lock");
        let writer_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(storage)?;
        match writer_lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(OperationError::HostBusy),
            Err(error) => return Err(storage(error)),
        }
        let connection = Connection::open(&path).map_err(storage)?;
        let mut journal = Self::from_connection(connection)?;
        journal._writer_lock = Some(writer_lock);
        Ok(journal)
    }

    /// Does not create a database, change schema, or recover another host's operations.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, OperationError> {
        let connection =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(storage)?;
        check_schema(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            _writer_lock: None,
        })
    }

    pub fn open_in_memory() -> Result<Self, OperationError> {
        Self::from_connection(Connection::open_in_memory().map_err(storage)?)
    }

    fn from_connection(connection: Connection) -> Result<Self, OperationError> {
        let tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                [],
                |row| row.get(0),
            )
            .map_err(storage)?;
        if tables > 0 {
            check_schema(&connection)?;
        }
        connection
            .execute_batch(
                "
                PRAGMA foreign_keys = ON;
                PRAGMA busy_timeout = 5000;
                PRAGMA synchronous = FULL;
                BEGIN IMMEDIATE;

                CREATE TABLE IF NOT EXISTS operations (
                    operation_id TEXT PRIMARY KEY NOT NULL,
                    caller_id TEXT NOT NULL,
                    caller_kind TEXT NOT NULL,
                    client_request_id TEXT NOT NULL,
                    capability_id TEXT NOT NULL,
                    capability_version INTEGER NOT NULL CHECK (capability_version > 0),
                    invocation_digest TEXT NOT NULL,
                    operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
                    status TEXT NOT NULL CHECK (status IN (
                        'accepted', 'running', 'reconciling',
                        'succeeded', 'failed', 'cancelled', 'uncertain'
                    )),
                    outcome TEXT CHECK (outcome IS NULL OR outcome IN (
                        'succeeded', 'failed', 'cancelled', 'uncertain'
                    )),
                    output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
                    error TEXT,
                    recovery_json TEXT CHECK (
                        recovery_json IS NULL OR json_valid(recovery_json)
                    ),
                    cancellation_requested INTEGER NOT NULL DEFAULT 0
                        CHECK (cancellation_requested IN (0, 1)),
                    accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms >= 0),
                    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= accepted_at_ms),
                    UNIQUE (caller_kind, caller_id, client_request_id),
                    CHECK (
                        (status IN ('accepted', 'running', 'reconciling') AND outcome IS NULL)
                        OR (status IN ('succeeded', 'failed', 'cancelled', 'uncertain') AND outcome = status)
                    )
                );

                CREATE TABLE IF NOT EXISTS operation_events (
                    event_id TEXT PRIMARY KEY NOT NULL,
                    operation_id TEXT NOT NULL REFERENCES operations(operation_id),
                    sequence INTEGER NOT NULL CHECK (sequence >= 0),
                    kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
                    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
                    UNIQUE (operation_id, sequence)
                );

                CREATE TABLE IF NOT EXISTS domain_facts (
                    domain TEXT NOT NULL,
                    schema TEXT NOT NULL,
                    fact_key TEXT NOT NULL,
                    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
                    source_operation_id TEXT NOT NULL REFERENCES operations(operation_id),
                    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
                    PRIMARY KEY (domain, schema, fact_key)
                );

                CREATE TABLE IF NOT EXISTS outbox (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_id TEXT NOT NULL UNIQUE,
                    operation_id TEXT NOT NULL REFERENCES operations(operation_id),
                    topic TEXT NOT NULL,
                    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
                    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
                    delivered_at_ms INTEGER
                );

                CREATE TABLE IF NOT EXISTS operation_uncommitted_evidence (
                    operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(operation_id),
                    sha256 TEXT NOT NULL,
                    byte_size INTEGER NOT NULL CHECK(byte_size >= 0)
                );
                CREATE TABLE IF NOT EXISTS operation_uncommitted_evidence_chunks (
                    operation_id TEXT NOT NULL REFERENCES operation_uncommitted_evidence(operation_id),
                    chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
                    sha256 TEXT NOT NULL,
                    bytes BLOB NOT NULL CHECK(length(bytes) <= 65536),
                    PRIMARY KEY(operation_id,chunk_index)
                );

                CREATE INDEX IF NOT EXISTS idx_operation_events_operation
                    ON operation_events(operation_id, sequence);
                CREATE INDEX IF NOT EXISTS idx_domain_facts_operation
                    ON domain_facts(source_operation_id);
                CREATE INDEX IF NOT EXISTS idx_outbox_delivery
                    ON outbox(delivered_at_ms, sequence);
                PRAGMA application_id = 1380470606;
                PRAGMA user_version = 1;
                COMMIT;
                ",
            )
            .map_err(storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
            _writer_lock: None,
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>, OperationError> {
        self.connection
            .lock()
            .map_err(|_| OperationError::Storage("SQLite connection lock was poisoned".to_string()))
    }
}

#[async_trait]
impl OperationJournal for SqliteOperationJournal {
    async fn events_checkpoint(
        &self,
        scope: &str,
        principal: &CallerIdentity,
    ) -> Result<rho_contract::OperationEventsCheckpoint, OperationError> {
        let connection = self.connection()?;
        let sequence = connection
            .query_row(
                &format!(
                    "SELECT COALESCE(MAX(o.sequence), 0)
                     FROM outbox o JOIN operations op ON op.operation_id = o.operation_id
                     WHERE {OPERATION_VISIBILITY}"
                ),
                params![scope, caller_kind(principal.kind), principal.id],
                |row| row.get(0),
            )
            .map_err(storage)?;
        Ok(rho_contract::OperationEventsCheckpoint { sequence })
    }

    async fn list_recent(
        &self,
        scope: &str,
        caller: &CallerIdentity,
        args: &rho_contract::RecentOperationsArguments,
    ) -> Result<rho_contract::RecentOperations, OperationError> {
        rho_operation::validate_recent_arguments(args)?;
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT op.rowid, op.operation_id, op.client_request_id,
                        op.capability_id, op.capability_version, op.status,
                        op.accepted_at_ms, op.updated_at_ms, substr(op.error, 1, 2048)
                 FROM operations op WHERE {OPERATION_VISIBILITY}
                   AND op.rowid < ?4
                   AND (?5 IS NULL OR op.client_request_id = ?5)
                   AND (?6 IS NULL OR op.operation_id = ?6)
                 ORDER BY op.rowid DESC LIMIT ?7"
            ))
            .map_err(storage)?;
        let mut rows = statement
            .query(params![
                scope,
                caller_kind(caller.kind),
                caller.id,
                args.before_cursor.unwrap_or(i64::MAX as u64) as i64,
                args.client_request_id,
                args.operation_id.as_ref().map(OperationId::as_str),
                args.limit + 1
            ])
            .map_err(storage)?;
        let mut operations = Vec::new();
        while let Some(row) = rows.next().map_err(storage)? {
            let status: String = row.get(5).map_err(storage)?;
            let id: String = row.get(1).map_err(storage)?;
            operations.push(rho_contract::OperationSummary {
                cursor: row.get(0).map_err(storage)?,
                operation_id: OperationId::new(id)?,
                client_request_id: row.get(2).map_err(storage)?,
                capability: rho_contract::CapabilityRef::new(
                    row.get::<_, String>(3).map_err(storage)?,
                    row.get(4).map_err(storage)?,
                )?,
                status: serde_json::from_value(json!(status)).map_err(storage)?,
                accepted_at_ms: row.get(6).map_err(storage)?,
                updated_at_ms: row.get(7).map_err(storage)?,
                error: row.get(8).map_err(storage)?,
            });
        }
        let next_cursor = (operations.len() > args.limit as usize)
            .then(|| operations[args.limit as usize - 1].cursor);
        operations.truncate(args.limit as usize);
        Ok(rho_contract::RecentOperations {
            operations,
            next_cursor,
        })
    }

    async fn admit(&self, operation: &Operation) -> Result<Admission, OperationError> {
        let mut connection = self.connection()?;
        let transaction =
            Transaction::new(&mut connection, TransactionBehavior::Immediate).map_err(storage)?;
        if let Some(existing) = operation_by_idempotency_key(
            &transaction,
            operation.caller.kind,
            &operation.caller.id,
            &operation.client_request_id,
        )? {
            if existing.operation.invocation_digest != operation.invocation_digest
                || existing.operation.capability != operation.capability
            {
                return Err(OperationError::IdempotencyConflict);
            }
            transaction.commit().map_err(storage)?;
            return Ok(Admission::Existing(existing));
        }

        let operation_json = encode(operation)?;
        transaction
            .execute(
                "INSERT INTO operations(
                    operation_id, caller_id, caller_kind, client_request_id,
                    capability_id, capability_version, invocation_digest,
                    operation_json, status, outcome, output_json, error,
                    recovery_json, cancellation_requested, accepted_at_ms, updated_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'accepted',
                          NULL, NULL, NULL, NULL, 0, ?9, ?9)",
                params![
                    operation.operation_id.as_str(),
                    operation.caller.id,
                    caller_kind(operation.caller.kind),
                    operation.client_request_id,
                    operation.capability.id,
                    i64::from(operation.capability.version),
                    operation.invocation_digest,
                    operation_json,
                    operation.accepted_at_ms,
                ],
            )
            .map_err(storage)?;
        append_event_and_outbox(
            &transaction,
            &operation.operation_id,
            "operation.accepted",
            &json!({
                "status": "accepted",
                "capability": operation.capability,
                "target": operation.target,
            }),
            operation.accepted_at_ms,
        )?;
        let record = operation_by_id(&transaction, &operation.operation_id)?
            .ok_or_else(|| OperationError::Storage("admitted operation disappeared".to_string()))?;
        transaction.commit().map_err(storage)?;
        Ok(Admission::New(record))
    }

    async fn mark_running(
        &self,
        operation_id: &OperationId,
        at_ms: i64,
    ) -> Result<OperationRecord, OperationError> {
        let mut connection = self.connection()?;
        let transaction =
            Transaction::new(&mut connection, TransactionBehavior::Immediate).map_err(storage)?;
        let current = required_operation(&transaction, operation_id)?;
        match current.status {
            OperationStatus::Accepted => {
                transaction
                    .execute(
                        "UPDATE operations
                         SET status = 'running', updated_at_ms = MAX(updated_at_ms, ?2)
                         WHERE operation_id = ?1 AND status = 'accepted'",
                        params![operation_id.as_str(), at_ms],
                    )
                    .map_err(storage)?;
                append_event_and_outbox(
                    &transaction,
                    operation_id,
                    "operation.running",
                    &json!({"status": "running"}),
                    at_ms,
                )?;
            }
            status => {
                return Err(OperationError::LifecycleConflict(format!(
                    "cannot start operation {} from {status:?}",
                    operation_id.as_str()
                )));
            }
        }
        let record = required_operation(&transaction, operation_id)?;
        transaction.commit().map_err(storage)?;
        Ok(record)
    }

    async fn commit(
        &self,
        operation_id: &OperationId,
        plan: &CommitPlan,
        at_ms: i64,
    ) -> Result<OperationRecord, OperationError> {
        validate_plan(plan)?;
        let mut connection = self.connection()?;
        let transaction =
            Transaction::new(&mut connection, TransactionBehavior::Immediate).map_err(storage)?;
        let current = required_operation(&transaction, operation_id)?;
        if current.status.is_terminal() {
            return Err(OperationError::LifecycleConflict(format!(
                "terminal operation {} cannot be committed again",
                operation_id.as_str()
            )));
        }
        let before_start = current.status == OperationStatus::Accepted
            && matches!(
                plan.outcome,
                OperationOutcome::Failed | OperationOutcome::Cancelled
            )
            && plan.output.is_none()
            && plan.facts.is_empty()
            && plan.effect_observations.is_empty()
            && plan.events.is_empty();
        if !before_start
            && !matches!(
                current.status,
                OperationStatus::Running | OperationStatus::Reconciling
            )
        {
            return Err(OperationError::LifecycleConflict(format!(
                "operation {} cannot commit from {:?}",
                operation_id.as_str(),
                current.status
            )));
        }

        if let Some(evidence) = &plan.uncommitted_evidence {
            let fault: ContractFailureRecovery =
                serde_json::from_value(plan.recovery.clone().unwrap_or_default())
                    .map_err(storage)?;
            if evidence.reference.operation_id != *operation_id
                || fault.capability != current.operation.capability
                || !matches!(fault.candidate, UncommittedCandidate::Evidence { reference } if reference == evidence.reference)
                || !matches!(
                    plan.outcome,
                    OperationOutcome::Uncertain | OperationOutcome::Failed
                )
                || plan.output.is_some()
                || !plan.facts.is_empty()
                || !plan.effect_observations.is_empty()
                || !plan.events.is_empty()
            {
                return Err(OperationError::LifecycleConflict("uncommitted evidence must belong to this exact contract-failure terminal result".into()));
            }
            transaction.execute("INSERT INTO operation_uncommitted_evidence(operation_id,sha256,byte_size) VALUES(?1,?2,?3)",
                params![operation_id.as_str(), evidence.reference.sha256, evidence.reference.byte_size]).map_err(storage)?;
            for (index, bytes) in evidence
                .bytes
                .chunks(OPERATION_EVIDENCE_CHUNK_BYTES)
                .enumerate()
            {
                transaction.execute("INSERT INTO operation_uncommitted_evidence_chunks(operation_id,chunk_index,sha256,bytes) VALUES(?1,?2,?3,?4)",
                    params![operation_id.as_str(), index as i64, rho_operation::evidence_sha256(bytes), bytes]).map_err(storage)?;
            }
        }

        for fact in &plan.facts {
            validate_fact(fact)?;
            if fact.domain != current.operation.domain {
                return Err(OperationError::LifecycleConflict(
                    "handler cannot write another domain's facts".into(),
                ));
            }
            transaction
                .execute(
                    "INSERT INTO domain_facts(
                        domain, schema, fact_key, value_json,
                        source_operation_id, recorded_at_ms
                     ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(domain, schema, fact_key) DO UPDATE SET
                        value_json = excluded.value_json,
                        source_operation_id = excluded.source_operation_id,
                        recorded_at_ms = excluded.recorded_at_ms",
                    params![
                        fact.domain,
                        fact.schema,
                        fact.key,
                        encode(&fact.value)?,
                        operation_id.as_str(),
                        at_ms,
                    ],
                )
                .map_err(storage)?;
        }

        let status = plan.outcome.status();
        transaction
            .execute(
                "UPDATE operations
                 SET status = ?2,
                     outcome = ?3,
                     output_json = ?4,
                     error = ?5,
                     recovery_json = ?6,
                     updated_at_ms = MAX(updated_at_ms, ?7)
                 WHERE operation_id = ?1",
                params![
                    operation_id.as_str(),
                    operation_status(status),
                    operation_outcome(plan.outcome),
                    encode_optional(plan.output.as_ref())?,
                    plan.error,
                    encode_optional(plan.recovery.as_ref())?,
                    at_ms,
                ],
            )
            .map_err(storage)?;

        for observation in &plan.effect_observations {
            append_event_and_outbox(
                &transaction,
                operation_id,
                "effect.observed",
                &serde_json::to_value(observation).map_err(storage)?,
                at_ms,
            )?;
        }
        for event in &plan.events {
            validate_event_kind(&event.kind)?;
            if !event
                .kind
                .starts_with(&format!("{}.", current.operation.domain))
            {
                return Err(OperationError::LifecycleConflict(
                    "handler event must belong to its domain".into(),
                ));
            }
            append_event_and_outbox(
                &transaction,
                operation_id,
                &event.kind,
                &event.payload,
                at_ms,
            )?;
        }
        append_event_and_outbox(
            &transaction,
            operation_id,
            "operation.terminal",
            &json!({
                "status": operation_status(status),
                "outcome": operation_outcome(plan.outcome),
                "error": plan.error,
                "has_recovery": plan.recovery.is_some(),
            }),
            at_ms,
        )?;

        let record = required_operation(&transaction, operation_id)?;
        transaction.commit().map_err(storage)?;
        Ok(record)
    }

    async fn get(
        &self,
        operation_id: &OperationId,
    ) -> Result<Option<OperationRecord>, OperationError> {
        let connection = self.connection()?;
        operation_by_id(&connection, operation_id)
    }

    async fn request_cancellation(
        &self,
        operation_id: &OperationId,
        at_ms: i64,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        let mut connection = self.connection()?;
        let transaction =
            Transaction::new(&mut connection, TransactionBehavior::Immediate).map_err(storage)?;
        let current = required_operation(&transaction, operation_id)?;
        if current.status.is_terminal() {
            transaction.commit().map_err(storage)?;
            return Ok(CancellationRequestOutcome {
                accepted: false,
                operation: current,
            });
        }
        if !current.cancellation_requested {
            transaction
                .execute(
                    "UPDATE operations
                     SET cancellation_requested = 1, updated_at_ms = MAX(updated_at_ms, ?2)
                     WHERE operation_id = ?1",
                    params![operation_id.as_str(), at_ms],
                )
                .map_err(storage)?;
            append_event_and_outbox(
                &transaction,
                operation_id,
                "operation.cancellation_requested",
                &json!({"requested": true}),
                at_ms,
            )?;
        }
        let operation = required_operation(&transaction, operation_id)?;
        transaction.commit().map_err(storage)?;
        Ok(CancellationRequestOutcome {
            accepted: true,
            operation,
        })
    }

    async fn recover_incomplete(&self, at_ms: i64) -> Result<Vec<OperationRecord>, OperationError> {
        let mut connection = self.connection()?;
        let transaction =
            Transaction::new(&mut connection, TransactionBehavior::Immediate).map_err(storage)?;
        let identities = {
            let mut statement = transaction
                .prepare(
                    "SELECT operation_id, status
                     FROM operations
                     WHERE status IN ('accepted', 'running', 'reconciling')
                     ORDER BY accepted_at_ms, operation_id",
                )
                .map_err(storage)?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(storage)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(storage)?
        };

        let mut recovered = Vec::new();
        for (raw_id, previous_status) in identities {
            let operation_id = OperationId::new(raw_id)?;
            let (status, outcome, error, recovery) = if previous_status == "accepted" {
                (
                    OperationStatus::Failed,
                    OperationOutcome::Failed,
                    Some("host restarted before operation execution began".to_string()),
                    Some(json!({
                        "previous_status": previous_status,
                        "action": "safe_to_submit_with_a_new_client_request_id"
                    })),
                )
            } else {
                (
                    OperationStatus::Uncertain,
                    OperationOutcome::Uncertain,
                    Some("host restarted after an external effect may have begun".to_string()),
                    Some(json!({
                        "previous_status": previous_status,
                        "action": "owner_reconciliation_required"
                    })),
                )
            };
            transaction
                .execute(
                    "UPDATE operations
                     SET status = ?2, outcome = ?3, error = ?4,
                         recovery_json = ?5, updated_at_ms = MAX(updated_at_ms, ?6)
                     WHERE operation_id = ?1",
                    params![
                        operation_id.as_str(),
                        operation_status(status),
                        operation_outcome(outcome),
                        error,
                        encode_optional(recovery.as_ref())?,
                        at_ms,
                    ],
                )
                .map_err(storage)?;
            append_event_and_outbox(
                &transaction,
                &operation_id,
                "operation.recovered",
                &json!({
                    "previous_status": previous_status,
                    "status": operation_status(status),
                    "outcome": operation_outcome(outcome),
                }),
                at_ms,
            )?;
            append_event_and_outbox(
                &transaction,
                &operation_id,
                "operation.terminal",
                &json!({"outcome": outcome, "recovered": true}),
                at_ms,
            )?;
            recovered.push(required_operation(&transaction, &operation_id)?);
        }
        transaction.commit().map_err(storage)?;
        Ok(recovered)
    }

    async fn events(
        &self,
        operation_id: &OperationId,
    ) -> Result<Vec<OperationEventRecord>, OperationError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT event_id, operation_id, sequence, kind, payload_json, recorded_at_ms
                 FROM operation_events
                 WHERE operation_id = ?1
                 ORDER BY sequence",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([operation_id.as_str()], raw_event)
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        rows.into_iter().map(decode_event).collect()
    }

    async fn outbox(
        &self,
        scope: Option<&str>,
        caller: &CallerIdentity,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<OutboxRecord>, OperationError> {
        if limit == 0 || limit > MAX_OUTBOX_PAGE {
            return Err(OperationError::Storage(format!(
                "outbox limit must be between 1 and {MAX_OUTBOX_PAGE}"
            )));
        }
        let after = i64::try_from(after_sequence)
            .map_err(|_| OperationError::Storage("outbox cursor exceeds INT64".to_string()))?;
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT o.sequence, o.message_id, o.operation_id, o.topic,
                        o.payload_json, o.created_at_ms, o.delivered_at_ms
                 FROM outbox o JOIN operations op ON op.operation_id = o.operation_id
                 WHERE {OPERATION_VISIBILITY} AND o.sequence > ?4
                 ORDER BY o.sequence
                 LIMIT ?5"
            ))
            .map_err(storage)?;
        let rows = statement
            .query_map(
                params![
                    scope,
                    caller_kind(caller.kind),
                    caller.id,
                    after,
                    limit as i64
                ],
                raw_outbox,
            )
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        rows.into_iter().map(decode_outbox).collect()
    }

    async fn facts_for_operation(
        &self,
        operation_id: &OperationId,
    ) -> Result<Vec<StoredDomainFact>, OperationError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT domain, schema, fact_key, value_json,
                        source_operation_id, recorded_at_ms
                 FROM domain_facts
                 WHERE source_operation_id = ?1
                 ORDER BY domain, schema, fact_key",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([operation_id.as_str()], |row| {
                Ok(RawFact {
                    domain: row.get(0)?,
                    schema: row.get(1)?,
                    key: row.get(2)?,
                    value_json: row.get(3)?,
                    source_operation_id: row.get(4)?,
                    recorded_at_ms: row.get(5)?,
                })
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        rows.into_iter().map(decode_fact).collect()
    }
    async fn successful_outputs(
        &self,
        scope: &str,
        capability: &rho_contract::CapabilityRef,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<OperationOutputPage, OperationError> {
        if !(1..=32).contains(&limit) {
            return Err(OperationError::InvalidInput(
                "output page limit must be 1..=32".into(),
            ));
        }
        capability.validate()?;
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT operation_id, COALESCE(output_json, 'null') FROM operations
            WHERE status = 'succeeded' AND capability_id = ?1 AND capability_version = ?2
            AND json_extract(operation_json, '$.idempotency_scope') = ?3 AND operation_id > ?4
            ORDER BY operation_id LIMIT ?5",
            )
            .map_err(storage)?;
        let mut rows = statement
            .query(params![
                capability.id,
                capability.version,
                scope,
                after_id.unwrap_or(""),
                (limit + 1) as i64
            ])
            .map_err(storage)?;
        let mut selected = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next().map_err(storage)? {
            let id: String = row.get(0).map_err(storage)?;
            let output: String = row.get(1).map_err(storage)?;
            bytes += output.len();
            if bytes > MAX_PLAN_BYTES {
                return Err(OperationError::Storage(
                    "output reference page exceeds 4 MiB".into(),
                ));
            }
            selected.push((id, serde_json::from_str(&output).map_err(storage)?));
        }
        let next_id = (selected.len() > limit).then(|| selected[limit - 1].0.clone());
        Ok(OperationOutputPage {
            outputs: selected
                .into_iter()
                .take(limit)
                .map(|(_, output)| output)
                .collect(),
            next_id,
        })
    }
    async fn read_evidence(
        &self,
        args: &OperationReadEvidenceArguments,
    ) -> Result<OperationEvidencePage, OperationError> {
        if args.limit_bytes == 0
            || args.limit_bytes as usize > OPERATION_EVIDENCE_CHUNK_BYTES
            || args.offset > args.reference.byte_size
        {
            return Err(OperationError::InvalidInput(
                "evidence page exceeds its reference or 64 KiB byte bound".into(),
            ));
        }
        let connection = self.connection()?;
        let header: Option<(String, u64)> = connection
            .query_row(
                "SELECT sha256,byte_size FROM operation_uncommitted_evidence WHERE operation_id=?1",
                [args.reference.operation_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let (digest, size) = header.ok_or_else(|| {
            OperationError::NotFound("original uncommitted evidence is unavailable".into())
        })?;
        if digest != args.reference.sha256 || size != args.reference.byte_size {
            return Err(OperationError::ContentChanged(
                "evidence header does not match its original reference".into(),
            ));
        }
        let end = args
            .offset
            .saturating_add(args.limit_bytes as u64)
            .min(size);
        let mut bytes = Vec::with_capacity((end - args.offset) as usize);
        if end > args.offset {
            let first = args.offset / OPERATION_EVIDENCE_CHUNK_BYTES as u64;
            let last = (end - 1) / OPERATION_EVIDENCE_CHUNK_BYTES as u64;
            let mut statement = connection.prepare("SELECT chunk_index,sha256,bytes FROM operation_uncommitted_evidence_chunks WHERE operation_id=?1 AND chunk_index BETWEEN ?2 AND ?3 ORDER BY chunk_index").map_err(storage)?;
            let rows = statement
                .query_map(
                    params![args.reference.operation_id.as_str(), first, last],
                    |row| {
                        Ok((
                            row.get::<_, u64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Vec<u8>>(2)?,
                        ))
                    },
                )
                .map_err(storage)?;
            let mut expected_index = first;
            for row in rows {
                let (index, digest, chunk) = row.map_err(storage)?;
                let chunk_start = index * OPERATION_EVIDENCE_CHUNK_BYTES as u64;
                let expected_length =
                    (size - chunk_start).min(OPERATION_EVIDENCE_CHUNK_BYTES as u64) as usize;
                if index != expected_index
                    || chunk.len() != expected_length
                    || rho_operation::evidence_sha256(&chunk) != digest
                {
                    return Err(OperationError::ContentChanged(
                        "an original evidence chunk is missing or corrupt".into(),
                    ));
                }
                let from = args.offset.saturating_sub(chunk_start) as usize;
                let to = (end - chunk_start).min(chunk.len() as u64) as usize;
                bytes.extend_from_slice(&chunk[from..to]);
                expected_index += 1;
            }
            if expected_index != last + 1 || bytes.len() != (end - args.offset) as usize {
                return Err(OperationError::ContentChanged(
                    "original evidence has a missing byte range".into(),
                ));
            }
        }
        Ok(OperationEvidencePage {
            reference: args.reference.clone(),
            offset: args.offset,
            bytes,
            next_offset: (end < size).then_some(end),
        })
    }
    async fn get_request(
        &self,
        caller: &CallerIdentity,
        principal: &CallerIdentity,
        project: Option<&str>,
        client_request_id: &str,
    ) -> Result<Option<OperationRecord>, OperationError> {
        let connection = self.connection()?;
        Ok(
            operation_by_idempotency_key(&connection, caller.kind, &caller.id, client_request_id)?
                .filter(|record| {
                    record.operation.principal() == principal
                        && project.is_none_or(|scope| {
                            record.operation.idempotency_scope.as_deref() == Some(scope)
                        })
                }),
        )
    }
}

fn validate_plan(plan: &CommitPlan) -> Result<(), OperationError> {
    let encoded = serde_json::to_vec(&plan.inline_document()).map_err(storage)?;
    if encoded.len() > MAX_PLAN_BYTES {
        return Err(OperationError::Storage(format!(
            "commit plan exceeds {MAX_PLAN_BYTES} bytes"
        )));
    }
    if let Some(evidence) = &plan.uncommitted_evidence {
        if evidence.reference.byte_size > i64::MAX as u64 {
            return Err(OperationError::BudgetExceeded("evidence exceeds SQLite's representable byte-offset limit; no truncated evidence was stored".into()));
        }
        if evidence.reference.byte_size != evidence.bytes.len() as u64
            || evidence.reference.sha256 != rho_operation::evidence_sha256(&evidence.bytes)
        {
            return Err(OperationError::LifecycleConflict(
                "uncommitted evidence bytes do not match their original reference".into(),
            ));
        }
    }
    if plan.outcome == OperationOutcome::Succeeded && plan.error.is_some() {
        return Err(OperationError::LifecycleConflict(
            "successful commit plan cannot contain an error".to_string(),
        ));
    }
    if plan.outcome == OperationOutcome::Uncertain && plan.recovery.is_none() {
        return Err(OperationError::LifecycleConflict(
            "uncertain commit plan requires recovery material".to_string(),
        ));
    }
    Ok(())
}

fn validate_fact(fact: &rho_operation::DomainFactMutation) -> Result<(), OperationError> {
    for (label, value) in [
        ("domain", fact.domain.as_str()),
        ("schema", fact.schema.as_str()),
        ("fact key", fact.key.as_str()),
    ] {
        if value.is_empty()
            || value.len() > 512
            || value.trim() != value
            || value.chars().any(char::is_control)
        {
            return Err(OperationError::Storage(format!(
                "{label} is empty, oversized, or malformed"
            )));
        }
    }
    Ok(())
}

fn validate_event_kind(kind: &str) -> Result<(), OperationError> {
    if kind.is_empty()
        || kind.len() > 160
        || kind.trim() != kind
        || kind.chars().any(char::is_control)
    {
        return Err(OperationError::Storage(
            "operation event kind is malformed".to_string(),
        ));
    }
    Ok(())
}

fn append_event_and_outbox(
    transaction: &Transaction<'_>,
    operation_id: &OperationId,
    kind: &str,
    payload: &Value,
    at_ms: i64,
) -> Result<(), OperationError> {
    validate_event_kind(kind)?;
    let next_sequence: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence) + 1, 0)
             FROM operation_events
             WHERE operation_id = ?1",
            [operation_id.as_str()],
            |row| row.get(0),
        )
        .map_err(storage)?;
    let event_id = format!("{}:event:{next_sequence}", operation_id.as_str());
    let payload_json = encode(payload)?;
    transaction
        .execute(
            "INSERT INTO operation_events(
                event_id, operation_id, sequence, kind, payload_json, recorded_at_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event_id,
                operation_id.as_str(),
                next_sequence,
                kind,
                payload_json,
                at_ms,
            ],
        )
        .map_err(storage)?;
    transaction
        .execute(
            "INSERT INTO outbox(
                message_id, operation_id, topic, payload_json, created_at_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![
                format!("{event_id}:outbox"),
                operation_id.as_str(),
                kind,
                payload_json,
                at_ms,
            ],
        )
        .map_err(storage)?;
    Ok(())
}

fn operation_by_id(
    connection: &Connection,
    operation_id: &OperationId,
) -> Result<Option<OperationRecord>, OperationError> {
    let raw = connection
        .query_row(
            "SELECT operation_json, status, outcome, output_json, error,
                    recovery_json, cancellation_requested, updated_at_ms
             FROM operations
             WHERE operation_id = ?1",
            [operation_id.as_str()],
            raw_operation,
        )
        .optional()
        .map_err(storage)?;
    raw.map(decode_operation).transpose()
}

fn operation_by_idempotency_key(
    connection: &Connection,
    kind: CallerKind,
    caller_id: &str,
    client_request_id: &str,
) -> Result<Option<OperationRecord>, OperationError> {
    let raw = connection
        .query_row(
            "SELECT operation_json, status, outcome, output_json, error,
                    recovery_json, cancellation_requested, updated_at_ms
             FROM operations
             WHERE caller_kind = ?1 AND caller_id = ?2 AND client_request_id = ?3",
            params![caller_kind(kind), caller_id, client_request_id],
            raw_operation,
        )
        .optional()
        .map_err(storage)?;
    raw.map(decode_operation).transpose()
}

fn required_operation(
    connection: &Connection,
    operation_id: &OperationId,
) -> Result<OperationRecord, OperationError> {
    operation_by_id(connection, operation_id)?
        .ok_or_else(|| OperationError::NotFound(operation_id.as_str().to_string()))
}

struct RawOperation {
    operation_json: String,
    status: String,
    outcome: Option<String>,
    output_json: Option<String>,
    error: Option<String>,
    recovery_json: Option<String>,
    cancellation_requested: bool,
    updated_at_ms: i64,
}

fn raw_operation(row: &Row<'_>) -> rusqlite::Result<RawOperation> {
    Ok(RawOperation {
        operation_json: row.get(0)?,
        status: row.get(1)?,
        outcome: row.get(2)?,
        output_json: row.get(3)?,
        error: row.get(4)?,
        recovery_json: row.get(5)?,
        cancellation_requested: row.get(6)?,
        updated_at_ms: row.get(7)?,
    })
}

fn decode_operation(raw: RawOperation) -> Result<OperationRecord, OperationError> {
    Ok(OperationRecord {
        next_reads: None,
        diagnostics: None,
        operation: serde_json::from_str(&raw.operation_json).map_err(storage)?,
        status: parse_operation_status(&raw.status)?,
        outcome: raw
            .outcome
            .as_deref()
            .map(parse_operation_outcome)
            .transpose()?,
        output: raw
            .output_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(storage)?,
        error: raw.error,
        recovery: raw
            .recovery_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(storage)?,
        cancellation_requested: raw.cancellation_requested,
        updated_at_ms: raw.updated_at_ms,
    })
}

struct RawEvent {
    event_id: String,
    operation_id: String,
    sequence: i64,
    kind: String,
    payload_json: String,
    recorded_at_ms: i64,
}

fn raw_event(row: &Row<'_>) -> rusqlite::Result<RawEvent> {
    Ok(RawEvent {
        event_id: row.get(0)?,
        operation_id: row.get(1)?,
        sequence: row.get(2)?,
        kind: row.get(3)?,
        payload_json: row.get(4)?,
        recorded_at_ms: row.get(5)?,
    })
}

fn decode_event(raw: RawEvent) -> Result<OperationEventRecord, OperationError> {
    Ok(OperationEventRecord {
        event_id: raw.event_id,
        operation_id: OperationId::new(raw.operation_id)?,
        sequence: u64::try_from(raw.sequence)
            .map_err(|_| OperationError::Storage("negative event sequence".to_string()))?,
        kind: raw.kind,
        payload: serde_json::from_str(&raw.payload_json).map_err(storage)?,
        recorded_at_ms: raw.recorded_at_ms,
    })
}

struct RawOutbox {
    sequence: i64,
    message_id: String,
    operation_id: String,
    topic: String,
    payload_json: String,
    created_at_ms: i64,
    delivered_at_ms: Option<i64>,
}

fn raw_outbox(row: &Row<'_>) -> rusqlite::Result<RawOutbox> {
    Ok(RawOutbox {
        sequence: row.get(0)?,
        message_id: row.get(1)?,
        operation_id: row.get(2)?,
        topic: row.get(3)?,
        payload_json: row.get(4)?,
        created_at_ms: row.get(5)?,
        delivered_at_ms: row.get(6)?,
    })
}

fn decode_outbox(raw: RawOutbox) -> Result<OutboxRecord, OperationError> {
    Ok(OutboxRecord {
        sequence: u64::try_from(raw.sequence)
            .map_err(|_| OperationError::Storage("negative outbox sequence".to_string()))?,
        message_id: raw.message_id,
        operation_id: OperationId::new(raw.operation_id)?,
        topic: raw.topic,
        payload: serde_json::from_str(&raw.payload_json).map_err(storage)?,
        created_at_ms: raw.created_at_ms,
        delivered_at_ms: raw.delivered_at_ms,
    })
}

struct RawFact {
    domain: String,
    schema: String,
    key: String,
    value_json: String,
    source_operation_id: String,
    recorded_at_ms: i64,
}

fn decode_fact(raw: RawFact) -> Result<StoredDomainFact, OperationError> {
    Ok(StoredDomainFact {
        domain: raw.domain,
        schema: raw.schema,
        key: raw.key,
        value: serde_json::from_str(&raw.value_json).map_err(storage)?,
        source_operation_id: OperationId::new(raw.source_operation_id)?,
        recorded_at_ms: raw.recorded_at_ms,
    })
}

fn encode(value: &impl serde::Serialize) -> Result<String, OperationError> {
    serde_json::to_string(value).map_err(storage)
}

fn encode_optional(value: Option<&Value>) -> Result<Option<String>, OperationError> {
    value.map(encode).transpose()
}

fn caller_kind(value: CallerKind) -> &'static str {
    match value {
        CallerKind::Human => "human",
        CallerKind::Agent => "agent",
        CallerKind::System => "system",
        CallerKind::Plugin => "plugin",
    }
}

fn operation_status(value: OperationStatus) -> &'static str {
    match value {
        OperationStatus::Accepted => "accepted",
        OperationStatus::Running => "running",
        OperationStatus::Reconciling => "reconciling",
        OperationStatus::Succeeded => "succeeded",
        OperationStatus::Failed => "failed",
        OperationStatus::Cancelled => "cancelled",
        OperationStatus::Uncertain => "uncertain",
    }
}

fn parse_operation_status(value: &str) -> Result<OperationStatus, OperationError> {
    match value {
        "accepted" => Ok(OperationStatus::Accepted),
        "running" => Ok(OperationStatus::Running),
        "reconciling" => Ok(OperationStatus::Reconciling),
        "succeeded" => Ok(OperationStatus::Succeeded),
        "failed" => Ok(OperationStatus::Failed),
        "cancelled" => Ok(OperationStatus::Cancelled),
        "uncertain" => Ok(OperationStatus::Uncertain),
        _ => Err(OperationError::Storage(format!(
            "database contains unknown operation status {value}"
        ))),
    }
}

fn operation_outcome(value: OperationOutcome) -> &'static str {
    match value {
        OperationOutcome::Succeeded => "succeeded",
        OperationOutcome::Failed => "failed",
        OperationOutcome::Cancelled => "cancelled",
        OperationOutcome::Uncertain => "uncertain",
    }
}

fn parse_operation_outcome(value: &str) -> Result<OperationOutcome, OperationError> {
    match value {
        "succeeded" => Ok(OperationOutcome::Succeeded),
        "failed" => Ok(OperationOutcome::Failed),
        "cancelled" => Ok(OperationOutcome::Cancelled),
        "uncertain" => Ok(OperationOutcome::Uncertain),
        _ => Err(OperationError::Storage(format!(
            "database contains unknown operation outcome {value}"
        ))),
    }
}

fn storage(error: impl std::fmt::Display) -> OperationError {
    OperationError::Storage(error.to_string())
}

fn check_schema(connection: &Connection) -> Result<(), OperationError> {
    let app: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(storage)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(storage)?;
    if app != APPLICATION_ID || version != SCHEMA_VERSION {
        return Err(OperationError::Storage(
            "database is not a supported Rho Next journal; existing data was not changed".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod evidence_tests {
    use super::*;
    use rho_contract::*;
    use rho_operation::{
        CapabilityRegistry, DomainFactMutation, HandlerError, OperationEvidenceHandler,
        OperationGateway, OperationGetHandler, OperationHandler, PlannedEvent, QueryGateway,
        SystemClock, UuidOperationIdGenerator,
    };
    use std::{
        collections::BTreeSet,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    struct FaultOwner {
        descriptor: CapabilityDescriptor,
        output: Value,
        executed: AtomicUsize,
    }
    impl FaultOwner {
        fn new() -> Self {
            let documentation = rho_contract::builtin_documentation("host.overview");
            Self {
                descriptor: CapabilityDescriptor {
                    kind: CapabilityKind::Operation,
                    capability: CapabilityRef::new("fixture.native", 1).unwrap(),
                    domain: "fixture".into(),
                    input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
                    output_schema: json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}),
                    recovery_schema: json!({"type":"object","properties":{"native_marker":{"type":"string"}},"required":["native_marker"],"additionalProperties":false}),
                    documentation,
                    required_scopes: BTreeSet::from(["fixture.run".into()]),
                    potential_effects: BTreeSet::from([EffectHint::MayMutateRuntime]),
                    idempotency: IdempotencyClass::CallerScoped,
                    retry: RetryClass::Never,
                    cancellation: CancellationClass::Unsupported,
                },
                output: json!({"native_result":"字".repeat(MAX_OPERATION_COMMIT_BYTES / 3 + 31),"$ref":"data, never a capability"}),
                executed: AtomicUsize::new(0),
            }
        }
    }
    #[async_trait]
    impl OperationHandler for FaultOwner {
        fn descriptor(&self) -> &CapabilityDescriptor {
            &self.descriptor
        }
        fn idempotency_scope(&self) -> Option<String> {
            Some("/evidence-project".into())
        }
        fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
            Ok(arguments.clone())
        }
        fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
            Ok(TargetRef {
                kind: "workspace".into(),
                identity: "native-fixture".into(),
            })
        }
        async fn execute(&self, _: &Operation) -> Result<CommitPlan, HandlerError> {
            self.executed.fetch_add(1, Ordering::SeqCst);
            let mut plan = CommitPlan::succeeded(self.output.clone());
            plan.recovery = Some(json!({"native_marker":"original-stage-marker"}));
            plan.facts.push(DomainFactMutation {
                domain: "fixture".into(),
                schema: "fixture.uncommitted".into(),
                key: "candidate".into(),
                value: json!({"value":37}),
            });
            plan.events.push(PlannedEvent {
                kind: "fixture.uncommitted-event".into(),
                payload: json!({"original":true}),
            });
            plan.effect_observations
                .push(rho_contract::EffectObservation {
                    kind: "native".into(),
                    source: "fixture".into(),
                    detail: json!({"native_id":42}),
                    observed_at_ms: 1,
                    completeness: ObservationCompleteness::Partial,
                });
            Ok(plan)
        }
    }
    fn context() -> CallContext {
        CallContext {
            caller: CallerIdentity {
                kind: CallerKind::Agent,
                id: "external-agent".into(),
            },
            principal: Some(CallerIdentity {
                kind: CallerKind::Human,
                id: "local-account".into(),
            }),
            scopes: BTreeSet::from(["operation.read".into(), "fixture.run".into()]),
            connection_id: "fixture-connection".into(),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        }
    }
    fn request() -> Invocation {
        Invocation {
            client_request_id: "original-request".into(),
            capability: CapabilityRef::new("fixture.native", 1).unwrap(),
            arguments: json!({}),
            preconditions: vec![],
        }
    }
    fn fixture(
        journal: Arc<SqliteOperationJournal>,
    ) -> (OperationGateway, QueryGateway, Arc<FaultOwner>) {
        let owner = Arc::new(FaultOwner::new());
        let mut registry = CapabilityRegistry::new();
        registry.register(owner.clone()).unwrap();
        registry
            .register_query(Arc::new(OperationEvidenceHandler::new(
                journal.clone(),
                Some("/evidence-project".into()),
            )))
            .unwrap();
        registry
            .register_query(Arc::new(
                OperationGetHandler::new(
                    journal.clone(),
                    Some("/evidence-project".into()),
                    &registry.descriptors(),
                )
                .unwrap(),
            ))
            .unwrap();
        registry.validate_links().unwrap();
        let registry = Arc::new(registry);
        (
            OperationGateway::new(
                registry.clone(),
                journal,
                Arc::new(SystemClock),
                Arc::new(UuidOperationIdGenerator),
            )
            .with_project_scope(Some("/evidence-project".into())),
            QueryGateway::new(registry),
            owner,
        )
    }
    fn read(reference: &OperationEvidenceReference, offset: u64) -> QueryRequest {
        QueryRequest {
            capability: CapabilityRef::new("operation.read_evidence", 1).unwrap(),
            arguments: json!({"reference":reference,"offset":offset,"limit_bytes":65536}),
        }
    }
    #[tokio::test]
    async fn oversized_fault_is_atomic_paged_exact_evidence_without_domain_facts_or_replay() {
        let temporary = tempfile::tempdir().unwrap();
        let journal = Arc::new(
            SqliteOperationJournal::open(temporary.path().join("journal.sqlite")).unwrap(),
        );
        let (gateway, queries, owner) = fixture(journal.clone());
        let record = gateway.invoke(&context(), request()).await.unwrap();
        assert_eq!(record.status, OperationStatus::Uncertain);
        assert!(record.output.is_none());
        let fault: ContractFailureRecovery =
            serde_json::from_value(record.recovery.clone().unwrap()).unwrap();
        let UncommittedCandidate::Evidence { reference } = fault.candidate else {
            panic!("large original candidate was not retained as evidence")
        };
        assert!(reference.byte_size > MAX_OPERATION_COMMIT_BYTES as u64);
        assert!(serde_json::to_vec(&record).unwrap().len() < 65536);
        let mut original = vec![];
        let mut offset = 0;
        loop {
            let snapshot = queries
                .query(&context(), read(&reference, offset))
                .await
                .unwrap();
            let page: OperationEvidencePage =
                serde_json::from_value(snapshot.data.unwrap()).unwrap();
            assert_eq!(page.offset, offset);
            assert!(page.bytes.len() <= OPERATION_EVIDENCE_CHUNK_BYTES);
            original.extend_from_slice(&page.bytes);
            if let Some(next) = page.next_offset {
                assert!(next > offset);
                assert_eq!(snapshot.next_reads[0].arguments["offset"], json!(next));
                offset = next;
            } else {
                break;
            }
        }
        assert_eq!(original.len() as u64, reference.byte_size);
        assert_eq!(rho_operation::evidence_sha256(&original), reference.sha256);
        let candidate: UncommittedOwnerResult = serde_json::from_slice(&original).unwrap();
        assert_eq!(candidate.output, Some(owner.output.clone()));
        assert_eq!(
            candidate.recovery,
            Some(json!({"native_marker":"original-stage-marker"}))
        );
        assert_eq!(candidate.facts[0].value, json!({"value":37}));
        assert_eq!(candidate.events[0].payload, json!({"original":true}));
        assert_eq!(
            candidate.effect_observations[0].detail,
            json!({"native_id":42})
        );
        assert_eq!(serde_json::to_vec(&candidate).unwrap(), original);
        assert!(
            journal
                .facts_for_operation(&record.operation.operation_id)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            journal
                .events(&record.operation.operation_id)
                .await
                .unwrap()
                .iter()
                .all(|e| e.kind != "fixture.uncommitted-event")
        );
        let repeated = gateway.invoke(&context(), request()).await.unwrap();
        assert_eq!(
            repeated.operation.operation_id,
            record.operation.operation_id
        );
        assert_eq!(owner.executed.load(Ordering::SeqCst), 1);
        let get = queries
            .query(
                &context(),
                QueryRequest {
                    capability: CapabilityRef::new("operation.get", 1).unwrap(),
                    arguments: json!({"operation_id":record.operation.operation_id}),
                },
            )
            .await
            .unwrap();
        let inspected: OperationGetResult = serde_json::from_value(get.data.unwrap()).unwrap();
        assert!(
            inspected
                .record
                .unwrap()
                .next_reads
                .unwrap()
                .iter()
                .any(|r| r.capability.id == "operation.read_evidence")
        );
        let mut other = context();
        other.principal.as_mut().unwrap().id = "another-account".into();
        assert!(matches!(
            queries.query(&other, read(&reference, 0)).await,
            Err(OperationError::NotFound(_))
        ));
        let mut wrong_project = CapabilityRegistry::new();
        wrong_project
            .register_query(Arc::new(OperationEvidenceHandler::new(
                journal.clone(),
                Some("/other-project".into()),
            )))
            .unwrap();
        assert!(matches!(
            QueryGateway::new(Arc::new(wrong_project))
                .query(&context(), read(&reference, 0))
                .await,
            Err(OperationError::NotFound(_))
        ));
        journal.connection().unwrap().execute("UPDATE operation_uncommitted_evidence_chunks SET bytes=zeroblob(length(bytes)) WHERE operation_id=?1 AND chunk_index=1", [record.operation.operation_id.as_str()]).unwrap();
        assert!(matches!(
            queries
                .query(
                    &context(),
                    read(&reference, OPERATION_EVIDENCE_CHUNK_BYTES as u64)
                )
                .await,
            Err(OperationError::ContentChanged(_))
        ));
    }
    #[tokio::test]
    async fn forced_terminal_write_failure_rolls_back_evidence_and_never_claims_persistence() {
        let journal = Arc::new(SqliteOperationJournal::open_in_memory().unwrap());
        let (gateway, _, owner) = fixture(journal.clone());
        journal.connection().unwrap().execute_batch("CREATE TRIGGER fail_contract_terminal BEFORE UPDATE OF status ON operations WHEN NEW.status='uncertain' BEGIN SELECT RAISE(ABORT,'injected terminal write failure'); END;").unwrap();
        let error = gateway.invoke(&context(), request()).await.unwrap_err();
        let OperationError::CommitPending {
            operation_id,
            detail,
        } = error
        else {
            panic!("storage failure must remain explicitly uncommitted")
        };
        assert!(detail.contains("injected terminal write failure"));
        let record = journal.get(&operation_id).await.unwrap().unwrap();
        assert_eq!(record.status, OperationStatus::Running);
        assert!(record.recovery.is_none());
        {
            let connection = journal.connection().unwrap();
            for table in [
                "operation_uncommitted_evidence",
                "operation_uncommitted_evidence_chunks",
                "domain_facts",
            ] {
                let count: u64 = connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(count, 0);
            }
        }
        let repeated = gateway.invoke(&context(), request()).await.unwrap();
        assert_eq!(repeated.status, OperationStatus::Running);
        assert_eq!(owner.executed.load(Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use rho_contract::{CallerIdentity, CapabilityRef, EffectHint, Operation, TargetRef};
    use rho_operation::DomainFactMutation;

    use super::*;

    fn operation(id: &str, request: &str, digest: &str) -> Operation {
        Operation {
            principal: None,
            operation_id: OperationId::new(id).unwrap(),
            client_request_id: request.to_string(),
            caller: CallerIdentity {
                kind: CallerKind::Human,
                id: "caller_test".to_string(),
            },
            capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
            domain: "workspace".to_string(),
            target: TargetRef {
                kind: "workspace".to_string(),
                identity: "session-test".to_string(),
            },
            normalized_arguments: json!({"code": "1 + 1"}),
            invocation_digest: digest.to_string(),
            idempotency_scope: None,
            preconditions: Vec::new(),
            potential_effects: BTreeSet::from([EffectHint::MayMutateRuntime]),
            correlation_id: id.to_string(),
            causation_id: None,
            trace_parent: None,
            accepted_at_ms: 1,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn event_visibility_is_identical_for_checkpoints_and_pages_before_the_limit() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        let principal = operation("unused", "unused", "unused").caller;
        assert_eq!(
            journal
                .events_checkpoint("/project", &principal)
                .await
                .unwrap()
                .sequence,
            0
        );
        // Invisible rows occupy more than a whole client page, including another
        // project, another principal and the same principal ID with a different kind.
        for index in 0..105 {
            let id = format!("hidden-{index}");
            let mut op = operation(&id, &id, &id);
            op.idempotency_scope = Some("/project".into());
            match index % 3 {
                0 => op.idempotency_scope = Some("/other".into()),
                1 => {
                    op.principal = Some(CallerIdentity {
                        kind: CallerKind::Human,
                        id: "other-person".into(),
                    })
                }
                _ => {
                    op.principal = Some(CallerIdentity {
                        kind: CallerKind::Agent,
                        id: principal.id.clone(),
                    })
                }
            }
            journal.admit(&op).await.unwrap();
        }
        assert_eq!(
            journal
                .events_checkpoint("/project", &principal)
                .await
                .unwrap()
                .sequence,
            0
        );
        let mut own = operation("own", "own", "own");
        own.idempotency_scope = Some("/project".into());
        journal.admit(&own).await.unwrap();
        let checkpoint = journal
            .events_checkpoint("/project", &principal)
            .await
            .unwrap();

        let mut delegated = operation("delegated", "delegated", "delegated");
        delegated.idempotency_scope = Some("/project".into());
        delegated.caller = CallerIdentity {
            kind: CallerKind::Agent,
            id: "mcp-connection".into(),
        };
        delegated.principal = Some(principal.clone());
        journal.admit(&delegated).await.unwrap();
        let mut final_hidden = operation("final-hidden", "final-hidden", "final-hidden");
        final_hidden.idempotency_scope = Some("/other".into());
        journal.admit(&final_hidden).await.unwrap();

        let changes: u64 = journal
            .connection()
            .unwrap()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap();
        let first = journal
            .outbox(Some("/project"), &principal, 0, 1)
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].operation_id, own.operation_id);
        assert_eq!(first[0].sequence, checkpoint.sequence);
        let second = journal
            .outbox(Some("/project"), &principal, checkpoint.sequence, 1)
            .await
            .unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].operation_id, delegated.operation_id);
        assert_eq!(
            journal
                .events_checkpoint("/project", &principal)
                .await
                .unwrap()
                .sequence,
            second[0].sequence
        );
        assert!(
            journal
                .outbox(Some("/project"), &principal, second[0].sequence, 100)
                .await
                .unwrap()
                .is_empty()
        );
        let after: u64 = journal
            .connection()
            .unwrap()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            changes, after,
            "event observation must not write or recover work"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_only_checkpoint_and_exact_summary_do_not_recover_an_accepted_operation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("journal.sqlite");
        let writer = SqliteOperationJournal::open(&path).unwrap();
        let mut op = operation("accepted", "accepted", "accepted");
        op.idempotency_scope = Some("/project".into());
        writer.admit(&op).await.unwrap();
        let reader = SqliteOperationJournal::open_read_only(&path).unwrap();
        let checkpoint = reader
            .events_checkpoint("/project", &op.caller)
            .await
            .unwrap();
        assert_eq!(checkpoint.sequence, 1);
        let page = reader
            .list_recent(
                "/project",
                &op.caller,
                &rho_contract::RecentOperationsArguments {
                    operation_id: Some(op.operation_id.clone()),
                    client_request_id: None,
                    before_cursor: None,
                    limit: 30,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.operations.len(), 1);
        assert_eq!(page.operations[0].status, OperationStatus::Accepted);
        assert_eq!(page.operations[0].cursor, 1);
        assert_eq!(
            writer.get(&op.operation_id).await.unwrap().unwrap().status,
            OperationStatus::Accepted
        );
        assert_eq!(
            writer
                .events_checkpoint("/project", &op.caller)
                .await
                .unwrap(),
            checkpoint
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn successful_output_pages_preserve_scope_and_cursor_without_writes() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        let cap = CapabilityRef::new("environment.plan", 1).unwrap();
        for (id, scope, success) in [
            ("op_1", "/project", true),
            ("op_2", "/project", true),
            ("op_3", "/other", true),
            ("op_4", "/project", false),
        ] {
            let mut op = operation(id, id, id);
            op.capability = cap.clone();
            op.domain = "environment".into();
            op.idempotency_scope = Some(scope.into());
            journal.admit(&op).await.unwrap();
            journal.mark_running(&op.operation_id, 2).await.unwrap();
            let mut plan = CommitPlan::succeeded(json!({"source":id}));
            if !success {
                plan.outcome = OperationOutcome::Failed;
            }
            journal.commit(&op.operation_id, &plan, 3).await.unwrap();
        }
        let caller = operation("unused", "unused", "unused").caller;
        let history = journal.outbox(None, &caller, 0, 100).await.unwrap();
        let first = journal
            .successful_outputs("/project", &cap, None, 1)
            .await
            .unwrap();
        assert_eq!(first.outputs, vec![json!({"source":"op_1"})]);
        assert_eq!(first.next_id.as_deref(), Some("op_1"));
        let second = journal
            .successful_outputs("/project", &cap, first.next_id.as_deref(), 1)
            .await
            .unwrap();
        assert_eq!(second.outputs, vec![json!({"source":"op_2"})]);
        assert!(second.next_id.is_none());
        assert!(
            journal
                .successful_outputs("/project", &cap, None, 33)
                .await
                .is_err()
        );
        assert_eq!(
            journal.outbox(None, &caller, 0, 100).await.unwrap(),
            history
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn caller_scoped_idempotency_returns_original_operation() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        let first = operation("op_first", "request_one", "sha256:one");
        assert!(matches!(
            journal.admit(&first).await.unwrap(),
            Admission::New(_)
        ));
        let retry = operation("op_retry", "request_one", "sha256:one");
        let Admission::Existing(existing) = journal.admit(&retry).await.unwrap() else {
            panic!("retry should return the original operation");
        };
        assert_eq!(existing.operation.operation_id, first.operation_id);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reused_idempotency_key_with_other_input_is_rejected() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        journal
            .admit(&operation("op_first", "request_one", "sha256:one"))
            .await
            .unwrap();
        let error = journal
            .admit(&operation("op_retry", "request_one", "sha256:two"))
            .await
            .unwrap_err();
        assert_eq!(error, OperationError::IdempotencyConflict);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn terminal_commit_is_atomic_and_immutable() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        let operation = operation("op_commit", "request_commit", "sha256:commit");
        journal.admit(&operation).await.unwrap();
        journal
            .mark_running(&operation.operation_id, 2)
            .await
            .unwrap();
        let mut plan = CommitPlan::succeeded(json!({"answer": 2}));
        plan.facts.push(DomainFactMutation {
            domain: "workspace".to_string(),
            schema: "rho.workspace.execution.v1".to_string(),
            key: operation.operation_id.as_str().to_string(),
            value: json!({"answer": 2}),
        });
        let record = journal
            .commit(&operation.operation_id, &plan, 3)
            .await
            .unwrap();
        assert_eq!(record.status, OperationStatus::Succeeded);
        assert_eq!(
            journal
                .facts_for_operation(&operation.operation_id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            journal
                .commit(&operation.operation_id, &plan, 4)
                .await
                .is_err()
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_request_does_not_claim_the_operation_stopped() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        let operation = operation("op_cancel", "request_cancel", "sha256:cancel");
        journal.admit(&operation).await.unwrap();
        journal
            .mark_running(&operation.operation_id, 2)
            .await
            .unwrap();
        let outcome = journal
            .request_cancellation(&operation.operation_id, 3)
            .await
            .unwrap();
        assert!(outcome.accepted);
        assert!(outcome.operation.cancellation_requested);
        assert_eq!(outcome.operation.status, OperationStatus::Running);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn recovery_distinguishes_not_started_from_possible_effect() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        let accepted = operation("op_accepted", "request_accepted", "sha256:accepted");
        let running = operation("op_running", "request_running", "sha256:running");
        journal.admit(&accepted).await.unwrap();
        journal.admit(&running).await.unwrap();
        journal
            .mark_running(&running.operation_id, 2)
            .await
            .unwrap();
        let recovered = journal.recover_incomplete(3).await.unwrap();
        assert_eq!(recovered.len(), 2);
        assert_eq!(
            journal
                .get(&accepted.operation_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            OperationStatus::Failed
        );
        assert_eq!(
            journal
                .get(&running.operation_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            OperationStatus::Uncertain
        );
    }

    #[tokio::test]
    async fn outbox_failure_rolls_back_terminal_status_fact_and_events() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        let operation = operation("op_fault", "request_fault", "sha256:fault");
        journal.admit(&operation).await.unwrap();
        journal
            .mark_running(&operation.operation_id, 2)
            .await
            .unwrap();
        let events_before = journal.events(&operation.operation_id).await.unwrap();
        let messages_before = journal
            .outbox(None, &operation.caller, 0, 100)
            .await
            .unwrap();
        journal
            .connection()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail_terminal_outbox BEFORE INSERT ON outbox
             WHEN NEW.topic = 'operation.terminal'
             BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;",
            )
            .unwrap();
        let mut plan = CommitPlan::succeeded(json!(2));
        plan.facts.push(DomainFactMutation {
            domain: "workspace".into(),
            schema: "execution.v1".into(),
            key: "output".into(),
            value: json!(2),
        });
        assert!(
            journal
                .commit(&operation.operation_id, &plan, 3)
                .await
                .is_err()
        );
        assert_eq!(
            journal
                .get(&operation.operation_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            OperationStatus::Running
        );
        assert!(
            journal
                .facts_for_operation(&operation.operation_id)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            journal.events(&operation.operation_id).await.unwrap(),
            events_before
        );
        assert_eq!(
            journal
                .outbox(None, &operation.caller, 0, 100)
                .await
                .unwrap(),
            messages_before
        );
        journal
            .connection()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_terminal_outbox")
            .unwrap();
        assert_eq!(
            journal
                .commit(&operation.operation_id, &plan, 4)
                .await
                .unwrap()
                .status,
            OperationStatus::Succeeded
        );
    }

    #[tokio::test]
    async fn same_name_in_different_caller_namespaces_is_not_the_same_identity() {
        let journal = SqliteOperationJournal::open_in_memory().unwrap();
        let human = operation("op_human", "same", "sha256:same");
        let mut agent = operation("op_agent", "same", "sha256:same");
        agent.caller.kind = CallerKind::Agent;
        journal.admit(&human).await.unwrap();
        assert!(matches!(
            journal.admit(&agent).await.unwrap(),
            Admission::New(_)
        ));
    }
}
