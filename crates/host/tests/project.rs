use async_trait::async_trait;
use rho_contract::{
    CapabilityRef, Invocation, OperationStatus, Precondition, QueryRequest, QueryStatus,
};
use rho_git::GitProject;
use rho_host::NextHost;
use rho_operation::{CapabilityRegistry, OperationGateway, SystemClock, UuidOperationIdGenerator};
use rho_project::{
    GitApplyReport, ProjectOwner, ProjectPatchHandler, ProjectRuntime, ProjectSnapshot,
};
use rho_sqlite::SqliteOperationJournal;
use serde_json::{Value, json};
use std::sync::Arc;
use std::{path::Path, process::Command};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=Rho test",
            "-c",
            "user.email=rho@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}
fn repository(root: &Path) {
    std::fs::create_dir_all(root).unwrap();
    git(root, &["init", "--quiet"]);
    for (name, contents) in [
        ("analysis.R", "x <- 1\n"),
        ("staged.R", "a <- 0\n"),
        ("dirty.R", "b <- 0\n"),
    ] {
        std::fs::write(root.join(name), contents).unwrap();
    }
    git(root, &["add", "."]);
    git(root, &["commit", "--quiet", "-m", "fixture"]);
}
fn patch(path: &str, before: &str, after: &str) -> String {
    format!(
        "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-{before}\n+{after}\n"
    )
}
fn invoke(id: &str, patch: String, preconditions: Vec<Precondition>) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new("project.apply_patch", 1).unwrap(),
        arguments: json!({"patch":patch}),
        preconditions,
    }
}
async fn snapshot(host: &NextHost, paths: &[&str]) -> Value {
    let value = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("project.snapshot", 1).unwrap(),
                arguments: json!({"paths":paths}),
            },
        )
        .await
        .unwrap();
    assert_eq!(value.status, QueryStatus::Ready, "{value:?}");
    value.data.unwrap()
}

#[tokio::test]
async fn git_patch_preserves_dirty_staged_untracked_and_uses_native_preconditions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    repository(&root);
    std::fs::write(root.join("staged.R"), "a <- 10\n").unwrap();
    git(&root, &["add", "staged.R"]);
    std::fs::write(root.join("dirty.R"), "b <- 20\n").unwrap();
    std::fs::write(root.join("note.txt"), "untracked\n").unwrap();
    let index = std::fs::read(root.join(".git/index")).unwrap();
    let head = git(&root, &["rev-parse", "HEAD"]);
    let host = NextHost::open_project(dir.path().join("state/next.sqlite"), &root)
        .await
        .unwrap();
    let before = snapshot(&host, &["analysis.R"]).await;
    assert!(
        before["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry == "analysis.R")
    );
    assert_eq!(before["git"]["head"], head);
    let changes = before["git"]["changes"].as_array().unwrap();
    assert!(
        changes
            .iter()
            .any(|entry| entry["path"] == "staged.R" && entry["index_status"] == "M")
    );
    assert!(
        changes
            .iter()
            .any(|entry| entry["path"] == "dirty.R" && entry["worktree_status"] == "M")
    );
    assert!(
        changes
            .iter()
            .any(|entry| entry["path"] == "note.txt" && entry["index_status"] == "?")
    );
    let conditions = vec![
        Precondition {
            kind: "git.head".into(),
            subject: "project".into(),
            expected: json!(head),
        },
        Precondition {
            kind: "file.sha256".into(),
            subject: "analysis.R".into(),
            expected: before["files"][0]["sha256"].clone(),
        },
    ];
    let request = invoke(
        "patch-once",
        patch("analysis.R", "x <- 1", "x <- 2"),
        conditions.clone(),
    );
    let result = host
        .invoke(&NextHost::local_context(), request.clone())
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    assert_eq!(
        result.output.as_ref().unwrap()["changed_paths"],
        json!(["analysis.R"])
    );
    assert_eq!(result.output.as_ref().unwrap()["committed_to_git"], false);
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(
        std::fs::read_to_string(root.join("staged.R")).unwrap(),
        "a <- 10\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("dirty.R")).unwrap(),
        "b <- 20\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("note.txt")).unwrap(),
        "untracked\n"
    );
    assert_eq!(
        host.invoke(&NextHost::local_context(), request)
            .await
            .unwrap(),
        result
    );
    let stale = host
        .invoke(
            &NextHost::local_context(),
            invoke("stale", patch("analysis.R", "x <- 2", "x <- 3"), conditions),
        )
        .await
        .unwrap();
    assert_eq!(stale.status, OperationStatus::Failed);
    assert!(stale.error.unwrap().contains("precondition failed"));
    assert_eq!(
        std::fs::read_to_string(root.join("analysis.R")).unwrap(),
        "x <- 2\n"
    );
}

#[tokio::test]
async fn file_pages_are_exact_bounded_and_do_not_create_operations() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    repository(&root);
    let bytes = vec![255_u8, 0, 65, 66, 67, 128];
    std::fs::write(root.join("data.bin"), &bytes).unwrap();
    let host = NextHost::open_project(dir.path().join("state/next.sqlite"), &root)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let initial = snapshot(&host, &["data.bin"]).await;
    let hash = initial["files"][0]["sha256"].clone();
    let request = QueryRequest {
        capability: CapabilityRef::new("project.read_file", 1).unwrap(),
        arguments: json!({"path":"data.bin","offset":1,"limit_bytes":3,"expected_sha256":hash}),
    };
    let page = host
        .query_snapshot(&context, request.clone())
        .await
        .unwrap();
    assert_eq!(page.status, QueryStatus::Ready, "{page:?}");
    assert_eq!(page.data.as_ref().unwrap()["bytes"], json!([0, 65, 66]));
    assert_eq!(page.data.as_ref().unwrap()["has_more"], true);
    assert!(host.outbox(&context, 0, 100).await.unwrap().is_empty());
    std::fs::write(root.join("data.bin"), [1, 2, 3]).unwrap();
    let stale = host.query_snapshot(&context, request).await.unwrap();
    assert_eq!(stale.status, QueryStatus::Unavailable);
}

#[tokio::test]
async fn creates_and_deletes_files_with_explicit_absence_and_content_preconditions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    repository(&root);
    let host = NextHost::open_project(dir.path().join("state/next.sqlite"), &root)
        .await
        .unwrap();
    let create = "diff --git a/new.R b/new.R\nnew file mode 100644\n--- /dev/null\n+++ b/new.R\n@@ -0,0 +1 @@\n+answer <- 42\n";
    let result = host
        .invoke(
            &NextHost::local_context(),
            invoke(
                "create",
                create.into(),
                vec![Precondition {
                    kind: "file.sha256".into(),
                    subject: "new.R".into(),
                    expected: Value::Null,
                }],
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    let hash = snapshot(&host, &["new.R"]).await["files"][0]["sha256"].clone();
    let delete = "diff --git a/new.R b/new.R\ndeleted file mode 100644\n--- a/new.R\n+++ /dev/null\n@@ -1 +0,0 @@\n-answer <- 42\n";
    let result = host
        .invoke(
            &NextHost::local_context(),
            invoke(
                "delete",
                delete.into(),
                vec![Precondition {
                    kind: "file.sha256".into(),
                    subject: "new.R".into(),
                    expected: hash,
                }],
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    assert!(!root.join("new.R").exists());
}

#[tokio::test]
async fn rename_is_observed_for_both_paths_and_conflicting_multi_file_patch_is_not_partial() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    repository(&root);
    let host = NextHost::open_project(dir.path().join("state/next.sqlite"), &root)
        .await
        .unwrap();
    let bad = patch("analysis.R", "x <- 1", "x <- 2")
        + &patch("dirty.R", "not the original line", "changed");
    let failed = host
        .invoke(
            &NextHost::local_context(),
            invoke("conflict", bad, Vec::new()),
        )
        .await
        .unwrap();
    assert_eq!(failed.status, OperationStatus::Failed);
    assert_eq!(
        std::fs::read_to_string(root.join("analysis.R")).unwrap(),
        "x <- 1\n"
    );
    let rename = "diff --git a/analysis.R b/renamed.R\nsimilarity index 100%\nrename from analysis.R\nrename to renamed.R\n";
    let result = host
        .invoke(
            &NextHost::local_context(),
            invoke("rename", rename.into(), Vec::new()),
        )
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    assert_eq!(
        result.output.as_ref().unwrap()["changed_paths"],
        json!(["analysis.R", "renamed.R"])
    );
    assert!(!root.join("analysis.R").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("renamed.R")).unwrap(),
        "x <- 1\n"
    );
}

#[tokio::test]
async fn project_subdirectory_patches_use_project_relative_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    repository(&root);
    let subdir = root.join("sub");
    std::fs::create_dir(&subdir).unwrap();
    std::fs::write(subdir.join("space name.R"), "a\n").unwrap();
    let host = NextHost::open_project(dir.path().join("state/next.sqlite"), &subdir)
        .await
        .unwrap();
    let result = host
        .invoke(
            &NextHost::local_context(),
            invoke("subdir", patch("space name.R", "a", "b"), Vec::new()),
        )
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    assert_eq!(
        result.output.as_ref().unwrap()["changed_paths"],
        json!(["space name.R"])
    );
    assert_eq!(
        std::fs::read_to_string(subdir.join("space name.R")).unwrap(),
        "b\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("analysis.R")).unwrap(),
        "x <- 1\n"
    );
}

#[tokio::test]
async fn projectless_git_folder_and_idempotency_scope_are_truthful() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    for root in [&a, &b] {
        std::fs::create_dir(root).unwrap();
        std::fs::write(root.join("x.R"), "a\n").unwrap();
    }
    let database = dir.path().join("state/next.sqlite");
    let host = NextHost::open_project(&database, &a).await.unwrap();
    assert!(snapshot(&host, &["x.R"]).await["git"].is_null());
    let request = invoke("same", patch("x.R", "a", "b"), Vec::new());
    assert_eq!(
        host.invoke(&NextHost::local_context(), request.clone())
            .await
            .unwrap()
            .status,
        OperationStatus::Succeeded
    );
    drop(host);
    let other = NextHost::open_project(&database, &b).await.unwrap();
    assert!(
        other
            .invoke(&NextHost::local_context(), request)
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(b.join("x.R")).unwrap(), "a\n");
}

#[tokio::test]
async fn host_data_and_escape_paths_are_not_project_patch_targets() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    repository(&root);
    let host = NextHost::open_project(root.join("next.sqlite"), &root)
        .await
        .unwrap();
    let rename = "diff --git a/next.sqlite b/stolen.sqlite\nsimilarity index 100%\nrename from next.sqlite\nrename to stolen.sqlite\n";
    let result = host
        .invoke(
            &NextHost::local_context(),
            invoke("protected", rename.into(), Vec::new()),
        )
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Failed);
    assert!(!root.join("stolen.sqlite").exists());
    for path in ["../outside.R", ".git/config"] {
        let result = host
            .invoke(
                &NextHost::local_context(),
                invoke(
                    path.replace('/', "_").as_str(),
                    patch(path, "a", "b"),
                    Vec::new(),
                ),
            )
            .await
            .unwrap();
        assert_eq!(result.status, OperationStatus::Failed);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn paths_cannot_write_through_a_symlink_outside_the_project() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    repository(&root);
    let outside = dir.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("file.R"), "a\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let host = NextHost::open_project(dir.path().join("state/next.sqlite"), &root)
        .await
        .unwrap();
    let result = host
        .invoke(
            &NextHost::local_context(),
            invoke("symlink", patch("link/file.R", "a", "b"), Vec::new()),
        )
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Failed);
    assert_eq!(
        std::fs::read_to_string(outside.join("file.R")).unwrap(),
        "a\n"
    );
    std::fs::rename(&root, dir.path().join("moved-project")).unwrap();
    std::os::unix::fs::symlink(&outside, &root).unwrap();
    let changed_root = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("project.snapshot", 1).unwrap(),
                arguments: json!({"paths":["file.R"]}),
            },
        )
        .await
        .unwrap();
    assert_eq!(changed_root.status, QueryStatus::Unavailable);
    assert!(changed_root.data.is_none());
}

struct FaultInjectedGit {
    inner: GitProject,
    first_patch: String,
}
#[async_trait]
impl ProjectRuntime for FaultInjectedGit {
    fn root(&self) -> &str {
        self.inner.root()
    }
    async fn snapshot(&self, paths: &[String], limit: usize) -> Result<ProjectSnapshot, String> {
        self.inner.snapshot(paths, limit).await
    }
    async fn patch_paths(&self, patch: &str) -> Result<Vec<String>, String> {
        self.inner.patch_paths(patch).await
    }
    async fn check_patch(&self, patch: &str) -> Result<(), String> {
        self.inner.check_patch(patch).await
    }
    async fn apply_patch(&self, _: &str) -> GitApplyReport {
        // Execute a real first-file effect, then simulate losing the process result
        // before the second file was changed.
        assert_eq!(
            self.inner.apply_patch(&self.first_patch).await.exit_code,
            Some(0)
        );
        GitApplyReport {
            exit_code: None,
            diagnostic: "fault injection: process result lost after first file".into(),
        }
    }
}

#[tokio::test]
async fn partial_file_effect_with_lost_ack_is_persisted_as_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    repository(&root);
    let first = patch("analysis.R", "x <- 1", "x <- 2");
    let both = first.clone() + &patch("dirty.R", "b <- 0", "b <- 1");
    let runtime = Arc::new(FaultInjectedGit {
        inner: GitProject::open(&root, Vec::new()).unwrap(),
        first_patch: first,
    });
    let owner = Arc::new(ProjectOwner::new(
        runtime,
        Arc::new(tokio::sync::Mutex::new(())),
    ));
    let mut registry = CapabilityRegistry::new();
    registry
        .register(Arc::new(ProjectPatchHandler::new(owner)))
        .unwrap();
    let gateway = OperationGateway::new(
        Arc::new(registry),
        Arc::new(SqliteOperationJournal::open_in_memory().unwrap()),
        Arc::new(SystemClock),
        Arc::new(UuidOperationIdGenerator),
    );
    let request = invoke("partial", both, Vec::new());
    let record = gateway
        .invoke(&NextHost::local_context(), request.clone())
        .await
        .unwrap();
    assert_eq!(record.status, OperationStatus::Uncertain);
    assert!(record.recovery.is_some());
    assert_eq!(
        record.output.as_ref().unwrap()["changed_paths"],
        json!(["analysis.R"])
    );
    assert_eq!(
        std::fs::read_to_string(root.join("analysis.R")).unwrap(),
        "x <- 2\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("dirty.R")).unwrap(),
        "b <- 0\n"
    );
    assert_eq!(
        gateway
            .invoke(&NextHost::local_context(), request)
            .await
            .unwrap(),
        record
    );
}

#[tokio::test]
async fn recent_summaries_are_project_and_principal_scoped_and_paginated() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    repository(&root);
    let db = directory.path().join("state/next.sqlite");
    let host = NextHost::open_project(&db, &root).await.unwrap();
    let context = NextHost::local_context();
    for index in 0..3 {
        host.invoke(
            &context,
            invoke(
                &format!("summary-{index}"),
                patch("analysis.R", "x <- 1", "x <- 2"),
                vec![],
            ),
        )
        .await
        .unwrap();
    }
    let query = |args| QueryRequest {
        capability: CapabilityRef::new("operation.list_recent", 1).unwrap(),
        arguments: args,
    };
    let first = host
        .query_snapshot(&context, query(json!({"limit":2})))
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(first["operations"].as_array().unwrap().len(), 2);
    assert!(first["operations"][0].get("output").is_none());
    assert!(first["operations"][0].get("normalized_arguments").is_none());
    let second = host
        .query_snapshot(
            &context,
            query(json!({"limit":2,"before_cursor":first["next_cursor"]})),
        )
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(second["operations"].as_array().unwrap().len(), 1);
    let mut stranger = context.clone();
    stranger.caller.id = "another-user".into();
    assert_eq!(
        host.query_snapshot(&stranger, query(json!({})))
            .await
            .unwrap()
            .data
            .unwrap()["operations"],
        json!([])
    );
    let found = host
        .query_snapshot(&context, query(json!({"client_request_id":"summary-1"})))
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(found["operations"].as_array().unwrap().len(), 1);
    let operation_id: rho_contract::OperationId =
        serde_json::from_value(found["operations"][0]["operation_id"].clone()).unwrap();
    let exact = host
        .query_snapshot(&context, query(json!({"operation_id":operation_id})))
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(
        exact, found,
        "exact lookups retain the stable summary cursor"
    );
    assert_eq!(
        host.query_snapshot(&stranger, query(json!({"operation_id":operation_id})))
            .await
            .unwrap()
            .data
            .unwrap()["operations"],
        json!([])
    );
    assert_eq!(
        host.query_snapshot(&context, query(json!({"operation_id":"missing-operation"})))
            .await
            .unwrap()
            .data
            .unwrap()["operations"],
        json!([])
    );
    for invalid in [
        json!({"operation_id":operation_id,"client_request_id":"summary-1"}),
        json!({"operation_id":operation_id,"before_cursor":100}),
        json!({"client_request_id":"summary-1","before_cursor":100}),
        json!({"operation_id":""}),
        json!({"operation_id":"invalid id"}),
    ] {
        assert!(host.query_snapshot(&context, query(invalid)).await.is_err());
    }
    assert!(
        host.query_snapshot(&context, query(json!({"limit":101})))
            .await
            .is_err()
    );
    host.drain().await;
    drop(host);
    let other = directory.path().join("other");
    std::fs::create_dir(&other).unwrap();
    let host = NextHost::open_project(&db, other).await.unwrap();
    assert_eq!(
        host.query_snapshot(&context, query(json!({})))
            .await
            .unwrap()
            .data
            .unwrap()["operations"],
        json!([])
    );
    assert_eq!(
        host.query_snapshot(&context, query(json!({"operation_id":operation_id})))
            .await
            .unwrap()
            .data
            .unwrap()["operations"],
        json!([])
    );
    assert!(
        host.get_operation(&context, &operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(host.outbox(&context, 0, 1).await.unwrap().is_empty());
    assert_eq!(
        host.query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("operation.events_checkpoint", 1).unwrap(),
                arguments: json!({}),
            }
        )
        .await
        .unwrap()
        .data
        .unwrap(),
        json!({"sequence":0})
    );
    // Explicitly unbound CLI journal reads still resolve records across projects.
    let reader = NextHost::open_read_only(&db).unwrap();
    assert!(
        reader
            .get_operation(&context, &operation_id)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn checkpoint_closes_initialization_race_with_bounded_events_and_full_history() {
    use rho_contract::{CallerIdentity, CallerKind, HostRequest, ObservationCompleteness};
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    repository(&root);
    let host = NextHost::open_project(directory.path().join("state/next.sqlite"), &root)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let checkpoint_query = || QueryRequest {
        capability: CapabilityRef::new("operation.events_checkpoint", 1).unwrap(),
        arguments: json!({}),
    };
    let initial = host
        .query_snapshot(&context, checkpoint_query())
        .await
        .unwrap();
    assert_eq!(initial.status, QueryStatus::Ready);
    assert_eq!(initial.completeness, ObservationCompleteness::Complete);
    assert_eq!(initial.data.unwrap(), json!({"sequence":0}));
    assert_eq!(
        initial.target.identity,
        root.canonicalize().unwrap().to_str().unwrap()
    );
    assert!(
        !host
            .capabilities()
            .iter()
            .any(|item| item.capability.id == "workspace.run_r")
    );
    let mut restricted = context.clone();
    restricted.scopes.remove("operation.read");
    assert!(
        host.query_snapshot(&restricted, checkpoint_query())
            .await
            .is_err()
    );
    let mut invalid = checkpoint_query();
    invalid.arguments = json!({"project":"/other"});
    assert!(host.query_snapshot(&context, invalid).await.is_err());
    assert!(host.outbox(&context, 0, 100).await.unwrap().is_empty());

    host.invoke(
        &context,
        invoke(
            "before-checkpoint",
            patch("analysis.R", "x <- 1", "x <- 2"),
            vec![],
        ),
    )
    .await
    .unwrap();
    let baseline = host
        .dispatch(&context, HostRequest::QuerySnapshot(checkpoint_query()))
        .await
        .unwrap()["data"]["sequence"]
        .as_u64()
        .unwrap();
    let mut agent = context.clone();
    agent.principal = Some(context.caller.clone());
    agent.caller = CallerIdentity {
        kind: CallerKind::Agent,
        id: "mcp-client".into(),
    };
    let mut inserted = std::collections::BTreeSet::new();
    // These arrive from another entry point after C and before recent history.
    for index in 0..40 {
        let record = host
            .invoke(
                &agent,
                invoke(
                    &format!("startup-{index}"),
                    patch("analysis.R", "x <- 1", "x <- 2"),
                    vec![],
                ),
            )
            .await
            .unwrap();
        inserted.insert(record.operation.operation_id);
    }
    let recent_query = |arguments| QueryRequest {
        capability: CapabilityRef::new("operation.list_recent", 1).unwrap(),
        arguments,
    };
    let recent = host
        .query_snapshot(&context, recent_query(json!({})))
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(recent["operations"].as_array().unwrap().len(), 30);
    let page = host.outbox(&context, baseline, 100).await.unwrap();
    assert_eq!(page.len(), 100);
    assert_eq!(host.outbox(&context, baseline, 100).await.unwrap(), page);
    let mut events = page.clone();
    let mut cursor = page.last().unwrap().sequence;
    loop {
        let page = host.outbox(&context, cursor, 100).await.unwrap();
        if page.is_empty() {
            break;
        }
        cursor = page.last().unwrap().sequence;
        events.extend(page);
    }
    assert_eq!(
        events
            .iter()
            .map(|event| event.operation_id.clone())
            .collect::<std::collections::BTreeSet<_>>(),
        inserted
    );
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence)
    );
    assert_eq!(
        host.query_snapshot(&context, checkpoint_query())
            .await
            .unwrap()
            .data
            .unwrap()["sequence"],
        cursor
    );
    assert_eq!(
        host.query_snapshot(&agent, checkpoint_query())
            .await
            .unwrap()
            .data
            .unwrap()["sequence"],
        cursor
    );

    let mut history = recent["operations"].as_array().unwrap().clone();
    let mut next = recent["next_cursor"].clone();
    while !next.is_null() {
        let page = host
            .query_snapshot(&context, recent_query(json!({"before_cursor":next})))
            .await
            .unwrap()
            .data
            .unwrap();
        history.extend(page["operations"].as_array().unwrap().iter().cloned());
        next = page["next_cursor"].clone();
    }
    assert_eq!(history.len(), 41);
    assert!(
        history
            .windows(2)
            .all(|pair| pair[0]["cursor"].as_u64().unwrap() > pair[1]["cursor"].as_u64().unwrap())
    );
    let mut outsider = agent.clone();
    outsider.principal = Some(CallerIdentity {
        kind: CallerKind::Human,
        id: "stranger".into(),
    });
    assert_eq!(
        host.query_snapshot(&outsider, checkpoint_query())
            .await
            .unwrap()
            .data
            .unwrap(),
        json!({"sequence":0})
    );
    assert!(host.outbox(&outsider, 0, 100).await.unwrap().is_empty());
}

#[tokio::test]
async fn directory_browsing_includes_ignored_data_and_rejects_escape_paths() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    repository(&root);
    std::fs::write(root.join(".gitignore"), "data/\n").unwrap();
    std::fs::create_dir(root.join("data")).unwrap();
    std::fs::write(root.join("data/忽略的数据.csv"), "x,y\n1,2\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(directory.path(), root.join("outside")).unwrap();
    let host = NextHost::open_project(directory.path().join("state/next.sqlite"), &root)
        .await
        .unwrap();
    let query = |path: &str| QueryRequest {
        capability: CapabilityRef::new("project.list_directory", 1).unwrap(),
        arguments: json!({"path":path,"limit":1}),
    };
    let context = NextHost::local_context();
    let page = host.query_snapshot(&context, query("data")).await.unwrap();
    assert_eq!(page.status, QueryStatus::Ready);
    assert_eq!(
        page.data.unwrap()["entries"][0]["path"],
        "data/忽略的数据.csv"
    );
    assert!(
        host.query_snapshot(&context, query("../outside"))
            .await
            .is_err()
    );
    #[cfg(unix)]
    assert_eq!(
        host.query_snapshot(&context, query("outside"))
            .await
            .unwrap()
            .status,
        QueryStatus::Unavailable
    );
    let page = host
        .query_snapshot(&context, query(""))
        .await
        .unwrap()
        .data
        .unwrap();
    assert!(page["next_name"].is_string());
    assert!(host.outbox(&context, 0, 10).await.unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn database_alias_does_not_expose_the_sibling_application_store() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let real = temp.path().join("real.sqlite");
    std::fs::write(&real, []).unwrap();
    let alias = project.join("alias.sqlite");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let application =
        rho_host::ApplicationStore::open(&alias.with_extension("studio.sqlite")).unwrap();
    application
        .write(
            "user",
            &rho_contract::ApplicationState {
                key: "preferences".into(),
                version: None,
                value: json!({"private":"application state"}),
            },
        )
        .unwrap();
    drop(application);
    let host = NextHost::open_project(&alias, &project).await.unwrap();
    let read = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("project.read_file", 1).unwrap(),
                arguments: json!({"path":"alias.studio.sqlite"}),
            },
        )
        .await
        .unwrap();
    assert_eq!(read.status, QueryStatus::Unavailable);
    assert!(read.data.is_none());
}

#[tokio::test]
async fn project_search_includes_ignored_data_and_reports_result_bounds() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    std::fs::create_dir_all(project.join("data/raw")).unwrap();
    std::fs::write(project.join(".gitignore"), "data/\n").unwrap();
    for i in 0..205 {
        std::fs::write(
            project.join(format!("data/raw/sample-{i:03}.csv")),
            "x\n1\n",
        )
        .unwrap();
    }
    let host = NextHost::open_project(directory.path().join("next.sqlite"), &project)
        .await
        .unwrap();
    let result = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("project.search_files", 1).unwrap(),
                arguments: json!({"text":"sample-","show_hidden":false}),
            },
        )
        .await
        .unwrap();
    let data = result.data.unwrap();
    assert_eq!(data["entries"].as_array().unwrap().len(), 200);
    assert_eq!(data["truncated"], true);
    assert!(data["notices"][0].as_str().unwrap().contains("Page budget"));
    assert_eq!(result.next_reads.len(), 1);
    let continuation = &result.next_reads[0];
    assert_eq!(continuation.capability.id, "project.search_files");
    assert_eq!(continuation.arguments["continuation"], data["continuation"]);
    let rest = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: continuation.capability.clone(),
                arguments: continuation.arguments.clone(),
            },
        )
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(rest["entries"].as_array().unwrap().len(), 5);
    assert_eq!(rest["continuation"], serde_json::Value::Null);
    assert_eq!(rest["truncated"], false);
    let paths: std::collections::BTreeSet<_> = data["entries"]
        .as_array()
        .unwrap()
        .iter()
        .chain(rest["entries"].as_array().unwrap())
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths.len(), 205);
    assert!(
        host.outbox(&NextHost::local_context(), 0, 100)
            .await
            .unwrap()
            .is_empty()
    );
}
