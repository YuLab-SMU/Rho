use super::*;
use rho_contract::OperationCommitReference;
use rho_operation::{CommitReceipt, UncommittedEvidence, commit_reference, evidence_sha256};
use std::sync::Arc;

pub(super) const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS operation_commit_candidates (
        operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(operation_id),
        sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        plan_json TEXT CHECK(plan_json IS NULL OR json_valid(plan_json)),
        evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
        staged_at_ms INTEGER NOT NULL, committed_at_ms INTEGER,
        CHECK ((committed_at_ms IS NULL AND plan_json IS NOT NULL)
            OR (committed_at_ms IS NOT NULL AND plan_json IS NULL AND evidence_json IS NULL))
    );
    CREATE TABLE IF NOT EXISTS operation_commit_candidate_chunks (
        operation_id TEXT NOT NULL REFERENCES operation_commit_candidates(operation_id),
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0), sha256 TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes) <= 65536),
        PRIMARY KEY(operation_id, chunk_index)
    );
";

pub(super) fn receipt(
    connection: &Connection,
    id: &OperationId,
) -> Result<Option<CommitReceipt>, OperationError> {
    connection.query_row("SELECT sha256,byte_size,committed_at_ms IS NOT NULL FROM operation_commit_candidates WHERE operation_id=?1", [id.as_str()], |row| {
        Ok(CommitReceipt { reference: OperationCommitReference { operation_id: id.clone(), sha256: row.get(0)?, byte_size: row.get(1)? }, committed: row.get(2)? })
    }).optional().map_err(storage)
}

pub(super) fn validate(current: &OperationRecord, plan: &CommitPlan) -> Result<(), OperationError> {
    validate_plan(plan)?;
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
            "operation cannot stage or commit from {:?}",
            current.status
        )));
    }
    if let Some(evidence) = &plan.uncommitted_evidence {
        let fault: ContractFailureRecovery =
            serde_json::from_value(plan.recovery.clone().unwrap_or_default()).map_err(storage)?;
        if evidence.reference.operation_id != current.operation.operation_id
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
            return Err(OperationError::LifecycleConflict(
                "candidate evidence does not belong to this exact contract-failure result".into(),
            ));
        }
    }
    for fact in &plan.facts {
        validate_fact(fact)?;
        if fact.domain != current.operation.domain {
            return Err(OperationError::LifecycleConflict(
                "candidate contains another domain's facts".into(),
            ));
        }
    }
    for event in &plan.events {
        validate_event_kind(&event.kind)?;
        if !event
            .kind
            .starts_with(&format!("{}.", current.operation.domain))
        {
            return Err(OperationError::LifecycleConflict(
                "candidate contains another domain's events".into(),
            ));
        }
    }
    Ok(())
}

pub(super) fn stage(
    journal: &SqliteOperationJournal,
    id: &OperationId,
    plan: &CommitPlan,
    at_ms: i64,
) -> Result<CommitReceipt, OperationError> {
    validate_plan(plan)?;
    let reference = commit_reference(id, plan)?;
    let mut connection = journal.connection()?;
    let tx = Transaction::new(&mut connection, TransactionBehavior::Immediate).map_err(storage)?;
    let current = required_operation(&tx, id)?;
    if let Some(existing) = receipt(&tx, id)? {
        if existing.reference != reference {
            return Err(OperationError::ContentChanged(
                "the original commit candidate cannot be replaced".into(),
            ));
        }
        return Ok(existing);
    }
    validate(&current, plan)?;
    tx.execute("INSERT INTO operation_commit_candidates(operation_id,sha256,byte_size,plan_json,evidence_json,staged_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
        params![id.as_str(), reference.sha256, reference.byte_size, encode(&plan.inline_document())?,
            plan.uncommitted_evidence.as_ref().map(|e| encode(&e.reference)).transpose()?, at_ms]).map_err(storage)?;
    if let Some(evidence) = &plan.uncommitted_evidence {
        for (index, bytes) in evidence
            .bytes
            .chunks(OPERATION_EVIDENCE_CHUNK_BYTES)
            .enumerate()
        {
            tx.execute("INSERT INTO operation_commit_candidate_chunks(operation_id,chunk_index,sha256,bytes) VALUES(?1,?2,?3,?4)",
                params![id.as_str(), index as i64, evidence_sha256(bytes), bytes]).map_err(storage)?;
        }
    }
    tx.commit().map_err(storage)?;
    Ok(CommitReceipt {
        reference,
        committed: false,
    })
}

pub(super) fn read(
    journal: &SqliteOperationJournal,
    reference: &OperationCommitReference,
) -> Result<CommitPlan, OperationError> {
    let connection = journal.connection()?;
    let stored = receipt(&connection, &reference.operation_id)?
        .ok_or_else(|| OperationError::NotFound("commit candidate".into()))?;
    if stored.reference != *reference {
        return Err(OperationError::ContentChanged(
            "commit candidate reference does not match".into(),
        ));
    }
    if stored.committed {
        return Err(OperationError::Unavailable(
            "candidate is already committed; read the original terminal record".into(),
        ));
    }
    let (plan, evidence): (String, Option<String>) = connection
        .query_row(
            "SELECT plan_json,evidence_json FROM operation_commit_candidates WHERE operation_id=?1",
            [reference.operation_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage)?;
    if plan.len() > MAX_PLAN_BYTES {
        return Err(OperationError::ContentChanged(
            "stored candidate exceeds the inline plan bound".into(),
        ));
    }
    let mut plan: CommitPlan = serde_json::from_str(&plan).map_err(storage)?;
    if let Some(evidence) = evidence {
        let evidence_reference: rho_contract::OperationEvidenceReference =
            serde_json::from_str(&evidence).map_err(storage)?;
        if evidence_reference.operation_id != reference.operation_id {
            return Err(OperationError::ContentChanged(
                "pending evidence belongs to another operation".into(),
            ));
        }
        let reference = evidence_reference;
        let mut statement = connection.prepare("SELECT chunk_index,sha256,bytes FROM operation_commit_candidate_chunks WHERE operation_id=?1 ORDER BY chunk_index").map_err(storage)?;
        let mut rows = statement
            .query([reference.operation_id.as_str()])
            .map_err(storage)?;
        let mut bytes = Vec::new();
        let mut index = 0_i64;
        while let Some(row) = rows.next().map_err(storage)? {
            let chunk_index: i64 = row.get(0).map_err(storage)?;
            let hash: String = row.get(1).map_err(storage)?;
            let chunk: Vec<u8> = row.get(2).map_err(storage)?;
            if chunk_index != index
                || evidence_sha256(&chunk) != hash
                || bytes.len() as u64 + chunk.len() as u64 > reference.byte_size
            {
                return Err(OperationError::ContentChanged(
                    "pending evidence chunk failed its identity or size check".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
            index += 1;
        }
        if bytes.len() as u64 != reference.byte_size || evidence_sha256(&bytes) != reference.sha256
        {
            return Err(OperationError::ContentChanged(
                "pending evidence is incomplete or changed".into(),
            ));
        }
        plan.uncommitted_evidence = Some(UncommittedEvidence {
            reference,
            bytes: Arc::from(bytes),
        });
    }
    validate_plan(&plan)?;
    if commit_reference(&reference.operation_id, &plan)? != *reference {
        return Err(OperationError::ContentChanged(
            "stored commit candidate failed its digest check".into(),
        ));
    }
    Ok(plan)
}

pub(super) fn committed(
    tx: &Transaction<'_>,
    reference: &OperationCommitReference,
    at_ms: i64,
) -> Result<(), OperationError> {
    tx.execute("INSERT INTO operation_commit_candidates(operation_id,sha256,byte_size,staged_at_ms,committed_at_ms) VALUES(?1,?2,?3,?4,?4)
        ON CONFLICT(operation_id) DO UPDATE SET plan_json=NULL,evidence_json=NULL,committed_at_ms=excluded.committed_at_ms",
        params![reference.operation_id.as_str(),reference.sha256,reference.byte_size,at_ms]).map_err(storage)?;
    tx.execute(
        "DELETE FROM operation_commit_candidate_chunks WHERE operation_id=?1",
        [reference.operation_id.as_str()],
    )
    .map_err(storage)?;
    Ok(())
}
