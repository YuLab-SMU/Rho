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
struct Records(Vec<OperationRecord>);
#[async_trait]
impl OperationRecords for Records {
    async fn get(&self, id: &str) -> Result<Option<OperationRecord>, String> {
        Ok(self
            .0
            .iter()
            .find(|record| record.operation.operation_id.as_str() == id)
            .cloned())
    }
    async fn successful_outputs(
        &self,
        _: &str,
        _: &CapabilityRef,
        _: Option<&str>,
        _: usize,
    ) -> Result<OperationOutputPage, String> {
        panic!("Retained successful source needs no global cleanup-reference scan")
    }
}
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
        panic!("Navigation link executed another read")
    }
}
#[derive(Default)]
struct Native(AtomicUsize);
#[async_trait]
impl EnvironmentRuntime for Native {
    fn root(&self) -> &str {
        "/project"
    }
    async fn observe(
        &self,
        library: Option<&str>,
        _: usize,
    ) -> Result<EnvironmentObservation, String> {
        assert_eq!(library, Some("/project/library"));
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(EnvironmentObservation {
            r_version: "4".into(),
            platform: "fixture".into(),
            r_home: "/r".into(),
            library_paths: vec!["/project/library".into()],
            packages: vec![],
            truncated: false,
            jsonlite_library: "/r/library".into(),
            renv_available: false,
            pak_available: false,
            configuration_observed_at_ms: 1,
            configuration_source: "fixture".into(),
            inventory_observed_at_ms: 2,
            active_workspace_library: None,
            notices: vec![],
        })
    }
    async fn plan(
        &self,
        _: &str,
        _: &PlanArguments,
        _: watch::Receiver<bool>,
    ) -> Result<EnvironmentPlan, HandlerError> {
        panic!("Read planned environment work")
    }
    async fn realize(
        &self,
        _: &str,
        _: &str,
        _: &EnvironmentPlan,
        _: watch::Receiver<bool>,
    ) -> Result<EnvironmentRealization, HandlerError> {
        panic!("Read installed an environment")
    }
    async fn verify(
        &self,
        _: &str,
        _: &EnvironmentRealization,
        _: watch::Receiver<bool>,
    ) -> Result<Verification, HandlerError> {
        panic!("Read loaded a namespace")
    }
    async fn reconcile(&self, _: &str) -> Result<EnvironmentReconciliation, HandlerError> {
        panic!("Read recovered native work")
    }
    async fn material_state(
        &self,
        source: &str,
        _: MaterialKind,
        _: Option<&str>,
    ) -> Result<MaterialState, String> {
        assert_eq!(source, "realization");
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(MaterialState {
            stage: None,
            trash: None,
            native_marker_present: false,
            live_processes: vec![],
        })
    }
    async fn change_material(
        &self,
        _: &str,
        _: MaterialKind,
        _: &str,
        _: MaterialAction,
        _: &str,
    ) -> Result<MaterialChange, HandlerError> {
        panic!("Read changed staged material")
    }
}
fn source(id: &str, capability: &str, arguments: Value, output: Value) -> OperationRecord {
    OperationRecord {
        operation: Operation {
            operation_id: OperationId::new(id).unwrap(),
            client_request_id: id.into(),
            caller: CallerIdentity {
                kind: CallerKind::Agent,
                id: "original-agent".into(),
            },
            principal: Some(human("alice")),
            capability: CapabilityRef::new(capability, 1).unwrap(),
            domain: "environment".into(),
            target: TargetRef {
                kind: "environment".into(),
                identity: "/project".into(),
            },
            normalized_arguments: arguments,
            invocation_digest: "original-digest".into(),
            idempotency_scope: Some("/project".into()),
            preconditions: vec![],
            potential_effects: Default::default(),
            correlation_id: id.into(),
            causation_id: None,
            trace_parent: None,
            accepted_at_ms: 1,
            admission: None,
        },
        status: OperationStatus::Succeeded,
        outcome: Some(OperationOutcome::Succeeded),
        output: Some(output),
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
        scopes: [ENVIRONMENT_READ_SCOPE.into()].into(),
        connection_id: "fixture".into(),
        correlation_id: None,
        causation_id: None,
        trace_parent: None,
    }
}
#[tokio::test]
async fn observation_and_retention_check_original_principal_before_native_reads() {
    let native = Arc::new(Native::default());
    let realization = source(
        "realization",
        REALIZE_CAPABILITY,
        json!({"plan_operation_id":"plan"}),
        json!(EnvironmentRealization {
            project_root: "/project".into(),
            plan_operation_id: "plan".into(),
            manager: "renv".into(),
            lock_digest: "sha256:lock".into(),
            library_path: "/project/library".into(),
            library_digest: "sha256:library".into(),
            renv_lockfile: "/project/renv.lock".into(),
            r_version: "4".into(),
            platform: "fixture".into(),
            packages: vec![],
            probes: vec![],
            verified: true,
            restart_required: false,
            activation: "explicit".into(),
        }),
    );
    let cleanup = source(
        "cleanup",
        CLEANUP_CAPABILITY,
        json!({"operation_id":"realization","expected_fingerprint":"hash"}),
        Value::Null,
    );
    let mut foreign_cleanup = cleanup.clone();
    foreign_cleanup.operation.operation_id = OperationId::new("foreign-cleanup").unwrap();
    foreign_cleanup.operation.principal = Some(human("bob"));
    let owner = Arc::new(EnvironmentOwner::new(
        native.clone(),
        Arc::new(Records(vec![realization, cleanup, foreign_cleanup])),
        Arc::new(Mutex::new(())),
        None,
        false,
    ));
    let handlers: Vec<Arc<dyn QueryHandler>> = vec![
        Arc::new(EnvironmentObserveHandler::new(owner.clone())),
        Arc::new(RetentionQuery::new(owner.clone(), false)),
        Arc::new(RetentionQuery::new(owner, true)),
    ];
    let requests = vec![
        QueryRequest {
            capability: CapabilityRef::new("environment.observe", 1).unwrap(),
            arguments: json!({"realization_operation_id":"realization","limit":20}),
        },
        QueryRequest {
            capability: CapabilityRef::new("environment.retention", 1).unwrap(),
            arguments: json!({"operation_id":"realization"}),
        },
        QueryRequest {
            capability: CapabilityRef::new("environment.cleanup_status", 1).unwrap(),
            arguments: json!({"cleanup_operation_id":"cleanup"}),
        },
    ];
    let mut registry = CapabilityRegistry::new();
    for (handler, request) in handlers.into_iter().zip(&requests) {
        assert!(handler.query(&request.arguments).await.is_err());
        registry.register_query(handler).unwrap();
    }
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
    for request in &requests {
        let foreign = gateway
            .query(&context("bob"), request.clone())
            .await
            .unwrap_err();
        let mut missing = request.clone();
        for value in missing.arguments.as_object_mut().unwrap().values_mut() {
            if value.is_string() {
                *value = json!("missing");
            }
        }
        let absent = gateway.query(&context("alice"), missing).await.unwrap_err();
        assert_eq!(foreign.to_string(), absent.to_string());
    }
    assert_eq!(native.0.load(Ordering::SeqCst), 0);
    // Even the cleanup's owner cannot read a source owned by another principal.
    let foreign_request = QueryRequest {
        capability: CapabilityRef::new("environment.cleanup_status", 1).unwrap(),
        arguments: json!({"cleanup_operation_id":"foreign-cleanup"}),
    };
    assert!(
        gateway
            .query(&context("bob"), foreign_request)
            .await
            .is_err()
    );
    assert_eq!(native.0.load(Ordering::SeqCst), 0);
    for request in requests {
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
    }
    assert_eq!(native.0.load(Ordering::SeqCst), 6);
}
