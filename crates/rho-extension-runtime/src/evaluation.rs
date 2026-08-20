//! Phase 2.5 protected evaluation and manual promotion (P2.5-3).
//!
//! Evaluation is broker-orchestrated and runs before any production grant or
//! route becomes active. A sealed evaluation plan binds the baseline and
//! candidate digests, the protected fixture-set digest, mandatory cases,
//! budgets, and the minimum-improvement rule *before* the candidate result is
//! known. This module models that machinery as pure, deterministic types and
//! predicates — it performs no execution and replays no production side effect.
//!
//! The non-negotiables:
//!
//! - candidate-authored tests can never replace protected tests;
//! - a candidate that deletes a regression, changes expected output, narrows
//!   the tested domain, or makes a failing case unreachable is tampering;
//! - no aggregate score can hide a mandatory-regression failure;
//! - mandatory regressions and safety invariants are hard gates.

use serde::{Deserialize, Serialize};

use crate::digest::PackageDigest;
use crate::{PluginId, ScopeId};

/// A sealed evaluation plan: fixed before the candidate result is known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvaluationPlan {
    pub plan_id: String,
    pub project_id: ScopeId,
    pub lineage_id: String,
    pub plugin_id: PluginId,
    pub baseline_digest: PackageDigest,
    pub candidate_digest: PackageDigest,
    /// Digest of the protected fixture set (sealed, independently of the
    /// candidate's authored tests).
    pub protected_fixture_set_digest: PackageDigest,
    /// Mandatory contract/regression case identifiers.
    pub mandatory_cases: Vec<String>,
    /// Required independently reported evaluation layers.
    pub required_layers: Vec<String>,
    /// The predeclared minimum-improvement rule (optional).
    pub minimum_improvement_rule: Option<String>,
    /// Absolute rejection conditions (mandatory).
    pub rejection_conditions: Vec<String>,
}

/// Broker-sealed plan retained independently from candidate-produced evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SealedEvaluationPlan {
    plan: EvaluationPlan,
    seal_digest: PackageDigest,
}

impl EvaluationPlan {
    pub fn seal(self) -> Result<SealedEvaluationPlan, EvaluationError> {
        if self.plan_id.is_empty()
            || self.baseline_digest == self.candidate_digest
            || self.mandatory_cases.is_empty()
            || self.required_layers.is_empty()
            || self.rejection_conditions.is_empty()
            || has_duplicates(&self.mandatory_cases)
            || has_duplicates(&self.required_layers)
            || has_duplicates(&self.rejection_conditions)
        {
            return Err(EvaluationError::UnsealedPlan);
        }
        let encoded = serde_json::to_vec(&self).map_err(|_| EvaluationError::UnsealedPlan)?;
        let seal_digest =
            PackageDigest::from_inventory(&[(b"rho-evaluation-plan-v1", encoded.as_slice())]);
        Ok(SealedEvaluationPlan {
            plan: self,
            seal_digest,
        })
    }
}

impl SealedEvaluationPlan {
    pub fn plan(&self) -> &EvaluationPlan {
        &self.plan
    }

    pub fn seal_digest(&self) -> &PackageDigest {
        &self.seal_digest
    }
}

/// The per-layer result. Layers are reported separately; no aggregate score is
/// ever computed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerResult {
    pub layer: String,
    pub passed: bool,
    pub notes: Vec<String>,
}

/// A single mandatory case result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaseResult {
    pub case_id: String,
    pub passed: bool,
    pub observation: String,
}

/// Evaluation evidence: the complete, versioned outcome for one candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvaluationEvidence {
    pub evidence_id: String,
    pub plan_id: String,
    pub plan_seal_digest: PackageDigest,
    pub candidate_digest: PackageDigest,
    pub layers: Vec<LayerResult>,
    pub cases: Vec<CaseResult>,
    pub triggered_rejection_conditions: Vec<String>,
    pub safety_invariants_held: bool,
    pub claimed_improvement_met: bool,
}

/// The decision a sealed evaluation produces. Safety and mandatory regressions
/// are hard gates; no aggregate score can flip them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationDecision {
    Accept,
    Reject,
    Inconclusive,
}

/// Error kind for evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationError {
    /// The candidate removed or changed a mandatory case (tampering).
    TamperedFixture,
    /// The candidate failed a mandatory case.
    MandatoryRegressionFailed,
    /// A safety invariant did not hold.
    SafetyInvariantViolated,
    /// The plan was not sealed before the result (missing fixture digest).
    UnsealedPlan,
    /// Evidence does not bind to the independently retained sealed plan.
    PlanMismatch,
    /// A required evaluation layer is absent, duplicated, or failed.
    LayerFailed,
    /// A predeclared absolute rejection condition occurred.
    RejectionConditionTriggered,
    /// Candidate evidence contains duplicate or otherwise ambiguous results.
    DuplicateEvidence,
    /// Promotion was requested without an accepted sealed evaluation.
    PromotionNotAccepted,
}

impl EvaluationEvidence {
    /// Produce the decision strictly from hard gates. A failed mandatory case,
    /// a violated safety invariant, or a tampered fixture is rejection; missing
    /// determinism is inconclusive; otherwise pass.
    pub fn decide(
        &self,
        sealed_plan: &SealedEvaluationPlan,
    ) -> Result<EvaluationDecision, EvaluationError> {
        let plan = sealed_plan.plan();
        if self.plan_id != plan.plan_id
            || self.plan_seal_digest != *sealed_plan.seal_digest()
            || self.candidate_digest != plan.candidate_digest
        {
            return Err(EvaluationError::PlanMismatch);
        }
        if has_duplicates_by(&self.cases, |result| result.case_id.as_str())
            || has_duplicates_by(&self.layers, |result| result.layer.as_str())
            || has_duplicates(&self.triggered_rejection_conditions)
        {
            return Err(EvaluationError::DuplicateEvidence);
        }

        // Every mandatory case must be present and passed. A missing case is
        // indistinguishable from evaluation tampering.
        for case_id in &plan.mandatory_cases {
            let Some(result) = self.cases.iter().find(|c| &c.case_id == case_id) else {
                return Err(EvaluationError::TamperedFixture);
            };
            if !result.passed {
                return Err(EvaluationError::MandatoryRegressionFailed);
            }
        }

        for layer_id in &plan.required_layers {
            let Some(result) = self.layers.iter().find(|layer| &layer.layer == layer_id) else {
                return Err(EvaluationError::TamperedFixture);
            };
            if !result.passed {
                return Err(EvaluationError::LayerFailed);
            }
        }
        if self.layers.iter().any(|layer| !layer.passed) {
            return Err(EvaluationError::LayerFailed);
        }

        for condition in &self.triggered_rejection_conditions {
            if !plan.rejection_conditions.contains(condition) {
                return Err(EvaluationError::TamperedFixture);
            }
        }
        if !self.triggered_rejection_conditions.is_empty() {
            return Err(EvaluationError::RejectionConditionTriggered);
        }

        if !self.safety_invariants_held {
            return Err(EvaluationError::SafetyInvariantViolated);
        }

        // If the candidate claimed improvement, the rule must be met. Missing
        // evidence for a claimed improvement is inconclusive, not pass.
        if plan.minimum_improvement_rule.is_some() && !self.claimed_improvement_met {
            return Ok(EvaluationDecision::Inconclusive);
        }

        Ok(EvaluationDecision::Accept)
    }
}

/// Manual promotion is the only path P2.5-3 authorizes. It uses the Phase 2
/// candidate/grant lifecycle and an explicit rollback target, and it is human
/// (or trusted-policy) initiated — never candidate-authored. This pure wrapper
/// records that decision without executing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ManualPromotion {
    candidate_digest: PackageDigest,
    parent_digest: PackageDigest,
    rollback_digest: PackageDigest,
    evidence_id: String,
    plan_seal_digest: PackageDigest,
    project_id: ScopeId,
    lineage_id: String,
    plugin_id: PluginId,
}

impl ManualPromotion {
    pub fn authorize(
        evidence: &EvaluationEvidence,
        sealed_plan: &SealedEvaluationPlan,
        parent_digest: PackageDigest,
        rollback_digest: PackageDigest,
    ) -> Result<Self, EvaluationError> {
        if evidence.decide(sealed_plan)? != EvaluationDecision::Accept
            || parent_digest != sealed_plan.plan.baseline_digest
            || rollback_digest != sealed_plan.plan.baseline_digest
        {
            return Err(EvaluationError::PromotionNotAccepted);
        }
        Ok(Self {
            candidate_digest: sealed_plan.plan.candidate_digest.clone(),
            parent_digest,
            rollback_digest,
            evidence_id: evidence.evidence_id.clone(),
            plan_seal_digest: sealed_plan.seal_digest.clone(),
            project_id: sealed_plan.plan.project_id.clone(),
            lineage_id: sealed_plan.plan.lineage_id.clone(),
            plugin_id: sealed_plan.plan.plugin_id.clone(),
        })
    }

    pub fn candidate_digest(&self) -> &PackageDigest {
        &self.candidate_digest
    }

    pub fn parent_digest(&self) -> &PackageDigest {
        &self.parent_digest
    }

    pub fn rollback_digest(&self) -> &PackageDigest {
        &self.rollback_digest
    }

    pub fn evidence_id(&self) -> &str {
        &self.evidence_id
    }

    pub fn plan_seal_digest(&self) -> &PackageDigest {
        &self.plan_seal_digest
    }

    pub fn project_id(&self) -> &ScopeId {
        &self.project_id
    }

    pub fn lineage_id(&self) -> &str {
        &self.lineage_id
    }

    pub fn plugin_id(&self) -> &PluginId {
        &self.plugin_id
    }
}

fn has_duplicates(values: &[String]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    values.iter().any(|value| !seen.insert(value.as_str()))
}

fn has_duplicates_by<'a, T>(values: &'a [T], key: impl Fn(&'a T) -> &'a str) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    values.iter().any(|value| !seen.insert(key(value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(id: &str) -> ScopeId {
        ScopeId::new(id).unwrap()
    }

    fn digest(seed: &str) -> PackageDigest {
        PackageDigest::from_inventory(&[(seed.as_bytes(), seed.as_bytes())])
    }

    fn plugin(id: &str) -> PluginId {
        PluginId::new(id).unwrap()
    }

    fn plan() -> EvaluationPlan {
        EvaluationPlan {
            plan_id: "plan.1".to_string(),
            project_id: scope("scope.project"),
            lineage_id: "lineage.1".to_string(),
            plugin_id: plugin("org.example.a"),
            baseline_digest: digest("v1"),
            candidate_digest: digest("v2"),
            protected_fixture_set_digest: digest("fixtures"),
            mandatory_cases: vec!["regression-1".to_string()],
            required_layers: vec!["correctness".to_string(), "resource".to_string()],
            minimum_improvement_rule: None,
            rejection_conditions: vec!["crash".to_string()],
        }
    }

    fn passing_cases() -> Vec<CaseResult> {
        vec![CaseResult {
            case_id: "regression-1".to_string(),
            passed: true,
            observation: "ok".to_string(),
        }]
    }

    fn evidence(
        sealed_plan: &SealedEvaluationPlan,
        cases: Vec<CaseResult>,
        safety: bool,
    ) -> EvaluationEvidence {
        EvaluationEvidence {
            evidence_id: "ev.1".to_string(),
            plan_id: sealed_plan.plan().plan_id.clone(),
            plan_seal_digest: sealed_plan.seal_digest().clone(),
            candidate_digest: sealed_plan.plan().candidate_digest.clone(),
            layers: vec![
                LayerResult {
                    layer: "correctness".to_string(),
                    passed: true,
                    notes: Vec::new(),
                },
                LayerResult {
                    layer: "resource".to_string(),
                    passed: true,
                    notes: Vec::new(),
                },
            ],
            cases,
            triggered_rejection_conditions: Vec::new(),
            safety_invariants_held: safety,
            claimed_improvement_met: true,
        }
    }

    #[test]
    fn all_hard_gates_pass_accepts() {
        let sealed = plan().seal().unwrap();
        let e = evidence(&sealed, passing_cases(), true);
        assert_eq!(e.decide(&sealed).unwrap(), EvaluationDecision::Accept);
    }

    #[test]
    fn failed_mandatory_case_rejects() {
        let mut cases = passing_cases();
        cases[0].passed = false;
        let sealed = plan().seal().unwrap();
        let e = evidence(&sealed, cases, true);
        assert_eq!(
            e.decide(&sealed),
            Err(EvaluationError::MandatoryRegressionFailed)
        );
    }

    #[test]
    fn missing_mandatory_case_is_tampering() {
        let sealed = plan().seal().unwrap();
        let e = evidence(&sealed, Vec::new(), true);
        assert_eq!(e.decide(&sealed), Err(EvaluationError::TamperedFixture));
    }

    #[test]
    fn safety_violation_rejects() {
        let sealed = plan().seal().unwrap();
        let e = evidence(&sealed, passing_cases(), false);
        assert_eq!(
            e.decide(&sealed),
            Err(EvaluationError::SafetyInvariantViolated)
        );
    }

    #[test]
    fn unsealed_plan_is_an_error() {
        let mut p = plan();
        p.mandatory_cases.clear();
        assert_eq!(p.seal(), Err(EvaluationError::UnsealedPlan));
    }

    #[test]
    fn failed_layer_and_rejection_condition_are_hard_failures() {
        let sealed = plan().seal().unwrap();
        let mut failed_layer = evidence(&sealed, passing_cases(), true);
        failed_layer.layers[0].passed = false;
        assert_eq!(
            failed_layer.decide(&sealed),
            Err(EvaluationError::LayerFailed)
        );

        let mut rejected = evidence(&sealed, passing_cases(), true);
        rejected.triggered_rejection_conditions = vec!["crash".to_string()];
        assert_eq!(
            rejected.decide(&sealed),
            Err(EvaluationError::RejectionConditionTriggered)
        );
    }

    #[test]
    fn evidence_must_match_the_external_sealed_plan() {
        let sealed = plan().seal().unwrap();
        let mut tampered_plan = plan();
        tampered_plan.candidate_digest = digest("v3");
        let tampered_seal = tampered_plan.seal().unwrap();
        let evidence = evidence(&tampered_seal, passing_cases(), true);
        assert_eq!(evidence.decide(&sealed), Err(EvaluationError::PlanMismatch));
    }

    #[test]
    fn manual_promotion_requires_accepted_sealed_evidence() {
        let sealed = plan().seal().unwrap();
        let evidence = evidence(&sealed, passing_cases(), true);
        let promotion =
            ManualPromotion::authorize(&evidence, &sealed, digest("v1"), digest("v1")).unwrap();
        assert_eq!(promotion.candidate_digest(), &digest("v2"));

        let mut failed = evidence;
        failed.layers[0].passed = false;
        assert_eq!(
            ManualPromotion::authorize(&failed, &sealed, digest("v1"), digest("v1")),
            Err(EvaluationError::LayerFailed)
        );
    }
}
