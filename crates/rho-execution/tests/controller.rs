use rho_execution::*;
use rho_protocol::*;

fn spec(id: &str, lane: &str, retry_class: RetryClass) -> PreparedExecutionSpec {
    let execution_id = ExecutionId::new(format!("execution_{id}")).unwrap();
    let operation_id = OperationId::new(format!("operation_{id}")).unwrap();
    PreparedExecutionSpec {
        spec: ExecutionSpec::new(
            execution_id,
            operation_id,
            ExecutorKind::LocalProcess,
            vec!["rho-runner".to_string()],
        ),
        lane_id: LaneId::new(lane),
        idempotency_key: format!("idem_{id}"),
        effect_class: EffectClass::WorkspaceMutation,
        retry_class,
        submit_acknowledged: false,
    }
}

#[test]
fn controller_rejects_illegal_terminal_to_running_and_handles_cancel_after_terminal() {
    let mut controller = ExecutionController::with_default_lanes(1, 1);
    let job_id = JobId::new("job_terminal").unwrap();
    controller
        .prepare(
            job_id.clone(),
            spec("terminal", WORKSPACE_R_LANE, RetryClass::NonIdempotent),
        )
        .unwrap();
    controller.start_ready();
    controller
        .transition_job(&job_id, ExecutionState::Succeeded)
        .unwrap();

    assert!(matches!(
        controller.transition_job(&job_id, ExecutionState::Running),
        Err(ExecutionControllerError::IllegalTransition { .. })
    ));
    assert_eq!(
        controller.cancel(&job_id).unwrap(),
        CancelOutcome::AlreadyTerminal
    );
}

#[test]
fn controller_double_submit_has_explicit_result() {
    let mut controller = ExecutionController::with_default_lanes(1, 1);
    controller
        .prepare(
            JobId::new("job_one").unwrap(),
            spec("same", WORKSPACE_R_LANE, RetryClass::NonIdempotent),
        )
        .unwrap();
    assert!(matches!(
        controller.prepare(
            JobId::new("job_two").unwrap(),
            spec("same", WORKSPACE_R_LANE, RetryClass::NonIdempotent)
        ),
        Err(ExecutionControllerError::DoubleSubmit(_))
    ));
    assert_eq!(
        validate_transition(ExecutionState::Submitted, ExecutionState::Submitted).unwrap(),
        TransitionResult::AlreadySubmitted,
    );
}

#[test]
fn controller_default_lanes_serialize_workspace_and_project_writes() {
    let mut controller = ExecutionController::with_default_lanes(2, 2);
    controller
        .prepare(
            JobId::new("job_a").unwrap(),
            spec("a", WORKSPACE_R_LANE, RetryClass::NonIdempotent),
        )
        .unwrap();
    controller
        .prepare(
            JobId::new("job_b").unwrap(),
            spec("b", WORKSPACE_R_LANE, RetryClass::NonIdempotent),
        )
        .unwrap();
    let started = controller.start_ready();
    assert_eq!(started, vec![JobId::new("job_a").unwrap()]);
    let lane = controller.lane(&LaneId::new(WORKSPACE_R_LANE)).unwrap();
    assert_eq!(lane.running.len(), 1);
    assert_eq!(lane.queued.len(), 1);
}

#[test]
fn controller_fairness_starts_one_job_per_ready_lane() {
    let mut controller = ExecutionController::with_default_lanes(1, 1);
    controller
        .prepare(
            JobId::new("job_workspace").unwrap(),
            spec("workspace", WORKSPACE_R_LANE, RetryClass::NonIdempotent),
        )
        .unwrap();
    controller
        .prepare(
            JobId::new("job_network").unwrap(),
            spec(
                "network",
                SANDBOX_NETWORK_LANE,
                RetryClass::ConditionallyIdempotent,
            ),
        )
        .unwrap();
    let started = controller.start_ready();
    assert_eq!(started.len(), 2);
    assert!(started.contains(&JobId::new("job_workspace").unwrap()));
    assert!(started.contains(&JobId::new("job_network").unwrap()));
}

#[test]
fn controller_retry_separates_semantic_from_infrastructure_and_never_replays_unknown_non_idempotent()
 {
    assert_eq!(
        retry_decision(RetryClass::NonIdempotent, RetryStage::AfterSubmitAck, true),
        RetryDecision::DoNotReplay,
    );
    assert_eq!(
        retry_decision(
            RetryClass::IdempotentWrite,
            RetryStage::AfterSubmitAck,
            true
        ),
        RetryDecision::RetryInfrastructure,
    );
    assert_eq!(
        retry_decision(RetryClass::PureRead, RetryStage::BeforeSubmit, false),
        RetryDecision::RetryInfrastructure,
    );
}

#[test]
fn controller_rebuild_reconciles_only_non_terminal_jobs() {
    let running = JobRecord {
        job_id: JobId::new("job_running").unwrap(),
        execution_id: ExecutionId::new("execution_running").unwrap(),
        operation_id: OperationId::new("operation_running").unwrap(),
        lane_id: LaneId::new(WORKSPACE_R_LANE),
        state: ExecutionState::Running,
        idempotency_key: "idem_running".to_string(),
    };
    let done = JobRecord {
        job_id: JobId::new("job_done").unwrap(),
        execution_id: ExecutionId::new("execution_done").unwrap(),
        operation_id: OperationId::new("operation_done").unwrap(),
        lane_id: LaneId::new(WORKSPACE_R_LANE),
        state: ExecutionState::Succeeded,
        idempotency_key: "idem_done".to_string(),
    };
    let controller = ExecutionController::rebuild_from_store_records(vec![running.clone(), done]);
    assert_eq!(controller.non_terminal_jobs_for_reconcile(), vec![running]);
}

#[test]
fn controller_contains_no_ssh_slurm_or_oci_command_details() {
    let source = include_str!("../src/lib.rs");
    for forbidden in [
        "ssh ",
        "sbatch",
        "srun",
        "docker run",
        "apptainer exec",
        "kubectl",
    ] {
        assert!(
            !source.to_lowercase().contains(forbidden),
            "execution controller leaked command detail: {forbidden}"
        );
    }
    assert!(boundary().does_not_own.contains(&"agent_plan"));
}
