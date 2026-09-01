use rho_control_plane::*;
use rho_protocol::*;
use serde_json::json;

#[test]
fn capability_registry_contains_exhaustive_initial_descriptors() {
    let registry = CapabilityRegistry::canonical().unwrap();
    for id in [
        "workspace.inspect",
        RUN_R_CAPABILITY,
        "project.apply_patch",
        "network.fetch",
        "artifact.commit",
        ENVIRONMENT_INSPECT_CAPABILITY,
        ENVIRONMENT_EXPLAIN_INCIDENT_CAPABILITY,
        ENVIRONMENT_PROPOSE_CHANGE_CAPABILITY,
        ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY,
        ENVIRONMENT_OPERATION_INSPECT_CAPABILITY,
    ] {
        let capability_id = CapabilityId::new(id).unwrap();
        assert_eq!(
            registry.descriptor(&capability_id).unwrap().descriptor.id,
            capability_id
        );
    }
}

#[test]
fn capability_registry_rejects_contradictory_metadata_at_startup() {
    let mut registry = CapabilityRegistry::new();
    let mut descriptor = CapabilityDescriptor::new(
        CapabilityId::new("project.bad_mutation").unwrap(),
        "Bad mutation",
        EffectClass::ProjectMutation,
        RetryClass::PureRead,
        DataClass::ProjectConfidential,
        TargetClass::ProjectFiles,
        vec![ExecutorKind::LocalProcess],
        true,
    );
    descriptor.input_schema = json!({"type": "object"});
    descriptor.output_schema = json!({"type": "object"});
    let error = registry
        .register(RegisteredCapability {
            descriptor,
            result_sensitivity: ResultSensitivityRule::SameAsInput,
            destinations: vec![DestinationClass::LocalSandbox],
            max_argument_bytes: MAX_CAPABILITY_ARGUMENT_BYTES,
            max_array_items: MAX_CAPABILITY_ARRAY_ITEMS,
        })
        .unwrap_err();
    assert!(matches!(
        error,
        CapabilityRegistryError::ContradictoryMetadata { reason, .. }
            if reason.contains("mutation cannot be pure_read")
    ));
}

#[test]
fn capability_registry_validates_arguments_before_admission() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let run_r = CapabilityId::new(RUN_R_CAPABILITY).unwrap();
    registry
        .validate_arguments(&run_r, &json!({"code": "x <- 1", "timeout_ms": 1000}))
        .unwrap();
    assert!(matches!(
        registry.validate_arguments(&run_r, &json!({"timeout_ms": 1000})),
        Err(CapabilityRegistryError::SchemaViolation { reason, .. })
            if reason.contains("missing required property code")
    ));
    assert!(matches!(
        registry.validate_arguments(&run_r, &json!({"code": "", "timeout_ms": 1000})),
        Err(CapabilityRegistryError::SchemaViolation { reason, .. })
            if reason.contains("minLength")
    ));
    assert!(matches!(
        registry.validate_arguments(&run_r, &json!({"code": "x", "unexpected": true})),
        Err(CapabilityRegistryError::SchemaViolation { reason, .. })
            if reason.contains("unknown property unexpected")
    ));
}

#[test]
fn capability_registry_argument_byte_bound_is_enforced() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let id = CapabilityId::new(RUN_R_CAPABILITY).unwrap();
    let mut registered = registry.descriptor(&id).unwrap().clone();
    registered.max_argument_bytes = 16;
    let mut bounded = CapabilityRegistry::new();
    bounded.register(registered).unwrap();
    assert!(matches!(
        bounded.validate_arguments(&id, &json!({"code": "this payload is too large"})),
        Err(CapabilityRegistryError::ArgumentBytesExceeded { .. })
    ));
}

#[test]
fn capability_registry_run_r_and_other_classifications_are_not_caller_overridable() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let run_r = registry
        .descriptor(&CapabilityId::new(RUN_R_CAPABILITY).unwrap())
        .unwrap();
    assert_eq!(
        run_r.descriptor.effect_class,
        EffectClass::WorkspaceMutation
    );
    assert_eq!(run_r.descriptor.retry_class, RetryClass::NonIdempotent);
    assert_eq!(run_r.descriptor.target_class, TargetClass::Workspace);

    let network = registry
        .descriptor(&CapabilityId::new("network.fetch").unwrap())
        .unwrap();
    assert_eq!(network.descriptor.effect_class, EffectClass::ExternalEffect);
    assert_eq!(
        network.descriptor.retry_class,
        RetryClass::ConditionallyIdempotent
    );
}

#[test]
fn capability_registry_provider_snapshot_filters_unsupported_targets_and_destinations() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let support = CapabilitySupport {
        targets: [TargetClass::Workspace].into_iter().collect(),
        destinations: [DestinationClass::LocalWorkspace].into_iter().collect(),
    };
    let snapshot = registry.provider_snapshot(&support);
    let ids = snapshot
        .iter()
        .map(|entry| entry.id.as_str())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"workspace.inspect"));
    assert!(ids.contains(&RUN_R_CAPABILITY));
    assert!(!ids.contains(&"network.fetch"));
    assert!(snapshot.iter().all(|entry| {
        entry
            .destinations
            .iter()
            .all(|destination| *destination == DestinationClass::LocalWorkspace)
    }));
}

#[test]
fn capability_registry_mcp_facade_and_first_party_adapter_share_fixture() {
    assert_eq!(
        mcp_facade_snapshot_fixture(),
        first_party_adapter_snapshot_fixture()
    );
}

#[test]
fn capability_registry_api_does_not_expose_executor_handles_approval_store_or_secret_resolver() {
    let source = include_str!("../src/capability_registry.rs");
    for forbidden in [
        "ExecutorHandle",
        "ApprovalStore",
        "SecretResolver",
        "resolve_secret",
    ] {
        assert!(
            !source.contains(forbidden),
            "registry leaked authority: {forbidden}"
        );
    }
}
