use super::*;
use rho_contract as host;
use rho_operation::{
    CapabilityRegistry, OperationGateway, OperationJournal, QueryGateway, SystemClock,
    UuidOperationIdGenerator,
};
use rho_sqlite::SqliteOperationJournal;

struct Harness {
    _temp: tempfile::TempDir,
    repo: Arc<Mutex<PluginRepository>>,
    runtime: Arc<PluginRuntime>,
    instance: PluginInstance,
    bridge: PluginCapabilityBridge,
    registry: Arc<CapabilityRegistry>,
    journal: Arc<SqliteOperationJournal>,
    gateway: Arc<OperationGateway>,
    queries: QueryGateway,
    context: host::CallContext,
}
impl Harness {
    async fn new(configuration: Value, preflight: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("plugin");
        let mut archive = fixture(&path, "1.0", false);
        if preflight {
            let manifest_path = path.join("plugin.json");
            let mut manifest: Value =
                serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
            let mut prepare = manifest["capabilities"][0].clone();
            prepare["capability"]["id"] = json!("fixture.prepare");
            manifest["capabilities"]
                .as_array_mut()
                .unwrap()
                .push(prepare);
            manifest["capabilities"][1]["preflight"] = json!({"id":"fixture.prepare","version":1});
            fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            archive = snapshot_directory(&path, None, "native-test").unwrap();
        }
        let scope = temp.path().to_str().unwrap().to_owned();
        let context = host::CallContext {
            caller: host::CallerIdentity {
                kind: host::CallerKind::Agent,
                id: "agent-a".into(),
            },
            principal: Some(host::CallerIdentity {
                kind: host::CallerKind::Human,
                id: "account-a".into(),
            }),
            scopes: ["fixture:read".into(), "operation.read".into()].into(),
            connection_id: "test".into(),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        };
        let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
        repo.import(&archive).unwrap();
        let repo = Arc::new(Mutex::new(repo));
        let runtime = Arc::new(runtime(repo.clone()));
        let mut activation = activation(&archive, configuration);
        activation.project = plugin_project_id(&scope);
        activation.principal = plugin_principal_id(context.principal());
        let instance = runtime.activate(activation).await.unwrap();
        let bridge = PluginCapabilityBridge::new(
            runtime.clone(),
            scope.clone(),
            Arc::new(NoPluginResources),
        );
        let registry = Arc::new(CapabilityRegistry::new());
        bridge.refresh(&registry).unwrap();
        let journal = Arc::new(SqliteOperationJournal::open(temp.path().join("operations.sqlite")).unwrap());
        let gateway = Arc::new(
            OperationGateway::new(
                registry.clone(),
                journal.clone(),
                Arc::new(SystemClock),
                Arc::new(UuidOperationIdGenerator),
            )
            .with_project_scope(Some(scope)),
        );
        let queries = QueryGateway::new(registry.clone());
        Self {
            _temp: temp,
            repo,
            runtime,
            instance,
            bridge,
            registry,
            journal,
            gateway,
            queries,
            context,
        }
    }
    fn payload(&self, capability: &str, arguments: Value) -> Value {
        json!(PluginRequest {
            binding: ProviderBinding {
                capability: key(capability),
                provider: self.instance.identity.clone(),
                project: self.instance.project.clone(),
                target: Some("native-target".into())
            },
            arguments,
            preconditions: json!({"native_revision":"original"})
        })
    }
    fn invocation(&self, id: &str, arguments: Value) -> host::Invocation {
        host::Invocation {
            capability: host::CapabilityRef::new("fixture.run", 1).unwrap(),
            client_request_id: id.into(),
            arguments: self.payload("fixture.run", arguments),
            preconditions: vec![],
        }
    }
    async fn read(
        &self,
        args: Value,
    ) -> Result<host::QuerySnapshot, rho_operation::OperationError> {
        self.queries
            .query(
                &self.context,
                host::QueryRequest {
                    capability: host::CapabilityRef::new("fixture.read", 1).unwrap(),
                    arguments: self.payload("fixture.read", args),
                },
            )
            .await
    }
}

#[tokio::test]
async fn pending_cancellation_requires_original_authority_and_retries_the_same_native_fence() {
    for mode in ["journal_failure", "lose_first", "unsupported", "running", "wrong_identity"] {
        let h = Harness::new(json!({"pending_cancellation": if mode == "unsupported" {Value::Null} else {json!(mode)}, "cancel_confirmed":true}), false).await;
        let gateway = h.gateway.clone();
        let context = h.context.clone();
        let invocation = h.invocation("conditional", json!({"action":if mode == "running" {"running"} else {"hold"}}));
        let (accepted, ack) = tokio::sync::oneshot::channel();
        let work = tokio::spawn(async move { gateway.invoke_notifying(&context, invocation, Some(accepted)).await });
        let original = ack.await.unwrap();
        let id = &original.operation.operation_id;
        wait_pending(&h.runtime).await;
        let mut foreign = h.context.clone();
        foreign.principal.as_mut().unwrap().id = "foreign-principal".into();
        assert!(h.gateway.request_cancellation_conditional(&foreign, id, true).await.is_err());
        let mut readonly = h.context.clone();
        readonly.scopes.remove("fixture:read");
        assert!(h.gateway.request_cancellation_conditional(&readonly, id, true).await.is_err());
        assert_eq!(h.read(json!({"action":"cancellation_state"})).await.unwrap().data.unwrap()["requests"], json!({}));
        let connection = rusqlite::Connection::open(h._temp.path().join("operations.sqlite")).unwrap();
        if mode == "journal_failure" {
            connection.execute_batch("CREATE TRIGGER fail_cancellation BEFORE UPDATE OF cancellation_requested ON operations BEGIN SELECT RAISE(ABORT,'injected cancellation journal failure'); END;").unwrap();
        }
        assert!(h.gateway.request_cancellation_conditional(&h.context, id, true).await.is_err());
        let observed = h.journal.get(id).await.unwrap().unwrap();
        assert!(!observed.cancellation_requested);
        if mode == "wrong_identity" {
            let result = work.await.unwrap().unwrap();
            assert_eq!(result.status, host::OperationStatus::Uncertain);
            assert!(!result.cancellation_requested);
            assert!(h.runtime.release(&h.instance.identity).await.is_err());
            continue;
        }
        assert!(!work.is_finished(), "preparation cannot finish the original operation");
        let native = h.read(json!({"action":"cancellation_state"})).await.unwrap().data.unwrap();
        assert_eq!(native["signals"], json!([]));
        assert_eq!(native["invocations"], 1);
        if mode == "unsupported" || mode == "running" {
            assert_eq!(native["preparations"], json!({}));
            if mode == "unsupported" { assert_eq!(native["requests"], json!({})); }
            h.read(json!({"action":"finish"})).await.unwrap();
            assert_eq!(work.await.unwrap().unwrap().status, host::OperationStatus::Succeeded);
        } else {
            assert_eq!(native["preparations"][id.as_str()]["operation_id"], id.as_str());
            if mode == "journal_failure" { connection.execute_batch("DROP TRIGGER fail_cancellation").unwrap(); }
            // A reopened view has a different caller but retains the same principal and original scopes.
            let mut reopened = h.context.clone();
            reopened.caller.id = "reopened-console".into();
            assert!(h.gateway.request_cancellation_conditional(&reopened, id, true).await.unwrap().accepted);
            let result = work.await.unwrap().unwrap();
            assert_eq!(result.operation.operation_id, *id);
            assert_eq!(result.status, host::OperationStatus::Cancelled);
            assert!(result.cancellation_requested);
            let native = h.read(json!({"action":"cancellation_state"})).await.unwrap().data.unwrap();
            assert_eq!(native["signals"], json!([id]));
            assert_eq!(native["invocations"], 1);
            if mode == "lose_first" {
                let requests = native["requests"][id.as_str()].as_array().unwrap();
                assert_eq!(requests.len(), 2);
                assert_eq!(requests[0], requests[1]);
            }
        }
        h.runtime.release(&h.instance.identity).await.unwrap();
    }
}

#[tokio::test]
async fn original_return_retires_unanswered_preparation_and_accepts_only_its_late_identity() {
    let h = Harness::new(json!({"pending_cancellation":"gate","cancel_confirmed":true}), false).await;
    let gateway = h.gateway.clone(); let context = h.context.clone();
    let invocation = h.invocation("original", json!({"action":"hold"}));
    let (accepted, ack) = tokio::sync::oneshot::channel();
    let work = tokio::spawn(async move { gateway.invoke_notifying(&context, invocation, Some(accepted)).await });
    let id = ack.await.unwrap().operation.operation_id;
    wait_pending(&h.runtime).await;
    let gateway = h.gateway.clone(); let context = h.context.clone(); let original = id.clone();
    let preparing = tokio::spawn(async move { gateway.request_cancellation_conditional(&context,&original,true).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if h.read(json!({"action":"cancellation_state"})).await.unwrap().data.unwrap()["preparations"][id.as_str()].is_object() { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    // A second, explicitly authorized cancellation can finish the original while
    // the first preparation acknowledgement is still missing.
    assert!(h.gateway.request_cancellation(&h.context,&id).await.unwrap().accepted);
    assert_eq!(work.await.unwrap().unwrap().status,host::OperationStatus::Cancelled);
    assert!(tokio::time::timeout(Duration::from_secs(3),preparing).await.unwrap().unwrap().is_err());
    h.read(json!({"action":"confirm_preparation"})).await.unwrap();
    assert_eq!(h.read(json!({"action":"cancellation_state"})).await.unwrap().data.unwrap()["invocations"],1);
    h.runtime.release(&h.instance.identity).await.unwrap();
}

#[tokio::test]
async fn operation_bridge_freezes_binding_commits_once_and_returns_original_after_unload() {
    let h = Harness::new(json!({"label":"bound"}), true).await;
    let query = h.read(json!({"message":"中文"})).await.unwrap();
    assert_eq!(query.data.unwrap()["arguments"]["message"], "中文");
    let invocation = h.invocation("one", json!({"action":"commit"}));
    let record = h
        .gateway
        .invoke(&h.context, invocation.clone())
        .await
        .unwrap();
    assert_eq!(record.status, host::OperationStatus::Succeeded);
    let output = record.output.as_ref().unwrap();
    assert_eq!(
        output["operation_id"],
        record.operation.operation_id.as_str()
    );
    assert_eq!(output["arguments"]["normalized"], true);
    assert_eq!(output["owner_context"]["native_session"], "fixed-session");
    assert_eq!(output["preconditions"]["native_revision"], "original");
    assert_eq!(
        record.operation.admission.as_ref().unwrap().owner_context["binding"]["provider"]["instance"],
        h.instance.identity.instance.as_str()
    );
    let facts = h
        .journal
        .facts_for_operation(&record.operation.operation_id)
        .await
        .unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(
        facts[0].value["owner"]["revision"],
        h.instance.identity.revision.as_str()
    );
    // Simulate losing only the lifecycle completion notification after a real
    // terminal commit. Cleanup must consult that journal, not a caller's result.
    h.repo
        .lock()
        .unwrap()
        .retain(
            "operation",
            &format!(
                "{}:{}",
                h.instance.identity.instance,
                record.operation.operation_id.as_str()
            ),
            &h.instance.identity.revision,
        )
        .unwrap();
    assert!(h.runtime.release(&h.instance.identity).await.is_err());
    let mut foreign = h.context.clone();
    foreign.principal.as_mut().unwrap().id = "foreign".into();
    assert!(
        h.bridge
            .reconcile_reference(h.journal.as_ref(), &foreign, &record.operation.operation_id)
            .await
            .is_err()
    );
    h.bridge
        .reconcile_reference(
            h.journal.as_ref(),
            &h.context,
            &record.operation.operation_id,
        )
        .await
        .unwrap();
    h.runtime.release(&h.instance.identity).await.unwrap();
    h.bridge.refresh(&h.registry).unwrap();
    assert!(h.registry.descriptors().is_empty());
    assert!(
        !h.gateway
            .request_cancellation(&h.context, &record.operation.operation_id)
            .await
            .unwrap()
            .accepted
    );
    let replay = h.gateway.invoke(&h.context, invocation).await.unwrap();
    assert_eq!(replay.operation.operation_id, record.operation.operation_id);
    assert_eq!(replay.output, record.output);
    assert_eq!(
        h.journal
            .facts_for_operation(&record.operation.operation_id)
            .await
            .unwrap(),
        facts
    );
    h.repo
        .lock()
        .unwrap()
        .remove(&h.instance.identity.revision)
        .unwrap();
}

#[tokio::test]
async fn operation_bridge_retains_running_provider_and_cancellation_does_not_imply_stop() {
    let h = Harness::new(json!({"cancel_confirmed":false}), false).await;
    // Retain an existing query lease so it can report owner completion during drain.
    let reader = h
        .runtime
        .resolve(
            &key("fixture.read"),
            &h.instance.project,
            &h.instance.principal,
            Some(&h.instance.identity),
        )
        .unwrap();
    let gateway = h.gateway.clone();
    let context = h.context.clone();
    let invocation = h.invocation("held", json!({"action":"hold"}));
    let (accepted, ack) = tokio::sync::oneshot::channel();
    let work = tokio::spawn(async move {
        gateway
            .invoke_notifying(&context, invocation, Some(accepted))
            .await
    });
    let record = ack.await.unwrap();
    wait_pending(&h.runtime).await;
    assert!(h.runtime.release(&h.instance.identity).await.is_err());
    h.bridge.refresh(&h.registry).unwrap();
    assert!(h.registry.handler(&host::CapabilityRef::new("fixture.run",1).unwrap()).is_err());
    assert!(h.registry.query_handler(&host::CapabilityRef::new("fixture.read",1).unwrap()).is_ok());
    assert!(h.registry.descriptors().iter().all(|d| d.kind == host::CapabilityKind::Query));
    let cancel = h
        .gateway
        .request_cancellation(&h.context, &record.operation.operation_id)
        .await
        .unwrap();
    assert!(cancel.accepted);
    assert!(!work.is_finished());
    let mut finish = call(&reader, json!({"action":"finish"}), false);
    finish.principal = h.instance.principal.clone();
    reader.call(finish).await.unwrap();
    let result = work.await.unwrap().unwrap();
    assert_eq!(result.status, host::OperationStatus::Succeeded);
    assert!(result.cancellation_requested);
    drop(reader);
    h.runtime.release(&h.instance.identity).await.unwrap();
}

#[tokio::test]
async fn operation_bridge_preserves_invalid_candidate_and_crash_is_never_replayed() {
    let h = Harness::new(json!({}), false).await;
    for action in ["badcommit", "badfact", "evidence"] {
        let record = h
            .gateway
            .invoke(&h.context, h.invocation(action, json!({"action":action})))
            .await
            .unwrap();
        assert_eq!(record.status, host::OperationStatus::Uncertain);
        assert!(record.recovery.as_ref().unwrap()["candidate"].is_object());
        let native = h.read(json!({"action":"settlement_state"})).await.unwrap().data.unwrap();
        assert_eq!(native["settlements"][record.operation.operation_id.as_str()]["outcome"], "uncertain",
            "settlement uses the validated original result, not the backend's proposed success");
        assert!(
            h.journal
                .facts_for_operation(&record.operation.operation_id)
                .await
                .unwrap()
                .is_empty()
        );
    }
    let marker = h._temp.path().join("once");
    let request = h.invocation("crash", json!({"action":"crash","marker":marker}));
    let record = h.gateway.invoke(&h.context, request.clone()).await.unwrap();
    assert_eq!(record.status, host::OperationStatus::Uncertain);
    h.bridge.refresh(&h.registry).unwrap();
    let original = h.gateway.invoke(&h.context, request).await.unwrap();
    assert_eq!(
        original.operation.operation_id,
        record.operation.operation_id
    );
    assert_eq!(fs::read_to_string(marker).unwrap(), "executed\n");
}

#[tokio::test]
async fn operation_bridge_rejects_foreign_bindings_and_preflight_retargeting_before_admission() {
    let h = Harness::new(json!({"retarget":true}), true).await;
    let mut context = h.context.clone();
    context.principal.as_mut().unwrap().id = "account-b".into();
    let query = host::QueryRequest {
        capability: host::CapabilityRef::new("fixture.read", 1).unwrap(),
        arguments: h.payload("fixture.read", json!({})),
    };
    assert!(h.queries.query(&context, query).await.is_err());
    assert!(
        h.gateway
            .invoke(
                &h.context,
                h.invocation("retarget", json!({"action":"commit"}))
            )
            .await
            .is_err()
    );
    assert!(
        h.gateway
            .owner_request_record(&h.context, "retarget")
            .await
            .unwrap()
            .is_none()
    );
    let mut forged = h.invocation("forged", json!({}));
    forged.arguments["binding"]["provider"]["revision"] =
        json!(format!("sha256:{}", "0".repeat(64)));
    assert!(h.gateway.invoke(&h.context, forged).await.is_err());
    h.runtime.release(&h.instance.identity).await.unwrap();
}

#[tokio::test]
async fn operation_bridge_retains_provider_until_original_durable_result_is_committed() {
    let h = Harness::new(json!({}), true).await;
    let connection = rusqlite::Connection::open(h._temp.path().join("operations.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_commit BEFORE UPDATE OF status ON operations WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'injected plugin commit failure'); END;").unwrap();
    let invocation = h.invocation("commit-recovery", json!({"action":"commit"}));
    let error = h.gateway.invoke(&h.context, invocation.clone()).await.unwrap_err();
    let rho_operation::OperationError::CommitPending {operation_id,..} = error else { panic!("expected retained native result") };
    let receipt = h.journal.commit_receipt(&operation_id).await.unwrap().unwrap();
    assert!(!receipt.committed);
    let cancellation = h.gateway.request_cancellation(&h.context, &operation_id).await.unwrap();
    assert!(cancellation.accepted);
    assert_eq!(cancellation.operation.status, host::OperationStatus::Running);
    assert!(h.journal.facts_for_operation(&operation_id).await.unwrap().is_empty());
    let native = h.read(json!({"action":"settlement_state"})).await.unwrap().data.unwrap();
    assert_eq!(native["settlements"], json!({}), "native completion must not advance an uncommitted operation");
    assert!(h.bridge.reconcile_reference(h.journal.as_ref(), &h.context, &operation_id).await.is_err());
    assert!(h.runtime.release(&h.instance.identity).await.is_err());
    connection.execute_batch("DROP TRIGGER fail_commit").unwrap();
    let result = h.gateway.reconcile_commit(&h.context, &host::ReconcileOperationCommit {reference:receipt.reference}).await.unwrap();
    assert_eq!(result.status,host::OperationStatus::Succeeded);
    assert!(result.cancellation_requested, "a later cancellation request cannot overwrite a known native result");
    assert_eq!(h.journal.facts_for_operation(&operation_id).await.unwrap().len(),1);
    let native = h.read(json!({"action":"settlement_state"})).await.unwrap().data.unwrap();
    assert_eq!(native["settlements"][operation_id.as_str()]["outcome"], "succeeded");
    assert_eq!(native["settlements"][operation_id.as_str()]["binding"], invocation.arguments["binding"]);
    assert_eq!(native["invocations"], 1);
    h.runtime.release(&h.instance.identity).await.unwrap();
    h.bridge.refresh(&h.registry).unwrap();
    assert!(h.registry.descriptors().is_empty());
    let original = h.gateway.invoke(&h.context, invocation).await.unwrap();
    assert_eq!(original.operation.operation_id, operation_id);
    assert_eq!(original.output, result.output);
}

#[tokio::test]
async fn operation_bridge_reconciles_lost_native_settlement_without_reexecution() {
    let h = Harness::new(json!({"settlement":"lose_first"}), false).await;
    let invocation = h.invocation("lost-settlement", json!({"action":"commit"}));
    let record = h.gateway.invoke(&h.context, invocation.clone()).await.unwrap();
    assert_eq!(record.status, host::OperationStatus::Succeeded, "lost cleanup acknowledgement cannot replace committed science");
    let id = &record.operation.operation_id;
    assert!(h.repo.lock().unwrap().references(&h.instance.identity.revision).unwrap().contains(&format!("operation:{}:{id}", h.instance.identity.instance)));
    assert!(h.runtime.release(&h.instance.identity).await.is_err());
    let native = h.read(json!({"action":"settlement_state"})).await.unwrap().data.unwrap();
    assert_eq!(native["settlements"][id.as_str()]["outcome"], "succeeded");
    let mut foreign = h.context.clone();
    foreign.principal.as_mut().unwrap().id = "another-owner".into();
    assert!(h.bridge.reconcile_reference(h.journal.as_ref(), &foreign, id).await.is_err());
    h.bridge.reconcile_reference(h.journal.as_ref(), &h.context, id).await.unwrap();
    let native = h.read(json!({"action":"settlement_state"})).await.unwrap().data.unwrap();
    assert_eq!(native["invocations"], 1);
    let requests = native["requests"][id.as_str()].as_array().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1], "explicit resend keeps its pending transport identity");
    h.bridge.reconcile_reference(h.journal.as_ref(), &h.context, id).await.unwrap();
    let repeated = h.read(json!({"action":"settlement_state"})).await.unwrap().data.unwrap();
    assert_eq!(repeated["requests"], native["requests"], "completed cleanup does not notify the owner again");
    assert!(!h.repo.lock().unwrap().references(&h.instance.identity.revision).unwrap().iter().any(|r| r.starts_with("operation:")));
    assert_eq!(h.runtime.observe().iter().find(|o| o.instance.identity == h.instance.identity).unwrap().instance.state, InstanceState::Draining,
        "late exact acknowledgement must not disconnect the owner");
    let replay = h.gateway.invoke(&h.context, invocation).await.unwrap();
    assert_eq!(replay.operation.operation_id, *id);
    assert_eq!(replay.output, record.output);
    h.runtime.release(&h.instance.identity).await.unwrap();
}

#[tokio::test]
async fn operation_bridge_wrong_settlement_acknowledgement_preserves_committed_result() {
    let h = Harness::new(json!({"settlement":"wrong_identity"}), false).await;
    let invocation = h.invocation("wrong-ack", json!({"action":"commit"}));
    let record = h.gateway.invoke(&h.context, invocation.clone()).await.unwrap();
    assert_eq!(record.status, host::OperationStatus::Succeeded);
    assert!(h.repo.lock().unwrap().references(&h.instance.identity.revision).unwrap().iter().any(|r| r.starts_with("operation:")));
    assert!(h.read(json!({})).await.is_err());
    h.bridge.reconcile_reference(h.journal.as_ref(), &h.context, &record.operation.operation_id).await.unwrap();
    assert!(!h.repo.lock().unwrap().references(&h.instance.identity.revision).unwrap().iter().any(|r| r.starts_with("operation:")));
    assert!(h.runtime.release(&h.instance.identity).await.is_err(), "reference cleanup is not native shutdown confirmation");
    let replay = h.gateway.invoke(&h.context, invocation).await.unwrap();
    assert_eq!(replay.operation.operation_id, record.operation.operation_id);
    assert_eq!(replay.output, record.output);
}
