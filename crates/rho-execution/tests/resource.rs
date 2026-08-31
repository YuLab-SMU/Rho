use rho_execution::resource::*;
use rho_protocol::{ExecutionId, ProjectId};

fn request() -> ResourceRequest {
    ResourceRequest {
        cpu_millis: 1000,
        memory_bytes: 128 * 1024 * 1024,
        max_processes: 8,
        walltime_ms: 5000,
        disk_bytes: 64 * 1024 * 1024,
        output_bytes: 8 * 1024 * 1024,
        open_files: 64,
    }
}

fn verified_profile() -> PlatformResourceProfile {
    PlatformResourceProfile {
        platform: "verified-test-platform".to_string(),
        adapter: "verified-adapter".to_string(),
        enforced: vec![
            ResourceGuarantee::Cpu,
            ResourceGuarantee::Memory,
            ResourceGuarantee::ProcessCount,
            ResourceGuarantee::Walltime,
            ResourceGuarantee::Disk,
            ResourceGuarantee::Output,
            ResourceGuarantee::OpenFiles,
            ResourceGuarantee::ProcessTree,
        ],
        unsupported: Vec::new(),
        isolation_tier_enabled: true,
    }
}

#[test]
fn resource_admission_records_requested_equal_effective_without_silent_clamp() {
    let request = request();
    let allocation = allocate_resources(
        request.clone(),
        &ResourcePolicy::default(),
        verified_profile(),
        true,
    )
    .unwrap();
    assert_eq!(allocation.requested, request);
    assert_eq!(allocation.effective, request);
    assert!(allocation.platform.isolation_tier_enabled);
}

#[test]
fn resource_over_policy_is_rejected_not_clamped() {
    let policy = ResourcePolicy::default();
    for (name, mut candidate) in [
        ("cpu", request()),
        ("memory", request()),
        ("pids", request()),
        ("walltime", request()),
        ("disk", request()),
        ("output", request()),
        ("open_files", request()),
    ] {
        match name {
            "cpu" => candidate.cpu_millis = policy.max_cpu_millis + 1,
            "memory" => candidate.memory_bytes = policy.max_memory_bytes + 1,
            "pids" => candidate.max_processes = policy.max_processes + 1,
            "walltime" => candidate.walltime_ms = policy.max_walltime_ms + 1,
            "disk" => candidate.disk_bytes = policy.max_disk_bytes + 1,
            "output" => candidate.output_bytes = policy.max_output_bytes + 1,
            "open_files" => candidate.open_files = policy.max_open_files + 1,
            _ => unreachable!(),
        }
        assert_eq!(
            allocate_resources(candidate, &policy, verified_profile(), true).unwrap_err(),
            ResourceAdmissionError::RequestExceedsPolicy(name)
        );
    }
}

#[test]
fn resource_global_and_per_project_concurrency_are_deterministic() {
    let policy = ResourcePolicy {
        global_concurrency: 2,
        per_project_concurrency: 1,
        ..ResourcePolicy::default()
    };
    let mut controller = ResourceAdmissionController::default();
    let project_a = ProjectId::new("project_a").unwrap();
    let token_a = controller
        .admit(
            ExecutionId::new("execution_a").unwrap(),
            project_a.clone(),
            &policy,
        )
        .unwrap();
    assert_eq!(
        controller
            .admit(
                ExecutionId::new("execution_a2").unwrap(),
                project_a,
                &policy,
            )
            .unwrap_err(),
        ResourceAdmissionError::ProjectConcurrency
    );
    let token_b = controller
        .admit(
            ExecutionId::new("execution_b").unwrap(),
            ProjectId::new("project_b").unwrap(),
            &policy,
        )
        .unwrap();
    assert_eq!(
        controller
            .admit(
                ExecutionId::new("execution_c").unwrap(),
                ProjectId::new("project_c").unwrap(),
                &policy,
            )
            .unwrap_err(),
        ResourceAdmissionError::GlobalConcurrency
    );
    assert!(controller.release(token_a));
    assert!(controller.release(token_b));
    assert_eq!(controller.active_count(), 0);
}

#[test]
fn resource_abuse_terminal_reason_records_observed_usage_for_every_quota() {
    let allocation = allocate_resources(
        request(),
        &ResourcePolicy::default(),
        verified_profile(),
        true,
    )
    .unwrap();
    let cases = [
        ObservedResourceUsage {
            cpu_millis: 1001,
            ..Default::default()
        },
        ObservedResourceUsage {
            peak_memory_bytes: 128 * 1024 * 1024 + 1,
            ..Default::default()
        },
        ObservedResourceUsage {
            peak_processes: 9,
            ..Default::default()
        },
        ObservedResourceUsage {
            walltime_ms: 5001,
            ..Default::default()
        },
        ObservedResourceUsage {
            disk_bytes: 64 * 1024 * 1024 + 1,
            ..Default::default()
        },
        ObservedResourceUsage {
            output_bytes: 8 * 1024 * 1024 + 1,
            ..Default::default()
        },
        ObservedResourceUsage {
            peak_open_files: 65,
            ..Default::default()
        },
    ];
    for observed in cases {
        let terminal = observe_quota(&allocation, observed.clone()).unwrap();
        assert_eq!(terminal.observed, observed);
        assert!(terminal.reason_code.ends_with("quota_exceeded"));
    }
}

#[test]
fn resource_platform_missing_guarantee_disables_full_isolation_tier() {
    let profile = PlatformResourceProfile::detect();
    if !profile.isolation_tier_enabled {
        assert!(!profile.unsupported.is_empty());
        assert_eq!(
            allocate_resources(request(), &ResourcePolicy::default(), profile, true).unwrap_err(),
            ResourceAdmissionError::IsolationTierUnavailable
        );
    }
}

#[test]
fn resource_boundary_forbids_silent_clamp_and_unsupported_tier_enable() {
    let (_, does_not_own) = resource_boundary();
    assert!(does_not_own.contains(&"silent_clamp"));
    assert!(does_not_own.contains(&"unsupported_tier_enable"));
}
