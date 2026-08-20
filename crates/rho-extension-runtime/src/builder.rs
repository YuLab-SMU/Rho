//! Phase 2.5 staged candidate builder (P2.5-2).
//!
//! The builder is a broker-owned workflow that stages an Agent-authored
//! candidate package as immutable, digest-bound provenance — no production
//! grant, no activation, and autonomy capped at `A3 draft`. This module is a
//! pure model of the staging boundary: it proves what the builder *may* and
//! *may not* do, without executing any build, and it fails closed on hostile
//! inputs.
//!
//! The builder never writes into the active package directory, never replaces
//! the accepted pointer, never edits policy/protected fixtures/grants/audit,
//! and never marks its own candidate accepted.

use serde::{Deserialize, Serialize};

use crate::digest::PackageDigest;
use crate::{AutonomyLevel, PluginId, ScopeId};

/// The one restricted candidate profile available in P2.5-2: a validated
/// manifest plus immutable provenance. No executable code is run here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateProfile {
    pub candidate_id: String,
    pub project_id: ScopeId,
    pub lineage_id: String,
    pub plugin_id: PluginId,
    /// The candidate package digest (an executable identity, never a live
    /// patch).
    pub package_digest: PackageDigest,
    /// The exact parent digest this candidate was derived from.
    pub parent_digest: PackageDigest,
    /// Whether the builder may later request evaluation (never activation).
    pub autonomy: AutonomyLevel,
}

/// Immutable build provenance. Every field is a digest or bounded identifier;
/// raw credentials and hidden model reasoning are never recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildProvenance {
    pub source_digest: PackageDigest,
    pub manifest_digest: PackageDigest,
    pub dependency_lock_digest: PackageDigest,
    pub build_input_digest: PackageDigest,
    pub builder_identity_class: String,
    pub tool_versions: Vec<String>,
    pub generated_file_inventory: Vec<String>,
}

/// A candidate's static-validation outcome. The builder may run allowed
/// formatters/compilers/tests, but a candidate that deletes a regression,
/// changes expected output to match itself, narrows the tested input domain, or
/// makes a failing case unreachable is rejected as evaluation tampering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum StaticValidation {
    Pass,
    Fail { reasons: Vec<String> },
}

/// A staged candidate artifact bound to its profile and provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedCandidate {
    pub profile: CandidateProfile,
    pub provenance: BuildProvenance,
    pub static_validation: StaticValidation,
}

/// Error kind for the staging boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuilderError {
    /// The candidate widens the standing envelope (any capability, permission,
    /// runtime, data, dependency, host, path, or budget outside it).
    EnvelopeWidened,
    /// The candidate attempts to reach policy, protected fixtures, grants,
    /// audit, credentials, or another project.
    AuthorityEscape,
    /// The autonomy level exceeded `A3 draft`.
    AutonomyTooHigh,
    /// The candidate digest equals the parent (not an evolution step).
    NoopCandidate,
    /// The provenance is incomplete or mutable.
    InvalidProvenance,
}

/// The broker-owned staging boundary. It is a pure reference monitor over the
/// builder; it holds no execution and no persistent store.
#[derive(Debug, Default)]
pub struct StagingLedger {
    /// Keyed by exact `(project_id, candidate_id)`.
    candidates: std::collections::BTreeMap<(ScopeId, String), StagedCandidate>,
}

impl StagingLedger {
    pub fn new() -> Self {
        Self {
            candidates: std::collections::BTreeMap::new(),
        }
    }

    /// Stage a candidate. Enforces project/lineage policy binding, the standing
    /// envelope, the autonomy cap, provenance, and digest identity atomically.
    pub fn stage(
        &mut self,
        policy: &crate::StandingPolicy,
        candidate_envelopes: &crate::EvolutionEnvelopes,
        candidate: StagedCandidate,
    ) -> Result<(), BuilderError> {
        if !policy.is_active()
            || policy.project_id != candidate.profile.project_id
            || policy.lineage_id != candidate.profile.lineage_id
        {
            return Err(BuilderError::AuthorityEscape);
        }
        if !policy.envelopes.contains(candidate_envelopes) {
            return Err(BuilderError::EnvelopeWidened);
        }
        if candidate.profile.autonomy > AutonomyLevel::A3Draft
            || candidate.profile.autonomy > policy.autonomy
        {
            return Err(BuilderError::AutonomyTooHigh);
        }
        if candidate.profile.package_digest == candidate.profile.parent_digest {
            return Err(BuilderError::NoopCandidate);
        }
        if candidate.profile.candidate_id.is_empty()
            || candidate.profile.lineage_id.is_empty()
            || candidate.provenance.builder_identity_class.is_empty()
            || candidate.provenance.tool_versions.is_empty()
            || candidate.provenance.generated_file_inventory.is_empty()
            || candidate.provenance.generated_file_inventory.len() > crate::MAX_PACKAGE_FILES
            || candidate
                .provenance
                .generated_file_inventory
                .iter()
                .any(|path| !valid_staged_path(path))
        {
            return Err(BuilderError::InvalidProvenance);
        }
        let key = (
            candidate.profile.project_id.clone(),
            candidate.profile.candidate_id.clone(),
        );
        if self.candidates.contains_key(&key) {
            // Fail closed on duplicate rather than silently overwrite.
            return Err(BuilderError::InvalidProvenance);
        }
        self.candidates.insert(key, candidate);
        Ok(())
    }

    /// Remove a staged candidate. It never affects an accepted plugin because
    /// staging is a separate lane with no pointer into production.
    pub fn discard(&mut self, project_id: &ScopeId, candidate_id: &str) -> bool {
        self.candidates
            .remove(&(project_id.clone(), candidate_id.to_string()))
            .is_some()
    }

    pub fn get(&self, project_id: &ScopeId, candidate_id: &str) -> Option<&StagedCandidate> {
        self.candidates
            .get(&(project_id.clone(), candidate_id.to_string()))
    }

    pub fn candidates(&self, project_id: &ScopeId) -> impl Iterator<Item = &StagedCandidate> {
        self.candidates
            .iter()
            .filter(move |((project, _), _)| project == project_id)
            .map(|(_, candidate)| candidate)
    }
}

fn valid_staged_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= crate::MAX_RELATIVE_PATH_BYTES
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains(':')
        && !path
            .split(['/', '\\'])
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
}

/// Pure predicate: a candidate manifest diff is inside the standing envelope if
/// every newly declared namespace already appears in the policy envelopes.
/// This mirrors, but does not replace, `validate_candidate_against_policy`.
pub fn candidate_within_envelope(
    policy: &crate::StandingPolicy,
    project_id: &ScopeId,
    lineage_id: &str,
    candidate_envelopes: &crate::EvolutionEnvelopes,
) -> bool {
    policy.is_active()
        && &policy.project_id == project_id
        && policy.lineage_id == lineage_id
        && policy.envelopes.contains(candidate_envelopes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(id: &str) -> ScopeId {
        ScopeId::new(id).unwrap()
    }

    fn plugin(id: &str) -> PluginId {
        PluginId::new(id).unwrap()
    }

    fn digest(seed: &str) -> PackageDigest {
        PackageDigest::from_inventory(&[(seed.as_bytes(), seed.as_bytes())])
    }

    fn candidate(id: &str, autonomy: AutonomyLevel) -> StagedCandidate {
        StagedCandidate {
            profile: CandidateProfile {
                candidate_id: id.to_string(),
                project_id: scope("scope.project"),
                lineage_id: "lineage.1".to_string(),
                plugin_id: plugin("org.example.a"),
                package_digest: digest("v2"),
                parent_digest: digest("v1"),
                autonomy,
            },
            provenance: BuildProvenance {
                source_digest: digest("src"),
                manifest_digest: digest("man"),
                dependency_lock_digest: digest("dep"),
                build_input_digest: digest("in"),
                builder_identity_class: "agent".to_string(),
                tool_versions: vec!["rustc 1.88".to_string()],
                generated_file_inventory: vec!["dist/plugin.wasm".to_string()],
            },
            static_validation: StaticValidation::Pass,
        }
    }

    fn candidate_envelopes() -> crate::EvolutionEnvelopes {
        crate::EvolutionEnvelopes {
            runtime_kinds: vec!["wasm".to_string()],
            ..Default::default()
        }
    }

    fn policy() -> crate::StandingPolicy {
        crate::StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A3Draft,
            candidate_envelopes(),
        )
    }

    #[test]
    fn stage_caps_autonomy_at_a3() {
        let mut ledger = StagingLedger::new();
        let ok = candidate("c1", AutonomyLevel::A3Draft);
        ledger.stage(&policy(), &candidate_envelopes(), ok).unwrap();

        let too_high = candidate("c2", AutonomyLevel::A5EnvelopeAutonomous);
        assert_eq!(
            ledger.stage(&policy(), &candidate_envelopes(), too_high),
            Err(BuilderError::AutonomyTooHigh)
        );
    }

    #[test]
    fn noop_candidate_is_rejected() {
        let mut ledger = StagingLedger::new();
        let mut noop = candidate("c1", AutonomyLevel::A3Draft);
        noop.profile.package_digest = noop.profile.parent_digest.clone();
        assert_eq!(
            ledger.stage(&policy(), &candidate_envelopes(), noop),
            Err(BuilderError::NoopCandidate)
        );
    }

    #[test]
    fn discard_removes_without_touching_others() {
        let mut ledger = StagingLedger::new();
        let project = scope("scope.project");
        ledger
            .stage(
                &policy(),
                &candidate_envelopes(),
                candidate("c1", AutonomyLevel::A3Draft),
            )
            .unwrap();
        ledger
            .stage(
                &policy(),
                &candidate_envelopes(),
                candidate("c2", AutonomyLevel::A3Draft),
            )
            .unwrap();
        assert!(ledger.discard(&project, "c1"));
        assert!(ledger.get(&project, "c1").is_none());
        assert!(ledger.get(&project, "c2").is_some());
    }

    #[test]
    fn envelope_widening_detected() {
        let policy = crate::StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A3Draft,
            crate::EvolutionEnvelopes {
                runtime_kinds: vec!["wasm".to_string()],
                ..Default::default()
            },
        );
        let inside = crate::EvolutionEnvelopes {
            runtime_kinds: vec!["wasm".to_string()],
            ..Default::default()
        };
        let widened = crate::EvolutionEnvelopes {
            runtime_kinds: vec!["wasm".to_string(), "web-worker".to_string()],
            ..Default::default()
        };
        assert!(candidate_within_envelope(
            &policy,
            &scope("scope.project"),
            "lineage.1",
            &inside
        ));
        assert!(!candidate_within_envelope(
            &policy,
            &scope("scope.project"),
            "lineage.1",
            &widened
        ));
        assert!(!candidate_within_envelope(
            &policy,
            &scope("scope.other"),
            "lineage.1",
            &inside
        ));
    }

    #[test]
    fn staging_access_is_project_bound() {
        let mut ledger = StagingLedger::new();
        let project = scope("scope.project");
        ledger
            .stage(
                &policy(),
                &candidate_envelopes(),
                candidate("c1", AutonomyLevel::A3Draft),
            )
            .unwrap();
        assert!(ledger.get(&scope("scope.other"), "c1").is_none());
        assert!(!ledger.discard(&scope("scope.other"), "c1"));
        assert_eq!(ledger.candidates(&scope("scope.other")).count(), 0);
        assert_eq!(ledger.candidates(&project).count(), 1);
        assert!(ledger.get(&project, "c1").is_some());
    }
}
