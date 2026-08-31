use std::collections::BTreeMap;

use rho_protocol::{
    ArtifactDigest, ExecutionId, ExecutionState, JobId, JobObservation, OperationId, RetryClass,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlurmSubmitRequest {
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub operation_marker: String,
    pub submission_bundle_digest: ArtifactDigest,
    pub script_file_handle: String,
    pub spec_file_handle: String,
    pub output_staging_handle: String,
    pub retry_class: RetryClass,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlurmQueueState {
    Pending,
    Running,
    Completing,
    Suspended,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlurmAccountingState {
    Completed,
    Failed,
    Cancelled,
    Timeout,
    OutOfMemory,
    NodeFailure,
    Preempted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlurmAccountingRecord {
    pub state: SlurmAccountingState,
    pub exit_code: String,
    pub effective_resources_digest: String,
    pub stdout_manifest_digest: Option<ArtifactDigest>,
    pub stderr_manifest_digest: Option<ArtifactDigest>,
    pub output_manifest_digest: Option<ArtifactDigest>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SlurmPortError {
    #[error("Slurm submit acknowledgement was lost")]
    SubmitAckLost,
    #[error("Slurm transport is unavailable")]
    Unavailable,
    #[error("Slurm request was rejected")]
    Rejected,
}

pub trait SlurmSchedulerPort {
    fn find_by_operation_marker(&mut self, marker: &str) -> Result<Option<String>, SlurmPortError>;
    fn submit(&mut self, request: &SlurmSubmitRequest) -> Result<String, SlurmPortError>;
    fn queue_state(
        &mut self,
        slurm_job_id: &str,
    ) -> Result<Option<SlurmQueueState>, SlurmPortError>;
    fn accounting(
        &mut self,
        slurm_job_id: &str,
    ) -> Result<Option<SlurmAccountingRecord>, SlurmPortError>;
    fn cancel(&mut self, slurm_job_id: &str) -> Result<(), SlurmPortError>;
    fn requeue(&mut self, slurm_job_id: &str) -> Result<(), SlurmPortError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlurmJobRecord {
    pub job_id: JobId,
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub operation_marker: String,
    pub slurm_job_id: Option<String>,
    pub state: ExecutionState,
    pub retry_class: RetryClass,
    pub cancel_requested: bool,
    pub scheduler_terminal_confirmed: bool,
    pub accounting: Option<SlurmAccountingRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SlurmSubmitOutcome {
    Submitted {
        record: SlurmJobRecord,
        recovered_ack: bool,
    },
    Uncertain {
        record: SlurmJobRecord,
        reason_code: String,
    },
    Duplicate {
        record: SlurmJobRecord,
    },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SlurmExecutorError {
    #[error("Slurm request is invalid")]
    InvalidRequest,
    #[error("Slurm job is unknown")]
    UnknownJob,
    #[error("Slurm scheduler error: {0}")]
    Scheduler(#[from] SlurmPortError),
    #[error("Slurm requeue is not allowed by retry class or scheduler truth")]
    RequeueDenied,
}

#[derive(Default)]
pub struct SlurmExecutor {
    records: BTreeMap<OperationId, SlurmJobRecord>,
}

impl SlurmExecutor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn submit(
        &mut self,
        request: SlurmSubmitRequest,
        scheduler: &mut impl SlurmSchedulerPort,
    ) -> Result<SlurmSubmitOutcome, SlurmExecutorError> {
        validate_request(&request)?;
        if let Some(record) = self.records.get(&request.operation_id) {
            return Ok(SlurmSubmitOutcome::Duplicate {
                record: record.clone(),
            });
        }
        if let Some(slurm_job_id) = scheduler.find_by_operation_marker(&request.operation_marker)? {
            let record = self.record(&request, Some(slurm_job_id), ExecutionState::Submitted);
            self.records
                .insert(request.operation_id.clone(), record.clone());
            return Ok(SlurmSubmitOutcome::Submitted {
                record,
                recovered_ack: true,
            });
        }
        match scheduler.submit(&request) {
            Ok(slurm_job_id) => {
                let record = self.record(&request, Some(slurm_job_id), ExecutionState::Submitted);
                self.records
                    .insert(request.operation_id.clone(), record.clone());
                Ok(SlurmSubmitOutcome::Submitted {
                    record,
                    recovered_ack: false,
                })
            }
            Err(SlurmPortError::SubmitAckLost) => {
                if let Some(slurm_job_id) =
                    scheduler.find_by_operation_marker(&request.operation_marker)?
                {
                    let record =
                        self.record(&request, Some(slurm_job_id), ExecutionState::Submitted);
                    self.records
                        .insert(request.operation_id.clone(), record.clone());
                    Ok(SlurmSubmitOutcome::Submitted {
                        record,
                        recovered_ack: true,
                    })
                } else {
                    let record = self.record(&request, None, ExecutionState::Uncertain);
                    self.records
                        .insert(request.operation_id.clone(), record.clone());
                    Ok(SlurmSubmitOutcome::Uncertain {
                        record,
                        reason_code: "slurm_submit_ack_lost_marker_not_yet_visible".to_string(),
                    })
                }
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn reconcile(
        &mut self,
        operation_id: &OperationId,
        scheduler: &mut impl SlurmSchedulerPort,
    ) -> Result<JobObservation, SlurmExecutorError> {
        let record = self
            .records
            .get_mut(operation_id)
            .ok_or(SlurmExecutorError::UnknownJob)?;
        if record.slurm_job_id.is_none() {
            record.slurm_job_id = scheduler.find_by_operation_marker(&record.operation_marker)?;
        }
        let Some(slurm_job_id) = record.slurm_job_id.clone() else {
            record.state = ExecutionState::Uncertain;
            return Ok(observation(
                record,
                "operation marker not visible; do not resubmit",
            ));
        };
        if let Some(queue) = scheduler.queue_state(&slurm_job_id)? {
            record.state = match queue {
                SlurmQueueState::Pending | SlurmQueueState::Suspended => ExecutionState::Queued,
                SlurmQueueState::Running | SlurmQueueState::Completing => ExecutionState::Running,
            };
            return Ok(observation(record, "scheduler queue state"));
        }
        if let Some(accounting) = scheduler.accounting(&slurm_job_id)? {
            record.state = accounting_state(accounting.state);
            record.scheduler_terminal_confirmed = true;
            record.accounting = Some(accounting);
            return Ok(observation(record, "scheduler accounting terminal truth"));
        }
        record.state = ExecutionState::Uncertain;
        Ok(observation(
            record,
            "squeue missing and sacct lagging; reconciliation required",
        ))
    }

    pub fn request_cancel(
        &mut self,
        operation_id: &OperationId,
        scheduler: &mut impl SlurmSchedulerPort,
    ) -> Result<JobObservation, SlurmExecutorError> {
        let record = self
            .records
            .get_mut(operation_id)
            .ok_or(SlurmExecutorError::UnknownJob)?;
        if record.state.is_terminal() && record.scheduler_terminal_confirmed {
            return Ok(observation(record, "already scheduler terminal"));
        }
        let Some(slurm_job_id) = &record.slurm_job_id else {
            record.cancel_requested = true;
            record.state = ExecutionState::Uncertain;
            return Ok(observation(
                record,
                "cancel pending operation marker lookup",
            ));
        };
        scheduler.cancel(slurm_job_id)?;
        record.cancel_requested = true;
        Ok(observation(
            record,
            "scancel requested; scheduler terminal not yet confirmed",
        ))
    }

    pub fn requeue(
        &mut self,
        operation_id: &OperationId,
        scheduler: &mut impl SlurmSchedulerPort,
    ) -> Result<(), SlurmExecutorError> {
        let record = self
            .records
            .get(operation_id)
            .ok_or(SlurmExecutorError::UnknownJob)?;
        let retry_allowed = matches!(
            record.retry_class,
            RetryClass::PureRead | RetryClass::IdempotentWrite
        );
        let scheduler_retryable = record.accounting.as_ref().is_some_and(|accounting| {
            matches!(
                accounting.state,
                SlurmAccountingState::NodeFailure | SlurmAccountingState::Preempted
            )
        });
        if !retry_allowed || !scheduler_retryable {
            return Err(SlurmExecutorError::RequeueDenied);
        }
        scheduler.requeue(
            record
                .slurm_job_id
                .as_deref()
                .ok_or(SlurmExecutorError::RequeueDenied)?,
        )?;
        Ok(())
    }

    pub fn record_for(&self, operation_id: &OperationId) -> Option<&SlurmJobRecord> {
        self.records.get(operation_id)
    }

    fn record(
        &self,
        request: &SlurmSubmitRequest,
        slurm_job_id: Option<String>,
        state: ExecutionState,
    ) -> SlurmJobRecord {
        SlurmJobRecord {
            job_id: JobId::new(format!("job_{}", request.operation_id.as_str()))
                .unwrap_or_else(|_| JobId::generate()),
            execution_id: request.execution_id.clone(),
            operation_id: request.operation_id.clone(),
            operation_marker: request.operation_marker.clone(),
            slurm_job_id,
            state,
            retry_class: request.retry_class,
            cancel_requested: false,
            scheduler_terminal_confirmed: false,
            accounting: None,
        }
    }
}

fn validate_request(request: &SlurmSubmitRequest) -> Result<(), SlurmExecutorError> {
    if request.operation_marker != format!("rho-operation-{}", request.operation_id.as_str())
        || request.script_file_handle.is_empty()
        || request.spec_file_handle.is_empty()
        || request.output_staging_handle.is_empty()
    {
        return Err(SlurmExecutorError::InvalidRequest);
    }
    Ok(())
}

fn accounting_state(state: SlurmAccountingState) -> ExecutionState {
    match state {
        SlurmAccountingState::Completed => ExecutionState::Succeeded,
        SlurmAccountingState::Cancelled => ExecutionState::Cancelled,
        SlurmAccountingState::Failed
        | SlurmAccountingState::Timeout
        | SlurmAccountingState::OutOfMemory
        | SlurmAccountingState::NodeFailure
        | SlurmAccountingState::Preempted => ExecutionState::Failed,
    }
}

fn observation(record: &SlurmJobRecord, message: &str) -> JobObservation {
    JobObservation {
        job_id: record.job_id.clone(),
        execution_id: record.execution_id.clone(),
        state: record.state,
        scheduler_id: record.slurm_job_id.clone(),
        message: Some(message.to_string()),
    }
}

pub fn slurm_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "operation_marker",
            "scheduler_mapping",
            "queue_accounting_reconcile",
            "cancel_confirmation_split",
        ],
        &[
            "compute_node_ssh",
            "agent_script_interpolation",
            "squeue_missing_success",
            "ack_loss_resubmit",
        ],
    )
}
