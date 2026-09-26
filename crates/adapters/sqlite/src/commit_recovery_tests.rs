use super::*;
use rho_contract::*;
use rho_operation::*;
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Default)]
struct Counts {
    executed: AtomicUsize,
    completed: AtomicUsize,
    dropped: AtomicUsize,
}
struct Lease(Arc<Counts>);
#[async_trait::async_trait]
impl ExecutionLease for Lease {
    async fn completed(&mut self, result: &Result<OperationRecord, OperationError>) {
        assert!(result.as_ref().unwrap().status.is_terminal());
        self.0.completed.fetch_add(1, Ordering::SeqCst);
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.dropped.fetch_add(1, Ordering::SeqCst);
    }
}
struct Owner {
    descriptor: CapabilityDescriptor,
    counts: Arc<Counts>,
}
#[async_trait]
impl OperationHandler for Owner {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some("/commit-project".into())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        Ok(value.clone())
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(TargetRef {
            kind: "fixture".into(),
            identity: "native-original".into(),
        })
    }
    async fn acquire_execution(
        &self,
        _: &Operation,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(Box::new(Lease(self.counts.clone())))
    }
    async fn execute(&self, _: &Operation) -> Result<CommitPlan, HandlerError> {
        self.counts.executed.fetch_add(1, Ordering::SeqCst);
        let mut plan = CommitPlan::succeeded(json!({"answer":37}));
        plan.facts.push(DomainFactMutation {
            domain: "fixture".into(),
            schema: "fixture.answer".into(),
            key: "answer".into(),
            value: json!(37),
        });
        plan.events.push(PlannedEvent {
            kind: "fixture.finished".into(),
            payload: json!({"answer":37}),
        });
        Ok(plan)
    }
}
fn fixture(journal: Arc<SqliteOperationJournal>) -> (OperationGateway, Arc<Counts>) {
    let counts = Arc::new(Counts::default());
    let mut registry = CapabilityRegistry::default();
    registry
        .register(Arc::new(Owner {
            counts: counts.clone(),
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Operation,
                capability: CapabilityRef::new("fixture.execute", 1).unwrap(),
                domain: "fixture".into(),
                input_schema: json!({"type":"object","additionalProperties":false}),
                output_schema: json!({"type":"object"}),
                recovery_schema: json!({"type":"null"}),
                required_scopes: BTreeSet::from(["fixture.run".into()]),
                potential_effects: Default::default(),
                idempotency: IdempotencyClass::CallerScoped,
                retry: RetryClass::ReconcileFirst,
                cancellation: CancellationClass::Unsupported,
                documentation: builtin_documentation("host.overview"),
            },
        }))
        .unwrap();
    (gateway(journal, Arc::new(registry)), counts)
}
fn gateway(
    journal: Arc<SqliteOperationJournal>,
    registry: Arc<CapabilityRegistry>,
) -> OperationGateway {
    OperationGateway::new(
        registry,
        journal,
        Arc::new(SystemClock),
        Arc::new(UuidOperationIdGenerator),
    )
    .with_project_scope(Some("/commit-project".into()))
}
fn context() -> CallContext {
    CallContext {
        view_scope: None,
        caller: CallerIdentity {
            kind: CallerKind::Agent,
            id: "agent".into(),
        },
        principal: Some(CallerIdentity {
            kind: CallerKind::Human,
            id: "human".into(),
        }),
        scopes: BTreeSet::from(["operation.read".into(), "fixture.run".into()]),
        connection_id: "commit-test".into(),
        correlation_id: None,
        causation_id: None,
        trace_parent: None,
    }
}
fn invocation() -> Invocation {
    Invocation {
        client_request_id: "original".into(),
        capability: CapabilityRef::new("fixture.execute", 1).unwrap(),
        arguments: json!({}),
        preconditions: vec![],
    }
}
async fn failed(gateway: &OperationGateway) -> OperationId {
    match gateway.invoke(&context(), invocation()).await.unwrap_err() {
        OperationError::CommitPending { operation_id, .. } => operation_id,
        error => panic!("expected retained result: {error}"),
    }
}
async fn status(gateway: &OperationGateway, id: &OperationId) -> OperationCommitStatus {
    gateway
        .commit_recovery()
        .status(&context(), Some("/commit-project"), id)
        .await
        .unwrap()
        .unwrap()
}
fn fail_terminal(journal: &SqliteOperationJournal) {
    journal.connection().unwrap().execute_batch("CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON operations WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'injected terminal failure'); END;").unwrap();
}

#[tokio::test]
async fn volatile_candidate_preserves_lease_and_original_authority_until_exact_commit() {
    let journal = Arc::new(SqliteOperationJournal::open_in_memory().unwrap());
    let (gateway, counts) = fixture(journal.clone());
    journal.connection().unwrap().execute_batch("CREATE TRIGGER fail_stage BEFORE INSERT ON operation_commit_candidates BEGIN SELECT RAISE(ABORT,'injected stage failure'); END;").unwrap();
    let id = failed(&gateway).await;
    let state = status(&gateway, &id).await;
    assert_eq!(state.phase, OperationCommitPhase::Volatile);
    assert!(journal.commit_receipt(&id).await.unwrap().is_none());
    assert!(journal.facts_for_operation(&id).await.unwrap().is_empty());
    assert_eq!(counts.dropped.load(Ordering::SeqCst), 0);
    assert_eq!(counts.completed.load(Ordering::SeqCst), 0);
    assert_eq!(
        gateway
            .invoke(&context(), invocation())
            .await
            .unwrap()
            .status,
        OperationStatus::Running
    );
    assert_eq!(counts.executed.load(Ordering::SeqCst), 1);
    let args = ReconcileOperationCommit {
        reference: state.reference.unwrap(),
    };
    let mut read_only = context();
    read_only.scopes.remove("fixture.run");
    assert!(matches!(
        gateway.reconcile_commit(&read_only, &args).await,
        Err(OperationError::AccessDenied { .. })
    ));
    let mut stranger = context();
    stranger.principal.as_mut().unwrap().id = "other".into();
    assert!(matches!(
        gateway.reconcile_commit(&stranger, &args).await,
        Err(OperationError::NotFound(_))
    ));
    assert!(
        gateway
            .commit_recovery()
            .status(&context(), Some("/other-project"), &id)
            .await
            .unwrap()
            .is_none()
    );
    let mut wrong = args.clone();
    wrong.reference.byte_size += 1;
    assert!(matches!(
        gateway.reconcile_commit(&context(), &wrong).await,
        Err(OperationError::ContentChanged(_))
    ));
    journal
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_stage")
        .unwrap();
    let context = context();
    let (a, b) = tokio::join!(
        gateway.reconcile_commit(&context, &args),
        gateway.reconcile_commit(&context, &args)
    );
    assert_eq!(a.unwrap().output, json!({"answer":37}).into());
    assert_eq!(b.unwrap().status, OperationStatus::Succeeded);
    assert_eq!(counts.executed.load(Ordering::SeqCst), 1);
    assert_eq!(counts.completed.load(Ordering::SeqCst), 1);
    assert_eq!(counts.dropped.load(Ordering::SeqCst), 1);
    assert_eq!(journal.facts_for_operation(&id).await.unwrap().len(), 1);
    assert_eq!(
        journal
            .events(&id)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.kind == "operation.terminal")
            .count(),
        1
    );
    assert_eq!(
        status(&gateway, &id).await.phase,
        OperationCommitPhase::Committed
    );
}

#[tokio::test]
async fn durable_candidate_survives_reopen_and_provider_removal_without_reexecution() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("journal.sqlite");
    let journal = Arc::new(SqliteOperationJournal::open(&path).unwrap());
    let (original, counts) = fixture(journal.clone());
    fail_terminal(&journal);
    let id = failed(&original).await;
    let state = status(&original, &id).await;
    assert_eq!(state.phase, OperationCommitPhase::Durable);
    let args = ReconcileOperationCommit {
        reference: state.reference.unwrap(),
    };
    assert_eq!(counts.dropped.load(Ordering::SeqCst), 0);
    journal
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_terminal")
        .unwrap();
    drop(original);
    drop(journal);
    let journal = Arc::new(SqliteOperationJournal::open(&path).unwrap());
    let recovered = journal
        .recover_incomplete(SystemClock.now_ms().unwrap())
        .await
        .unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].status, OperationStatus::Reconciling);
    let events = journal.events(&id).await.unwrap();
    journal
        .recover_incomplete(SystemClock.now_ms().unwrap())
        .await
        .unwrap();
    assert_eq!(journal.events(&id).await.unwrap(), events);
    let restored = gateway(journal.clone(), Arc::new(CapabilityRegistry::default()));
    assert_eq!(
        status(&restored, &id).await.phase,
        OperationCommitPhase::Durable
    );
    let record = restored.reconcile_commit(&context(), &args).await.unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded);
    assert_eq!(record.output, Some(json!({"answer":37})));
    assert_eq!(counts.executed.load(Ordering::SeqCst), 1);
    assert_eq!(counts.completed.load(Ordering::SeqCst), 0); // old process did not receive completion
    assert_eq!(journal.facts_for_operation(&id).await.unwrap().len(), 1);
    assert!(
        journal
            .read_commit_candidate(&args.reference)
            .await
            .is_err()
    );
    let events = journal.events(&id).await.unwrap();
    restored.reconcile_commit(&context(), &args).await.unwrap();
    assert_eq!(journal.events(&id).await.unwrap(), events);
}

#[tokio::test]
async fn lost_completion_ack_releases_original_lease_from_terminal_receipt_once() {
    let journal = Arc::new(SqliteOperationJournal::open_in_memory().unwrap());
    let (gateway, counts) = fixture(journal.clone());
    fail_terminal(&journal);
    let id = failed(&gateway).await;
    let args = ReconcileOperationCommit {
        reference: status(&gateway, &id).await.reference.unwrap(),
    };
    let plan = journal
        .read_commit_candidate(&args.reference)
        .await
        .unwrap();
    journal
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_terminal")
        .unwrap();
    journal
        .commit(&id, &plan, SystemClock.now_ms().unwrap())
        .await
        .unwrap();
    assert_eq!(counts.completed.load(Ordering::SeqCst), 0);
    let events = journal.events(&id).await.unwrap();
    gateway.reconcile_commit(&context(), &args).await.unwrap();
    gateway.reconcile_commit(&context(), &args).await.unwrap();
    assert_eq!(counts.completed.load(Ordering::SeqCst), 1);
    assert_eq!(counts.dropped.load(Ordering::SeqCst), 1);
    assert_eq!(journal.events(&id).await.unwrap(), events);
}

#[tokio::test]
async fn changed_staged_candidate_cannot_be_reconciled_after_restart() {
    let journal = Arc::new(SqliteOperationJournal::open_in_memory().unwrap());
    let (original, counts) = fixture(journal.clone());
    fail_terminal(&journal);
    let id = failed(&original).await;
    let args = ReconcileOperationCommit {
        reference: status(&original, &id).await.reference.unwrap(),
    };
    drop(original);
    journal.connection().unwrap().execute("UPDATE operation_commit_candidates SET plan_json=json_set(plan_json,'$.output.answer',999) WHERE operation_id=?1",[id.as_str()]).unwrap();
    let restored = gateway(journal.clone(), Arc::new(CapabilityRegistry::default()));
    assert!(matches!(
        restored.reconcile_commit(&context(), &args).await,
        Err(OperationError::ContentChanged(_))
    ));
    assert!(journal.facts_for_operation(&id).await.unwrap().is_empty());
    assert_eq!(counts.executed.load(Ordering::SeqCst), 1);
    assert!(
        !journal
            .get(&id)
            .await
            .unwrap()
            .unwrap()
            .status
            .is_terminal()
    );
}
