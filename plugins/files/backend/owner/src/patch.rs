use rho_files_api::*;
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchOutcome { Succeeded, Failed, Uncertain }

#[derive(Debug)]
pub enum PatchFailure {
    BeforeEffect { message: String },
    AfterPossibleEffect { message: String, recovery: Value },
}
impl PatchFailure {
    fn before_effect(message: impl Into<String>) -> Self { Self::BeforeEffect { message: message.into() } }
    fn after_possible_effect(message: impl Into<String>, recovery: Value) -> Self { Self::AfterPossibleEffect { message: message.into(), recovery } }
}

pub struct PatchAssessment {
    pub result: ProjectPatchResult,
    pub outcome: PatchOutcome,
    pub error: Option<String>,
    pub recovery: Option<Value>,
}

/// Caller owns its execution lane and original Operation. A native invocation is
/// never retried here; evidence after possible effects is retained for recovery.
pub async fn apply_patch(runtime: &dyn ProjectRuntime, args: &ApplyPatchArguments, preconditions: &[FilePrecondition]) -> Result<PatchAssessment, PatchFailure> {
    validate_patch(args).map_err(PatchFailure::before_effect)?;
    let paths = runtime
        .patch_paths(&args.patch)
        .await
        .map_err(PatchFailure::before_effect)?;
    if paths.is_empty() || paths.len() > MAX_PROJECT_PATHS {
        return Err(PatchFailure::before_effect(
            "patch must affect between 1 and 64 paths",
        ));
    }
    let mut observed_paths = paths.clone();
    for condition in preconditions {
        match condition.kind.as_str() {
            "git.head" if condition.subject == "project" => {}
            "file.sha256" => {
                validate_path(&condition.subject).map_err(PatchFailure::before_effect)?;
                observed_paths.push(condition.subject.clone());
            }
            _ => {
                return Err(PatchFailure::before_effect(
                    "unsupported project precondition",
                ));
            }
        }
    }
    observed_paths.sort();
    observed_paths.dedup();
    if observed_paths.len() > MAX_PROJECT_PATHS {
        return Err(PatchFailure::before_effect(
            "preconditions exceed the file observation limit",
        ));
    }
    runtime
        .check_patch(&args.patch)
        .await
        .map_err(PatchFailure::before_effect)?;
    let before = runtime
        .snapshot(&observed_paths, 200)
        .await
        .map_err(PatchFailure::before_effect)?;
    for condition in preconditions {
        if condition.kind == "file.sha256"
            && condition.expected.is_null()
            && before
                .files
                .iter()
                .find(|file| file.path == condition.subject)
                .is_some_and(|file| file.kind != "absent")
        {
            return Err(PatchFailure::before_effect(format!(
                "precondition failed: {} must be absent",
                condition.subject
            )));
        }
        let observed = match condition.kind.as_str() {
            "git.head" => json!(before.git.as_ref().and_then(|git| git.head.as_ref())),
            _ => json!(
                before
                    .files
                    .iter()
                    .find(|file| file.path == condition.subject)
                    .and_then(|file| file.sha256.as_ref())
            ),
        };
        if observed != condition.expected {
            return Err(PatchFailure::before_effect(format!(
                "precondition failed for {}: {}",
                condition.kind, condition.subject
            )));
        }
    }
    let report = runtime.apply_patch(&args.patch).await;
    let after = runtime.snapshot(&observed_paths, 200).await.map_err(|error|
        PatchFailure::after_possible_effect(error, json!({"project_root":runtime.root(), "before":before, "affected_paths":paths})))?;
    let changed_paths = paths
        .iter()
        .filter(|path| {
            before.files.iter().find(|file| &file.path == *path)
                != after.files.iter().find(|file| &file.path == *path)
        })
        .cloned()
        .collect::<Vec<_>>();
    let git_identity_changed = before
        .git
        .as_ref()
        .map(|git| (&git.repository_root, &git.head))
        != after
            .git
            .as_ref()
            .map(|git| (&git.repository_root, &git.head));
    let outcome = if git_identity_changed {
        PatchOutcome::Uncertain
    } else if report.exit_code == Some(0) {
        PatchOutcome::Succeeded
    } else if report.exit_code.is_some() && changed_paths.is_empty() {
        PatchOutcome::Failed
    } else {
        PatchOutcome::Uncertain
    };
    let error = (outcome != PatchOutcome::Succeeded).then(|| {
        if git_identity_changed {
            "Git identity changed while the patch was applied".into()
        } else {
            report.diagnostic.clone()
        }
    });
    let result = ProjectPatchResult {
        before,
        after,
        affected_paths: paths,
        changed_paths,
        git_exit_code: report.exit_code,
        diagnostic: report.diagnostic,
        committed_to_git: false,
    };
    let recovery = (outcome == PatchOutcome::Uncertain).then(||
        json!({"action":"query_project_snapshot_before_retry", "root":runtime.root(), "affected_paths":result.affected_paths}));
    Ok(PatchAssessment { result, outcome, error, recovery })
}
