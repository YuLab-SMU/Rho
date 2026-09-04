#![cfg(unix)]

use std::{
    fs,
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    },
};

use rho_protocol::ProjectRevision;
use rho_sandbox::snapshot::*;

fn project() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("analysis.R"), "x <- 1\n").unwrap();
    fs::create_dir(temp.path().join("data")).unwrap();
    fs::write(temp.path().join("data/counts.csv"), "gene,a\nx,1\n").unwrap();
    temp
}

#[test]
fn snapshot_manifest_is_relative_immutable_revision_bound_and_digest_verified() {
    let temp = project();
    let snapshot =
        build_project_snapshot(temp.path(), ProjectRevision(7), SnapshotLimits::default()).unwrap();
    assert_eq!(snapshot.manifest().project_revision, ProjectRevision(7));
    assert_eq!(snapshot.read("analysis.R").unwrap(), b"x <- 1\n");
    assert!(snapshot.manifest().content_digest.starts_with("sha256:"));
    assert!(
        snapshot
            .manifest()
            .files
            .iter()
            .all(|entry| !entry.relative_path.starts_with('/'))
    );
    assert!(!snapshot.contains_host_path(temp.path()));

    fs::write(temp.path().join("analysis.R"), "x <- 2\n").unwrap();
    assert_eq!(snapshot.read("analysis.R").unwrap(), b"x <- 1\n");
}

#[test]
fn snapshot_delta_captures_created_replaced_and_deleted_bytes_against_one_revision() {
    let temp = project();
    let baseline =
        build_project_snapshot(temp.path(), ProjectRevision(7), SnapshotLimits::default()).unwrap();
    fs::write(temp.path().join("analysis.R"), "x <- 2\n").unwrap();
    fs::remove_file(temp.path().join("data/counts.csv")).unwrap();
    fs::create_dir(temp.path().join("results")).unwrap();
    fs::write(temp.path().join("results/summary.txt"), "complete\n").unwrap();

    let delta = diff_project_snapshot(&baseline, temp.path(), SnapshotLimits::default()).unwrap();
    assert_eq!(delta.base_project_revision, ProjectRevision(7));
    assert_eq!(
        delta
            .changes
            .iter()
            .map(|change| (change.relative_path.as_str(), change.kind))
            .collect::<Vec<_>>(),
        vec![
            ("analysis.R", SnapshotFileChangeKind::Replace),
            ("data/counts.csv", SnapshotFileChangeKind::Delete),
            ("results/summary.txt", SnapshotFileChangeKind::Create),
        ]
    );
    assert_eq!(
        delta.changes[0].bytes.as_deref(),
        Some("x <- 2\n".as_bytes())
    );
    assert!(delta.changes[1].bytes.is_none());
    assert_eq!(
        delta.changes[2].bytes.as_deref(),
        Some("complete\n".as_bytes())
    );
    assert_eq!(delta.total_staged_bytes, 16);
}

#[test]
fn snapshot_delta_rejects_an_ignore_policy_rewrite() {
    let temp = project();
    fs::write(temp.path().join(IGNORE_POLICY_FILE), "*.secret\n").unwrap();
    let baseline =
        build_project_snapshot(temp.path(), ProjectRevision(4), SnapshotLimits::default()).unwrap();
    fs::write(temp.path().join(IGNORE_POLICY_FILE), "*.txt\n").unwrap();
    assert_eq!(
        diff_project_snapshot(&baseline, temp.path(), SnapshotLimits::default()).unwrap_err(),
        SnapshotError::IgnorePolicyRace
    );
}

#[test]
fn snapshot_rejects_symlink_loop_escape_and_toctou_swap() {
    let temp = project();
    symlink("../outside", temp.path().join("escape")).unwrap();
    assert!(matches!(
        build_project_snapshot(temp.path(), ProjectRevision(1), SnapshotLimits::default()),
        Err(SnapshotError::SymbolicLink(path)) if path == "escape"
    ));
    fs::remove_file(temp.path().join("escape")).unwrap();
    symlink(".", temp.path().join("loop")).unwrap();
    assert!(matches!(
        build_project_snapshot(temp.path(), ProjectRevision(1), SnapshotLimits::default()),
        Err(SnapshotError::SymbolicLink(path)) if path == "loop"
    ));
    fs::remove_file(temp.path().join("loop")).unwrap();

    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), "outside canary").unwrap();
    let target = temp.path().join("analysis.R");
    let outside_path = outside.path().to_path_buf();
    let mut swapped = false;
    let mut hook = |relative: &str| {
        if relative == "analysis.R" && !swapped {
            swapped = true;
            fs::remove_file(&target).unwrap();
            symlink(&outside_path, &target).unwrap();
        }
    };
    assert!(matches!(
        build_project_snapshot_with_hook(
            temp.path(),
            ProjectRevision(1),
            SnapshotLimits::default(),
            &mut hook,
        ),
        Err(SnapshotError::RaceDetected(path)) if path == "analysis.R"
    ));
}

#[test]
fn snapshot_rejects_hardlink_to_outside_and_special_fifo_socket() {
    let temp = project();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::hard_link(outside.path(), temp.path().join("outside-hardlink")).unwrap();
    assert!(matches!(
        build_project_snapshot(temp.path(), ProjectRevision(1), SnapshotLimits::default()),
        Err(SnapshotError::HardLink(path)) if path == "outside-hardlink"
    ));
    fs::remove_file(temp.path().join("outside-hardlink")).unwrap();

    let fifo = temp.path().join("pipe");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    assert!(matches!(
        build_project_snapshot(temp.path(), ProjectRevision(1), SnapshotLimits::default()),
        Err(SnapshotError::SpecialFile(path)) if path == "pipe"
    ));
    fs::remove_file(&fifo).unwrap();

    let socket_path = temp.path().join("socket");
    let _listener = UnixListener::bind(&socket_path).unwrap();
    assert!(matches!(
        build_project_snapshot(temp.path(), ProjectRevision(1), SnapshotLimits::default()),
        Err(SnapshotError::SpecialFile(path)) if path == "socket"
    ));
}

#[test]
fn snapshot_freezes_ignore_policy_before_traversal_and_detects_policy_race() {
    let temp = project();
    fs::write(
        temp.path().join(".rhoignore"),
        "secret.txt\n*.tmp\ncache/\n",
    )
    .unwrap();
    fs::write(temp.path().join("secret.txt"), "CANARY_SECRET_FILE").unwrap();
    fs::write(temp.path().join("scratch.tmp"), "ignored").unwrap();
    fs::create_dir(temp.path().join("cache")).unwrap();
    fs::write(temp.path().join("cache/object"), "ignored").unwrap();
    let snapshot =
        build_project_snapshot(temp.path(), ProjectRevision(2), SnapshotLimits::default()).unwrap();
    assert!(snapshot.read("secret.txt").is_none());
    assert!(snapshot.read("scratch.tmp").is_none());
    assert!(snapshot.read("cache/object").is_none());
    assert!(snapshot.read(IGNORE_POLICY_FILE).is_some());

    let policy = temp.path().join(IGNORE_POLICY_FILE);
    let mut changed = false;
    let mut hook = |relative: &str| {
        if relative == "analysis.R" && !changed {
            changed = true;
            fs::write(&policy, "\n").unwrap();
        }
    };
    assert_eq!(
        build_project_snapshot_with_hook(
            temp.path(),
            ProjectRevision(2),
            SnapshotLimits::default(),
            &mut hook,
        )
        .unwrap_err(),
        SnapshotError::IgnorePolicyRace
    );
}

#[test]
fn snapshot_limits_file_count_total_single_file_and_depth_deterministically() {
    let temp = project();
    assert_eq!(
        build_project_snapshot(
            temp.path(),
            ProjectRevision(1),
            SnapshotLimits {
                max_files: 1,
                ..SnapshotLimits::default()
            },
        )
        .unwrap_err(),
        SnapshotError::FileCountExceeded(1)
    );
    assert!(matches!(
        build_project_snapshot(
            temp.path(),
            ProjectRevision(1),
            SnapshotLimits {
                max_file_bytes: 2,
                ..SnapshotLimits::default()
            },
        ),
        Err(SnapshotError::FileBytesExceeded { limit: 2, .. })
    ));
    assert_eq!(
        build_project_snapshot(
            temp.path(),
            ProjectRevision(1),
            SnapshotLimits {
                max_total_bytes: 3,
                ..SnapshotLimits::default()
            },
        )
        .unwrap_err(),
        SnapshotError::TotalBytesExceeded(3)
    );
    fs::create_dir_all(temp.path().join("a/b/c")).unwrap();
    fs::write(temp.path().join("a/b/c/file"), "x").unwrap();
    assert_eq!(
        build_project_snapshot(
            temp.path(),
            ProjectRevision(1),
            SnapshotLimits {
                max_path_depth: 2,
                ..SnapshotLimits::default()
            },
        )
        .unwrap_err(),
        SnapshotError::PathDepthExceeded(2)
    );
}

#[test]
fn snapshot_permission_error_is_bounded_and_does_not_leak_host_path() {
    let temp = project();
    let file = temp.path().join("analysis.R");
    let mut permissions = fs::metadata(&file).unwrap().permissions();
    permissions.set_mode(0o000);
    fs::set_permissions(&file, permissions).unwrap();
    let result = build_project_snapshot(temp.path(), ProjectRevision(1), SnapshotLimits::default());
    let mut restore = fs::metadata(&file).unwrap().permissions();
    restore.set_mode(0o600);
    fs::set_permissions(&file, restore).unwrap();
    let error = result.unwrap_err();
    assert!(matches!(error, SnapshotError::ReadFailed(ref path) if path == "analysis.R"));
    assert!(
        !error
            .to_string()
            .contains(temp.path().to_string_lossy().as_ref())
    );
}

#[test]
fn snapshot_watcher_advances_project_revision_and_marks_old_snapshot_stale_once() {
    let temp = project();
    let snapshot =
        build_project_snapshot(temp.path(), ProjectRevision(9), SnapshotLimits::default()).unwrap();
    let mut watcher = ProjectRevisionWatcher::from_snapshot(&snapshot, SnapshotLimits::default());
    assert_eq!(
        watcher.detect_external_mutation(temp.path()).unwrap(),
        ProjectRevision(9)
    );
    fs::write(temp.path().join("analysis.R"), "x <- 99\n").unwrap();
    assert_eq!(
        watcher.detect_external_mutation(temp.path()).unwrap(),
        ProjectRevision(10)
    );
    assert!(watcher.is_stale(&snapshot));
    assert_eq!(
        watcher.detect_external_mutation(temp.path()).unwrap(),
        ProjectRevision(10)
    );
}

#[test]
fn snapshot_boundary_has_no_live_mount_or_absolute_path_identity() {
    let (_, does_not_own) = snapshot_boundary();
    assert!(does_not_own.contains(&"live_authoritative_mount"));
    assert!(does_not_own.contains(&"absolute_host_path"));
    assert!(does_not_own.contains(&"symlink_follow"));
}
