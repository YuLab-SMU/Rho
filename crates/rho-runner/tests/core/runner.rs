#![cfg(unix)]

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    thread,
    time::Duration,
};

use rho_protocol::*;
use rho_runner::{
    journal::RunnerProcessHandle,
    process::{
        ApprovedRunnerLaunch, BoundedRunnerLogs, MAX_RUNNER_LOG_ITEMS, OsRunnerProcessPort,
        RunnerProcessError, RunnerProcessObservation, RunnerProcessPort,
    },
    protocol::*,
    *,
};

#[derive(Default)]
struct FakeProcess {
    spawn_calls: usize,
    fail_spawn: bool,
    observations: VecDeque<RunnerProcessObservation>,
    cancel_calls: usize,
}

impl RunnerProcessPort for FakeProcess {
    fn spawn(
        &mut self,
        launch: &ApprovedRunnerLaunch,
    ) -> Result<RunnerProcessHandle, RunnerProcessError> {
        self.spawn_calls += 1;
        if self.fail_spawn {
            return Err(RunnerProcessError::Spawn);
        }
        Ok(RunnerProcessHandle {
            handle_id: format!("handle_{}", launch.execution_id.as_str()),
            pid: Some(42),
            start_identity: "42:100".to_string(),
        })
    }

    fn observe(
        &mut self,
        _handle: &RunnerProcessHandle,
    ) -> Result<RunnerProcessObservation, RunnerProcessError> {
        Ok(self
            .observations
            .pop_front()
            .unwrap_or(RunnerProcessObservation::Running))
    }

    fn cancel(&mut self, _handle: &RunnerProcessHandle) -> Result<bool, RunnerProcessError> {
        self.cancel_calls += 1;
        Ok(true)
    }

    fn take_logs(
        &mut self,
        _handle: &RunnerProcessHandle,
    ) -> Result<BoundedRunnerLogs, RunnerProcessError> {
        Ok(BoundedRunnerLogs::default())
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    profile: RunnerDeploymentProfile,
    journal: PathBuf,
    key: RunnerAuthKey,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("approved-worker");
    fs::write(
        &executable,
        "#!/bin/sh\necho stdout-ok\necho stderr-ok >&2\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let working = temp.path().join("working");
    let output = temp.path().join("output");
    fs::create_dir(&working).unwrap();
    fs::create_dir(&output).unwrap();
    let command = ApprovedRunnerCommand {
        command_id: "analysis".to_string(),
        executable: executable.clone(),
        executable_sha256: executable_digest(&executable).unwrap(),
    };
    Fixture {
        journal: temp.path().join("runner-journal.json"),
        profile: RunnerDeploymentProfile {
            profile_id: "runner_profile_test".to_string(),
            working_root: working,
            output_root: output,
            commands: BTreeMap::from([("analysis".to_string(), command)]),
            resource_profile: "bounded-test".to_string(),
            allowed_executors: BTreeSet::from([ExecutorKind::LocalProcess]),
            allowed_execution_profiles: BTreeMap::from([(
                ExecutionProfileId::new("execution_profile_default").unwrap(),
                AuthorityDigest::new(format!("sha256:{}", "d".repeat(64))).unwrap(),
            )]),
            allowed_repository_profiles: BTreeMap::from([(
                RepositoryProfileId::new("repository_profile_default").unwrap(),
                AuthorityDigest::new(format!("sha256:{}", "e".repeat(64))).unwrap(),
            )]),
        },
        key: RunnerAuthKey::new(vec![7; 32]).unwrap(),
        _temp: temp,
    }
}

fn spec(label: &str) -> ExecutionSpec {
    let mut spec = ExecutionSpec::new(
        ExecutionId::new(format!("execution_runner_{label}")).unwrap(),
        OperationId::new(format!("operation_runner_{label}")).unwrap(),
        ExecutorKind::LocalProcess,
        vec!["analysis".to_string()],
    );
    spec.environment.manifest_digest = rho_runner::artifacts::digest(b"runner-environment");
    spec
}

fn prepare_request(profile: &RunnerDeploymentProfile, spec: ExecutionSpec) -> RunnerRequest {
    let staging = RunnerStagingManifestV1::new(
        &spec,
        Vec::new(),
        RemoteBlobDescriptor {
            digest: spec.environment.manifest_digest.clone(),
            byte_size: b"runner-environment".len() as u64,
            media_type: "application/vnd.rho.environment+json".to_string(),
        },
        &BTreeSet::new(),
    )
    .unwrap();
    let root = profile.working_root.join(spec.execution_id.as_str());
    if !root.exists() {
        let environment = root.join("environment");
        fs::create_dir_all(&environment).unwrap();
        let blob = environment.join(
            spec.environment
                .manifest_digest
                .as_str()
                .trim_start_matches("sha256:"),
        );
        fs::write(&blob, b"runner-environment").unwrap();
        let mut permissions = fs::metadata(&blob).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&blob, permissions).unwrap();
        let manifest_path = root.join("staging-manifest.json");
        fs::write(&manifest_path, serde_json::to_vec(&staging).unwrap()).unwrap();
        let mut permissions = fs::metadata(&manifest_path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&manifest_path, permissions).unwrap();
    }
    RunnerRequest::Prepare {
        spec: Box::new(spec),
        staging: Box::new(staging),
    }
}

fn envelope(id: &str, request: RunnerRequest, key: &RunnerAuthKey) -> AuthenticatedRunnerRequest {
    decode_authenticated_request(
        &encode_authenticated_request(id, request, key).unwrap(),
        key,
    )
    .unwrap()
}

#[test]
fn runner_core_handshake_prepare_submit_duplicate_and_terminal_status_are_durable() {
    let fixture = fixture();
    let process = FakeProcess {
        observations: [RunnerProcessObservation::ExitedSuccess].into(),
        ..FakeProcess::default()
    };
    let mut runner = RunnerCore::open(fixture.profile.clone(), &fixture.journal, process).unwrap();
    assert!(matches!(
        runner
            .handle(envelope(
                "request_handshake",
                RunnerRequest::Handshake { client_version: 1 },
                &fixture.key,
            ))
            .unwrap(),
        RunnerResponse::Handshake { .. }
    ));
    let spec = spec("duplicate");
    runner
        .handle(envelope(
            "request_prepare",
            prepare_request(&fixture.profile, spec.clone()),
            &fixture.key,
        ))
        .unwrap();
    let first = runner
        .handle(envelope(
            "request_submit",
            RunnerRequest::Submit {
                operation_id: spec.operation_id.clone(),
            },
            &fixture.key,
        ))
        .unwrap();
    assert!(matches!(
        first,
        RunnerResponse::Job {
            duplicate: false,
            ..
        }
    ));
    let duplicate = runner
        .handle(envelope(
            "request_submit_duplicate",
            RunnerRequest::Submit {
                operation_id: spec.operation_id.clone(),
            },
            &fixture.key,
        ))
        .unwrap();
    assert!(matches!(
        duplicate,
        RunnerResponse::Job {
            duplicate: true,
            ..
        }
    ));
    let status = runner
        .handle(envelope(
            "request_status",
            RunnerRequest::Status {
                execution_id: spec.execution_id.clone(),
            },
            &fixture.key,
        ))
        .unwrap();
    assert!(matches!(
        status,
        RunnerResponse::Status { state, .. } if state == "succeeded"
    ));
    assert!(fixture.journal.exists());
}

#[test]
fn runner_core_restart_recovers_journal_and_missing_process_is_uncertain_not_failed() {
    let fixture = fixture();
    let spec = spec("restart");
    {
        let mut runner = RunnerCore::open(
            fixture.profile.clone(),
            &fixture.journal,
            FakeProcess::default(),
        )
        .unwrap();
        runner
            .handle(envelope(
                "prepare_restart",
                prepare_request(&fixture.profile, spec.clone()),
                &fixture.key,
            ))
            .unwrap();
        runner
            .handle(envelope(
                "submit_restart",
                RunnerRequest::Submit {
                    operation_id: spec.operation_id.clone(),
                },
                &fixture.key,
            ))
            .unwrap();
    }
    let mut restarted = RunnerCore::open(
        fixture.profile,
        &fixture.journal,
        FakeProcess {
            observations: [RunnerProcessObservation::Missing].into(),
            ..FakeProcess::default()
        },
    )
    .unwrap();
    let response = restarted
        .handle(envelope(
            "reconcile_restart",
            RunnerRequest::Reconcile {
                execution_id: spec.execution_id,
            },
            &fixture.key,
        ))
        .unwrap();
    assert!(matches!(
        response,
        RunnerResponse::Status { state, .. } if state == "uncertain"
    ));
}

#[test]
fn runner_protocol_rejects_malformed_oversized_unauthenticated_without_effect() {
    let fixture = fixture();
    assert_eq!(
        decode_authenticated_request(b"not-json", &fixture.key).unwrap_err(),
        RunnerProtocolError::Malformed
    );
    assert_eq!(
        decode_authenticated_request(&vec![b'x'; MAX_RUNNER_FRAME_BYTES + 1], &fixture.key)
            .unwrap_err(),
        RunnerProtocolError::FrameTooLarge
    );
    let bytes = encode_authenticated_request(
        "request_auth",
        prepare_request(&fixture.profile, spec("auth")),
        &fixture.key,
    )
    .unwrap();
    let wrong = RunnerAuthKey::new(vec![8; 32]).unwrap();
    assert_eq!(
        decode_authenticated_request(&bytes, &wrong).unwrap_err(),
        RunnerProtocolError::Authentication
    );
    let runner =
        RunnerCore::open(fixture.profile, &fixture.journal, FakeProcess::default()).unwrap();
    assert_eq!(runner.journal().records().count(), 0);
}

#[test]
fn runner_command_profile_rejects_agent_shell_text_and_conflicting_operation() {
    let fixture = fixture();
    let mut runner = RunnerCore::open(
        fixture.profile.clone(),
        &fixture.journal,
        FakeProcess::default(),
    )
    .unwrap();
    let mut shell = spec("shell");
    shell.argv = vec![
        "analysis".to_string(),
        "-c".to_string(),
        "rm -rf .".to_string(),
    ];
    assert!(
        runner
            .handle(envelope(
                "prepare_shell",
                prepare_request(&fixture.profile, shell),
                &fixture.key,
            ))
            .is_err()
    );

    let one = spec("conflict");
    runner
        .handle(envelope(
            "prepare_one",
            prepare_request(&fixture.profile, one.clone()),
            &fixture.key,
        ))
        .unwrap();
    let mut conflict = one;
    conflict.argv.push("different".to_string());
    assert!(
        runner
            .handle(envelope(
                "prepare_conflict",
                prepare_request(&fixture.profile, conflict),
                &fixture.key,
            ))
            .is_err()
    );
}

#[test]
fn runner_rejects_staged_blob_tamper_and_unadmitted_execution_profile() {
    let fixture = fixture();
    let mut runner = RunnerCore::open(
        fixture.profile.clone(),
        &fixture.journal,
        FakeProcess::default(),
    )
    .unwrap();
    let staged_spec = spec("staged_tamper");
    let request = prepare_request(&fixture.profile, staged_spec.clone());
    let environment_blob = fixture
        .profile
        .working_root
        .join(staged_spec.execution_id.as_str())
        .join("environment")
        .join(
            staged_spec
                .environment
                .manifest_digest
                .as_str()
                .trim_start_matches("sha256:"),
        );
    fs::set_permissions(&environment_blob, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&environment_blob, b"tampered").unwrap();
    assert!(
        runner
            .handle(envelope("prepare_staged_tamper", request, &fixture.key))
            .is_err()
    );

    let mut profile_mismatch = spec("profile_mismatch");
    profile_mismatch.environment.execution_profile_digest =
        AuthorityDigest::new(format!("sha256:{}", "9".repeat(64))).unwrap();
    let request = prepare_request(&fixture.profile, profile_mismatch);
    assert!(
        runner
            .handle(envelope("prepare_profile_mismatch", request, &fixture.key))
            .is_err()
    );
}

#[test]
fn runner_os_process_uses_clean_env_bounded_logs_and_cancel_tree() {
    let fixture = fixture();
    let command = fixture.profile.commands["analysis"].clone();
    let launch = ApprovedRunnerLaunch {
        execution_id: ExecutionId::new("execution_runner_os").unwrap(),
        executable: command.executable.display().to_string(),
        argv: Vec::new(),
        working_directory: fixture.profile.working_root.display().to_string(),
        environment: BTreeMap::from([(
            "HOME".to_string(),
            fixture.profile.output_root.display().to_string(),
        )]),
    };
    let mut process = OsRunnerProcessPort::default();
    let handle = process.spawn(&launch).unwrap();
    for _ in 0..100 {
        if process.observe(&handle).unwrap() != RunnerProcessObservation::Running {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let logs = process.take_logs(&handle).unwrap();
    assert!(logs.stdout.iter().any(|line| line == b"stdout-ok"));
    assert!(logs.stderr.iter().any(|line| line == b"stderr-ok"));
    assert!(logs.stdout.len() <= MAX_RUNNER_LOG_ITEMS);
}

#[test]
fn runner_boundary_has_no_agent_policy_ui_workspace_or_self_update_logic() {
    let source = include_str!("../../src/lib.rs")
        .split("pub fn boundary")
        .next()
        .unwrap();
    for forbidden in [
        "AgentProvider",
        "Acp",
        "React",
        "WorkspaceExecutor",
        "self_update",
    ] {
        assert!(!source.contains(forbidden), "runner leaked {forbidden}");
    }
    let excluded = boundary().does_not_own;
    assert!(excluded.contains(&"agent_plan"));
    assert!(excluded.contains(&"broker_policy"));
    assert!(excluded.contains(&"desktop_projection"));
    assert!(excluded.contains(&"self_update_protocol"));
}
