use super::*;
use rho_contract::{CallContext, CallerKind, OperationId, OperationStatus, QueryRequest};
use rho_operation::{CapabilityRegistry, OperationOutputPage, QueryGateway};
use std::sync::atomic::{AtomicUsize, Ordering};

fn human(id: &str) -> CallerIdentity {
    CallerIdentity {
        kind: CallerKind::Human,
        id: id.into(),
    }
}
struct Records(OperationRecord);
struct RelatedRead(CapabilityDescriptor);
#[async_trait]
impl QueryHandler for RelatedRead {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.0
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        Ok(value.clone())
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        panic!("A navigation link must not execute another read")
    }
}
#[async_trait]
impl OperationRecords for Records {
    async fn get(&self, id: &str) -> Result<Option<OperationRecord>, String> {
        Ok((id == self.0.operation.operation_id.as_str()).then(|| self.0.clone()))
    }
    async fn successful_outputs(
        &self,
        _: &str,
        _: &CapabilityRef,
        _: Option<&str>,
        _: usize,
    ) -> Result<OperationOutputPage, String> {
        panic!("Snapshot must read only its explicit original operation")
    }
}
#[derive(Default)]
struct Native(AtomicUsize);
#[async_trait]
impl SlurmRuntime for Native {
    fn target(&self) -> TargetRef {
        TargetRef {
            kind: "remote".into(),
            identity: "configured-remote".into(),
        }
    }
    fn scope(&self) -> &str {
        "configured-project-remote"
    }
    async fn submit(
        &self,
        _: &Operation,
        _: &SlurmSubmitArguments,
    ) -> Result<SlurmJobRef, HandlerError> {
        panic!("Read submitted a job")
    }
    async fn find(&self, source: &Operation) -> Result<SlurmLookup, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(SlurmLookup {
            source_operation_id: source.operation_id.as_str().into(),
            jobs: vec![],
            accounting_lookback_days: 30,
        })
    }
    async fn request_cancel(
        &self,
        _: &Operation,
        _: &SlurmObservation,
    ) -> Result<SlurmCancellation, HandlerError> {
        panic!("Read cancelled a job")
    }
}
fn source(native: &Native) -> OperationRecord {
    OperationRecord {
        operation: Operation {
            operation_id: OperationId::new("original").unwrap(),
            client_request_id: "original-request".into(),
            caller: CallerIdentity {
                kind: CallerKind::Agent,
                id: "original-agent".into(),
            },
            principal: Some(human("alice")),
            capability: CapabilityRef::new(SUBMIT_CAPABILITY, 1).unwrap(),
            domain: "execution".into(),
            target: native.target(),
            normalized_arguments: json!({"body":"true"}),
            invocation_digest: "original-digest".into(),
            idempotency_scope: Some(native.scope().into()),
            preconditions: vec![],
            potential_effects: Default::default(),
            correlation_id: "original".into(),
            causation_id: None,
            trace_parent: None,
            accepted_at_ms: 1,
            admission: None,
        },
        status: OperationStatus::Uncertain,
        outcome: Some(OperationOutcome::Uncertain),
        output: None,
        error: None,
        recovery: None,
        cancellation_requested: false,
        updated_at_ms: 1,
        next_reads: None,
        diagnostics: None,
    }
}
fn context(id: &str) -> CallContext {
    CallContext {
        caller: human(id),
        principal: None,
        view_scope: None,
        scopes: [SLURM_READ_SCOPE.into()].into(),
        connection_id: "fixture".into(),
        correlation_id: None,
        causation_id: None,
        trace_parent: None,
    }
}

#[tokio::test]
async fn query_checks_original_principal_before_any_scheduler_observation() {
    let native = Arc::new(Native::default());
    let owner = Arc::new(SlurmOwner::new(
        native.clone(),
        Arc::new(Records(source(&native))),
    ));
    let handler = Arc::new(SlurmQueryHandler::new(owner));
    let arguments = json!({"submission_operation_id":"original"});
    assert!(handler.query(&arguments).await.is_err());
    let mut registry = CapabilityRegistry::new();
    registry.register_query(handler).unwrap();
    registry
        .register_query(Arc::new(RelatedRead(CapabilityDescriptor {
            capability: CapabilityRef::new("operation.list_recent", 1).unwrap(),
            documentation: rho_contract::builtin_documentation("operation.list_recent"),
            recovery_schema: json!({"type":"null"}),
            kind: CapabilityKind::Query,
            domain: "operation".into(),
            input_schema: schemars::schema_for!(rho_contract::RecentOperationsArguments).to_value(),
            output_schema: schemars::schema_for!(rho_contract::RecentOperations).to_value(),
            required_scopes: ["operation.read".into()].into(),
            potential_effects: Default::default(),
            idempotency: IdempotencyClass::Pure,
            retry: RetryClass::Safe,
            cancellation: CancellationClass::Unsupported,
        })))
        .unwrap();
    let gateway = QueryGateway::new(Arc::new(registry));
    let request = QueryRequest {
        capability: CapabilityRef::new("slurm.snapshot", 1).unwrap(),
        arguments,
    };
    assert!(
        gateway
            .query(&context("bob"), request.clone())
            .await
            .is_err()
    );
    assert_eq!(native.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        gateway
            .query(&context("alice"), request.clone())
            .await
            .unwrap()
            .status,
        QueryStatus::Ready
    );
    let mut delegated = context("alice");
    delegated.caller = CallerIdentity {
        kind: CallerKind::Agent,
        id: "other-agent".into(),
    };
    delegated.principal = Some(human("alice"));
    assert_eq!(
        gateway
            .query(&delegated, request.clone())
            .await
            .unwrap()
            .status,
        QueryStatus::Ready
    );
    delegated.principal = Some(human("bob"));
    assert!(gateway.query(&delegated, request.clone()).await.is_err());
    delegated.principal = Some(human("alice"));
    delegated.scopes.clear();
    assert!(gateway.query(&delegated, request).await.is_err());
    assert_eq!(native.0.load(Ordering::SeqCst), 2);
}
