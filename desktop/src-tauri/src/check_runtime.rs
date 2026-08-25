use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Mutex as StdMutex, MutexGuard};

use anyhow::{Context, Result, anyhow, ensure};
use rho_store::{
    AuditEvidence, AuditFinding, AuditLimits, AuditResponse, AuditSeverity, AuditStatus,
    CurrentProjectAuditSnapshot, audit_current_project_snapshot,
    capture_current_project_audit_snapshot,
};
use rho_ui_contract::{
    ApplicationComponentId, CHECK_PROJECT_SNAPSHOT_CONTRACT, CHECK_RESULT_CONTRACT,
    CheckCoverageV1, CheckEvidenceV1, CheckFindingV1, CheckProjectSnapshotV1, CheckResultId,
    CheckResultStatusV1, CheckResultV1, CheckRuleId, CheckRulePackOutputV1, CheckSeverityV1,
    CheckSnapshotFileV1, CheckSnapshotId, MAX_CHECK_RESULT_BYTES, MAX_CHECK_RESULT_EVIDENCE,
    MAX_CHECK_RESULT_FINDINGS, PackageDigest, PluginId, ProjectId, SurfaceOriginV1, Validate,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{AppState, display_error, text_sha256};

pub(crate) const CHECK_RESULTS_CHANGED_EVENT: &str = "rho://check-results-changed";
const CHECK_CORE_RULE_COUNT: usize = 22;
const MAX_CHECK_RESULTS_PER_PROJECT: usize = 32;
const MAX_PLUGIN_SNAPSHOT_INPUT_BYTES: usize = 192 * 1024;
const MAX_CHECK_PLUGIN_RULE_PACKS: usize = 8;
const MAX_CHECK_RESULT_LIMITATIONS: usize = 64;

#[derive(Default)]
struct ProjectCheckResults {
    order: VecDeque<CheckResultId>,
    results: BTreeMap<CheckResultId, CheckResultV1>,
}

#[derive(Default)]
struct CheckRuntimeInner {
    projects: BTreeMap<ProjectId, ProjectCheckResults>,
}

#[derive(Default)]
pub(crate) struct CheckRuntimeState {
    inner: StdMutex<CheckRuntimeInner>,
}

impl CheckRuntimeState {
    fn inner(&self) -> MutexGuard<'_, CheckRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn insert(&self, result: CheckResultV1) -> Result<()> {
        result.validate()?;
        let project = result.project_id.clone();
        let result_id = result.result_id.clone();
        let mut inner = self.inner();
        let results = inner.projects.entry(project).or_default();
        if results.results.contains_key(&result_id) {
            return Err(anyhow!("Check result identity already exists"));
        }
        results.order.push_back(result_id.clone());
        results.results.insert(result_id, result);
        while results.order.len() > MAX_CHECK_RESULTS_PER_PROJECT {
            if let Some(evicted) = results.order.pop_front() {
                results.results.remove(&evicted);
            }
        }
        Ok(())
    }

    fn get(&self, project_id: &ProjectId, result_id: &CheckResultId) -> Option<CheckResultV1> {
        self.inner()
            .projects
            .get(project_id)
            .and_then(|results| results.results.get(result_id))
            .cloned()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub(crate) struct CheckRunRequest {
    pub project_id: ProjectId,
    #[specta(type = rho_ui_contract::UiIpcNumber)]
    pub expected_project_revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
pub(crate) struct CheckResultRequest {
    pub project_id: ProjectId,
    #[specta(type = rho_ui_contract::UiIpcNumber)]
    pub expected_project_revision: u64,
    pub result_id: CheckResultId,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct CheckRunResponse {
    pub result: CheckResultV1,
}

#[derive(Debug, Clone, Serialize)]
struct CheckResultsChanged<'a> {
    project_id: &'a ProjectId,
    result_id: &'a CheckResultId,
    project_revision: u64,
}

fn public_snapshot(
    raw: &CurrentProjectAuditSnapshot,
    project_id: ProjectId,
    project_revision: u64,
) -> Result<CheckProjectSnapshotV1> {
    let snapshot_hash_input = serde_json::to_string(&json!({
        "project_id": project_id,
        "project_revision": project_revision,
        "raw": raw,
    }))?;
    let mut limitations = raw
        .source_files
        .iter()
        .filter_map(|file| file.skip_reason.as_ref())
        .map(|reason| format!("Source capture skipped a file: {reason}."))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if raw.renv_lock_present && raw.renv_lock_content.is_none() {
        limitations.push("renv.lock was unreadable or exceeded the capture budget.".to_string());
    }
    let source_bytes = raw
        .source_files
        .iter()
        .map(|file| file.content.len() as u64)
        .sum();
    let snapshot = CheckProjectSnapshotV1 {
        contract: CHECK_PROJECT_SNAPSHOT_CONTRACT.to_string(),
        snapshot_id: CheckSnapshotId::new(format!(
            "check-snapshot:{}",
            text_sha256(&snapshot_hash_input)
        ))?,
        project_id,
        project_revision,
        captured_at: raw.captured_at.clone(),
        files: raw
            .source_files
            .iter()
            .map(|file| CheckSnapshotFileV1 {
                path: file.path.clone(),
                size_bytes: file.content.len() as u64,
                content_sha256: text_sha256(&file.content),
                skipped: file.skipped,
                skip_reason: file.skip_reason.clone(),
            })
            .collect(),
        source_bytes,
        renv_lock_sha256: raw.renv_lock_content.as_ref().map(|text| text_sha256(text)),
        truncated: raw.source_files.len() >= AuditLimits::default().max_source_files,
        limitations,
    };
    snapshot.validate()?;
    Ok(snapshot)
}

fn plugin_snapshot(mut snapshot: CheckProjectSnapshotV1) -> CheckProjectSnapshotV1 {
    while serde_json::to_vec(&json!({"operation": "check", "snapshot": &snapshot}))
        .map_or(usize::MAX, |bytes| bytes.len())
        > MAX_PLUGIN_SNAPSHOT_INPUT_BYTES
        && !snapshot.files.is_empty()
    {
        snapshot.files.pop();
        snapshot.truncated = true;
    }
    if snapshot.truncated
        && !snapshot
            .limitations
            .iter()
            .any(|value| value == "Workspace rule-pack input was descriptor-truncated.")
    {
        snapshot
            .limitations
            .push("Workspace rule-pack input was descriptor-truncated.".to_string());
    }
    snapshot.source_bytes = snapshot.files.iter().map(|file| file.size_bytes).sum();
    snapshot
}

fn omit_null_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|_, value| !value.is_null());
            for value in object.values_mut() {
                omit_null_fields(value);
            }
        }
        Value::Array(items) => {
            for item in items {
                omit_null_fields(item);
            }
        }
        _ => {}
    }
}

fn plugin_check_input(snapshot: &CheckProjectSnapshotV1) -> Value {
    let mut snapshot = serde_json::to_value(snapshot).unwrap_or_else(|_| json!({}));
    omit_null_fields(&mut snapshot);
    json!({"operation": "check", "snapshot": snapshot})
}

fn bounded_limitation(value: impl AsRef<str>) -> String {
    crate::startup_runtime::bounded_diagnostic(value.as_ref())
        .chars()
        .take(1_024)
        .collect()
}

fn evidence_from_audit(evidence: AuditEvidence) -> CheckEvidenceV1 {
    if let (Some(path), Some(line)) = (evidence.path.clone(), evidence.line) {
        return CheckEvidenceV1::SourceRange {
            path,
            line,
            column: evidence.column,
            excerpt: evidence.excerpt,
        };
    }
    if let Some(path) = evidence.path {
        return CheckEvidenceV1::ProjectFile { path };
    }
    if let Some(run_id) = evidence.run_id {
        return CheckEvidenceV1::RunRef { run_id };
    }
    if let Some(snapshot_id) = evidence.snapshot_id {
        return CheckEvidenceV1::EnvironmentRef { snapshot_id };
    }
    CheckEvidenceV1::Note {
        text: evidence
            .excerpt
            .unwrap_or_else(|| "Core rule returned no navigable evidence.".to_string()),
    }
}

fn core_rule_presentation(rule_id: &str) -> (&'static str, &'static str, &'static str) {
    match rule_id {
        "rho.repro.v1.evidence.run.env_snapshot_missing" => (
            "Environment was not recorded",
            "A run has no saved record of the R and package environment used.",
            "Rerun important work after confirming the project environment.",
        ),
        "rho.repro.v1.evidence.run.source_revision_missing" => (
            "Source version was not recorded",
            "A run is not linked to the saved source version that produced it.",
            "Open the related run and confirm which code was executed.",
        ),
        "rho.repro.v1.evidence.artifact.producing_run_missing" => (
            "Saved output has no producing run",
            "A saved output is not linked to the run that created it.",
            "Regenerate the output from a recorded run when provenance matters.",
        ),
        "rho.repro.v1.evidence.artifact.provenance_incomplete" => (
            "Saved output has incomplete history",
            "A saved output is missing source or environment information.",
            "Review the output and regenerate it from the current project if needed.",
        ),
        "rho.repro.v1.evidence.artifact.file_missing" => (
            "Saved output file is missing",
            "The output remains in project history, but its file is no longer available.",
            "Restore the file or regenerate the output.",
        ),
        "rho.repro.v1.evidence.env.snapshot_incomplete" => (
            "Environment record is incomplete",
            "A recorded environment does not contain all information needed for review.",
            "Refresh the project environment evidence before sharing results.",
        ),
        "rho.repro.v1.evidence.env.lockfile_drift" => (
            "Package lockfile has changed",
            "The recorded environment no longer matches the project lockfile.",
            "Review Environment and update or restore the lockfile intentionally.",
        ),
        "rho.repro.v1.evidence.env.lockfile_missing" => (
            "Package lockfile is missing",
            "The project has no renv.lock file to record package versions.",
            "Initialize renv when the project needs a reproducible package environment.",
        ),
        "rho.repro.v1.portability.absolute_path.windows" => (
            "Windows-specific path",
            "Source code refers to a location tied to one Windows machine.",
            "Use a project-relative path or a configurable input location.",
        ),
        "rho.repro.v1.portability.absolute_path.posix" => (
            "System-specific path",
            "Source code refers to an absolute location that may not exist elsewhere.",
            "Use a project-relative path or a configurable input location.",
        ),
        "rho.repro.v1.portability.home_path.literal" => (
            "Home-folder path",
            "Source code depends on a file under one user's home folder.",
            "Move the input into the project or make its location configurable.",
        ),
        "rho.repro.v1.portability.setwd.literal" => (
            "Working directory changed in code",
            "The analysis changes its working directory to a fixed location.",
            "Open the intended Rho project and use project-relative paths.",
        ),
        "rho.repro.v1.randomness.rng_without_seed" => (
            "Random result may change",
            "Random-number generation was found without a nearby fixed seed.",
            "Set a deliberate seed before the random analysis when repeatability matters.",
        ),
        "rho.repro.v1.packages.not_recorded" => (
            "Package is not in the environment record",
            "Source code uses a package that is absent from the recorded environment.",
            "Refresh Environment and record the package dependency.",
        ),
        "rho.repro.v1.packages.installed_not_locked" => (
            "Installed package is not locked",
            "A package is available now but is not recorded in renv.lock.",
            "Review and snapshot the intended package environment.",
        ),
        "rho.repro.v1.packages.locked_not_installed" => (
            "Locked package is not installed",
            "renv.lock expects a package that is unavailable in the current environment.",
            "Review Environment and restore the lockfile deliberately.",
        ),
        "rho.repro.v1.packages.version_drift" => (
            "Package versions differ",
            "The installed package version differs from the locked version.",
            "Choose whether to restore or update the project environment.",
        ),
        "rho.repro.v1.runs.failed" => (
            "A run failed",
            "A recorded analysis ended with an error.",
            "Open the related run, review the error, and rerun only after correcting it.",
        ),
        "rho.repro.v1.runs.cancelled" => (
            "A run was cancelled",
            "A recorded analysis was cancelled before completion.",
            "Confirm whether a completed replacement run is needed.",
        ),
        "rho.repro.v1.runs.interrupted" => (
            "A run was interrupted",
            "A recorded analysis stopped before completion.",
            "Confirm whether a completed replacement run is needed.",
        ),
        "rho.repro.v1.runs.warning_bearing" => (
            "A run reported warnings",
            "A recorded analysis completed with warnings that may affect interpretation.",
            "Open the run and review its warnings before relying on the result.",
        ),
        "rho.repro.v1.runs.artifact_incomplete_run" => (
            "Output came from an incomplete run",
            "A saved output is linked to a run that did not complete successfully.",
            "Review the output carefully and regenerate it from a successful run.",
        ),
        _ => (
            "Review needed",
            "A bounded project rule found something that may affect reproducibility.",
            "Review the linked evidence before relying on this result.",
        ),
    }
}

fn finding_from_audit(finding: AuditFinding) -> Result<CheckFindingV1> {
    let (title, summary, remediation) = core_rule_presentation(&finding.rule_id);
    Ok(CheckFindingV1 {
        rule_id: CheckRuleId::new(finding.rule_id)?,
        rule_version: finding.rule_version,
        origin: SurfaceOriginV1::Application {
            component_id: ApplicationComponentId::new("rho.check.core")?,
        },
        activation_generation: 1,
        severity: match finding.severity {
            AuditSeverity::Info => CheckSeverityV1::Info,
            AuditSeverity::Warning => CheckSeverityV1::Warning,
            AuditSeverity::Error => CheckSeverityV1::Error,
        },
        category: finding.category,
        title: title.to_string(),
        summary: summary.to_string(),
        remediation: remediation.to_string(),
        evidence: finding
            .evidence
            .into_iter()
            .map(evidence_from_audit)
            .collect(),
        limitations: finding.limitations,
    })
}

fn validate_plugin_evidence(
    snapshot: &CheckProjectSnapshotV1,
    finding: &rho_ui_contract::PluginCheckFindingV1,
) -> Result<()> {
    let paths = snapshot
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    for evidence in &finding.evidence {
        match evidence {
            CheckEvidenceV1::SourceRange { path, .. } | CheckEvidenceV1::ProjectFile { path } => {
                ensure!(
                    paths.contains(path.as_str()),
                    "workspace Check rule referenced a file outside its immutable snapshot"
                )
            }
            CheckEvidenceV1::Note { .. } => {}
            CheckEvidenceV1::RunRef { .. } | CheckEvidenceV1::EnvironmentRef { .. } => {
                return Err(anyhow!(
                    "workspace Check rule cannot invent Run or Environment evidence"
                ));
            }
        }
    }
    Ok(())
}

fn completed_plugin_result(value: &Value) -> Result<Value> {
    ensure!(
        value.get("status").and_then(Value::as_str) == Some("completed"),
        "workspace Check rule returned a failed terminal result"
    );
    value
        .get("result")
        .cloned()
        .context("workspace Check rule result is missing")
}

fn ruleset_digest(
    registrations: &[crate::workspace_plugins::WorkspaceCheckRuleRegistration],
) -> String {
    let mut identity = "rho.check.core@1\n".to_string();
    for registration in registrations {
        identity.push_str(&format!(
            "{}\0{}\0{}\0{}\n",
            registration.plugin_id,
            registration.contribution_id,
            registration.package_digest,
            registration.activation_generation
        ));
    }
    text_sha256(&identity)
}

fn build_result(
    public_snapshot: CheckProjectSnapshotV1,
    audit: AuditResponse,
    plugin_findings: Vec<CheckFindingV1>,
    plugin_rule_packs: usize,
    plugin_rule_failures: usize,
    mut limitations: Vec<String>,
    ruleset_digest: String,
) -> Result<CheckResultV1> {
    let mut findings = audit
        .findings
        .into_iter()
        .map(finding_from_audit)
        .collect::<Result<Vec<_>>>()?;
    findings.extend(plugin_findings);
    findings.sort_by(|left, right| {
        left.rule_id
            .cmp(&right.rule_id)
            .then_with(|| left.summary.cmp(&right.summary))
    });
    limitations.extend(audit.truncation_reasons);
    let mut aggregate_truncated = false;
    if findings.len() > MAX_CHECK_RESULT_FINDINGS {
        findings.truncate(MAX_CHECK_RESULT_FINDINGS);
        aggregate_truncated = true;
        limitations.push("Check findings exceeded the aggregate result budget.".to_string());
    }
    let mut remaining_evidence = MAX_CHECK_RESULT_EVIDENCE;
    for finding in &mut findings {
        if finding.evidence.len() > remaining_evidence {
            finding.evidence.truncate(remaining_evidence);
            aggregate_truncated = true;
        }
        remaining_evidence = remaining_evidence.saturating_sub(finding.evidence.len());
    }
    if aggregate_truncated {
        limitations.push("Check evidence was truncated to its aggregate budget.".to_string());
    }
    limitations = limitations
        .into_iter()
        .map(bounded_limitation)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_CHECK_RESULT_LIMITATIONS)
        .collect();
    let incomplete = audit.truncated
        || public_snapshot.truncated
        || aggregate_truncated
        || plugin_rule_failures > 0
        || !limitations.is_empty();
    let status = if matches!(audit.status, AuditStatus::Error) {
        CheckResultStatusV1::Failed
    } else if incomplete {
        CheckResultStatusV1::Incomplete
    } else if findings.is_empty() {
        CheckResultStatusV1::Clean
    } else {
        CheckResultStatusV1::Findings
    };
    let result_truncated = audit.truncated || public_snapshot.truncated || aggregate_truncated;
    let mut result = CheckResultV1 {
        contract: CHECK_RESULT_CONTRACT.to_string(),
        result_id: CheckResultId::new(format!("check-result:{}", Uuid::new_v4().simple()))?,
        project_id: public_snapshot.project_id.clone(),
        project_revision: public_snapshot.project_revision,
        generated_at: chrono::Utc::now().to_rfc3339(),
        coverage: CheckCoverageV1 {
            files_scanned: audit.coverage.files_scanned,
            files_skipped: audit.coverage.files_skipped,
            core_rules: CHECK_CORE_RULE_COUNT,
            plugin_rule_packs,
            plugin_rule_failures,
        },
        snapshot: public_snapshot,
        ruleset_digest,
        status,
        findings,
        truncated: result_truncated,
        limitations,
    };
    while serde_json::to_vec(&result)?.len() > MAX_CHECK_RESULT_BYTES && !result.findings.is_empty()
    {
        result.findings.pop();
        result.truncated = true;
        result.status = CheckResultStatusV1::Incomplete;
        if !result
            .limitations
            .iter()
            .any(|value| value == "Check findings exceeded the encoded result budget.")
        {
            result
                .limitations
                .push("Check findings exceeded the encoded result budget.".to_string());
        }
    }
    result.validate()?;
    Ok(result)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn check_project_run(
    request: CheckRunRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CheckRunResponse, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let kernel = crate::ui_runtime::snapshot_for_state(&state)
        .await
        .map_err(display_error)?;
    if request.project_id != kernel.project.project_id
        || request.expected_project_revision != kernel.context.project_revision
        || request.expected_project_revision == 0
    {
        return Err("Check project request is stale or belongs to another project".to_string());
    }
    let dirty_paths = state
        .resource_registry
        .dirty_check_source_paths(&request.project_id);
    if !dirty_paths.is_empty() {
        return Err(format!(
            "Save modified source files before checking: {}",
            dirty_paths.join(", ")
        ));
    }

    let root = state.project_root.read().await.clone();
    let project_root = crate::normalize_project_root(root.to_string_lossy().as_ref());
    let limits = AuditLimits::default();
    let raw_snapshot = capture_current_project_audit_snapshot(&project_root, &limits);
    let public_snapshot = public_snapshot(
        &raw_snapshot,
        request.project_id.clone(),
        request.expected_project_revision,
    )
    .map_err(display_error)?;
    let audit = audit_current_project_snapshot(&raw_snapshot, &limits);

    let plugin_input_snapshot = plugin_snapshot(public_snapshot.clone());
    let mut plugin_findings = Vec::new();
    let mut plugin_failures = 0usize;
    let mut limitations = Vec::new();
    let plugin_context = match crate::commands::plugins::runtime_context(&state).await {
        Ok(context) => Some(context),
        Err(error) => {
            plugin_failures += 1;
            limitations.push(bounded_limitation(format!(
                "Workspace rule packs were unavailable: {error}."
            )));
            None
        }
    };
    let all_registrations = plugin_context
        .as_ref()
        .map(|context| state.plugin_permissions.check_rule_registrations(context))
        .unwrap_or_default();
    let registrations = all_registrations
        .iter()
        .take(MAX_CHECK_PLUGIN_RULE_PACKS)
        .cloned()
        .collect::<Vec<_>>();
    if all_registrations.len() > registrations.len() {
        plugin_failures += all_registrations.len() - registrations.len();
        limitations.push(format!(
            "Only the first {MAX_CHECK_PLUGIN_RULE_PACKS} workspace rule packs ran in this bounded Check."
        ));
    }
    let store_executor = if registrations.is_empty() {
        None
    } else {
        Some(
            crate::application_state::store_executor(&state)
                .await
                .map_err(display_error)?,
        )
    };
    for registration in &registrations {
        let Some(plugin_context) = plugin_context.as_ref() else {
            break;
        };
        let registry = state.plugin_permissions.clone();
        let plugin_context = plugin_context.clone();
        let contribution_id = registration.contribution_id.clone();
        let input = plugin_check_input(&plugin_input_snapshot);
        let invocation = crate::workspace_plugins::run_store_service(
            store_executor.expect("non-empty registrations require a Store executor"),
            move |store| {
                registry.invoke_check_rule(&plugin_context, &contribution_id, input, store)
            },
        )
        .await;
        let output = invocation
            .and_then(|value| completed_plugin_result(&value))
            .and_then(|value| CheckRulePackOutputV1::parse(value).map_err(anyhow::Error::from));
        match output {
            Ok(output) => {
                let prefix = format!("{}.", registration.contribution_id);
                let origin = SurfaceOriginV1::WorkspacePlugin {
                    plugin_id: PluginId::new(registration.plugin_id.clone())
                        .map_err(display_error)?,
                    package_digest: PackageDigest::new(registration.package_digest.clone())
                        .map_err(display_error)?,
                };
                for finding in output.findings {
                    if finding.rule_id.as_str() != registration.contribution_id
                        && !finding.rule_id.as_str().starts_with(&prefix)
                    {
                        plugin_failures += 1;
                        limitations.push(format!(
                            "Workspace rule pack {} returned an unowned rule identity.",
                            registration.contribution_id
                        ));
                        continue;
                    }
                    if let Err(error) = validate_plugin_evidence(&plugin_input_snapshot, &finding) {
                        plugin_failures += 1;
                        limitations.push(bounded_limitation(format!(
                            "Workspace rule pack {} returned invalid evidence: {error}.",
                            registration.contribution_id
                        )));
                        continue;
                    }
                    plugin_findings.push(
                        finding.bind_origin(origin.clone(), registration.activation_generation),
                    );
                }
                limitations.extend(output.limitations);
            }
            Err(error) => {
                plugin_failures += 1;
                limitations.push(bounded_limitation(format!(
                    "Workspace rule pack {} was unavailable: {error}.",
                    registration.contribution_id
                )));
            }
        }
    }
    let result = build_result(
        public_snapshot,
        audit,
        plugin_findings,
        registrations.len(),
        plugin_failures,
        limitations,
        ruleset_digest(&registrations),
    )
    .map_err(display_error)?;
    state
        .check_runtime
        .insert(result.clone())
        .map_err(display_error)?;
    let _ = app.emit(
        CHECK_RESULTS_CHANGED_EVENT,
        CheckResultsChanged {
            project_id: &result.project_id,
            result_id: &result.result_id,
            project_revision: result.project_revision,
        },
    );
    Ok(CheckRunResponse { result })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn check_result(
    request: CheckResultRequest,
    state: State<'_, AppState>,
) -> Result<CheckResultV1, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let kernel = crate::ui_runtime::snapshot_for_state(&state)
        .await
        .map_err(display_error)?;
    if request.project_id != kernel.project.project_id
        || request.expected_project_revision != kernel.context.project_revision
    {
        return Err("Check result request is stale or belongs to another project".to_string());
    }
    state
        .check_runtime
        .get(&request.project_id, &request.result_id)
        .context("Check result is unavailable; run Check project again")
        .map_err(display_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean_result(project: &str, suffix: usize) -> CheckResultV1 {
        let project_id = ProjectId::new(project).unwrap();
        let snapshot = CheckProjectSnapshotV1 {
            contract: CHECK_PROJECT_SNAPSHOT_CONTRACT.to_string(),
            snapshot_id: CheckSnapshotId::new(format!("check-snapshot:{suffix}")).unwrap(),
            project_id: project_id.clone(),
            project_revision: 1,
            captured_at: "2026-08-22T00:00:00Z".to_string(),
            files: Vec::new(),
            source_bytes: 0,
            renv_lock_sha256: None,
            truncated: false,
            limitations: Vec::new(),
        };
        CheckResultV1 {
            contract: CHECK_RESULT_CONTRACT.to_string(),
            result_id: CheckResultId::new(format!("check-result:{suffix}")).unwrap(),
            project_id,
            project_revision: 1,
            snapshot,
            ruleset_digest: "a".repeat(64),
            generated_at: "2026-08-22T00:00:01Z".to_string(),
            status: CheckResultStatusV1::Clean,
            findings: Vec::new(),
            coverage: CheckCoverageV1 {
                files_scanned: 0,
                files_skipped: 0,
                core_rules: CHECK_CORE_RULE_COUNT,
                plugin_rule_packs: 0,
                plugin_rule_failures: 0,
            },
            truncated: false,
            limitations: Vec::new(),
        }
    }

    #[test]
    fn retention_is_bounded_and_project_a_b_a_never_crosses_results() {
        let state = CheckRuntimeState::default();
        for suffix in 0..=MAX_CHECK_RESULTS_PER_PROJECT {
            state.insert(clean_result("project:a", suffix)).unwrap();
        }
        state.insert(clean_result("project:b", 100)).unwrap();
        assert!(
            state
                .get(
                    &ProjectId::new("project:a").unwrap(),
                    &CheckResultId::new("check-result:0").unwrap()
                )
                .is_none()
        );
        assert!(
            state
                .get(
                    &ProjectId::new("project:a").unwrap(),
                    &CheckResultId::new("check-result:32").unwrap()
                )
                .is_some()
        );
        assert!(
            state
                .get(
                    &ProjectId::new("project:b").unwrap(),
                    &CheckResultId::new("check-result:100").unwrap()
                )
                .is_some()
        );
        assert!(
            state
                .get(
                    &ProjectId::new("project:a").unwrap(),
                    &CheckResultId::new("check-result:100").unwrap()
                )
                .is_none()
        );
    }

    #[test]
    fn check_ipc_serialization_matches_generated_contract() {
        let mut result = clean_result("project:fixture", 7);
        result.status = CheckResultStatusV1::Findings;
        result.findings.push(CheckFindingV1 {
            rule_id: CheckRuleId::new("rho.repro.v1.randomness.rng_without_seed").unwrap(),
            rule_version: 1,
            origin: SurfaceOriginV1::Application {
                component_id: ApplicationComponentId::new("rho.check.core").unwrap(),
            },
            activation_generation: 3,
            severity: CheckSeverityV1::Warning,
            category: "randomness".to_string(),
            title: "Random result may change".to_string(),
            summary: "Random-number generation has no nearby fixed seed.".to_string(),
            remediation: "Set a deliberate seed before the analysis.".to_string(),
            evidence: vec![CheckEvidenceV1::SourceRange {
                path: "analysis.R".to_string(),
                line: 2,
                column: Some(4),
                excerpt: Some("sample(values)".to_string()),
            }],
            limitations: Vec::new(),
        });
        result.validate().unwrap();
        let run_request = CheckRunRequest {
            project_id: ProjectId::new("project:fixture").unwrap(),
            expected_project_revision: 1,
        };
        let result_request = CheckResultRequest {
            project_id: ProjectId::new("project:fixture").unwrap(),
            expected_project_revision: 1,
            result_id: result.result_id.clone(),
        };

        let response = serde_json::to_value(CheckRunResponse { result }).unwrap();
        let run_request = serde_json::to_value(run_request).unwrap();
        let result_request = serde_json::to_value(result_request).unwrap();
        assert_eq!(response["result"]["contract"], CHECK_RESULT_CONTRACT);
        assert_eq!(
            response["result"]["snapshot"]["contract"],
            CHECK_PROJECT_SNAPSHOT_CONTRACT
        );
        assert_eq!(response["result"]["findings"][0]["severity"], "warning");
        assert_eq!(
            response["result"]["findings"][0]["evidence"][0]["kind"],
            "source_range"
        );
        assert_eq!(response["result"]["findings"][0]["evidence"][0]["line"], 2);
        assert_eq!(run_request["expected_project_revision"], 1);
        assert_eq!(result_request["result_id"], "check-result:7");
    }

    #[test]
    fn plugin_descriptor_truncation_omits_nulls_and_never_exposes_source_bytes() {
        let raw = CurrentProjectAuditSnapshot {
            project_root: "/tmp/project".to_string(),
            captured_at: "2026-08-22T00:00:00Z".to_string(),
            source_files: vec![rho_store::SourceFile {
                path: "analysis.R".to_string(),
                content: "a secret source token <- 1".to_string(),
                skipped: false,
                skip_reason: None,
            }],
            renv_lock_present: false,
            renv_lock_content: None,
        };
        let public = public_snapshot(&raw, ProjectId::new("project:a").unwrap(), 1).unwrap();
        let input = plugin_check_input(&plugin_snapshot(public));
        let encoded = serde_json::to_string(&input).unwrap();
        assert!(!encoded.contains("a secret source token"));
        assert!(!encoded.contains("skip_reason"));
        assert!(!encoded.contains("renv_lock_sha256"));
        assert_eq!(input["snapshot"]["source_bytes"], 26);
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn check_typescript_export() {
        let output_path = std::env::var_os("RHO_CHECK_BINDINGS_PATH")
            .expect("RHO_CHECK_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                super::check_project_run,
                super::check_result,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Check TypeScript export must succeed");
    }
}
