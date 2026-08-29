use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::artifact::ArtifactRecordSummary;
use crate::environment::EnvironmentSnapshotRecord;
use crate::run::{ProblemSummary, RunDetail};

/// Per-field comparison state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompareField {
    Same,
    Different,
    LeftOnly,
    RightOnly,
    Unknown,
    NotApplicable,
}

/// One compared field in a section
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareFieldEntry {
    pub field: String,
    pub state: CompareField,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limitation: Option<String>,
}

/// One comparison section
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareSection {
    pub id: String,
    pub label: String,
    pub fields: Vec<CompareFieldEntry>,
}

/// Summary counts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareSummary {
    pub same: usize,
    pub different: usize,
    pub unknown: usize,
    pub limitations: usize,
}

/// Top-level response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareRunsResponse {
    pub schema_version: u32,
    pub project_root: String,
    pub generated_at: String,
    pub left_run_id: String,
    pub right_run_id: String,
    pub summary: CompareSummary,
    pub sections: Vec<CompareSection>,
    pub truncated: bool,
    pub truncation_reasons: Vec<String>,
}

fn compare_string(a: &str, b: &str) -> CompareField {
    if a == b {
        CompareField::Same
    } else {
        CompareField::Different
    }
}

fn compare_opt_string(a: &Option<String>, b: &Option<String>) -> CompareField {
    match (a, b) {
        (None, None) => CompareField::Unknown,
        (Some(_), None) => CompareField::LeftOnly,
        (None, Some(_)) => CompareField::RightOnly,
        (Some(la), Some(lb)) if la == lb => CompareField::Same,
        (Some(_), Some(_)) => CompareField::Different,
    }
}

fn compare_opt_i64(a: &Option<i64>, b: &Option<i64>) -> CompareField {
    match (a, b) {
        (None, None) => CompareField::Unknown,
        (Some(_), None) => CompareField::LeftOnly,
        (None, Some(_)) => CompareField::RightOnly,
        (Some(la), Some(lb)) if la == lb => CompareField::Same,
        (Some(_), Some(_)) => CompareField::Different,
    }
}

fn opt_string_value(v: &Option<String>) -> Option<String> {
    v.clone()
}

fn opt_i64_value(v: &Option<i64>) -> Option<String> {
    v.map(|n| n.to_string())
}

fn field(
    name: &str,
    state: CompareField,
    left: Option<String>,
    right: Option<String>,
) -> CompareFieldEntry {
    CompareFieldEntry {
        field: name.to_string(),
        state,
        left_value: left,
        right_value: right,
        limitation: None,
    }
}

fn field_limited(
    name: &str,
    state: CompareField,
    left: Option<String>,
    right: Option<String>,
    limitation: &str,
) -> CompareFieldEntry {
    CompareFieldEntry {
        field: name.to_string(),
        state,
        left_value: left,
        right_value: right,
        limitation: Some(limitation.to_string()),
    }
}

impl CompareRunsResponse {
    #[allow(clippy::too_many_arguments)]
    pub fn compute(
        project_root: String,
        left: &RunDetail,
        right: &RunDetail,
        left_problems: &[ProblemSummary],
        right_problems: &[ProblemSummary],
        left_snapshot: &Option<EnvironmentSnapshotRecord>,
        right_snapshot: &Option<EnvironmentSnapshotRecord>,
        left_artifacts: &[ArtifactRecordSummary],
        right_artifacts: &[ArtifactRecordSummary],
    ) -> Self {
        let sections = vec![
            compare_identity(left, right),
            compare_source(left, right),
            compare_environment(left, right, left_snapshot, right_snapshot),
            compare_outcome(left, right, left_problems, right_problems),
            compare_artifacts(left_artifacts, right_artifacts),
        ];

        let mut summary = CompareSummary {
            same: 0,
            different: 0,
            unknown: 0,
            limitations: 0,
        };
        for section in &sections {
            for f in &section.fields {
                match f.state {
                    CompareField::Same => summary.same += 1,
                    CompareField::Different => summary.different += 1,
                    CompareField::Unknown => summary.unknown += 1,
                    _ => {}
                }
                if f.limitation.is_some() {
                    summary.limitations += 1;
                }
            }
        }

        CompareRunsResponse {
            schema_version: 1,
            project_root,
            generated_at: chrono::Utc::now().to_rfc3339(),
            left_run_id: left.run_id.clone(),
            right_run_id: right.run_id.clone(),
            summary,
            sections,
            truncated: false,
            truncation_reasons: vec![],
        }
    }
}

fn compute_duration(started: &str, finished: &Option<String>) -> Option<i64> {
    let start = chrono::DateTime::parse_from_rfc3339(started).ok()?;
    let end = if let Some(f) = finished {
        chrono::DateTime::parse_from_rfc3339(f).ok()?
    } else {
        return None;
    };
    Some((end - start).num_milliseconds())
}

fn sha256_hex(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ── Section builders ──

fn compare_identity(left: &RunDetail, right: &RunDetail) -> CompareSection {
    let mut fields = vec![
        field(
            "parent_run_id",
            compare_opt_string(&left.parent_run_id, &right.parent_run_id),
            opt_string_value(&left.parent_run_id),
            opt_string_value(&right.parent_run_id),
        ),
        field(
            "origin",
            compare_string(&left.origin, &right.origin),
            Some(left.origin.clone()),
            Some(right.origin.clone()),
        ),
        field(
            "request_type",
            compare_string(&left.request_type, &right.request_type),
            Some(left.request_type.clone()),
            Some(right.request_type.clone()),
        ),
        field(
            "operation_class",
            compare_string(&left.operation_class, &right.operation_class),
            Some(left.operation_class.clone()),
            Some(right.operation_class.clone()),
        ),
        field(
            "status",
            compare_string(&left.status, &right.status),
            Some(left.status.clone()),
            Some(right.status.clone()),
        ),
        field(
            "terminal_reason",
            compare_opt_string(&left.terminal_reason, &right.terminal_reason),
            opt_string_value(&left.terminal_reason),
            opt_string_value(&right.terminal_reason),
        ),
    ];

    let left_dur = compute_duration(&left.started_at, &left.finished_at).map(|ms| ms.to_string());
    let right_dur =
        compute_duration(&right.started_at, &right.finished_at).map(|ms| ms.to_string());
    fields.push(field(
        "duration_ms",
        CompareField::NotApplicable,
        left_dur,
        right_dur,
    ));

    for (name, lv, rv, state) in [
        (
            "workspace_id",
            opt_string_value(&left.workspace_id),
            opt_string_value(&right.workspace_id),
            compare_opt_string(&left.workspace_id, &right.workspace_id),
        ),
        (
            "state_revision_before",
            opt_i64_value(&left.state_revision_before),
            opt_i64_value(&right.state_revision_before),
            compare_opt_i64(&left.state_revision_before, &right.state_revision_before),
        ),
        (
            "project_revision_before",
            opt_i64_value(&left.project_revision_before),
            opt_i64_value(&right.project_revision_before),
            compare_opt_i64(
                &left.project_revision_before,
                &right.project_revision_before,
            ),
        ),
        (
            "state_revision_after",
            opt_i64_value(&left.state_revision_after),
            opt_i64_value(&right.state_revision_after),
            compare_opt_i64(&left.state_revision_after, &right.state_revision_after),
        ),
        (
            "project_revision_after",
            opt_i64_value(&left.project_revision_after),
            opt_i64_value(&right.project_revision_after),
            compare_opt_i64(&left.project_revision_after, &right.project_revision_after),
        ),
    ] {
        fields.push(field(name, state, lv, rv));
    }

    CompareSection {
        id: "identity".to_string(),
        label: "Identity & Execution".to_string(),
        fields,
    }
}

fn compare_source(left: &RunDetail, right: &RunDetail) -> CompareSection {
    let left_digest = sha256_hex(&left.code);
    let right_digest = sha256_hex(&right.code);

    CompareSection {
        id: "source".to_string(),
        label: "Source & Request".to_string(),
        fields: vec![
            field(
                "source_path",
                compare_opt_string(&left.source_path, &right.source_path),
                opt_string_value(&left.source_path),
                opt_string_value(&right.source_path),
            ),
            field(
                "execution_mode",
                compare_opt_string(&left.execution_mode, &right.execution_mode),
                opt_string_value(&left.execution_mode),
                opt_string_value(&right.execution_mode),
            ),
            field(
                "document_version",
                compare_opt_i64(&left.document_version, &right.document_version),
                opt_i64_value(&left.document_version),
                opt_i64_value(&right.document_version),
            ),
            field(
                "code_digest",
                compare_string(&left_digest, &right_digest),
                Some(left_digest),
                Some(right_digest),
            ),
            field(
                "code_length",
                CompareField::NotApplicable,
                Some(left.code.len().to_string()),
                Some(right.code.len().to_string()),
            ),
            field(
                "arguments_json",
                if left.arguments_json == right.arguments_json {
                    CompareField::Same
                } else {
                    CompareField::Different
                },
                Some(left.arguments_json.clone()),
                Some(right.arguments_json.clone()),
            ),
        ],
    }
}

fn compare_environment(
    left: &RunDetail,
    right: &RunDetail,
    left_snapshot: &Option<EnvironmentSnapshotRecord>,
    right_snapshot: &Option<EnvironmentSnapshotRecord>,
) -> CompareSection {
    let mut fields = Vec::new();

    let left_available = left_snapshot.is_some();
    let right_available = right_snapshot.is_some();

    fields.push(field(
        "snapshot_available",
        if left_available && right_available {
            CompareField::Same
        } else if left_available {
            CompareField::LeftOnly
        } else if right_available {
            CompareField::RightOnly
        } else {
            CompareField::Unknown
        },
        Some(left_available.to_string()),
        Some(right_available.to_string()),
    ));

    fields.push(field(
        "snapshot_id",
        compare_opt_string(
            &left.environment_snapshot_id,
            &right.environment_snapshot_id,
        ),
        opt_string_value(&left.environment_snapshot_id),
        opt_string_value(&right.environment_snapshot_id),
    ));

    // Parse canonical JSON from both snapshots for deeper comparison
    match (left_snapshot, right_snapshot) {
        (Some(ls), Some(rs)) => {
            let left_json: Result<serde_json::Value, _> = serde_json::from_str(&ls.canonical_json);
            let right_json: Result<serde_json::Value, _> = serde_json::from_str(&rs.canonical_json);

            match (left_json, right_json) {
                (Ok(lj), Ok(rj)) => {
                    // R version
                    let lr = lj
                        .get("R")
                        .and_then(|v| v.get("version"))
                        .and_then(|v| v.as_str());
                    let rr = rj
                        .get("R")
                        .and_then(|v| v.get("version"))
                        .and_then(|v| v.as_str());
                    fields.push(field(
                        "r_version",
                        compare_opt_string(&lr.map(String::from), &rr.map(String::from)),
                        lr.map(String::from),
                        rr.map(String::from),
                    ));

                    // R platform
                    let lp = lj
                        .get("R")
                        .and_then(|v| v.get("platform"))
                        .and_then(|v| v.as_str());
                    let rp = rj
                        .get("R")
                        .and_then(|v| v.get("platform"))
                        .and_then(|v| v.as_str());
                    fields.push(field(
                        "r_platform",
                        compare_opt_string(&lp.map(String::from), &rp.map(String::from)),
                        lp.map(String::from),
                        rp.map(String::from),
                    ));

                    // Package comparison
                    let left_pkgs = extract_packages(&lj);
                    let right_pkgs = extract_packages(&rj);
                    let pkg_diff = diff_packages(&left_pkgs, &right_pkgs);

                    fields.push(field(
                        "package_count_left",
                        CompareField::NotApplicable,
                        Some(left_pkgs.len().to_string()),
                        None,
                    ));
                    fields.push(field(
                        "package_count_right",
                        CompareField::NotApplicable,
                        None,
                        Some(right_pkgs.len().to_string()),
                    ));
                    fields.push(field(
                        "package_diff",
                        if pkg_diff.is_empty() {
                            CompareField::Same
                        } else {
                            CompareField::Different
                        },
                        Some(serde_json::to_string(&pkg_diff).unwrap_or_default()),
                        None,
                    ));
                }
                _ => {
                    fields.push(field_limited(
                        "environment_details",
                        CompareField::Unknown,
                        None,
                        None,
                        "snapshot_parse_error",
                    ));
                }
            }
        }
        _ => {
            fields.push(field_limited(
                "environment_details",
                CompareField::Unknown,
                None,
                None,
                "one_or_both_snapshots_unavailable",
            ));
        }
    }

    CompareSection {
        id: "environment".to_string(),
        label: "Environment".to_string(),
        fields,
    }
}

fn extract_packages(snapshot: &serde_json::Value) -> Vec<(String, String)> {
    let mut pkgs = Vec::new();
    if let Some(installed) = snapshot
        .get("installed_packages")
        .and_then(|v| v.as_array())
    {
        for pkg in installed.iter().take(200) {
            let name = pkg
                .get("Package")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            let version = pkg
                .get("Version")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            pkgs.push((name, version));
        }
    }
    pkgs.sort_by(|a, b| a.0.cmp(&b.0));
    pkgs
}

fn diff_packages(left: &[(String, String)], right: &[(String, String)]) -> Vec<serde_json::Value> {
    let left_map: std::collections::BTreeMap<&str, &str> =
        left.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect();
    let right_map: std::collections::BTreeMap<&str, &str> = right
        .iter()
        .map(|(n, v)| (n.as_str(), v.as_str()))
        .collect();

    let mut diffs = Vec::new();

    for (name, left_ver) in &left_map {
        match right_map.get(name) {
            None => {
                diffs.push(serde_json::json!({
                    "package": name,
                    "change": "removed",
                    "left_version": left_ver,
                    "right_version": null
                }));
            }
            Some(right_ver) if left_ver != right_ver => {
                diffs.push(serde_json::json!({
                    "package": name,
                    "change": "version_changed",
                    "left_version": left_ver,
                    "right_version": right_ver
                }));
            }
            _ => {}
        }
    }

    for (name, right_ver) in &right_map {
        if !left_map.contains_key(name) {
            diffs.push(serde_json::json!({
                "package": name,
                "change": "added",
                "left_version": null,
                "right_version": right_ver
            }));
        }
    }

    diffs.truncate(200);
    diffs
}

fn compare_outcome(
    left: &RunDetail,
    right: &RunDetail,
    left_problems: &[ProblemSummary],
    right_problems: &[ProblemSummary],
) -> CompareSection {
    let left_stdout_digest = left.stdout.as_ref().map(|s| sha256_hex(s));
    let right_stdout_digest = right.stdout.as_ref().map(|s| sha256_hex(s));

    let left_tb = left.traceback.join("\n");
    let right_tb = right.traceback.join("\n");
    let traceback_state = if left_tb.is_empty() && right_tb.is_empty() {
        CompareField::Unknown
    } else if left_tb == right_tb {
        CompareField::Same
    } else {
        CompareField::Different
    };

    // Problem alignment by message
    let left_msgs: std::collections::BTreeSet<&str> =
        left_problems.iter().map(|p| p.message.as_str()).collect();
    let right_msgs: std::collections::BTreeSet<&str> =
        right_problems.iter().map(|p| p.message.as_str()).collect();
    let matched: Vec<_> = left_msgs.intersection(&right_msgs).collect();
    let left_only_count = left_msgs.len() - matched.len();
    let right_only_count = right_msgs.len() - matched.len();

    CompareSection {
        id: "outcome".to_string(),
        label: "Outcome & Problems".to_string(),
        fields: vec![
            field(
                "error_message",
                compare_opt_string(&left.error_message, &right.error_message),
                opt_string_value(&left.error_message),
                opt_string_value(&right.error_message),
            ),
            field(
                "error_call",
                compare_opt_string(&left.error_call, &right.error_call),
                opt_string_value(&left.error_call),
                opt_string_value(&right.error_call),
            ),
            field(
                "message_count",
                CompareField::NotApplicable,
                Some(left.messages.len().to_string()),
                Some(right.messages.len().to_string()),
            ),
            field(
                "warning_count",
                CompareField::NotApplicable,
                Some(left.warnings.len().to_string()),
                Some(right.warnings.len().to_string()),
            ),
            field(
                "traceback_matched",
                traceback_state,
                Some(left_tb.chars().take(512).collect()),
                Some(right_tb.chars().take(512).collect()),
            ),
            field(
                "stdout_digest",
                compare_opt_string(&left_stdout_digest, &right_stdout_digest),
                left_stdout_digest,
                right_stdout_digest,
            ),
            field(
                "problem_count",
                CompareField::NotApplicable,
                Some(left_problems.len().to_string()),
                Some(right_problems.len().to_string()),
            ),
            field(
                "problems_matched",
                if matched.is_empty() && left_only_count == 0 && right_only_count == 0 {
                    CompareField::Unknown
                } else if left_only_count == 0 && right_only_count == 0 {
                    CompareField::Same
                } else {
                    CompareField::Different
                },
                Some(left_only_count.to_string()),
                Some(right_only_count.to_string()),
            ),
        ],
    }
}

fn compare_artifacts(
    left_artifacts: &[ArtifactRecordSummary],
    right_artifacts: &[ArtifactRecordSummary],
) -> CompareSection {
    let left_paths: std::collections::BTreeSet<&str> = left_artifacts
        .iter()
        .map(|a| a.output_path.as_str())
        .collect();
    let right_paths: std::collections::BTreeSet<&str> = right_artifacts
        .iter()
        .map(|a| a.output_path.as_str())
        .collect();

    let shared: Vec<_> = left_paths.intersection(&right_paths).collect();
    let left_only: Vec<_> = left_paths.difference(&right_paths).collect();
    let right_only: Vec<_> = right_paths.difference(&left_paths).collect();

    let shared_count = shared.len();
    let left_only_count = left_only.len();
    let right_only_count = right_only.len();

    let artifact_state = if left_only_count == 0 && right_only_count == 0 && shared_count > 0 {
        CompareField::Same
    } else if shared_count > 0 || left_only_count > 0 || right_only_count > 0 {
        CompareField::Different
    } else {
        CompareField::Unknown
    };

    CompareSection {
        id: "artifacts".to_string(),
        label: "Artifacts".to_string(),
        fields: vec![
            field(
                "artifact_count",
                CompareField::NotApplicable,
                Some(left_artifacts.len().to_string()),
                Some(right_artifacts.len().to_string()),
            ),
            field(
                "artifacts_comparison",
                artifact_state,
                Some(format!(
                    "left_only: {}, right_only: {}, shared: {}",
                    left_only_count, right_only_count, shared_count
                )),
                None,
            ),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::RunDetail;

    fn make_run(
        run_id: &str,
        project_root: &str,
        status: &str,
        source_path: &str,
        code: &str,
    ) -> RunDetail {
        RunDetail {
            run_id: run_id.to_string(),
            parent_run_id: None,
            project_root: project_root.to_string(),
            origin: "user".to_string(),
            status: status.to_string(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            finished_at: Some("2026-01-01T00:01:00Z".to_string()),
            terminal_reason: if status == "failed" {
                Some("r_error".to_string())
            } else {
                None
            },
            request_type: "workspace.execute".to_string(),
            operation_class: "scientific".to_string(),
            code: code.to_string(),
            arguments_json: r#"{"code":"test"}"#.to_string(),
            source_path: Some(source_path.to_string()),
            execution_mode: Some("selection".to_string()),
            document_version: Some(1),
            workspace_id: Some("ws_1".to_string()),
            state_revision_before: Some(1),
            project_revision_before: Some(0),
            state_revision_after: Some(2),
            project_revision_after: Some(0),
            environment_snapshot_id: Some("snap_a".to_string()),
            environment_snapshot_id_after: None,
            stdout: Some("output".to_string()),
            value_text: None,
            messages: vec![],
            warnings: vec![],
            error_message: if status == "failed" {
                Some("boom".to_string())
            } else {
                None
            },
            error_call: None,
            traceback: if status == "failed" {
                vec!["error line".to_string()]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn compute_identical_runs_all_same() {
        let left = make_run("run_a", "D:/proj", "completed", "script.R", "1+1");
        let right = make_run("run_a", "D:/proj", "completed", "script.R", "1+1");
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        assert_eq!(resp.sections.len(), 5);
        let id_section = &resp.sections[0];
        let status_field = id_section
            .fields
            .iter()
            .find(|f| f.field == "status")
            .unwrap();
        assert_eq!(status_field.state, CompareField::Same);
    }

    #[test]
    fn compute_different_status() {
        let left = make_run("run_a", "D:/proj", "completed", "script.R", "1+1");
        let right = make_run("run_b", "D:/proj", "failed", "script.R", "1+1");
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        let id_section = &resp.sections[0];
        let status_field = id_section
            .fields
            .iter()
            .find(|f| f.field == "status")
            .unwrap();
        assert_eq!(status_field.state, CompareField::Different);
    }

    #[test]
    fn compute_different_source_paths() {
        let left = make_run("run_a", "D:/proj", "completed", "a.R", "1+1");
        let right = make_run("run_b", "D:/proj", "completed", "b.R", "1+1");
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        let src_section = &resp.sections[1];
        let path_field = src_section
            .fields
            .iter()
            .find(|f| f.field == "source_path")
            .unwrap();
        assert_eq!(path_field.state, CompareField::Different);
    }

    #[test]
    fn compute_different_code_digest() {
        let left = make_run("run_a", "D:/proj", "completed", "a.R", "1+1");
        let right = make_run("run_b", "D:/proj", "completed", "a.R", "2+2");
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        let src_section = &resp.sections[1];
        let digest_field = src_section
            .fields
            .iter()
            .find(|f| f.field == "code_digest")
            .unwrap();
        assert_eq!(digest_field.state, CompareField::Different);
    }

    #[test]
    fn compute_null_fields_as_unknown() {
        let mut left = make_run("run_a", "D:/proj", "completed", "a.R", "1+1");
        left.source_path = None;
        left.environment_snapshot_id = None;
        let mut right = make_run("run_b", "D:/proj", "completed", "a.R", "1+1");
        right.source_path = None;
        right.environment_snapshot_id = None;
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        let src_section = &resp.sections[1];
        let path_field = src_section
            .fields
            .iter()
            .find(|f| f.field == "source_path")
            .unwrap();
        assert_eq!(path_field.state, CompareField::Unknown);
    }

    #[test]
    fn compare_different_error_messages() {
        let mut left = make_run("run_a", "D:/proj", "failed", "a.R", "1+1");
        left.error_message = Some("err_a".to_string());
        left.traceback = vec!["line 1".to_string()];
        let mut right = make_run("run_b", "D:/proj", "failed", "a.R", "1+1");
        right.error_message = Some("err_b".to_string());
        right.traceback = vec!["line 2".to_string()];
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        let out_section = &resp.sections[3];
        let err_field = out_section
            .fields
            .iter()
            .find(|f| f.field == "error_message")
            .unwrap();
        assert_eq!(err_field.state, CompareField::Different);
    }

    #[test]
    fn response_is_deterministic() {
        let left = make_run("run_a", "D:/proj", "completed", "a.R", "1+1");
        let right = make_run("run_b", "D:/proj", "completed", "a.R", "1+1");
        let resp1 = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        let resp2 = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        assert_eq!(resp1.summary.same, resp2.summary.same);
        assert_eq!(resp1.summary.different, resp2.summary.different);
        assert_eq!(resp1.summary.unknown, resp2.summary.unknown);
        assert_eq!(resp1.sections.len(), resp2.sections.len());
    }

    #[test]
    fn response_includes_all_five_sections() {
        let left = make_run("run_a", "D:/proj", "completed", "a.R", "1+1");
        let right = make_run("run_b", "D:/proj", "completed", "a.R", "1+1");
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        let ids: Vec<&str> = resp.sections.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["identity", "source", "environment", "outcome", "artifacts"]
        );
    }

    #[test]
    fn summary_counts_match_field_states() {
        let left = make_run("run_a", "D:/proj", "completed", "a.R", "1+1");
        let right = make_run("run_b", "D:/proj", "completed", "a.R", "1+1");
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        let mut actual_same = 0usize;
        let mut actual_diff = 0usize;
        let mut actual_unknown = 0usize;
        for s in &resp.sections {
            for f in &s.fields {
                match f.state {
                    CompareField::Same => actual_same += 1,
                    CompareField::Different => actual_diff += 1,
                    CompareField::Unknown => actual_unknown += 1,
                    _ => {}
                }
            }
        }
        assert_eq!(resp.summary.same, actual_same);
        assert_eq!(resp.summary.different, actual_diff);
        assert_eq!(resp.summary.unknown, actual_unknown);
    }

    #[test]
    fn schema_version_is_one() {
        let left = make_run("run_a", "D:/proj", "completed", "a.R", "1+1");
        let right = make_run("run_b", "D:/proj", "completed", "a.R", "1+1");
        let resp = CompareRunsResponse::compute(
            "D:/proj".into(),
            &left,
            &right,
            &[],
            &[],
            &None,
            &None,
            &[],
            &[],
        );
        assert_eq!(resp.schema_version, 1);
    }
}
