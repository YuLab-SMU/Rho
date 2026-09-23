use super::*;
use rho_contract::*;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct JournalState {
    records: BTreeMap<OperationId, OperationRecord>,
    plans: Vec<CommitPlan>,
    recovery_reads: usize,
}
#[derive(Default)]
struct TestJournal(Mutex<JournalState>);
#[async_trait]
impl OperationJournal for TestJournal {
    async fn events_checkpoint(
        &self,
        _: &str,
        _: &CallerIdentity,
    ) -> Result<OperationEventsCheckpoint, OperationError> {
        Ok(OperationEventsCheckpoint { sequence: 0 })
    }
    async fn admit(&self, operation: &Operation) -> Result<Admission, OperationError> {
        let mut state = self.0.lock().unwrap();
        if let Some(record) = state.records.values().find(|r| {
            r.operation.caller == operation.caller
                && r.operation.client_request_id == operation.client_request_id
                && r.operation.idempotency_scope == operation.idempotency_scope
        }) {
            return if record.operation.same_request(operation) {
                Ok(Admission::Existing(record.clone()))
            } else {
                Err(OperationError::IdempotencyConflict)
            };
        }
        let record = OperationRecord {
            operation: operation.clone(),
            status: OperationStatus::Accepted,
            outcome: None,
            output: None,
            error: None,
            recovery: None,
            cancellation_requested: false,
            updated_at_ms: operation.accepted_at_ms,
            next_reads: None,
            diagnostics: None,
        };
        state
            .records
            .insert(operation.operation_id.clone(), record.clone());
        Ok(Admission::New(record))
    }
    async fn mark_running(
        &self,
        id: &OperationId,
        at: i64,
    ) -> Result<OperationRecord, OperationError> {
        let mut state = self.0.lock().unwrap();
        let record = state.records.get_mut(id).unwrap();
        record.status = OperationStatus::Running;
        record.updated_at_ms = at;
        Ok(record.clone())
    }
    async fn commit(
        &self,
        id: &OperationId,
        plan: &CommitPlan,
        at: i64,
    ) -> Result<OperationRecord, OperationError> {
        let mut state = self.0.lock().unwrap();
        let record = state.records.get_mut(id).unwrap();
        assert!(
            !record.status.is_terminal(),
            "a terminal record must never be recommitted"
        );
        record.status = plan.outcome.status();
        record.outcome = Some(plan.outcome);
        record.output = plan.output.clone();
        record.error = plan.error.clone();
        record.recovery = plan.recovery.clone();
        record.updated_at_ms = at;
        let result = record.clone();
        state.plans.push(plan.clone());
        Ok(result)
    }
    async fn get(&self, id: &OperationId) -> Result<Option<OperationRecord>, OperationError> {
        Ok(self.0.lock().unwrap().records.get(id).cloned())
    }
    async fn get_request(
        &self,
        caller: &CallerIdentity,
        principal: &CallerIdentity,
        project: Option<&str>,
        client_request_id: &str,
    ) -> Result<Option<OperationRecord>, OperationError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .records
            .values()
            .find(|r| {
                &r.operation.caller == caller
                    && r.operation.principal() == principal
                    && r.operation.client_request_id == client_request_id
                    && project
                        .is_none_or(|scope| r.operation.idempotency_scope.as_deref() == Some(scope))
            })
            .cloned())
    }
    async fn read_evidence(
        &self,
        args: &OperationReadEvidenceArguments,
    ) -> Result<OperationEvidencePage, OperationError> {
        let state = self.0.lock().unwrap();
        let evidence = state
            .plans
            .iter()
            .filter_map(|p| p.uncommitted_evidence.as_ref())
            .find(|e| e.reference == args.reference)
            .ok_or_else(|| OperationError::NotFound("evidence".into()))?;
        let end = (args.offset + args.limit_bytes as u64).min(args.reference.byte_size);
        Ok(OperationEvidencePage {
            reference: args.reference.clone(),
            offset: args.offset,
            bytes: evidence.bytes[args.offset as usize..end as usize].to_vec(),
            next_offset: (end < args.reference.byte_size).then_some(end),
        })
    }
    async fn request_cancellation(
        &self,
        id: &OperationId,
        _: i64,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        let mut state = self.0.lock().unwrap();
        let record = state.records.get_mut(id).unwrap();
        let accepted = !record.status.is_terminal();
        if accepted {
            record.cancellation_requested = true;
        }
        Ok(CancellationRequestOutcome {
            accepted,
            operation: record.clone(),
        })
    }
    async fn recover_incomplete(&self, _: i64) -> Result<Vec<OperationRecord>, OperationError> {
        self.0.lock().unwrap().recovery_reads += 1;
        Ok(vec![])
    }
    async fn events(&self, _: &OperationId) -> Result<Vec<OperationEventRecord>, OperationError> {
        Ok(vec![])
    }
    async fn outbox(
        &self,
        _: Option<&str>,
        _: &CallerIdentity,
        _: u64,
        _: usize,
    ) -> Result<Vec<OutboxRecord>, OperationError> {
        Ok(vec![])
    }
    async fn facts_for_operation(
        &self,
        _: &OperationId,
    ) -> Result<Vec<StoredDomainFact>, OperationError> {
        Ok(vec![])
    }
    async fn successful_outputs(
        &self,
        _: &str,
        _: &CapabilityRef,
        _: Option<&str>,
        _: usize,
    ) -> Result<OperationOutputPage, OperationError> {
        Ok(OperationOutputPage {
            outputs: vec![],
            next_id: None,
        })
    }
}
fn context() -> CallContext {
    CallContext {
        caller: CallerIdentity {
            kind: CallerKind::Agent,
            id: "agent-1".into(),
        },
        principal: Some(CallerIdentity {
            kind: CallerKind::Human,
            id: "principal-1".into(),
        }),
        scopes: BTreeSet::from([
            "operation.read".into(),
            "test.run".into(),
            "test.read".into(),
        ]),
        connection_id: "test-connection".into(),
        correlation_id: None,
        causation_id: None,
        trace_parent: None,
    }
}
fn input_schema() -> Value {
    json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false})
}
fn descriptor(id: &str, kind: CapabilityKind) -> CapabilityDescriptor {
    let mut documentation = rho_contract::builtin_documentation("host.overview");
    documentation.examples[0].arguments = json!({"value":1});
    CapabilityDescriptor {
        kind,
        capability: CapabilityRef::new(id, 1).unwrap(),
        domain: "test".into(),
        input_schema: input_schema(),
        output_schema: input_schema(),
        recovery_schema: json!({"type":"object","properties":{"marker":{"type":"string"}},"required":["marker"],"additionalProperties":false}),
        documentation,
        required_scopes: BTreeSet::from([if kind == CapabilityKind::Operation {
            "test.run"
        } else {
            "test.read"
        }
        .into()]),
        potential_effects: if kind == CapabilityKind::Operation {
            BTreeSet::from([EffectHint::MayMutateRuntime])
        } else {
            BTreeSet::new()
        },
        idempotency: IdempotencyClass::CallerScoped,
        retry: RetryClass::Never,
        cancellation: CancellationClass::Cooperative,
    }
}
struct TestHandler {
    descriptor: CapabilityDescriptor,
    normalize_calls: AtomicUsize,
    execute_calls: AtomicUsize,
    corrupt_normalized: bool,
    plan: CommitPlan,
    error: Option<HandlerError>,
    started: Option<Arc<tokio::sync::Notify>>,
    finish: Option<Arc<tokio::sync::Notify>>,
}

fn dynamic_handler(value: i64) -> TestHandler {
    let mut handler = TestHandler::new(CommitPlan::succeeded(json!({"value":value})));
    handler.descriptor.documentation.related_capabilities.clear();
    handler
}

#[test]
fn dynamic_registration_is_atomic_owned_and_compare_and_swap() {
    let registry = CapabilityRegistry::new();
    let first = registry.replace_batch("plugin.test", None, ContributionBatch {
        operations: vec![Arc::new(dynamic_handler(1))], queries: vec![],
    }).unwrap();
    let before = registry.snapshot();
    let mut bad = TestQuery::new("test.partial");
    bad.descriptor.input_schema = json!({"$ref":"https://invalid.test/schema"});
    assert!(registry.replace_batch("plugin.test", Some(&first), ContributionBatch {
        operations:vec![Arc::new(dynamic_handler(2))], queries:vec![Arc::new(bad)],
    }).is_err());
    assert!(Arc::ptr_eq(&before, &registry.snapshot()));
    assert!(registry.query_handler(&CapabilityRef::new("test.partial",1).unwrap()).is_err());
    assert!(registry.replace_batch("another.owner", None, ContributionBatch {
        operations:vec![Arc::new(dynamic_handler(2))],queries:vec![],
    }).is_err());
    let removed = registry.remove_batch(&first).unwrap();
    assert!(registry.descriptors().is_empty());
    assert!(registry.remove_batch(&first).is_err());
    let mut changed = dynamic_handler(3);
    changed.descriptor.output_schema = json!({"type":"string"});
    assert!(registry.replace_batch("plugin.test", Some(&removed), ContributionBatch {
        operations:vec![Arc::new(changed)],queries:vec![],
    }).is_err());
    assert!(registry.descriptors().is_empty());
    let restored = registry.replace_batch("plugin.test", Some(&removed), ContributionBatch {
        operations:vec![Arc::new(dynamic_handler(4))],queries:vec![],
    }).unwrap();
    assert_eq!(restored.generation, removed.generation + 1);
    // Existing observations retain a consistent original handler/schema pair.
    assert_eq!(before.descriptors(), registry.descriptors());
}

#[tokio::test]
async fn accepted_operation_retains_handler_contract_and_cancellation_after_unregistration() {
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let mut handler = dynamic_handler(17);
    handler.started = Some(started.clone()); handler.finish = Some(finish.clone());
    let journal = Arc::new(TestJournal::default());
    let mut registry = CapabilityRegistry::new();
    register_get(&mut registry, journal.clone(), Some("/project".into()));
    let registry = Arc::new(registry);
    let registration = registry.replace_batch("plugin.test", None, ContributionBatch {
        operations:vec![Arc::new(handler)],queries:vec![],
    }).unwrap();
    let gateway = Arc::new(gateway(registry.clone(), journal.clone()));
    let runner = gateway.clone();
    let running = tokio::spawn(async move { runner.invoke(&context(), invocation(json!({"value":1}))).await });
    started.notified().await;
    let operation = journal.0.lock().unwrap().records.values().next().unwrap().operation.operation_id.clone();
    registry.remove_batch(&registration).unwrap();
    assert!(registry.handler(&CapabilityRef::new("test.execute",1).unwrap()).is_err());
    let cancellation = gateway.request_cancellation(&context(), &operation).await.unwrap();
    assert!(cancellation.accepted); assert_eq!(cancellation.operation.status, OperationStatus::Running);
    finish.notify_one();
    let result = running.await.unwrap().unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded); assert_eq!(result.output, Some(json!({"value":17})));
    let read = QueryGateway::new(registry).query(&context(), query("operation.get", json!({"operation_id":operation}))).await.unwrap();
    let data: OperationGetResult = serde_json::from_value(read.data.unwrap()).unwrap();
    assert_eq!(data.record.unwrap().operation.operation_id, operation);
    assert!(matches!(data.output_contract.unwrap().availability, RecordedContractAvailability::OwnerUnavailableInThisHost));
    assert_eq!(journal.0.lock().unwrap().plans.len(), 1);
}

struct DelayedQuery { base: TestQuery, started: Arc<tokio::sync::Notify>, finish: Arc<tokio::sync::Notify> }
#[async_trait]
impl QueryHandler for DelayedQuery {
    fn descriptor(&self) -> &CapabilityDescriptor { self.base.descriptor() }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> { self.base.normalize_arguments(arguments) }
    async fn query(&self, arguments: &Value) -> Result<QuerySnapshot, OperationError> {
        self.started.notify_one(); self.finish.notified().await; self.base.query(arguments).await
    }
}
#[tokio::test]
async fn query_in_flight_uses_one_registry_snapshot_through_result_validation() {
    let started = Arc::new(tokio::sync::Notify::new()); let finish = Arc::new(tokio::sync::Notify::new());
    let mut base = TestQuery::new("test.delayed"); base.descriptor.documentation.related_capabilities.clear();
    let registry = Arc::new(CapabilityRegistry::new());
    let registration = registry.replace_batch("plugin.query", None, ContributionBatch { operations:vec![],queries:vec![Arc::new(DelayedQuery {
        base, started:started.clone(), finish:finish.clone(),
    })]}).unwrap();
    let reader = QueryGateway::new(registry.clone());
    let reading = tokio::spawn(async move { reader.query(&context(), query("test.delayed",json!({"value":1}))).await });
    started.notified().await;
    registry.remove_batch(&registration).unwrap();
    finish.notify_one();
    assert_eq!(reading.await.unwrap().unwrap().data, Some(json!({"value":1})));
    assert!(QueryGateway::new(registry).query(&context(), query("test.delayed", json!({"value":1}))).await.is_err());
}

#[tokio::test]
async fn captured_request_returns_original_after_provider_removal_without_preparation_or_replay() {
    let registry = Arc::new(CapabilityRegistry::new());
    let handler = Arc::new(dynamic_handler(23));
    let registration = registry.replace_batch("plugin.original", None, ContributionBatch {operations:vec![handler.clone()],queries:vec![]}).unwrap();
    let journal = Arc::new(TestJournal::default()); let gateway = gateway(registry.clone(), journal.clone());
    let original = gateway.invoke(&context(), invocation(json!({"value":1}))).await.unwrap();
    assert_eq!(original.operation.admission.as_ref().unwrap().descriptor.capability, original.operation.capability);
    registry.remove_batch(&registration).unwrap();
    let repeated = gateway.invoke(&context(), invocation(json!({"value":1}))).await.unwrap();
    assert_eq!(repeated.operation.operation_id, original.operation.operation_id);
    assert_eq!(handler.execute_calls.load(Ordering::SeqCst), 1);
    let mut denied = context(); denied.scopes.remove("test.run");
    assert!(matches!(gateway.invoke(&denied, invocation(json!({"value":1}))).await, Err(OperationError::AccessDenied {..})));
    assert_eq!(journal.0.lock().unwrap().plans.len(), 1);
}

struct BindingHandler { base: TestHandler, bound: Arc<TestHandler>, reject: bool }
#[async_trait]
impl OperationHandler for BindingHandler {
    fn descriptor(&self) -> &CapabilityDescriptor { self.base.descriptor() }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> { self.base.normalize_arguments(arguments) }
    fn resolve_target(&self, arguments: &Value) -> Result<TargetRef, OperationError> { self.base.resolve_target(arguments) }
    async fn bind(&self, _: &CallContext, _: &Value, _: &[Precondition]) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        if self.reject { Err(OperationError::InvalidInput("native preflight rejected the request".into())) }
        else { Ok(Some(self.bound.clone())) }
    }
    async fn execute(&self, _: &Operation) -> Result<CommitPlan, HandlerError> { panic!("unbound routing handler must never execute") }
}
#[tokio::test]
async fn preparation_freezes_the_owner_before_admission_and_cannot_expand_its_authority() {
    for (reject, expand, succeeds) in [(false,false,true),(true,false,false),(false,true,false)] {
        let mut bound = dynamic_handler(37);
        if expand { bound.descriptor.required_scopes.clear(); }
        let bound = Arc::new(bound);
        let registry = Arc::new(CapabilityRegistry::new());
        registry.replace_batch("plugin.bound", None, ContributionBatch {operations:vec![Arc::new(BindingHandler {
            base:dynamic_handler(0),bound:bound.clone(),reject,
        })],queries:vec![]}).unwrap();
        let journal = Arc::new(TestJournal::default());
        let result = gateway(registry,journal.clone()).invoke(&context(),invocation(json!({"value":1}))).await;
        if succeeds { assert_eq!(result.unwrap().output, Some(json!({"value":37}))); }
        else { assert!(result.is_err()); assert!(journal.0.lock().unwrap().records.is_empty()); }
        assert_eq!(bound.execute_calls.load(Ordering::SeqCst), usize::from(succeeds));
    }
}
impl TestHandler {
    fn new(plan: CommitPlan) -> Self {
        Self {
            descriptor: descriptor("test.execute", CapabilityKind::Operation),
            normalize_calls: AtomicUsize::new(0),
            execute_calls: AtomicUsize::new(0),
            corrupt_normalized: false,
            plan,
            error: None,
            started: None,
            finish: None,
        }
    }
}
#[async_trait]
impl OperationHandler for TestHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some("/project".into())
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        self.normalize_calls.fetch_add(1, Ordering::SeqCst);
        if self.corrupt_normalized && arguments["value"] == json!(2) {
            Ok(json!({"value":"invalid after normalization"}))
        } else {
            Ok(arguments.clone())
        }
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(TargetRef {
            kind: "workspace".into(),
            identity: "native-1".into(),
        })
    }
    async fn execute(&self, _: &Operation) -> Result<CommitPlan, HandlerError> {
        self.execute_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(started) = &self.started {
            started.notify_one();
        }
        if let Some(finish) = &self.finish {
            finish.notified().await;
        }
        if let Some(error) = &self.error {
            Err(error.clone())
        } else {
            Ok(self.plan.clone())
        }
    }
}
struct TestQuery {
    descriptor: CapabilityDescriptor,
    data: Value,
    reads: Vec<NextRead>,
    corrupt_normalized: bool,
    calls: AtomicUsize,
}
impl TestQuery {
    fn new(id: &str) -> Self {
        Self {
            descriptor: descriptor(id, CapabilityKind::Query),
            data: json!({"value":1}),
            reads: vec![],
            corrupt_normalized: false,
            calls: AtomicUsize::new(0),
        }
    }
}
#[async_trait]
impl QueryHandler for TestQuery {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        Ok(
            if self.corrupt_normalized && arguments["value"] == json!(2) {
                json!({"value":"invalid normalized read"})
            } else {
                arguments.clone()
            },
        )
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "project".into(),
                identity: "/project".into(),
            },
            source: "test-owner".into(),
            observed_at_ms: 1,
            status: QueryStatus::Ready,
            completeness: ObservationCompleteness::Complete,
            data: Some(self.data.clone()),
            notices: vec![],
            next_reads: self.reads.clone(),
            diagnostics: vec![],
        })
    }
}
fn invocation(value: Value) -> Invocation {
    Invocation {
        client_request_id: "request-1".into(),
        capability: CapabilityRef::new("test.execute", 1).unwrap(),
        arguments: value,
        preconditions: vec![],
    }
}
fn query(id: &str, arguments: Value) -> QueryRequest {
    QueryRequest {
        capability: CapabilityRef::new(id, 1).unwrap(),
        arguments,
    }
}
fn gateway(registry: Arc<CapabilityRegistry>, journal: Arc<TestJournal>) -> OperationGateway {
    OperationGateway::new(
        registry,
        journal,
        Arc::new(SystemClock),
        Arc::new(UuidOperationIdGenerator),
    )
    .with_project_scope(Some("/project".into()))
}
fn register_get(
    registry: &mut CapabilityRegistry,
    journal: Arc<TestJournal>,
    project: Option<String>,
) {
    let handler = OperationGetHandler::new(journal, project, &registry.descriptors()).unwrap();
    registry.register_query(Arc::new(handler)).unwrap();
}

#[tokio::test]
async fn raw_and_normalized_inputs_are_checked_before_admission_or_native_effects() {
    let mut handler = TestHandler::new(CommitPlan::succeeded(json!({"value":1})));
    handler.corrupt_normalized = true;
    let handler = Arc::new(handler);
    let mut registry = CapabilityRegistry::new();
    registry.register(handler.clone()).unwrap();
    let journal = Arc::new(TestJournal::default());
    let gateway = gateway(Arc::new(registry), journal.clone());
    let normalizations = handler.normalize_calls.load(Ordering::SeqCst);
    assert!(matches!(
        gateway
            .invoke(&context(), invocation(json!({"value":"bad raw value"})))
            .await,
        Err(OperationError::InvalidInput(_))
    ));
    assert_eq!(
        handler.normalize_calls.load(Ordering::SeqCst),
        normalizations
    );
    assert!(matches!(
        gateway
            .invoke(&context(), invocation(json!({"value":2})))
            .await,
        Err(OperationError::InvalidInput(_))
    ));
    assert!(journal.0.lock().unwrap().records.is_empty());
    assert_eq!(handler.execute_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_malformed_owner_result_retains_every_candidate_value_without_committing_its_facts() {
    let mut candidate = CommitPlan::succeeded(json!({"wrong":"native output"}));
    candidate.recovery = Some(json!({"unexpected":"native marker"}));
    candidate.facts.push(DomainFactMutation {
        domain: "test".into(),
        schema: "test.fact".into(),
        key: "native-key".into(),
        value: json!({"raw":"fact evidence"}),
    });
    candidate.events.push(PlannedEvent {
        kind: "native-event".into(),
        payload: json!({"raw":"event evidence"}),
    });
    candidate.effect_observations.push(EffectObservation {
        kind: "runtime".into(),
        source: "native".into(),
        detail: json!({"pid":42}),
        observed_at_ms: 1,
        completeness: ObservationCompleteness::Partial,
    });
    let handler = Arc::new(TestHandler::new(candidate.clone()));
    let journal = Arc::new(TestJournal::default());
    let mut registry = CapabilityRegistry::new();
    registry.register(handler.clone()).unwrap();
    register_get(&mut registry, journal.clone(), Some("/project".into()));
    let advertised = registry
        .descriptor(&CapabilityRef::new("test.execute", 1).unwrap())
        .unwrap()
        .recovery_schema
        .clone();
    let gateway = gateway(Arc::new(registry), journal.clone());
    let call = invocation(json!({"value":1}));
    let result = gateway.invoke(&context(), call.clone()).await.unwrap();
    assert_eq!(result.status, OperationStatus::Uncertain);
    assert!(result.output.is_none());
    let recovery: ContractFailureRecovery =
        serde_json::from_value(result.recovery.clone().unwrap()).unwrap();
    let UncommittedCandidate::Inline { result: original } = &recovery.candidate else {
        panic!()
    };
    assert_eq!(original.output, candidate.output);
    assert_eq!(original.recovery, candidate.recovery);
    assert_eq!(original.facts[0].value, candidate.facts[0].value);
    assert_eq!(original.events[0].payload, candidate.events[0].payload);
    assert_eq!(
        original.effect_observations[0].detail,
        candidate.effect_observations[0].detail
    );
    assert!(!recovery.automatic_reexecution);
    assert!(recovery.execution_started);
    assert_eq!(recovery.violations.len(), 2);
    jsonschema::options()
        .offline()
        .build(&advertised)
        .unwrap()
        .validate(result.recovery.as_ref().unwrap())
        .unwrap();
    {
        let stored = &journal.0.lock().unwrap().plans[0];
        assert!(stored.facts.is_empty());
        assert!(stored.events.is_empty());
        assert!(stored.effect_observations.is_empty());
    }
    assert!(
        result
            .diagnostics
            .as_ref()
            .unwrap()
            .iter()
            .any(|d| d.code == DiagnosticCode::ContractViolation)
    );
    let repeated = gateway.invoke(&context(), call).await.unwrap();
    assert_eq!(result, repeated);
    assert_eq!(handler.execute_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_and_shared_recovery_refs_are_valid_without_colliding_definition_names() {
    let mut plan = CommitPlan::succeeded(json!({"value":7}));
    plan.recovery = Some(json!({"marker":"native root"}));
    let mut handler = TestHandler::new(plan);
    handler.descriptor.output_schema = json!({"type":"object","properties":{"value":{"$ref":"#/$defs/Shared"}},"required":["value"],"additionalProperties":false,"$defs":{"Shared":{"type":"integer"}}});
    handler.descriptor.recovery_schema = json!({"type":"object","properties":{"marker":{"$ref":"#/$defs/Shared"}},"required":["marker"],"additionalProperties":false,"$defs":{"Shared":{"type":"string"}}});
    let mut registry = CapabilityRegistry::new();
    registry.register(Arc::new(handler)).unwrap();
    let journal = Arc::new(TestJournal::default());
    register_get(&mut registry, journal.clone(), Some("/project".into()));
    let registry = Arc::new(registry);
    let gateway = gateway(registry.clone(), journal);
    let result = gateway
        .invoke(&context(), invocation(json!({"value":1})))
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded);
    let inspected = QueryGateway::new(registry)
        .query(
            &context(),
            query(
                "operation.get",
                json!({"operation_id":result.operation.operation_id}),
            ),
        )
        .await
        .unwrap();
    let payload: OperationGetResult = serde_json::from_value(inspected.data.unwrap()).unwrap();
    assert_eq!(payload.record.unwrap().output, Some(json!({"value":7})));
}

#[tokio::test]
async fn a_native_uncertain_error_has_concrete_shared_recovery_not_a_contract_fault() {
    let mut handler = TestHandler::new(CommitPlan::succeeded(json!({"value":1})));
    handler.error = Some(HandlerError::after_possible_effect(
        "native acknowledgement lost",
        None,
    ));
    let mut registry = CapabilityRegistry::new();
    registry.register(Arc::new(handler)).unwrap();
    let journal = Arc::new(TestJournal::default());
    let result = gateway(Arc::new(registry), journal)
        .invoke(&context(), invocation(json!({"value":1})))
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Uncertain);
    assert_eq!(
        result.recovery,
        Some(serde_json::to_value(ObserveOwnerRecovery::default()).unwrap())
    );
    assert!(result.next_reads.unwrap().is_empty());
    assert!(
        result
            .diagnostics
            .unwrap()
            .iter()
            .all(|d| d.code != DiagnosticCode::ContractViolation)
    );
}

#[tokio::test]
async fn record_get_is_read_only_project_principal_scoped_and_keeps_metadata_out_of_storage() {
    let handler = Arc::new(TestHandler::new(CommitPlan::succeeded(json!({"value":1}))));
    let journal = Arc::new(TestJournal::default());
    let mut registry = CapabilityRegistry::new();
    registry.register(handler.clone()).unwrap();
    register_get(&mut registry, journal.clone(), Some("/project".into()));
    let registry = Arc::new(registry);
    let gateway = gateway(registry.clone(), journal.clone());
    let result = gateway
        .invoke(&context(), invocation(json!({"value":1})))
        .await
        .unwrap();
    let raw = journal
        .get(&result.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert!(raw.next_reads.is_none());
    assert!(raw.diagnostics.is_none());
    let reads = result.next_reads.as_ref().unwrap();
    assert_eq!(reads[0].capability.id, "operation.get");
    let same = gateway
        .get_operation(&context(), &result.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(same.next_reads, result.next_reads);
    let query_gateway = QueryGateway::new(registry);
    let request = query(
        "operation.get",
        json!({"operation_id":result.operation.operation_id}),
    );
    let page = query_gateway
        .query(&context(), request.clone())
        .await
        .unwrap();
    let value: OperationGetResult = serde_json::from_value(page.data.unwrap()).unwrap();
    assert!(matches!(
        value.output_contract.unwrap().availability,
        RecordedContractAvailability::Registered
    ));
    let mut other = context();
    other.principal.as_mut().unwrap().id = "different account".replace(' ', "-");
    let page = query_gateway.query(&other, request).await.unwrap();
    let value: OperationGetResult = serde_json::from_value(page.data.unwrap()).unwrap();
    assert!(value.record.is_none());
    assert!(value.output_contract.is_none());
    assert_eq!(handler.execute_calls.load(Ordering::SeqCst), 1);
    assert_eq!(journal.0.lock().unwrap().recovery_reads, 0);
}

#[tokio::test]
async fn historical_records_remain_readable_when_the_native_owner_is_not_registered() {
    let journal = Arc::new(TestJournal::default());
    let mut source = CapabilityRegistry::new();
    source
        .register(Arc::new(TestHandler::new(CommitPlan::succeeded(
            json!({"value":3}),
        ))))
        .unwrap();
    let record = gateway(Arc::new(source), journal.clone())
        .invoke(&context(), invocation(json!({"value":1})))
        .await
        .unwrap();
    let mut readonly = CapabilityRegistry::new();
    register_get(&mut readonly, journal.clone(), None);
    let page = QueryGateway::new(Arc::new(readonly))
        .query(
            &context(),
            query(
                "operation.get",
                json!({"operation_id":record.operation.operation_id}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(page.target.kind, "operation");
    let result: OperationGetResult = serde_json::from_value(page.data.unwrap()).unwrap();
    assert!(matches!(
        result.output_contract.unwrap().availability,
        RecordedContractAvailability::OwnerUnavailableInThisHost
    ));
    assert_eq!(result.record.unwrap().output, record.output);
    assert_eq!(journal.0.lock().unwrap().recovery_reads, 0);
}

#[tokio::test]
async fn accepted_running_and_cancellation_requested_are_not_reported_as_stopped() {
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let mut handler = TestHandler::new(CommitPlan::succeeded(json!({"value":1})));
    handler.started = Some(started.clone());
    handler.finish = Some(finish.clone());
    let journal = Arc::new(TestJournal::default());
    let mut registry = CapabilityRegistry::new();
    registry.register(Arc::new(handler)).unwrap();
    register_get(&mut registry, journal.clone(), Some("/project".into()));
    let gateway = Arc::new(gateway(Arc::new(registry), journal));
    let (tx, rx) = tokio::sync::oneshot::channel();
    let task_gateway = gateway.clone();
    let task = tokio::spawn(async move {
        task_gateway
            .invoke_notifying(&context(), invocation(json!({"value":1})), Some(tx))
            .await
    });
    let accepted = rx.await.unwrap();
    assert_eq!(accepted.status, OperationStatus::Accepted);
    assert!(
        accepted
            .next_reads
            .unwrap()
            .iter()
            .any(|r| r.capability.id == "operation.get")
    );
    started.notified().await;
    let cancelled = gateway
        .request_cancellation(&context(), &accepted.operation.operation_id)
        .await
        .unwrap();
    assert!(cancelled.accepted);
    assert_eq!(cancelled.operation.status, OperationStatus::Running);
    assert!(cancelled.operation.cancellation_requested);
    assert!(
        cancelled
            .operation
            .diagnostics
            .unwrap()
            .iter()
            .any(|d| d.message.contains("has not confirmed"))
    );
    finish.notify_one();
    assert_eq!(
        task.await.unwrap().unwrap().status,
        OperationStatus::Succeeded
    );
}

#[tokio::test]
async fn query_inputs_outputs_and_read_links_are_validated_by_the_actual_gateway() {
    let mut source = TestQuery::new("test.source");
    source.corrupt_normalized = true;
    let source = Arc::new(source);
    let mut registry = CapabilityRegistry::new();
    registry.register_query(source.clone()).unwrap();
    let gateway = QueryGateway::new(Arc::new(registry));
    assert!(
        gateway
            .query(&context(), query("test.source", json!({"value":"wrong"})))
            .await
            .is_err()
    );
    assert!(
        gateway
            .query(&context(), query("test.source", json!({"value":2})))
            .await
            .is_err()
    );
    assert_eq!(source.calls.load(Ordering::SeqCst), 0);
    let mut invalid = TestQuery::new("test.invalid");
    invalid.data = json!({"value":"wrong"});
    let mut registry = CapabilityRegistry::new();
    registry.register_query(Arc::new(invalid)).unwrap();
    assert!(matches!(
        QueryGateway::new(Arc::new(registry))
            .query(&context(), query("test.invalid", json!({"value":1})))
            .await,
        Err(OperationError::Contract(_))
    ));
    for target in ["test.missing", "test.execute", "test.control"] {
        let mut source = TestQuery::new("test.source");
        source.reads = vec![NextRead::query(
            target,
            "Inspect evidence",
            json!({"value":1}),
        )];
        let mut registry = CapabilityRegistry::new();
        registry
            .register(Arc::new(TestHandler::new(CommitPlan::succeeded(
                json!({"value":1}),
            ))))
            .unwrap();
        registry
            .register_control(descriptor("test.control", CapabilityKind::Control))
            .unwrap();
        registry.register_query(Arc::new(source)).unwrap();
        assert!(matches!(
            QueryGateway::new(Arc::new(registry))
                .query(&context(), query("test.source", json!({"value":1})))
                .await,
            Err(OperationError::Contract(_))
        ));
    }
}

#[tokio::test]
async fn permission_filtering_precedes_read_link_schema_validation_and_exposure() {
    let mut target = TestQuery::new("test.private");
    target.descriptor.required_scopes = BTreeSet::from(["private.read".into()]);
    let mut source = TestQuery::new("test.source");
    source.reads = vec![NextRead::query(
        "test.private",
        "Read private evidence",
        json!({"value":"malformed hidden input"}),
    )];
    let mut registry = CapabilityRegistry::new();
    registry.register_query(Arc::new(target)).unwrap();
    registry.register_query(Arc::new(source)).unwrap();
    let gateway = QueryGateway::new(Arc::new(registry));
    let result = gateway
        .query(&context(), query("test.source", json!({"value":1})))
        .await
        .unwrap();
    assert!(result.next_reads.is_empty());
    let mut permitted = context();
    permitted.scopes.insert("private.read".into());
    assert!(matches!(
        gateway
            .query(&permitted, query("test.source", json!({"value":1})))
            .await,
        Err(OperationError::Contract(_))
    ));
    let mut denied = context();
    denied.scopes.remove("test.read");
    assert!(matches!(
        gateway
            .query(&denied, query("test.source", json!({"value":1})))
            .await,
        Err(OperationError::AccessDenied { .. })
    ));
}

#[tokio::test]
async fn missing_identity_fields_do_not_disable_validation_of_bound_read_arguments() {
    for (arguments, missing, succeeds) in [
        (json!({"limit":10}), "id", true),
        (json!({"limit":"wrong"}), "id", false),
        (json!({"limit":10}), "invented", false),
        (json!({"limit":10,"id":"already-bound"}), "id", false),
    ] {
        let mut target = TestQuery::new("test.target");
        target.descriptor.input_schema = json!({"type":"object","properties":{"id":{"type":"string"},"limit":{"type":"integer"}},"required":["id","limit"],"additionalProperties":false});
        target.descriptor.documentation.examples[0].arguments = json!({"id":"example","limit":10});
        let mut source = TestQuery::new("test.source");
        source.reads = vec![NextRead {
            purpose: "Inspect matching evidence".into(),
            capability: CapabilityRef::new("test.target", 1).unwrap(),
            arguments,
            missing_identity_fields: vec![missing.into()],
        }];
        let mut registry = CapabilityRegistry::new();
        registry.register_query(Arc::new(target)).unwrap();
        registry.register_query(Arc::new(source)).unwrap();
        assert_eq!(
            QueryGateway::new(Arc::new(registry))
                .query(&context(), query("test.source", json!({"value":1})))
                .await
                .is_ok(),
            succeeds
        );
    }
}

#[test]
fn registration_checks_references_examples_normalization_and_control_collisions() {
    for reference in ["#/$defs/absent", "https://untrusted.invalid/schema"] {
        let mut handler = TestHandler::new(CommitPlan::succeeded(json!({"value":1})));
        handler.descriptor.output_schema = json!({"$ref":reference});
        assert!(matches!(
            CapabilityRegistry::new().register(Arc::new(handler)),
            Err(OperationError::Contract(_))
        ));
    }
    let mut invalid = TestHandler::new(CommitPlan::succeeded(json!({"value":1})));
    invalid.descriptor.documentation.examples[0].arguments = json!({"value":"wrong"});
    assert!(
        CapabilityRegistry::new()
            .register(Arc::new(invalid))
            .is_err()
    );
    let mut invalid = TestHandler::new(CommitPlan::succeeded(json!({"value":1})));
    invalid.corrupt_normalized = true;
    invalid.descriptor.documentation.examples[0].arguments = json!({"value":2});
    assert!(
        CapabilityRegistry::new()
            .register(Arc::new(invalid))
            .is_err()
    );
    let mut registry = CapabilityRegistry::new();
    registry
        .register_control(descriptor("test.execute", CapabilityKind::Control))
        .unwrap();
    assert!(matches!(
        registry.register(Arc::new(TestHandler::new(CommitPlan::succeeded(
            json!({"value":1})
        )))),
        Err(OperationError::DuplicateCapability(_))
    ));
}

#[test]
fn partial_hosts_explain_missing_precondition_reads_but_reject_effectful_read_sources() {
    let mut handler = TestHandler::new(CommitPlan::succeeded(json!({"value":1})));
    handler
        .descriptor
        .documentation
        .preconditions
        .push(CapabilityPrecondition {
            parameter: "native identity".into(),
            requirement: "Use the exact native session.".into(),
            read_from: Some(CapabilityRef::new("workspace.runtime_status", 1).unwrap()),
        });
    let mut registry = CapabilityRegistry::new();
    registry.register(Arc::new(handler)).unwrap();
    registry.validate_links().unwrap();
    let descriptor = registry
        .descriptor(&CapabilityRef::new("test.execute", 1).unwrap())
        .unwrap();
    assert!(
        descriptor.documentation.preconditions[0]
            .read_from
            .is_none()
    );
    assert!(
        descriptor.documentation.preconditions[0]
            .requirement
            .contains("unavailable in this Host")
    );
    let mut query = TestQuery::new("test.read");
    query
        .descriptor
        .documentation
        .preconditions
        .push(CapabilityPrecondition {
            parameter: "unsafe source".into(),
            requirement: "Must not execute".into(),
            read_from: Some(CapabilityRef::new("test.execute", 1).unwrap()),
        });
    registry.register_query(Arc::new(query)).unwrap();
    assert!(registry.validate_links().is_err());
}

#[tokio::test]
async fn schema_composition_does_not_interpret_ref_keys_inside_literal_data() {
    let output = json!({"value":{"$ref":"#/$defs/not-a-schema-reference"}});
    let mut handler = TestHandler::new(CommitPlan::succeeded(output.clone()));
    handler.descriptor.output_schema = json!({"type":"object","properties":{"value":{"const":{"$ref":"#/$defs/not-a-schema-reference"}}},"required":["value"],"additionalProperties":false});
    let mut registry = CapabilityRegistry::new();
    registry.register(Arc::new(handler)).unwrap();
    let journal = Arc::new(TestJournal::default());
    register_get(&mut registry, journal.clone(), Some("/project".into()));
    let registry = Arc::new(registry);
    let result = gateway(registry.clone(), journal)
        .invoke(&context(), invocation(json!({"value":1})))
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded);
    let read = QueryGateway::new(registry)
        .query(
            &context(),
            query(
                "operation.get",
                json!({"operation_id":result.operation.operation_id}),
            ),
        )
        .await
        .unwrap();
    let result: OperationGetResult = serde_json::from_value(read.data.unwrap()).unwrap();
    assert_eq!(result.record.unwrap().output, Some(output));
}

#[tokio::test]
async fn legacy_public_record_and_event_reads_require_scope_even_for_the_same_principal() {
    let journal = Arc::new(TestJournal::default());
    let mut registry = CapabilityRegistry::new();
    registry
        .register(Arc::new(TestHandler::new(CommitPlan::succeeded(
            json!({"value":1}),
        ))))
        .unwrap();
    register_get(&mut registry, journal.clone(), Some("/project".into()));
    let gateway = gateway(Arc::new(registry), journal);
    let record = gateway
        .invoke(&context(), invocation(json!({"value":1})))
        .await
        .unwrap();
    let mut denied = context();
    denied.scopes.clear();
    assert!(matches!(
        gateway
            .get_operation(&denied, &record.operation.operation_id)
            .await,
        Err(OperationError::AccessDenied { .. })
    ));
    assert!(matches!(
        gateway.get_request_operation(&denied, "request-1").await,
        Err(OperationError::AccessDenied { .. })
    ));
    assert!(matches!(
        gateway
            .events(&denied, &record.operation.operation_id)
            .await,
        Err(OperationError::AccessDenied { .. })
    ));
    assert!(matches!(
        gateway.outbox(&denied, 0, 100).await,
        Err(OperationError::AccessDenied { .. })
    ));
    assert!(matches!(
        gateway
            .facts_for_operation(&denied, &record.operation.operation_id)
            .await,
        Err(OperationError::AccessDenied { .. })
    ));
}
#[tokio::test]
async fn native_cancellation_authority_does_not_require_an_additional_public_read_scope() {
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let mut handler = TestHandler::new(CommitPlan::succeeded(json!({"value":1})));
    handler.started = Some(started.clone());
    handler.finish = Some(finish.clone());
    let journal = Arc::new(TestJournal::default());
    let mut registry = CapabilityRegistry::new();
    registry.register(Arc::new(handler)).unwrap();
    register_get(&mut registry, journal.clone(), Some("/project".into()));
    let gateway = Arc::new(gateway(Arc::new(registry), journal));
    let mut native = context();
    native.scopes.remove("operation.read");
    let task_gateway = gateway.clone();
    let task_context = native.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        task_gateway
            .invoke_notifying(&task_context, invocation(json!({"value":1})), Some(tx))
            .await
    });
    let accepted = rx.await.unwrap();
    started.notified().await;
    assert!(
        gateway
            .request_cancellation(&native, &accepted.operation.operation_id)
            .await
            .unwrap()
            .accepted
    );
    assert!(
        gateway
            .owner_record(&native, &accepted.operation.operation_id)
            .await
            .unwrap()
            .is_some()
    );
    finish.notify_one();
    task.await.unwrap().unwrap();
}
#[tokio::test]
async fn original_request_lookup_uses_actor_identity_not_a_principal_summary_page() {
    let journal = Arc::new(TestJournal::default());
    let mut registry = CapabilityRegistry::new();
    registry
        .register(Arc::new(TestHandler::new(CommitPlan::succeeded(
            json!({"value":1}),
        ))))
        .unwrap();
    let gateway = gateway(Arc::new(registry), journal);
    let first = gateway
        .invoke(&context(), invocation(json!({"value":1})))
        .await
        .unwrap();
    let mut second_context = context();
    second_context.caller.id = "another-agent".into();
    let second = gateway
        .invoke(&second_context, invocation(json!({"value":2})))
        .await
        .unwrap();
    assert_ne!(first.operation.operation_id, second.operation.operation_id);
    assert_eq!(
        gateway
            .owner_request_record(&context(), "request-1")
            .await
            .unwrap()
            .unwrap()
            .operation
            .operation_id,
        first.operation.operation_id
    );
    assert_eq!(
        gateway
            .owner_request_record(&second_context, "request-1")
            .await
            .unwrap()
            .unwrap()
            .operation
            .operation_id,
        second.operation.operation_id
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repeated_query_navigation_uses_precompiled_input_and_payload_validators() {
    let target = TestQuery::new("test.target");
    let mut source = TestQuery::new("test.source");
    source.reads = vec![NextRead::query(
        "test.target",
        "Read matching evidence",
        json!({"value":1}),
    )];
    let mut registry = CapabilityRegistry::new();
    registry.register_query(Arc::new(target)).unwrap();
    registry.register_query(Arc::new(source)).unwrap();
    let before = crate::schema::compiled_schema_count();
    let gateway = QueryGateway::new(Arc::new(registry));
    for _ in 0..20 {
        let page = gateway
            .query(&context(), query("test.source", json!({"value":1})))
            .await
            .unwrap();
        assert_eq!(page.next_reads.len(), 1);
    }
    assert_eq!(crate::schema::compiled_schema_count(), before);
}
#[test]
fn control_contract_validation_uses_the_registry_without_admitting_an_operation() {
    let capability = CapabilityRef::new("test.control", 1).unwrap();
    let mut registry = CapabilityRegistry::new();
    registry
        .register_control(descriptor("test.control", CapabilityKind::Control))
        .unwrap();
    assert!(
        registry
            .validate_control_input(&context(), &capability, &json!({"value":1}))
            .is_ok()
    );
    assert!(matches!(
        registry.validate_control_input(&context(), &capability, &json!({"value":"wrong"})),
        Err(OperationError::InvalidInput(_))
    ));
    assert!(matches!(
        registry.validate_control_output(&capability, &json!({"value":"wrong"})),
        Err(OperationError::Contract(_))
    ));
    let mut denied = context();
    denied.scopes.clear();
    assert!(matches!(
        registry.validate_control_input(&denied, &capability, &json!({"value":1})),
        Err(OperationError::AccessDenied { .. })
    ));
    assert!(matches!(
        registry.handler(&capability),
        Err(OperationError::UnknownCapability(_))
    ));
}
