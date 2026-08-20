//! Phase 2.5 lineage repair loop, standing-policy autonomous evolution, and
//! capability gardener (P2.5-4 through P2.5-6) — pure contracts.
//!
//! These three work packages extend the lineage/vocabulary established in
//! P2.5-0 with the *decision rules* that govern repair, autonomous activation,
//! and gardening. Like the earlier packages, this module is pure: it performs
//! no I/O, no execution, and replays no production side effect. The point is to
//! encode the exact invariants as testable predicates.

use serde::{Deserialize, Serialize};

use crate::digest::PackageDigest;
use crate::{
    AutonomyLevel, FailureClass, PluginLineage, PolicyMatch, ScopeId, StandingPolicy, VersionState,
};

/// A minimized, redacted failure fixture proposal derived from a classified
/// failure. It is a candidate-authored regression request, not a protected-set
/// admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegressionProposal {
    pub proposal_id: String,
    pub project_id: ScopeId,
    pub failure_class: FailureClass,
    pub case_id: String,
    pub minimized_observation: String,
}

/// A child candidate created from the exact accepted digest for a repair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairCandidate {
    pub candidate_id: String,
    pub lineage_id: String,
    pub parent_digest: PackageDigest,
    pub candidate_digest: PackageDigest,
}

/// P2.5-4 pure rule: only a `PluginDefect` failure may enter automated repair.
/// Everything else (input misuse, environment drift, host defect, policy
/// denial, security violation, unknown) is routed to its owning recovery
/// contract, never to the repair loop.
pub fn repair_eligibility(failure: FailureClass) -> bool {
    failure.is_autonomous_repair_eligible()
}

/// P2.5-4: a child candidate must be derived from the exact accepted digest.
/// If the parent does not match the lineage's accepted pointer, the repair is
/// stale and rejected (the lineage may have advanced concurrently).
pub fn repair_parent_must_match(lineage: &PluginLineage, candidate: &RepairCandidate) -> bool {
    lineage.lineage_id == candidate.lineage_id
        && lineage.accepted_digest.as_ref() == Some(&candidate.parent_digest)
        && candidate.candidate_digest != candidate.parent_digest
}

/// P2.5-5 pure rule: autonomous (`A5`) activation is permitted only when (a)
/// the policy is an exact envelope match (not a widening), and (b) the policy
/// autonomy is at least `A5`. A widening always requires trusted review.
pub fn autonomous_activation_allowed(
    policy: &StandingPolicy,
    lineage: &PluginLineage,
    candidate_envelopes: &crate::EvolutionEnvelopes,
    candidate_digest: &PackageDigest,
    parent_digest: &PackageDigest,
    evaluation_decision: crate::EvaluationDecision,
) -> bool {
    if !policy.is_active() {
        return false;
    }
    if policy.autonomy < AutonomyLevel::A5EnvelopeAutonomous {
        return false;
    }
    if evaluation_decision != crate::EvaluationDecision::Accept
        || policy.project_id != lineage.project_id
        || policy.lineage_id != lineage.lineage_id
        || lineage.accepted_digest.as_ref() != Some(parent_digest)
    {
        return false;
    }
    matches!(
        crate::validate_candidate_against_policy(
            policy,
            &lineage.project_id,
            &lineage.lineage_id,
            candidate_envelopes,
            candidate_digest,
            parent_digest
        ),
        PolicyMatch::WithinEnvelope
    )
}

/// A capability-gardener proposal. Similarity is heuristic and creates **no**
/// authority; merging, generalizing, deprecating, archiving, or retiring can
/// only be a proposal, never an automatic action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GardenerProposal {
    pub proposal_id: String,
    pub project_id: ScopeId,
    pub action: crate::GardenAction,
    /// Explicit parent lineages for a merge candidate.
    pub parent_lineage_ids: Vec<String>,
    /// The heuristic evidence (bounded overlap/usage/failure/cost/correction).
    pub evidence: Vec<String>,
}

/// P2.5-6 pure rule: a merge that would widen permissions is rejected. The
/// union of two narrower envelopes must be reviewed for least privilege; it is
/// never silently accepted.
pub fn merge_must_not_widen_permissions(
    merged: &crate::EvolutionEnvelopes,
    parents: &[&crate::EvolutionEnvelopes],
) -> bool {
    !parents.is_empty()
        && merged.permission_classes.iter().all(|class| {
            parents
                .iter()
                .all(|parent| parent.permission_classes.contains(class))
        })
}

/// A bounded improvement entry surfaced even when no prompt is required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImprovementEntry {
    pub lineage_id: String,
    pub candidate_digest: PackageDigest,
    pub summary: String,
    pub permissions_unchanged: bool,
    pub rollback_available: bool,
}

/// P2.5-4/5/6 pure helper: the version state must never regress an accepted
/// pointer without an explicit rollback target.
pub fn accepted_digest_is_preserved(
    lineage: &PluginLineage,
    previous_accepted: &PackageDigest,
    version_state: VersionState,
) -> bool {
    lineage.accepted_digest.as_ref() == Some(previous_accepted)
        || (version_state == VersionState::Accepted
            && lineage.rollback_digest.as_ref() == Some(previous_accepted))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(id: &str) -> ScopeId {
        ScopeId::new(id).unwrap()
    }

    fn plugin(id: &str) -> crate::PluginId {
        crate::PluginId::new(id).unwrap()
    }

    fn digest(seed: &str) -> PackageDigest {
        PackageDigest::from_inventory(&[(seed.as_bytes(), seed.as_bytes())])
    }

    fn lineage() -> PluginLineage {
        PluginLineage::new(
            "lineage.1",
            scope("scope.project"),
            plugin("org.example.a"),
            Some(digest("v1")),
        )
    }

    #[test]
    fn only_plugin_defect_repairs() {
        assert!(repair_eligibility(FailureClass::PluginDefect));
        assert!(!repair_eligibility(FailureClass::SecurityViolation));
        assert!(!repair_eligibility(FailureClass::InputPreconditionMismatch));
    }

    #[test]
    fn repair_parent_must_match_accepted_digest() {
        let lineage = lineage();
        let good = RepairCandidate {
            candidate_id: "c1".to_string(),
            lineage_id: "lineage.1".to_string(),
            parent_digest: digest("v1"),
            candidate_digest: digest("v2"),
        };
        let stale = RepairCandidate {
            candidate_id: "c2".to_string(),
            lineage_id: "lineage.1".to_string(),
            parent_digest: digest("v0"),
            candidate_digest: digest("v2"),
        };
        assert!(repair_parent_must_match(&lineage, &good));
        assert!(!repair_parent_must_match(&lineage, &stale));
    }

    #[test]
    fn autonomous_activation_requires_a5_and_within_envelope() {
        let envelopes = |kinds: &[&str]| crate::EvolutionEnvelopes {
            runtime_kinds: kinds.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        let policy_a5 = StandingPolicy::new(
            "policy.1",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A5EnvelopeAutonomous,
            envelopes(&["wasm"]),
        );
        let lineage = lineage();
        assert!(autonomous_activation_allowed(
            &policy_a5,
            &lineage,
            &envelopes(&["wasm"]),
            &digest("v2"),
            &digest("v1"),
            crate::EvaluationDecision::Accept,
        ));
        // Widening rejects.
        assert!(!autonomous_activation_allowed(
            &policy_a5,
            &lineage,
            &envelopes(&["wasm", "web-worker"]),
            &digest("v2"),
            &digest("v1"),
            crate::EvaluationDecision::Accept,
        ));

        let policy_a3 = StandingPolicy::new(
            "policy.2",
            1,
            scope("scope.project"),
            "lineage.1",
            AutonomyLevel::A3Draft,
            envelopes(&["wasm"]),
        );
        assert!(!autonomous_activation_allowed(
            &policy_a3,
            &lineage,
            &envelopes(&["wasm"]),
            &digest("v2"),
            &digest("v1"),
            crate::EvaluationDecision::Accept,
        ));
        assert!(!autonomous_activation_allowed(
            &policy_a5,
            &lineage,
            &envelopes(&["wasm"]),
            &digest("v2"),
            &digest("v1"),
            crate::EvaluationDecision::Inconclusive,
        ));
    }

    #[test]
    fn merge_cannot_introduce_new_permissions() {
        let a = crate::EvolutionEnvelopes {
            permission_classes: vec!["project.fs.read".to_string()],
            ..Default::default()
        };
        let b = crate::EvolutionEnvelopes {
            permission_classes: vec!["network.fetch".to_string()],
            ..Default::default()
        };
        let union = crate::EvolutionEnvelopes {
            permission_classes: vec!["project.fs.read".to_string(), "network.fetch".to_string()],
            ..Default::default()
        };
        let merged_bad = crate::EvolutionEnvelopes {
            permission_classes: vec!["process.spawn".to_string()],
            ..Default::default()
        };
        assert!(!merge_must_not_widen_permissions(&union, &[&a, &b]));
        assert!(!merge_must_not_widen_permissions(&merged_bad, &[&a, &b]));

        let parent_one = crate::EvolutionEnvelopes {
            permission_classes: vec!["project.fs.read".to_string()],
            ..Default::default()
        };
        let parent_two = crate::EvolutionEnvelopes {
            permission_classes: vec!["project.fs.read".to_string(), "network.fetch".to_string()],
            ..Default::default()
        };
        let common_only = crate::EvolutionEnvelopes {
            permission_classes: vec!["project.fs.read".to_string()],
            ..Default::default()
        };
        assert!(merge_must_not_widen_permissions(
            &common_only,
            &[&parent_one, &parent_two]
        ));
    }
}
