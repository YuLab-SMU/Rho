#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt};

use rho_agent_host::{
    AgentProvider, FakeProvider, FakeProviderScenario, process::executable_digest,
    providers::external::*,
};
use rho_control_plane::CapabilityRegistry;
use rho_protocol::*;
use serde_json::json;

fn installed() -> (tempfile::TempDir, ExternalObserverProvider) {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("observer.sh");
    fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&executable, permissions).unwrap();
    let sandbox = temp.path().join("empty-snapshot");
    fs::create_dir(&sandbox).unwrap();
    let provider =
        ExternalObserverProvider::from_explicit_install(ExternalProviderInstallManifest {
            provider_id: ProviderId::new("provider_external_observer").unwrap(),
            version: SELECTED_EXTERNAL_PROVIDER_VERSION.to_string(),
            executable_sha256: executable_digest(&executable).unwrap(),
            executable,
            isolated_root: temp.path().to_path_buf(),
            enabled: true,
        })
        .unwrap();
    (temp, provider)
}

#[test]
fn external_provider_requires_explicit_enabled_install_and_exact_digest() {
    let temp = tempfile::tempdir().unwrap();
    let executable = temp.path().join("observer.sh");
    fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    let mut permissions = fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&executable, permissions).unwrap();
    let base = ExternalProviderInstallManifest {
        provider_id: ProviderId::new("provider_external_observer").unwrap(),
        version: SELECTED_EXTERNAL_PROVIDER_VERSION.to_string(),
        executable_sha256: executable_digest(&executable).unwrap(),
        executable,
        isolated_root: temp.path().to_path_buf(),
        enabled: false,
    };
    assert!(matches!(
        ExternalObserverProvider::from_explicit_install(base.clone()),
        Err(ExternalProviderError::Disabled)
    ));
    let mut wrong = base;
    wrong.enabled = true;
    wrong.executable_sha256 =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    assert!(matches!(
        ExternalObserverProvider::from_explicit_install(wrong),
        Err(ExternalProviderError::DigestMismatch)
    ));
    assert_eq!(SELECTED_EXTERNAL_PROVIDER, "rho-observer-acp");
}

#[test]
fn external_provider_advertises_only_bounded_read_capabilities() {
    let (_temp, provider) = installed();
    let snapshot = provider.snapshot();
    for expected in [
        "workspace.inspect",
        "workspace.inspect_object",
        "snapshot.read",
        "history.errors",
    ] {
        assert!(
            snapshot
                .capability_ids
                .contains(&CapabilityId::new(expected).unwrap())
        );
    }
    for forbidden in [
        RUN_R_CAPABILITY,
        "project.apply_patch",
        "network.fetch",
        "shell.execute",
        "secret.resolve",
    ] {
        assert!(
            !snapshot
                .capability_ids
                .contains(&CapabilityId::new(forbidden).unwrap())
        );
    }
    assert!(
        external_observer_capabilities()
            .iter()
            .all(|capability| capability.effect_class == EffectClass::Read)
    );
}

#[test]
fn external_provider_mutation_shell_secret_and_network_attempts_are_canonical_denies_with_no_side_effect()
 {
    let (temp, provider) = installed();
    let sentinel = temp.path().join("sentinel");
    fs::write(&sentinel, "unchanged").unwrap();
    let registry = CapabilityRegistry::canonical().unwrap();
    for (capability, arguments) in [
        (
            RUN_R_CAPABILITY,
            json!({"code":"writeLines('changed', 'sentinel')"}),
        ),
        ("project.apply_patch", json!({"patch":"delete everything"})),
        ("network.fetch", json!({"url":"https://attacker.invalid"})),
        ("shell.execute", json!({"command":"rm -rf ."})),
        ("secret.resolve", json!({"secret":"provider-token"})),
    ] {
        assert_eq!(
            provider.assess_capability(
                &registry,
                &CapabilityId::new(capability).unwrap(),
                &arguments,
            ),
            ExternalCapabilityDecision::Denied {
                reason_code: if ["shell.execute", "secret.resolve"].contains(&capability) {
                    "external_observer_unknown_capability"
                } else {
                    "external_observer_read_only"
                }
                .to_string(),
            }
        );
    }
    assert_eq!(fs::read_to_string(sentinel).unwrap(), "unchanged");
}

#[test]
fn external_provider_receives_empty_snapshot_sandbox_no_path_socket_or_general_env() {
    let (temp, provider) = installed();
    let sandbox = temp.path().join("empty-snapshot");
    let spec = provider.process_spec(sandbox.clone()).unwrap();
    assert_eq!(spec.working_directory, sandbox.canonicalize().unwrap());
    assert!(spec.environment.is_empty());
    assert!(fs::read_dir(&sandbox).unwrap().next().is_none());
    let encoded = serde_json::to_string(&provider.status()).unwrap();
    assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));
    for forbidden in ["workspace_socket", "project_root", "terminal", "secret"] {
        assert!(!encoded.to_ascii_lowercase().contains(forbidden));
    }
}

#[test]
fn external_provider_observation_is_revision_bound_bounded_and_sensitive() {
    let (_temp, provider) = installed();
    let observation = provider
        .bound_observation(
            CapabilityId::new("workspace.inspect").unwrap(),
            DataClass::ProjectConfidential,
            "workspace_1/kernel_1/42/3",
            (0..MAX_EXTERNAL_RESULT_ITEMS + 20)
                .map(|index| json!({"object": format!("object_{index}")}))
                .collect(),
        )
        .unwrap();
    assert_eq!(observation.items.len(), MAX_EXTERNAL_RESULT_ITEMS);
    assert!(observation.truncated);
    assert_eq!(observation.sensitivity, DataClass::ProjectConfidential);
    assert_eq!(observation.revision_ref, "workspace_1/kernel_1/42/3");
}

#[test]
fn external_provider_switch_keeps_canonical_snapshot_schema_and_authority_contract() {
    let (_temp, external) = installed();
    let first_party = FakeProvider::new(FakeProviderScenario::Normal);
    let external_value = serde_json::to_value(external.snapshot()).unwrap();
    let first_party_value = serde_json::to_value(first_party.snapshot()).unwrap();
    let mut external_keys = external_value
        .as_object()
        .unwrap()
        .keys()
        .collect::<Vec<_>>();
    let mut first_keys = first_party_value
        .as_object()
        .unwrap()
        .keys()
        .collect::<Vec<_>>();
    external_keys.sort();
    first_keys.sort();
    assert_eq!(external_keys, first_keys);
    assert!(external.status().read_only);
}

#[test]
fn external_provider_offline_crash_and_uninstalled_status_leave_ide_workspace_available() {
    let (_temp, mut provider) = installed();
    provider.mark_offline();
    assert!(
        provider
            .status()
            .user_summary
            .contains("IDE and Workspace remain available")
    );
    provider.mark_crashed();
    assert!(provider.status().user_summary.contains("logical session"));
    let uninstalled = unavailable_external_status(ExternalProviderAvailability::Uninstalled);
    assert!(uninstalled.user_summary.contains("install explicitly"));
    assert!(uninstalled.read_only);
}

#[test]
fn external_provider_source_has_no_download_authority_socket_path_terminal_or_general_env_api() {
    let source = include_str!("../src/providers/external/mod.rs");
    for forbidden in [
        "download_provider",
        "registry_client",
        "WorkspaceExecutor",
        "SecretBroker",
        "std::env::vars",
        "Command::new",
    ] {
        assert!(
            !source.contains(forbidden),
            "external provider leaked {forbidden}"
        );
    }
    let (_, does_not_own) = external_provider_boundary();
    assert!(does_not_own.contains(&"workspace_socket"));
    assert!(does_not_own.contains(&"terminal_capability"));
    assert!(does_not_own.contains(&"effect_authority"));
}
