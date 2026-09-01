use rho_control_plane::*;
use rho_protocol::*;
use rho_store::{EnvironmentStateCommit, SemanticStore, Store};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

#[cfg(unix)]
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, time::Duration};

#[cfg(unix)]
use rho_execution::local::{LocalExecutionSpec, LocalProcessExecutor, local_executable_digest};

fn digest(value: char) -> AuthorityDigest {
    AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
}

fn plan() -> MaterializedPackagePlanV1 {
    let environment_id = EnvironmentId::new("environment_operation_test").unwrap();
    MaterializedPackagePlanV1::new(MaterializedPackagePlanBodyV1 {
        contract_version: ENVIRONMENT_CONTRACT_VERSION,
        environment: EnvironmentIdentityV1 {
            environment_id: environment_id.clone(),
            role: EnvironmentRoleV1::NativeUser,
            project_id: Some(ProjectId::new("project_environment_operation").unwrap()),
            target_id: "local".to_string(),
            execution_profile_id: ExecutionProfileId::new("execution_profile_local").unwrap(),
        },
        expected_before: ExpectedEnvironmentStateV1 {
            environment_id,
            desired_revision: EnvironmentDesiredRevisionId::new("env_desired_before").unwrap(),
            realization_revision: EnvironmentRealizationRevisionId::new("env_realized_before")
                .unwrap(),
            project_revision: Some(2),
            repository_profile_digest: digest('a'),
        },
        intent: PackageIntentV1::InstallUserPackage,
        runtime: RuntimeRealizationV1 {
            runtime_id: RuntimeRealizationId::new("runtime_realization_test").unwrap(),
            requirement: RuntimeRequirementV1 {
                distribution: RuntimeDistributionV1::R,
                exact_version: "4.5.2".to_string(),
                platform: "test".to_string(),
                architecture: "test".to_string(),
            },
            ownership: RuntimeOwnershipV1::System,
            support_tier: RuntimeSupportTierV1::Verified,
            executable: "/runtime/Rscript".to_string(),
            runtime_home: "/runtime".to_string(),
            executable_digest: digest('b'),
            build_fingerprint: digest('c'),
            compiler_fingerprint: None,
        },
        library_stack: LibraryStackV1::new(vec![LibraryLayerV1 {
            layer_id: LibraryLayerId::new("library_user_operation").unwrap(),
            kind: LibraryLayerKindV1::User,
            owner: LibraryOwnerV1::User,
            mutability: LibraryMutabilityV1::UserWritable,
            canonical_path: "/runtime/library".to_string(),
            priority: 1,
            filesystem_identity: "fs:operation-user".to_string(),
        }])
        .unwrap(),
        repository_profile: RepositoryProfileV1 {
            profile_id: RepositoryProfileId::new("repository_profile_test").unwrap(),
            repositories: vec![RepositoryEndpointV1 {
                name: "fixture".to_string(),
                url: "file:///fixtures/mini-cran".to_string(),
                priority: 1,
            }],
            bioconductor_version: None,
            snapshot: None,
            binary_preference: "prefer_binary".to_string(),
            source_fallback_policy: "deny".to_string(),
            offline_policy: "offline".to_string(),
            proxy_profile_ref: None,
            trust_bundle_ref: None,
            credential_refs: Vec::new(),
            allowed_origins: vec!["file:///fixtures".to_string()],
        },
        package_actions: vec![PackageActionV1 {
            package: "DESeq2".to_string(),
            kind: PackageActionKindV1::Install,
            from_version: None,
            to_version: Some("1.50.0".to_string()),
            source: "file:///fixtures/mini-cran/DESeq2.tar.gz".to_string(),
            repository: Some("fixture".to_string()),
            form: PackageFormV1::Source,
            artifact_digest: digest('d'),
            artifact_byte_size: 42,
        }],
        native_requirement_actions: Vec::new(),
        toolchain_actions: Vec::new(),
        lockfile_action: None,
        artifact_digests: vec![digest('d')],
        network_intents: Vec::new(),
        secret_requirements: Vec::new(),
        verification_probes: vec![EnvironmentVerificationProbeV1 {
            probe_id: "probe_namespace_load".to_string(),
            kind: "namespace_load".to_string(),
            expected: "DESeq2@1.50.0".to_string(),
        }],
        restart_required: true,
        expires_at: "2026-09-02T00:00:00Z".to_string(),
    })
    .unwrap()
}

fn admission(
    directory: &TempDir,
    plan: &MaterializedPackagePlanV1,
    operation_id: &str,
) -> (BrokerLease, ExpectedRevisions) {
    let database = directory
        .path()
        .join(format!("broker-{operation_id}.sqlite"));
    let (mut semantic_store, _) =
        SemanticStore::open_app_local(directory.path(), &database).unwrap();
    let operation_id = OperationId::new(operation_id).unwrap();
    let capability = CapabilityId::new(ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY).unwrap();
    let mut context = policy_context_fixture(capability, operation_id.clone());
    let expected = context.expected_revisions.clone();
    let arguments = environment_plan_arguments(plan, &expected);
    context.input.arguments = arguments.clone();
    context.input.destination = DestinationClass::LocalWorkspace;
    let mut broker = BrokerAdmission::new(
        CapabilityRegistry::canonical().unwrap(),
        StreamId::new(format!("stream_{operation_id}")).unwrap(),
    );
    let BrokerAdmissionOutcome::Ask {
        approval_binding, ..
    } = broker
        .admit(
            &mut semantic_store,
            AdmissionRequest {
                context,
                normalized_arguments: arguments.clone(),
                now_ms: 1_000,
            },
        )
        .unwrap()
    else {
        panic!("Environment mutation must require exact approval");
    };
    let lease = broker
        .lease_from_approval(
            &approval_binding.approval_id,
            &arguments,
            &expected,
            DestinationClass::LocalWorkspace,
            1_001,
        )
        .unwrap();
    let mut authority = Store::open(directory.path().join("authority.sqlite")).unwrap();
    authority
        .record_environment_plan_for_review("/projects/environment-operation", plan)
        .unwrap();
    authority
        .approve_environment_plan(
            "/projects/environment-operation",
            plan.plan_id.as_str(),
            lease.opaque_id(),
            lease.operation_id().as_str(),
        )
        .unwrap();
    (lease, expected)
}

fn request(
    plan: MaterializedPackagePlanV1,
    expected: ExpectedRevisions,
) -> EnvironmentApplyRequest {
    EnvironmentApplyRequest {
        project_root: "/projects/environment-operation".to_string(),
        plan,
        expected_revisions: expected,
        destination: DestinationClass::LocalWorkspace,
        now_ms: 1_002,
    }
}

#[derive(Clone)]
struct FakeExecution {
    execute_outcome: EnvironmentExecutionOutcome,
    reconcile_outcome: Option<EnvironmentExecutionOutcome>,
    execute_calls: usize,
    reconcile_calls: usize,
}

impl EnvironmentExecutionPort for FakeExecution {
    fn execute<C: rho_store::StoreConnection>(
        &mut self,
        _plan: &MaterializedPackagePlanV1,
        _store: &mut Store<C>,
        _project_root: &str,
        _operation_id: &str,
    ) -> Result<EnvironmentExecutionOutcome, String> {
        self.execute_calls += 1;
        Ok(self.execute_outcome.clone())
    }

    fn reconcile<C: rho_store::StoreConnection>(
        &mut self,
        _plan: &MaterializedPackagePlanV1,
        _store: &mut Store<C>,
        _project_root: &str,
        _operation_id: &str,
    ) -> Result<Option<EnvironmentExecutionOutcome>, String> {
        self.reconcile_calls += 1;
        Ok(self.reconcile_outcome.clone())
    }
}

struct CommitVerifier {
    project_root: String,
    operation_id: OperationId,
    mismatch_project: bool,
}

impl EnvironmentCommitVerifier for CommitVerifier {
    fn verify(
        &mut self,
        plan: &MaterializedPackagePlanV1,
        execution_id: &ExecutionId,
    ) -> Result<EnvironmentStateCommit, String> {
        let desired = EnvironmentDesiredRevisionV1 {
            revision_id: EnvironmentDesiredRevisionId::new("env_desired_after").unwrap(),
            core_manifest_digest: None,
            renv_lock_digest: None,
            repository_profile_digest: digest('a'),
            execution_profile_digest: digest('e'),
            ownership_policy_digest: digest('f'),
        };
        let realization = EnvironmentRealizationRevisionV1 {
            revision_id: EnvironmentRealizationRevisionId::new("env_realized_after").unwrap(),
            runtime_id: plan.body.runtime.runtime_id.clone(),
            library_stack_digest: digest('1'),
            package_inventory_digest: digest('2'),
            native_fingerprint: digest('3'),
            target_realization_digest: digest('4'),
        };
        let receipt = EnvironmentOperationReceiptV1 {
            receipt_id: EnvironmentReceiptId::new("environment_receipt_operation").unwrap(),
            operation_id: self.operation_id.clone(),
            plan_id: plan.plan_id.clone(),
            actor_id: "user".to_string(),
            approval_effect_digest: digest('5'),
            desired_before: plan.body.expected_before.desired_revision.clone(),
            desired_after: Some(desired.revision_id.clone()),
            realization_before: plan.body.expected_before.realization_revision.clone(),
            realization_after: Some(realization.revision_id.clone()),
            checkpoints: vec![EnvironmentCheckpointV1 {
                name: "namespace_verified".to_string(),
                reached_at: "2026-09-01T12:00:00Z".to_string(),
                digest: Some(digest('6')),
            }],
            execution_refs: vec![execution_id.clone()],
            verification_refs: vec!["probe_namespace_load:passed".to_string()],
            outcome: EnvironmentOperationOutcomeV1::Succeeded,
            partial_effects_possible: false,
            restart_required: plan.body.restart_required,
            recorded_at: "2026-09-01T12:00:01Z".to_string(),
        };
        let receipt_digest = AuthorityDigest::new(format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&receipt).unwrap())
        ))
        .unwrap();
        Ok(EnvironmentStateCommit {
            project_root: if self.mismatch_project {
                "/projects/wrong".to_string()
            } else {
                self.project_root.clone()
            },
            environment: plan.body.environment.clone(),
            desired: desired.clone(),
            realization: realization.clone(),
            receipt,
            binding: WorkspaceEnvironmentBindingV1 {
                environment_id: plan.body.environment.environment_id.clone(),
                desired_revision: desired.revision_id,
                realization_revision: realization.revision_id,
                receipt_digest,
            },
        })
    }
}

fn execution_id() -> ExecutionId {
    ExecutionId::new("execution_environment_operation").unwrap()
}

#[test]
fn broker_leased_execution_verifies_and_commits_once() {
    let directory = tempfile::tempdir().unwrap();
    let plan = plan();
    let (lease, expected) = admission(&directory, &plan, "operation_environment_success");
    let request = request(plan, expected);
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    let mut execution = FakeExecution {
        execute_outcome: EnvironmentExecutionOutcome::Succeeded {
            execution_id: execution_id(),
        },
        reconcile_outcome: None,
        execute_calls: 0,
        reconcile_calls: 0,
    };
    let mut verifier = CommitVerifier {
        project_root: request.project_root.clone(),
        operation_id: lease.operation_id().clone(),
        mismatch_project: false,
    };

    let outcome = EnvironmentOperationCoordinator::apply(
        &mut store,
        &lease,
        &request,
        &mut execution,
        &mut verifier,
    )
    .unwrap();
    assert_eq!(outcome.status, "succeeded");
    assert!(outcome.projection.is_some());
    assert_eq!(outcome.journal.plan, request.plan);
    assert_eq!(
        outcome
            .journal
            .checkpoints
            .iter()
            .map(|checkpoint| checkpoint.name.as_str())
            .collect::<Vec<_>>(),
        ["admitted", "executed", "verified", "committed"]
    );
    assert!(
        store
            .current_environment_state(&request.project_root)
            .unwrap()
            .is_some()
    );

    let repeated = EnvironmentOperationCoordinator::apply(
        &mut store,
        &lease,
        &request,
        &mut execution,
        &mut verifier,
    )
    .unwrap();
    assert_eq!(repeated.status, "succeeded");
    assert_eq!(execution.execute_calls, 1);
}

#[test]
fn mismatched_or_expired_lease_creates_no_operation() {
    let directory = tempfile::tempdir().unwrap();
    let plan = plan();
    let (lease, expected) = admission(&directory, &plan, "operation_environment_rejected");
    let mut request = request(plan, expected);
    request.now_ms = 100_000;
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    let mut execution = FakeExecution {
        execute_outcome: EnvironmentExecutionOutcome::Succeeded {
            execution_id: execution_id(),
        },
        reconcile_outcome: None,
        execute_calls: 0,
        reconcile_calls: 0,
    };
    let mut verifier = CommitVerifier {
        project_root: request.project_root.clone(),
        operation_id: lease.operation_id().clone(),
        mismatch_project: false,
    };
    assert!(matches!(
        EnvironmentOperationCoordinator::apply(
            &mut store,
            &lease,
            &request,
            &mut execution,
            &mut verifier,
        ),
        Err(EnvironmentOperationError::LeaseMismatch)
    ));
    assert!(
        store
            .current_environment_operation_id(&request.project_root, request.plan.plan_id.as_str())
            .unwrap()
            .is_none()
    );
    assert_eq!(execution.execute_calls, 0);
}

#[test]
fn verifier_identity_mismatch_fails_without_binding() {
    let directory = tempfile::tempdir().unwrap();
    let plan = plan();
    let (lease, expected) = admission(&directory, &plan, "operation_environment_tampered");
    let request = request(plan, expected);
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    let mut execution = FakeExecution {
        execute_outcome: EnvironmentExecutionOutcome::Succeeded {
            execution_id: execution_id(),
        },
        reconcile_outcome: None,
        execute_calls: 0,
        reconcile_calls: 0,
    };
    let mut verifier = CommitVerifier {
        project_root: request.project_root.clone(),
        operation_id: lease.operation_id().clone(),
        mismatch_project: true,
    };
    assert!(matches!(
        EnvironmentOperationCoordinator::apply(
            &mut store,
            &lease,
            &request,
            &mut execution,
            &mut verifier,
        ),
        Err(EnvironmentOperationError::Verification(_))
    ));
    assert!(
        store
            .current_environment_state(&request.project_root)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .get_environment_operation_journal(&request.project_root, lease.operation_id().as_str())
            .unwrap()
            .unwrap()
            .status,
        "failed"
    );
}

#[test]
fn uncertain_execution_reconciles_without_resubmission() {
    let directory = tempfile::tempdir().unwrap();
    let plan = plan();
    let (lease, expected) = admission(&directory, &plan, "operation_environment_reconcile");
    let request = request(plan, expected);
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    let mut execution = FakeExecution {
        execute_outcome: EnvironmentExecutionOutcome::Uncertain {
            execution_id: Some(execution_id()),
            reason: "ack_lost".to_string(),
        },
        reconcile_outcome: Some(EnvironmentExecutionOutcome::Succeeded {
            execution_id: execution_id(),
        }),
        execute_calls: 0,
        reconcile_calls: 0,
    };
    let mut verifier = CommitVerifier {
        project_root: request.project_root.clone(),
        operation_id: lease.operation_id().clone(),
        mismatch_project: false,
    };
    let uncertain = EnvironmentOperationCoordinator::apply(
        &mut store,
        &lease,
        &request,
        &mut execution,
        &mut verifier,
    )
    .unwrap();
    assert_eq!(uncertain.status, "uncertain");
    assert!(uncertain.projection.is_none());

    let reconciled = EnvironmentOperationCoordinator::reconcile(
        &mut store,
        &request,
        &mut execution,
        &mut verifier,
    )
    .unwrap();
    assert_eq!(reconciled.status, "succeeded");
    assert_eq!(execution.execute_calls, 1);
    assert_eq!(execution.reconcile_calls, 1);
}

#[test]
fn confirmed_cancellation_is_terminal_without_authority_binding() {
    let directory = tempfile::tempdir().unwrap();
    let plan = plan();
    let (lease, expected) = admission(&directory, &plan, "operation_environment_cancelled");
    let request = request(plan, expected);
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    let mut execution = FakeExecution {
        execute_outcome: EnvironmentExecutionOutcome::Cancelled {
            execution_id: execution_id(),
        },
        reconcile_outcome: None,
        execute_calls: 0,
        reconcile_calls: 0,
    };
    let mut verifier = CommitVerifier {
        project_root: request.project_root.clone(),
        operation_id: lease.operation_id().clone(),
        mismatch_project: false,
    };
    let outcome = EnvironmentOperationCoordinator::apply(
        &mut store,
        &lease,
        &request,
        &mut execution,
        &mut verifier,
    )
    .unwrap();
    assert_eq!(outcome.status, "cancelled");
    assert!(outcome.projection.is_none());
    assert!(
        store
            .current_environment_state(&request.project_root)
            .unwrap()
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn local_environment_port_uses_execution_lifecycle_and_durable_submit_checkpoints() {
    let directory = tempfile::tempdir().unwrap();
    let plan = plan();
    let (lease, expected) = admission(&directory, &plan, "operation_environment_local_port");
    let request = request(plan, expected);
    let executable = directory.path().join("environment-worker");
    fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let working = directory.path().join("working");
    fs::create_dir(&working).unwrap();
    fs::set_permissions(&working, fs::Permissions::from_mode(0o555)).unwrap();
    let staging = directory.path().join("staging");
    fs::create_dir(&staging).unwrap();
    let execution_id = ExecutionId::new("execution_environment_local_port").unwrap();
    let prepared = LocalProcessExecutor::prepare(LocalExecutionSpec {
        execution_id: execution_id.clone(),
        operation_id: lease.operation_id().clone(),
        executable: executable.clone(),
        executable_sha256: local_executable_digest(&executable).unwrap(),
        argv: Vec::new(),
        working_set_root: working.clone(),
        working_directory: working,
        input_artifacts: Vec::new(),
        output_staging: staging.clone(),
        environment: BTreeMap::from([
            ("HOME".to_string(), staging.display().to_string()),
            ("TMPDIR".to_string(), staging.display().to_string()),
        ]),
        secret_lease_ids: Vec::new(),
        network_profile: "deny".to_string(),
        effect_class: EffectClass::ExternalEffect,
        retry_class: RetryClass::NonIdempotent,
        timeout_ms: 1_000,
    })
    .unwrap();
    let mut execution =
        LocalEnvironmentExecutionPort::new(prepared, Duration::from_millis(5), 200).unwrap();
    let mut verifier = CommitVerifier {
        project_root: request.project_root.clone(),
        operation_id: lease.operation_id().clone(),
        mismatch_project: false,
    };
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    let outcome = EnvironmentOperationCoordinator::apply(
        &mut store,
        &lease,
        &request,
        &mut execution,
        &mut verifier,
    )
    .unwrap();
    assert_eq!(outcome.status, "succeeded");
    let names = outcome
        .journal
        .checkpoints
        .iter()
        .map(|checkpoint| checkpoint.name.as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"process_submit_intent"));
    assert!(names.contains(&"process_handle"));
}
