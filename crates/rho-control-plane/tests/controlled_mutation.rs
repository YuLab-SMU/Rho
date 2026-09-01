#![cfg(unix)]

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};

use rho_control_plane::*;
use rho_protocol::*;
use rho_sandbox::{platform::required_mutation_guarantees, staging::StagingArea};

fn digest(byte: char) -> String {
    format!("sha256:{}", byte.to_string().repeat(64))
}

fn attestation(passed: bool, all_guarantees: bool) -> SecurityProfileAttestation {
    SecurityProfileAttestation {
        profile_id: "security_profile_linux_verified".to_string(),
        platform: "linux".to_string(),
        provider_id: "provider_external_observer".to_string(),
        provider_executable_digest: digest('a'),
        corpus_report_digest: digest('b'),
        reviewer_attestation_digest: digest('c'),
        corpus_passed: passed,
        guarantees: if all_guarantees {
            required_mutation_guarantees().into_iter().collect()
        } else {
            BTreeSet::new()
        },
    }
}

fn revision(project: u64) -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_mutation").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_mutation").unwrap(),
        state_revision: StateRevision(3),
        project_revision: ProjectRevision(project),
    }
}

#[test]
fn controlled_mutation_capability_is_advertised_only_by_verified_security_profile() {
    let verified = VerifiedMutationProfile::evaluate(attestation(true, true));
    assert!(verified.controlled_mutation_enabled);
    let disabled = VerifiedMutationProfile::evaluate(attestation(true, false));
    assert!(!disabled.controlled_mutation_enabled);
    let reads = vec![CapabilityId::new("workspace.inspect").unwrap()];
    let enabled = controlled_mutation_capabilities(reads.clone(), &verified);
    assert!(enabled.contains(&CapabilityId::new("project.apply_patch").unwrap()));
    let observer = controlled_mutation_capabilities(reads, &disabled);
    assert!(!observer.contains(&CapabilityId::new("project.apply_patch").unwrap()));
    assert!(matches!(
        admit_controlled_mutation_api(
            &disabled,
            &CapabilityId::new("project.apply_patch").unwrap()
        ),
        Err(ControlledMutationError::ProfileDisabled)
    ));
}

#[test]
fn controlled_mutation_pipeline_requires_broker_approval_commits_revision_and_reobserve() {
    let project = tempfile::tempdir().unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let sealed = staging.write_and_seal("analysis.R", b"x <- 2\n").unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_controlled",
        ProjectRevision(4),
        staging.staging_root_digest().unwrap(),
        PatchPathSemantics::CaseSensitive,
        vec![PatchOperation::Create {
            path: "analysis.R".to_string(),
            staged: sealed.reference().clone(),
            mode: 0o644,
            hunk_count: 1,
        }],
    )
    .unwrap();
    let prepared = PreparedProjectPatch {
        patch: &patch,
        staging: &staging,
        sealed: BTreeMap::from([("analysis.R".to_string(), &sealed)]),
    };
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(4)).unwrap();
    let approval = committer
        .bind_approval(
            &patch,
            "approval_controlled",
            DestinationClass::LocalSandbox,
            2000,
            BTreeSet::new(),
        )
        .unwrap();
    let profile = VerifiedMutationProfile::evaluate(attestation(true, true));
    let (outcome, report) =
        execute_controlled_patch(&profile, &mut committer, &prepared, &approval, 1000).unwrap();
    assert!(matches!(outcome, ProjectCommitOutcome::Committed { .. }));
    assert_eq!(report.resulting_project_revision, Some(ProjectRevision(5)));
    assert!(report.reobserve_required);
    assert!(!report.provider_permission_was_authority);
    assert!(report.sandbox_scope.contains("authoritative-project:none"));
    assert_eq!(
        fs::read(project.path().join("analysis.R")).unwrap(),
        b"x <- 2\n"
    );
}

#[test]
fn controlled_mutation_provider_permission_absence_does_not_remove_exact_broker_approval() {
    let project = tempfile::tempdir().unwrap();
    let staging_root = tempfile::tempdir().unwrap();
    let mut staging = StagingArea::open(staging_root.path(), 1024).unwrap();
    let sealed = staging.write_and_seal("file", b"value").unwrap();
    let patch = CanonicalProjectPatch::new(
        "patch_no_provider_permission",
        ProjectRevision(1),
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
    let mut committer = BrokerProjectCommitter::open(project.path(), revision(1)).unwrap();
    let wrong_approval = PatchApprovalBinding {
        approval_id: "forged".to_string(),
        patch_digest: ArtifactDigest::new(digest('f')).unwrap(),
        base_project_revision: ProjectRevision(1),
        destination: DestinationClass::LocalSandbox,
        expires_at_ms: 2000,
        high_risk_acknowledgements: BTreeSet::new(),
    };
    let profile = VerifiedMutationProfile::evaluate(attestation(true, true));
    assert!(matches!(
        execute_controlled_patch(&profile, &mut committer, &prepared, &wrong_approval, 1000,),
        Err(ControlledMutationError::Commit(
            ProjectCommitError::InvalidApproval
        ))
    ));
    assert!(!project.path().join("file").exists());
}

#[test]
fn controlled_mutation_source_has_no_user_toggle_direct_write_terminal_or_test_bypass() {
    let source = include_str!("../src/controlled_mutation/mod.rs")
        .split("pub fn controlled_mutation_boundary")
        .next()
        .unwrap();
    for forbidden in [
        "user_toggle",
        "feature_bypass",
        "WorkspaceExecutor",
        "std::process::Command",
        "direct_write_test_hook",
    ] {
        assert!(
            !source.contains(forbidden),
            "controlled mutation leaked {forbidden}"
        );
    }
    let (_, does_not_own) = controlled_mutation_boundary();
    assert!(does_not_own.contains(&"provider_permission_authority"));
    assert!(does_not_own.contains(&"host_terminal"));
}
