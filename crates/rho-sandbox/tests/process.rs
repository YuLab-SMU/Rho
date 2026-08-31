#![cfg(unix)]

use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, thread, time::Duration};

use rho_protocol::ProjectRevision;
use rho_sandbox::{
    platform::{PlatformSandboxProfile, required_mutation_guarantees},
    process::*,
    snapshot::{SnapshotLimits, build_project_snapshot},
};

fn project_snapshot() -> (tempfile::TempDir, rho_sandbox::snapshot::ProjectSnapshot) {
    let project = tempfile::tempdir().unwrap();
    fs::write(project.path().join("analysis.R"), "x <- 1\n").unwrap();
    let snapshot = build_project_snapshot(
        project.path(),
        ProjectRevision(3),
        SnapshotLimits::default(),
    )
    .unwrap();
    (project, snapshot)
}

fn script(root: &std::path::Path) -> std::path::PathBuf {
    let path = root.join("sandbox-child.sh");
    fs::write(
        &path,
        r#"#!/bin/sh
mode="$1"
case "$mode" in
  inspect)
    printf 'home=%s workspace=%s staging=%s unrelated=%s\n' "$HOME" "$RHO_SANDBOX_WORKSPACE" "$RHO_SANDBOX_STAGING" "${UNRELATED_SECRET-unset}"
    ;;
  log-storm)
    i=0; while [ "$i" -lt 5000 ]; do printf 'line-%s-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' "$i"; i=$((i+1)); done
    sleep 30
    ;;
  disk-storm)
    dd if=/dev/zero of=large.bin bs=1024 count=1024 2>/dev/null
    sleep 30
    ;;
  hang)
    sleep 30
    ;;
  tree)
    sleep 30 & echo "$!" > child.pid; wait
    ;;
esac
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

fn spec(executable: std::path::PathBuf, mode: &str, quota: SandboxQuota) -> SandboxLaunchSpec {
    SandboxLaunchSpec {
        executable_sha256: sandbox_executable_digest(&executable).unwrap(),
        executable,
        argv: vec![mode.to_string()],
        mode: SandboxMode::ObserverOnly,
        quota,
    }
}

#[test]
fn process_layout_mounts_only_immutable_snapshot_scratch_and_staging() {
    let (project, snapshot) = project_snapshot();
    let parent = tempfile::tempdir().unwrap();
    let layout = SandboxLayout::materialize(parent.path(), &snapshot).unwrap();
    let view = layout.mount_view();
    assert_eq!(view.workspace, "/workspace");
    assert_eq!(view.scratch, "/scratch");
    assert_eq!(view.staging, "/staging");
    assert!(view.workspace_read_only);
    assert!(!view.authoritative_project_mounted);
    assert!(!view.workspace_socket_mounted);
    assert!(!view.database_mounted);
    assert!(!view.artifact_store_mounted);
    assert!(!view.secret_store_mounted);
    assert!(!layout.permits_host_path(project.path()));
    assert!(
        fs::write(
            layout.workspace_for_supervisor().join("analysis.R"),
            "mutate"
        )
        .is_err()
    );
}

#[test]
fn process_clean_environment_has_only_virtual_mounts_and_scoped_lease() {
    unsafe { std::env::set_var("UNRELATED_SECRET", "CANARY_UNRELATED") };
    let (_project, snapshot) = project_snapshot();
    let parent = tempfile::tempdir().unwrap();
    let layout = SandboxLayout::materialize(parent.path(), &snapshot).unwrap();
    let executable = script(parent.path());
    let root = layout.root_for_supervisor().to_path_buf();
    let mut supervisor = SandboxSupervisor::launch(
        layout,
        &PlatformSandboxProfile::detect(),
        &spec(executable, "inspect", SandboxQuota::default()),
        ScopedLeaseEnvironment::new(BTreeMap::from([(
            "AISDK_PROVIDER_TOKEN".to_string(),
            "CANARY_SCOPED".to_string(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let mut logs = Vec::new();
    for _ in 0..100 {
        supervisor.poll();
        logs.extend(std::iter::from_fn(|| supervisor.pop_bounded_log()));
        if supervisor.state() == SandboxProcessState::Reaped {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let visible = String::from_utf8_lossy(&logs.concat()).to_string();
    assert!(visible.contains("home=/scratch"));
    assert!(visible.contains("workspace=/workspace"));
    assert!(visible.contains("unrelated=unset"));
    assert!(!visible.contains("CANARY_UNRELATED"));
    assert!(!visible.contains("CANARY_SCOPED"));
    let result = supervisor.finish();
    assert!(result.whole_tree_confirmed_dead);
    assert!(result.cleanup_confirmed);
    assert!(!root.exists());
    unsafe { std::env::remove_var("UNRELATED_SECRET") };
}

#[test]
fn process_platform_missing_guarantee_disables_mutation_without_silent_fallback() {
    let profile = PlatformSandboxProfile::detect();
    for guarantee in required_mutation_guarantees() {
        assert!(
            profile.guarantees.contains(&guarantee) || profile.unsupported.contains(&guarantee)
        );
    }
    if !profile.external_mutation_enabled {
        assert!(profile.reason.contains("external mutation disabled"));
        let (_project, snapshot) = project_snapshot();
        let parent = tempfile::tempdir().unwrap();
        let layout = SandboxLayout::materialize(parent.path(), &snapshot).unwrap();
        let executable = script(parent.path());
        let mut launch = spec(executable, "inspect", SandboxQuota::default());
        launch.mode = SandboxMode::ControlledMutation;
        assert!(matches!(
            SandboxSupervisor::launch(
                layout,
                &profile,
                &launch,
                ScopedLeaseEnvironment::new(BTreeMap::new()).unwrap(),
            ),
            Err(SandboxProcessError::MutationGuaranteeUnavailable(_))
        ));
    }
}

#[test]
fn process_log_storm_and_disk_storm_terminate_within_quota_and_cleanup() {
    for (mode, quota) in [
        (
            "log-storm",
            SandboxQuota {
                max_log_bytes: 1024,
                deadline_ms: 2_000,
                ..SandboxQuota::default()
            },
        ),
        (
            "disk-storm",
            SandboxQuota {
                max_disk_bytes: 128 * 1024,
                deadline_ms: 2_000,
                ..SandboxQuota::default()
            },
        ),
    ] {
        let (_project, snapshot) = project_snapshot();
        let parent = tempfile::tempdir().unwrap();
        let layout = SandboxLayout::materialize(parent.path(), &snapshot).unwrap();
        let executable = script(parent.path());
        let mut supervisor = SandboxSupervisor::launch(
            layout,
            &PlatformSandboxProfile::detect(),
            &spec(executable, mode, quota),
            ScopedLeaseEnvironment::new(BTreeMap::new()).unwrap(),
        )
        .unwrap();
        for _ in 0..200 {
            supervisor.poll();
            if supervisor.state() == SandboxProcessState::Reaped {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(supervisor.state(), SandboxProcessState::Reaped);
    }
}

#[test]
fn process_deadline_and_cancel_reap_whole_tree_or_return_explicit_truth() {
    let (_project, snapshot) = project_snapshot();
    let parent = tempfile::tempdir().unwrap();
    let layout = SandboxLayout::materialize(parent.path(), &snapshot).unwrap();
    let executable = script(parent.path());
    let mut supervisor = SandboxSupervisor::launch(
        layout,
        &PlatformSandboxProfile::detect(),
        &spec(
            executable,
            "tree",
            SandboxQuota {
                deadline_ms: 5_000,
                ..SandboxQuota::default()
            },
        ),
        ScopedLeaseEnvironment::new(BTreeMap::new()).unwrap(),
    )
    .unwrap();
    thread::sleep(Duration::from_millis(30));
    let result = supervisor.cancel();
    assert!(
        result.whole_tree_confirmed_dead || result.state == SandboxProcessState::ReconcileRequired
    );
    assert!(result.cleanup_confirmed || result.state == SandboxProcessState::ReconcileRequired);
}

#[test]
fn process_short_deadline_kills_protocol_hang() {
    let (_project, snapshot) = project_snapshot();
    let parent = tempfile::tempdir().unwrap();
    let layout = SandboxLayout::materialize(parent.path(), &snapshot).unwrap();
    let executable = script(parent.path());
    let mut supervisor = SandboxSupervisor::launch(
        layout,
        &PlatformSandboxProfile::detect(),
        &spec(
            executable,
            "hang",
            SandboxQuota {
                deadline_ms: 20,
                ..SandboxQuota::default()
            },
        ),
        ScopedLeaseEnvironment::new(BTreeMap::new()).unwrap(),
    )
    .unwrap();
    thread::sleep(Duration::from_millis(30));
    supervisor.poll();
    assert_eq!(supervisor.state(), SandboxProcessState::Reaped);
}

#[test]
fn process_wrong_digest_and_broad_environment_fail_closed() {
    let (_project, snapshot) = project_snapshot();
    let parent = tempfile::tempdir().unwrap();
    let layout = SandboxLayout::materialize(parent.path(), &snapshot).unwrap();
    let executable = script(parent.path());
    let mut launch = spec(executable, "inspect", SandboxQuota::default());
    launch.executable_sha256 =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    assert!(matches!(
        SandboxSupervisor::launch(
            layout,
            &PlatformSandboxProfile::detect(),
            &launch,
            ScopedLeaseEnvironment::new(BTreeMap::new()).unwrap(),
        ),
        Err(SandboxProcessError::DigestMismatch)
    ));
    assert!(matches!(
        ScopedLeaseEnvironment::new(BTreeMap::from([(
            "DATABASE_URL".to_string(),
            "CANARY_DB".to_string()
        )])),
        Err(SandboxProcessError::EnvironmentRejected)
    ));
}

#[test]
fn process_boundary_excludes_authoritative_paths_sockets_database_cas_and_secret_store() {
    let (_, does_not_own) = process_boundary();
    for excluded in [
        "authoritative_project_mount",
        "workspace_socket",
        "rho_database",
        "artifact_store_internal",
        "secret_store",
        "silent_guarantee_downgrade",
    ] {
        assert!(does_not_own.contains(&excluded));
    }
}
