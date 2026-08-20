//! Phase 2.5 observation, recipe, and skill suggestions (P2.5-1).
//!
//! P2.5-1 models the *opt-in* distillation path — experience trace references,
//! repeated-pattern observations, previewable Recipes, and declarative Skills —
//! as pure data types and pure validation. It performs **no** observation,
//! **no** Agent/Provider call, **no** build, and **no** plugin-host activation.
//!
//! The governing privacy rules are enforced here, structurally:
//!
//! - observation is disabled by default (opt-in project flag);
//! - records are project-scoped and never cross a project boundary;
//! - raw prompts, source, data frames, R objects, credentials, and logs are
//!   excluded by the redaction profile by construction;
//! - exclusion and expiry are first-class and never rewrite execution truth;
//! - pattern similarity is heuristic and never becomes authority.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ScopeId;
use crate::digest::PackageDigest;

pub const MAX_TRACE_REFERENCES: usize = 64;
pub const MAX_PATTERN_FEATURES: usize = 64;
pub const MAX_RECIPE_STEPS: usize = 64;
pub const MAX_OBSERVATION_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_SKILL_INSTRUCTION_BYTES: usize = 64 * 1024;

/// How a task's outcome is labeled, without copying its payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeClass {
    Success,
    Failure,
    Corrected,
    Unknown,
}

/// A redaction profile: which content classes are permitted in a trace. Raw
/// prompts, full source, data frames, R objects, credentials, environment
/// values, and unbounded logs are always excluded and cannot be re-enabled.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactionProfile {
    /// Whether bounded derived *structure* (steps, schemas) may be retained.
    pub retain_structure: bool,
    /// Whether outcome labels may be retained.
    pub retain_outcome_labels: bool,
    /// Always-false guards that document the forbidden classes. Enforced by the
    /// validator below, never by user input.
    #[serde(default)]
    pub allow_raw_prompts: bool,
    #[serde(default)]
    pub allow_raw_credentials: bool,
    #[serde(default)]
    pub allow_full_source: bool,
}

impl RedactionProfile {
    /// A redaction profile is valid only if every forbidden class remains
    /// forbidden. This is structural, not policy: a caller cannot flip these.
    pub fn is_valid(&self) -> bool {
        !self.allow_raw_prompts && !self.allow_raw_credentials && !self.allow_full_source
    }
}

/// A bounded, project-scoped reference to existing task/run/artifact evidence.
/// It links evidence; it never duplicates its payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExperienceTraceRef {
    pub trace_ref_id: String,
    pub project_id: ScopeId,
    pub source_task_id: Option<String>,
    pub source_run_id: Option<String>,
    pub artifact_ids: Vec<String>,
    /// Normalized, non-sensitive structural features used for similarity.
    pub normalized_pattern_features: Vec<String>,
    pub outcome_class: OutcomeClass,
    pub redaction_profile: RedactionProfile,
    /// Whether this trace is excluded from future distillation.
    pub excluded: bool,
    /// Epoch millis after which derived payloads expire (audit facts remain).
    pub expires_at_millis: Option<u64>,
}

impl ExperienceTraceRef {
    pub fn is_valid(&self) -> bool {
        self.redaction_profile.is_valid()
            && self.artifact_ids.len() <= MAX_TRACE_REFERENCES
            && self.normalized_pattern_features.len() <= MAX_PATTERN_FEATURES
            && self
                .normalized_pattern_features
                .iter()
                .all(|feature| feature.len() <= MAX_OBSERVATION_TEXT_BYTES)
    }

    /// Whether the trace is still eligible for distillation at `now_millis`.
    pub fn is_eligible(&self, now_millis: u64) -> bool {
        !self.excluded
            && self
                .expires_at_millis
                .map(|expiry| now_millis < expiry)
                .unwrap_or(true)
    }
}

/// A repeated-pattern observation: a heuristic grouping of similar trace
/// references. It is a suggestion, never authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatternObservation {
    pub pattern_id: String,
    pub project_id: ScopeId,
    pub trace_ref_ids: Vec<String>,
    /// Human-explainable description of why these traces group together.
    pub explanation: String,
}

/// A typed reusable workflow: purpose, inputs, preconditions, ordered steps,
/// outputs, failure behavior, and provenance. It has no new authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recipe {
    pub recipe_id: String,
    pub project_id: ScopeId,
    pub purpose: String,
    pub input_schema: String,
    pub preconditions: Vec<String>,
    pub ordered_steps: Vec<String>,
    pub output_schema: String,
    /// Links to the traces/patterns that produced this recipe.
    pub provenance_refs: Vec<String>,
    pub revision: u64,
}

impl Recipe {
    /// A recipe must state purpose, inputs, preconditions, ordered steps,
    /// outputs, and provenance; otherwise it is not a distinct workflow.
    pub fn is_valid(&self) -> bool {
        !self.purpose.is_empty()
            && !self.input_schema.is_empty()
            && !self.ordered_steps.is_empty()
            && !self.output_schema.is_empty()
            && !self.provenance_refs.is_empty()
            && self.preconditions.len() <= MAX_RECIPE_STEPS
            && self.ordered_steps.len() <= MAX_RECIPE_STEPS
            && [
                self.purpose.as_str(),
                self.input_schema.as_str(),
                self.output_schema.as_str(),
            ]
            .into_iter()
            .all(|value| value.len() <= MAX_OBSERVATION_TEXT_BYTES)
    }
}

/// A bounded declarative Skill suggestion. It never has executable authority
/// and cannot override system/developer/user/broker policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillSuggestion {
    pub skill_id: String,
    pub project_id: ScopeId,
    pub recipe_id: String,
    /// Bounded declarative instruction text, labeled by origin.
    pub instructions: String,
}

/// An opt-in observation model per project. Denied by default.
#[derive(Debug, Clone, Default)]
pub struct ObservationModel {
    /// Per project: whether observation is enabled and which traces exist.
    traces:
        std::collections::BTreeMap<ScopeId, std::collections::BTreeMap<String, ExperienceTraceRef>>,
    patterns: Vec<PatternObservation>,
    recipes: Vec<Recipe>,
    skills: Vec<SkillSuggestion>,
    /// Whether observation is enabled per project.
    enabled: BTreeSet<ScopeId>,
}

/// Error kind for observation-model operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationError {
    /// Observation is disabled for this project.
    Disabled,
    /// The trace belongs to another project (cross-project leak).
    CrossProject,
    /// The trace is excluded, expired, or its redaction profile is invalid.
    Ineligible,
    /// The trace is already known.
    Duplicate,
}

impl ObservationModel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enable observation for a project (explicit user decision).
    pub fn enable(&mut self, project_id: ScopeId) {
        self.enabled.insert(project_id);
    }

    pub fn is_enabled(&self, project_id: &ScopeId) -> bool {
        self.enabled.contains(project_id)
    }

    /// Add a trace. Fails when observation is disabled, the trace is
    /// cross-project, or the redaction profile/eligibility is violated at
    /// `now_millis`.
    pub fn add_trace(
        &mut self,
        trace: ExperienceTraceRef,
        now_millis: u64,
    ) -> Result<(), ObservationError> {
        if !self.enabled.contains(&trace.project_id) {
            return Err(ObservationError::Disabled);
        }
        if !trace.is_valid() {
            return Err(ObservationError::Ineligible);
        }
        if !trace.is_eligible(now_millis) {
            return Err(ObservationError::Ineligible);
        }
        let project_id = trace.project_id.clone();
        let traces = self.traces.entry(project_id).or_default();
        if traces.contains_key(&trace.trace_ref_id) {
            return Err(ObservationError::Duplicate);
        }
        traces.insert(trace.trace_ref_id.clone(), trace);
        Ok(())
    }

    /// Record a pattern observation over traces already present in the same
    /// project. Cross-project grouping is rejected.
    pub fn add_pattern(
        &mut self,
        pattern: PatternObservation,
        now_millis: u64,
    ) -> Result<(), ObservationError> {
        if !self.enabled.contains(&pattern.project_id) {
            return Err(ObservationError::Disabled);
        }
        if pattern.trace_ref_ids.is_empty()
            || pattern.trace_ref_ids.len() > MAX_TRACE_REFERENCES
            || pattern.explanation.is_empty()
            || pattern.explanation.len() > MAX_OBSERVATION_TEXT_BYTES
        {
            return Err(ObservationError::Ineligible);
        }
        let Some(project_traces) = self.traces.get(&pattern.project_id) else {
            return Err(ObservationError::Ineligible);
        };
        for trace_id in &pattern.trace_ref_ids {
            match project_traces.get(trace_id) {
                Some(trace) if trace.is_valid() && trace.is_eligible(now_millis) => {}
                Some(_) => return Err(ObservationError::Ineligible),
                None => {
                    let exists_elsewhere = self.traces.iter().any(|(project, traces)| {
                        project != &pattern.project_id && traces.contains_key(trace_id)
                    });
                    return Err(if exists_elsewhere {
                        ObservationError::CrossProject
                    } else {
                        ObservationError::Ineligible
                    });
                }
            }
        }
        if self.patterns.iter().any(|existing| {
            existing.project_id == pattern.project_id && existing.pattern_id == pattern.pattern_id
        }) {
            return Err(ObservationError::Duplicate);
        }
        self.patterns.push(pattern);
        Ok(())
    }

    /// Add a recipe. A recipe needs provenance; it carries no new authority.
    pub fn add_recipe(&mut self, recipe: Recipe, now_millis: u64) -> Result<(), ObservationError> {
        if !self.enabled.contains(&recipe.project_id) {
            return Err(ObservationError::Disabled);
        }
        if !recipe.is_valid() {
            return Err(ObservationError::Ineligible);
        }
        let provenance_owned =
            self.provenance_is_eligible(&recipe.project_id, &recipe.provenance_refs, now_millis);
        if !provenance_owned {
            let exists_elsewhere = recipe.provenance_refs.iter().any(|reference| {
                self.traces.iter().any(|(project, traces)| {
                    project != &recipe.project_id && traces.contains_key(reference)
                }) || self.patterns.iter().any(|pattern| {
                    pattern.project_id != recipe.project_id && pattern.pattern_id == *reference
                })
            });
            return Err(if exists_elsewhere {
                ObservationError::CrossProject
            } else {
                ObservationError::Ineligible
            });
        }
        if self.recipes.iter().any(|existing| {
            existing.project_id == recipe.project_id && existing.recipe_id == recipe.recipe_id
        }) {
            return Err(ObservationError::Duplicate);
        }
        self.recipes.push(recipe);
        Ok(())
    }

    /// Add a declarative skill suggestion over a recipe in the same project.
    pub fn add_skill(
        &mut self,
        skill: SkillSuggestion,
        now_millis: u64,
    ) -> Result<(), ObservationError> {
        if !self.enabled.contains(&skill.project_id) {
            return Err(ObservationError::Disabled);
        }
        let recipe = self.recipes.iter().find(|recipe| {
            recipe.recipe_id == skill.recipe_id && recipe.project_id == skill.project_id
        });
        let Some(recipe) = recipe else {
            return Err(ObservationError::Ineligible);
        };
        if !self.provenance_is_eligible(&recipe.project_id, &recipe.provenance_refs, now_millis) {
            return Err(ObservationError::Ineligible);
        }
        if skill.instructions.is_empty() || skill.instructions.len() > MAX_SKILL_INSTRUCTION_BYTES {
            return Err(ObservationError::Ineligible);
        }
        if self.skills.iter().any(|existing| {
            existing.project_id == skill.project_id && existing.skill_id == skill.skill_id
        }) {
            return Err(ObservationError::Duplicate);
        }
        self.skills.push(skill);
        Ok(())
    }

    /// Exclude a trace from future distillation. This does not rewrite past
    /// execution truth; it only prevents future use.
    pub fn exclude_trace(
        &mut self,
        project_id: &ScopeId,
        trace_id: &str,
    ) -> Result<(), ObservationError> {
        let trace_exists_elsewhere = self
            .traces
            .iter()
            .any(|(project, traces)| project != project_id && traces.contains_key(trace_id));
        let Some(trace) = self
            .traces
            .get_mut(project_id)
            .and_then(|traces| traces.get_mut(trace_id))
        else {
            return Err(if trace_exists_elsewhere {
                ObservationError::CrossProject
            } else {
                ObservationError::Ineligible
            });
        };
        trace.excluded = true;
        Ok(())
    }

    fn provenance_is_eligible(
        &self,
        project_id: &ScopeId,
        provenance_refs: &[String],
        now_millis: u64,
    ) -> bool {
        provenance_refs.iter().all(|reference| {
            self.traces
                .get(project_id)
                .and_then(|traces| traces.get(reference))
                .is_some_and(|trace| trace.is_valid() && trace.is_eligible(now_millis))
                || self.patterns.iter().any(|pattern| {
                    &pattern.project_id == project_id
                        && pattern.pattern_id == *reference
                        && self.traces.get(project_id).is_some_and(|traces| {
                            pattern.trace_ref_ids.iter().all(|trace_id| {
                                traces.get(trace_id).is_some_and(|trace| {
                                    trace.is_valid() && trace.is_eligible(now_millis)
                                })
                            })
                        })
                })
        })
    }
}

/// Threat fixture: a candidate that tries to self-authorize by declaring a
/// broader envelope is always rejected before the policy is even considered.
/// This is enforced by `validate_candidate_against_policy` in `evolution.rs`;
/// the observation model re-exposes a pure predicate for P2.5-1 tests.
pub fn self_grant_attempt_rejected(
    candidate_envelopes: &crate::EvolutionEnvelopes,
    policy: &crate::StandingPolicy,
) -> bool {
    let outcome = crate::validate_candidate_against_policy(
        policy,
        &policy.project_id,
        &policy.lineage_id,
        candidate_envelopes,
        &PackageDigest::from_inventory(&[(b"x", b"x")]),
        &PackageDigest::from_inventory(&[(b"y", b"y")]),
    );
    matches!(
        outcome,
        crate::PolicyMatch::RequiresTrustedReview | crate::PolicyMatch::Rejected
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(id: &str) -> ScopeId {
        ScopeId::new(id).unwrap()
    }

    fn trace(project: &ScopeId, id: &str) -> ExperienceTraceRef {
        ExperienceTraceRef {
            trace_ref_id: id.to_string(),
            project_id: project.clone(),
            source_task_id: None,
            source_run_id: None,
            artifact_ids: Vec::new(),
            normalized_pattern_features: vec!["subset".to_string()],
            outcome_class: OutcomeClass::Success,
            redaction_profile: RedactionProfile {
                retain_structure: true,
                retain_outcome_labels: true,
                ..Default::default()
            },
            excluded: false,
            expires_at_millis: None,
        }
    }

    #[test]
    fn observation_disabled_by_default() {
        let mut model = ObservationModel::new();
        let project = scope("scope.project");
        let err = model.add_trace(trace(&project, "t1"), 0).unwrap_err();
        assert_eq!(err, ObservationError::Disabled);
    }

    #[test]
    fn enabled_then_trace_is_project_scoped() {
        let mut model = ObservationModel::new();
        let a = scope("scope.project.a");
        let b = scope("scope.project.b");
        model.enable(a.clone());
        model.add_trace(trace(&a, "t1"), 0).unwrap();

        // Trace belongs to A; adding the same id under B is a distinct record.
        model.enable(b.clone());
        model.add_trace(trace(&b, "t1"), 0).unwrap();
        assert!(model.is_enabled(&a));
        assert!(model.is_enabled(&b));
    }

    #[test]
    fn invalid_redaction_profile_is_ineligible() {
        let mut model = ObservationModel::new();
        let project = scope("scope.project");
        model.enable(project.clone());
        let mut bad = trace(&project, "t1");
        bad.redaction_profile.allow_raw_prompts = true;
        let err = model.add_trace(bad, 0).unwrap_err();
        assert_eq!(err, ObservationError::Ineligible);
    }

    #[test]
    fn excluded_or_expired_trace_is_ineligible() {
        let mut model = ObservationModel::new();
        let project = scope("scope.project");
        model.enable(project.clone());

        let mut expired = trace(&project, "expired");
        expired.expires_at_millis = Some(100);
        assert_eq!(
            model.add_trace(expired, 1000),
            Err(ObservationError::Ineligible)
        );

        let mut excluded = trace(&project, "excluded");
        excluded.excluded = true;
        assert_eq!(
            model.add_trace(excluded, 0),
            Err(ObservationError::Ineligible)
        );
    }

    #[test]
    fn pattern_cannot_group_across_projects() {
        let mut model = ObservationModel::new();
        let a = scope("scope.project.a");
        let b = scope("scope.project.b");
        model.enable(a.clone());
        model.enable(b.clone());
        model.add_trace(trace(&a, "t1"), 0).unwrap();
        model.add_trace(trace(&b, "t2"), 0).unwrap();

        let pattern = PatternObservation {
            pattern_id: "p1".to_string(),
            project_id: a.clone(),
            trace_ref_ids: vec!["t1".to_string(), "t2".to_string()],
            explanation: "cross-project grouping".to_string(),
        };
        let err = model.add_pattern(pattern, 0).unwrap_err();
        assert_eq!(err, ObservationError::CrossProject);
    }

    #[test]
    fn excluding_a_trace_prevents_future_distillation() {
        let mut model = ObservationModel::new();
        let project = scope("scope.project");
        model.enable(project.clone());
        model.add_trace(trace(&project, "t1"), 0).unwrap();
        model.exclude_trace(&project, "t1").unwrap();

        let pattern = PatternObservation {
            pattern_id: "p1".to_string(),
            project_id: project,
            trace_ref_ids: vec!["t1".to_string()],
            explanation: "repeat".to_string(),
        };
        assert_eq!(
            model.add_pattern(pattern, 0),
            Err(ObservationError::Ineligible)
        );
    }

    #[test]
    fn recipe_requires_provenance() {
        let mut model = ObservationModel::new();
        let project = scope("scope.project");
        model.enable(project.clone());
        let recipe = Recipe {
            recipe_id: "r1".to_string(),
            project_id: project,
            purpose: "Enrichment".to_string(),
            input_schema: "csv".to_string(),
            preconditions: vec![],
            ordered_steps: vec!["read".to_string()],
            output_schema: "table".to_string(),
            provenance_refs: vec![],
            revision: 1,
        };
        // Missing provenance makes it invalid.
        assert_eq!(
            model.add_recipe(recipe, 0),
            Err(ObservationError::Ineligible)
        );
    }

    #[test]
    fn recipe_provenance_must_exist_in_the_same_project() {
        let mut model = ObservationModel::new();
        let a = scope("scope.project.a");
        let b = scope("scope.project.b");
        model.enable(a.clone());
        model.enable(b.clone());
        model.add_trace(trace(&b, "t-b"), 0).unwrap();

        let recipe = Recipe {
            recipe_id: "r1".to_string(),
            project_id: a,
            purpose: "Enrichment".to_string(),
            input_schema: "csv".to_string(),
            preconditions: vec![],
            ordered_steps: vec!["read".to_string()],
            output_schema: "table".to_string(),
            provenance_refs: vec!["t-b".to_string()],
            revision: 1,
        };
        assert_eq!(
            model.add_recipe(recipe, 0),
            Err(ObservationError::CrossProject)
        );
    }

    #[test]
    fn excluded_trace_cannot_be_used_as_recipe_provenance() {
        let mut model = ObservationModel::new();
        let project = scope("scope.project");
        model.enable(project.clone());
        model.add_trace(trace(&project, "t1"), 0).unwrap();
        model.exclude_trace(&project, "t1").unwrap();
        let recipe = Recipe {
            recipe_id: "r1".to_string(),
            project_id: project,
            purpose: "Enrichment".to_string(),
            input_schema: "csv".to_string(),
            preconditions: vec![],
            ordered_steps: vec!["read".to_string()],
            output_schema: "table".to_string(),
            provenance_refs: vec!["t1".to_string()],
            revision: 1,
        };
        assert_eq!(
            model.add_recipe(recipe, 0),
            Err(ObservationError::Ineligible)
        );
    }

    #[test]
    fn exclusion_also_blocks_later_skill_distillation() {
        let mut model = ObservationModel::new();
        let project = scope("scope.project");
        model.enable(project.clone());
        model.add_trace(trace(&project, "t1"), 0).unwrap();
        model
            .add_recipe(
                Recipe {
                    recipe_id: "r1".to_string(),
                    project_id: project.clone(),
                    purpose: "Enrichment".to_string(),
                    input_schema: "csv".to_string(),
                    preconditions: vec![],
                    ordered_steps: vec!["read".to_string()],
                    output_schema: "table".to_string(),
                    provenance_refs: vec!["t1".to_string()],
                    revision: 1,
                },
                0,
            )
            .unwrap();
        model.exclude_trace(&project, "t1").unwrap();

        let skill = SkillSuggestion {
            skill_id: "skill.1".to_string(),
            project_id: project,
            recipe_id: "r1".to_string(),
            instructions: "Use the bounded recipe".to_string(),
        };
        assert_eq!(model.add_skill(skill, 0), Err(ObservationError::Ineligible));
    }
}
