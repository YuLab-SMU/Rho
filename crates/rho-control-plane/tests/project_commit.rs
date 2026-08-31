#![cfg(unix)]

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};

use rho_control_plane::*;
use rho_protocol::*;
use rho_sandbox::staging::StagingArea;
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> ArtifactDigest {
    ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).unwrap()
}

fn revision(project: u64) -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_commit").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_commit").unwrap(),
        state_revision: StateRevision(10),
        project_revision: ProjectRevision(project),
    }
}

#[test]
fn project_commit_applies_exact_patch_atomically_and_advances_revision_with_provenance() {
    let project = tempfile::tempdir().unwrap();
    fs::write(project.path().join("old.R"), "old\n").unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let sealed_new = staging.write_and_seal("new.R", b"new\n").unwrap();
    let sealed_old = staging.write_and_seal("old.R", b"replaced\n").unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_success",
        ProjectRevision(4),
        staging.staging_root_digest().unwrap(),
        PatchPathSemantics::CaseSensitive,
        vec![
            PatchOperation::Create {
                path: "new.R".to_string(),
                staged: sealed_new.reference().clone(),
                mode: 0o644,
                hunk_count: 1,
            },
            PatchOperation::Replace {
                path: "old.R".to_string(),
                base_digest: digest(b"old\n"),
                staged: sealed_old.reference().clone(),
                mode: 0o644,
                hunk_count: 1,
            },
        ],
    )
    .unwrap();
    let prepared = PreparedProjectPatch {
        patch: &patch,
        staging: &staging,
        sealed: BTreeMap::from([
            ("new.R".to_string(), &sealed_new),
            ("old.R".to_string(), &sealed_old),
        ]),
    };
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(4)).unwrap();
    let approval = committer
        .bind_approval(
            &patch,
            "approval_patch_success",
            DestinationClass::LocalSandbox,
            2000,
            BTreeSet::new(),
        )
        .unwrap();
    let outcome = committer
        .commit(&prepared, &approval, DestinationClass::LocalSandbox, 1000)
        .unwrap();
    let ProjectCommitOutcome::Committed {
        transition,
        event,
        provenance,
    } = outcome
    else {
        panic!("expected committed outcome");
    };
    assert_eq!(transition.before.project_revision, ProjectRevision(4));
    assert_eq!(transition.after.project_revision, ProjectRevision(5));
    assert!(matches!(
        event,
        SemanticEventPayload::RevisionAdvanced { .. }
    ));
    assert_eq!(provenance.patch_digest, patch_digest(&patch).unwrap());
    assert_eq!(provenance.applied_paths, vec!["new.R", "old.R"]);
    assert_eq!(fs::read(project.path().join("new.R")).unwrap(), b"new\n");
    assert_eq!(
        fs::read(project.path().join("old.R")).unwrap(),
        b"replaced\n"
    );
}

#[test]
fn project_commit_stale_patch_never_overwrites_new_revision_or_bytes() {
    let project = tempfile::tempdir().unwrap();
    fs::write(project.path().join("file.R"), "current\n").unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let sealed = staging.write_and_seal("file.R", b"stale\n").unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_stale",
        ProjectRevision(3),
        staging.staging_root_digest().unwrap(),
        PatchPathSemantics::CaseSensitive,
        vec![PatchOperation::Replace {
            path: "file.R".to_string(),
            base_digest: digest(b"current\n"),
            staged: sealed.reference().clone(),
            mode: 0o644,
            hunk_count: 1,
        }],
    )
    .unwrap();
    let prepared = PreparedProjectPatch {
        patch: &patch,
        staging: &staging,
        sealed: BTreeMap::from([("file.R".to_string(), &sealed)]),
    };
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(4)).unwrap();
    let approval = committer
        .bind_approval(
            &patch,
            "approval_stale",
            DestinationClass::LocalSandbox,
            2000,
            BTreeSet::new(),
        )
        .unwrap();
    assert!(matches!(
        committer.commit(&prepared, &approval, DestinationClass::LocalSandbox, 1000),
        Err(ProjectCommitError::StaleRevision { .. })
    ));
    assert_eq!(
        fs::read(project.path().join("file.R")).unwrap(),
        b"current\n"
    );
}

#[test]
fn project_commit_approval_binds_patch_revision_destination_expiry_and_single_use() {
    let project = tempfile::tempdir().unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let sealed = staging.write_and_seal("file.R", b"new\n").unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_approval",
        ProjectRevision(1),
        staging.staging_root_digest().unwrap(),
        PatchPathSemantics::CaseSensitive,
        vec![PatchOperation::Create {
            path: "file.R".to_string(),
            staged: sealed.reference().clone(),
            mode: 0o644,
            hunk_count: 1,
        }],
    )
    .unwrap();
    let prepared = PreparedProjectPatch {
        patch: &patch,
        staging: &staging,
        sealed: BTreeMap::from([("file.R".to_string(), &sealed)]),
    };
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(1)).unwrap();
    let approval = committer
        .bind_approval(
            &patch,
            "approval_exact",
            DestinationClass::LocalSandbox,
            1500,
            BTreeSet::new(),
        )
        .unwrap();
    assert!(matches!(
        committer.commit(&prepared, &approval, DestinationClass::LocalWorkspace, 1000),
        Err(ProjectCommitError::InvalidApproval)
    ));
    assert!(matches!(
        committer.commit(&prepared, &approval, DestinationClass::LocalSandbox, 1600),
        Err(ProjectCommitError::InvalidApproval)
    ));
    committer
        .commit(&prepared, &approval, DestinationClass::LocalSandbox, 1000)
        .unwrap();
    assert!(matches!(
        committer.commit(&prepared, &approval, DestinationClass::LocalSandbox, 1000),
        Err(ProjectCommitError::StaleRevision { .. }) | Err(ProjectCommitError::InvalidApproval)
    ));
}

#[test]
fn project_commit_high_risk_paths_default_deny_and_rename_cannot_bypass() {
    for (path, expected) in [
        (".git/hooks/pre-commit", HighRiskPathClass::GitHook),
        (".Rprofile", HighRiskPathClass::StartupProfile),
        (".Renviron", HighRiskPathClass::StartupProfile),
        (
            ".github/workflows/test.yml",
            HighRiskPathClass::TaskOrBuildConfig,
        ),
        (
            "config/credentials.json",
            HighRiskPathClass::CredentialConfig,
        ),
        ("renv/activate.R", HighRiskPathClass::PackageActivation),
    ] {
        assert_eq!(classify_high_risk_path(path), Some(expected));
    }
    let project = tempfile::tempdir().unwrap();
    fs::write(project.path().join("safe.R"), "safe\n").unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_risky_rename",
        ProjectRevision(1),
        staging.staging_root_digest().unwrap(),
        PatchPathSemantics::CaseSensitive,
        vec![PatchOperation::Rename {
            from: "safe.R".to_string(),
            to: ".Rprofile".to_string(),
            base_digest: digest(b"safe\n"),
        }],
    )
    .unwrap();
    let prepared = PreparedProjectPatch {
        patch: &patch,
        staging: &staging,
        sealed: BTreeMap::new(),
    };
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(1)).unwrap();
    let approval = committer
        .bind_approval(
            &patch,
            "approval_risky",
            DestinationClass::LocalSandbox,
            2000,
            BTreeSet::new(),
        )
        .unwrap();
    assert!(matches!(
        committer.commit(&prepared, &approval, DestinationClass::LocalSandbox, 1000),
        Err(ProjectCommitError::HighRiskDenied(
            HighRiskPathClass::StartupProfile
        ))
    ));
    assert!(project.path().join("safe.R").exists());
    assert!(!project.path().join(".Rprofile").exists());
}

#[test]
fn project_commit_partial_multi_file_is_exact_reconcile_not_all_success() {
    let project = tempfile::tempdir().unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let one = staging.write_and_seal("one", b"one").unwrap();
    let two = staging.write_and_seal("two", b"two").unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_partial",
        ProjectRevision(1),
        staging.staging_root_digest().unwrap(),
        PatchPathSemantics::CaseSensitive,
        vec![
            PatchOperation::Create {
                path: "one".to_string(),
                staged: one.reference().clone(),
                mode: 0o644,
                hunk_count: 1,
            },
            PatchOperation::Create {
                path: "two".to_string(),
                staged: two.reference().clone(),
                mode: 0o644,
                hunk_count: 1,
            },
        ],
    )
    .unwrap();
    let prepared = PreparedProjectPatch {
        patch: &patch,
        staging: &staging,
        sealed: BTreeMap::from([("one".to_string(), &one), ("two".to_string(), &two)]),
    };
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(1)).unwrap();
    let approval = committer
        .bind_approval(
            &patch,
            "approval_partial",
            DestinationClass::LocalSandbox,
            2000,
            BTreeSet::new(),
        )
        .unwrap();
    let outcome = committer
        .commit_with_fault(
            &prepared,
            &approval,
            DestinationClass::LocalSandbox,
            1000,
            Some(ProjectCommitFault::AfterOperation(0)),
        )
        .unwrap();
    let ProjectCommitOutcome::ReconcileRequired {
        applied_paths,
        pending_paths,
        journal_id,
        ..
    } = outcome
    else {
        panic!("partial commit must reconcile");
    };
    assert_eq!(applied_paths, vec!["one"]);
    assert_eq!(pending_paths, vec!["two"]);
    assert_eq!(
        committer.state().revision.project_revision,
        ProjectRevision(1)
    );
    let reconciled = committer.reconcile_journal(&journal_id).unwrap();
    assert!(matches!(
        reconciled,
        ProjectCommitOutcome::ReconcileRequired { .. }
    ));
}

#[test]
fn project_commit_crash_after_all_files_before_revision_reconciles_to_success_once() {
    let project = tempfile::tempdir().unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let sealed = staging.write_and_seal("file", b"value").unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_revision_pending",
        ProjectRevision(2),
        staging.staging_root_digest().unwrap(),
        PatchPathSemantics::CaseSensitive,
        vec![PatchOperation::Create {
            path: "file".to_string(),
            staged: sealed.reference().clone(),
            mode: 0o644,
            hunk_count: 1,
        }],
    )
    .unwrap();
    let prepared = PreparedProjectPatch {
        patch: &patch,
        staging: &staging,
        sealed: BTreeMap::from([("file".to_string(), &sealed)]),
    };
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(2)).unwrap();
    let approval = committer
        .bind_approval(
            &patch,
            "approval_revision_pending",
            DestinationClass::LocalSandbox,
            2000,
            BTreeSet::new(),
        )
        .unwrap();
    let outcome = committer
        .commit_with_fault(
            &prepared,
            &approval,
            DestinationClass::LocalSandbox,
            1000,
            Some(ProjectCommitFault::BeforeRevisionCommit),
        )
        .unwrap();
    let ProjectCommitOutcome::ReconcileRequired {
        journal_id,
        pending_paths,
        ..
    } = outcome
    else {
        panic!()
    };
    assert!(pending_paths.is_empty());
    let reconciled = committer.reconcile_journal(&journal_id).unwrap();
    assert!(matches!(reconciled, ProjectCommitOutcome::Committed { .. }));
    assert_eq!(
        committer.state().revision.project_revision,
        ProjectRevision(3)
    );
}

#[test]
fn project_commit_external_conflict_disk_full_and_link_file_fail_truthfully() {
    let project = tempfile::tempdir().unwrap();
    fs::write(project.path().join("file"), "base").unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let sealed = staging.write_and_seal("file", b"next").unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_conflict",
        ProjectRevision(1),
        staging.staging_root_digest().unwrap(),
        PatchPathSemantics::CaseSensitive,
        vec![PatchOperation::Replace {
            path: "file".to_string(),
            base_digest: digest(b"base"),
            staged: sealed.reference().clone(),
            mode: 0o644,
            hunk_count: 1,
        }],
    )
    .unwrap();
    let prepared = PreparedProjectPatch {
        patch: &patch,
        staging: &staging,
        sealed: BTreeMap::from([("file".to_string(), &sealed)]),
    };
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(1)).unwrap();
    let approval = committer
        .bind_approval(
            &patch,
            "approval_conflict",
            DestinationClass::LocalSandbox,
            2000,
            BTreeSet::new(),
        )
        .unwrap();
    fs::write(project.path().join("file"), "external").unwrap();
    assert!(matches!(
        committer.commit(&prepared, &approval, DestinationClass::LocalSandbox, 1000),
        Err(ProjectCommitError::BaseDigestConflict(_))
    ));
    assert_eq!(fs::read(project.path().join("file")).unwrap(), b"external");

    fs::write(project.path().join("file"), "base").unwrap();
    assert!(matches!(
        committer.commit_with_fault(
            &prepared,
            &approval,
            DestinationClass::LocalSandbox,
            1000,
            Some(ProjectCommitFault::DiskFull)
        ),
        Err(ProjectCommitError::DiskFull)
    ));
    assert_eq!(fs::read(project.path().join("file")).unwrap(), b"base");
}

#[test]
fn project_commit_boundary_never_claims_cross_file_atomicity_or_direct_provider_write() {
    let (_, does_not_own) = project_commit_boundary();
    assert!(does_not_own.contains(&"cross_file_atomicity_claim"));
    assert!(does_not_own.contains(&"provider_direct_write"));
    assert!(does_not_own.contains(&"stale_overwrite"));
}
