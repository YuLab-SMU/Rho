use rho_protocol::*;
use rho_secret_broker::*;

fn secret_ref() -> SecretRef {
    let mut reference = SecretRef::new(
        SecretId::new("secret_provider_main").unwrap(),
        SecretPurpose::ProviderCredential,
        DestinationClass::AllowlistedDomain,
    );
    reference.provider = Some(ProviderId::new("provider_main").unwrap());
    reference
}

fn scope() -> SecretLeaseScope {
    SecretLeaseScope {
        purpose: SecretPurpose::ProviderCredential,
        provider: Some(ProviderId::new("provider_main").unwrap()),
        destination: DestinationClass::AllowlistedDomain,
        audience: "provider-child".to_string(),
        operation_id: OperationId::new("operation_secret").unwrap(),
        expires_at_ms: 2000,
        child_env_key: "PROVIDER_TOKEN".to_string(),
    }
}

#[test]
fn secret_material_is_redacted_and_not_serializable_in_metadata_surfaces() {
    let mut broker = SecretBroker::new();
    let reference = broker.put_memory(secret_ref(), SecretMaterial::new(b"CANARY_SECRET".to_vec()));
    let metadata_json = serde_json::to_string(&broker.audit_metadata()).unwrap();
    let ref_json = serde_json::to_string(&reference).unwrap();
    assert!(!metadata_json.contains("CANARY_SECRET"));
    assert!(!ref_json.contains("CANARY_SECRET"));
    assert_eq!(
        format!("{:?}", SecretMaterial::new(b"CANARY_SECRET".to_vec())),
        "SecretMaterial(REDACTED)"
    );
    assert_eq!(
        broker.redact_text("token=CANARY_SECRET"),
        "token=[REDACTED_SECRET]"
    );
}

#[test]
fn secret_lease_binds_purpose_provider_destination_audience_operation_expiry_and_single_use() {
    let mut broker = SecretBroker::new();
    let reference = broker.put_memory(secret_ref(), SecretMaterial::new(b"TOKEN_A".to_vec()));
    let scope = scope();
    let lease = broker.issue_lease(&reference, scope.clone()).unwrap();

    let mut wrong_audience = scope.clone();
    wrong_audience.audience = "other-child".to_string();
    assert_eq!(
        broker
            .resolve_scoped(&lease, &wrong_audience, 1000)
            .unwrap_err(),
        SecretBrokerError::LeaseScopeMismatch
    );
    assert!(matches!(
        broker.resolve_scoped(&lease, &scope, 3000),
        Err(SecretBrokerError::LeaseExpired(_))
    ));

    let mut child = ChildEnvironment::default();
    broker
        .inject_once(&lease, &scope, 1000, &mut child)
        .unwrap();
    assert_eq!(child.vars.get("PROVIDER_TOKEN").unwrap(), "TOKEN_A");
    assert_eq!(
        child.vars.len(),
        1,
        "unrelated child env must not inherit broad credentials"
    );
    assert!(matches!(
        broker.inject_once(&lease, &scope, 1000, &mut child),
        Err(SecretBrokerError::LeaseAlreadyUsed(_))
    ));
}

#[test]
fn secret_wrong_purpose_and_revoke_hard_fail() {
    let mut broker = SecretBroker::new();
    let reference = broker.put_memory(secret_ref(), SecretMaterial::new(b"TOKEN_B".to_vec()));
    let mut bad_scope = scope();
    bad_scope.purpose = SecretPurpose::RemoteExecutionCredential;
    assert_eq!(
        broker.issue_lease(&reference, bad_scope).unwrap_err(),
        SecretBrokerError::LeaseScopeMismatch
    );

    broker.revoke(&reference).unwrap();
    assert!(matches!(
        broker.issue_lease(&reference, scope()),
        Err(SecretBrokerError::Revoked(_))
    ));
}

#[test]
fn secret_memory_backend_releases_material_after_crash_but_metadata_truth_recovers() {
    let mut broker = SecretBroker::new();
    let reference = broker.put_memory(secret_ref(), SecretMaterial::new(b"TOKEN_C".to_vec()));
    let recovered_metadata = broker.recover_metadata_after_crash();
    assert_eq!(recovered_metadata.len(), 1);
    assert!(!recovered_metadata[0].material_recoverable_after_crash);
    let mut recovered = SecretBroker::from_recovered_metadata(recovered_metadata);
    let lease = recovered.issue_lease(&reference, scope()).unwrap();
    assert!(matches!(
        recovered.resolve_scoped(&lease, &scope(), 1000),
        Err(SecretBrokerError::NotFound(_))
    ));
}

#[test]
fn secret_env_reference_injects_only_requested_child_key() {
    let mut broker = SecretBroker::new();
    unsafe {
        std::env::set_var("RHO_TEST_PROVIDER_TOKEN", "TOKEN_ENV");
    }
    let reference = broker.put_env_reference(secret_ref(), "RHO_TEST_PROVIDER_TOKEN");
    let lease = broker.issue_lease(&reference, scope()).unwrap();
    let mut child = ChildEnvironment::default();
    broker
        .inject_once(&lease, &scope(), 1000, &mut child)
        .unwrap();
    assert_eq!(
        child.vars,
        [("PROVIDER_TOKEN".to_string(), "TOKEN_ENV".to_string())].into()
    );
    assert!(!child.vars.contains_key("RHO_TEST_PROVIDER_TOKEN"));
    unsafe {
        std::env::remove_var("RHO_TEST_PROVIDER_TOKEN");
    }
}

#[test]
fn secret_broker_source_has_no_plaintext_persistence_or_general_env_sink() {
    let source = include_str!("../src/lib.rs");
    for forbidden in ["sqlite", "fs::write", "persist_plaintext", "Command::envs"] {
        assert!(
            !source.to_lowercase().contains(forbidden),
            "secret broker leaked forbidden sink: {forbidden}"
        );
    }
    assert!(boundary().does_not_own.contains(&"plaintext_persistence"));
}
