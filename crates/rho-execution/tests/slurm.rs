use std::collections::{BTreeMap, VecDeque};

use rho_execution::slurm::*;
use rho_protocol::*;

#[derive(Default)]
struct FakeScheduler {
    markers: BTreeMap<String, String>,
    submit_calls: usize,
    submit_ack_lost: bool,
    queue: VecDeque<Option<SlurmQueueState>>,
    accounting: VecDeque<Option<SlurmAccountingRecord>>,
    cancel_calls: usize,
    requeue_calls: usize,
}

impl SlurmSchedulerPort for FakeScheduler {
    fn find_by_operation_marker(&mut self, marker: &str) -> Result<Option<String>, SlurmPortError> {
        Ok(self.markers.get(marker).cloned())
    }

    fn submit(&mut self, request: &SlurmSubmitRequest) -> Result<String, SlurmPortError> {
        self.submit_calls += 1;
        let id = format!("slurm_{}", self.submit_calls);
        self.markers
            .insert(request.operation_marker.clone(), id.clone());
        if self.submit_ack_lost {
            Err(SlurmPortError::SubmitAckLost)
        } else {
            Ok(id)
        }
    }

    fn queue_state(
        &mut self,
        _slurm_job_id: &str,
    ) -> Result<Option<SlurmQueueState>, SlurmPortError> {
        Ok(self.queue.pop_front().unwrap_or(None))
    }

    fn accounting(
        &mut self,
        _slurm_job_id: &str,
    ) -> Result<Option<SlurmAccountingRecord>, SlurmPortError> {
        Ok(self.accounting.pop_front().unwrap_or(None))
    }

    fn cancel(&mut self, _slurm_job_id: &str) -> Result<(), SlurmPortError> {
        self.cancel_calls += 1;
        Ok(())
    }

    fn requeue(&mut self, _slurm_job_id: &str) -> Result<(), SlurmPortError> {
        self.requeue_calls += 1;
        Ok(())
    }
}

fn digest(character: char) -> ArtifactDigest {
    ArtifactDigest::new(format!("sha256:{}", character.to_string().repeat(64))).unwrap()
}

fn request(label: &str, retry_class: RetryClass) -> SlurmSubmitRequest {
    SlurmSubmitRequest {
        execution_id: ExecutionId::new(format!("execution_slurm_{label}")).unwrap(),
        operation_id: OperationId::new(format!("operation_slurm_{label}")).unwrap(),
        operation_marker: format!("rho-operation-operation_slurm_{label}"),
        submission_bundle_digest: digest('a'),
        script_file_handle: "script_handle".to_string(),
        spec_file_handle: "spec_handle".to_string(),
        staging_manifest_file_handle: "staging_manifest_handle".to_string(),
        staging_manifest_digest: digest('f'),
        environment_receipt_digest: AuthorityDigest::new(format!("sha256:{}", "1".repeat(64)))
            .unwrap(),
        execution_profile_digest: AuthorityDigest::new(format!("sha256:{}", "2".repeat(64)))
            .unwrap(),
        output_staging_handle: "staging_handle".to_string(),
        offline_network: true,
        retry_class,
    }
}

fn accounting(state: SlurmAccountingState) -> SlurmAccountingRecord {
    SlurmAccountingRecord {
        state,
        exit_code: "0:0".to_string(),
        effective_resources_digest: digest('b').to_string(),
        stdout_manifest_digest: Some(digest('c')),
        stderr_manifest_digest: Some(digest('d')),
        output_manifest_digest: Some(digest('e')),
    }
}

#[test]
fn slurm_submit_ack_loss_recovers_operation_marker_without_second_submit() {
    let request = request("ack_loss", RetryClass::NonIdempotent);
    let mut scheduler = FakeScheduler {
        submit_ack_lost: true,
        ..FakeScheduler::default()
    };
    let mut executor = SlurmExecutor::new();
    let outcome = executor.submit(request.clone(), &mut scheduler).unwrap();
    assert!(matches!(
        outcome,
        SlurmSubmitOutcome::Submitted {
            recovered_ack: true,
            ..
        }
    ));
    assert_eq!(scheduler.submit_calls, 1);
    assert!(matches!(
        executor.submit(request, &mut scheduler).unwrap(),
        SlurmSubmitOutcome::Duplicate { .. }
    ));
    assert_eq!(scheduler.submit_calls, 1);
}

#[test]
fn slurm_queue_running_and_accounting_terminal_normalize_with_complete_linkage() {
    let request = request("lifecycle", RetryClass::PureRead);
    let operation_id = request.operation_id.clone();
    let mut scheduler = FakeScheduler {
        queue: [
            Some(SlurmQueueState::Pending),
            Some(SlurmQueueState::Running),
            None,
        ]
        .into(),
        accounting: [Some(accounting(SlurmAccountingState::Completed))].into(),
        ..FakeScheduler::default()
    };
    let mut executor = SlurmExecutor::new();
    executor.submit(request, &mut scheduler).unwrap();
    assert_eq!(
        executor
            .reconcile(&operation_id, &mut scheduler)
            .unwrap()
            .state,
        ExecutionState::Queued
    );
    assert_eq!(
        executor
            .reconcile(&operation_id, &mut scheduler)
            .unwrap()
            .state,
        ExecutionState::Running
    );
    let terminal = executor.reconcile(&operation_id, &mut scheduler).unwrap();
    assert_eq!(terminal.state, ExecutionState::Succeeded);
    let record = executor.record_for(&operation_id).unwrap();
    assert!(record.scheduler_terminal_confirmed);
    assert!(
        record
            .accounting
            .as_ref()
            .unwrap()
            .output_manifest_digest
            .is_some()
    );
    let commit = executor.environment_commit_facts(&operation_id).unwrap();
    assert_eq!(commit.shared_storage_output_manifest_digest, digest('e'));
    assert_eq!(commit.staging_manifest_digest, digest('f'));
}

#[test]
fn slurm_squeue_disappearance_and_sacct_lag_is_uncertain_not_success() {
    let request = request("sacct_lag", RetryClass::NonIdempotent);
    let operation_id = request.operation_id.clone();
    let mut scheduler = FakeScheduler::default();
    let mut executor = SlurmExecutor::new();
    executor.submit(request, &mut scheduler).unwrap();
    let observed = executor.reconcile(&operation_id, &mut scheduler).unwrap();
    assert_eq!(observed.state, ExecutionState::Uncertain);
    assert!(observed.message.unwrap().contains("sacct lagging"));
}

#[test]
fn slurm_cancel_requested_is_distinct_from_scheduler_confirmed_terminal() {
    let request = request("cancel", RetryClass::NonIdempotent);
    let operation_id = request.operation_id.clone();
    let mut scheduler = FakeScheduler {
        accounting: [Some(accounting(SlurmAccountingState::Cancelled))].into(),
        ..FakeScheduler::default()
    };
    let mut executor = SlurmExecutor::new();
    executor.submit(request, &mut scheduler).unwrap();
    let requested = executor
        .request_cancel(&operation_id, &mut scheduler)
        .unwrap();
    assert_ne!(requested.state, ExecutionState::Cancelled);
    assert!(requested.message.unwrap().contains("not yet confirmed"));
    assert_eq!(scheduler.cancel_calls, 1);
    let confirmed = executor.reconcile(&operation_id, &mut scheduler).unwrap();
    assert_eq!(confirmed.state, ExecutionState::Cancelled);
    assert!(
        executor
            .record_for(&operation_id)
            .unwrap()
            .scheduler_terminal_confirmed
    );
}

#[test]
fn slurm_requeue_requires_retry_class_and_retryable_scheduler_truth() {
    for (retry_class, should_allow) in [
        (RetryClass::PureRead, true),
        (RetryClass::IdempotentWrite, true),
        (RetryClass::ConditionallyIdempotent, false),
        (RetryClass::NonIdempotent, false),
    ] {
        let label = format!("requeue_{retry_class:?}").to_ascii_lowercase();
        let request = request(&label, retry_class);
        let operation_id = request.operation_id.clone();
        let mut scheduler = FakeScheduler {
            accounting: [Some(accounting(SlurmAccountingState::NodeFailure))].into(),
            ..FakeScheduler::default()
        };
        let mut executor = SlurmExecutor::new();
        executor.submit(request, &mut scheduler).unwrap();
        executor.reconcile(&operation_id, &mut scheduler).unwrap();
        assert_eq!(
            executor.requeue(&operation_id, &mut scheduler).is_ok(),
            should_allow
        );
    }
}

#[test]
fn slurm_boundary_has_no_compute_node_ssh_agent_interpolation_missing_success_or_ack_resubmit() {
    let (_, does_not_own) = slurm_boundary();
    assert!(does_not_own.contains(&"compute_node_ssh"));
    assert!(does_not_own.contains(&"agent_script_interpolation"));
    assert!(does_not_own.contains(&"squeue_missing_success"));
    assert!(does_not_own.contains(&"ack_loss_resubmit"));
}
