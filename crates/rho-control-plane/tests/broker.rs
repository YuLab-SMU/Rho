use rho_control_plane::*;
use rho_protocol::*;
use rho_store::SemanticStore;
use serde_json::json;

fn open_store() -> (tempfile::TempDir, SemanticStore) {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/rho-semantic.sqlite3");
    let (store, _outcome) = SemanticStore::open_app_local(temp.path(), &db).unwrap();
    (temp, store)
}

fn broker() -> BrokerAdmission {
    BrokerAdmission::new(
        CapabilityRegistry::canonical().unwrap(),
        StreamId::new("stream_broker").unwrap(),
    )
}

fn request(capability: &str, operation: &str, args: serde_json::Value) -> AdmissionRequest {
    let mut context = policy_context_fixture(
        CapabilityId::new(capability).unwrap(),
        OperationId::new(operation).unwrap(),
    );
    context.input.arguments = args.clone();
    AdmissionRequest {
        context,
        normalized_arguments: args,
        now_ms: 1000,
    }
}

#[test]
fn broker_records_durable_ask_fact_before_execution_submit() {
    let (_temp, mut store) = open_store();
    let mut broker = broker();
    let outcome = broker
        .admit(
            &mut store,
            request(
                RUN_R_CAPABILITY,
                "operation_broker_ask",
                json!({"code": "x <- 1"}),
            ),
        )
        .unwrap();

    let BrokerAdmissionOutcome::Ask {
        decision,
        durable_event_id,
        approval_binding,
    } = outcome
    else {
        panic!("run_r should require exact approval");
    };
    assert_eq!(decision.decision, BrokerDecisionKind::Ask);
    assert_eq!(decision.reason_code, "mutation_requires_approval");
    let count: i64 = store
        .connection()
        .query_row(
            "SELECT count(*) FROM events WHERE event_id = ?1",
            [&durable_event_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        approval_binding.normalized_args_hash,
        hash_args(&json!({"code": "x <- 1"})).unwrap()
    );
}

#[test]
fn broker_records_durable_deny_fact() {
    let (_temp, mut store) = open_store();
    let mut broker = broker();
    let mut admission = request(
        "network.fetch",
        "operation_broker_deny",
        json!({"url": "https://example.org"}),
    );
    admission.context.input.destination = DestinationClass::UnrestrictedNetwork;

    let outcome = broker.admit(&mut store, admission).unwrap();
    let BrokerAdmissionOutcome::Denied {
        decision,
        durable_event_id,
    } = outcome
    else {
        panic!("unrestricted network should be denied");
    };
    assert_eq!(decision.decision, BrokerDecisionKind::Deny);
    assert_eq!(decision.reason_code, "unrestricted_network_denied");
    let payload: String = store
        .connection()
        .query_row(
            "SELECT payload_json FROM events WHERE event_id = ?1",
            [&durable_event_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(payload.contains("policy_decision_recorded"));
}

#[test]
fn broker_approval_lease_binds_exact_args_revision_destination_expiry_and_single_use() {
    let (_temp, mut store) = open_store();
    let mut broker = broker();
    let admission = request(
        RUN_R_CAPABILITY,
        "operation_broker_lease",
        json!({"code": "x <- 1"}),
    );
    let expected = admission.context.expected_revisions.clone();
    let outcome = broker.admit(&mut store, admission).unwrap();
    let BrokerAdmissionOutcome::Ask {
        approval_binding, ..
    } = outcome
    else {
        panic!("expected approval binding");
    };

    assert!(matches!(
        broker.lease_from_approval(
            &approval_binding.approval_id,
            &json!({"code": "x <- 2"}),
            &expected,
            DestinationClass::LocalWorkspace,
            1001,
        ),
        Err(BrokerError::ApprovalMismatch(_))
    ));

    let lease = broker
        .lease_from_approval(
            &approval_binding.approval_id,
            &json!({"code": "x <- 1"}),
            &expected,
            DestinationClass::LocalWorkspace,
            1001,
        )
        .unwrap();
    assert!(
        lease_matches_request(
            &lease,
            &json!({"code": "x <- 1"}),
            &expected,
            DestinationClass::LocalWorkspace,
            1001,
        )
        .unwrap()
    );
    assert!(matches!(
        broker.lease_from_approval(
            &approval_binding.approval_id,
            &json!({"code": "x <- 1"}),
            &expected,
            DestinationClass::LocalWorkspace,
            1001,
        ),
        Err(BrokerError::ApprovalAlreadyUsed(_))
    ));
}

#[test]
fn broker_duplicate_admission_returns_same_authoritative_result_without_second_effect() {
    let (_temp, mut store) = open_store();
    let mut broker = broker();
    let admission = request(
        RUN_R_CAPABILITY,
        "operation_broker_duplicate",
        json!({"code": "x <- 1"}),
    );
    let first = broker.admit(&mut store, admission.clone()).unwrap();
    let second = broker.admit(&mut store, admission).unwrap();
    let first_event = match first {
        BrokerAdmissionOutcome::Ask {
            durable_event_id, ..
        } => durable_event_id,
        other => panic!("unexpected outcome {other:?}"),
    };
    assert_eq!(
        second,
        BrokerAdmissionOutcome::Duplicate {
            operation_id: OperationId::new("operation_broker_duplicate").unwrap(),
            durable_event_id: first_event,
        }
    );
    let count: i64 = store
        .connection()
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn broker_executor_port_hard_denies_missing_lease() {
    assert!(matches!(
        BrokerAdmission::require_lease(None),
        Err(BrokerError::MissingLease)
    ));
}

#[test]
fn broker_source_level_contract_declares_unique_ingress_and_no_direct_mutation_port() {
    assert!(broker_source_declares_unique_ingress().contains("BrokerAdmission::admit"));
    let source = include_str!("../src/broker.rs");
    for forbidden in [
        "DirectMutationPort",
        "provider_auto_approve",
        "ExecutorHandle",
    ] {
        assert!(
            !source.contains(forbidden),
            "broker leaked bypass term: {forbidden}"
        );
    }
}
