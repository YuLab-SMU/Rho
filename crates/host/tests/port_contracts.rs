use async_trait::async_trait;
use rho_contract::*;
use rho_host::{DeterministicWorkspaceRuntime, NextHost, OperationError};
use rho_operation::{SystemClock, UuidOperationIdGenerator};
use rho_sqlite::SqliteOperationJournal;
use rho_workspace::{
    RunRArguments, WorkspaceRuntime, WorkspaceRuntimeError, WorkspaceRuntimeReport,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;

fn invocation(request: &str) -> Invocation {
    Invocation {
        client_request_id: request.into(),
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        arguments: json!({"code":"answer <- 42"}),
        preconditions: vec![],
    }
}
async fn query(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    arguments: Value,
) -> Result<QuerySnapshot, OperationError> {
    host.query_snapshot(
        context,
        QueryRequest {
            capability: CapabilityRef::new(id, 1).unwrap(),
            arguments,
        },
    )
    .await
}
async fn demo(runtime: Arc<dyn WorkspaceRuntime>) -> NextHost {
    NextHost::with_components(
        Arc::new(SqliteOperationJournal::open_in_memory().unwrap()),
        runtime,
        Arc::new(SystemClock),
        Arc::new(UuidOperationIdGenerator),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn event_pages_and_legacy_reads_share_visibility_cursor_and_validated_records() {
    let runtime = Arc::new(DeterministicWorkspaceRuntime::default());
    let host = demo(runtime.clone()).await;
    let context = NextHost::local_context();
    let first = host.invoke(&context, invocation("first")).await.unwrap();
    let mut other = context.clone();
    other.caller.id = "other-principal".into();
    let hidden = host.invoke(&other, invocation("hidden")).await.unwrap();
    let second = host.invoke(&context, invocation("second")).await.unwrap();
    let legacy = host.outbox(&context, 0, 100).await.unwrap();
    assert!(!legacy.is_empty());
    assert!(
        legacy
            .iter()
            .all(|event| event.operation_id != hidden.operation.operation_id)
    );
    let mut cursor = 0;
    let mut found = vec![];
    loop {
        let arguments = json!({"after_sequence":cursor,"limit":2});
        let snapshot = query(&host, &context, "operation.events", arguments.clone())
            .await
            .unwrap();
        let page: OperationEventsPage =
            serde_json::from_value(snapshot.data.clone().unwrap()).unwrap();
        assert_eq!(
            query(&host, &context, "operation.events", arguments)
                .await
                .unwrap()
                .data,
            snapshot.data
        );
        assert!(page.events.len() <= 2);
        assert_eq!(page.after_sequence, cursor);
        assert_eq!(
            page.next_after_sequence,
            page.events.last().map_or(cursor, |event| event.sequence)
        );
        assert_eq!(
            snapshot.next_reads[0].arguments["after_sequence"],
            page.next_after_sequence
        );
        assert!(snapshot.next_reads.iter().all(|read| {
            host.capabilities_for(&context).iter().any(|descriptor| {
                descriptor.capability == read.capability && descriptor.kind == CapabilityKind::Query
            })
        }));
        found.extend(page.events);
        if !page.has_more {
            assert_eq!(snapshot.completeness, ObservationCompleteness::Complete);
            assert!(page.limit_reason.is_none());
            break;
        }
        assert_eq!(snapshot.completeness, ObservationCompleteness::Partial);
        assert_eq!(page.limit_reason.as_deref(), Some("item_limit"));
        assert!(page.next_after_sequence > cursor);
        cursor = page.next_after_sequence;
    }
    assert_eq!(found, legacy);
    assert_eq!(runtime.execution_count(), 3);
    for original in [first, second] {
        let snapshot = query(
            &host,
            &context,
            "operation.get",
            json!({"operation_id":original.operation.operation_id}),
        )
        .await
        .unwrap();
        let typed: OperationGetResult = serde_json::from_value(snapshot.data.unwrap()).unwrap();
        let bare = host
            .dispatch(
                &context,
                HostRequest::GetOperation {
                    operation_id: original.operation.operation_id.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(bare, serde_json::to_value(typed.record).unwrap());
        assert_eq!(
            typed.output_contract.unwrap().capability,
            original.operation.capability
        );
    }
    let mut denied = context.clone();
    denied.scopes.clear();
    for request in [
        HostRequest::Subscribe {
            after_sequence: 0,
            limit: 100,
        },
        HostRequest::GetOperation {
            operation_id: hidden.operation.operation_id,
        },
    ] {
        assert!(matches!(
            host.dispatch(&denied, request).await,
            Err(OperationError::AccessDenied { .. })
        ));
    }
    for invalid in [
        json!({"limit":0}),
        json!({"limit":1001}),
        json!({"after_sequence":u64::MAX}),
        json!({"extra":true}),
    ] {
        assert!(matches!(
            query(&host, &context, "operation.events", invalid).await,
            Err(OperationError::InvalidInput(_))
        ));
    }
}

struct InputRuntime {
    started: Notify,
    release: Notify,
    input: Mutex<Option<InputRequest>>,
    executions: AtomicUsize,
    deliveries: AtomicUsize,
}
impl InputRuntime {
    fn new() -> Self {
        Self {
            started: Notify::new(),
            release: Notify::new(),
            input: Mutex::new(None),
            executions: AtomicUsize::new(0),
            deliveries: AtomicUsize::new(0),
        }
    }
}
#[async_trait]
impl WorkspaceRuntime for InputRuntime {
    fn session_id(&self) -> &str {
        "native-input-session"
    }
    fn input_request(&self) -> Option<InputRequest> {
        self.input.lock().unwrap().clone()
    }
    fn respond_input(&self, reply: RespondInput) -> Result<(), String> {
        let mut pending = self.input.lock().unwrap();
        let pending = pending.as_mut().ok_or("No pending request")?;
        if pending.submitted
            || pending.operation_id != reply.operation_id
            || pending.session_id != reply.session_id
            || pending.request_id != reply.request_id
        {
            return Err("Native input identity changed or already submitted".into());
        }
        pending.submitted = true;
        self.deliveries.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn execute(
        &self,
        operation: &Operation,
        _: &RunRArguments,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        self.executions.fetch_add(1, Ordering::SeqCst);
        *self.input.lock().unwrap() = Some(InputRequest {
            session_id: self.session_id().into(),
            operation_id: operation.operation_id.clone(),
            request_id: "native-request".into(),
            prompt: "Answer?".into(),
            password: true,
            submitted: false,
        });
        self.started.notify_one();
        self.release.notified().await;
        Ok(WorkspaceRuntimeReport {
            session_id: self.session_id().into(),
            value: json!(42),
            stdout: String::new(),
            stderr: String::new(),
            conditions: vec![],
            output_references: vec![],
            effect_observations: vec![],
            outcome: OperationOutcome::Succeeded,
            error: None,
        })
    }
}

#[tokio::test]
async fn controls_require_original_native_authority_and_do_not_claim_execution_completion() {
    let runtime = Arc::new(InputRuntime::new());
    let host = demo(runtime.clone()).await;
    let reader = NextHost::local_context();
    let mut executor = reader.clone();
    executor.principal = Some(reader.caller.clone());
    executor.caller = CallerIdentity {
        kind: CallerKind::Agent,
        id: "executor-only".into(),
    };
    executor.scopes = BTreeSet::from(["workspace.run_r".into()]);
    let accepted = host
        .invoke_accepted(&executor, invocation("one-execution"))
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime.started.notified(),
    )
    .await
    .unwrap();
    let id = accepted.operation.operation_id.clone();
    let reply = |session: &str, request: &str, reply_id: &str, value: String| {
        HostRequest::RespondInput(RespondInput {
            session_id: session.into(),
            operation_id: id.clone(),
            request_id: request.into(),
            reply_id: reply_id.into(),
            value,
        })
    };
    let mut denied = executor.clone();
    denied.scopes.clear();
    assert!(matches!(
        host.dispatch(
            &denied,
            reply(
                runtime.session_id(),
                "native-request",
                "reply",
                "secret-answer".into()
            )
        )
        .await,
        Err(OperationError::AccessDenied { .. })
    ));
    assert!(matches!(
        host.dispatch(
            &denied,
            HostRequest::RequestCancellation {
                operation_id: id.clone(),
                only_if_pending: None
            }
        )
        .await,
        Err(OperationError::AccessDenied { .. })
    ));
    assert!(matches!(
        host.dispatch(
            &executor,
            reply(
                "old-session",
                "native-request",
                "reply",
                "secret-answer".into()
            )
        )
        .await,
        Err(OperationError::InvalidInput(_))
    ));
    for bad in [
        reply(
            runtime.session_id(),
            "native-request",
            "",
            "secret-answer".into(),
        ),
        reply(
            runtime.session_id(),
            "native-request",
            "reply",
            "秘密".repeat(12000),
        ),
        reply(
            runtime.session_id(),
            "native-request",
            "reply",
            "secret-answer\0".into(),
        ),
    ] {
        let error = host.dispatch(&executor, bad).await.unwrap_err();
        assert!(matches!(error, OperationError::InvalidInput(_)));
        assert!(!error.to_string().contains("secret-answer"));
        assert!(!error.to_string().contains("秘密"));
    }
    assert_eq!(runtime.deliveries.load(Ordering::SeqCst), 0);
    let mut foreign = executor.clone();
    foreign.principal = Some(CallerIdentity {
        kind: CallerKind::Human,
        id: "another-user".into(),
    });
    assert!(matches!(
        host.dispatch(
            &foreign,
            reply(
                runtime.session_id(),
                "native-request",
                "reply",
                "secret-answer".into()
            )
        )
        .await,
        Err(OperationError::NotFound(_))
    ));
    let cancellation = host
        .dispatch(
            &executor,
            HostRequest::RequestCancellation {
                operation_id: id.clone(),
                only_if_pending: Some(false),
            },
        )
        .await
        .unwrap();
    let cancellation: CancellationRequestOutcome = serde_json::from_value(cancellation).unwrap();
    assert!(cancellation.accepted);
    assert_eq!(cancellation.operation.status, OperationStatus::Running);
    assert!(cancellation.operation.cancellation_requested);
    assert!(cancellation.operation.next_reads.unwrap().is_empty());
    assert_eq!(cancellation.operation.operation.caller, executor.caller);
    let repeated = host.request_cancellation(&executor, &id).await.unwrap();
    assert_eq!(repeated.operation.status, OperationStatus::Running);
    assert!(matches!(
        host.dispatch(
            &executor,
            HostRequest::RequestCancellation {
                operation_id: id.clone(),
                only_if_pending: Some(true)
            }
        )
        .await,
        Err(OperationError::InvalidInput(_))
    ));
    assert_eq!(
        host.dispatch(
            &executor,
            reply(
                runtime.session_id(),
                "native-request",
                "reply",
                "secret-answer".into()
            )
        )
        .await
        .unwrap(),
        json!({"submitted":true})
    );
    assert!(
        host.dispatch(
            &executor,
            reply(
                runtime.session_id(),
                "native-request",
                "reply",
                "secret-answer".into()
            )
        )
        .await
        .is_err()
    );
    assert_eq!(runtime.deliveries.load(Ordering::SeqCst), 1);
    assert_eq!(
        host.get_operation(&reader, &id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Running
    );
    let events = host.outbox(&reader, 0, 100).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.topic == "operation.cancellation_requested")
            .count(),
        1
    );
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("secret-answer")
    );
    runtime.release.notify_one();
    host.drain().await;
    // Runtime completed before acknowledging cancellation; keep actual truth.
    assert_eq!(
        host.get_operation(&reader, &id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Succeeded
    );
    assert_eq!(runtime.executions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn event_byte_limits_resume_without_omissions_and_invalid_lifecycle_data_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("journal.sqlite");
    let host = NextHost::open_demo(&database).await.unwrap();
    let context = NextHost::local_context();
    let original = host
        .invoke(&context, invocation("event-budget"))
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(&database).unwrap();
    // Inject large historical owner evidence to exercise the actual durable
    // port budget and validator, without fabricating scientific completion.
    let last: u64 = connection
        .query_row("SELECT MAX(sequence) FROM outbox", [], |row| row.get(0))
        .unwrap();
    for index in 0..3 {
        connection.execute("INSERT INTO outbox(message_id,operation_id,topic,payload_json,created_at_ms) VALUES(?1,?2,'workspace.history_evidence',?3,1)",
            rusqlite::params![format!("large-{index}"), original.operation.operation_id.as_str(), json!({"text":"x".repeat(120 * 1024)}).to_string()]).unwrap();
    }
    let first = query(
        &host,
        &context,
        "operation.events",
        json!({"after_sequence":last,"limit":100}),
    )
    .await
    .unwrap();
    let page: OperationEventsPage = serde_json::from_value(first.data.unwrap()).unwrap();
    assert_eq!(page.events.len(), 2);
    assert!(page.has_more);
    assert_eq!(page.limit_reason.as_deref(), Some("utf8_byte_limit"));
    assert!(serde_json::to_vec(&page).unwrap().len() <= OPERATION_EVENTS_PAGE_BYTES);
    let second: OperationEventsPage = serde_json::from_value(
        query(
            &host,
            &context,
            "operation.events",
            json!({"after_sequence":page.next_after_sequence,"limit":100}),
        )
        .await
        .unwrap()
        .data
        .unwrap(),
    )
    .unwrap();
    assert_eq!(second.events.len(), 1);
    assert!(!second.has_more);
    assert_eq!(second.events[0].sequence, page.next_after_sequence + 1);
    connection
        .execute(
            "UPDATE outbox SET payload_json = ?1 WHERE sequence = ?2",
            rusqlite::params![
                json!({"text":"x".repeat(300 * 1024)}).to_string(),
                second.next_after_sequence
            ],
        )
        .unwrap();
    assert!(matches!(
        query(
            &host,
            &context,
            "operation.events",
            json!({"after_sequence":page.next_after_sequence})
        )
        .await,
        Err(OperationError::BudgetExceeded(_))
    ));
    connection
        .execute(
            "UPDATE outbox SET payload_json = '{}' WHERE topic = 'operation.accepted'",
            [],
        )
        .unwrap();
    assert!(matches!(
        query(&host, &context, "operation.events", json!({"limit":1})).await,
        Err(OperationError::Contract(_))
    ));
    assert!(matches!(
        host.outbox(&context, 0, 1).await,
        Err(OperationError::Contract(_))
    ));
    connection
        .execute(
            "UPDATE operations SET output_json = '{}' WHERE operation_id = ?1",
            [original.operation.operation_id.as_str()],
        )
        .unwrap();
    assert!(matches!(
        host.get_operation(&context, &original.operation.operation_id)
            .await,
        Err(OperationError::Contract(_))
    ));
    assert!(matches!(
        host.request_cancellation(&context, &original.operation.operation_id)
            .await,
        Err(OperationError::Contract(_))
    ));
}

struct ComposedSchemaQuery {
    descriptor: CapabilityDescriptor,
    data: Value,
}
#[async_trait]
impl rho_operation::QueryHandler for ComposedSchemaQuery {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        Ok(arguments.clone())
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "test".into(),
                identity: "composed-contract".into(),
            },
            source: "deterministic-schema-fixture".into(),
            observed_at_ms: 1,
            status: QueryStatus::Ready,
            completeness: ObservationCompleteness::Complete,
            data: Some(self.data.clone()),
            notices: vec![],
            next_reads: vec![],
            diagnostics: vec![],
        })
    }
}

#[tokio::test]
async fn composed_payload_namespaces_preserve_conflicting_shapes_and_literal_reference_data() {
    let host = demo(Arc::new(DeterministicWorkspaceRuntime::default())).await;
    let mut descriptor = host
        .capabilities()
        .into_iter()
        .find(|descriptor| descriptor.capability.id == "operation.events")
        .unwrap();
    descriptor.capability = CapabilityRef::new("test.schema_envelope", 1).unwrap();
    descriptor.input_schema = json!({"type":"object","additionalProperties":false});
    descriptor.documentation.examples[0].arguments = json!({});
    descriptor.documentation.related_capabilities.clear();
    descriptor.documentation.preconditions.clear();
    descriptor.required_scopes.clear();
    let envelope = json!({"type":"object","properties":{
        "metadata":{"$ref":"#/$defs/Shared"},"retained":{"$ref":"#/$defs/rho_payload_0"},"data":{}
    },"required":["metadata","retained","data"],"additionalProperties":false,
    "$defs":{"Shared":{"type":"integer"},"rho_payload_0":{"const":"original"}}});
    let literal = json!({"$ref":"#/$defs/Shared","$id":"untrusted-data"});
    let payload = json!({"type":"object","properties":{
        "value":{"$ref":"#/$defs/Shared"},"literal":{"const":literal}
    },"required":["value","literal"],"additionalProperties":false,
    "$defs":{"Shared":{"type":"string"}}});
    descriptor.output_schema = payload_envelope(envelope, "data", payload);
    // A second payload receives a third namespace and cannot reuse the first.
    descriptor.output_schema = payload_envelope(
        descriptor.output_schema,
        "extra",
        json!({"$ref":"#/$defs/Shared","$defs":{"Shared":{"type":"boolean"}}}),
    );
    descriptor.output_schema["required"]
        .as_array_mut()
        .unwrap()
        .push(json!("extra"));
    let valid = json!({"metadata":7,"retained":"original","data":{"value":"payload","literal":literal},"extra":true});
    let mut bad_metadata = valid.clone();
    bad_metadata["metadata"] = json!("wrong outer type");
    let mut bad_data = valid.clone();
    bad_data["data"]["value"] = json!(7);
    let mut bad_extra = valid.clone();
    bad_extra["extra"] = json!("wrong second payload type");
    let mut bad_literal = valid.clone();
    bad_literal["data"]["literal"]["$ref"] = json!("#/$defs/rho_payload_1/$defs/Shared");
    for (data, expected_success) in [
        (valid, true),
        (bad_metadata, false),
        (bad_data, false),
        (bad_extra, false),
        (bad_literal, false),
    ] {
        let mut registry = rho_operation::CapabilityRegistry::new();
        registry
            .register_query(Arc::new(ComposedSchemaQuery {
                descriptor: descriptor.clone(),
                data,
            }))
            .unwrap();
        registry.validate_links().unwrap();
        let gateway = rho_operation::QueryGateway::new(Arc::new(registry));
        let result = gateway
            .query(
                &NextHost::local_context(),
                QueryRequest {
                    capability: descriptor.capability.clone(),
                    arguments: json!({}),
                },
            )
            .await;
        if expected_success {
            result.unwrap();
        } else {
            assert!(matches!(result, Err(OperationError::Contract(_))));
        }
    }
}

#[tokio::test]
async fn commit_recovery_ports_preserve_native_result_authority_and_do_not_rerun() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("journal.sqlite");
    let journal = Arc::new(SqliteOperationJournal::open(&path).unwrap());
    let runtime = Arc::new(DeterministicWorkspaceRuntime::default());
    let host = NextHost::with_components(journal.clone(),runtime.clone(),Arc::new(SystemClock),Arc::new(UuidOperationIdGenerator)).await.unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON operations WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END;").unwrap();
    let context = NextHost::local_context();
    let error = host.invoke(&context,invocation("commit-once")).await.unwrap_err();
    let OperationError::CommitPending {operation_id,..} = error else { panic!("expected original uncommitted result") };
    assert_eq!(runtime.execution_count(),1);
    assert!(!host.is_idle(), "pending result must prevent a clean quit from dropping its lease");
    assert!(host.prepare_workbench_quit().await.is_err());
    let snapshot = query(&host,&context,"operation.commit_status",json!({"operation_id":operation_id})).await.unwrap();
    let status: OperationCommitStatus = serde_json::from_value(snapshot.data.unwrap()).unwrap();
    assert_eq!(status.phase,OperationCommitPhase::Durable);
    let args = ReconcileOperationCommit {reference:status.reference.unwrap()};
    let mut read_only=context.clone(); read_only.scopes=BTreeSet::from(["operation.read".into()]);
    assert!(matches!(host.dispatch(&read_only,HostRequest::ReconcileCommit(args.clone())).await,Err(OperationError::AccessDenied{..})));
    connection.execute_batch("DROP TRIGGER fail_terminal").unwrap();
    let first = host.dispatch(&context,HostRequest::ReconcileCommit(args.clone())).await.unwrap();
    let terminal: OperationRecord = serde_json::from_value(first.clone()).unwrap();
    assert_eq!(terminal.status,OperationStatus::Succeeded);
    assert!(host.is_idle());
    let checkpoint = query(&host,&context,"operation.events",json!({"after_sequence":0,"limit":100})).await.unwrap();
    let repeated = host.dispatch(&context,HostRequest::ReconcileCommit(args)).await.unwrap();
    assert_eq!(first,repeated);
    assert_eq!(query(&host,&context,"operation.events",json!({"after_sequence":0,"limit":100})).await.unwrap().data,checkpoint.data);
    assert_eq!(runtime.execution_count(),1);
    let status = query(&host,&context,"operation.commit_status",json!({"operation_id":operation_id})).await.unwrap();
    assert_eq!(status.data.unwrap()["phase"],"committed");
    assert_eq!(host.invoke(&context,invocation("commit-once")).await.unwrap().operation.operation_id,operation_id);
}
