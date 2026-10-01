use super::*;
use async_trait::async_trait;
use rho_files_api::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Native {
    writes: AtomicUsize,
    change: bool,
    exit: Option<i32>,
    fail_after: bool,
    changed_head: bool,
    kind: &'static str,
}
impl Default for Native {
    fn default() -> Self {
        Self {
            writes: AtomicUsize::new(0),
            change: true,
            exit: Some(0),
            fail_after: false,
            changed_head: false,
            kind: "file",
        }
    }
}
#[async_trait]
impl ProjectRuntime for Native {
    fn root(&self) -> &str {
        "/project"
    }
    async fn patch_paths(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(vec!["note.txt".into()])
    }
    async fn check_patch(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn apply_patch(&self, _: &str) -> GitApplyReport {
        self.writes.fetch_add(1, Ordering::SeqCst);
        GitApplyReport {
            exit_code: self.exit,
            diagnostic: "native diagnostic".into(),
        }
    }
    async fn snapshot(&self, paths: &[String], _: usize) -> Result<ProjectSnapshot, String> {
        let after = self.writes.load(Ordering::SeqCst) != 0;
        if after && self.fail_after {
            return Err("read after write failed".into());
        }
        Ok(ProjectSnapshot {
            root: self.root().into(),
            git: Some(GitObservation {
                repository_root: self.root().into(),
                head: Some(
                    if after && self.changed_head {
                        "other"
                    } else {
                        "original"
                    }
                    .into(),
                ),
                changes: vec![],
                truncated: false,
            }),
            files: paths
                .iter()
                .map(|path| FileObservation {
                    path: path.clone(),
                    kind: self.kind.into(),
                    sha256: (self.kind == "file").then(|| {
                        if after && self.change {
                            "after"
                        } else {
                            "before"
                        }
                        .into()
                    }),
                    byte_size: 6,
                    mode: None,
                    modified_at_ns: None,
                })
                .collect(),
            entries: vec![],
            entries_truncated: false,
            observed_at_ms: 1,
        })
    }
    async fn list_directory(&self, args: &ListDirectoryArguments) -> Result<DirectoryPage, String> {
        let entries = (0..225)
            .map(|n| DirectoryEntry {
                path: format!("note-{n:03}.txt"),
                name: format!("note-{n:03}.txt"),
                kind: "file".into(),
                byte_size: 0,
            })
            .filter(|entry| {
                args.after_name
                    .as_ref()
                    .is_none_or(|after| &entry.name > after)
            })
            .take(args.limit as usize)
            .collect::<Vec<_>>();
        Ok(DirectoryPage {
            path: args.path.clone(),
            next_name: entries.last().map(|entry| entry.name.clone()),
            entries,
            truncated: false,
            notices: vec![],
        })
    }
}
fn patch() -> ApplyPatchArguments {
    ApplyPatchArguments {
        patch: "native patch fixture".into(),
    }
}

#[tokio::test]
async fn native_preconditions_fail_before_any_effect_and_absence_means_absence() {
    for (kind, expected) in [("file", json!("stale")), ("directory", json!(null))] {
        let native = Native {
            kind,
            ..Default::default()
        };
        let result = apply_patch(
            &native,
            &patch(),
            &[FilePrecondition {
                kind: "file.sha256".into(),
                subject: "note.txt".into(),
                expected,
            }],
        )
        .await;
        let PatchFailure::BeforeEffect { message } = result.err().unwrap() else {
            panic!("wrong effect classification");
        };
        assert!(message.contains("precondition failed"));
        assert_eq!(native.writes.load(Ordering::SeqCst), 0);
    }
    let native = Native::default();
    let PatchFailure::BeforeEffect { message } = apply_patch(
        &native,
        &patch(),
        &[FilePrecondition {
            kind: "git.head".into(),
            subject: "other".into(),
            expected: json!("original"),
        }],
    )
    .await
    .err()
    .unwrap() else {
        panic!("wrong effect classification");
    };
    assert!(message.contains("unsupported"));
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn native_exit_and_observed_changes_determine_truth_without_retrying() {
    for (exit, change, changed_head, expected) in [
        (Some(0), true, false, PatchOutcome::Succeeded),
        (Some(1), false, false, PatchOutcome::Failed),
        (Some(1), true, false, PatchOutcome::Uncertain),
        (None, false, false, PatchOutcome::Uncertain),
        (Some(0), true, true, PatchOutcome::Uncertain),
    ] {
        let native = Native {
            exit,
            change,
            changed_head,
            ..Default::default()
        };
        let assessment = apply_patch(&native, &patch(), &[]).await.unwrap();
        assert_eq!(assessment.outcome, expected);
        assert_eq!(
            assessment.recovery.is_some(),
            expected == PatchOutcome::Uncertain
        );
        assert_eq!(
            assessment.error.is_some(),
            expected != PatchOutcome::Succeeded
        );
        assert_eq!(assessment.result.changed_paths.len(), usize::from(change));
        assert!(!assessment.result.committed_to_git);
        assert_eq!(native.writes.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn failed_post_write_observation_keeps_original_recovery_material() {
    let native = Native {
        fail_after: true,
        ..Default::default()
    };
    let PatchFailure::AfterPossibleEffect { recovery, .. } =
        apply_patch(&native, &patch(), &[]).await.err().unwrap()
    else {
        panic!("lost possible effect");
    };
    assert_eq!(recovery["project_root"], "/project");
    assert_eq!(recovery["affected_paths"], json!(["note.txt"]));
    assert_eq!(recovery["before"]["files"][0]["sha256"], "before");
    assert_eq!(native.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn search_pages_continue_once_and_reject_other_queries_and_projects() {
    let native = Native::default();
    let mut args: SearchFilesArguments = serde_json::from_value(json!({"text":"note"})).unwrap();
    let first = search_files(&native, &args).await.unwrap();
    assert_eq!(first.entries.len(), 200);
    assert!(first.truncated);
    args.continuation = first.continuation;
    let next = search_files(&native, &args).await.unwrap();
    assert_eq!(next.entries.len(), 25);
    assert_eq!(next.entries[0].path, "note-200.txt");
    assert!(next.continuation.is_none());
    args.text = "other".into();
    assert!(search_files(&native, &args).await.is_err());
    args.text = "note".into();
    args.continuation.as_mut().unwrap().project = "/other".into();
    assert!(search_files(&native, &args).await.is_err());
    assert_eq!(native.writes.load(Ordering::SeqCst), 0);
}
