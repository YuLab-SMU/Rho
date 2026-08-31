use rho_control_plane::*;
use rho_protocol::*;
use rho_workspace::*;
use serde_json::json;

#[derive(Default)]
struct FakeIntentStore;

impl DurableIntentRecorder for FakeIntentStore {
    fn append_broker_intent(
        &mut self,
        _expected_next_seq: StreamSeq,
        _event: &SemanticEvent,
    ) -> Result<DurableIntentOutcome, BrokerError> {
        Ok(DurableIntentOutcome::Appended)
    }
}

fn initial_revision() -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_policy").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_policy").unwrap(),
        state_revision: StateRevision(4),
        project_revision: ProjectRevision(2),
    }
}

fn project_id() -> ProjectId {
    ProjectId::new("project_workspace").unwrap()
}

fn lease_and_request(operation: &str) -> (BrokerLease, WorkspaceBridgeRequest, serde_json::Value) {
    let mut store = FakeIntentStore;
    let args = json!({"code": "x <- 1"});
    let mut context = policy_context_fixture(
        CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
        OperationId::new(operation).unwrap(),
    );
    context.input.arguments = args.clone();
    let mut broker = BrokerAdmission::new(
        CapabilityRegistry::canonical().unwrap(),
        StreamId::new("stream_workspace_executor").unwrap(),
    );
    let outcome = broker
        .admit(
            &mut store,
            AdmissionRequest {
                context: context.clone(),
                normalized_arguments: args.clone(),
                now_ms: 1000,
            },
        )
        .unwrap();
    let BrokerAdmissionOutcome::Ask {
        approval_binding, ..
    } = outcome
    else {
        panic!("run_r should ask");
    };
    let lease = broker
        .lease_from_approval(
            &approval_binding.approval_id,
            &args,
            &context.expected_revisions,
            DestinationClass::LocalWorkspace,
            1001,
        )
        .unwrap();
    let request = WorkspaceBridgeRequest {
        project_id: project_id(),
        workspace_id: context.expected_revisions.workspace_id.clone(),
        kernel_instance_id: context.expected_revisions.kernel_instance_id.clone(),
        expected_revisions: context.expected_revisions,
        execution_id: ExecutionId::new(format!("execution_{operation}")).unwrap(),
        operation_id: OperationId::new(operation).unwrap(),
        now_ms: 1001,
        effect: WorkspaceEffectKind::Mutation,
    };
    (lease, request, args)
}

#[test]
fn workspace_executor_serializes_same_workspace_effects_and_allows_status_when_busy() {
    let (lease, request, args) = lease_and_request("operation_workspace_busy");
    let mut executor = WorkspaceExecutor::new(project_id(), initial_revision());
    executor.simulate_busy(JobId::new("job_busy").unwrap());

    let error = executor
        .execute(request, &lease, &args, direct_validated_bridge_fixture())
        .unwrap_err();
    assert!(matches!(error, WorkspaceExecutorError::Busy(job) if job.as_str() == "job_busy"));
    let status = executor.status();
    assert!(status.busy);
    assert!(status.message.contains("bounded status"));
}

#[test]
fn workspace_executor_rejects_wrong_workspace_and_expired_or_mismatched_lease() {
    let (lease, mut request, args) = lease_and_request("operation_workspace_auth");
    let mut executor = WorkspaceExecutor::new(project_id(), initial_revision());

    request.workspace_id = WorkspaceId::new("workspace_other").unwrap();
    assert!(matches!(
        executor.execute(
            request.clone(),
            &lease,
            &args,
            direct_validated_bridge_fixture()
        ),
        Err(WorkspaceExecutorError::WrongWorkspace)
    ));

    request.workspace_id = WorkspaceId::new("workspace_policy").unwrap();
    request.now_ms = 100_000;
    assert!(matches!(
        executor.execute(request, &lease, &args, direct_validated_bridge_fixture()),
        Err(WorkspaceExecutorError::InvalidLease)
    ));
}

#[test]
fn workspace_executor_failed_r_execution_advances_revision_instead_of_rollback() {
    let (lease, request, args) = lease_and_request("operation_workspace_failed");
    let mut executor = WorkspaceExecutor::new(project_id(), initial_revision());
    let observation = executor
        .execute(
            request,
            &lease,
            &args,
            SimulatedRResult {
                terminal: ExecutionTerminalOutcome::Failed,
                stdout: "Error: object not found".to_string(),
                conditions: vec!["error: object not found".to_string()],
                objects: Vec::new(),
            },
        )
        .unwrap();

    assert_eq!(observation.terminal, ExecutionTerminalOutcome::Failed);
    assert_eq!(
        observation.revision_transition.before.state_revision,
        StateRevision(4)
    );
    assert_eq!(
        observation.revision_transition.after.state_revision,
        StateRevision(5)
    );
}

#[test]
fn workspace_executor_disconnect_returns_uncertain_revision_aware_observation() {
    let (lease, request, args) = lease_and_request("operation_workspace_disconnect");
    let mut executor = WorkspaceExecutor::new(project_id(), initial_revision());
    let observation = executor
        .execute(
            request,
            &lease,
            &args,
            SimulatedRResult {
                terminal: ExecutionTerminalOutcome::Uncertain,
                stdout: "connection lost".to_string(),
                conditions: vec!["disconnect".to_string()],
                objects: Vec::new(),
            },
        )
        .unwrap();

    assert_eq!(observation.terminal, ExecutionTerminalOutcome::Uncertain);
    assert_eq!(
        observation.revision_transition.after.state_revision,
        StateRevision(5)
    );
}

#[test]
fn workspace_executor_normalizes_output_bounds() {
    let output = normalize_workspace_output(
        "x".repeat(MAX_WORKSPACE_STDOUT_BYTES + 10),
        (0..MAX_WORKSPACE_CONDITIONS + 10)
            .map(|idx| format!("condition_{idx}"))
            .collect(),
        (0..MAX_WORKSPACE_OBJECTS + 10)
            .map(|idx| format!("object_{idx}"))
            .collect(),
    );
    assert!(output.truncated);
    assert_eq!(output.stdout.len(), MAX_WORKSPACE_STDOUT_BYTES);
    assert_eq!(output.conditions.len(), MAX_WORKSPACE_CONDITIONS);
    assert_eq!(output.objects.len(), MAX_WORKSPACE_OBJECTS);
}

#[test]
fn workspace_executor_matches_direct_validated_bridge_fixture() {
    let (lease, request, args) = lease_and_request("operation_workspace_fixture");
    let mut executor = WorkspaceExecutor::new(project_id(), initial_revision());
    let fixture = direct_validated_bridge_fixture();
    let expected_output = normalize_workspace_output(
        fixture.stdout.clone(),
        fixture.conditions.clone(),
        fixture.objects.clone(),
    );
    let observation = executor.execute(request, &lease, &args, fixture).unwrap();
    assert_eq!(observation.output, expected_output);
}
