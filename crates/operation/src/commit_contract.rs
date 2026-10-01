use crate::{CommitPlan, OperationError, RegistrySnapshot, UncommittedEvidence, evidence_sha256};
use rho_contract::*;
use serde_json::Value;

impl RegistrySnapshot {
    /// Validation happens before journal commit. An owner contract fault after
    /// execution preserves the entire candidate as recovery and commits no facts.
    pub(crate) fn checked_plan(
        &self,
        operation: &Operation,
        mut plan: CommitPlan,
        execution_started: bool,
    ) -> Result<CommitPlan, OperationError> {
        let schemas = self
            .schemas
            .get(&operation.capability)
            .ok_or_else(|| OperationError::UnknownCapability(operation.capability.display_key()))?;
        let original_recovery = plan.recovery.clone();
        if plan.outcome == OperationOutcome::Uncertain && plan.recovery.is_none() {
            plan.recovery = Some(
                serde_json::to_value(ObserveOwnerRecovery::default())
                    .map_err(|e| OperationError::Contract(e.to_string()))?,
            );
        }
        let mut violations = vec![];
        let mut violation = |field: &str, error: String| {
            violations.push(OwnerContractViolation {
                field: field.into(),
                message: error.chars().take(4096).collect(),
            })
        };
        if let Some(output) = &plan.output {
            if let Err(error) = schemas.output(output) {
                violation("output", error.to_string());
            }
        } else if plan.outcome == OperationOutcome::Succeeded {
            violation("output", "A successful operation requires an explicit output matching its registered schema.".into());
        }
        if let Err(error) = schemas.recovery(plan.recovery.as_ref().unwrap_or(&Value::Null)) {
            violation("recovery", error.to_string());
        }
        if plan.outcome == OperationOutcome::Succeeded && plan.error.is_some() {
            violation(
                "error",
                "A successful operation cannot contain an execution error.".into(),
            );
        }
        for fact in &plan.facts {
            if fact.domain != operation.domain
                || [&fact.domain, &fact.schema, &fact.key].iter().any(|s| {
                    s.is_empty()
                        || s.len() > 512
                        || s.trim() != s.as_str()
                        || s.chars().any(char::is_control)
                })
            {
                violation(
                    "facts",
                    "A fact has invalid identity fields or belongs to another scientific owner."
                        .into(),
                );
                break;
            }
        }
        for event in &plan.events {
            if event.kind.is_empty()
                || event.kind.len() > 160
                || event.kind.trim() != event.kind
                || event.kind.chars().any(char::is_control)
                || !event.kind.starts_with(&format!("{}.", operation.domain))
            {
                violation(
                    "events",
                    "An event has invalid identity or belongs to another owner.".into(),
                );
                break;
            }
        }
        let inline_bytes = serde_json::to_vec(&plan.inline_document())
            .map_err(|e| OperationError::Contract(e.to_string()))?
            .len();
        if inline_bytes > MAX_OPERATION_COMMIT_BYTES {
            violation(
                "result_budget",
                format!(
                    "The owner candidate contains {inline_bytes} encoded UTF-8 bytes and exceeds the {MAX_OPERATION_COMMIT_BYTES}-byte inline journal limit."
                ),
            );
        }
        if violations.is_empty() {
            return Ok(plan);
        }
        let candidate = UncommittedOwnerResult {
            outcome: plan.outcome,
            output: plan.output,
            error: plan.error,
            recovery: original_recovery,
            facts: plan
                .facts
                .into_iter()
                .map(|f| UncommittedFact {
                    domain: f.domain,
                    schema: f.schema,
                    key: f.key,
                    value: f.value,
                })
                .collect(),
            effect_observations: plan
                .effect_observations
                .into_iter()
                .map(|e| UncommittedEffectObservation {
                    kind: e.kind,
                    source: e.source,
                    detail: e.detail,
                    observed_at_ms: e.observed_at_ms,
                    completeness: e.completeness,
                })
                .collect(),
            events: plan
                .events
                .into_iter()
                .map(|e| UncommittedEvent {
                    kind: e.kind,
                    payload: e.payload,
                })
                .collect(),
        };
        let encoded =
            serde_json::to_vec(&candidate).map_err(|e| OperationError::Contract(e.to_string()))?;
        let (candidate, uncommitted_evidence) =
            if encoded.len() > MAX_INLINE_CONTRACT_CANDIDATE_BYTES {
                let reference = OperationEvidenceReference {
                    operation_id: operation.operation_id.clone(),
                    kind: OperationEvidenceKind::UncommittedOwnerResult,
                    sha256: evidence_sha256(&encoded),
                    byte_size: encoded.len() as u64,
                };
                (
                    UncommittedCandidate::Evidence {
                        reference: reference.clone(),
                    },
                    Some(UncommittedEvidence {
                        reference,
                        bytes: encoded.into(),
                    }),
                )
            } else {
                (UncommittedCandidate::Inline { result: candidate }, None)
            };
        let recovery = ContractFailureRecovery {
            kind: ContractFailureKind::OwnerContractViolation,
            capability: operation.capability.clone(),
            automatic_reexecution: false,
            execution_started,
            violations,
            candidate,
        };
        let recovery =
            serde_json::to_value(recovery).map_err(|e| OperationError::Contract(e.to_string()))?;
        schemas.recovery(&recovery)?;
        Ok(CommitPlan { outcome: if execution_started { OperationOutcome::Uncertain } else { OperationOutcome::Failed }, output: None,
            error: Some("The owner result violated its registered contract. Original uncommitted material is retained in recovery; no candidate domain facts or events were committed.".into()),
            recovery: Some(recovery), facts: vec![], effect_observations: vec![], events: vec![], uncommitted_evidence })
    }
}
