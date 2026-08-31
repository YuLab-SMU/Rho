#![forbid(unsafe_code)]
//! Execution controller and resource lanes.
//!
//! The controller owns job orchestration only. It does_not_own SSH, Slurm, OCI,
//! Workspace bridge command details, Agent planning, or Broker authority.

pub mod collect;
pub mod local;
pub mod oci;
pub mod process_tree;
pub mod reconcile;
pub mod remote_reconcile;
pub mod resource;
pub mod slurm;
pub mod spec;
pub mod ssh;

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use rho_protocol::{
    CancelOutcome, EffectClass, ExecutionId, ExecutionSpec, ExecutionState, JobId, JobObservation,
    OperationId, RetryClass,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> ExecutionBoundary {
    ExecutionBoundary {
        owns: &[
            "job_state_machine",
            "resource_lanes",
            "retry_orchestration",
            "restart_reconcile",
        ],
        does_not_own: &[
            "ssh_command_details",
            "slurm_command_details",
            "oci_command_details",
            "agent_plan",
            "broker_authority",
        ],
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct LaneId(String);

impl LaneId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub const WORKSPACE_R_LANE: &str = "workspace-r";
pub const PROJECT_WRITE_LANE: &str = "project-authoritative-write";
pub const AGENT_MODEL_LANE: &str = "agent-model";
pub const SANDBOX_NETWORK_LANE: &str = "sandbox-network";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreparedExecutionSpec {
    pub spec: ExecutionSpec,
    pub lane_id: LaneId,
    pub idempotency_key: String,
    pub effect_class: EffectClass,
    pub retry_class: RetryClass,
    pub submit_acknowledged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JobRecord {
    pub job_id: JobId,
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub lane_id: LaneId,
    pub state: ExecutionState,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TransitionResult {
    Advanced,
    AlreadySubmitted,
    AlreadyTerminal,
    DuplicateTerminal,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ExecutionControllerError {
    #[error("illegal job transition from {from:?} to {to:?}")]
    IllegalTransition {
        from: ExecutionState,
        to: ExecutionState,
    },
    #[error("lane {0} is unknown")]
    UnknownLane(String),
    #[error("lane {lane} is at capacity")]
    LaneAtCapacity { lane: String },
    #[error("execution {0} has already been submitted")]
    DoubleSubmit(ExecutionId),
    #[error("job {0} is unknown")]
    UnknownJob(JobId),
}

pub trait Executor {
    fn submit(&mut self, spec: &PreparedExecutionSpec) -> JobObservation;
    fn cancel(&mut self, job_id: &JobId) -> CancelOutcome;
    fn reconcile(&mut self, job_id: &JobId) -> Option<JobObservation>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceLane {
    pub lane_id: LaneId,
    pub capacity: usize,
    pub queued: VecDeque<ExecutionId>,
    pub running: BTreeSet<ExecutionId>,
}

impl ResourceLane {
    pub fn new(lane_id: LaneId, capacity: usize) -> Self {
        Self {
            lane_id,
            capacity,
            queued: VecDeque::new(),
            running: BTreeSet::new(),
        }
    }

    fn enqueue(&mut self, execution_id: ExecutionId) {
        self.queued.push_back(execution_id);
    }

    fn can_start(&self) -> bool {
        self.running.len() < self.capacity
    }

    fn start_next(&mut self) -> Option<ExecutionId> {
        if !self.can_start() {
            return None;
        }
        let execution_id = self.queued.pop_front()?;
        self.running.insert(execution_id.clone());
        Some(execution_id)
    }

    fn finish(&mut self, execution_id: &ExecutionId) {
        self.running.remove(execution_id);
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExecutionController {
    lanes: BTreeMap<LaneId, ResourceLane>,
    jobs: BTreeMap<JobId, JobRecord>,
    execution_to_job: BTreeMap<ExecutionId, JobId>,
}

impl ExecutionController {
    pub fn with_default_lanes(
        agent_model_capacity: usize,
        sandbox_network_capacity: usize,
    ) -> Self {
        let mut controller = Self::default();
        controller.add_lane(LaneId::new(WORKSPACE_R_LANE), 1);
        controller.add_lane(LaneId::new(PROJECT_WRITE_LANE), 1);
        controller.add_lane(LaneId::new(AGENT_MODEL_LANE), agent_model_capacity.max(1));
        controller.add_lane(
            LaneId::new(SANDBOX_NETWORK_LANE),
            sandbox_network_capacity.max(1),
        );
        controller
    }

    pub fn add_lane(&mut self, lane_id: LaneId, capacity: usize) {
        self.lanes
            .insert(lane_id.clone(), ResourceLane::new(lane_id, capacity.max(1)));
    }

    pub fn prepare(
        &mut self,
        job_id: JobId,
        prepared: PreparedExecutionSpec,
    ) -> Result<(), ExecutionControllerError> {
        if self
            .execution_to_job
            .contains_key(&prepared.spec.execution_id)
        {
            return Err(ExecutionControllerError::DoubleSubmit(
                prepared.spec.execution_id,
            ));
        }
        let lane = self.lanes.get_mut(&prepared.lane_id).ok_or_else(|| {
            ExecutionControllerError::UnknownLane(prepared.lane_id.as_str().to_string())
        })?;
        lane.enqueue(prepared.spec.execution_id.clone());
        self.execution_to_job
            .insert(prepared.spec.execution_id.clone(), job_id.clone());
        self.jobs.insert(
            job_id.clone(),
            JobRecord {
                job_id,
                execution_id: prepared.spec.execution_id,
                operation_id: prepared.spec.operation_id,
                lane_id: prepared.lane_id,
                state: ExecutionState::Prepared,
                idempotency_key: prepared.idempotency_key,
            },
        );
        Ok(())
    }

    pub fn start_ready(&mut self) -> Vec<JobId> {
        let lane_ids = self.lanes.keys().cloned().collect::<Vec<_>>();
        let mut started = Vec::new();
        for lane_id in lane_ids {
            let Some(lane) = self.lanes.get_mut(&lane_id) else {
                continue;
            };
            if let Some(execution_id) = lane.start_next()
                && let Some(job_id) = self.execution_to_job.get(&execution_id).cloned()
            {
                if let Some(job) = self.jobs.get_mut(&job_id) {
                    job.state = ExecutionState::Running;
                }
                started.push(job_id);
            }
        }
        started
    }

    pub fn transition_job(
        &mut self,
        job_id: &JobId,
        next: ExecutionState,
    ) -> Result<TransitionResult, ExecutionControllerError> {
        let job = self
            .jobs
            .get_mut(job_id)
            .ok_or_else(|| ExecutionControllerError::UnknownJob(job_id.clone()))?;
        let current = job.state;
        let result = validate_transition(current, next)?;
        if matches!(result, TransitionResult::Advanced) {
            job.state = next;
            if next.is_terminal()
                && let Some(lane) = self.lanes.get_mut(&job.lane_id)
            {
                lane.finish(&job.execution_id);
            }
        }
        Ok(result)
    }

    pub fn cancel(&mut self, job_id: &JobId) -> Result<CancelOutcome, ExecutionControllerError> {
        let state = self
            .jobs
            .get(job_id)
            .ok_or_else(|| ExecutionControllerError::UnknownJob(job_id.clone()))?
            .state;
        if state.is_terminal() {
            return Ok(CancelOutcome::AlreadyTerminal);
        }
        self.transition_job(job_id, ExecutionState::Cancelled)?;
        Ok(CancelOutcome::Cancelled)
    }

    pub fn non_terminal_jobs_for_reconcile(&self) -> Vec<JobRecord> {
        self.jobs
            .values()
            .filter(|job| !job.state.is_terminal())
            .cloned()
            .collect()
    }

    pub fn rebuild_from_store_records(records: Vec<JobRecord>) -> Self {
        let mut controller = Self::with_default_lanes(1, 2);
        controller.jobs.clear();
        controller.execution_to_job.clear();
        for record in records {
            controller
                .execution_to_job
                .insert(record.execution_id.clone(), record.job_id.clone());
            controller.jobs.insert(record.job_id.clone(), record);
        }
        controller
    }

    pub fn job(&self, job_id: &JobId) -> Option<&JobRecord> {
        self.jobs.get(job_id)
    }

    pub fn lane(&self, lane_id: &LaneId) -> Option<&ResourceLane> {
        self.lanes.get(lane_id)
    }
}

pub fn validate_transition(
    current: ExecutionState,
    next: ExecutionState,
) -> Result<TransitionResult, ExecutionControllerError> {
    if current.is_terminal() {
        if current == next {
            return Ok(TransitionResult::DuplicateTerminal);
        }
        if next == ExecutionState::Running
            || next == ExecutionState::Submitted
            || next == ExecutionState::Queued
        {
            return Err(ExecutionControllerError::IllegalTransition {
                from: current,
                to: next,
            });
        }
        return Ok(TransitionResult::AlreadyTerminal);
    }
    if current == ExecutionState::Submitted && next == ExecutionState::Submitted {
        return Ok(TransitionResult::AlreadySubmitted);
    }
    Ok(TransitionResult::Advanced)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RetryStage {
    BeforeSubmit,
    AfterSubmitAck,
    AfterTerminalFailure,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RetryDecision {
    RetryInfrastructure,
    RetrySemantic,
    DoNotReplay,
}

pub fn retry_decision(
    retry_class: RetryClass,
    stage: RetryStage,
    outcome_unknown: bool,
) -> RetryDecision {
    match (retry_class, stage, outcome_unknown) {
        (RetryClass::NonIdempotent, RetryStage::AfterSubmitAck, true) => RetryDecision::DoNotReplay,
        (RetryClass::NonIdempotent, _, _) => RetryDecision::DoNotReplay,
        (RetryClass::PureRead, RetryStage::BeforeSubmit, _) => RetryDecision::RetryInfrastructure,
        (RetryClass::PureRead, _, _) => RetryDecision::RetrySemantic,
        (RetryClass::IdempotentWrite, RetryStage::AfterSubmitAck, true) => {
            RetryDecision::RetryInfrastructure
        }
        (RetryClass::IdempotentWrite, _, _) => RetryDecision::RetrySemantic,
        (RetryClass::ConditionallyIdempotent, RetryStage::AfterSubmitAck, true) => {
            RetryDecision::DoNotReplay
        }
        (RetryClass::ConditionallyIdempotent, _, _) => RetryDecision::RetrySemantic,
    }
}
