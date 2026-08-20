//! Phase 2.5 pure contracts and threat fixtures (P2.5-0).
//!
//! P2.5-0 defines the *vocabulary* and *pure validation* for Agent-authored
//! capability evolution — experience traces, recipes, lineages, candidates,
//! standing policies, evaluation evidence, and capability gardening — without
//! any schema, observation, Agent call, build, plugin execution, or UI.
//!
//! The governing invariants are enforced here as pure functions, not
//! persistence:
//!
//! 1. Package digest is executable identity; `lineage_id` never authorizes.
//! 2. A candidate is an immutable digest, never a live patch.
//! 3. Authority is external to the builder.
//! 4. A standing policy is an upper bound, not a suggestion.
//! 5. Evaluation evidence is versioned; a candidate cannot choose its own gate.
//! 6. No production side-effect replay.
//! 7. Everything is project-scoped.
//! 8. First-party promotion is ordinary product work, never a runtime state.

use serde::{Deserialize, Serialize};

use crate::digest::PackageDigest;
use crate::{PluginId, ScopeId};

/// The monotonic autonomy level. The project default is `A0`; a candidate can
/// never raise its own level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutonomyLevel {
    /// No observation or evolution.
    A0Off,
    /// Bounded trace references and pattern suggestions only.
    A1Observe,
    /// Propose Recipes and Skills; no executable package.
    A2Distill,
    /// Create and test candidate packages in staging; no activation.
    A3Draft,
    /// Protected evaluation plus trusted manual activation.
    A4ReviewToActivate,
    /// Activate a passing candidate under an exact standing policy.
    A5EnvelopeAutonomous,
}

/// Default autonomy for a freshly created lineage, per the design.
pub const DEFAULT_LINEAGE_AUTONOMY: AutonomyLevel = AutonomyLevel::A3Draft;

/// The exact envelopes that bound a standing evolution policy. Each envelope is
/// an upper bound; a candidate outside any envelope is blocked before
/// execution.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvolutionEnvelopes {
    /// Permitted `provides`/`requires` namespaces and contract-major ranges.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capability_namespaces: Vec<String>,
    /// Permitted permission operation classes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permission_classes: Vec<String>,
    /// Allowed runtime kinds (as declared kind strings).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runtime_kinds: Vec<String>,
    /// Permitted project data classes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_classes: Vec<String>,
}

impl EvolutionEnvelopes {
    /// Whether `candidate` stays inside `self` for every named envelope. A
    /// candidate declaring something not in the envelope is outside it.
    pub fn contains(&self, candidate: &EvolutionEnvelopes) -> bool {
        subset(
            &candidate.capability_namespaces,
            &self.capability_namespaces,
        ) && subset(&candidate.permission_classes, &self.permission_classes)
            && subset(&candidate.runtime_kinds, &self.runtime_kinds)
            && subset(&candidate.data_classes, &self.data_classes)
    }
}

fn subset(candidate: &[String], allowed: &[String]) -> bool {
    candidate
        .iter()
        .all(|item| allowed.iter().any(|a| a == item))
}

/// The failure classification used before any repair is attempted. Only the
/// `PluginDefect` class may enter automated repair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    InputPreconditionMismatch,
    PluginDefect,
    EnvironmentDependencyDrift,
    HostRuntimeDefect,
    PermissionPolicyDenial,
    UpstreamCapabilityChange,
    UserCancellationOrStaleState,
    SecurityViolation,
    Unknown,
}

impl FailureClass {
    /// Only a supported plugin-defect classification may enter automated repair.
    pub fn is_autonomous_repair_eligible(self) -> bool {
        matches!(self, Self::PluginDefect)
    }
}

/// The lineage lifecycle state (separate from the version state machine).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineageState {
    Observing,
    Distilled,
    Executable,
    Deprecated,
    Archived,
}

/// The version/candidate state machine within a lineage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionState {
    Draft,
    Validating,
    Evaluating,
    Ready,
    Activating,
    Accepted,
    Rejected,
    Failed,
    RollbackReady,
}

/// Pure outcome: whether a candidate may proceed to evaluation given its
/// declared envelopes against a standing policy's envelopes and autonomy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyMatch {
    /// Candidate stays inside every envelope and may proceed.
    WithinEnvelope,
    /// Candidate widens at least one envelope; trusted review is required.
    RequiresTrustedReview,
    /// The candidate would be self-authorizing or otherwise invalid.
    Rejected,
}

/// A pure, immutable policy-decision vocabulary object. It performs no I/O.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StandingPolicy {
    pub policy_id: String,
    pub revision: u64,
    pub project_id: ScopeId,
    pub lineage_id: String,
    pub autonomy: AutonomyLevel,
    pub envelopes: EvolutionEnvelopes,
    pub revoked: bool,
}

impl StandingPolicy {
    pub fn new(
        policy_id: impl Into<String>,
        revision: u64,
        project_id: ScopeId,
        lineage_id: impl Into<String>,
        autonomy: AutonomyLevel,
        envelopes: EvolutionEnvelopes,
    ) -> Self {
        Self {
            policy_id: policy_id.into(),
            revision,
            project_id,
            lineage_id: lineage_id.into(),
            autonomy,
            envelopes,
            revoked: false,
        }
    }

    /// A revocation never raises autonomy; it only lowers or keeps it. This is
    /// enforced structurally.
    pub fn is_active(&self) -> bool {
        !self.revoked
    }

    /// A builder cannot raise autonomy: the only allowed transitions are to a
    /// lower or equal level, and only the trusted shell may change it. This
    /// pure predicate guards that invariant.
    pub fn autonomy_can_transition_to(&self, next: AutonomyLevel) -> bool {
        next <= self.autonomy
    }
}

/// Pure validation that a candidate's declared envelopes fall within a policy.
///
/// Any widening requires trusted review; self-grant is always rejected.
pub fn validate_candidate_against_policy(
    policy: &StandingPolicy,
    project_id: &ScopeId,
    lineage_id: &str,
    candidate_envelopes: &EvolutionEnvelopes,
    candidate_digest: &PackageDigest,
    expected_parent_digest: &PackageDigest,
) -> PolicyMatch {
    // Invariant 1: a digest is an executable identity. A candidate that does
    // not differ from its parent is a no-op, not an evolution step.
    if candidate_digest == expected_parent_digest
        || &policy.project_id != project_id
        || policy.lineage_id != lineage_id
    {
        return PolicyMatch::Rejected;
    }
    if !policy.is_active() {
        return PolicyMatch::Rejected;
    }
    if policy.envelopes.contains(candidate_envelopes) {
        PolicyMatch::WithinEnvelope
    } else {
        PolicyMatch::RequiresTrustedReview
    }
}

/// A provenance reference. It is a link, never permission to duplicate payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenanceRef {
    pub trace_ref_id: String,
    pub project_id: ScopeId,
}

/// A lineage version, binding the package digest to its parent, source, and
/// evaluation evidence. The `accepted_digest` of a lineage is a broker-owned
/// compare-and-swap pointer, never the authorization principal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineageVersion {
    pub package_digest: PackageDigest,
    pub parent_digest: PackageDigest,
    pub state: VersionState,
}

/// A pure broker-side lineage object. It records ancestry but never grants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginLineage {
    pub lineage_id: String,
    pub project_id: ScopeId,
    pub plugin_id: PluginId,
    /// The broker-owned accepted digest (a compare-and-swap pointer).
    pub accepted_digest: Option<PackageDigest>,
    pub rollback_digest: Option<PackageDigest>,
    pub state: LineageState,
    pub versions: Vec<LineageVersion>,
    pub parent_lineage_ids: Vec<String>,
}

impl PluginLineage {
    pub fn new(
        lineage_id: impl Into<String>,
        project_id: ScopeId,
        plugin_id: PluginId,
        accepted_digest: Option<PackageDigest>,
    ) -> Self {
        Self {
            lineage_id: lineage_id.into(),
            project_id,
            plugin_id,
            accepted_digest,
            rollback_digest: None,
            state: LineageState::Distilled,
            versions: Vec::new(),
            parent_lineage_ids: Vec::new(),
        }
    }

    /// Try to advance the accepted pointer using compare-and-swap semantics.
    /// Returns `false` (rejected) when the expected old digest does not match
    /// the currently accepted digest — a stale publication.
    pub fn try_publish(
        &mut self,
        expected_old: &PackageDigest,
        promotion: &crate::ManualPromotion,
    ) -> bool {
        if self.accepted_digest.as_ref() != Some(expected_old)
            || promotion.parent_digest() != expected_old
            || promotion.rollback_digest() != expected_old
            || promotion.project_id() != &self.project_id
            || promotion.lineage_id() != self.lineage_id
            || promotion.plugin_id() != &self.plugin_id
            || promotion.candidate_digest() == expected_old
        {
            return false;
        }
        self.rollback_digest = self.accepted_digest.take();
        self.accepted_digest = Some(promotion.candidate_digest().clone());
        true
    }
}

/// Capability gardening proposals. Similarity is heuristic; it creates no
/// authority and never deletes or merges on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GardenAction {
    Merge { parents: Vec<String> },
    Generalize,
    Split,
    Deprecate,
    Archive,
    Retire,
    PromoteForFirstParty,
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

    fn envelopes(kinds: &[&str]) -> EvolutionEnvelopes {
        EvolutionEnvelopes {
            runtime_kinds: kinds.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn promotion(parent: &str, candidate: &str) -> crate::ManualPromotion {
        let plan = crate::EvaluationPlan {
            plan_id: "plan.1".to_string(),
            project_id: scope("scope.project"),
            lineage_id: "lineage.1".to_string(),
            plugin_id: plugin("org.example.a"),
            baseline_digest: digest(parent),
            candidate_digest: digest(candidate),
            protected_fixture_set_digest: digest("fixtures"),
            mandatory_cases: vec!["regression".to_string()],
            required_layers: vec!["correctness".to_string()],
            minimum_improvement_rule: None,
            rejection_conditions: vec!["crash".to_string()],
        };
        let sealed = plan.seal().unwrap();
        let evidence = crate::EvaluationEvidence {
            evidence_id: "evidence.1".to_string(),
            plan_id: sealed.plan().plan_id.clone(),
            plan_seal_digest: sealed.seal_digest().clone(),
            candidate_digest: sealed.plan().candidate_digest.clone(),
            layers: vec![crate::LayerResult {
                layer: "correctness".to_string(),
                passed: true,
                notes: Vec::new(),
            }],
            cases: vec![crate::CaseResult {
                case_id: "regression".to_string(),
                passed: true,
                observation: "ok".to_string(),
            }],
            triggered_rejection_conditions: Vec::new(),
            safety_invariants_held: true,
            claimed_improvement_met: true,
        };
        crate::ManualPromotion::authorize(&evidence, &sealed, digest(parent), digest(parent))
            .unwrap()
    }

    #[test]
    fn within_envelope_matches() {
        let policy = StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A5EnvelopeAutonomous,
            envelopes(&["wasm"]),
        );
        let outcome = validate_candidate_against_policy(
            &policy,
            &scope("scope.project"),
            "lineage.1",
            &envelopes(&["wasm"]),
            &digest("v2"),
            &digest("v1"),
        );
        assert_eq!(outcome, PolicyMatch::WithinEnvelope);
    }

    #[test]
    fn widened_envelope_requires_review() {
        let policy = StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A5EnvelopeAutonomous,
            envelopes(&["wasm"]),
        );
        let outcome = validate_candidate_against_policy(
            &policy,
            &scope("scope.project"),
            "lineage.1",
            &envelopes(&["wasm", "web-worker"]),
            &digest("v2"),
            &digest("v1"),
        );
        assert_eq!(outcome, PolicyMatch::RequiresTrustedReview);
    }

    #[test]
    fn identical_digest_is_rejected() {
        let policy = StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A3Draft,
            envelopes(&["wasm"]),
        );
        let outcome = validate_candidate_against_policy(
            &policy,
            &scope("scope.project"),
            "lineage.1",
            &envelopes(&["wasm"]),
            &digest("v1"),
            &digest("v1"),
        );
        assert_eq!(outcome, PolicyMatch::Rejected);
    }

    #[test]
    fn revoked_policy_rejects() {
        let mut policy = StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A5EnvelopeAutonomous,
            envelopes(&["wasm"]),
        );
        policy.revoked = true;
        let outcome = validate_candidate_against_policy(
            &policy,
            &scope("scope.project"),
            "lineage.1",
            &envelopes(&["wasm"]),
            &digest("v2"),
            &digest("v1"),
        );
        assert_eq!(outcome, PolicyMatch::Rejected);
    }

    #[test]
    fn autonomy_cannot_raise_through_builder() {
        let policy = StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A3Draft,
            envelopes(&["wasm"]),
        );
        // A builder cannot raise A3 → A5.
        assert!(!policy.autonomy_can_transition_to(AutonomyLevel::A5EnvelopeAutonomous));
        // It can narrow or keep the level.
        assert!(policy.autonomy_can_transition_to(AutonomyLevel::A2Distill));
        assert!(policy.autonomy_can_transition_to(AutonomyLevel::A3Draft));
    }

    #[test]
    fn lineage_publish_uses_expected_old_cas() {
        let mut lineage = PluginLineage::new(
            "lineage.1",
            scope("scope.project"),
            plugin("org.example.a"),
            Some(digest("v1")),
        );

        // Correct expected-old publishes.
        let v2 = promotion("v1", "v2");
        assert!(lineage.try_publish(&digest("v1"), &v2));
        assert_eq!(lineage.accepted_digest, Some(digest("v2")));
        assert_eq!(lineage.rollback_digest, Some(digest("v1")));

        // Stale expected-old is rejected.
        let v3 = promotion("v1", "v3");
        assert!(!lineage.try_publish(&digest("v1"), &v3));
        assert_eq!(lineage.accepted_digest, Some(digest("v2")));
    }

    #[test]
    fn policy_match_rejects_foreign_project_or_lineage() {
        let policy = StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project.a"),
            "lineage.a",
            AutonomyLevel::A5EnvelopeAutonomous,
            envelopes(&["wasm"]),
        );
        assert_eq!(
            validate_candidate_against_policy(
                &policy,
                &scope("scope.project.b"),
                "lineage.a",
                &envelopes(&["wasm"]),
                &digest("v2"),
                &digest("v1")
            ),
            PolicyMatch::Rejected
        );
        assert_eq!(
            validate_candidate_against_policy(
                &policy,
                &scope("scope.project.a"),
                "lineage.b",
                &envelopes(&["wasm"]),
                &digest("v2"),
                &digest("v1")
            ),
            PolicyMatch::Rejected
        );
    }

    #[test]
    fn only_plugin_defect_is_repair_eligible() {
        assert!(FailureClass::PluginDefect.is_autonomous_repair_eligible());
        assert!(!FailureClass::SecurityViolation.is_autonomous_repair_eligible());
        assert!(!FailureClass::InputPreconditionMismatch.is_autonomous_repair_eligible());
        assert!(!FailureClass::Unknown.is_autonomous_repair_eligible());
    }
}
