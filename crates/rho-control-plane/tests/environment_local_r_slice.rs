#![cfg(unix)]

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use rho_control_plane::*;
use rho_execution::local::{LocalExecutionSpec, LocalProcessExecutor, local_executable_digest};
use rho_protocol::*;
use rho_store::{EnvironmentStateCommit, SemanticStore, Store};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn digest_bytes(bytes: &[u8]) -> AuthorityDigest {
    AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).unwrap()
}

fn local_plan_fixture(
    project_root: &str,
    target_library: &str,
    project_revision: u64,
) -> MaterializedPackagePlanV1 {
    let digest = |value: char| {
        AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
    };
    let environment_id = EnvironmentId::new("environment_test_local").unwrap();
    MaterializedPackagePlanV1::new(MaterializedPackagePlanBodyV1 {
        contract_version: ENVIRONMENT_CONTRACT_VERSION,
        environment: EnvironmentIdentityV1 {
            environment_id: environment_id.clone(),
            role: EnvironmentRoleV1::NativeUser,
            project_id: Some(ProjectId::new("project_test_local").unwrap()),
            target_id: "local".to_string(),
            execution_profile_id: ExecutionProfileId::new("execution_profile_test_local").unwrap(),
        },
        expected_before: ExpectedEnvironmentStateV1 {
            environment_id,
            desired_revision: EnvironmentDesiredRevisionId::new("env_desired_test_before").unwrap(),
            realization_revision: EnvironmentRealizationRevisionId::new("env_realized_test_before")
                .unwrap(),
            project_revision: Some(project_revision),
            repository_profile_digest: digest('a'),
        },
        intent: PackageIntentV1::InstallUserPackage,
        runtime: RuntimeRealizationV1 {
            runtime_id: RuntimeRealizationId::new("runtime_realization_test_local").unwrap(),
            requirement: RuntimeRequirementV1 {
                distribution: RuntimeDistributionV1::R,
                exact_version: "4.5.2".to_string(),
                platform: std::env::consts::OS.to_string(),
                architecture: std::env::consts::ARCH.to_string(),
            },
            ownership: RuntimeOwnershipV1::System,
            support_tier: RuntimeSupportTierV1::Verified,
            executable: "/usr/local/bin/Rscript".to_string(),
            runtime_home: "/usr/local/lib/R".to_string(),
            executable_digest: digest('b'),
            build_fingerprint: digest('c'),
            compiler_fingerprint: None,
        },
        library_stack: LibraryStackV1::new(vec![LibraryLayerV1 {
            layer_id: LibraryLayerId::new("library_user_test_local").unwrap(),
            kind: LibraryLayerKindV1::User,
            owner: LibraryOwnerV1::User,
            mutability: LibraryMutabilityV1::UserWritable,
            canonical_path: target_library.to_string(),
            priority: 1,
            filesystem_identity: format!("test:{project_root}:user-library"),
        }])
        .unwrap(),
        repository_profile: RepositoryProfileV1 {
            profile_id: RepositoryProfileId::new("repository_profile_test_local").unwrap(),
            repositories: vec![RepositoryEndpointV1 {
                name: "fixture".to_string(),
                url: "file:///fixtures/mini-cran".to_string(),
                priority: 1,
            }],
            bioconductor_version: None,
            snapshot: None,
            binary_preference: "source".to_string(),
            source_fallback_policy: "deny".to_string(),
            offline_policy: "offline".to_string(),
            proxy_profile_ref: None,
            trust_bundle_ref: None,
            credential_refs: Vec::new(),
            allowed_origins: vec!["file://".to_string()],
        },
        package_actions: vec![PackageActionV1 {
            package: "rhofixture".to_string(),
            kind: PackageActionKindV1::Install,
            from_version: None,
            to_version: Some("1.0.0".to_string()),
            source: "file:///fixtures/mini-cran/rhofixture_1.0.0.tar.gz".to_string(),
            repository: Some("fixture".to_string()),
            form: PackageFormV1::Source,
            artifact_digest: digest('e'),
            artifact_byte_size: 42,
        }],
        native_requirement_actions: Vec::new(),
        toolchain_actions: Vec::new(),
        lockfile_action: None,
        artifact_digests: vec![digest('e')],
        network_intents: Vec::new(),
        secret_requirements: Vec::new(),
        verification_probes: vec![EnvironmentVerificationProbeV1 {
            probe_id: "probe_namespace_rhofixture".to_string(),
            kind: "namespace_load".to_string(),
            expected: "rhofixture@1.0.0".to_string(),
        }],
        restart_required: true,
        expires_at: "2099-01-01T00:00:00Z".to_string(),
    })
    .unwrap()
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn command_stdout(executable: &Path, arguments: &[&str]) -> String {
    let output = Command::new(executable)
        .args(arguments)
        .output()
        .expect("R probe starts");
    assert!(
        output.status.success(),
        "R probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn set_tree_read_only(path: &Path) {
    for entry in fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            set_tree_read_only(&entry.path());
        } else {
            let mut permissions = entry.metadata().unwrap().permissions();
            permissions.set_readonly(true);
            fs::set_permissions(entry.path(), permissions).unwrap();
        }
    }
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).unwrap();
}

fn package_fixture(root: &Path, r: &Path) -> PathBuf {
    let source = root.join("rhofixture");
    fs::create_dir_all(source.join("R")).unwrap();
    fs::write(
        source.join("DESCRIPTION"),
        concat!(
            "Package: rhofixture\n",
            "Type: Package\n",
            "Title: Rho Environment Fixture\n",
            "Version: 1.0.0\n",
            "Authors@R: person('Rho', 'Test', email='rho@example.invalid', role=c('aut','cre'))\n",
            "Description: A hermetic package used to verify the Environment realization lane.\n",
            "License: MIT\n",
            "Encoding: UTF-8\n"
        ),
    )
    .unwrap();
    fs::write(source.join("NAMESPACE"), "export(rho_fixture_value)\n").unwrap();
    fs::write(
        source.join("R").join("value.R"),
        "rho_fixture_value <- function() 'verified'\n",
    )
    .unwrap();
    let output = Command::new(r)
        .args(["CMD", "build", "--no-build-vignettes", "--no-manual"])
        .arg(&source)
        .current_dir(root)
        .output()
        .expect("R CMD build starts");
    assert!(
        output.status.success(),
        "R CMD build failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    root.join("rhofixture_1.0.0.tar.gz")
}

fn admitted_lease(
    directory: &TempDir,
    plan: &MaterializedPackagePlanV1,
    operation_id: OperationId,
    project_root: &str,
) -> (BrokerLease, ExpectedRevisions) {
    let database = directory.path().join("environment-semantic.sqlite");
    let (mut semantic, _) = SemanticStore::open_app_local(directory.path(), &database).unwrap();
    let capability = CapabilityId::new(ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY).unwrap();
    let mut context = policy_context_fixture(capability, operation_id);
    let expected = context.expected_revisions.clone();
    let arguments = environment_plan_arguments(plan, &expected);
    context.input.arguments = arguments.clone();
    context.input.destination = DestinationClass::LocalWorkspace;
    let mut broker = BrokerAdmission::new(
        CapabilityRegistry::canonical().unwrap(),
        StreamId::new("stream_environment_local_r_slice").unwrap(),
    );
    let BrokerAdmissionOutcome::Ask {
        approval_binding, ..
    } = broker
        .admit(
            &mut semantic,
            AdmissionRequest {
                context,
                normalized_arguments: arguments.clone(),
                now_ms: 1_000,
            },
        )
        .unwrap()
    else {
        panic!("Environment mutation must ask for exact approval")
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
        .record_environment_plan_for_review(project_root, plan)
        .unwrap();
    authority
        .approve_environment_plan(
            project_root,
            plan.plan_id.as_str(),
            lease.opaque_id(),
            lease.operation_id().as_str(),
        )
        .unwrap();
    (lease, expected)
}

struct InstalledPackageVerifier {
    project_root: String,
    staged_library: PathBuf,
    target_library: PathBuf,
    operation_id: OperationId,
    marker: PathBuf,
}

impl EnvironmentCommitVerifier for InstalledPackageVerifier {
    fn verify(
        &mut self,
        plan: &MaterializedPackagePlanV1,
        execution_id: &ExecutionId,
    ) -> Result<EnvironmentStateCommit, String> {
        let marker = fs::read_to_string(&self.marker).map_err(|error| error.to_string())?;
        if marker.trim() != "rhofixture@1.0.0:verified" {
            return Err("fixed R helper did not verify the exact namespace".to_string());
        }
        let description = fs::read(self.staged_library.join("rhofixture/DESCRIPTION"))
            .map_err(|error| error.to_string())?;
        let description_text = String::from_utf8_lossy(&description);
        if !description_text.contains("Package: rhofixture")
            || !description_text.contains("Version: 1.0.0")
        {
            return Err("staged package identity is wrong".to_string());
        }
        if self.target_library.exists() {
            return Err("target library changed after plan materialization".to_string());
        }
        fs::rename(&self.staged_library, &self.target_library)
            .map_err(|error| error.to_string())?;
        let package_inventory_digest = digest_bytes(&description);
        let desired = EnvironmentDesiredRevisionV1 {
            revision_id: EnvironmentDesiredRevisionId::new("env_desired_local_r_after").unwrap(),
            core_manifest_digest: None,
            renv_lock_digest: None,
            repository_profile_digest: plan.body.expected_before.repository_profile_digest.clone(),
            execution_profile_digest: digest_bytes(b"local-execution-profile"),
            ownership_policy_digest: digest_bytes(b"native-user-ownership"),
        };
        let realization = EnvironmentRealizationRevisionV1 {
            revision_id: EnvironmentRealizationRevisionId::new("env_realized_local_r_after")
                .unwrap(),
            runtime_id: plan.body.runtime.runtime_id.clone(),
            library_stack_digest: plan.body.library_stack.effective_digest.clone(),
            package_inventory_digest,
            native_fingerprint: digest_bytes(b"native-fixture-none"),
            target_realization_digest: digest_bytes(
                self.target_library.to_string_lossy().as_bytes(),
            ),
        };
        let receipt = EnvironmentOperationReceiptV1 {
            receipt_id: EnvironmentReceiptId::new("environment_receipt_local_r_slice").unwrap(),
            operation_id: self.operation_id.clone(),
            plan_id: plan.plan_id.clone(),
            actor_id: "user".to_string(),
            approval_effect_digest: digest_bytes(plan.plan_id.as_str().as_bytes()),
            desired_before: plan.body.expected_before.desired_revision.clone(),
            desired_after: Some(desired.revision_id.clone()),
            realization_before: plan.body.expected_before.realization_revision.clone(),
            realization_after: Some(realization.revision_id.clone()),
            checkpoints: vec![EnvironmentCheckpointV1 {
                name: "namespace_verified".to_string(),
                reached_at: "2026-09-01T12:00:00Z".to_string(),
                digest: Some(digest_bytes(marker.as_bytes())),
            }],
            execution_refs: vec![execution_id.clone()],
            verification_refs: vec!["namespace:rhofixture@1.0.0".to_string()],
            outcome: EnvironmentOperationOutcomeV1::Succeeded,
            partial_effects_possible: false,
            restart_required: true,
            recorded_at: "2026-09-01T12:00:01Z".to_string(),
        };
        let receipt_digest = digest_bytes(&serde_json::to_vec(&receipt).unwrap());
        Ok(EnvironmentStateCommit {
            project_root: self.project_root.clone(),
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

#[test]
#[ignore = "requires local R, pak, and jsonlite; run for the Environment realization gate"]
fn native_user_r_package_realizes_through_exact_broker_execution_receipt() {
    let rscript = find_on_path("Rscript").expect("Rscript is available");
    let r = find_on_path("R").expect("R is available");
    let directory = TempDir::new().unwrap();
    let project = directory.path().join("ordinary-project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("analysis.R"), "answer <- 42\n").unwrap();
    assert_eq!(
        rho_environment::classify_project_environment(&project, false),
        rho_environment::ProjectEnvironmentMode::NativeUser
    );
    assert!(!project.join("renv.lock").exists());

    let artifact = package_fixture(directory.path(), &r);
    let artifact_bytes = fs::read(&artifact).unwrap();
    let target_library = directory.path().join("user-library-realized");
    let mut body = local_plan_fixture(
        project.to_string_lossy().as_ref(),
        target_library.to_string_lossy().as_ref(),
        2,
    )
    .body;
    let rscript = rscript.canonicalize().unwrap();
    let runtime_digest = AuthorityDigest::new(local_executable_digest(&rscript).unwrap()).unwrap();
    body.runtime.executable = rscript.to_string_lossy().to_string();
    body.runtime.runtime_home = command_stdout(
        &rscript,
        &[
            "--vanilla",
            "-e",
            "cat(normalizePath(R.home(), winslash='/'))",
        ],
    );
    body.runtime.requirement.exact_version = command_stdout(
        &rscript,
        &[
            "--vanilla",
            "-e",
            "cat(paste(R.version$major,R.version$minor,sep='.'))",
        ],
    );
    body.runtime.requirement.platform =
        command_stdout(&rscript, &["--vanilla", "-e", "cat(R.version$platform)"]);
    body.runtime.requirement.architecture = command_stdout(
        &rscript,
        &[
            "--vanilla",
            "-e",
            "cat(if (is.null(R.version$arch) || !nzchar(R.version$arch)) R.version$platform else R.version$arch)",
        ],
    );
    body.runtime.executable_digest = runtime_digest.clone();
    body.runtime.build_fingerprint = runtime_digest;
    let source = format!("file://{}", artifact.to_string_lossy());
    body.repository_profile.repositories[0].url =
        format!("file://{}", directory.path().to_string_lossy());
    body.package_actions[0].source = source;
    body.package_actions[0].artifact_digest = digest_bytes(&artifact_bytes);
    body.package_actions[0].artifact_byte_size = artifact_bytes.len() as u64;
    body.artifact_digests = vec![body.package_actions[0].artifact_digest.clone()];
    let plan = MaterializedPackagePlanV1::new(body).unwrap();
    let operation_id = OperationId::new("operation_environment_local_r_slice").unwrap();
    let (lease, expected) = admitted_lease(
        &directory,
        &plan,
        operation_id.clone(),
        project.to_string_lossy().as_ref(),
    );

    let working = directory.path().join("immutable-working");
    let output = directory.path().join("operation-output");
    fs::create_dir_all(&working).unwrap();
    fs::create_dir_all(&output).unwrap();
    let environment_source = working.join("environment.R");
    fs::write(
        &environment_source,
        include_str!("../../../r/rho.environment/R/environment.R"),
    )
    .unwrap();
    let staged_artifact = working.join("rhofixture_1.0.0.tar.gz");
    fs::write(&staged_artifact, artifact_bytes).unwrap();
    let helper = working.join("apply.R");
    fs::write(
        &helper,
        concat!(
            "args <- commandArgs(trailingOnly=TRUE)\n",
            ".libPaths(c(args[[4]], .libPaths()))\n",
            "helper <- new.env(parent=baseenv())\n",
            "sys.source(args[[1]], envir=helper)\n",
            "helper$rho_environment_pak_install(args[[2]], args[[3]])\n",
            ".libPaths(c(args[[3]], .libPaths()))\n",
            "ns <- loadNamespace('rhofixture', lib.loc=args[[3]])\n",
            "value <- get('rho_fixture_value', envir=ns)()\n",
            "writeLines(sprintf('rhofixture@%s:%s', as.character(packageVersion('rhofixture', lib.loc=args[[3]])), value), args[[5]])\n"
        ),
    )
    .unwrap();
    let support_library = command_stdout(
        &rscript,
        &["--vanilla", "-e", "cat(dirname(find.package('pak')))"],
    );
    let staged_library = output.join("library");
    let marker = output.join("verified.txt");
    set_tree_read_only(&working);
    let prepared = LocalProcessExecutor::prepare(LocalExecutionSpec {
        execution_id: ExecutionId::new("execution_environment_local_r_slice").unwrap(),
        operation_id: operation_id.clone(),
        executable: rscript.clone(),
        executable_sha256: local_executable_digest(&rscript).unwrap(),
        argv: vec![
            "--vanilla".to_string(),
            helper.to_string_lossy().to_string(),
            environment_source.to_string_lossy().to_string(),
            staged_artifact.to_string_lossy().to_string(),
            staged_library.to_string_lossy().to_string(),
            support_library,
            marker.to_string_lossy().to_string(),
        ],
        working_set_root: working.clone(),
        working_directory: working,
        input_artifacts: Vec::new(),
        output_staging: output.clone(),
        environment: BTreeMap::from([
            (
                "PATH".to_string(),
                std::env::var("PATH").unwrap_or_default(),
            ),
            ("HOME".to_string(), output.to_string_lossy().to_string()),
            ("TMPDIR".to_string(), output.to_string_lossy().to_string()),
            ("R_ENVIRON_USER".to_string(), "/dev/null".to_string()),
            ("R_PROFILE_USER".to_string(), "/dev/null".to_string()),
        ]),
        secret_lease_ids: Vec::new(),
        network_profile: "deny".to_string(),
        effect_class: EffectClass::ExternalEffect,
        retry_class: RetryClass::NonIdempotent,
        timeout_ms: 120_000,
    })
    .unwrap();
    let mut execution =
        LocalEnvironmentExecutionPort::new(prepared, Duration::from_millis(10), 12_000).unwrap();
    let mut verifier = InstalledPackageVerifier {
        project_root: project.to_string_lossy().to_string(),
        staged_library,
        target_library: target_library.clone(),
        operation_id,
        marker,
    };
    let mut store = Store::open(directory.path().join("authority.sqlite")).unwrap();
    let request = EnvironmentApplyRequest {
        project_root: project.to_string_lossy().to_string(),
        plan: plan.clone(),
        expected_revisions: expected,
        destination: DestinationClass::LocalWorkspace,
        now_ms: 1_002,
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
    assert!(target_library.join("rhofixture/DESCRIPTION").is_file());
    assert!(!project.join("renv.lock").exists());
    assert_eq!(
        fs::read_to_string(project.join("analysis.R")).unwrap(),
        "answer <- 42\n"
    );
    assert_eq!(outcome.journal.plan, plan);
    assert_eq!(
        store
            .current_environment_state(project.to_string_lossy().as_ref())
            .unwrap()
            .unwrap()
            .receipt
            .outcome,
        EnvironmentOperationOutcomeV1::Succeeded
    );
}
