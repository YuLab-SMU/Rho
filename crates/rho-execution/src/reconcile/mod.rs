use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{ExecutionId, OperationId, OperationOutcome, RetryClass};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::local::ProcessIdentity;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum DurableExecutionStage {
    IntentRecorded,
    SpawnAcknowledged,
    HandleRecorded,
    RunningObserved,
    TerminalObserved,
    OutputsCollected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DurableExecutionTruth {
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub retry_class: RetryClass,
    pub stage: DurableExecutionStage,
    pub process_identity: Option<ProcessIdentity>,
    pub terminal_outcome: Option<OperationOutcome>,
    pub terminal_event_id: Option<String>,
    pub collected_artifact_ids: BTreeSet<String>,
    pub reconcile_attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableMutationOutcome {
    Advanced,
    Duplicate,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ExecutionTruthError {
    #[error("execution {0} is unknown")]
    Unknown(ExecutionId),
    #[error("execution stage transition is illegal")]
    IllegalTransition,
    #[error("terminal truth conflicts with an existing terminal event")]
    TerminalConflict,
}

#[derive(Debug, Default, Clone)]
pub struct ExecutionTruthStore {
    records: BTreeMap<ExecutionId, DurableExecutionTruth>,
    terminal_event_ids: BTreeSet<String>,
}

impl ExecutionTruthStore {
    pub fn record_intent(
        &mut self,
        execution_id: ExecutionId,
        operation_id: OperationId,
        retry_class: RetryClass,
    ) -> DurableMutationOutcome {
        if self.records.contains_key(&execution_id) {
            return DurableMutationOutcome::Duplicate;
        }
        self.records.insert(
            execution_id.clone(),
            DurableExecutionTruth {
                execution_id,
                operation_id,
                retry_class,
                stage: DurableExecutionStage::IntentRecorded,
                process_identity: None,
                terminal_outcome: None,
                terminal_event_id: None,
                collected_artifact_ids: BTreeSet::new(),
                reconcile_attempts: 0,
            },
        );
        DurableMutationOutcome::Advanced
    }

    pub fn record_spawn_ack(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<DurableMutationOutcome, ExecutionTruthError> {
        self.advance_stage(execution_id, DurableExecutionStage::SpawnAcknowledged)
    }

    pub fn record_handle(
        &mut self,
        execution_id: &ExecutionId,
        identity: ProcessIdentity,
    ) -> Result<DurableMutationOutcome, ExecutionTruthError> {
        let record = self
            .records
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionTruthError::Unknown(execution_id.clone()))?;
        if let Some(existing) = &record.process_identity {
            return if existing == &identity {
                Ok(DurableMutationOutcome::Duplicate)
            } else {
                Err(ExecutionTruthError::IllegalTransition)
            };
        }
        if record.stage < DurableExecutionStage::SpawnAcknowledged
            || record.stage >= DurableExecutionStage::TerminalObserved
        {
            return Err(ExecutionTruthError::IllegalTransition);
        }
        record.process_identity = Some(identity);
        record.stage = DurableExecutionStage::HandleRecorded;
        Ok(DurableMutationOutcome::Advanced)
    }

    pub fn record_running(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<DurableMutationOutcome, ExecutionTruthError> {
        self.advance_stage(execution_id, DurableExecutionStage::RunningObserved)
    }

    pub fn record_terminal(
        &mut self,
        execution_id: &ExecutionId,
        terminal_event_id: impl Into<String>,
        outcome: OperationOutcome,
    ) -> Result<DurableMutationOutcome, ExecutionTruthError> {
        let event_id = terminal_event_id.into();
        let record = self
            .records
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionTruthError::Unknown(execution_id.clone()))?;
        if let Some(existing) = &record.terminal_event_id {
            return if existing == &event_id && record.terminal_outcome == Some(outcome) {
                Ok(DurableMutationOutcome::Duplicate)
            } else {
                Err(ExecutionTruthError::TerminalConflict)
            };
        }
        if self.terminal_event_ids.contains(&event_id) {
            return Err(ExecutionTruthError::TerminalConflict);
        }
        self.terminal_event_ids.insert(event_id.clone());
        record.stage = DurableExecutionStage::TerminalObserved;
        record.terminal_event_id = Some(event_id);
        record.terminal_outcome = Some(outcome);
        Ok(DurableMutationOutcome::Advanced)
    }

    pub fn record_artifact(
        &mut self,
        execution_id: &ExecutionId,
        artifact_id: impl Into<String>,
    ) -> Result<DurableMutationOutcome, ExecutionTruthError> {
        let record = self
            .records
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionTruthError::Unknown(execution_id.clone()))?;
        if record.stage < DurableExecutionStage::TerminalObserved {
            return Err(ExecutionTruthError::IllegalTransition);
        }
        let inserted = record.collected_artifact_ids.insert(artifact_id.into());
        if inserted {
            record.stage = DurableExecutionStage::OutputsCollected;
            Ok(DurableMutationOutcome::Advanced)
        } else {
            Ok(DurableMutationOutcome::Duplicate)
        }
    }

    pub fn record(&self, execution_id: &ExecutionId) -> Option<&DurableExecutionTruth> {
        self.records.get(execution_id)
    }

    pub fn record_mut(&mut self, execution_id: &ExecutionId) -> Option<&mut DurableExecutionTruth> {
        self.records.get_mut(execution_id)
    }

    pub fn records(&self) -> impl Iterator<Item = &DurableExecutionTruth> {
        self.records.values()
    }

    fn advance_stage(
        &mut self,
        execution_id: &ExecutionId,
        next: DurableExecutionStage,
    ) -> Result<DurableMutationOutcome, ExecutionTruthError> {
        let record = self
            .records
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionTruthError::Unknown(execution_id.clone()))?;
        if record.stage == next {
            return Ok(DurableMutationOutcome::Duplicate);
        }
        if next <= record.stage || next as u8 > record.stage as u8 + 1 {
            return Err(ExecutionTruthError::IllegalTransition);
        }
        record.stage = next;
        Ok(DurableMutationOutcome::Advanced)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessProbeObservation {
    ExactRunning,
    ExactExitedSuccess,
    ExactExitedFailure,
    Missing,
    IdentityMismatch,
    ProbeUnavailable,
}

pub trait ReconcileProcessProbe {
    fn observe(&mut self, identity: &ProcessIdentity) -> ProcessProbeObservation;
    fn cancel_exact(&mut self, identity: &ProcessIdentity) -> bool;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReconcileState {
    NeverSubmitted,
    SubmittedUnknown,
    Running,
    Terminal(OperationOutcome),
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReconcileReport {
    pub execution_id: ExecutionId,
    pub state: ReconcileState,
    pub reason_code: String,
    pub attempt: u32,
    pub next_backoff_ms: Option<u64>,
    pub safe_next_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReconcilePolicy {
    pub max_attempts: u32,
    pub base_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

impl Default for ReconcilePolicy {
    fn default() -> Self {
        Self {
            max_attempts: 8,
            base_backoff_ms: 100,
            max_backoff_ms: 10_000,
        }
    }
}

pub fn reconcile_execution(
    store: &mut ExecutionTruthStore,
    execution_id: &ExecutionId,
    probe: &mut impl ReconcileProcessProbe,
    policy: &ReconcilePolicy,
) -> Result<ReconcileReport, ExecutionTruthError> {
    let record = store
        .record_mut(execution_id)
        .ok_or_else(|| ExecutionTruthError::Unknown(execution_id.clone()))?;
    record.reconcile_attempts = record.reconcile_attempts.saturating_add(1);
    let attempt = record.reconcile_attempts;
    if let Some(outcome) = record.terminal_outcome {
        return Ok(report(
            execution_id,
            ReconcileState::Terminal(outcome),
            "durable_terminal",
            attempt,
            None,
            "inspect committed outputs",
        ));
    }
    let Some(identity) = record.process_identity.as_ref() else {
        return Ok(if record.stage == DurableExecutionStage::IntentRecorded {
            report(
                execution_id,
                ReconcileState::NeverSubmitted,
                "intent_without_spawn_ack",
                attempt,
                None,
                "safe to submit according to retry class",
            )
        } else {
            report(
                execution_id,
                ReconcileState::SubmittedUnknown,
                "spawn_ack_without_identity",
                attempt,
                backoff(attempt, policy),
                "do not replay non-idempotent execution; continue reconciliation",
            )
        });
    };
    let observation = probe.observe(identity);
    let (state, reason, next, action) = match observation {
        ProcessProbeObservation::ExactRunning => (
            ReconcileState::Running,
            "exact_process_running",
            backoff(attempt, policy),
            "continue bounded reconciliation",
        ),
        ProcessProbeObservation::ExactExitedSuccess => (
            ReconcileState::Terminal(OperationOutcome::Succeeded),
            "exact_process_exit_success",
            None,
            "record one terminal event then collect outputs",
        ),
        ProcessProbeObservation::ExactExitedFailure => (
            ReconcileState::Terminal(OperationOutcome::Failed),
            "exact_process_exit_failure",
            None,
            "record one terminal event and inspect diagnostics",
        ),
        ProcessProbeObservation::Missing => (
            ReconcileState::Uncertain,
            "process_missing_is_not_failure",
            backoff(attempt, policy),
            "preserve uncertain and inspect executor evidence",
        ),
        ProcessProbeObservation::IdentityMismatch => (
            ReconcileState::Uncertain,
            "pid_reused_identity_mismatch",
            None,
            "do not signal unrelated process; resolve manually",
        ),
        ProcessProbeObservation::ProbeUnavailable => (
            ReconcileState::Uncertain,
            "process_probe_unavailable",
            backoff(attempt, policy),
            "preserve uncertain until bounded retry expires",
        ),
    };
    Ok(report(execution_id, state, reason, attempt, next, action))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReconcileCancelOutcome {
    CancelledConfirmed,
    AlreadyTerminal,
    IdentityMismatchUncertain,
    SignalUnconfirmed,
}

pub fn cancel_reconciled_execution(
    store: &ExecutionTruthStore,
    execution_id: &ExecutionId,
    probe: &mut impl ReconcileProcessProbe,
) -> Result<ReconcileCancelOutcome, ExecutionTruthError> {
    let record = store
        .record(execution_id)
        .ok_or_else(|| ExecutionTruthError::Unknown(execution_id.clone()))?;
    if record.terminal_outcome.is_some() {
        return Ok(ReconcileCancelOutcome::AlreadyTerminal);
    }
    let Some(identity) = &record.process_identity else {
        return Ok(ReconcileCancelOutcome::SignalUnconfirmed);
    };
    if probe.observe(identity) == ProcessProbeObservation::IdentityMismatch {
        return Ok(ReconcileCancelOutcome::IdentityMismatchUncertain);
    }
    if probe.cancel_exact(identity) {
        Ok(ReconcileCancelOutcome::CancelledConfirmed)
    } else {
        Ok(ReconcileCancelOutcome::SignalUnconfirmed)
    }
}

fn report(
    execution_id: &ExecutionId,
    state: ReconcileState,
    reason_code: &str,
    attempt: u32,
    next_backoff_ms: Option<u64>,
    safe_next_action: &str,
) -> ReconcileReport {
    ReconcileReport {
        execution_id: execution_id.clone(),
        state,
        reason_code: reason_code.to_string(),
        attempt,
        next_backoff_ms,
        safe_next_action: safe_next_action.to_string(),
    }
}

fn backoff(attempt: u32, policy: &ReconcilePolicy) -> Option<u64> {
    if attempt >= policy.max_attempts {
        return None;
    }
    let multiplier = 1_u64
        .checked_shl(attempt.saturating_sub(1))
        .unwrap_or(u64::MAX);
    Some(
        policy
            .base_backoff_ms
            .saturating_mul(multiplier)
            .min(policy.max_backoff_ms),
    )
}

pub fn reconcile_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "durable_submit_truth",
            "exact_process_identity",
            "bounded_reconcile",
            "unique_terminal",
        ],
        &[
            "missing_means_failed",
            "pid_only_cancel",
            "automatic_unknown_replay",
            "duplicate_terminal_event",
        ],
    )
}
