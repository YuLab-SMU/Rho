//! One core-owned path from an executed result to its terminal journal record.
//! Retrying this path never acquires an owner or executes scientific work.
use crate::{Clock, CommitPlan, ExecutionLease, OperationError, OperationJournal};
use rho_contract::*;
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

const MAX_RETAINED_EXECUTIONS: usize = 128;

#[derive(Debug, Clone)]
pub struct CommitReceipt {
    pub reference: OperationCommitReference,
    pub committed: bool,
}

pub fn commit_reference(
    id: &OperationId,
    plan: &CommitPlan,
) -> Result<OperationCommitReference, OperationError> {
    let bytes = serde_json::to_vec(&json!({
        "operation_id": id,
        "plan": plan.inline_document(),
        "evidence": plan.uncommitted_evidence.as_ref().map(|e| &e.reference),
    }))
    .map_err(|e| OperationError::Contract(e.to_string()))?;
    Ok(OperationCommitReference {
        operation_id: id.clone(),
        sha256: crate::evidence_sha256(&bytes),
        byte_size: bytes.len() as u64,
    })
}

struct Retained {
    plan: Option<Arc<CommitPlan>>,
    lease: Option<Box<dyn ExecutionLease>>,
}
type RetainedMap = Arc<Mutex<BTreeMap<OperationId, Retained>>>;
pub(crate) struct CommitSlot {
    id: OperationId,
    retained: RetainedMap,
}
impl Drop for CommitSlot {
    fn drop(&mut self) {
        let mut retained = self.retained.lock().unwrap_or_else(|e| e.into_inner());
        if retained
            .get(&self.id)
            .is_some_and(|entry| entry.plan.is_none())
        {
            retained.remove(&self.id);
        }
    }
}

pub struct CommitRecovery {
    journal: Arc<dyn OperationJournal>,
    clock: Arc<dyn Clock>,
    retained: RetainedMap,
}
impl CommitRecovery {
    pub fn new(journal: Arc<dyn OperationJournal>, clock: Arc<dyn Clock>) -> Self {
        Self {
            journal,
            clock,
            retained: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
    pub fn has_retained_results(&self) -> bool {
        self.retained
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|entry| entry.plan.is_some())
    }
    // Reserve before admission and native effects. A storage failure cannot force
    // eviction of another original result or let an unbounded pending queue grow.
    pub(crate) fn reserve(&self, id: &OperationId) -> Result<CommitSlot, OperationError> {
        let mut retained = self.retained.lock().unwrap_or_else(|e| e.into_inner());
        if retained.len() >= MAX_RETAINED_EXECUTIONS {
            return Err(OperationError::BudgetExceeded("128 executions or uncommitted results are retained; inspect and reconcile original operations before submitting more work".into()));
        }
        if retained.contains_key(id) {
            return Err(OperationError::LifecycleConflict(
                "operation identity is already reserved".into(),
            ));
        }
        retained.insert(
            id.clone(),
            Retained {
                plan: None,
                lease: None,
            },
        );
        Ok(CommitSlot {
            id: id.clone(),
            retained: self.retained.clone(),
        })
    }
    pub(crate) async fn submit(
        &self,
        id: &OperationId,
        plan: CommitPlan,
        lease: Option<Box<dyn ExecutionLease>>,
    ) -> Result<OperationRecord, OperationError> {
        let reference = commit_reference(id, &plan)?;
        let plan = Arc::new(plan);
        {
            let mut retained = self.retained.lock().unwrap_or_else(|e| e.into_inner());
            let entry = retained.get_mut(id).ok_or_else(|| {
                OperationError::LifecycleConflict(
                    "commit result has no reserved retention slot".into(),
                )
            })?;
            if entry.plan.is_some() {
                return Err(OperationError::LifecycleConflict(
                    "an executed result cannot be replaced".into(),
                ));
            }
            entry.plan = Some(plan.clone());
            entry.lease = lease;
        }
        self.finish(&reference, &plan).await
    }
    async fn finish(
        &self,
        reference: &OperationCommitReference,
        plan: &CommitPlan,
    ) -> Result<OperationRecord, OperationError> {
        let result = async {
            let receipt = self
                .journal
                .stage_commit(&reference.operation_id, plan, self.clock.now_ms()?)
                .await?;
            if receipt.reference != *reference {
                return Err(OperationError::ContentChanged(
                    "staged commit identity differs from the retained result".into(),
                ));
            }
            self.journal
                .commit(&reference.operation_id, plan, self.clock.now_ms()?)
                .await
        }
        .await
        .map_err(|error| OperationError::CommitPending {
            operation_id: reference.operation_id.clone(),
            detail: error.to_string(),
        });
        if result.is_ok() {
            self.complete(&reference.operation_id, &result).await;
        }
        result
    }
    async fn complete(&self, id: &OperationId, result: &Result<OperationRecord, OperationError>) {
        let entry = self
            .retained
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        if let Some(mut lease) = entry.and_then(|e| e.lease) {
            lease.completed(result).await;
        }
    }
    pub async fn status(
        &self,
        context: &CallContext,
        project: Option<&str>,
        id: &OperationId,
    ) -> Result<Option<OperationCommitStatus>, OperationError> {
        crate::require_read_scope(context)?;
        let Some(mut record) =
            crate::record::visible_record(self.journal.as_ref(), context, id, project).await?
        else {
            return Ok(None);
        };
        let receipt = self.journal.commit_receipt(id).await?;
        let (phase, reference) = if let Some(receipt) = receipt {
            if receipt.committed && !record.status.is_terminal() {
                record = self
                    .journal
                    .get(id)
                    .await?
                    .ok_or_else(|| OperationError::NotFound(id.as_str().into()))?;
            }
            (
                if receipt.committed {
                    OperationCommitPhase::Committed
                } else {
                    OperationCommitPhase::Durable
                },
                Some(receipt.reference),
            )
        } else if let Some(plan) = self
            .retained
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .and_then(|e| e.plan.clone())
        {
            (
                OperationCommitPhase::Volatile,
                Some(commit_reference(id, &plan)?),
            )
        } else {
            (
                if record.status.is_terminal() {
                    OperationCommitPhase::Unavailable
                } else {
                    OperationCommitPhase::AwaitingResult
                },
                None,
            )
        };
        Ok(Some(OperationCommitStatus {
            operation_id: id.clone(),
            operation_status: record.status,
            phase,
            reference,
        }))
    }
    pub async fn reconcile(
        &self,
        context: &CallContext,
        project: Option<&str>,
        args: &ReconcileOperationCommit,
    ) -> Result<OperationRecord, OperationError> {
        let reference = &args.reference;
        OperationId::new(reference.operation_id.as_str())?;
        if reference.sha256.len() != 71
            || !reference.sha256.starts_with("sha256:")
            || !reference.sha256[7..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(OperationError::InvalidInput(
                "commit digest must be sha256: followed by a lowercase SHA-256".into(),
            ));
        }
        let record = crate::record::visible_record(
            self.journal.as_ref(),
            context,
            &reference.operation_id,
            project,
        )
        .await?
        .ok_or_else(|| OperationError::NotFound(reference.operation_id.as_str().into()))?;
        let admission = record.operation.admission.as_ref().ok_or_else(|| {
            OperationError::Unavailable(
                "original operation has no captured authority for commit reconciliation".into(),
            )
        })?;
        let missing = admission
            .descriptor
            .required_scopes
            .difference(&context.scopes)
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(OperationError::AccessDenied {
                capability: record.operation.capability.display_key(),
                missing,
            });
        }
        if let Some(receipt) = self.journal.commit_receipt(&reference.operation_id).await? {
            if receipt.reference != *reference {
                return Err(OperationError::ContentChanged(
                    "commit reference does not identify the original retained result".into(),
                ));
            }
            if receipt.committed {
                let record = self
                    .journal
                    .get(&reference.operation_id)
                    .await?
                    .ok_or_else(|| {
                        OperationError::NotFound(reference.operation_id.as_str().into())
                    })?;
                if !record.status.is_terminal() {
                    return Err(OperationError::Storage(
                        "committed receipt has no terminal operation".into(),
                    ));
                }
                let result = Ok(record);
                self.complete(&reference.operation_id, &result).await;
                return result;
            }
        }
        let retained = self
            .retained
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&reference.operation_id)
            .and_then(|e| e.plan.clone());
        let plan = match retained {
            Some(plan) => plan,
            None => match self.journal.read_commit_candidate(reference).await {
                Ok(plan) => Arc::new(plan),
                Err(error) => {
                    // Another recovery request may have committed between the
                    // receipt read and candidate load. Resolve by exact receipt.
                    if self
                        .journal
                        .commit_receipt(&reference.operation_id)
                        .await?
                        .is_some_and(|receipt| receipt.committed && receipt.reference == *reference)
                    {
                        let record = self
                            .journal
                            .get(&reference.operation_id)
                            .await?
                            .filter(|record| record.status.is_terminal())
                            .ok_or_else(|| {
                                OperationError::Storage(
                                    "commit receipt has no terminal record".into(),
                                )
                            })?;
                        let result = Ok(record);
                        self.complete(&reference.operation_id, &result).await;
                        return result;
                    }
                    return Err(error);
                }
            },
        };
        if commit_reference(&reference.operation_id, &plan)? != *reference {
            return Err(OperationError::ContentChanged(
                "commit candidate failed its identity check".into(),
            ));
        }
        self.finish(reference, &plan).await
    }
}

/// Observers and live Hosts use the same journal reader. The weak live binding
/// adds volatile-result visibility without making registry/gateway ownership cyclic.
pub struct OperationCommitStatusHandler {
    fallback: CommitRecovery,
    live: std::sync::OnceLock<std::sync::Weak<CommitRecovery>>,
    project: Option<String>,
    descriptor: CapabilityDescriptor,
}
impl OperationCommitStatusHandler {
    pub fn new(journal: Arc<dyn OperationJournal>, project: Option<String>) -> Self {
        Self {
            fallback: CommitRecovery::new(journal, Arc::new(crate::SystemClock)),
            live: std::sync::OnceLock::new(), project,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query, capability: CapabilityRef::new("operation.commit_status", 1).unwrap(), domain: "operation".into(),
                input_schema: schemars::schema_for!(OperationGetArguments).to_value(),
                output_schema: schemars::schema_for!(Option<OperationCommitStatus>).to_value(),
                recovery_schema: json!({"type":"null"}),
                required_scopes: std::collections::BTreeSet::from(["operation.read".into()]),
                potential_effects: Default::default(), idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe, cancellation: CancellationClass::Unsupported,
                documentation: CapabilityDocumentation {
                    summary: "Inspect an original operation's commit recovery".into(),
                    purpose: "Distinguish awaiting-result, volatile, durable and committed candidate state using the original journal and exact OperationId.".into(),
                    when_to_use: vec!["An executed operation reported CommitPending, or a commit acknowledgement was lost.".into()],
                    limitations: vec!["Volatile results are retained only by the current Host. Durable means the candidate was stored, not that its scientific facts were committed. An observer cannot see another process's volatile result.".into(), "Read-only: never starts a runtime, replays execution, stages a result or completes a commit. Unavailable means a terminal record has no candidate receipt; it is not permission to replay.".into()],
                    owner: "operation".into(), effects: "Read-only observation of the original journal and live retained results.".into(),
                    retry_rule: "Repeat this read. Use the exact returned reference with operation.reconcile_commit when the original operation's authority is still available.".into(),
                    cancellation_rule: "Stopping this read has no effect on the original operation.".into(),
                    preconditions: vec![], examples: vec![CapabilityExample { arguments: json!({"operation_id":"operation-example"}), result_explanation: "A visible operation reports phase and optional digest-bound reference. An absent or invisible operation returns null.".into() }],
                    related_capabilities: vec![CapabilityRef::new("operation.get",1).unwrap()], related_skills: vec![],
                    position_units: vec!["Reference byte_size is the encoded candidate identity document's UTF-8 byte count. Its evidence reference binds separately stored raw bytes.".into()],
                },
            },
        }
    }
    pub fn bind(&self, recovery: &Arc<CommitRecovery>) {
        self.live
            .set(Arc::downgrade(recovery))
            .expect("commit status binds once");
    }
}
#[async_trait::async_trait]
impl crate::QueryHandler for OperationCommitStatusHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(
        &self,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, OperationError> {
        let args: OperationGetArguments = serde_json::from_value(value.clone())
            .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
        OperationId::new(args.operation_id.as_str())?;
        Ok(json!(args))
    }
    async fn query(&self, _: &serde_json::Value) -> Result<QuerySnapshot, OperationError> {
        Err(OperationError::InvalidInput(
            "caller context is required".into(),
        ))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        value: &serde_json::Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let args: OperationGetArguments = serde_json::from_value(value.clone())
            .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
        let live = self.live.get().and_then(std::sync::Weak::upgrade);
        let recovery = live.as_deref().unwrap_or(&self.fallback);
        let status = recovery
            .status(context, self.project.as_deref(), &args.operation_id)
            .await?;
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "operation".into(),
                identity: args.operation_id.as_str().into(),
            },
            source: "operation-journal/commit-candidate".into(),
            observed_at_ms: crate::SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: ObservationCompleteness::Complete,
            notices: vec![],
            diagnostics: vec![],
            next_reads: vec![NextRead::query(
                "operation.get",
                "Read the original authoritative operation",
                json!(args),
            )],
            data: Some(json!(status)),
        })
    }
}
