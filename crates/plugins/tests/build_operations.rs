#![cfg(unix)]
use rho_contract as host;
use rho_operation::{CapabilityRegistry, OperationGateway, SystemClock, UuidOperationIdGenerator};
use rho_plugin_protocol::*;
use rho_plugins::*;
use rho_sqlite::SqliteOperationJournal;
use serde_json::json;
use std::{fs, sync::Arc, time::Duration};

struct Harness {
    temp: tempfile::TempDir,
    repo: PluginRepository,
    _service: Arc<PluginService>,
    gateway: Arc<OperationGateway>,
    context: host::CallContext,
    revision: RevisionId,
}
impl Harness {
    fn new(script: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("package");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("build.sh"), script).unwrap();
        fs::write(source.join("deps.lock"), "fixture has no dependencies").unwrap();
        fs::write(
            source.join("BUILD.md"),
            "Run the declared local fixture recipe",
        )
        .unwrap();
        fs::write(source.join("plugin.json"), serde_json::to_vec(&json!({
            "protocol_version":1,"id":"example.build","name":"Native build fixture","version":"1","description":"Local build acceptance","license":"MIT",
            "source":{"files":["build.sh"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":{"command":["/bin/sh","build.sh","literal $(touch escaped) 科学"]}},
            "dependencies":{},"requires":[],"views":[{"id":"view","title":"Fixture","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}],
            "capabilities":[],"contexts":[],"backend":null,"configuration_schema":{"type":"object"},"default_configuration":{}
        })).unwrap()).unwrap();
        let archive = snapshot_directory(&source, None, "ui-web").unwrap();
        let store = temp.path().join("store");
        let mut repo = PluginRepository::open(&store).unwrap();
        repo.import(&archive).unwrap();
        let journal =
            Arc::new(SqliteOperationJournal::open(temp.path().join("journal.sqlite")).unwrap());
        let scope = temp.path().to_string_lossy().into_owned();
        let service = PluginService::open(&store, scope.clone(), vec![], journal.clone()).unwrap();
        let mut registry = CapabilityRegistry::new();
        service.register(&mut registry).unwrap();
        let registry = Arc::new(registry);
        let gateway = Arc::new(
            OperationGateway::new(
                registry.clone(),
                journal,
                Arc::new(SystemClock),
                Arc::new(UuidOperationIdGenerator),
            )
            .with_project_scope(Some(scope)),
        );
        let context = host::CallContext {
            caller: host::CallerIdentity {
                kind: host::CallerKind::Agent,
                id: "builder".into(),
            },
            principal: None,
            scopes: [
                "plugins.write".into(),
                "plugins.run".into(),
                "operation.read".into(),
                "operation.cancel".into(),
            ]
            .into(),
            view_scope: None,
            connection_id: "test".into(),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        };
        Self {
            temp,
            repo,
            _service: service,
            gateway,
            context,
            revision: archive.revision.id,
        }
    }
    fn invocation(&self, id: &str, timeout_ms: u64) -> host::Invocation {
        host::Invocation {
            client_request_id: id.into(),
            capability: host::CapabilityRef::new("plugins.build", 1).unwrap(),
            arguments: json!({"revision":self.revision,"timeout_ms":timeout_ms}),
            preconditions: vec![],
        }
    }
    async fn run(&self, id: &str, timeout: u64) -> host::OperationRecord {
        self.gateway
            .invoke(&self.context, self.invocation(id, timeout))
            .await
            .unwrap()
    }
    fn directory(&self, operation: &host::OperationId) -> std::path::PathBuf {
        self.repo
            .root()
            .join("builds-v1")
            .join(&content_digest(operation.as_str().as_bytes()).as_str()[7..])
    }
}

#[tokio::test]
async fn exact_source_build_commits_one_artifact_without_activation_and_reuses_original_receipt() {
    let mut h = Harness::new(
        "set -eu\nmkdir dist\nprintf '%s' \"$1\" > dist/index.html\nprintf '\\377Unicode 科学'\nprintf warning >&2\n",
    );
    let branch = h.repo.create_branch(&h.revision, "editing").unwrap();
    let request = h.invocation("build-once", 5000);
    let result = h.gateway.invoke(&h.context, request.clone()).await.unwrap();
    assert_eq!(
        result.status,
        host::OperationStatus::Succeeded,
        "{:?}",
        result.error
    );
    let output: PluginBuildResult = serde_json::from_value(result.output.clone().unwrap()).unwrap();
    assert_eq!(output.revision, h.revision);
    assert_eq!(output.process.stdout.bytes[0], 255);
    assert_eq!(output.process.stderr.bytes, b"warning");
    let artifact = h.repo.artifact(output.artifact.as_ref().unwrap()).unwrap();
    assert_eq!(artifact.revision, h.revision);
    assert_eq!(artifact.target, "ui-web");
    assert_eq!(
        h.repo
            .blob(&artifact.files[&PackagePath::new("dist/index.html").unwrap()].digest)
            .unwrap(),
        "literal $(touch escaped) 科学".as_bytes()
    );
    assert_eq!(h.repo.branch_head(&branch).unwrap(), h.revision);
    assert!(
        !h.directory(&result.operation.operation_id)
            .join("source/escaped")
            .exists()
    );
    let duplicate = h.gateway.invoke(&h.context, request).await.unwrap();
    assert_eq!(
        duplicate.operation.operation_id,
        result.operation.operation_id
    );
    assert_eq!(duplicate.output, result.output);
    assert_eq!(
        fs::read_dir(h.repo.root().join("builds-v1"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(h.repo.inspect(&h.revision).unwrap().artifacts.len(), 1);
    assert!(
        h.repo
            .inspect(&h.revision)
            .unwrap()
            .references
            .iter()
            .all(|r| !r.starts_with("build:"))
    );
    assert!(
        h.directory(&result.operation.operation_id)
            .join("process.json")
            .is_file()
    );
    assert!(
        h.directory(&result.operation.operation_id)
            .join("artifact.json")
            .is_file()
    );
    assert!(
        h.repo
            .recorded_instances_scoped(None, 10, None)
            .unwrap()
            .instances
            .is_empty()
    );
}

#[tokio::test]
async fn build_failure_missing_output_and_source_mutation_never_publish_artifacts() {
    for (script, message) in [
        ("echo failure >&2; exit 9", "Build stopped"),
        ("exit 0", "no artifact"),
        (
            "mkdir dist; echo output > dist/index.html; echo changed >> build.sh",
            "changed declared source",
        ),
        ("mkdir dist; ln -s /etc/passwd dist/index.html", "symlink"),
    ] {
        let h = Harness::new(script);
        let result = h.run("failure", 5000).await;
        assert_eq!(
            result.status,
            host::OperationStatus::Failed,
            "{script}: {:?}",
            result.error
        );
        assert!(
            result.error.as_ref().unwrap().contains(message),
            "{:?}",
            result.error
        );
        assert!(h.repo.inspect(&h.revision).unwrap().artifacts.is_empty());
        assert!(result.output.as_ref().unwrap()["artifact"].is_null());
    }
}

#[tokio::test]
async fn build_timeout_and_explicit_cancellation_retain_evidence_without_artifacts() {
    let h = Harness::new("echo started; sleep 30; mkdir dist; echo late > dist/index.html");
    let timeout = h.run("timeout", 50).await;
    assert_eq!(
        timeout.status,
        host::OperationStatus::Failed,
        "{:?}",
        timeout.error
    );
    assert_eq!(
        timeout.output.as_ref().unwrap()["process"]["termination"],
        "timed_out"
    );
    let gateway = h.gateway.clone();
    let context = h.context.clone();
    let request = h.invocation("cancel", 30000);
    let (send, receive) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        gateway
            .invoke_notifying(&context, request, Some(send))
            .await
            .unwrap()
    });
    let accepted = receive.await.unwrap();
    let directory = h.directory(&accepted.operation.operation_id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !directory.join("source").exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    h.gateway
        .request_cancellation(&h.context, &accepted.operation.operation_id)
        .await
        .unwrap();
    let cancelled = running.await.unwrap();
    assert_eq!(
        cancelled.status,
        host::OperationStatus::Cancelled,
        "{:?}",
        cancelled.error
    );
    assert!(h.repo.inspect(&h.revision).unwrap().artifacts.is_empty());
}

#[tokio::test]
async fn build_admission_rejects_missing_authority_and_forged_source_fields_without_starting() {
    let h = Harness::new("exit 0");
    for missing in ["plugins.run", "plugins.write"] {
        let mut context = h.context.clone();
        context.scopes.remove(missing);
        assert!(
            h.gateway
                .invoke(&context, h.invocation(missing, 1000))
                .await
                .is_err()
        );
    }
    for (name, value) in [
        ("timeout_ms", json!(0)),
        ("artifact", json!("forged")),
        ("project", json!("forged")),
        ("environment", json!({"SECRET":"forged"})),
    ] {
        let mut request = h.invocation(name, 1000);
        request.arguments[name] = value;
        assert!(h.gateway.invoke(&h.context, request).await.is_err());
    }
    assert!(!h.repo.root().join("builds-v1").exists());
    assert!(h.repo.inspect(&h.revision).unwrap().references.is_empty());
    assert!(!h.temp.path().join("dist").exists());
}

#[tokio::test]
async fn accepted_builds_protect_exact_source_and_cancel_queued_work_without_starting() {
    let mut h =
        Harness::new("touch running; sleep 30; mkdir dist; echo finished > dist/index.html");
    let first_request = h.invocation("running", 30000);
    let gateway = h.gateway.clone();
    let context = h.context.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    let first = tokio::spawn(async move {
        gateway
            .invoke_notifying(&context, first_request, Some(send))
            .await
            .unwrap()
    });
    let accepted = receive.await.unwrap();
    let marker = h
        .directory(&accepted.operation.operation_id)
        .join("source/running");
    tokio::time::timeout(Duration::from_secs(5), async {
        while !marker.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        h.repo.remove(&h.revision),
        Err(PluginError::Referenced(_))
    ));
    let branch = h
        .repo
        .create_branch(&h.revision, "Moving editing branch")
        .unwrap();
    let child = h
        .repo
        .checkpoint(&CheckpointPlugin {
            branch: branch.clone(),
            expected_head: h.revision.clone(),
            changes: [(
                PackagePath::new("build.sh").unwrap(),
                PluginSourceEdit::Put {
                    content_base64: {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD.encode("exit 9")
                    },
                    executable: false,
                },
            )]
            .into(),
        })
        .unwrap();
    assert_ne!(child.revision, h.revision);
    let gateway = h.gateway.clone();
    let context = h.context.clone();
    let request = h.invocation("queued", 30000);
    let (send, receive) = tokio::sync::oneshot::channel();
    let queued = tokio::spawn(async move {
        gateway
            .invoke_notifying(&context, request, Some(send))
            .await
            .unwrap()
    });
    let pending = receive.await.unwrap();
    assert!(!h.directory(&pending.operation.operation_id).exists());
    h.gateway
        .request_cancellation(&h.context, &pending.operation.operation_id)
        .await
        .unwrap();
    let cancelled = queued.await.unwrap();
    assert_eq!(cancelled.status, host::OperationStatus::Cancelled);
    assert!(!h.directory(&pending.operation.operation_id).exists());
    h.gateway
        .request_cancellation(&h.context, &accepted.operation.operation_id)
        .await
        .unwrap();
    let original = first.await.unwrap();
    assert_eq!(original.status, host::OperationStatus::Cancelled);
    assert_eq!(
        original.output.as_ref().unwrap()["revision"],
        json!(h.revision)
    );
    assert_eq!(h.repo.branch_head(&branch).unwrap(), child.revision);
    assert!(
        h.repo
            .inspect(&child.revision)
            .unwrap()
            .artifacts
            .is_empty()
    );
}

#[tokio::test]
async fn interrupted_build_preserves_original_uncertainty_and_source_protection_without_reexecution()
 {
    let mut h = Harness::new("touch running; sleep 30; mkdir dist; echo late > dist/index.html");
    let request = h.invocation("interrupted", 30000);
    let gateway = h.gateway.clone();
    let context = h.context.clone();
    let original = request.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        gateway
            .invoke_notifying(&context, original, Some(send))
            .await
    });
    let accepted = receive.await.unwrap();
    let directory = h.directory(&accepted.operation.operation_id);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !directory.join("source/running").exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    h.gateway.recover_incomplete().await.unwrap();
    let observed = h.gateway.invoke(&h.context, request).await.unwrap();
    assert_eq!(
        observed.operation.operation_id,
        accepted.operation.operation_id
    );
    assert_eq!(observed.status, host::OperationStatus::Uncertain);
    assert!(matches!(
        h.repo.remove(&h.revision),
        Err(PluginError::Referenced(_))
    ));
    let reconciliation = h._service.complete_record(&h.context, &observed).await;
    assert!(
        matches!(reconciliation, Err(rho_operation::OperationError::Unavailable(message)) if message.contains("settlement is uncertain")),
        "Reference reconciliation must not claim native cleanup for an uncertain build"
    );
    assert!(matches!(
        h.repo.remove(&h.revision),
        Err(PluginError::Referenced(_))
    ));
    assert!(h.repo.inspect(&h.revision).unwrap().artifacts.is_empty());
    assert_eq!(
        fs::read_dir(h.repo.root().join("builds-v1"))
            .unwrap()
            .count(),
        1
    );
    assert!(directory.join("request.json").is_file());
}

#[tokio::test]
async fn repeated_builds_keep_the_retained_package_exportable_and_roll_back_over_quota_artifacts() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut h = Harness::new("mkdir dist; echo excess > dist/index.html");
    let source = h.repo.export(&h.revision).unwrap();
    for index in 0..32 {
        let bytes = format!("Retained artifact {index}").into_bytes();
        let digest = content_digest(&bytes);
        let mut archive = source.clone();
        let mut artifact = BuildArtifact {
            id: ArtifactId::new(format!("sha256:{}", "0".repeat(64))).unwrap(),
            revision: h.revision.clone(),
            target: "ui-web".into(),
            files: [(
                PackagePath::new("dist/index.html").unwrap(),
                PackageFile {
                    digest: digest.clone(),
                    bytes: bytes.len() as u64,
                    executable: false,
                },
            )]
            .into(),
        };
        artifact.id = artifact_digest(&artifact).unwrap();
        archive.artifacts.push(artifact);
        archive.blobs.insert(digest, STANDARD.encode(bytes));
        h.repo.import(&archive).unwrap();
    }
    let result = h.run("excess", 5000).await;
    assert_eq!(
        result.status,
        host::OperationStatus::Failed,
        "{:?}",
        result.error
    );
    assert!(result.error.unwrap().contains("artifact inventory exceeds"));
    assert!(result.output.unwrap()["artifact"].is_null());
    assert_eq!(h.repo.inspect(&h.revision).unwrap().artifacts.len(), 32);
    assert!(
        h.repo.blob(&content_digest(b"excess\n")).is_err(),
        "Rejected build left unreferenced bytes behind"
    );
    validate_archive(&h.repo.export(&h.revision).unwrap()).unwrap();
}
