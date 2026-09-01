use std::{thread, time::Duration};

use rho_execution::local::{
    LocalProcessExecutor, LocalSubmitOutcome, LocalTerminalObservation, SubmitIntentRecorder,
    ValidatedLocalExecutionSpec,
};
use rho_protocol::{
    AuthorityDigest, DestinationClass, EnvironmentCheckpointV1, EnvironmentOperationOutcomeV1,
    ExecutionId, ExpectedRevisions, MaterializedPackagePlanV1, RetryClass,
};
use rho_store::{
    EnvironmentOperationJournalRecord, EnvironmentStateCommit, EnvironmentStateProjection, Store,
    StoreConnection, StoreError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{BrokerError, BrokerLease, lease_matches_request};

#[derive(Debug, Clone)]
pub struct EnvironmentApplyRequest {
    pub project_root: String,
    pub plan: MaterializedPackagePlanV1,
    pub expected_revisions: ExpectedRevisions,
    pub destination: DestinationClass,
    pub now_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum EnvironmentExecutionOutcome {
    Succeeded {
        execution_id: ExecutionId,
    },
    Failed {
        execution_id: Option<ExecutionId>,
        reason: String,
    },
    Cancelled {
        execution_id: ExecutionId,
    },
    Uncertain {
        execution_id: Option<ExecutionId>,
        reason: String,
    },
}

pub trait EnvironmentExecutionPort {
    fn execute<C: StoreConnection>(
        &mut self,
        plan: &MaterializedPackagePlanV1,
        store: &mut Store<C>,
        project_root: &str,
        operation_id: &str,
    ) -> Result<EnvironmentExecutionOutcome, String>;

    fn reconcile<C: StoreConnection>(
        &mut self,
        plan: &MaterializedPackagePlanV1,
        store: &mut Store<C>,
        project_root: &str,
        operation_id: &str,
    ) -> Result<Option<EnvironmentExecutionOutcome>, String>;
}

pub trait EnvironmentCommitVerifier {
    fn verify(
        &mut self,
        plan: &MaterializedPackagePlanV1,
        execution_id: &ExecutionId,
    ) -> Result<EnvironmentStateCommit, String>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentApplyOutcome {
    pub status: String,
    pub journal: EnvironmentOperationJournalRecord,
    pub projection: Option<EnvironmentStateProjection>,
}

#[derive(Debug, Error)]
pub enum EnvironmentOperationError {
    #[error("Broker lease error: {0}")]
    Broker(#[from] BrokerError),
    #[error("Store error: {0}")]
    Store(#[from] StoreError),
    #[error("Environment plan is invalid: {0}")]
    InvalidPlan(String),
    #[error("Broker lease does not match the exact Environment plan and revisions")]
    LeaseMismatch,
    #[error("Environment execution failed: {0}")]
    Execution(String),
    #[error("Environment verification failed: {0}")]
    Verification(String),
}

pub struct EnvironmentOperationCoordinator;

impl EnvironmentOperationCoordinator {
    pub fn apply<C, E, V>(
        store: &mut Store<C>,
        lease: &BrokerLease,
        request: &EnvironmentApplyRequest,
        execution: &mut E,
        verifier: &mut V,
    ) -> Result<EnvironmentApplyOutcome, EnvironmentOperationError>
    where
        C: StoreConnection,
        E: EnvironmentExecutionPort,
        V: EnvironmentCommitVerifier,
    {
        request
            .plan
            .validate()
            .map_err(|error| EnvironmentOperationError::InvalidPlan(error.to_string()))?;
        if request.plan.body.expected_before.project_revision
            != Some(request.expected_revisions.project_revision.0)
        {
            return Err(EnvironmentOperationError::InvalidPlan(
                "Environment plan project revision differs from Broker precondition".to_string(),
            ));
        }
        let arguments = environment_plan_arguments(&request.plan, &request.expected_revisions);
        if !lease_matches_request(
            lease,
            &arguments,
            &request.expected_revisions,
            request.destination,
            request.now_ms,
        )? {
            return Err(EnvironmentOperationError::LeaseMismatch);
        }
        let operation_id = lease.operation_id().as_str();
        let review = store
            .get_environment_plan_review(&request.project_root, request.plan.plan_id.as_str())?
            .ok_or_else(|| {
                EnvironmentOperationError::InvalidPlan(
                    "Environment plan was not materialized for review".to_string(),
                )
            })?;
        if !matches!(review.status.as_str(), "approved" | "dispatched")
            || review.approval_lease_id.as_deref() != Some(lease.opaque_id())
            || review.operation_id.as_deref() != Some(operation_id)
            || review.plan != request.plan
        {
            return Err(EnvironmentOperationError::InvalidPlan(
                "Environment plan has no matching exact reviewed approval".to_string(),
            ));
        }
        let journal = store.begin_environment_operation(
            &request.project_root,
            &request.plan,
            operation_id,
        )?;
        store.dispatch_approved_environment_plan(
            &request.project_root,
            request.plan.plan_id.as_str(),
            lease.opaque_id(),
            operation_id,
        )?;
        if journal.status != "prepared" {
            return Ok(EnvironmentApplyOutcome {
                status: journal.status.clone(),
                journal,
                projection: None,
            });
        }
        append_checkpoint(store, &request.project_root, operation_id, "admitted", None)?;
        store.transition_environment_operation(
            &request.project_root,
            operation_id,
            "running",
            None,
        )?;
        let outcome =
            match execution.execute(&request.plan, store, &request.project_root, operation_id) {
                Ok(outcome) => outcome,
                Err(reason) => EnvironmentExecutionOutcome::Uncertain {
                    execution_id: None,
                    reason,
                },
            };
        finalize_execution(
            store,
            &request.project_root,
            operation_id,
            &request.plan,
            outcome,
            verifier,
        )
    }

    pub fn reconcile<C, E, V>(
        store: &mut Store<C>,
        request: &EnvironmentApplyRequest,
        execution: &mut E,
        verifier: &mut V,
    ) -> Result<EnvironmentApplyOutcome, EnvironmentOperationError>
    where
        C: StoreConnection,
        E: EnvironmentExecutionPort,
        V: EnvironmentCommitVerifier,
    {
        request
            .plan
            .validate()
            .map_err(|error| EnvironmentOperationError::InvalidPlan(error.to_string()))?;
        let operation_id = store
            .current_environment_operation_id(&request.project_root, request.plan.plan_id.as_str())?
            .ok_or_else(|| {
                EnvironmentOperationError::InvalidPlan(
                    "no Environment operation exists for this plan".to_string(),
                )
            })?;
        let journal = store
            .get_environment_operation_journal(&request.project_root, &operation_id)?
            .ok_or_else(|| {
                EnvironmentOperationError::InvalidPlan(
                    "Environment operation journal is missing".to_string(),
                )
            })?;
        if journal.status != "uncertain" && journal.status != "reconcile_required" {
            return Ok(EnvironmentApplyOutcome {
                status: journal.status.clone(),
                journal,
                projection: None,
            });
        }
        if journal.status == "uncertain" {
            store.transition_environment_operation(
                &request.project_root,
                &operation_id,
                "reconcile_required",
                journal.reason.as_deref(),
            )?;
        }
        let Some(outcome) = execution
            .reconcile(&request.plan, store, &request.project_root, &operation_id)
            .map_err(EnvironmentOperationError::Execution)?
        else {
            let journal = store
                .get_environment_operation_journal(&request.project_root, &operation_id)?
                .expect("journal exists");
            return Ok(EnvironmentApplyOutcome {
                status: "reconcile_required".to_string(),
                journal,
                projection: None,
            });
        };
        if matches!(outcome, EnvironmentExecutionOutcome::Succeeded { .. }) {
            store.transition_environment_operation(
                &request.project_root,
                &operation_id,
                "running",
                None,
            )?;
        }
        finalize_execution(
            store,
            &request.project_root,
            &operation_id,
            &request.plan,
            outcome,
            verifier,
        )
    }
}

pub fn environment_plan_arguments(
    plan: &MaterializedPackagePlanV1,
    expected: &ExpectedRevisions,
) -> Value {
    let hex = plan
        .plan_id
        .as_str()
        .strip_prefix("environment_plan_")
        .expect("validated plan ID uses canonical prefix");
    json!({
        "plan_id": plan.plan_id.as_str(),
        "plan_digest": format!("sha256:{hex}"),
        "environment_id": plan.body.environment.environment_id.as_str(),
        "expected_desired_revision": plan.body.expected_before.desired_revision.as_str(),
        "expected_realization_revision": plan.body.expected_before.realization_revision.as_str(),
        "project_revision": expected.project_revision.0,
        "restart_required": plan.body.restart_required,
    })
}

fn finalize_execution<C, V>(
    store: &mut Store<C>,
    project_root: &str,
    operation_id: &str,
    plan: &MaterializedPackagePlanV1,
    outcome: EnvironmentExecutionOutcome,
    verifier: &mut V,
) -> Result<EnvironmentApplyOutcome, EnvironmentOperationError>
where
    C: StoreConnection,
    V: EnvironmentCommitVerifier,
{
    match outcome {
        EnvironmentExecutionOutcome::Succeeded { execution_id } => {
            append_checkpoint(store, project_root, operation_id, "executed", None)?;
            store.transition_environment_operation(
                project_root,
                operation_id,
                "verifying",
                None,
            )?;
            let commit = match verifier.verify(plan, &execution_id) {
                Ok(commit) => commit,
                Err(error) => {
                    store.transition_environment_operation(
                        project_root,
                        operation_id,
                        "failed",
                        Some(&error),
                    )?;
                    return Err(EnvironmentOperationError::Verification(error));
                }
            };
            if commit.project_root != project_root
                || commit.environment.environment_id != plan.body.environment.environment_id
                || commit.receipt.plan_id != plan.plan_id
                || commit.receipt.operation_id.as_str() != operation_id
                || commit.receipt.desired_before != plan.body.expected_before.desired_revision
                || commit.receipt.realization_before
                    != plan.body.expected_before.realization_revision
                || !commit.receipt.execution_refs.contains(&execution_id)
                || commit.receipt.outcome != EnvironmentOperationOutcomeV1::Succeeded
            {
                store.transition_environment_operation(
                    project_root,
                    operation_id,
                    "failed",
                    Some("verified Environment commit identity mismatch"),
                )?;
                return Err(EnvironmentOperationError::Verification(
                    "verified Environment commit identity mismatch".to_string(),
                ));
            }
            append_checkpoint(store, project_root, operation_id, "verified", None)?;
            let projection = store.commit_environment_state_for_operation(&commit, operation_id)?;
            let journal = store
                .get_environment_operation_journal(project_root, operation_id)?
                .ok_or_else(|| {
                    StoreError::Validation(
                        "Environment operation disappeared after commit".to_string(),
                    )
                })?;
            Ok(EnvironmentApplyOutcome {
                status: "succeeded".to_string(),
                journal,
                projection: Some(projection),
            })
        }
        EnvironmentExecutionOutcome::Failed { reason, .. } => {
            let journal = store.transition_environment_operation(
                project_root,
                operation_id,
                "failed",
                Some(&reason),
            )?;
            Ok(EnvironmentApplyOutcome {
                status: "failed".to_string(),
                journal,
                projection: None,
            })
        }
        EnvironmentExecutionOutcome::Cancelled { .. } => {
            let journal = store.transition_environment_operation(
                project_root,
                operation_id,
                "cancelled",
                Some("cancelled after process-tree confirmation"),
            )?;
            Ok(EnvironmentApplyOutcome {
                status: "cancelled".to_string(),
                journal,
                projection: None,
            })
        }
        EnvironmentExecutionOutcome::Uncertain { reason, .. } => {
            let journal = store.transition_environment_operation(
                project_root,
                operation_id,
                "uncertain",
                Some(&reason),
            )?;
            Ok(EnvironmentApplyOutcome {
                status: "uncertain".to_string(),
                journal,
                projection: None,
            })
        }
    }
}

fn append_checkpoint<C: StoreConnection>(
    store: &mut Store<C>,
    project_root: &str,
    operation_id: &str,
    name: &str,
    digest: Option<AuthorityDigest>,
) -> Result<(), StoreError> {
    store.append_environment_checkpoint(
        project_root,
        operation_id,
        &EnvironmentCheckpointV1 {
            name: name.to_string(),
            reached_at: timestamp(),
            digest,
        },
    )?;
    Ok(())
}

fn timestamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix_ms:{millis}")
}

struct StoreSubmitRecorder<'a, C> {
    store: &'a mut Store<C>,
    project_root: &'a str,
    operation_id: &'a str,
}

impl<C: StoreConnection> SubmitIntentRecorder for StoreSubmitRecorder<'_, C> {
    fn record_submit_intent(&mut self, spec: &ValidatedLocalExecutionSpec) -> Result<(), String> {
        let digest = digest_serializable(spec)?;
        append_checkpoint(
            self.store,
            self.project_root,
            self.operation_id,
            "process_submit_intent",
            Some(digest),
        )
        .map_err(|error| error.to_string())
    }

    fn record_process_handle(
        &mut self,
        _execution_id: &ExecutionId,
        identity: &rho_execution::local::ProcessIdentity,
    ) -> Result<(), String> {
        let digest = digest_serializable(identity)?;
        append_checkpoint(
            self.store,
            self.project_root,
            self.operation_id,
            "process_handle",
            Some(digest),
        )
        .map_err(|error| error.to_string())
    }
}

fn digest_serializable(value: &impl Serialize) -> Result<AuthorityDigest, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|error| error.to_string())
}

pub struct LocalEnvironmentExecutionPort {
    executor: LocalProcessExecutor,
    prepared: Option<ValidatedLocalExecutionSpec>,
    execution_id: ExecutionId,
    poll_interval: Duration,
    max_polls: usize,
}

impl LocalEnvironmentExecutionPort {
    pub fn new(
        prepared: ValidatedLocalExecutionSpec,
        poll_interval: Duration,
        max_polls: usize,
    ) -> Result<Self, String> {
        if prepared.spec().retry_class != RetryClass::NonIdempotent {
            return Err("Environment mutation must be non-idempotent".to_string());
        }
        Ok(Self {
            execution_id: prepared.spec().execution_id.clone(),
            executor: LocalProcessExecutor::new(),
            prepared: Some(prepared),
            poll_interval,
            max_polls: max_polls.max(1),
        })
    }

    fn poll_terminal(&mut self) -> Result<Option<EnvironmentExecutionOutcome>, String> {
        for _ in 0..self.max_polls {
            if let Some(terminal) = self
                .executor
                .poll(&self.execution_id)
                .map_err(|error| error.to_string())?
            {
                return Ok(Some(local_terminal_outcome(terminal)));
            }
            thread::sleep(self.poll_interval);
        }
        Ok(None)
    }
}

impl EnvironmentExecutionPort for LocalEnvironmentExecutionPort {
    fn execute<C: StoreConnection>(
        &mut self,
        _plan: &MaterializedPackagePlanV1,
        store: &mut Store<C>,
        project_root: &str,
        operation_id: &str,
    ) -> Result<EnvironmentExecutionOutcome, String> {
        let prepared = self
            .prepared
            .take()
            .ok_or_else(|| "Environment execution was already submitted".to_string())?;
        if prepared.spec().operation_id.as_str() != operation_id {
            return Err("local Environment spec operation identity mismatch".to_string());
        }
        let mut recorder = StoreSubmitRecorder {
            store,
            project_root,
            operation_id,
        };
        match self
            .executor
            .submit(prepared, &mut recorder)
            .map_err(|error| error.to_string())?
        {
            LocalSubmitOutcome::SpawnAcknowledged { .. } | LocalSubmitOutcome::Duplicate { .. } => {
                Ok(self.poll_terminal()?.unwrap_or_else(|| {
                    EnvironmentExecutionOutcome::Uncertain {
                        execution_id: Some(self.execution_id.clone()),
                        reason: "poll_deadline".to_string(),
                    }
                }))
            }
            LocalSubmitOutcome::Uncertain { reason_code, .. } => {
                Ok(EnvironmentExecutionOutcome::Uncertain {
                    execution_id: Some(self.execution_id.clone()),
                    reason: reason_code,
                })
            }
        }
    }

    fn reconcile<C: StoreConnection>(
        &mut self,
        _plan: &MaterializedPackagePlanV1,
        _store: &mut Store<C>,
        _project_root: &str,
        _operation_id: &str,
    ) -> Result<Option<EnvironmentExecutionOutcome>, String> {
        self.poll_terminal()
    }
}

fn local_terminal_outcome(terminal: &LocalTerminalObservation) -> EnvironmentExecutionOutcome {
    match terminal.reason_code.as_str() {
        "succeeded" => EnvironmentExecutionOutcome::Succeeded {
            execution_id: terminal.execution_id.clone(),
        },
        "cancelled_process_tree_confirmed" => EnvironmentExecutionOutcome::Cancelled {
            execution_id: terminal.execution_id.clone(),
        },
        _ => EnvironmentExecutionOutcome::Failed {
            execution_id: Some(terminal.execution_id.clone()),
            reason: terminal.reason_code.clone(),
        },
    }
}
