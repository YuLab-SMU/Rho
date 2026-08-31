use std::collections::VecDeque;

use rho_execution::{oci::*, resource::*};
use rho_protocol::{
    ExecutionId, ExecutionSpec, ExecutionState, ExecutorKind, JobId, NetworkPolicy, OperationId,
};

struct FakeRuntime {
    create_calls: usize,
    start: Result<(), OciRuntimeError>,
    inspections: VecDeque<Result<OciRuntimeState, OciRuntimeError>>,
    killed: usize,
    deleted: usize,
}

impl OciRuntime for FakeRuntime {
    fn create(&mut self, spec: &PreparedOciSpec) -> Result<OciRuntimeHandle, OciRuntimeError> {
        self.create_calls += 1;
        Ok(OciRuntimeHandle {
            container_id: format!("container_{}", spec.execution.execution_id.as_str()),
            execution_id: spec.execution.execution_id.clone(),
            image_digest: spec.image.digest.clone(),
            created_unix_ms: 100,
        })
    }

    fn start(&mut self, _handle: &OciRuntimeHandle) -> Result<(), OciRuntimeError> {
        self.start.clone()
    }

    fn inspect(&mut self, _handle: &OciRuntimeHandle) -> Result<OciRuntimeState, OciRuntimeError> {
        self.inspections
            .pop_front()
            .unwrap_or(Ok(OciRuntimeState::Running))
    }

    fn kill(&mut self, _handle: &OciRuntimeHandle) -> Result<(), OciRuntimeError> {
        self.killed += 1;
        Ok(())
    }

    fn delete(&mut self, _handle: &OciRuntimeHandle) -> Result<(), OciRuntimeError> {
        self.deleted += 1;
        Ok(())
    }
}

fn support() -> OciPlatformSupport {
    OciPlatformSupport {
        runtime: "test-oci-runtime".to_string(),
        rootless: true,
        user_namespace: true,
        seccomp: true,
        resource_enforcement: true,
        network_namespace: true,
    }
}

fn allocation() -> EffectiveResourceAllocation {
    let request = rho_execution::resource::ResourceRequest {
        cpu_millis: 1000,
        memory_bytes: 128 * 1024 * 1024,
        max_processes: 8,
        walltime_ms: 5000,
        disk_bytes: 64 * 1024 * 1024,
        output_bytes: 8 * 1024 * 1024,
        open_files: 64,
    };
    EffectiveResourceAllocation {
        requested: request.clone(),
        effective: request,
        platform: PlatformResourceProfile {
            platform: "test".to_string(),
            adapter: "verified".to_string(),
            enforced: vec![ResourceGuarantee::ProcessTree],
            unsupported: Vec::new(),
            isolation_tier_enabled: true,
        },
    }
}

fn execution(id: &str) -> ExecutionSpec {
    let mut spec = ExecutionSpec::new(
        ExecutionId::new(format!("execution_{id}")).unwrap(),
        OperationId::new(format!("operation_{id}")).unwrap(),
        ExecutorKind::Oci,
        vec!["python".to_string(), "analysis.py".to_string()],
    );
    spec.network = NetworkPolicy::Deny;
    spec
}

fn prepared(id: &str) -> PreparedOciSpec {
    prepare_oci_spec(
        execution(id),
        OciImageIdentity {
            repository: "registry.example/rho-worker".to_string(),
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
        },
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        vec![
            OciMount {
                handle_id: "working_set_handle".to_string(),
                destination: "/workspace".to_string(),
                read_only: true,
            },
            OciMount {
                handle_id: "staging_handle".to_string(),
                destination: "/staging".to_string(),
                read_only: false,
            },
        ],
        allocation(),
        &support(),
    )
    .unwrap()
}

#[test]
fn oci_prepare_pins_image_environment_resources_mounts_and_rootless_security() {
    let spec = prepared("prepare");
    assert!(spec.image.digest.starts_with("sha256:"));
    assert!(!spec.security.privileged);
    assert!(!spec.security.host_network);
    assert!(spec.security.user_namespace);
    assert!(spec.security.no_new_privileges);
    assert!(spec.security.added_capabilities.is_empty());
    assert_eq!(
        spec.security.dropped_capabilities,
        ["all".to_string()].into()
    );
    assert_eq!(spec.mounts[0].destination, "/workspace");
    assert!(spec.mounts[0].read_only);
    let provenance = oci_provenance(&spec);
    assert_eq!(provenance["image_digest"], spec.image.digest);
    assert_eq!(provenance["environment_digest"], spec.environment_digest);
}

#[test]
fn oci_rejects_mutable_tag_host_mounts_and_missing_platform_guarantees() {
    let mutable = prepare_oci_spec(
        execution("mutable"),
        OciImageIdentity {
            repository: "ubuntu:latest".to_string(),
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
        },
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        vec![],
        allocation(),
        &support(),
    );
    assert_eq!(mutable.unwrap_err(), OciExecutorError::MutableImage);

    let unsafe_mount = prepare_oci_spec(
        execution("socket"),
        OciImageIdentity {
            repository: "rho-worker".to_string(),
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
        },
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        vec![OciMount {
            handle_id: "host_socket".to_string(),
            destination: "/var/run/docker.sock".to_string(),
            read_only: false,
        }],
        allocation(),
        &support(),
    );
    assert_eq!(unsafe_mount.unwrap_err(), OciExecutorError::UnsafeMount);

    let mut unsupported = support();
    unsupported.seccomp = false;
    assert_eq!(
        prepare_oci_spec(
            execution("unsupported"),
            OciImageIdentity {
                repository: "rho-worker".to_string(),
                digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
            },
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
            vec![],
            allocation(),
            &unsupported,
        )
        .unwrap_err(),
        OciExecutorError::UnsupportedPlatform
    );
}

#[test]
fn oci_submit_duplicate_and_success_terminal_use_canonical_job_contract() {
    let spec = prepared("success");
    let mut runtime = FakeRuntime {
        create_calls: 0,
        start: Ok(()),
        inspections: [Ok(OciRuntimeState::ExitedSuccess)].into(),
        killed: 0,
        deleted: 0,
    };
    let mut executor = OciExecutor::new();
    assert!(matches!(
        executor.submit(&spec, &mut runtime).unwrap(),
        OciSubmitOutcome::Running { .. }
    ));
    executor.submit(&spec, &mut runtime).unwrap();
    assert_eq!(runtime.create_calls, 1);
    let observation = executor
        .reconcile(
            &spec.execution.execution_id,
            JobId::new("job_oci_success").unwrap(),
            &mut runtime,
        )
        .unwrap();
    assert_eq!(observation.state, ExecutionState::Succeeded);
}

#[test]
fn oci_daemon_disconnect_timeout_missing_and_stale_identity_are_uncertain_reconcile() {
    for observation in [
        Err(OciRuntimeError::DaemonUnavailable),
        Err(OciRuntimeError::Timeout),
        Ok(OciRuntimeState::Missing),
        Ok(OciRuntimeState::StaleIdentity),
        Ok(OciRuntimeState::DaemonUnavailable),
    ] {
        let spec = prepared("uncertain");
        let mut runtime = FakeRuntime {
            create_calls: 0,
            start: Ok(()),
            inspections: [observation].into(),
            killed: 0,
            deleted: 0,
        };
        let mut executor = OciExecutor::new();
        executor.submit(&spec, &mut runtime).unwrap();
        let observed = executor
            .reconcile(
                &spec.execution.execution_id,
                JobId::new("job_oci_uncertain").unwrap(),
                &mut runtime,
            )
            .unwrap();
        assert_eq!(observed.state, ExecutionState::Uncertain);
        assert!(observed.message.unwrap().contains("reconciliation"));
    }
}

#[test]
fn oci_start_disconnect_is_uncertain_not_failed_and_cancel_maps_kill_delete() {
    let spec = prepared("start_disconnect");
    let mut runtime = FakeRuntime {
        create_calls: 0,
        start: Err(OciRuntimeError::DaemonUnavailable),
        inspections: VecDeque::new(),
        killed: 0,
        deleted: 0,
    };
    let mut executor = OciExecutor::new();
    assert!(matches!(
        executor.submit(&spec, &mut runtime).unwrap(),
        OciSubmitOutcome::Uncertain { .. }
    ));
    executor
        .cancel(&spec.execution.execution_id, &mut runtime)
        .unwrap();
    assert_eq!((runtime.killed, runtime.deleted), (1, 1));
}

#[test]
fn oci_boundary_excludes_host_socket_network_privilege_project_and_secret_mounts() {
    let (_, does_not_own) = oci_boundary();
    assert!(does_not_own.contains(&"mutable_tag_identity"));
    assert!(does_not_own.contains(&"host_socket"));
    assert!(does_not_own.contains(&"host_network"));
    assert!(does_not_own.contains(&"privileged_container"));
    assert!(does_not_own.contains(&"authoritative_project_mount"));
    assert!(does_not_own.contains(&"secret_store_mount"));
}
