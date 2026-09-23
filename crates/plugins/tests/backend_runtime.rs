use rho_plugin_protocol::*;
use rho_plugins::*;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

fn key(id: &str) -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new(id).unwrap(),
        version: 1,
    }
}
fn fixture(path: &Path, version: &str, requires: bool) -> PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    let code = include_str!("fixtures/backend.py");
    fs::write(path.join("backend.py"), code).unwrap();
    fs::write(path.join("dist/backend"), code).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path.join("dist/backend"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(
        path.join("BUILD.md"),
        "Copy backend.py to dist/backend and set executable permission.",
    )
    .unwrap();
    fs::write(
        path.join("deps.lock"),
        "Python 3 standard library; no third party dependencies.",
    )
    .unwrap();
    let capability = |id, kind, effects, cancellation| {
        json!({
            "capability": {"id": id, "version": 1}, "kind": kind, "title": id, "description": "Runtime fixture",
            "input_schema": {"type":"object"}, "output_schema": {"type":"object"}, "recovery_schema": true,
            "required_scopes": ["fixture:read"], "effects": effects, "cancellation": cancellation
        })
    };
    fs::write(path.join("plugin.json"), serde_json::to_vec(&json!({
        "protocol_version":1,"id":"example.backend","name":"External backend","version":version,
        "description":"Independent backend protocol conformance","license":"MIT",
        "source":{"files":["backend.py"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},
        "dependencies":{}, "requires": if requires { json!([{"capability":{"id":"host.echo","version":1},"scopes":["fixture:read"]}]) } else {json!([])},
        "views":[],"contexts":[],"backend":{"executable":"dist/backend","arguments":[]},
        "capabilities":[capability("fixture.read","query",json!([]),"unsupported"),
            capability("fixture.run","operation",json!(["fixture.write"]),"request")],
        "configuration_schema":{"type":"object"},"default_configuration":{}
    })).unwrap()).unwrap();
    snapshot_directory(path, None, "native-test").unwrap()
}
fn activation(archive: &PluginArchive, configuration: Value) -> BackendActivation {
    BackendActivation {
        revision: archive.revision.id.clone(),
        artifact: archive.artifacts[0].id.clone(),
        target: "native-test".into(),
        project: ProjectId::new("project-a").unwrap(),
        principal: PrincipalId::new("owner-a").unwrap(),
        alias: InstanceAlias::new("test").unwrap(),
        configuration,
        grants: archive.revision.manifest.requires.clone(),
    }
}
fn runtime(repo: Arc<Mutex<PluginRepository>>) -> PluginRuntime {
    PluginRuntime::new(
        repo,
        Arc::new(NoPluginHostServices),
        BackendPolicy {
            initialize_timeout: Duration::from_secs(10),
            write_timeout: Duration::from_secs(2),
            release_timeout: Duration::from_millis(500),
        },
    )
}
fn resolve(runtime: &PluginRuntime, instance: &PluginInstance, operation: bool) -> ProviderLease {
    runtime
        .resolve(
            &key(if operation {
                "fixture.run"
            } else {
                "fixture.read"
            }),
            &instance.project,
            &instance.principal,
            Some(&instance.identity),
        )
        .unwrap()
}
fn call(lease: &ProviderLease, args: Value, operation: bool) -> PluginCall {
    PluginCall {
        request: RequestId::new("logical-request").unwrap(),
        binding: lease.binding(Some("native-target".into())),
        principal: PrincipalId::new("owner-a").unwrap(),
        scopes: ["fixture:read".into()].into(),
        arguments: args,
        preconditions: json!({}),
        operation_id: operation.then(|| "operation-original".into()),
    }
}
fn data(reply: RpcBody) -> Value {
    let RpcBody::QueryResult { data, .. } = reply else {
        panic!("expected query result")
    };
    data
}
async fn wait_pending(runtime: &PluginRuntime) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while runtime.observe().iter().all(|s| s.pending_messages == 0) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn immutable_revisions_run_in_distinct_processes_and_resolution_is_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let first = fixture(&temp.path().join("one"), "1.0", false);
    let second = fixture(&temp.path().join("two"), "2.0", false);
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&first).unwrap();
    repo.import(&second).unwrap();
    let repo = Arc::new(Mutex::new(repo));
    let runtime = runtime(repo.clone());
    assert!(runtime.observe().is_empty());
    let one = runtime
        .activate(activation(&first, json!({"label":"one"})))
        .await
        .unwrap();
    let two = runtime
        .activate(activation(&second, json!({"label":"two"})))
        .await
        .unwrap();
    assert!(
        runtime
            .resolve(&key("fixture.read"), &one.project, &one.principal, None)
            .is_err()
    );
    let a = resolve(&runtime, &one, false);
    let b = resolve(&runtime, &two, false);
    assert!(
        a.call(call(
            &a,
            json!({"oversized": "x".repeat(MAX_CONTROL_BYTES)}),
            false
        ))
        .await
        .is_err()
    );
    let ar = data(
        a.call(call(&a, json!({"message":"中文"}), false))
            .await
            .unwrap(),
    );
    let br = data(b.call(call(&b, json!({}), false)).await.unwrap());
    assert_eq!(ar["label"], "one");
    assert_eq!(br["label"], "two");
    assert_ne!(ar["pid"], br["pid"]);
    assert_eq!(ar["arguments"]["message"], "中文");
    assert!(ar["host_credential"].is_null());
    assert!(repo.lock().unwrap().remove(&first.revision.id).is_err());
    let mut forged = call(&a, json!({}), false);
    forged.binding.provider = two.identity.clone();
    assert!(a.call(forged).await.is_err());
    let mut unscoped = call(&a, json!({}), false);
    unscoped.scopes.clear();
    assert!(a.call(unscoped).await.is_err());
    drop(a);
    drop(b);
    runtime.release(&one.identity).await.unwrap();
    runtime.release(&two.identity).await.unwrap();
    repo.lock().unwrap().remove(&first.revision.id).unwrap();
    repo.lock().unwrap().remove(&second.revision.id).unwrap();
    assert!(
        runtime
            .observe()
            .iter()
            .all(|i| i.instance.state == InstanceState::Released)
    );
    let recorded = PluginRepository::observe(&temp.path().join("store"))
        .unwrap()
        .unwrap()
        .recorded_instances(None, 1)
        .unwrap();
    assert_eq!(recorded.total, 2);
    assert_eq!(recorded.instances.len(), 1);
    assert!(recorded.next.is_some());
    assert_eq!(recorded.instances[0].state, InstanceState::Released);
}

#[tokio::test]
async fn draining_retains_accepted_work_and_unconfirmed_cancel_does_not_end_it() {
    let temp = tempfile::tempdir().unwrap();
    let archive = fixture(&temp.path().join("plugin"), "1", false);
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&archive).unwrap();
    let runtime = runtime(Arc::new(Mutex::new(repo)));
    let instance = runtime
        .activate(activation(&archive, json!({"label":"old"})))
        .await
        .unwrap();
    let operation = Arc::new(resolve(&runtime, &instance, true));
    let query = resolve(&runtime, &instance, false);
    let runner = operation.clone();
    let running = tokio::spawn(async move {
        runner
            .call(call(&runner, json!({"action":"hold"}), true))
            .await
    });
    wait_pending(&runtime).await;
    assert!(runtime.release(&instance.identity).await.is_err());
    assert_eq!(runtime.observe()[0].instance.state, InstanceState::Draining);
    assert!(
        runtime
            .resolve(
                &key("fixture.read"),
                &instance.project,
                &instance.principal,
                Some(&instance.identity)
            )
            .is_err()
    );
    assert!(!operation.cancel("operation-original").await.unwrap());
    assert!(!running.is_finished());
    query
        .call(call(&query, json!({"action":"finish"}), false))
        .await
        .unwrap();
    let RpcBody::CommitPlan(plan) = running.await.unwrap().unwrap() else {
        panic!("expected commit plan")
    };
    assert_eq!(plan.outcome, PluginOutcome::Succeeded);
    assert!(!plan.cancellation_confirmed);
    // Completion of the backend reply alone does not release the admission lease.
    assert!(runtime.release(&instance.identity).await.is_err());
    drop(operation);
    drop(query);
    runtime.release(&instance.identity).await.unwrap();
}

#[tokio::test]
async fn native_confirmation_is_distinct_from_request_acknowledgement() {
    let temp = tempfile::tempdir().unwrap();
    let archive = fixture(&temp.path().join("plugin"), "1", false);
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&archive).unwrap();
    let runtime = runtime(Arc::new(Mutex::new(repo)));
    let instance = runtime
        .activate(activation(&archive, json!({"cancel_confirmed":true})))
        .await
        .unwrap();
    let operation = Arc::new(resolve(&runtime, &instance, true));
    let runner = operation.clone();
    let running = tokio::spawn(async move { runner.call(call(&runner, json!({}), true)).await });
    wait_pending(&runtime).await;
    assert!(operation.cancel("operation-original").await.unwrap());
    let RpcBody::CommitPlan(plan) = running.await.unwrap().unwrap() else {
        panic!()
    };
    assert_eq!(plan.outcome, PluginOutcome::Cancelled);
    assert!(plan.cancellation_confirmed);
    drop(operation);
    runtime.release(&instance.identity).await.unwrap();
}

#[tokio::test]
async fn faults_fence_only_the_affected_instance_and_keep_revision_recovery_references() {
    for fault in ["spoof", "disorder", "oversize", "crash"] {
        let temp = tempfile::tempdir().unwrap();
        let archive = fixture(&temp.path().join("plugin"), "1", false);
        let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
        repo.import(&archive).unwrap();
        let repo = Arc::new(Mutex::new(repo));
        let runtime = runtime(repo.clone());
        let instance = runtime
            .activate(activation(&archive, json!({})))
            .await
            .unwrap();
        let healthy = runtime
            .activate(activation(&archive, json!({"label":"healthy"})))
            .await
            .unwrap();
        let operation = fault == "crash";
        let lease = resolve(&runtime, &instance, operation);
        let marker = temp.path().join("effects");
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            lease.call(call(
                &lease,
                json!({"action":fault,"marker":marker}),
                operation,
            )),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        drop(lease);
        let observer = resolve(&runtime, &healthy, false);
        assert_eq!(
            data(
                observer
                    .call(call(&observer, json!({}), false))
                    .await
                    .unwrap()
            )["label"],
            "healthy"
        );
        drop(observer);
        runtime.release(&healthy.identity).await.unwrap();
        assert!(
            runtime
                .observe()
                .iter()
                .any(|i| i.instance.identity == instance.identity
                    && i.instance.state == InstanceState::Disconnected)
        );
        assert!(
            repo.lock()
                .unwrap()
                .references(&archive.revision.id)
                .unwrap()
                .contains(&format!("instance:{}", instance.identity.instance))
        );
        if operation {
            assert_eq!(fs::read_to_string(marker).unwrap(), "executed\n");
        }
    }
}

#[tokio::test]
async fn initialization_and_cleanup_failure_never_publish_false_success() {
    let temp = tempfile::tempdir().unwrap();
    let archive = fixture(&temp.path().join("plugin"), "1", false);
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&archive).unwrap();
    let repo = Arc::new(Mutex::new(repo));
    let runtime = runtime(repo.clone());
    assert!(
        runtime
            .activate(activation(
                &archive,
                json!({"oversized":"x".repeat(MAX_CONTROL_BYTES)})
            ))
            .await
            .is_err()
    );
    assert!(runtime.observe().is_empty());
    assert!(
        runtime
            .activate(activation(&archive, json!({"mode":"init_fail"})))
            .await
            .is_err()
    );
    assert!(
        runtime
            .activate(activation(&archive, json!({"mode":"bad_ready"})))
            .await
            .is_err()
    );
    assert!(
        runtime
            .observe()
            .iter()
            .all(|i| i.instance.state != InstanceState::Active)
    );
    let bad = runtime
        .activate(activation(&archive, json!({"mode":"cleanup_fail"})))
        .await
        .unwrap();
    assert!(runtime.release(&bad.identity).await.is_err());
    assert!(
        runtime
            .observe()
            .iter()
            .any(|i| i.instance.identity == bad.identity
                && i.instance.state == InstanceState::CleanupFailed)
    );
    assert!(repo.lock().unwrap().remove(&archive.revision.id).is_err());
    let recorded = PluginRepository::observe(&temp.path().join("store"))
        .unwrap()
        .unwrap()
        .recorded_instances(None, 100)
        .unwrap();
    assert_eq!(recorded.total, 3);
    assert!(recorded.instances.iter().all(|i| matches!(
        i.state,
        InstanceState::Failed | InstanceState::CleanupFailed
    )));
}

#[tokio::test]
async fn cancelled_activation_remains_diagnostic_without_partial_contributions() {
    let temp = tempfile::tempdir().unwrap();
    let archive = fixture(&temp.path().join("plugin"), "1", false);
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&archive).unwrap();
    let runtime = runtime(Arc::new(Mutex::new(repo)));
    let result = tokio::time::timeout(
        Duration::from_millis(50),
        runtime.activate(activation(&archive, json!({"mode":"init_hang"}))),
    )
    .await;
    assert!(result.is_err());
    let observations = runtime.observe();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].instance.state, InstanceState::Failed);
    assert!(
        observations[0]
            .instance
            .diagnostic
            .as_ref()
            .unwrap()
            .contains("interrupted")
    );
    assert!(
        runtime
            .resolve(
                &key("fixture.read"),
                &observations[0].instance.project,
                &observations[0].instance.principal,
                None
            )
            .is_err()
    );
}

#[tokio::test]
async fn incompatible_contracts_cannot_partially_register_an_instance() {
    let temp = tempfile::tempdir().unwrap();
    let first = fixture(&temp.path().join("one"), "1.0", false);
    fixture(&temp.path().join("two"), "2.0", false);
    let manifest_path = temp.path().join("two/plugin.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["capabilities"][0]["output_schema"] = json!({"type":"string"});
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let second = snapshot_directory(&temp.path().join("two"), None, "native-test").unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&first).unwrap();
    repo.import(&second).unwrap();
    let runtime = runtime(Arc::new(Mutex::new(repo)));
    let original = runtime
        .activate(activation(&first, json!({})))
        .await
        .unwrap();
    assert!(
        runtime
            .activate(activation(&second, json!({})))
            .await
            .unwrap_err()
            .to_string()
            .contains("different registered contract")
    );
    assert_eq!(
        runtime
            .observe()
            .iter()
            .filter(|i| i.instance.state == InstanceState::Active)
            .count(),
        1
    );
    let lease = runtime
        .resolve(
            &key("fixture.read"),
            &original.project,
            &original.principal,
            None,
        )
        .unwrap();
    assert_eq!(lease.binding(None).provider, original.identity);
    drop(lease);
    runtime.release(&original.identity).await.unwrap();
}

struct EchoHost(Mutex<Vec<DelegatedPluginCall>>);
#[async_trait::async_trait]
impl PluginHostServices for EchoHost {
    async fn call(&self, call: DelegatedPluginCall) -> Result<Value, String> {
        self.0.lock().unwrap().push(call);
        Ok(json!({"host":"accepted"}))
    }
}
#[tokio::test]
async fn reverse_calls_inherit_active_parent_and_declared_scope_without_host_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let archive = fixture(&temp.path().join("plugin"), "1", true);
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&archive).unwrap();
    let host = Arc::new(EchoHost(Mutex::new(vec![])));
    let runtime = PluginRuntime::new(
        Arc::new(Mutex::new(repo)),
        host.clone(),
        BackendPolicy::default(),
    );
    let instance = runtime
        .activate(activation(&archive, json!({})))
        .await
        .unwrap();
    let lease = resolve(&runtime, &instance, false);
    let reply = data(
        lease
            .call(call(&lease, json!({"action":"delegate"}), false))
            .await
            .unwrap(),
    );
    assert_eq!(reply["delegated"]["result"]["host"], "accepted");
    for action in ["delegate_bad_parent", "delegate_bad_grant"] {
        let reply = data(
            lease
                .call(call(&lease, json!({"action":action}), false))
                .await
                .unwrap(),
        );
        assert_eq!(reply["delegated"]["code"], "access_denied");
    }
    let calls = host.0.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].query_only);
    assert_eq!(calls[0].parent.binding.project, instance.project);
    assert_eq!(calls[0].parent.principal, instance.principal);
    assert_eq!(calls[0].provider, instance.identity);
    assert_eq!(calls[0].parent.scopes, ["fixture:read".into()].into());
    drop(calls);
    drop(lease);
    runtime.release(&instance.identity).await.unwrap();
}

#[tokio::test]
async fn logs_are_bounded_and_invalid_commit_plans_never_reach_the_caller_as_success() {
    let temp = tempfile::tempdir().unwrap();
    let archive = fixture(&temp.path().join("plugin"), "1", false);
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    repo.import(&archive).unwrap();
    let runtime = runtime(Arc::new(Mutex::new(repo)));
    let instance = runtime
        .activate(activation(&archive, json!({})))
        .await
        .unwrap();
    let query = resolve(&runtime, &instance, false);
    query
        .call(call(&query, json!({"action":"logs"}), false))
        .await
        .unwrap();
    assert!(!runtime.observe()[0].stderr.is_empty());
    assert!(runtime.observe()[0].stderr.len() <= MAX_BACKEND_LOG_BYTES);
    let operation = resolve(&runtime, &instance, true);
    assert!(
        operation
            .call(call(&operation, json!({"action":"badcommit"}), true))
            .await
            .is_err()
    );
    drop(query);
    drop(operation);
    runtime.release(&instance.identity).await.unwrap();
}
