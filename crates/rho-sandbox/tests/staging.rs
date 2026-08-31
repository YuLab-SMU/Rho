#![cfg(unix)]

use std::{
    fs,
    os::unix::{fs::symlink, net::UnixListener},
};

use rho_sandbox::staging::*;

#[test]
fn staging_hashes_closes_and_reads_verified_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(temp.path(), 1024).unwrap();
    let sealed = staging
        .write_and_seal("output/analysis.R", b"x <- 1\n")
        .unwrap();
    assert_eq!(sealed.reference().relative_path, "output/analysis.R");
    assert_eq!(sealed.reference().byte_size, 7);
    assert!(sealed.reference().digest.as_str().starts_with("sha256:"));
    assert_eq!(staging.read_verified(&sealed).unwrap(), b"x <- 1\n");
    assert!(
        staging
            .staging_root_digest()
            .unwrap()
            .as_str()
            .starts_with("sha256:")
    );
}

#[test]
fn staging_file_changed_after_seal_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(temp.path(), 1024).unwrap();
    let sealed = staging.write_and_seal("result.txt", b"first").unwrap();
    fs::write(temp.path().join("result.txt"), b"second").unwrap();
    assert!(matches!(
        staging.read_verified(&sealed),
        Err(StagingError::ChangedAfterSeal)
    ));
}

#[test]
fn staging_rejects_traversal_symlink_hardlink_fifo_and_socket() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let mut staging = StagingArea::open(temp.path(), 1024).unwrap();
    assert!(matches!(
        staging.write_and_seal("../escape", b"bad"),
        Err(StagingError::UnsafePath)
    ));

    symlink(outside.path(), temp.path().join("link")).unwrap();
    assert!(matches!(
        staging.seal("link"),
        Err(StagingError::UnsafeFileType)
    ));
    fs::remove_file(temp.path().join("link")).unwrap();

    fs::hard_link(outside.path(), temp.path().join("hard")).unwrap();
    assert!(matches!(
        staging.seal("hard"),
        Err(StagingError::UnsafeFileType)
    ));
    fs::remove_file(temp.path().join("hard")).unwrap();

    let fifo = temp.path().join("fifo");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    assert!(matches!(
        staging.seal("fifo"),
        Err(StagingError::UnsafeFileType)
    ));
    fs::remove_file(fifo).unwrap();

    let socket = temp.path().join("socket");
    let _listener = UnixListener::bind(&socket).unwrap();
    assert!(matches!(
        staging.seal("socket"),
        Err(StagingError::UnsafeFileType)
    ));
}

#[test]
fn staging_rejects_file_size_and_parent_symlink_escape() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(temp.path(), 4).unwrap();
    assert!(matches!(
        staging.write_and_seal("large", b"12345"),
        Err(StagingError::FileTooLarge)
    ));
    symlink(outside.path(), temp.path().join("escape-dir")).unwrap();
    assert!(matches!(
        staging.write_and_seal("escape-dir/file", b"x"),
        Err(StagingError::PathEscape)
    ));
    assert!(!outside.path().join("file").exists());
}

#[test]
fn staging_boundary_has_no_live_commit_open_handle_host_path_or_shell() {
    let (_, does_not_own) = staging_boundary();
    assert!(does_not_own.contains(&"live_project_commit"));
    assert!(does_not_own.contains(&"open_mutable_handle"));
    assert!(does_not_own.contains(&"host_absolute_path"));
    assert!(does_not_own.contains(&"shell_command"));
}
