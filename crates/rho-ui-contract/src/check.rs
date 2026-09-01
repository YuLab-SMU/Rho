//! Immutable Check project snapshots and typed rule results.
//!
//! The shapes in this module carry no filesystem or rule-execution authority.
//! They bind references to one captured project revision and preserve the exact
//! application/plugin origin that produced each bounded finding.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    CheckResultId, CheckRuleId, CheckSnapshotId, ContractError, ProjectId, SurfaceOriginV1,
    Validate, encoded_json_len, validate_label, validate_opaque_text, validate_purpose,
};

pub const CHECK_PROJECT_SNAPSHOT_CONTRACT: &str = "rho.ui.check-project.snapshot.v1";
pub const CHECK_RESULT_CONTRACT: &str = "rho.ui.check-result.v1";
pub const CHECK_RULE_PACK_OUTPUT_CONTRACT: &str = "rho.ui.check-rule-pack.output.v1";
pub const MAX_CHECK_SNAPSHOT_FILES: usize = 2_000;
pub const MAX_CHECK_SNAPSHOT_BYTES: usize = 512 * 1024;
pub const MAX_CHECK_RESULT_FINDINGS: usize = 1_000;
pub const MAX_CHECK_RESULT_REFERENCES: usize = 4_000;
pub const MAX_CHECK_RESULT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_CHECK_RULE_PACK_FINDINGS: usize = 128;
pub const MAX_CHECK_RULE_PACK_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckSnapshotFileV1 {
    pub path: String,
    #[specta(type = crate::UiIpcNumber)]
    pub size_bytes: u64,
    pub content_sha256: String,
    pub skipped: bool,
    pub skip_reason: Option<String>,
}

impl Validate for CheckSnapshotFileV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.path, "check_snapshot.files.path")?;
        if self.path.starts_with('/')
            || self.path.contains('\\')
            || self.path.is_empty()
            || self
                .path
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err(ContractError::InvalidValue {
                path: "check_snapshot.files.path".to_string(),
                reason: "snapshot paths must be normalized project-relative paths".to_string(),
            });
        }
        validate_sha256(&self.content_sha256, "check_snapshot.files.content_sha256")?;
        if self.skipped != self.skip_reason.is_some() {
            return Err(ContractError::InvalidValue {
                path: "check_snapshot.files.skip_reason".to_string(),
                reason: "only skipped files carry one bounded reason".to_string(),
            });
        }
        if let Some(reason) = &self.skip_reason {
            validate_label(reason, "check_snapshot.files.skip_reason")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckProjectSnapshotV1 {
    pub contract: String,
    pub snapshot_id: CheckSnapshotId,
    pub project_id: ProjectId,
    #[specta(type = crate::UiIpcNumber)]
    pub project_revision: u64,
    pub captured_at: String,
    pub files: Vec<CheckSnapshotFileV1>,
    #[specta(type = crate::UiIpcNumber)]
    pub source_bytes: u64,
    pub renv_lock_sha256: Option<String>,
    pub truncated: bool,
    pub limitations: Vec<String>,
}

impl Validate for CheckProjectSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != CHECK_PROJECT_SNAPSHOT_CONTRACT || self.project_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "check_snapshot.contract".to_string(),
                reason: "snapshot contract and project revision must be current".to_string(),
            });
        }
        validate_opaque_text(&self.captured_at, "check_snapshot.captured_at")?;
        if self.files.len() > MAX_CHECK_SNAPSHOT_FILES {
            return Err(ContractError::LimitExceeded {
                path: "check_snapshot.files".to_string(),
                limit: MAX_CHECK_SNAPSHOT_FILES,
                actual: self.files.len(),
            });
        }
        let mut paths = BTreeSet::new();
        let mut source_bytes = 0u64;
        for file in &self.files {
            file.validate()?;
            if !paths.insert(file.path.as_str()) {
                return Err(ContractError::Duplicate {
                    path: "check_snapshot.files.path".to_string(),
                    value: file.path.clone(),
                });
            }
            source_bytes = source_bytes.saturating_add(file.size_bytes);
        }
        if source_bytes != self.source_bytes {
            return Err(ContractError::InvalidValue {
                path: "check_snapshot.source_bytes".to_string(),
                reason: "source byte count must equal the immutable file descriptors".to_string(),
            });
        }
        if let Some(digest) = &self.renv_lock_sha256 {
            validate_sha256(digest, "check_snapshot.renv_lock_sha256")?;
        }
        for limitation in &self.limitations {
            validate_purpose(limitation, "check_snapshot.limitations")?;
        }
        let encoded = encoded_json_len("check_snapshot", self)?;
        if encoded > MAX_CHECK_SNAPSHOT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "check_snapshot".to_string(),
                limit: MAX_CHECK_SNAPSHOT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CheckSeverityV1 {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FindingReferenceV1 {
    SourceRange {
        path: String,
        #[specta(type = crate::UiIpcNumber)]
        line: u32,
        #[specta(type = Option<crate::UiIpcNumber>)]
        column: Option<u32>,
        excerpt: Option<String>,
    },
    ProjectFile {
        path: String,
    },
    RunRef {
        run_id: String,
    },
    EnvironmentRef {
        snapshot_id: String,
    },
    Note {
        text: String,
    },
}

impl Validate for FindingReferenceV1 {
    fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::SourceRange {
                path,
                line,
                column,
                excerpt,
            } => {
                validate_opaque_text(path, "finding_reference.path")?;
                if *line == 0 || *column == Some(0) {
                    return Err(ContractError::InvalidValue {
                        path: "finding_reference.range".to_string(),
                        reason: "source references use positive one-based locations".to_string(),
                    });
                }
                if let Some(excerpt) = excerpt {
                    validate_purpose(excerpt, "finding_reference.excerpt")?;
                }
            }
            Self::ProjectFile { path } => validate_opaque_text(path, "finding_reference.path")?,
            Self::RunRef { run_id } => validate_opaque_text(run_id, "finding_reference.run_id")?,
            Self::EnvironmentRef { snapshot_id } => {
                validate_opaque_text(snapshot_id, "finding_reference.snapshot_id")?
            }
            Self::Note { text } => validate_purpose(text, "finding_reference.note")?,
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckFindingV1 {
    pub rule_id: CheckRuleId,
    #[specta(type = crate::UiIpcNumber)]
    pub rule_version: u32,
    pub origin: SurfaceOriginV1,
    #[specta(type = crate::UiIpcNumber)]
    pub activation_generation: u64,
    pub severity: CheckSeverityV1,
    pub category: String,
    pub title: String,
    pub summary: String,
    pub remediation: String,
    pub references: Vec<FindingReferenceV1>,
    pub limitations: Vec<String>,
}

impl Validate for CheckFindingV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.rule_version == 0 || self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "check_finding.generation".to_string(),
                reason: "rule version and activation generation must be positive".to_string(),
            });
        }
        self.origin.validate()?;
        validate_label(&self.category, "check_finding.category")?;
        validate_label(&self.title, "check_finding.title")?;
        validate_purpose(&self.summary, "check_finding.summary")?;
        validate_purpose(&self.remediation, "check_finding.remediation")?;
        for reference in &self.references {
            reference.validate()?;
        }
        for limitation in &self.limitations {
            validate_purpose(limitation, "check_finding.limitations")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CheckResultStatusV1 {
    Clean,
    Findings,
    Incomplete,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckCoverageV1 {
    #[specta(type = crate::UiIpcNumber)]
    pub files_scanned: usize,
    #[specta(type = crate::UiIpcNumber)]
    pub files_skipped: usize,
    #[specta(type = crate::UiIpcNumber)]
    pub core_rules: usize,
    #[specta(type = crate::UiIpcNumber)]
    pub plugin_rule_packs: usize,
    #[specta(type = crate::UiIpcNumber)]
    pub plugin_rule_failures: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckResultV1 {
    pub contract: String,
    pub result_id: CheckResultId,
    pub project_id: ProjectId,
    #[specta(type = crate::UiIpcNumber)]
    pub project_revision: u64,
    pub snapshot: CheckProjectSnapshotV1,
    pub ruleset_digest: String,
    pub generated_at: String,
    pub status: CheckResultStatusV1,
    pub findings: Vec<CheckFindingV1>,
    pub coverage: CheckCoverageV1,
    pub truncated: bool,
    pub limitations: Vec<String>,
}

impl Validate for CheckResultV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != CHECK_RESULT_CONTRACT
            || self.project_revision == 0
            || self.project_id != self.snapshot.project_id
            || self.project_revision != self.snapshot.project_revision
        {
            return Err(ContractError::InvalidValue {
                path: "check_result.identity".to_string(),
                reason: "result must match one exact immutable project snapshot".to_string(),
            });
        }
        self.snapshot.validate()?;
        validate_sha256(&self.ruleset_digest, "check_result.ruleset_digest")?;
        validate_opaque_text(&self.generated_at, "check_result.generated_at")?;
        if self.findings.len() > MAX_CHECK_RESULT_FINDINGS {
            return Err(ContractError::LimitExceeded {
                path: "check_result.findings".to_string(),
                limit: MAX_CHECK_RESULT_FINDINGS,
                actual: self.findings.len(),
            });
        }
        let mut reference_count = 0usize;
        for finding in &self.findings {
            finding.validate()?;
            reference_count = reference_count.saturating_add(finding.references.len());
        }
        if reference_count > MAX_CHECK_RESULT_REFERENCES {
            return Err(ContractError::LimitExceeded {
                path: "check_result.references".to_string(),
                limit: MAX_CHECK_RESULT_REFERENCES,
                actual: reference_count,
            });
        }
        if matches!(self.status, CheckResultStatusV1::Clean) && !self.findings.is_empty() {
            return Err(ContractError::InvalidValue {
                path: "check_result.status".to_string(),
                reason: "a clean result cannot contain findings".to_string(),
            });
        }
        if matches!(self.status, CheckResultStatusV1::Findings) && self.findings.is_empty() {
            return Err(ContractError::InvalidValue {
                path: "check_result.status".to_string(),
                reason: "findings status requires at least one typed finding".to_string(),
            });
        }
        for limitation in &self.limitations {
            validate_purpose(limitation, "check_result.limitations")?;
        }
        let encoded = encoded_json_len("check_result", self)?;
        if encoded > MAX_CHECK_RESULT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "check_result".to_string(),
                limit: MAX_CHECK_RESULT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PluginCheckFindingV1 {
    pub rule_id: CheckRuleId,
    #[specta(type = crate::UiIpcNumber)]
    pub rule_version: u32,
    pub severity: CheckSeverityV1,
    pub category: String,
    pub title: String,
    pub summary: String,
    pub remediation: String,
    pub references: Vec<FindingReferenceV1>,
    pub limitations: Vec<String>,
}

impl PluginCheckFindingV1 {
    pub fn bind_origin(
        self,
        origin: SurfaceOriginV1,
        activation_generation: u64,
    ) -> CheckFindingV1 {
        CheckFindingV1 {
            rule_id: self.rule_id,
            rule_version: self.rule_version,
            origin,
            activation_generation,
            severity: self.severity,
            category: self.category,
            title: self.title,
            summary: self.summary,
            remediation: self.remediation,
            references: self.references,
            limitations: self.limitations,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckRulePackOutputV1 {
    pub contract: String,
    pub findings: Vec<PluginCheckFindingV1>,
    pub limitations: Vec<String>,
}

impl CheckRulePackOutputV1 {
    pub fn parse(value: serde_json::Value) -> Result<Self, ContractError> {
        let output: Self =
            serde_json::from_value(value).map_err(|_| ContractError::InvalidValue {
                path: "check_rule_pack".to_string(),
                reason: "rule pack output is malformed".to_string(),
            })?;
        output.validate()?;
        Ok(output)
    }
}

impl Validate for CheckRulePackOutputV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != CHECK_RULE_PACK_OUTPUT_CONTRACT {
            return Err(ContractError::InvalidValue {
                path: "check_rule_pack.contract".to_string(),
                reason: "unknown Check rule-pack contract".to_string(),
            });
        }
        if self.findings.len() > MAX_CHECK_RULE_PACK_FINDINGS {
            return Err(ContractError::LimitExceeded {
                path: "check_rule_pack.findings".to_string(),
                limit: MAX_CHECK_RULE_PACK_FINDINGS,
                actual: self.findings.len(),
            });
        }
        for finding in &self.findings {
            if finding.rule_version == 0 {
                return Err(ContractError::InvalidValue {
                    path: "check_rule_pack.rule_version".to_string(),
                    reason: "rule version must be positive".to_string(),
                });
            }
            let bound = finding.clone().bind_origin(
                SurfaceOriginV1::Application {
                    component_id: crate::ApplicationComponentId::new("rho.check.validation")?,
                },
                1,
            );
            bound.validate()?;
        }
        for limitation in &self.limitations {
            validate_purpose(limitation, "check_rule_pack.limitations")?;
        }
        let encoded = encoded_json_len("check_rule_pack", self)?;
        if encoded > MAX_CHECK_RULE_PACK_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "check_rule_pack".to_string(),
                limit: MAX_CHECK_RULE_PACK_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

fn validate_sha256(value: &str, path: &str) -> Result<(), ContractError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ContractError::InvalidValue {
            path: path.to_string(),
            reason: "expected a 64-character SHA-256 digest".to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(project: &str) -> CheckProjectSnapshotV1 {
        CheckProjectSnapshotV1 {
            contract: CHECK_PROJECT_SNAPSHOT_CONTRACT.to_string(),
            snapshot_id: CheckSnapshotId::new("check-snapshot:a").unwrap(),
            project_id: ProjectId::new(project).unwrap(),
            project_revision: 3,
            captured_at: "2026-08-22T00:00:00Z".to_string(),
            files: vec![CheckSnapshotFileV1 {
                path: "analysis.R".to_string(),
                size_bytes: 8,
                content_sha256: "a".repeat(64),
                skipped: false,
                skip_reason: None,
            }],
            source_bytes: 8,
            renv_lock_sha256: None,
            truncated: false,
            limitations: Vec::new(),
        }
    }

    #[test]
    fn immutable_snapshot_and_typed_result_validate() {
        let snapshot = snapshot("project:a");
        snapshot.validate().unwrap();
        let result = CheckResultV1 {
            contract: CHECK_RESULT_CONTRACT.to_string(),
            result_id: CheckResultId::new("check-result:a").unwrap(),
            project_id: snapshot.project_id.clone(),
            project_revision: snapshot.project_revision,
            snapshot,
            ruleset_digest: "b".repeat(64),
            generated_at: "2026-08-22T00:00:01Z".to_string(),
            status: CheckResultStatusV1::Clean,
            findings: Vec::new(),
            coverage: CheckCoverageV1 {
                files_scanned: 1,
                files_skipped: 0,
                core_rules: 21,
                plugin_rule_packs: 0,
                plugin_rule_failures: 0,
            },
            truncated: false,
            limitations: Vec::new(),
        };
        result.validate().unwrap();
    }

    #[test]
    fn rejects_cross_project_duplicate_paths_and_false_clean_claims() {
        let mut duplicate = snapshot("project:a");
        duplicate.files.push(duplicate.files[0].clone());
        assert!(duplicate.validate().is_err());

        let snapshot = snapshot("project:a");
        let finding = CheckFindingV1 {
            rule_id: CheckRuleId::new("rho.repro.v1.portability.setwd.literal").unwrap(),
            rule_version: 1,
            origin: SurfaceOriginV1::Application {
                component_id: crate::ApplicationComponentId::new("rho.check.core").unwrap(),
            },
            activation_generation: 1,
            severity: CheckSeverityV1::Warning,
            category: "portability".to_string(),
            title: "Working directory is fixed".to_string(),
            summary: "setwd() fixes execution to one directory.".to_string(),
            remediation: "Use project-relative paths.".to_string(),
            references: vec![FindingReferenceV1::ProjectFile {
                path: "analysis.R".to_string(),
            }],
            limitations: Vec::new(),
        };
        let result = CheckResultV1 {
            contract: CHECK_RESULT_CONTRACT.to_string(),
            result_id: CheckResultId::new("check-result:a").unwrap(),
            project_id: ProjectId::new("project:b").unwrap(),
            project_revision: 3,
            snapshot,
            ruleset_digest: "b".repeat(64),
            generated_at: "2026-08-22T00:00:01Z".to_string(),
            status: CheckResultStatusV1::Clean,
            findings: vec![finding],
            coverage: CheckCoverageV1 {
                files_scanned: 1,
                files_skipped: 0,
                core_rules: 21,
                plugin_rule_packs: 0,
                plugin_rule_failures: 0,
            },
            truncated: false,
            limitations: Vec::new(),
        };
        assert!(result.validate().is_err());
    }
}
