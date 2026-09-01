use rho_control_plane::*;
use rho_protocol::*;
use rho_store::SemanticStore;
use serde_json::{Value, json};

fn plan_args(hex: char) -> Value {
    let digest = hex.to_string().repeat(64);
    json!({
        "plan_id": format!("environment_plan_{digest}"),
        "plan_digest": format!("sha256:{digest}"),
        "environment_id": "environment_project",
        "expected_desired_revision": "env_desired_before",
        "expected_realization_revision": "env_realized_before",
        "project_revision": 7,
        "restart_required": true
    })
}

#[test]
fn environment_capabilities_expose_reads_and_exact_request_without_install_authority() {
    let registry = CapabilityRegistry::canonical().unwrap();
    for id in [
        ENVIRONMENT_INSPECT_CAPABILITY,
        ENVIRONMENT_EXPLAIN_INCIDENT_CAPABILITY,
        ENVIRONMENT_PROPOSE_CHANGE_CAPABILITY,
        ENVIRONMENT_OPERATION_INSPECT_CAPABILITY,
    ] {
        let entry = registry
            .descriptor(&CapabilityId::new(id).unwrap())
            .unwrap();
        assert_eq!(entry.descriptor.effect_class, EffectClass::Read);
        assert_eq!(entry.descriptor.retry_class, RetryClass::PureRead);
    }
    let apply = registry
        .descriptor(&CapabilityId::new(ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY).unwrap())
        .unwrap();
    assert_eq!(apply.descriptor.effect_class, EffectClass::ProjectMutation);
    assert_eq!(apply.descriptor.retry_class, RetryClass::NonIdempotent);
    for forbidden in [
        "environment.install",
        "environment.shell",
        "environment.secret",
    ] {
        assert!(
            matches!(
                registry.descriptor(&CapabilityId::new(forbidden).unwrap()),
                Err(CapabilityRegistryError::NotFound(_))
            ),
            "registry exposed forbidden Environment authority {forbidden}"
        );
    }
}

#[test]
fn environment_apply_requires_matching_plan_digest() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let id = CapabilityId::new(ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY).unwrap();
    registry.validate_arguments(&id, &plan_args('a')).unwrap();
    let mut mismatched = plan_args('a');
    mismatched["plan_digest"] = Value::String(format!("sha256:{}", "b".repeat(64)));
    assert!(matches!(
        registry.validate_arguments(&id, &mismatched),
        Err(CapabilityRegistryError::SchemaViolation { reason, .. })
            if reason.contains("same lowercase SHA-256")
    ));
}

#[test]
fn broker_approval_binds_environment_plan_and_expected_revisions_once() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("semantic.sqlite");
    let (mut store, _) = SemanticStore::open_app_local(temp.path(), &database).unwrap();
    let mut broker = BrokerAdmission::new(
        CapabilityRegistry::canonical().unwrap(),
        StreamId::new("stream_environment_broker").unwrap(),
    );
    let capability = CapabilityId::new(ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY).unwrap();
    let operation = OperationId::new("operation_environment_apply").unwrap();
    let mut context = policy_context_fixture(capability, operation);
    let arguments = plan_args('c');
    context.input.arguments = arguments.clone();
    context.input.destination = DestinationClass::LocalWorkspace;
    let expected = context.expected_revisions.clone();
    let outcome = broker
        .admit(
            &mut store,
            AdmissionRequest {
                context,
                normalized_arguments: arguments.clone(),
                now_ms: 1_000,
            },
        )
        .unwrap();
    let BrokerAdmissionOutcome::Ask {
        approval_binding, ..
    } = outcome
    else {
        panic!("Environment application must require exact approval");
    };
    let mut stale = expected.clone();
    stale.project_revision = ProjectRevision(stale.project_revision.0 + 1);
    assert!(matches!(
        broker.lease_from_approval(
            &approval_binding.approval_id,
            &arguments,
            &stale,
            DestinationClass::LocalWorkspace,
            1_001,
        ),
        Err(BrokerError::ApprovalMismatch(_))
    ));
    broker
        .lease_from_approval(
            &approval_binding.approval_id,
            &arguments,
            &expected,
            DestinationClass::LocalWorkspace,
            1_001,
        )
        .unwrap();
    assert!(matches!(
        broker.lease_from_approval(
            &approval_binding.approval_id,
            &arguments,
            &expected,
            DestinationClass::LocalWorkspace,
            1_001,
        ),
        Err(BrokerError::ApprovalAlreadyUsed(_))
    ));
}
