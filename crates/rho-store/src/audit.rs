use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::Store;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuditScope {
    Project,
    CurrentProject,
    Run(String),
    Artifact(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuditSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct AuditEvidence {
    pub kind: String,
    pub path: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub excerpt: Option<String>,
    pub run_id: Option<String>,
    pub snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct AuditFinding {
    pub rule_id: String,
    pub rule_version: u32,
    pub severity: AuditSeverity,
    pub category: String,
    pub summary: String,
    pub evidence: Vec<AuditEvidence>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuditLimits {
    pub max_source_files: usize,
    pub max_file_bytes: usize,
    pub max_aggregate_bytes: usize,
    pub max_findings: usize,
    pub max_runs: usize,
    pub max_artifacts: usize,
    pub max_response_bytes: usize,
}

impl Default for AuditLimits {
    fn default() -> Self {
        Self {
            max_source_files: 2000,
            max_file_bytes: 8 * 1024 * 1024,
            max_aggregate_bytes: 16 * 1024 * 1024,
            max_findings: 1000,
            max_runs: 200,
            max_artifacts: 500,
            max_response_bytes: 2 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuditStatus {
    Complete,
    Findings,
    Incomplete,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuditResponse {
    pub schema_version: u32,
    pub rule_profile: String,
    pub rule_profile_version: u32,
    pub project_root: String,
    pub scope: String,
    pub generated_at: String,
    pub reference_snapshot_id: Option<String>,
    pub status: AuditStatus,
    pub findings: Vec<AuditFinding>,
    pub summary: AuditSummary,
    pub coverage: AuditCoverage,
    pub truncated: bool,
    pub truncation_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuditSummary {
    pub total_findings: usize,
    pub info: usize,
    pub warning: usize,
    pub error: usize,
    pub by_category: HashMap<String, usize>,
    pub files_scanned: usize,
    pub runs_checked: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AuditCoverage {
    pub files_scanned: usize,
    pub files_skipped: usize,
    pub skipped_reasons: Vec<String>,
    pub runs_considered: usize,
    pub artifacts_considered: usize,
    pub snapshot_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct SourceFile {
    pub path: String,
    pub content: String,
    pub skipped: bool,
    pub skip_reason: Option<String>,
}

/// Process-local immutable input for the current-project rule set. The Check
/// runtime projects only digest/size descriptors to UI and plugin rule packs;
/// raw source bytes remain in this value until core rule execution completes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CurrentProjectAuditSnapshot {
    pub project_root: String,
    pub captured_at: String,
    pub source_files: Vec<SourceFile>,
    pub renv_lock_present: bool,
    pub renv_lock_content: Option<String>,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RULE_PROFILE: &str = "rho.repro.v1";
const RULE_PROFILE_VERSION: u32 = 1;
const SCHEMA_VERSION: u32 = 1;

const BINARY_EXTENSIONS: &[&str] = &[
    "rds", "png", "jpg", "jpeg", "pdf", "xlsx", "RData", "rda", "feather", "parquet", "h5", "hdf5",
];

const RNG_FUNCTIONS: &[&str] = &[
    "rnorm(",
    "runif(",
    "rpois(",
    "rbinom(",
    "rexp(",
    "rgamma(",
    "rbeta(",
    "rt(",
    "rf(",
    "rchisq(",
    "rwilcox(",
    "rsignrank(",
    "rmultinom(",
    "rgeom(",
    "rhyper(",
    "rlnorm(",
    "rnbinom(",
    "rweibull(",
    "rcauchy(",
    "rlogis(",
    "sample(",
];

/// Known source-code extensions we are willing to scan for R patterns.
const SOURCE_EXTENSIONS: &[&str] = &["R", "r", "Rmd", "rmd", "qmd", "Qmd", "Rnw", "rnw"];

// ---------------------------------------------------------------------------
// Source-file scanning
// ---------------------------------------------------------------------------

/// Walk `project_root`, skip hidden dirs and binary extensions, and return
/// every readable text file that looks like source code.
pub fn scan_source_files(project_root: &str, limits: &AuditLimits) -> Vec<SourceFile> {
    let mut files = Vec::new();
    let mut aggregate_bytes: usize = 0;
    let mut paths = Vec::new();

    collect_source_paths(Path::new(project_root), &mut paths);
    paths.sort();

    for path in &paths {
        if files.len() >= limits.max_source_files {
            break;
        }

        let relative = path.strip_prefix(project_root).unwrap_or(path);
        let rel_str = relative.to_string_lossy().replace('\\', "/");

        match fs::read_to_string(path) {
            Ok(content) => {
                if content.len() > limits.max_file_bytes {
                    files.push(SourceFile {
                        path: rel_str,
                        content: String::new(),
                        skipped: true,
                        skip_reason: Some("file_too_large".to_string()),
                    });
                    continue;
                }

                let new_aggregate = aggregate_bytes.saturating_add(content.len());
                if new_aggregate > limits.max_aggregate_bytes {
                    files.push(SourceFile {
                        path: rel_str,
                        content: String::new(),
                        skipped: true,
                        skip_reason: Some("aggregate_limit".to_string()),
                    });
                    continue;
                }
                aggregate_bytes = new_aggregate;

                files.push(SourceFile {
                    path: rel_str,
                    content,
                    skipped: false,
                    skip_reason: None,
                });
            }
            Err(_) => {
                files.push(SourceFile {
                    path: rel_str,
                    content: String::new(),
                    skipped: true,
                    skip_reason: Some("read_error".to_string()),
                });
            }
        }
    }

    files
}

pub fn capture_current_project_audit_snapshot(
    project_root: &str,
    limits: &AuditLimits,
) -> CurrentProjectAuditSnapshot {
    let lock_path = Path::new(project_root).join("renv.lock");
    let renv_lock_present = lock_path.is_file();
    let renv_lock_content = fs::read_to_string(&lock_path)
        .ok()
        .filter(|content| content.len() <= limits.max_file_bytes);
    CurrentProjectAuditSnapshot {
        project_root: project_root.to_string(),
        captured_at: Utc::now().to_rfc3339(),
        source_files: scan_source_files(project_root, limits),
        renv_lock_present,
        renv_lock_content,
    }
}

fn collect_source_paths(dir: &Path, paths: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        // Skip hidden files and directories
        if file_name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            // Skip common large/vendor directories
            if file_name == "renv"
                || file_name == "node_modules"
                || file_name == ".git"
                || file_name == "packrat"
                || file_name == "__pycache__"
            {
                continue;
            }
            collect_source_paths(&path, paths);
        } else if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let ext_lower = ext.to_lowercase();

            if BINARY_EXTENSIONS.contains(&ext_lower.as_str()) {
                continue;
            }

            // Only collect known R-family source files. Extensionless files
            // retain the compatibility path used for scripts such as Makefile.
            if !ext.is_empty()
                && !SOURCE_EXTENSIONS
                    .iter()
                    .any(|e| e.eq_ignore_ascii_case(ext))
            {
                continue;
            }

            paths.push(path);
        }
    }
}

// ---------------------------------------------------------------------------
// Lockfile & snapshot helpers
// ---------------------------------------------------------------------------

/// Parsed package entry from a lockfile or snapshot.
#[derive(Debug, Clone)]
struct PkgInfo {
    name: String,
    version: String,
}

/// Read `renv.lock` from `project_root/renv.lock` and return the `Packages` map.
fn parse_lockfile_packages(project_root: &str) -> Option<Vec<PkgInfo>> {
    let lock_path = Path::new(project_root).join("renv.lock");
    let content = fs::read_to_string(lock_path).ok()?;
    parse_lockfile_packages_content(&content)
}

fn parse_lockfile_packages_content(content: &str) -> Option<Vec<PkgInfo>> {
    let json: serde_json::Value = serde_json::from_str(content).ok()?;
    let packages = json.get("Packages")?.as_object()?;
    let mut result = Vec::with_capacity(packages.len());
    for (name, pkg) in packages {
        let version = pkg
            .get("Version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        result.push(PkgInfo {
            name: name.clone(),
            version,
        });
    }
    Some(result)
}

/// Parse `canonical_json` of an environment snapshot to extract the
/// `installed_packages` array (each entry has `Package` and `Version`).
fn parse_snapshot_packages(canonical_json: &str) -> Option<Vec<PkgInfo>> {
    let json: serde_json::Value = serde_json::from_str(canonical_json).ok()?;
    let installed = json.get("installed_packages")?.as_array()?;
    let mut result = Vec::with_capacity(installed.len());
    for pkg in installed {
        let name = pkg.get("Package")?.as_str()?.to_string();
        let version = pkg
            .get("Version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        result.push(PkgInfo { name, version });
    }
    Some(result)
}

/// Check whether a snapshot's canonical_json indicates completeness.
fn snapshot_completeness(canonical_json: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(canonical_json).ok()?;
    json.get("completeness")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Check whether `renv_lock_drift` field exists in the snapshot.
fn snapshot_has_lockfile_drift(canonical_json: &str) -> bool {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(canonical_json) {
        json.get("renv_lock_drift").is_some()
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// Package name extraction from source lines
// ---------------------------------------------------------------------------

/// Extract package names referenced in a line of R code.
///
/// Detects `library(pkg)`, `require(pkg)`, and `pkg::symbol` forms.
fn extract_packages_from_line(line: &str) -> Vec<String> {
    let mut packages = Vec::new();

    // library(x) / library("x") / library('x')
    for start in line.match_indices("library(") {
        let rest = &line[start.0 + "library(".len()..];
        if let Some(name) = extract_first_arg(rest) {
            packages.push(name);
        }
    }

    // require(x) / require("x") / require('x')
    for start in line.match_indices("require(") {
        let rest = &line[start.0 + "require(".len()..];
        if let Some(name) = extract_first_arg(rest) {
            packages.push(name);
        }
    }

    // pkg::symbol  (extract the identifier before ::)
    for start in line.match_indices("::") {
        let before = &line[..start.0];
        if let Some(name) = extract_identifier_before_colons(before) {
            packages.push(name);
        }
    }

    packages
}

/// Given text after `library(` or `require(`, extract the first argument name.
fn extract_first_arg(rest: &str) -> Option<String> {
    let rest = rest.trim_start();
    let first_char = rest.chars().next()?;

    if first_char == '"' || first_char == '\'' {
        // Quoted: find matching closing quote
        let quote = first_char;
        let end = rest[1..].find(quote)?;
        Some(rest[1..1 + end].to_string())
    } else {
        // Bare identifier
        let end = rest.find(|c: char| !c.is_alphanumeric() && c != '.' && c != '_')?;
        let name = &rest[..end];
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        }
    }
}

/// Extract the identifier immediately before `::`, walking backwards.
fn extract_identifier_before_colons(before: &str) -> Option<String> {
    let trimmed = before.trim_end();
    if trimmed.is_empty() {
        return None;
    }

    let chars: Vec<char> = trimmed.chars().collect();
    let last = *chars.last()?;
    if matches!(last, '`' | '"' | '\'') {
        let opening = chars[..chars.len() - 1]
            .iter()
            .rposition(|candidate| *candidate == last)?;
        let name: String = chars[opening + 1..chars.len() - 1].iter().collect();
        return (!name.is_empty()).then_some(name);
    }

    let start = chars
        .iter()
        .rposition(|c| !(c.is_alphanumeric() || *c == '.' || *c == '_'))
        .map_or(0, |index| index + 1);
    let name: String = chars[start..].iter().collect();
    (!name.is_empty()).then_some(name)
}

// ---------------------------------------------------------------------------
// Audit implementation
// ---------------------------------------------------------------------------

impl<C> Store<C>
where
    C: std::ops::Deref<Target = rusqlite::Connection> + std::ops::DerefMut,
{
    /// Run the full reproducibility audit against the store and the
    /// on-disk project.  This is a read-only operation.
    pub fn audit_reproducibility(
        &self,
        scope: AuditScope,
        project_root: &str,
        reference_snapshot_id: Option<&str>,
        limits: &AuditLimits,
    ) -> AuditResponse {
        let generated_at = Utc::now().to_rfc3339();
        let mut findings: Vec<AuditFinding> = Vec::new();
        let mut truncation_reasons: Vec<String> = Vec::new();
        let mut truncated = false;

        // --- Retrieve store data ---------------------------------------

        let runs = self
            .list_runs(project_root, Some(limits.max_runs))
            .unwrap_or_default();
        let artifacts = self
            .list_artifact_records(Some(limits.max_artifacts), project_root, None, false)
            .unwrap_or_default();

        // Resolve reference snapshot
        let reference_snapshot =
            reference_snapshot_id.and_then(|sid| self.get_environment_snapshot(sid).ok().flatten());

        // Filter by scope
        let runs: Vec<_> = match &scope {
            AuditScope::Project => runs,
            AuditScope::CurrentProject => Vec::new(),
            AuditScope::Run(target) => runs.into_iter().filter(|r| &r.run_id == target).collect(),
            AuditScope::Artifact(target) => {
                // For artifact scope, only check that artifact's run
                let related_run_id = artifacts
                    .iter()
                    .find(|a| &a.artifact_id == target)
                    .and_then(|a| a.run_id.clone());
                match related_run_id {
                    Some(rid) => runs.into_iter().filter(|r| r.run_id == rid).collect(),
                    None => Vec::new(),
                }
            }
        };

        // Filter artifacts by scope
        let artifacts: Vec<_> = match &scope {
            AuditScope::Project => artifacts,
            AuditScope::CurrentProject => Vec::new(),
            AuditScope::Run(target) => artifacts
                .into_iter()
                .filter(|a| a.run_id.as_deref() == Some(target))
                .collect(),
            AuditScope::Artifact(target) => artifacts
                .into_iter()
                .filter(|a| &a.artifact_id == target)
                .collect(),
        };

        let runs_considered = runs.len();
        let artifacts_considered = artifacts.len();

        // --- Scan source files -----------------------------------------

        let source_files = scan_source_files(project_root, limits);
        let files_scanned = source_files.iter().filter(|f| !f.skipped).count();
        let files_skipped = source_files.iter().filter(|f| f.skipped).count();
        let mut skipped_reasons: Vec<String> = source_files
            .iter()
            .filter_map(|f| f.skip_reason.clone())
            .collect();
        skipped_reasons.sort();
        skipped_reasons.dedup();

        let snapshot_available = reference_snapshot.is_some()
            || runs.iter().any(|r| r.environment_snapshot_id.is_some());

        // --- Determine reference packages -------------------------------

        let snapshot_packages = reference_snapshot
            .as_ref()
            .and_then(|snap| parse_snapshot_packages(&snap.canonical_json));

        let lockfile_packages = parse_lockfile_packages(project_root);

        // --- Run rule checks -------------------------------------------

        check_evidence(
            &runs,
            &artifacts,
            project_root,
            &reference_snapshot,
            Path::new(project_root).join("renv.lock").is_file(),
            limits,
            &mut findings,
            &mut truncation_reasons,
            &mut truncated,
        );

        check_portability(
            &source_files,
            limits,
            &mut findings,
            &mut truncation_reasons,
            &mut truncated,
        );

        check_randomness(
            &source_files,
            limits,
            &mut findings,
            &mut truncation_reasons,
            &mut truncated,
        );

        check_packages(
            &source_files,
            &snapshot_packages,
            &lockfile_packages,
            limits,
            &mut findings,
            &mut truncation_reasons,
            &mut truncated,
        );

        check_runs(
            &runs,
            &artifacts,
            limits,
            &mut findings,
            &mut truncation_reasons,
            &mut truncated,
        );

        // --- Build summary ---------------------------------------------

        let total_findings = findings.len();
        let mut info = 0usize;
        let mut warning = 0usize;
        let mut error = 0usize;
        let mut by_category: HashMap<String, usize> = HashMap::new();

        for f in &findings {
            match f.severity {
                AuditSeverity::Info => info += 1,
                AuditSeverity::Warning => warning += 1,
                AuditSeverity::Error => error += 1,
            }
            *by_category.entry(f.category.clone()).or_insert(0) += 1;
        }

        let summary = AuditSummary {
            total_findings,
            info,
            warning,
            error,
            by_category,
            files_scanned,
            runs_checked: runs_considered,
        };

        let coverage = AuditCoverage {
            files_scanned,
            files_skipped,
            skipped_reasons,
            runs_considered,
            artifacts_considered,
            snapshot_available,
        };

        // --- Determine overall status ----------------------------------
        let status = if truncation_reasons.iter().any(|r| r.starts_with("error.")) {
            AuditStatus::Error
        } else if total_findings == 0 && !truncated {
            AuditStatus::Complete
        } else if error > 0 {
            AuditStatus::Findings
        } else if truncated {
            AuditStatus::Incomplete
        } else {
            AuditStatus::Findings
        };

        let scope_str = match &scope {
            AuditScope::Project => "project".to_string(),
            AuditScope::CurrentProject => "project_current".to_string(),
            AuditScope::Run(id) => format!("run:{id}"),
            AuditScope::Artifact(id) => format!("artifact:{id}"),
        };

        // Sort findings by rule_id for deterministic output
        findings.sort_by(|a, b| a.rule_id.cmp(&b.rule_id));

        AuditResponse {
            schema_version: SCHEMA_VERSION,
            rule_profile: RULE_PROFILE.to_string(),
            rule_profile_version: RULE_PROFILE_VERSION,
            project_root: project_root.to_string(),
            scope: scope_str,
            generated_at,
            reference_snapshot_id: reference_snapshot_id.map(|s| s.to_string()),
            status,
            findings,
            summary,
            coverage,
            truncated,
            truncation_reasons,
        }
    }
}

/// Run the accepted current-project core rules against bytes captured before
/// execution. No filesystem or Store read occurs after this function starts.
pub fn audit_current_project_snapshot(
    snapshot: &CurrentProjectAuditSnapshot,
    limits: &AuditLimits,
) -> AuditResponse {
    let mut findings = Vec::new();
    let mut truncation_reasons = Vec::new();
    let mut truncated = false;
    let runs: Vec<crate::run::RunSummary> = Vec::new();
    let artifacts: Vec<crate::artifact::ArtifactRecordSummary> = Vec::new();
    let reference_snapshot = None;
    let lockfile_packages = snapshot
        .renv_lock_content
        .as_deref()
        .and_then(parse_lockfile_packages_content);

    check_evidence(
        &runs,
        &artifacts,
        &snapshot.project_root,
        &reference_snapshot,
        snapshot.renv_lock_present,
        limits,
        &mut findings,
        &mut truncation_reasons,
        &mut truncated,
    );
    check_portability(
        &snapshot.source_files,
        limits,
        &mut findings,
        &mut truncation_reasons,
        &mut truncated,
    );
    check_randomness(
        &snapshot.source_files,
        limits,
        &mut findings,
        &mut truncation_reasons,
        &mut truncated,
    );
    check_packages(
        &snapshot.source_files,
        &None,
        &lockfile_packages,
        limits,
        &mut findings,
        &mut truncation_reasons,
        &mut truncated,
    );
    check_runs(
        &runs,
        &artifacts,
        limits,
        &mut findings,
        &mut truncation_reasons,
        &mut truncated,
    );

    let mut info = 0usize;
    let mut warning = 0usize;
    let mut error = 0usize;
    let mut by_category = HashMap::new();
    for finding in &findings {
        match finding.severity {
            AuditSeverity::Info => info += 1,
            AuditSeverity::Warning => warning += 1,
            AuditSeverity::Error => error += 1,
        }
        *by_category.entry(finding.category.clone()).or_insert(0) += 1;
    }
    let files_scanned = snapshot
        .source_files
        .iter()
        .filter(|file| !file.skipped)
        .count();
    let files_skipped = snapshot.source_files.len().saturating_sub(files_scanned);
    let mut skipped_reasons = snapshot
        .source_files
        .iter()
        .filter_map(|file| file.skip_reason.clone())
        .collect::<Vec<_>>();
    skipped_reasons.sort();
    skipped_reasons.dedup();
    let status = if truncation_reasons
        .iter()
        .any(|reason| reason.starts_with("error."))
    {
        AuditStatus::Error
    } else if findings.is_empty() && !truncated {
        AuditStatus::Complete
    } else if error > 0 {
        AuditStatus::Findings
    } else if truncated {
        AuditStatus::Incomplete
    } else {
        AuditStatus::Findings
    };
    findings.sort_by(|left, right| left.rule_id.cmp(&right.rule_id));
    AuditResponse {
        schema_version: SCHEMA_VERSION,
        rule_profile: RULE_PROFILE.to_string(),
        rule_profile_version: RULE_PROFILE_VERSION,
        project_root: snapshot.project_root.clone(),
        scope: "project_current".to_string(),
        generated_at: snapshot.captured_at.clone(),
        reference_snapshot_id: None,
        status,
        summary: AuditSummary {
            total_findings: findings.len(),
            info,
            warning,
            error,
            by_category,
            files_scanned,
            runs_checked: 0,
        },
        coverage: AuditCoverage {
            files_scanned,
            files_skipped,
            skipped_reasons,
            runs_considered: 0,
            artifacts_considered: 0,
            snapshot_available: false,
        },
        findings,
        truncated,
        truncation_reasons,
    }
}

// ---------------------------------------------------------------------------
// Rule-group helpers
// ---------------------------------------------------------------------------

fn push_finding(
    findings: &mut Vec<AuditFinding>,
    limits: &AuditLimits,
    truncation_reasons: &mut Vec<String>,
    truncated: &mut bool,
    finding: AuditFinding,
) {
    if findings.len() >= limits.max_findings {
        *truncated = true;
        if !truncation_reasons.contains(&"max_findings".to_string()) {
            truncation_reasons.push("max_findings".to_string());
        }
        return;
    }
    findings.push(finding);
}

// --- 2a. Evidence Completeness --------------------------------------------

#[allow(clippy::too_many_arguments)]
fn check_evidence(
    runs: &[crate::run::RunSummary],
    artifacts: &[crate::artifact::ArtifactRecordSummary],
    project_root: &str,
    reference_snapshot: &Option<crate::environment::EnvironmentSnapshotRecord>,
    lockfile_present: bool,
    limits: &AuditLimits,
    findings: &mut Vec<AuditFinding>,
    truncation_reasons: &mut Vec<String>,
    truncated: &mut bool,
) {
    for run in runs {
        // evidence.run.env_snapshot_missing
        if run.environment_snapshot_id.is_none() {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.evidence.run.env_snapshot_missing".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Warning,
                    category: "evidence".to_string(),
                    summary: format!("Run {} has no environment snapshot recorded", run.run_id),
                    evidence: vec![AuditEvidence {
                        kind: "run_id".to_string(),
                        path: None,
                        line: None,
                        column: None,
                        excerpt: None,
                        run_id: Some(run.run_id.clone()),
                        snapshot_id: None,
                    }],
                    limitations: Vec::new(),
                },
            );
        }

        // evidence.run.source_revision_missing
        if run.source_path.is_none() || run.document_version.is_none() {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.evidence.run.source_revision_missing".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Warning,
                    category: "evidence".to_string(),
                    summary: format!(
                        "Run {} is missing source_path or document_version",
                        run.run_id
                    ),
                    evidence: vec![AuditEvidence {
                        kind: "run_id".to_string(),
                        path: None,
                        line: None,
                        column: None,
                        excerpt: None,
                        run_id: Some(run.run_id.clone()),
                        snapshot_id: None,
                    }],
                    limitations: Vec::new(),
                },
            );
        }
    }

    for artifact in artifacts {
        // evidence.artifact.producing_run_missing
        if artifact.run_id.is_none() {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.evidence.artifact.producing_run_missing".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Error,
                    category: "evidence".to_string(),
                    summary: format!(
                        "Artifact {} has no producing run recorded",
                        artifact.artifact_id
                    ),
                    evidence: vec![AuditEvidence {
                        kind: "artifact_id".to_string(),
                        path: Some(artifact.output_path.clone()),
                        line: None,
                        column: None,
                        excerpt: None,
                        run_id: artifact.run_id.clone(),
                        snapshot_id: None,
                    }],
                    limitations: Vec::new(),
                },
            );
        }

        // evidence.artifact.provenance_incomplete
        if !artifact.provenance_complete {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.evidence.artifact.provenance_incomplete".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Warning,
                    category: "evidence".to_string(),
                    summary: format!(
                        "Artifact {} has incomplete provenance",
                        artifact.artifact_id
                    ),
                    evidence: vec![AuditEvidence {
                        kind: "artifact_id".to_string(),
                        path: Some(artifact.output_path.clone()),
                        line: None,
                        column: None,
                        excerpt: None,
                        run_id: artifact.run_id.clone(),
                        snapshot_id: None,
                    }],
                    limitations: Vec::new(),
                },
            );
        }

        // evidence.artifact.file_missing
        let full_path = Path::new(project_root).join(&artifact.output_path);
        if !full_path.exists() {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.evidence.artifact.file_missing".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Error,
                    category: "evidence".to_string(),
                    summary: format!(
                        "Output file for artifact {} does not exist on disk: {}",
                        artifact.artifact_id, artifact.output_path
                    ),
                    evidence: vec![AuditEvidence {
                        kind: "file_path".to_string(),
                        path: Some(artifact.output_path.clone()),
                        line: None,
                        column: None,
                        excerpt: None,
                        run_id: artifact.run_id.clone(),
                        snapshot_id: None,
                    }],
                    limitations: Vec::new(),
                },
            );
        }
    }

    // evidence.env.snapshot_incomplete
    if let Some(snap) = reference_snapshot {
        if let Some(completeness) = snapshot_completeness(&snap.canonical_json)
            && completeness != "complete"
        {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.evidence.env.snapshot_incomplete".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Warning,
                    category: "evidence".to_string(),
                    summary: format!(
                        "Environment snapshot {} reports completeness as '{}'",
                        snap.snapshot_id, completeness
                    ),
                    evidence: vec![AuditEvidence {
                        kind: "snapshot_id".to_string(),
                        path: None,
                        line: None,
                        column: None,
                        excerpt: Some(format!("completeness: {completeness}")),
                        run_id: None,
                        snapshot_id: Some(snap.snapshot_id.clone()),
                    }],
                    limitations: Vec::new(),
                },
            );
        }

        // evidence.env.lockfile_drift
        if snapshot_has_lockfile_drift(&snap.canonical_json) {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.evidence.env.lockfile_drift".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Warning,
                    category: "evidence".to_string(),
                    summary: format!(
                        "Environment snapshot {} reports lockfile drift",
                        snap.snapshot_id
                    ),
                    evidence: vec![AuditEvidence {
                        kind: "snapshot_id".to_string(),
                        path: None,
                        line: None,
                        column: None,
                        excerpt: None,
                        run_id: None,
                        snapshot_id: Some(snap.snapshot_id.clone()),
                    }],
                    limitations: Vec::new(),
                },
            );
        }
    }

    // evidence.env.lockfile_missing
    if !lockfile_present {
        push_finding(
            findings,
            limits,
            truncation_reasons,
            truncated,
            AuditFinding {
                rule_id: "rho.repro.v1.evidence.env.lockfile_missing".to_string(),
                rule_version: 1,
                severity: AuditSeverity::Error,
                category: "evidence".to_string(),
                summary: "No renv.lock found in project root".to_string(),
                evidence: vec![AuditEvidence {
                    kind: "file_path".to_string(),
                    path: Some("renv.lock".to_string()),
                    line: None,
                    column: None,
                    excerpt: None,
                    run_id: None,
                    snapshot_id: None,
                }],
                limitations: Vec::new(),
            },
        );
    }
}

// --- 2b. Portability ------------------------------------------------------

fn check_portability(
    source_files: &[SourceFile],
    limits: &AuditLimits,
    findings: &mut Vec<AuditFinding>,
    truncation_reasons: &mut Vec<String>,
    truncated: &mut bool,
) {
    for file in source_files {
        if file.skipped || file.content.is_empty() {
            continue;
        }

        for (line_idx, line) in file.content.lines().enumerate() {
            let line_num = line_idx as u32 + 1;

            // portability.absolute_path.windows
            if contains_windows_drive_absolute_path(line) {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.portability.absolute_path.windows".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Warning,
                        category: "portability".to_string(),
                        summary: format!(
                            "Windows absolute path detected in {}:{}",
                            file.path, line_num
                        ),
                        evidence: vec![AuditEvidence {
                            kind: "source_range".to_string(),
                            path: Some(file.path.clone()),
                            line: Some(line_num),
                            column: None,
                            excerpt: Some(line.trim().to_string()),
                            run_id: None,
                            snapshot_id: None,
                        }],
                        limitations: Vec::new(),
                    },
                );
            }

            // portability.absolute_path.posix
            let has_posix_path =
                line.contains("/home/") || line.contains("/Users/") || line.contains("/tmp/");
            if has_posix_path {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.portability.absolute_path.posix".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Warning,
                        category: "portability".to_string(),
                        summary: format!(
                            "POSIX absolute path detected in {}:{}",
                            file.path, line_num
                        ),
                        evidence: vec![AuditEvidence {
                            kind: "source_range".to_string(),
                            path: Some(file.path.clone()),
                            line: Some(line_num),
                            column: None,
                            excerpt: Some(line.trim().to_string()),
                            run_id: None,
                            snapshot_id: None,
                        }],
                        limitations: Vec::new(),
                    },
                );
            }

            // portability.home_path.literal
            if line.contains("~/") {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.portability.home_path.literal".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Warning,
                        category: "portability".to_string(),
                        summary: format!(
                            "Home-relative path (~/) detected in {}:{}",
                            file.path, line_num
                        ),
                        evidence: vec![AuditEvidence {
                            kind: "source_range".to_string(),
                            path: Some(file.path.clone()),
                            line: Some(line_num),
                            column: None,
                            excerpt: Some(line.trim().to_string()),
                            run_id: None,
                            snapshot_id: None,
                        }],
                        limitations: Vec::new(),
                    },
                );
            }

            // portability.setwd.literal
            if line.contains("setwd(\"") || line.contains("setwd('") {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.portability.setwd.literal".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Warning,
                        category: "portability".to_string(),
                        summary: format!("setwd() call detected in {}:{}", file.path, line_num),
                        evidence: vec![AuditEvidence {
                            kind: "source_range".to_string(),
                            path: Some(file.path.clone()),
                            line: Some(line_num),
                            column: None,
                            excerpt: Some(line.trim().to_string()),
                            run_id: None,
                            snapshot_id: None,
                        }],
                        limitations: Vec::new(),
                    },
                );
            }
        }
    }
}

fn contains_windows_drive_absolute_path(line: &str) -> bool {
    let bytes = line.as_bytes();
    bytes.windows(3).enumerate().any(|(index, candidate)| {
        candidate[0].is_ascii_alphabetic()
            && candidate[1] == b':'
            && matches!(candidate[2], b'/' | b'\\')
            && (index == 0
                || !(bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_'))
    })
}

// --- 2c. Randomness -------------------------------------------------------

fn check_randomness(
    source_files: &[SourceFile],
    limits: &AuditLimits,
    findings: &mut Vec<AuditFinding>,
    truncation_reasons: &mut Vec<String>,
    truncated: &mut bool,
) {
    for file in source_files {
        if file.skipped || file.content.is_empty() {
            continue;
        }

        let mut seed_seen = false;

        for (line_idx, line) in file.content.lines().enumerate() {
            let line_num = line_idx as u32 + 1;

            if line.contains("set.seed(") {
                seed_seen = true;
                continue;
            }

            if seed_seen {
                // RNG after set.seed() is fine
                continue;
            }

            // Check for RNG calls before set.seed()
            for rng_fn in RNG_FUNCTIONS {
                if line.contains(rng_fn) {
                    push_finding(
                        findings,
                        limits,
                        truncation_reasons,
                        truncated,
                        AuditFinding {
                            rule_id: "rho.repro.v1.randomness.rng_without_seed".to_string(),
                            rule_version: 1,
                            severity: AuditSeverity::Info,
                            category: "randomness".to_string(),
                            summary: format!(
                                "RNG call {} without set.seed() in {}:{}",
                                rng_fn.trim_end_matches('('),
                                file.path,
                                line_num
                            ),
                            evidence: vec![AuditEvidence {
                                kind: "source_range".to_string(),
                                path: Some(file.path.clone()),
                                line: Some(line_num),
                                column: None,
                                excerpt: Some(line.trim().to_string()),
                                run_id: None,
                                snapshot_id: None,
                            }],
                            limitations: vec![
                                "dynamic_rng_not_detected".to_string(),
                                "dplyr_rng_not_detected".to_string(),
                            ],
                        },
                    );
                    // Only report one RNG finding per line
                    break;
                }
            }
        }
    }
}

// --- 2d. Package Evidence -------------------------------------------------

fn check_packages(
    source_files: &[SourceFile],
    snapshot_packages: &Option<Vec<PkgInfo>>,
    lockfile_packages: &Option<Vec<PkgInfo>>,
    limits: &AuditLimits,
    findings: &mut Vec<AuditFinding>,
    truncation_reasons: &mut Vec<String>,
    truncated: &mut bool,
) {
    // Collect all packages referenced in source files
    let mut used_packages: Vec<String> = Vec::new();
    for file in source_files {
        if file.skipped || file.content.is_empty() {
            continue;
        }
        for line in file.content.lines() {
            for pkg in extract_packages_from_line(line) {
                if !used_packages.contains(&pkg) {
                    used_packages.push(pkg);
                }
            }
        }
    }

    let snapshot_packages = snapshot_packages.as_ref();
    let lockfile_packages = lockfile_packages.as_ref();

    // packages.not_recorded: in source but not in snapshot
    if let Some(snapshot) = snapshot_packages {
        for pkg_name in &used_packages {
            if !snapshot.iter().any(|p| p.name == *pkg_name) {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.packages.not_recorded".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Warning,
                        category: "packages".to_string(),
                        summary: format!(
                            "Package '{}' used in source but not found in environment snapshot",
                            pkg_name
                        ),
                        evidence: vec![AuditEvidence {
                            kind: "source_range".to_string(),
                            path: None,
                            line: None,
                            column: None,
                            excerpt: Some(format!("package: {pkg_name}")),
                            run_id: None,
                            snapshot_id: None,
                        }],
                        limitations: vec![
                            "dynamic_library_detection_limited".to_string(),
                            "string_interpolation_not_parsed".to_string(),
                        ],
                    },
                );
            }
        }
    }

    // packages.installed_not_locked: in snapshot but not in lockfile
    if let (Some(snapshot), Some(lockfile)) = (snapshot_packages, lockfile_packages) {
        for pkg in snapshot {
            if !lockfile.iter().any(|lp| lp.name == pkg.name) {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.packages.installed_not_locked".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Info,
                        category: "packages".to_string(),
                        summary: format!(
                            "Package '{}' {} is installed but not in lockfile",
                            pkg.name, pkg.version
                        ),
                        evidence: vec![AuditEvidence {
                            kind: "snapshot_id".to_string(),
                            path: None,
                            line: None,
                            column: None,
                            excerpt: Some(format!("{}@{}", pkg.name, pkg.version)),
                            run_id: None,
                            snapshot_id: None,
                        }],
                        limitations: Vec::new(),
                    },
                );
            }
        }
    }

    // packages.locked_not_installed: in lockfile but not in snapshot
    if let (Some(snapshot), Some(lockfile)) = (snapshot_packages, lockfile_packages) {
        for pkg in lockfile {
            if !snapshot.iter().any(|sp| sp.name == pkg.name) {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.packages.locked_not_installed".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Warning,
                        category: "packages".to_string(),
                        summary: format!(
                            "Package '{}' {} is locked but not installed",
                            pkg.name, pkg.version
                        ),
                        evidence: vec![AuditEvidence {
                            kind: "file_path".to_string(),
                            path: Some("renv.lock".to_string()),
                            line: None,
                            column: None,
                            excerpt: Some(format!("{}@{}", pkg.name, pkg.version)),
                            run_id: None,
                            snapshot_id: None,
                        }],
                        limitations: Vec::new(),
                    },
                );
            }
        }
    }

    // packages.version_drift: version differs between snapshot and lockfile
    if let (Some(snapshot), Some(lockfile)) = (snapshot_packages, lockfile_packages) {
        for sp in snapshot {
            if let Some(lp) = lockfile.iter().find(|lp| lp.name == sp.name)
                && sp.version != lp.version
            {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.packages.version_drift".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Warning,
                        category: "packages".to_string(),
                        summary: format!(
                            "Package '{}' version drift: snapshot={}, lockfile={}",
                            sp.name, sp.version, lp.version
                        ),
                        evidence: vec![AuditEvidence {
                            kind: "snapshot_id".to_string(),
                            path: None,
                            line: None,
                            column: None,
                            excerpt: Some(format!(
                                "snapshot: {}@{}, lockfile: {}@{}",
                                sp.name, sp.version, lp.name, lp.version
                            )),
                            run_id: None,
                            snapshot_id: None,
                        }],
                        limitations: Vec::new(),
                    },
                );
            }
        }
    }
}

// --- 2e. Run & Output Health ----------------------------------------------

fn check_runs(
    runs: &[crate::run::RunSummary],
    artifacts: &[crate::artifact::ArtifactRecordSummary],
    limits: &AuditLimits,
    findings: &mut Vec<AuditFinding>,
    truncation_reasons: &mut Vec<String>,
    truncated: &mut bool,
) {
    let successful_statuses = ["completed"];

    for run in runs {
        // runs.failed
        if run.status == "failed" {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.runs.failed".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Error,
                    category: "runs".to_string(),
                    summary: format!("Run {} failed", run.run_id),
                    evidence: vec![AuditEvidence {
                        kind: "run_id".to_string(),
                        path: None,
                        line: None,
                        column: None,
                        excerpt: run.error_message.clone(),
                        run_id: Some(run.run_id.clone()),
                        snapshot_id: None,
                    }],
                    limitations: Vec::new(),
                },
            );
        }

        // runs.cancelled
        if run.status == "cancelled" {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.runs.cancelled".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Warning,
                    category: "runs".to_string(),
                    summary: format!("Run {} was cancelled", run.run_id),
                    evidence: vec![AuditEvidence {
                        kind: "run_id".to_string(),
                        path: None,
                        line: None,
                        column: None,
                        excerpt: None,
                        run_id: Some(run.run_id.clone()),
                        snapshot_id: None,
                    }],
                    limitations: Vec::new(),
                },
            );
        }

        // runs.interrupted
        if run.status == "interrupted" {
            push_finding(
                findings,
                limits,
                truncation_reasons,
                truncated,
                AuditFinding {
                    rule_id: "rho.repro.v1.runs.interrupted".to_string(),
                    rule_version: 1,
                    severity: AuditSeverity::Warning,
                    category: "runs".to_string(),
                    summary: format!("Run {} was interrupted", run.run_id),
                    evidence: vec![AuditEvidence {
                        kind: "run_id".to_string(),
                        path: None,
                        line: None,
                        column: None,
                        excerpt: None,
                        run_id: Some(run.run_id.clone()),
                        snapshot_id: None,
                    }],
                    limitations: Vec::new(),
                },
            );
        }
    }

    // runs.artifact_incomplete_run: artifact from a non-successful run
    for artifact in artifacts {
        if let Some(ref run_id) = artifact.run_id {
            // Find the run
            let is_incomplete = runs
                .iter()
                .find(|r| &r.run_id == run_id)
                .map(|r| !successful_statuses.contains(&r.status.as_str()))
                .unwrap_or(true); // unknown run is also incomplete

            if is_incomplete {
                push_finding(
                    findings,
                    limits,
                    truncation_reasons,
                    truncated,
                    AuditFinding {
                        rule_id: "rho.repro.v1.runs.artifact_incomplete_run".to_string(),
                        rule_version: 1,
                        severity: AuditSeverity::Warning,
                        category: "runs".to_string(),
                        summary: format!(
                            "Artifact {} from run {} that did not complete successfully",
                            artifact.artifact_id, run_id
                        ),
                        evidence: vec![AuditEvidence {
                            kind: "artifact_id".to_string(),
                            path: Some(artifact.output_path.clone()),
                            line: None,
                            column: None,
                            excerpt: None,
                            run_id: Some(run_id.clone()),
                            snapshot_id: None,
                        }],
                        limitations: Vec::new(),
                    },
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::ArtifactRecordDraft;
    use crate::environment::EnvironmentSnapshotDraft;
    use crate::run::{RunDraft, RunFinish};
    use tempfile::TempDir;

    #[test]
    fn package_extraction_is_unicode_safe_before_namespace_operator() {
        let line = "cat(\"\\n\u{2500}\u{2500}\u{2500} base::plot() \u{2500}\u{2500}\u{2500}\\n\")";
        assert_eq!(extract_packages_from_line(line), vec!["base"]);
        assert_eq!(
            extract_packages_from_line("value <- `stats`::median(x)"),
            vec!["stats"]
        );
    }

    #[test]
    fn windows_drive_absolute_path_accepts_r_slashes_but_not_urls() {
        assert!(contains_windows_drive_absolute_path(
            r#"read.csv("D:\\data\\input.csv")"#
        ));
        assert!(contains_windows_drive_absolute_path(
            r#"read.csv("D:/data/input.csv")"#
        ));
        assert!(!contains_windows_drive_absolute_path(
            r#"download.file("https://example.org/data.csv")"#
        ));
    }

    #[test]
    fn unicode_namespace_text_does_not_hide_saved_portability_and_randomness_findings() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let store = Store::open(dir.path().join("test.sqlite")).unwrap();
        std::fs::write(
            dir.path().join("display.R"),
            "cat(\"\\n\u{2500}\u{2500}\u{2500} base::plot() \u{2500}\u{2500}\u{2500}\\n\")\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("analysis.R"),
            "setwd(\"D:/\")\nrnorm(100)\n",
        )
        .unwrap();

        let response = store.audit_reproducibility(
            AuditScope::Project,
            project_root,
            None,
            &AuditLimits::default(),
        );

        for rule_id in [
            "rho.repro.v1.portability.absolute_path.windows",
            "rho.repro.v1.portability.setwd.literal",
            "rho.repro.v1.randomness.rng_without_seed",
        ] {
            assert!(
                response
                    .findings
                    .iter()
                    .any(|finding| finding.rule_id == rule_id),
                "expected {rule_id}"
            );
        }
    }

    // --- Helpers ---

    fn make_run(
        store: &mut Store,
        project_root: &str,
        run_id: &str,
        status: &str,
        source_path: Option<&str>,
        document_version: Option<i64>,
        env_snapshot_id: Option<&str>,
        error_message: Option<&str>,
    ) {
        store
            .create_run(&RunDraft {
                run_id: run_id.to_string(),
                parent_run_id: None,
                project_root: project_root.to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "scientific".to_string(),
                code: "x <- 1".to_string(),
                arguments_json: "{}".to_string(),
                source_path: source_path.map(|s| s.to_string()),
                execution_mode: Some("file".to_string()),
                document_version,
                workspace_id: format!("ws_{run_id}"),
                state_revision_before: 1,
                project_revision_before: 0,
                environment_snapshot_id: env_snapshot_id.map(|s| s.to_string()),
            })
            .unwrap();
        store.update_run_status(run_id, "running", None).unwrap();
        store
            .finish_run(&RunFinish {
                run_id: run_id.to_string(),
                status: status.to_string(),
                terminal_reason: if status != "completed" {
                    Some("r_error".to_string())
                } else {
                    None
                },
                workspace_id: Some(format!("ws_{run_id}")),
                state_revision_after: Some(2),
                project_revision_after: Some(1),
                stdout: None,
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: error_message.map(|s| s.to_string()),
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: env_snapshot_id.map(|s| s.to_string()),
            })
            .unwrap();
    }

    fn make_artifact(
        store: &mut Store,
        project_root: &str,
        artifact_id: &str,
        run_id: Option<&str>,
        output_path: &str,
        provenance_complete: bool,
    ) {
        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: artifact_id.to_string(),
                artifact_kind: "plot_export".to_string(),
                run_id: run_id.map(|s| s.to_string()),
                project_root: project_root.to_string(),
                output_path: output_path.to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some("ws_test".to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                metadata_json: "{}".to_string(),
                provenance_complete,
                incomplete_reason: if !provenance_complete {
                    Some("partial".to_string())
                } else {
                    None
                },
            })
            .unwrap();
    }

    fn make_snapshot(
        store: &mut Store,
        snapshot_id: &str,
        project_root: &str,
        canonical_json: &str,
    ) {
        store
            .record_environment_snapshot(&EnvironmentSnapshotDraft {
                snapshot_id: snapshot_id.to_string(),
                project_root: project_root.to_string(),
                canonical_json: canonical_json.to_string(),
            })
            .unwrap();
    }

    fn snapshot_with_packages(packages: &[(&str, &str)]) -> String {
        let installed: Vec<serde_json::Value> = packages
            .iter()
            .map(|(name, version)| {
                serde_json::json!({
                    "Package": name,
                    "Version": version,
                })
            })
            .collect();
        serde_json::json!({
            "installed_packages": installed,
            "completeness": "complete",
        })
        .to_string()
    }

    // --- Tests ---

    #[test]
    fn empty_project_returns_complete() {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("test.sqlite");
        let store = Store::open(&database).unwrap();

        // Create a minimal renv.lock so lockfile_missing doesn't fire
        let lockfile = serde_json::json!({
            "Packages": {}
        })
        .to_string();
        std::fs::write(dir.path().join("renv.lock"), &lockfile).unwrap();

        let limits = AuditLimits::default();

        let response = store.audit_reproducibility(
            AuditScope::Project,
            dir.path().to_str().unwrap(),
            None,
            &limits,
        );

        assert_eq!(response.status, AuditStatus::Complete);
        assert_eq!(response.findings.len(), 0);
        assert_eq!(response.summary.total_findings, 0);
        // renv.lock is used by package checks but is not an R source file.
        assert_eq!(response.coverage.files_scanned, 0);
        assert_eq!(response.coverage.runs_considered, 0);
        assert!(!response.truncated);
    }

    #[test]
    fn evidence_completeness_rules() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let database = dir.path().join("test.sqlite");
        let mut store = Store::open(&database).unwrap();

        // Run with NO snapshot and NO source_path -> two warnings
        make_run(
            &mut store,
            project_root,
            "run_no_snap",
            "completed",
            None,
            None,
            None,
            None,
        );

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let evidence_ids: Vec<&str> = response
            .findings
            .iter()
            .map(|f| f.rule_id.as_str())
            .collect();

        assert!(
            evidence_ids.contains(&"rho.repro.v1.evidence.run.env_snapshot_missing"),
            "should flag missing env snapshot"
        );
        assert!(
            evidence_ids.contains(&"rho.repro.v1.evidence.run.source_revision_missing"),
            "should flag missing source revision"
        );

        // Artifact with no producing run
        make_artifact(
            &mut store,
            project_root,
            "artifact_no_run",
            None,
            "output.png",
            true,
        );
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);
        assert!(
            response
                .findings
                .iter()
                .any(|f| f.rule_id == "rho.repro.v1.evidence.artifact.producing_run_missing"),
            "should flag artifact with no producing run"
        );

        // Artifact with incomplete provenance
        make_artifact(
            &mut store,
            project_root,
            "artifact_incomplete",
            Some("run_no_snap"),
            "output2.png",
            false,
        );
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);
        assert!(
            response
                .findings
                .iter()
                .any(|f| f.rule_id == "rho.repro.v1.evidence.artifact.provenance_incomplete"),
            "should flag incomplete provenance"
        );

        // Lockfile missing (no renv.lock in tempdir)
        assert!(
            response
                .findings
                .iter()
                .any(|f| f.rule_id == "rho.repro.v1.evidence.env.lockfile_missing"),
            "should flag missing lockfile"
        );
    }

    #[test]
    fn portability_windows_absolute_path() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let store = Store::open(&db_path).unwrap();

        // Write a file with a Windows absolute path (backslash form)
        let r_file = dir.path().join("analysis.R");
        std::fs::write(&r_file, "data <- read.csv(\"D:\\\\data\\\\file.csv\")\n").unwrap();

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let portability: Vec<_> = response
            .findings
            .iter()
            .filter(|f| f.rule_id.starts_with("rho.repro.v1.portability."))
            .collect();

        assert!(!portability.is_empty(), "should detect portability issues");

        let win_finding = portability
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.portability.absolute_path.windows");
        assert!(
            win_finding.is_some(),
            "should detect D:/data/file.csv as Windows absolute path"
        );
    }

    #[test]
    fn randomness_rng_without_seed() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let store = Store::open(&db_path).unwrap();

        // File with rnorm() but no set.seed()
        let r_file = dir.path().join("analysis.R");
        std::fs::write(&r_file, "x <- rnorm(100)\nprint(mean(x))\n").unwrap();

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let rng_finding = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.randomness.rng_without_seed");

        assert!(
            rng_finding.is_some(),
            "should flag rnorm() without set.seed()"
        );
        assert_eq!(rng_finding.unwrap().severity, AuditSeverity::Info);
    }

    #[test]
    fn randomness_with_seed_not_flagged() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let store = Store::open(&db_path).unwrap();

        // File with set.seed() BEFORE rnorm()
        let r_file = dir.path().join("analysis.R");
        std::fs::write(&r_file, "set.seed(42)\nx <- rnorm(100)\nprint(mean(x))\n").unwrap();

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let rng_finding = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.randomness.rng_without_seed");

        assert!(
            rng_finding.is_none(),
            "should NOT flag rnorm() when set.seed() precedes it"
        );
    }

    #[test]
    fn package_evidence_unmatched_package() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        // Source file using a package
        let r_file = dir.path().join("analysis.R");
        std::fs::write(&r_file, "library(ggplot2)\nlibrary(dplyr)\n").unwrap();

        // Lockfile with only ggplot2
        let lockfile = serde_json::json!({
            "Packages": {
                "ggplot2": {
                    "Package": "ggplot2",
                    "Version": "3.5.0"
                }
            }
        })
        .to_string();
        std::fs::write(dir.path().join("renv.lock"), &lockfile).unwrap();

        // Snapshot with only ggplot2
        let snap_json = snapshot_with_packages(&[("ggplot2", "3.5.0")]);
        make_snapshot(&mut store, "snap_1", project_root, &snap_json);

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, Some("snap_1"), &limits);

        // dplyr is used but not in snapshot -> packages.not_recorded
        let not_recorded = response
            .findings
            .iter()
            .filter(|f| f.rule_id == "rho.repro.v1.packages.not_recorded")
            .collect::<Vec<_>>();

        assert_eq!(
            not_recorded.len(),
            1,
            "should flag 1 unmatched package: dplyr"
        );
        assert!(
            not_recorded[0].summary.contains("dplyr"),
            "unmatched package should be dplyr"
        );
    }

    #[test]
    fn package_version_drift() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        // Lockfile has ggplot2 3.5.0
        let lockfile = serde_json::json!({
            "Packages": {
                "ggplot2": {
                    "Package": "ggplot2",
                    "Version": "3.5.0"
                }
            }
        })
        .to_string();
        std::fs::write(dir.path().join("renv.lock"), &lockfile).unwrap();

        // Snapshot has ggplot2 3.4.0 (different version)
        let snap_json = snapshot_with_packages(&[("ggplot2", "3.4.0")]);
        make_snapshot(&mut store, "snap_drift", project_root, &snap_json);

        let limits = AuditLimits::default();
        let response = store.audit_reproducibility(
            AuditScope::Project,
            project_root,
            Some("snap_drift"),
            &limits,
        );

        let drift = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.packages.version_drift");
        assert!(drift.is_some(), "should flag version drift");
        assert!(drift.unwrap().summary.contains("3.5.0"));
        assert!(drift.unwrap().summary.contains("3.4.0"));
    }

    #[test]
    fn run_health_failed_run() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        make_run(
            &mut store,
            project_root,
            "run_fail",
            "failed",
            Some("analysis.R"),
            Some(1),
            Some("snap_run"),
            Some("Error: object 'x' not found"),
        );

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let failed = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.runs.failed");
        assert!(failed.is_some(), "should flag failed run");
    }

    #[test]
    fn scope_run_filters_correctly() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        // run_1: failed
        make_run(
            &mut store,
            project_root,
            "run_1",
            "failed",
            Some("a.R"),
            Some(1),
            None,
            Some("boom"),
        );
        // run_2: completed
        make_run(
            &mut store,
            project_root,
            "run_2",
            "completed",
            Some("b.R"),
            Some(1),
            None,
            None,
        );

        let limits = AuditLimits::default();

        // Scope to run_1 only
        let resp_run1 = store.audit_reproducibility(
            AuditScope::Run("run_1".to_string()),
            project_root,
            None,
            &limits,
        );

        // Should see failed for run_1
        let failed = resp_run1
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.runs.failed");
        assert!(failed.is_some(), "run_1 should be flagged as failed");
        assert_eq!(resp_run1.coverage.runs_considered, 1);

        // Scope to run_2 only
        let resp_run2 = store.audit_reproducibility(
            AuditScope::Run("run_2".to_string()),
            project_root,
            None,
            &limits,
        );
        let failed2 = resp_run2
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.runs.failed");
        assert!(failed2.is_none(), "run_2 should not be flagged as failed");
    }

    #[test]
    fn truncation_at_findings_limit() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        // Create many failed runs
        for i in 0..20 {
            make_run(
                &mut store,
                project_root,
                &format!("run_{i}"),
                "failed",
                Some("analysis.R"),
                Some(1),
                None,
                Some("error"),
            );
        }

        let limits = AuditLimits {
            max_findings: 5,
            ..AuditLimits::default()
        };

        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        assert!(response.truncated, "should be truncated");
        assert!(
            response
                .truncation_reasons
                .contains(&"max_findings".to_string()),
            "should report max_findings truncation"
        );
        assert!(response.findings.len() <= 5, "should cap at 5 findings");
    }

    #[test]
    fn deterministic_output() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        make_run(
            &mut store,
            project_root,
            "run_det",
            "failed",
            Some("analysis.R"),
            Some(1),
            None,
            Some("error"),
        );

        let r_file = dir.path().join("analysis.R");
        std::fs::write(&r_file, "x <- rnorm(100)\n").unwrap();

        let limits = AuditLimits::default();
        let resp1 = store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);
        let resp2 = store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        // Same input -> same output (findings, summary counts, and coverage
        // must be identical even though generated_at timestamps differ).
        assert_eq!(
            resp1.findings, resp2.findings,
            "findings must be deterministic"
        );
        assert_eq!(resp1.status, resp2.status);
        assert_eq!(resp1.summary.total_findings, resp2.summary.total_findings);
        assert_eq!(resp1.summary.info, resp2.summary.info);
        assert_eq!(resp1.summary.warning, resp2.summary.warning);
        assert_eq!(resp1.summary.error, resp2.summary.error);
        assert_eq!(resp1.summary.files_scanned, resp2.summary.files_scanned);
        assert_eq!(resp1.summary.runs_checked, resp2.summary.runs_checked);
        assert_eq!(resp1.truncated, resp2.truncated);
        assert_eq!(resp1.truncation_reasons, resp2.truncation_reasons);
        assert_eq!(resp1.coverage.files_scanned, resp2.coverage.files_scanned);
        assert_eq!(resp1.coverage.files_skipped, resp2.coverage.files_skipped);
    }

    #[test]
    fn severity_levels_all_present() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        // Failed run -> Error
        make_run(
            &mut store,
            project_root,
            "run_err",
            "failed",
            Some("a.R"),
            Some(1),
            None,
            Some("error"),
        );

        // Cancelled run -> Warning
        make_run(
            &mut store,
            project_root,
            "run_cancel",
            "cancelled",
            Some("a.R"),
            Some(1),
            None,
            None,
        );

        // Make store update... actually "cancelled" won't work through our helper.
        // Let's set it directly. Hmm, we can't access connection directly.
        // Let's just use the helper and it sets to whatever status we pass.
        // But our helper calls update_run_status then finish_run with the same status.
        // The finish_run will set it to what we pass. That should work.

        // RNG without seed -> Info
        std::fs::write(dir.path().join("a.R"), "x <- rnorm(100)\n").unwrap();

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let has_error = response
            .findings
            .iter()
            .any(|f| f.severity == AuditSeverity::Error);
        let has_warning = response
            .findings
            .iter()
            .any(|f| f.severity == AuditSeverity::Warning);
        let has_info = response
            .findings
            .iter()
            .any(|f| f.severity == AuditSeverity::Info);

        assert!(has_error, "should have at least one Error (failed run)");
        assert!(
            has_warning,
            "should have at least one Warning (cancelled run)"
        );
        assert!(has_info, "should have at least one Info (RNG without seed)");
    }

    #[test]
    fn artifact_file_missing_detected() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        make_run(
            &mut store,
            project_root,
            "run_art",
            "completed",
            Some("analysis.R"),
            Some(1),
            Some("snap_art"),
            None,
        );

        // Artifact pointing to a file that doesn't exist
        make_artifact(
            &mut store,
            project_root,
            "artifact_missing",
            Some("run_art"),
            "results/plot.png",
            true,
        );

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let file_missing = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.evidence.artifact.file_missing");
        assert!(
            file_missing.is_some(),
            "should flag artifact with missing output file"
        );
    }

    #[test]
    fn portability_setwd_detected() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let store = Store::open(&db_path).unwrap();

        std::fs::write(
            dir.path().join("setup.R"),
            "setwd(\"/some/path\")\ndata <- read.csv(\"file.csv\")\n",
        )
        .unwrap();

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let setwd_finding = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.portability.setwd.literal");
        assert!(setwd_finding.is_some(), "should detect setwd() call");
    }

    #[test]
    fn packages_installed_not_locked() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        // Lockfile has only dplyr
        let lockfile = serde_json::json!({
            "Packages": {
                "dplyr": {
                    "Package": "dplyr",
                    "Version": "1.1.4"
                }
            }
        })
        .to_string();
        std::fs::write(dir.path().join("renv.lock"), &lockfile).unwrap();

        // Snapshot has dplyr AND ggplot2 (extra in snapshot)
        let snap_json = snapshot_with_packages(&[("dplyr", "1.1.4"), ("ggplot2", "3.5.0")]);
        make_snapshot(&mut store, "snap_extra", project_root, &snap_json);

        let limits = AuditLimits::default();
        let response = store.audit_reproducibility(
            AuditScope::Project,
            project_root,
            Some("snap_extra"),
            &limits,
        );

        let installed_not_locked = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.packages.installed_not_locked");
        assert!(
            installed_not_locked.is_some(),
            "should flag ggplot2 as installed but not locked"
        );
        assert!(
            installed_not_locked.unwrap().summary.contains("ggplot2"),
            "should mention ggplot2"
        );
    }

    #[test]
    fn packages_locked_not_installed() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        // Lockfile has ggplot2
        let lockfile = serde_json::json!({
            "Packages": {
                "ggplot2": {
                    "Package": "ggplot2",
                    "Version": "3.5.0"
                }
            }
        })
        .to_string();
        std::fs::write(dir.path().join("renv.lock"), &lockfile).unwrap();

        // Snapshot only has dplyr (ggplot2 missing)
        let snap_json = snapshot_with_packages(&[("dplyr", "1.1.4")]);
        make_snapshot(&mut store, "snap_missing", project_root, &snap_json);

        let limits = AuditLimits::default();
        let response = store.audit_reproducibility(
            AuditScope::Project,
            project_root,
            Some("snap_missing"),
            &limits,
        );

        let locked_not_installed = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.packages.locked_not_installed");
        assert!(
            locked_not_installed.is_some(),
            "should flag ggplot2 as locked but not installed"
        );
        assert!(
            locked_not_installed.unwrap().summary.contains("ggplot2"),
            "should mention ggplot2"
        );
    }

    #[test]
    fn runs_cancelled_and_interrupted() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        make_run(
            &mut store,
            project_root,
            "run_cancelled",
            "cancelled",
            Some("a.R"),
            Some(1),
            None,
            None,
        );
        make_run(
            &mut store,
            project_root,
            "run_interrupted",
            "interrupted",
            Some("b.R"),
            Some(1),
            None,
            None,
        );

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        assert!(
            response
                .findings
                .iter()
                .any(|f| f.rule_id == "rho.repro.v1.runs.cancelled"),
            "should flag cancelled run"
        );
        assert!(
            response
                .findings
                .iter()
                .any(|f| f.rule_id == "rho.repro.v1.runs.interrupted"),
            "should flag interrupted run"
        );
    }

    #[test]
    fn artifact_incomplete_run_detected() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        make_run(
            &mut store,
            project_root,
            "run_bad",
            "failed",
            Some("a.R"),
            Some(1),
            None,
            Some("boom"),
        );

        // Artifact from the failed run
        make_artifact(
            &mut store,
            project_root,
            "art_from_fail",
            Some("run_bad"),
            "output.png",
            true,
        );

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        let incomplete_art = response
            .findings
            .iter()
            .find(|f| f.rule_id == "rho.repro.v1.runs.artifact_incomplete_run");
        assert!(
            incomplete_art.is_some(),
            "should flag artifact from incomplete run"
        );
    }

    #[test]
    fn audit_coverage_tracks_stats() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();

        // Create 2 runs
        make_run(
            &mut store,
            project_root,
            "run_a",
            "completed",
            Some("analysis.R"),
            Some(1),
            None,
            None,
        );
        make_run(
            &mut store,
            project_root,
            "run_b",
            "completed",
            Some("plot.R"),
            Some(1),
            None,
            None,
        );

        // Create 2 source files
        std::fs::write(dir.path().join("analysis.R"), "x <- 1\n").unwrap();
        std::fs::write(dir.path().join("plot.R"), "plot(x)\n").unwrap();

        let limits = AuditLimits::default();
        let response =
            store.audit_reproducibility(AuditScope::Project, project_root, None, &limits);

        assert_eq!(response.coverage.runs_considered, 2);
        assert_eq!(response.coverage.files_scanned, 2);
        assert_eq!(response.summary.runs_checked, 2);
    }

    #[test]
    fn current_project_scope_excludes_historical_runs_and_artifacts() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let mut store = Store::open(&db_path).unwrap();
        make_run(
            &mut store,
            project_root,
            "historical_run",
            "completed",
            Some("analysis.R"),
            Some(1),
            None,
            None,
        );
        std::fs::write(dir.path().join("analysis.R"), "x <- 1\n").unwrap();

        let response = store.audit_reproducibility(
            AuditScope::CurrentProject,
            project_root,
            None,
            &AuditLimits::default(),
        );

        assert_eq!(response.scope, "project_current");
        assert_eq!(response.coverage.runs_considered, 0);
        assert_eq!(response.coverage.artifacts_considered, 0);
        assert_eq!(response.coverage.files_scanned, 1);
    }

    #[test]
    fn source_file_binary_skipped() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();

        // Write a .png file -- should be skipped (binary extension)
        std::fs::write(dir.path().join("plot.png"), b"fake_png_data").unwrap();
        // Write a .rds file -- should be skipped (binary extension)
        std::fs::write(dir.path().join("data.rds"), b"fake_rds_data").unwrap();
        // Write a valid R file
        std::fs::write(dir.path().join("analysis.R"), "x <- 1\n").unwrap();

        let files = scan_source_files(project_root, &AuditLimits::default());

        let r_files: Vec<_> = files.iter().filter(|f| !f.skipped).collect();
        assert_eq!(r_files.len(), 1, "only analysis.R should be scanned");
        assert_eq!(r_files[0].path, "analysis.R");

        // Binary files (.png, .rds) should be excluded entirely (not in the list)
        let binary_names: Vec<_> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            !binary_names
                .iter()
                .any(|name| name.contains(".png") || name.contains(".rds")),
            "binary files should be excluded from the file list"
        );
    }

    #[test]
    fn source_file_filter_excludes_generated_html_and_keeps_r_sources() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        for name in ["report.html", "report.css", "report.js"] {
            std::fs::write(dir.path().join(name), "sample(1)\n").unwrap();
        }
        for name in [
            "analysis.R",
            "report.Rmd",
            "report.qmd",
            "notes.Rnw",
            "Makefile",
        ] {
            std::fs::write(dir.path().join(name), "x <- 1\n").unwrap();
        }

        let files = scan_source_files(project_root, &AuditLimits::default());
        let paths: Vec<_> = files.iter().map(|file| file.path.as_str()).collect();

        assert!(paths.contains(&"analysis.R"));
        assert!(paths.contains(&"report.Rmd"));
        assert!(paths.contains(&"report.qmd"));
        assert!(paths.contains(&"notes.Rnw"));
        assert!(paths.contains(&"Makefile"));
        assert!(!paths.contains(&"report.html"));
        assert!(!paths.contains(&"report.css"));
        assert!(!paths.contains(&"report.js"));
    }

    #[test]
    fn captured_current_project_rules_never_reread_changed_disk_state() {
        let dir = TempDir::new().unwrap();
        let project_root = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("analysis.R"), "setwd('/tmp/input')\n").unwrap();
        std::fs::write(dir.path().join("renv.lock"), r#"{"Packages":{}}"#).unwrap();
        let captured =
            capture_current_project_audit_snapshot(project_root, &AuditLimits::default());

        std::fs::write(dir.path().join("analysis.R"), "x <- 1\n").unwrap();
        std::fs::remove_file(dir.path().join("renv.lock")).unwrap();
        let first = audit_current_project_snapshot(&captured, &AuditLimits::default());
        let second = audit_current_project_snapshot(&captured, &AuditLimits::default());

        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&second).unwrap()
        );
        assert!(
            first
                .findings
                .iter()
                .any(|finding| { finding.rule_id == "rho.repro.v1.portability.setwd.literal" })
        );
        assert!(
            !first
                .findings
                .iter()
                .any(|finding| { finding.rule_id == "rho.repro.v1.evidence.env.lockfile_missing" })
        );

        let live = capture_current_project_audit_snapshot(project_root, &AuditLimits::default());
        let live_result = audit_current_project_snapshot(&live, &AuditLimits::default());
        assert!(
            !live_result
                .findings
                .iter()
                .any(|finding| { finding.rule_id == "rho.repro.v1.portability.setwd.literal" })
        );
        assert!(
            live_result
                .findings
                .iter()
                .any(|finding| { finding.rule_id == "rho.repro.v1.evidence.env.lockfile_missing" })
        );
    }
}
