use rho_control_plane::*;
use rho_protocol::*;
use rho_workspace::*;
use serde_json::json;
use sha2::{Digest, Sha256};

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

fn authority_digest(value: char) -> AuthorityDigest {
    AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
}

fn environment_binding_receipt(
    operation: &str,
    restart_required: bool,
) -> (WorkspaceEnvironmentBindingV1, EnvironmentOperationReceiptV1) {
    let desired_after = EnvironmentDesiredRevisionId::new("env_desired_workspace_after").unwrap();
    let realization_after =
        EnvironmentRealizationRevisionId::new("env_realized_workspace_after").unwrap();
    let receipt = EnvironmentOperationReceiptV1 {
        receipt_id: EnvironmentReceiptId::new(format!("environment_receipt_{operation}")).unwrap(),
        operation_id: OperationId::new(operation).unwrap(),
        plan_id: EnvironmentPlanId::new(format!("environment_plan_{operation}")).unwrap(),
        actor_id: "user".to_string(),
        approval_effect_digest: authority_digest('a'),
        desired_before: EnvironmentDesiredRevisionId::new("env_desired_workspace_before").unwrap(),
        desired_after: Some(desired_after.clone()),
        realization_before: EnvironmentRealizationRevisionId::new("env_realized_workspace_before")
            .unwrap(),
        realization_after: Some(realization_after.clone()),
        checkpoints: vec![EnvironmentCheckpointV1 {
            name: "verified".to_string(),
            reached_at: "2026-09-01T12:00:00Z".to_string(),
            digest: Some(authority_digest('b')),
        }],
        execution_refs: Vec::new(),
        verification_refs: vec!["namespace:verified".to_string()],
        outcome: EnvironmentOperationOutcomeV1::Succeeded,
        partial_effects_possible: false,
        restart_required,
        recorded_at: "2026-09-01T12:00:01Z".to_string(),
    };
    let receipt_digest = AuthorityDigest::new(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&receipt).unwrap())
    ))
    .unwrap();
    (
        WorkspaceEnvironmentBindingV1 {
            environment_id: EnvironmentId::new("environment_workspace").unwrap(),
            desired_revision: desired_after,
            realization_revision: realization_after,
            receipt_digest,
        },
        receipt,
    )
}

fn environment_observation(
    kernel: &str,
    binding: WorkspaceEnvironmentBindingV1,
    passed: bool,
) -> WorkspaceEnvironmentObservation {
    WorkspaceEnvironmentObservation {
        kernel_instance_id: KernelInstanceId::new(kernel).unwrap(),
        binding: binding.clone(),
        probes: vec![WorkspaceEnvironmentProbeObservation {
            probe_id: "probe_namespace_deseq2".to_string(),
            kind: "namespace_load".to_string(),
            passed,
            detail: if passed {
                "DESeq2@1.50.0 loaded".to_string()
            } else {
                "DESeq2 namespace failed".to_string()
            },
        }],
        incidents: if passed {
            Vec::new()
        } else {
            vec![EnvironmentIncidentV1 {
                incident_id: "environment_incident_namespace_deseq2".to_string(),
                environment_id: binding.environment_id,
                kind: "namespace_load_failure".to_string(),
                subject: "DESeq2".to_string(),
                detail: "DESeq2 namespace failed after Workspace restart".to_string(),
                observed_desired_revision: Some(binding.desired_revision),
                observed_realization_revision: Some(binding.realization_revision),
                detected_at: "2026-09-01T12:01:00Z".to_string(),
            }]
        },
        observed_at: "2026-09-01T12:01:00Z".to_string(),
    }
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
        environment_binding: None,
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
fn verified_environment_requires_new_kernel_and_reobservation_before_execution() {
    let (lease, request, args) = lease_and_request("operation_workspace_environment_gate");
    let mut executor = WorkspaceExecutor::new(project_id(), initial_revision());
    let (binding, receipt) =
        environment_binding_receipt("operation_workspace_environment_change", true);
    let staged = executor
        .stage_environment_binding(binding.clone(), &receipt)
        .unwrap();
    assert_eq!(staged.phase, WorkspaceEnvironmentPhase::RestartRequired);
    assert!(matches!(
        executor.execute(request, &lease, &args, direct_validated_bridge_fixture()),
        Err(WorkspaceExecutorError::Environment(
            WorkspaceEnvironmentError::RestartRequired
        ))
    ));

    let restart = executor
        .restart_for_environment(KernelInstanceId::new("kernel_environment_restarted").unwrap())
        .unwrap();
    assert_eq!(
        restart
            .revision_transition
            .before
            .kernel_instance_id
            .as_str(),
        "kernel_policy"
    );
    assert_eq!(
        restart
            .revision_transition
            .after
            .kernel_instance_id
            .as_str(),
        "kernel_environment_restarted"
    );
    assert!(!restart.replay_failed_expression);
    assert!(executor.status().environment.reobserve_required);

    let observed = executor
        .reobserve_environment(environment_observation(
            "kernel_environment_restarted",
            binding.clone(),
            true,
        ))
        .unwrap();
    assert!(matches!(
        observed,
        WorkspaceEnvironmentReobservation::Activated { binding: active }
            if active == binding
    ));
    assert_eq!(
        executor.status().environment.phase,
        WorkspaceEnvironmentPhase::Active
    );
}

#[test]
fn package_incident_keeps_workspace_blocked_until_a_fresh_probe_passes() {
    let mut executor = WorkspaceExecutor::new(project_id(), initial_revision());
    let (binding, receipt) =
        environment_binding_receipt("operation_workspace_environment_incident", true);
    executor
        .stage_environment_binding(binding.clone(), &receipt)
        .unwrap();
    executor
        .restart_for_environment(KernelInstanceId::new("kernel_environment_incident").unwrap())
        .unwrap();
    let blocked = executor
        .reobserve_environment(environment_observation(
            "kernel_environment_incident",
            binding.clone(),
            false,
        ))
        .unwrap();
    assert!(matches!(
        blocked,
        WorkspaceEnvironmentReobservation::Blocked { incidents }
            if incidents.len() == 1 && incidents[0].kind == "namespace_load_failure"
    ));
    assert_eq!(
        executor.status().environment.phase,
        WorkspaceEnvironmentPhase::BlockedByIncident
    );

    executor
        .reobserve_environment(environment_observation(
            "kernel_environment_incident",
            binding,
            true,
        ))
        .unwrap();
    assert_eq!(
        executor.status().environment.phase,
        WorkspaceEnvironmentPhase::Active
    );
    assert!(executor.status().environment.incidents.is_empty());
}

#[test]
fn workspace_rejects_unverified_or_tampered_environment_binding() {
    let mut executor = WorkspaceExecutor::new(project_id(), initial_revision());
    let (mut binding, receipt) =
        environment_binding_receipt("operation_workspace_environment_tamper", true);
    binding.receipt_digest = authority_digest('f');
    assert!(matches!(
        executor.stage_environment_binding(binding, &receipt),
        Err(WorkspaceExecutorError::Environment(
            WorkspaceEnvironmentError::ReceiptBindingMismatch
        ))
    ));
    assert_eq!(
        executor.status().environment.phase,
        WorkspaceEnvironmentPhase::Unbound
    );
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
