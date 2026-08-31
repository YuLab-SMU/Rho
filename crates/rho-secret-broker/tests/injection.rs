use std::collections::BTreeMap;

use rho_protocol::*;
use rho_secret_broker::*;

fn scope(purpose: SecretPurpose, key: &str) -> SecretLeaseScope {
    SecretLeaseScope {
        purpose,
        provider: Some(ProviderId::new("provider_main").unwrap()),
        destination: DestinationClass::ConfiguredProvider,
        audience: "target-provider-child".to_string(),
        operation_id: OperationId::new("operation_injection").unwrap(),
        expires_at_ms: 2000,
        child_env_key: key.to_string(),
    }
}

#[test]
fn injection_prefers_stdin_fd_or_socket_channel_and_never_persists_material() {
    let mut output = Vec::new();
    let receipt = inject_via_channel(
        &mut output,
        SecretMaterial::new(b"CANARY_CHANNEL_SECRET".to_vec()),
        &scope(SecretPurpose::ProviderCredential, "AISDK_PROVIDER_TOKEN"),
        InjectionPurpose::ProviderApi,
        InjectionMethod::StdinPipe,
    )
    .unwrap();
    assert_eq!(output, b"CANARY_CHANNEL_SECRET");
    assert_eq!(receipt.method, InjectionMethod::StdinPipe);
    assert!(!receipt.material_persisted);
    assert!(receipt.termination_required_on_revoke);
    let encoded = serde_json::to_string(&receipt).unwrap();
    assert!(!encoded.contains("CANARY_CHANNEL_SECRET"));
}

#[test]
fn injection_environment_fallback_is_exact_target_key_short_lived_and_cleanup_explicit() {
    let policy = InjectionPolicy {
        allow_environment_fallback: true,
        ..InjectionPolicy::default()
    };
    let mut environment = ChildEnvironment::default();
    let handle = inject_target_child_environment(
        &mut environment,
        "AISDK_PROVIDER_TOKEN",
        SecretMaterial::new(b"CANARY_ENV_SECRET".to_vec()),
        &scope(SecretPurpose::ProviderCredential, "AISDK_PROVIDER_TOKEN"),
        InjectionPurpose::ProviderApi,
        &policy,
    )
    .unwrap();
    assert_eq!(environment.vars.len(), 1);
    assert_eq!(
        environment.vars["AISDK_PROVIDER_TOKEN"],
        "CANARY_ENV_SECRET"
    );
    assert!(handle.receipt.termination_required_on_revoke);
    assert!(
        handle
            .receipt
            .residual_risk
            .contains("already-started target child")
    );
    handle.cleanup(&mut environment);
    assert!(environment.vars.is_empty());
}

#[test]
fn injection_wrong_purpose_key_and_signing_env_passthrough_fail_closed() {
    let policy = InjectionPolicy {
        allow_environment_fallback: true,
        ..InjectionPolicy::default()
    };
    let mut environment = ChildEnvironment::default();
    assert_eq!(
        inject_target_child_environment(
            &mut environment,
            "AISDK_PROVIDER_TOKEN",
            SecretMaterial::new(b"SSH_SECRET".to_vec()),
            &scope(
                SecretPurpose::RemoteExecutionCredential,
                "AISDK_PROVIDER_TOKEN"
            ),
            InjectionPurpose::ProviderApi,
            &policy,
        )
        .unwrap_err(),
        InjectionError::PurposeMismatch
    );
    assert_eq!(
        inject_target_child_environment(
            &mut environment,
            "DATABASE_URL",
            SecretMaterial::new(b"DB_SECRET".to_vec()),
            &scope(SecretPurpose::UserDefined, "DATABASE_URL"),
            InjectionPurpose::Database,
            &policy,
        )
        .unwrap_err(),
        InjectionError::EnvironmentKeyMismatch
    );
    assert_eq!(
        inject_target_child_environment(
            &mut environment,
            "SIGNING_KEY",
            SecretMaterial::new(b"SIGN_SECRET".to_vec()),
            &scope(SecretPurpose::SigningKey, "SIGNING_KEY"),
            InjectionPurpose::Signing,
            &policy,
        )
        .unwrap_err(),
        InjectionError::EnvironmentForbidden
    );
    assert!(environment.vars.is_empty());
}

#[test]
fn injection_redaction_covers_raw_base64_hex_percent_and_json_escaped_forms() {
    let secret = b"p@ss/word".to_vec();
    let input = concat!(
        "raw=p@ss/word ",
        "base64=cEBzcy93b3Jk ",
        "hex=704073732f776f7264 ",
        "url=p%40ss%2Fword ",
        "json=p@ss/word"
    );
    let redacted = redact_secret_forms(input, [secret]);
    for form in [
        "p@ss/word",
        "cEBzcy93b3Jk",
        "704073732f776f7264",
        "p%40ss%2Fword",
    ] {
        assert!(!redacted.contains(form));
    }
    assert!(redacted.matches("[REDACTED_SECRET]").count() >= 4);
}

#[test]
fn injection_canary_scan_prompts_events_logs_and_crash_dumps_is_empty_after_redaction() {
    let secret = b"CANARY_LONG_LIVED_SECRET".to_vec();
    let mut sinks = BTreeMap::from([
        (
            "prompt".to_string(),
            "prompt CANARY_LONG_LIVED_SECRET".to_string(),
        ),
        (
            "event".to_string(),
            "event CANARY_LONG_LIVED_SECRET".to_string(),
        ),
        (
            "log".to_string(),
            "log CANARY_LONG_LIVED_SECRET".to_string(),
        ),
        (
            "crash_dump".to_string(),
            "dump CANARY_LONG_LIVED_SECRET".to_string(),
        ),
    ]);
    for value in sinks.values_mut() {
        *value = redact_secret_forms(value, [secret.clone()]);
    }
    assert!(scan_for_secret_canary(&sinks, &["CANARY_LONG_LIVED_SECRET".to_string()]).is_empty());
}

#[test]
fn injection_boundary_forbids_prompt_material_token_passthrough_broad_env_and_plaintext() {
    let (_, does_not_own) = injection_boundary();
    assert!(does_not_own.contains(&"long_lived_prompt_material"));
    assert!(does_not_own.contains(&"token_passthrough"));
    assert!(does_not_own.contains(&"broad_child_environment"));
    assert!(does_not_own.contains(&"plaintext_persistence"));
}
