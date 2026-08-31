use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{ArtifactDigest, ExecutionId, OperationId, OperationOutcome, RetryClass};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteStage {
    IntentRecorded,
    SubmittedUnknown,
    Queued,
    Running,
    Terminal,
    ArtifactsCommitted,
    Uncertain,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteExecutionRecord {
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub retry_class: RetryClass,
    pub stage: RemoteStage,
    pub runner_job_id: Option<String>,
    pub scheduler_job_id: Option<String>,
    pub terminal_outcome: Option<OperationOutcome>,
    pub terminal_event_id: Option<String>,
    pub artifact_digests: BTreeSet<ArtifactDigest>,
    pub reconcile_attempts: u32,
    pub submit_dispatched: bool,
    pub cancel_request_ids: BTreeSet<String>,
    pub collect_request_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunnerRemoteTruth {
    pub operation_found: bool,
    pub runner_job_id: Option<String>,
    pub scheduler_job_id: Option<String>,
    pub state: RemoteStage,
    pub terminal_outcome: Option<OperationOutcome>,
    pub terminal_event_id: Option<String>,
    pub artifact_manifest_digests: BTreeSet<ArtifactDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchedulerRemoteTruth {
    pub scheduler_job_id: String,
    pub state: RemoteStage,
    pub terminal_outcome: Option<OperationOutcome>,
    pub accounting_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteArtifactTruth {
    pub complete: bool,
    pub digests: BTreeSet<ArtifactDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSubmitAck {
    pub runner_job_id: String,
    pub scheduler_job_id: Option<String>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RemotePortError {
    #[error("remote connection unavailable")]
    Disconnected,
    #[error("remote submit acknowledgement lost")]
    AckLost,
    #[error("remote service rejected request")]
    Rejected,
}

pub trait RunnerRemotePort {
    fn submit_once(
        &mut self,
        operation_id: &OperationId,
    ) -> Result<RemoteSubmitAck, RemotePortError>;
    fn query_operation(
        &mut self,
        operation_id: &OperationId,
    ) -> Result<RunnerRemoteTruth, RemotePortError>;
    fn cancel_once(&mut self, runner_job_id: &str, request_id: &str)
    -> Result<(), RemotePortError>;
    fn collect_once(
        &mut self,
        runner_job_id: &str,
        request_id: &str,
    ) -> Result<(), RemotePortError>;
}

pub trait SchedulerRemotePort {
    fn query_scheduler(
        &mut self,
        scheduler_job_id: &str,
    ) -> Result<Option<SchedulerRemoteTruth>, RemotePortError>;
}

pub trait RemoteArtifactPort {
    fn query_artifacts(
        &mut self,
        runner_job_id: &str,
    ) -> Result<RemoteArtifactTruth, RemotePortError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteReconcilePolicy {
    pub max_attempts: u32,
    pub base_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

impl Default for RemoteReconcilePolicy {
    fn default() -> Self {
        Self {
            max_attempts: 12,
            base_backoff_ms: 250,
            max_backoff_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteSecurityDiagnostic {
    pub priority: String,
    pub reason_code: String,
    pub prior_event_id: String,
    pub conflicting_event_id: String,
    pub causation_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteReconcileReport {
    pub execution_id: ExecutionId,
    pub stage: RemoteStage,
    pub reason_code: String,
    pub next_backoff_ms: Option<u64>,
    pub safe_operator_action: String,
    pub diagnostic: Option<RemoteSecurityDiagnostic>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RemoteReconcileError {
    #[error("remote execution is unknown")]
    UnknownExecution,
    #[error("remote terminal conflict requires explicit causation resolution")]
    TerminalConflict,
    #[error("remote request is invalid")]
    InvalidRequest,
}

#[derive(Debug, Default)]
pub struct RemoteReconciler {
    records: BTreeMap<ExecutionId, RemoteExecutionRecord>,
}

impl RemoteReconciler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_intent(
        &mut self,
        execution_id: ExecutionId,
        operation_id: OperationId,
        retry_class: RetryClass,
    ) -> bool {
        if self.records.contains_key(&execution_id) {
            return false;
        }
        self.records.insert(
            execution_id.clone(),
            RemoteExecutionRecord {
                execution_id,
                operation_id,
                retry_class,
                stage: RemoteStage::IntentRecorded,
                runner_job_id: None,
                scheduler_job_id: None,
                terminal_outcome: None,
                terminal_event_id: None,
                artifact_digests: BTreeSet::new(),
                reconcile_attempts: 0,
                submit_dispatched: false,
                cancel_request_ids: BTreeSet::new(),
                collect_request_ids: BTreeSet::new(),
            },
        );
        true
    }

    pub fn ensure_submit(
        &mut self,
        execution_id: &ExecutionId,
        runner: &mut impl RunnerRemotePort,
    ) -> Result<RemoteReconcileReport, RemoteReconcileError> {
        let record = self
            .records
            .get_mut(execution_id)
            .ok_or(RemoteReconcileError::UnknownExecution)?;
        if record.submit_dispatched {
            let truth = runner.query_operation(&record.operation_id);
            return Ok(match truth {
                Ok(truth) if truth.operation_found => {
                    apply_runner_truth(record, &truth);
                    simple_report(record, "operation_marker_recovered", None)
                }
                _ => {
                    record.stage = RemoteStage::SubmittedUnknown;
                    simple_report(record, "submit_already_dispatched_query_only", Some(250))
                }
            });
        }
        record.submit_dispatched = true;
        match runner.submit_once(&record.operation_id) {
            Ok(ack) => {
                record.runner_job_id = Some(ack.runner_job_id);
                record.scheduler_job_id = ack.scheduler_job_id;
                record.stage = RemoteStage::Queued;
                Ok(simple_report(
                    record,
                    "runner_submit_acknowledged",
                    Some(250),
                ))
            }
            Err(RemotePortError::AckLost | RemotePortError::Disconnected) => {
                record.stage = RemoteStage::SubmittedUnknown;
                Ok(simple_report(
                    record,
                    "submit_ack_lost_query_operation_marker",
                    Some(250),
                ))
            }
            Err(RemotePortError::Rejected) => {
                record.stage = RemoteStage::Uncertain;
                Ok(simple_report(record, "runner_submit_rejected", None))
            }
        }
    }

    pub fn reconcile(
        &mut self,
        execution_id: &ExecutionId,
        runner: &mut impl RunnerRemotePort,
        scheduler: &mut impl SchedulerRemotePort,
        artifacts: &mut impl RemoteArtifactPort,
        policy: &RemoteReconcilePolicy,
    ) -> Result<RemoteReconcileReport, RemoteReconcileError> {
        let record = self
            .records
            .get_mut(execution_id)
            .ok_or(RemoteReconcileError::UnknownExecution)?;
        record.reconcile_attempts = record.reconcile_attempts.saturating_add(1);
        let next = backoff(record.reconcile_attempts, policy);

        if record.stage == RemoteStage::ArtifactsCommitted {
            return Ok(simple_report(record, "local_store_complete", None));
        }

        match runner.query_operation(&record.operation_id) {
            Ok(truth) if truth.operation_found => {
                if let Some(conflict) = terminal_conflict(record, &truth) {
                    record.stage = RemoteStage::Conflict;
                    return Ok(RemoteReconcileReport {
                        execution_id: execution_id.clone(),
                        stage: RemoteStage::Conflict,
                        reason_code: "remote_terminal_conflict".to_string(),
                        next_backoff_ms: None,
                        safe_operator_action:
                            "inspect causal events; do not silently rewrite terminal truth"
                                .to_string(),
                        diagnostic: Some(conflict),
                    });
                }
                apply_runner_truth(record, &truth);
            }
            Ok(_) | Err(RemotePortError::Disconnected | RemotePortError::AckLost) => {}
            Err(RemotePortError::Rejected) => {
                record.stage = RemoteStage::Uncertain;
            }
        }

        if !matches!(
            record.stage,
            RemoteStage::Terminal | RemoteStage::ArtifactsCommitted
        ) && let Some(scheduler_id) = record.scheduler_job_id.clone()
            && let Ok(Some(truth)) = scheduler.query_scheduler(&scheduler_id)
        {
            if let Some(outcome) = truth.terminal_outcome {
                if let (Some(prior), Some(prior_event), Some(new_event)) = (
                    record.terminal_outcome,
                    record.terminal_event_id.clone(),
                    truth.accounting_event_id.clone(),
                ) && prior != outcome
                {
                    record.stage = RemoteStage::Conflict;
                    return Ok(RemoteReconcileReport {
                        execution_id: execution_id.clone(),
                        stage: RemoteStage::Conflict,
                        reason_code: "scheduler_terminal_conflict".to_string(),
                        next_backoff_ms: None,
                        safe_operator_action:
                            "record causation-linked resolution before changing truth".to_string(),
                        diagnostic: Some(RemoteSecurityDiagnostic {
                            priority: "p0".to_string(),
                            reason_code: "scheduler_terminal_conflict".to_string(),
                            prior_event_id: prior_event,
                            conflicting_event_id: new_event,
                            causation_required: true,
                        }),
                    });
                }
                record.terminal_outcome = Some(outcome);
                record.terminal_event_id = truth.accounting_event_id;
                record.stage = RemoteStage::Terminal;
            } else {
                record.stage = truth.state;
            }
        }

        if record.stage == RemoteStage::Terminal
            && let Some(runner_job_id) = record.runner_job_id.clone()
        {
            match artifacts.query_artifacts(&runner_job_id) {
                Ok(truth) if truth.complete => {
                    record.artifact_digests.extend(truth.digests);
                    record.stage = RemoteStage::ArtifactsCommitted;
                    return Ok(simple_report(record, "artifact_manifests_committed", None));
                }
                Ok(_) | Err(_) => {
                    return Ok(simple_report(
                        record,
                        "terminal_artifacts_pending_reconcile",
                        next,
                    ));
                }
            }
        }

        if next.is_none()
            && !matches!(
                record.stage,
                RemoteStage::Queued | RemoteStage::Running | RemoteStage::Terminal
            )
        {
            record.stage = RemoteStage::Uncertain;
        }
        Ok(simple_report(record, "remote_reconcile_in_progress", next))
    }

    pub fn cancel_once(
        &mut self,
        execution_id: &ExecutionId,
        request_id: &str,
        runner: &mut impl RunnerRemotePort,
    ) -> Result<bool, RemoteReconcileError> {
        let record = self
            .records
            .get_mut(execution_id)
            .ok_or(RemoteReconcileError::UnknownExecution)?;
        if request_id.is_empty() {
            return Err(RemoteReconcileError::InvalidRequest);
        }
        if !record.cancel_request_ids.is_empty() {
            record.cancel_request_ids.insert(request_id.to_string());
            return Ok(false);
        }
        record.cancel_request_ids.insert(request_id.to_string());
        let runner_job = record
            .runner_job_id
            .as_deref()
            .ok_or(RemoteReconcileError::InvalidRequest)?;
        let _ = runner.cancel_once(runner_job, request_id);
        Ok(true)
    }

    pub fn collect_once(
        &mut self,
        execution_id: &ExecutionId,
        request_id: &str,
        runner: &mut impl RunnerRemotePort,
    ) -> Result<bool, RemoteReconcileError> {
        let record = self
            .records
            .get_mut(execution_id)
            .ok_or(RemoteReconcileError::UnknownExecution)?;
        if request_id.is_empty() {
            return Err(RemoteReconcileError::InvalidRequest);
        }
        if !record.collect_request_ids.is_empty() {
            record.collect_request_ids.insert(request_id.to_string());
            return Ok(false);
        }
        record.collect_request_ids.insert(request_id.to_string());
        let runner_job = record
            .runner_job_id
            .as_deref()
            .ok_or(RemoteReconcileError::InvalidRequest)?;
        let _ = runner.collect_once(runner_job, request_id);
        Ok(true)
    }

    pub fn record(&self, execution_id: &ExecutionId) -> Option<&RemoteExecutionRecord> {
        self.records.get(execution_id)
    }
}

fn apply_runner_truth(record: &mut RemoteExecutionRecord, truth: &RunnerRemoteTruth) {
    record.runner_job_id = truth.runner_job_id.clone().or(record.runner_job_id.clone());
    record.scheduler_job_id = truth
        .scheduler_job_id
        .clone()
        .or(record.scheduler_job_id.clone());
    record.stage = truth.state;
    if truth.terminal_outcome.is_some() {
        record.terminal_outcome = truth.terminal_outcome;
        record.terminal_event_id = truth.terminal_event_id.clone();
        record.stage = RemoteStage::Terminal;
    }
    record
        .artifact_digests
        .extend(truth.artifact_manifest_digests.clone());
}

fn terminal_conflict(
    record: &RemoteExecutionRecord,
    truth: &RunnerRemoteTruth,
) -> Option<RemoteSecurityDiagnostic> {
    let prior = record.terminal_outcome?;
    let next = truth.terminal_outcome?;
    if prior == next {
        return None;
    }
    Some(RemoteSecurityDiagnostic {
        priority: "p0".to_string(),
        reason_code: "runner_terminal_conflict".to_string(),
        prior_event_id: record
            .terminal_event_id
            .clone()
            .unwrap_or_else(|| "event_unknown_prior".to_string()),
        conflicting_event_id: truth
            .terminal_event_id
            .clone()
            .unwrap_or_else(|| "event_unknown_conflict".to_string()),
        causation_required: true,
    })
}

fn simple_report(
    record: &RemoteExecutionRecord,
    reason: &str,
    next: Option<u64>,
) -> RemoteReconcileReport {
    RemoteReconcileReport {
        execution_id: record.execution_id.clone(),
        stage: record.stage,
        reason_code: reason.to_string(),
        next_backoff_ms: next,
        safe_operator_action: match record.stage {
            RemoteStage::ArtifactsCommitted => "open committed artifacts",
            RemoteStage::Terminal => "wait for artifact manifest reconciliation",
            RemoteStage::Queued | RemoteStage::Running => {
                "job remains remote; reconnect without resubmitting"
            }
            RemoteStage::Uncertain | RemoteStage::SubmittedUnknown => {
                "query runner operation marker and scheduler; do not replay"
            }
            RemoteStage::Conflict => "resolve causal terminal conflict",
            RemoteStage::IntentRecorded => "submit once through runner",
        }
        .to_string(),
        diagnostic: None,
    }
}

fn backoff(attempt: u32, policy: &RemoteReconcilePolicy) -> Option<u64> {
    if attempt >= policy.max_attempts {
        return None;
    }
    Some(
        policy
            .base_backoff_ms
            .saturating_mul(
                1_u64
                    .checked_shl(attempt.saturating_sub(1))
                    .unwrap_or(u64::MAX),
            )
            .min(policy.max_backoff_ms),
    )
}

pub fn remote_reconcile_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "local_runner_scheduler_artifact_hierarchy",
            "operation_marker_query",
            "bounded_backoff",
            "causal_terminal_conflict",
        ],
        &[
            "duplicate_remote_effect",
            "unknown_non_idempotent_submit",
            "silent_terminal_rewrite",
            "agent_plan",
            "provider_session",
        ],
    )
}
