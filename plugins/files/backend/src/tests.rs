use crate::{manifest::manifest, owner::Owner};
use rho_plugin_sdk::protocol::*;
use serde_json::{Value, json};
use std::fs;
use tokio::sync::watch;

fn identity() -> InstanceRef {
    serde_json::from_value(json!({"instance":"files-one","plugin":"org.rho.files","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))})).unwrap()
}
fn call(capability: &str, arguments: Value, root: &str, operation: Option<&str>) -> PluginCall {
    PluginCall {
        request: RequestId::new(format!("request-{}", operation.unwrap_or("read"))).unwrap(),
        binding: ProviderBinding {
            capability: CapabilityKey {
                id: ContributionId::new(capability).unwrap(),
                version: 1,
            },
            provider: identity(),
            project: ProjectId::new("project-one").unwrap(),
            target: Some(root.into()),
        },
        principal: PrincipalId::new("principal-one").unwrap(),
        scopes: ["project.read".into(), "project.write".into()].into(),
        arguments,
        preconditions: Value::Null,
        owner_context: if operation.is_some() {
            json!({"project_root":root})
        } else {
            Value::Null
        },
        operation_id: operation.map(Into::into),
    }
}
fn fixture() -> (tempfile::TempDir, Owner, String) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp
        .path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let owner = Owner::new(
        BackendEnvironment {
            project_root: root.clone(),
            data_root: root.clone(),
        },
        json!({}),
    )
    .unwrap();
    owner.bind_paths(&json!({"status":"ready","completeness":"complete","data":{"project_root":root,"protected_paths":[format!("{root}/private.sqlite"),format!("{root}/future.sqlite-wal")]}})).unwrap();
    (temp, owner, root)
}

#[test]
fn manifest_routes_match_exact_message_kinds_and_versions() {
    let manifest = manifest();
    manifest.validate().unwrap();
    assert_eq!(manifest.capabilities.len(), 9);
    for contribution in manifest.capabilities {
        let query = contribution.kind == CapabilityKind::Query;
        assert!(crate::owner::supported(&contribution.capability, query));
        assert!(!crate::owner::supported(&contribution.capability, !query));
        let mut changed = contribution.capability;
        changed.version = 2;
        assert!(!crate::owner::supported(&changed, query));
    }
}

#[tokio::test]
async fn trusted_paths_scopes_and_typed_text_observations() {
    let (_temp, owner, root) = fixture();
    fs::write(format!("{root}/private.sqlite"), "secret").unwrap();
    fs::write(format!("{root}/future.sqlite-wal"), "future secret").unwrap();
    fs::write(format!("{root}/分析.R"), "中文\r\nsecond\n").unwrap();
    let listing = owner
        .query(&call("files.list_directory", json!({}), &root, None))
        .await
        .unwrap()
        .0;
    assert_eq!(listing["entries"].as_array().unwrap().len(), 1);
    for name in ["private.sqlite", "future.sqlite-wal", "../escape"] {
        assert!(
            owner
                .query(&call("files.read_file", json!({"path":name}), &root, None))
                .await
                .is_err()
        );
    }
    let mut denied = call("files.list_directory", json!({}), &root, None);
    denied.scopes.clear();
    assert_eq!(
        owner.query(&denied).await.unwrap_err().code,
        "access_denied"
    );
    let original = owner
        .query(&call(
            "files.read_text",
            json!({"path":"分析.R","limit_lines":1}),
            &root,
            None,
        ))
        .await
        .unwrap()
        .0;
    assert_eq!(original["fragments"][0]["text"], "中文\r\n");
    fs::write(format!("{root}/分析.R"), "changed\n").unwrap();
    let changed = owner
        .query(&call(
            "files.read_text",
            json!({"path":"分析.R","expected_sha256":original["file"]["sha256"]}),
            &root,
            None,
        ))
        .await
        .unwrap_err();
    assert_eq!(changed.code, "content_changed");
    assert!(owner.bind_paths(&json!({"status":"ready","completeness":"complete","data":{"project_root":root,"protected_paths":[]}})).is_err());
    assert!(
        Owner::new(
            BackendEnvironment {
                project_root: root.clone(),
                data_root: root
            },
            json!({"protected_paths":[]})
        )
        .is_err()
    );
}

#[tokio::test]
async fn original_settlement_holds_the_lane_and_pending_cancellation_does_not_write() {
    let (_temp, owner, root) = fixture();
    fs::write(format!("{root}/note.txt"), "before\n").unwrap();
    let patch = "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\n";
    let snapshot = owner
        .query(&call(
            "files.snapshot",
            json!({"paths":["note.txt"]}),
            &root,
            None,
        ))
        .await
        .unwrap()
        .0;
    let mut original = call(
        "files.apply_patch",
        json!({"patch":patch}),
        &root,
        Some("original"),
    );
    original.preconditions = json!([{"kind":"file.sha256","subject":"note.txt","expected":snapshot["files"][0]["sha256"]}]);
    let prepared = owner.query(&call("files.prepare_patch", json!({"capability":original.binding.capability,"arguments":original.arguments,"target":null,"preconditions":original.preconditions}), &root, None)).await.unwrap();
    assert_eq!(prepared.1, ObservationCompleteness::Complete);
    assert_eq!(prepared.0["target"], root);
    owner.admit(&original).unwrap();
    assert!(owner.admit(&original).is_err());
    let result = owner.invoke(&original, watch::channel(false).1).await;
    assert_eq!(result.outcome, PluginOutcome::Succeeded);
    assert_eq!(
        fs::read_to_string(format!("{root}/note.txt")).unwrap(),
        "after\n"
    );
    assert!(!owner.ready_to_release());
    assert_eq!(
        owner
            .query(&call("files.snapshot", json!({}), &root, None))
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    let pending = call(
        "files.apply_patch",
        json!({"patch":patch}),
        &root,
        Some("pending"),
    );
    owner.admit(&pending).unwrap();
    let cancelled = owner.invoke(&pending, watch::channel(true).1).await;
    assert_eq!(cancelled.outcome, PluginOutcome::Cancelled);
    assert!(cancelled.cancellation_confirmed);
    let mut settlement = OperationSettlement {
        operation_id: OperationId::new("original").unwrap(),
        binding: original.binding.clone(),
        outcome: PluginOutcome::Succeeded,
    };
    settlement.binding.target = Some("/another".into());
    assert!(owner.settle(&settlement).is_err());
    settlement.binding = original.binding.clone();
    owner.settle(&settlement).unwrap();
    owner.settle(&settlement).unwrap();
    let mut cancelled_settlement = OperationSettlement {
        operation_id: OperationId::new("pending").unwrap(),
        binding: pending.binding,
        outcome: PluginOutcome::Succeeded,
    };
    assert!(owner.settle(&cancelled_settlement).is_err());
    cancelled_settlement.outcome = PluginOutcome::Cancelled;
    owner.settle(&cancelled_settlement).unwrap();
    assert!(owner.ready_to_release());
    // A stale content expectation is an original failed result, not another write.
    let mut stale = original;
    stale.operation_id = Some("stale".into());
    stale.arguments = json!({"patch":"diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-after\n+must-not-write\n"});
    owner.admit(&stale).unwrap();
    assert_eq!(
        owner.invoke(&stale, watch::channel(false).1).await.outcome,
        PluginOutcome::Failed
    );
    assert_eq!(
        fs::read_to_string(format!("{root}/note.txt")).unwrap(),
        "after\n"
    );
    owner
        .settle(&OperationSettlement {
            operation_id: OperationId::new("stale").unwrap(),
            binding: stale.binding,
            outcome: PluginOutcome::Failed,
        })
        .unwrap();
    assert!(owner.ready_to_release());
}
