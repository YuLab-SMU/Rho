use std::collections::BTreeSet;

use rho_protocol::{CapabilityId, ProjectRevision};
use rho_sandbox::platform::{SandboxGuarantee, required_mutation_guarantees};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    BrokerProjectCommitter, PatchApprovalBinding, PreparedProjectPatch, ProjectCommitError,
    ProjectCommitOutcome,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecurityProfileEvidence {
    pub profile_id: String,
    pub platform: String,
    pub provider_id: String,
    pub provider_executable_digest: String,
    pub corpus_report_digest: String,
    pub corpus_passed: bool,
    pub reviewer_evidence_digest: String,
    pub guarantees: BTreeSet<SandboxGuarantee>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifiedMutationProfile {
    pub evidence: SecurityProfileEvidence,
    pub controlled_mutation_enabled: bool,
    pub reason_code: String,
}

impl VerifiedMutationProfile {
    pub fn evaluate(evidence: SecurityProfileEvidence) -> Self {
        let required = required_mutation_guarantees()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let digests_valid = [
            evidence.provider_executable_digest.as_str(),
            evidence.corpus_report_digest.as_str(),
            evidence.reviewer_evidence_digest.as_str(),
        ]
        .iter()
        .all(|digest| valid_digest(digest));
        let controlled_mutation_enabled =
            evidence.corpus_passed && digests_valid && required.is_subset(&evidence.guarantees);
        Self {
            evidence,
            controlled_mutation_enabled,
            reason_code: if controlled_mutation_enabled {
                "verified_security_profile".to_string()
            } else {
                "observer_only_unverified_security_profile".to_string()
            },
        }
    }

    pub fn advertises(&self, capability_id: &CapabilityId) -> bool {
        if capability_id.as_str() == "project.apply_patch" {
            self.controlled_mutation_enabled
        } else {
            true
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlledMutationReport {
    pub profile_id: String,
    pub patch_id: String,
    pub base_project_revision: ProjectRevision,
    pub resulting_project_revision: Option<ProjectRevision>,
    pub state: String,
    pub reobserve_required: bool,
    pub provider_permission_was_authority: bool,
    pub sandbox_scope: String,
}

#[derive(Debug, Error)]
pub enum ControlledMutationError {
    #[error("controlled mutation is disabled for this security profile")]
    ProfileDisabled,
    #[error("capability is not advertised by the verified profile")]
    CapabilityNotAdvertised,
    #[error("Broker patch commit rejected: {0}")]
    Commit(#[from] ProjectCommitError),
}

pub fn controlled_mutation_capabilities(
    read_capabilities: impl IntoIterator<Item = CapabilityId>,
    profile: &VerifiedMutationProfile,
) -> Vec<CapabilityId> {
    let mut capabilities = read_capabilities.into_iter().collect::<BTreeSet<_>>();
    let patch = CapabilityId::new("project.apply_patch").unwrap();
    if profile.advertises(&patch) {
        capabilities.insert(patch);
    } else {
        capabilities.remove(&patch);
    }
    capabilities.into_iter().collect()
}

pub fn admit_controlled_mutation_api(
    profile: &VerifiedMutationProfile,
    capability_id: &CapabilityId,
) -> Result<(), ControlledMutationError> {
    if capability_id.as_str() != "project.apply_patch" {
        return Err(ControlledMutationError::CapabilityNotAdvertised);
    }
    if !profile.controlled_mutation_enabled {
        return Err(ControlledMutationError::ProfileDisabled);
    }
    Ok(())
}

pub fn execute_controlled_patch(
    profile: &VerifiedMutationProfile,
    committer: &mut BrokerProjectCommitter,
    prepared: &PreparedProjectPatch<'_>,
    approval: &PatchApprovalBinding,
    now_ms: u64,
) -> Result<(ProjectCommitOutcome, ControlledMutationReport), ControlledMutationError> {
    admit_controlled_mutation_api(profile, &CapabilityId::new("project.apply_patch").unwrap())?;
    // A Provider permission signal is deliberately absent: exact Broker approval
    // remains mandatory and is validated inside the committer.
    let outcome = committer.commit(
        prepared,
        approval,
        rho_protocol::DestinationClass::LocalSandbox,
        now_ms,
    )?;
    let resulting_project_revision = match &outcome {
        ProjectCommitOutcome::Committed { transition, .. } => {
            Some(transition.after.project_revision)
        }
        ProjectCommitOutcome::ReconcileRequired { .. } => None,
    };
    let state = match &outcome {
        ProjectCommitOutcome::Committed { .. } => "committed",
        ProjectCommitOutcome::ReconcileRequired { .. } => "reconcile_required",
    };
    Ok((
        outcome,
        ControlledMutationReport {
            profile_id: profile.evidence.profile_id.clone(),
            patch_id: prepared.patch.patch_id.clone(),
            base_project_revision: prepared.patch.base_project_revision,
            resulting_project_revision,
            state: state.to_string(),
            reobserve_required: resulting_project_revision.is_some(),
            provider_permission_was_authority: false,
            sandbox_scope: "/workspace:ro,/scratch:rw,/staging:rw,authoritative-project:none"
                .to_string(),
        },
    ))
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.chars().all(|character| character.is_ascii_hexdigit())
    })
}

pub fn controlled_mutation_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "verified_profile_advertisement",
            "broker_approval",
            "staged_patch_commit",
            "revision_reobserve",
        ],
        &[
            "user_toggle_bypass",
            "provider_permission_authority",
            "live_project_mount",
            "host_terminal",
            "direct_write_test_hook",
        ],
    )
}
