use std::collections::BTreeMap;

use rho_protocol::*;
use rho_secret_broker::*;

#[derive(Debug)]
struct FakeNativeService {
    status: OsBackendStatus,
    values: BTreeMap<(String, String), Vec<u8>>,
}

impl FakeNativeService {
    fn available() -> Self {
        Self {
            status: OsBackendStatus::Available,
            values: BTreeMap::new(),
        }
    }
}

impl NativeCredentialService for FakeNativeService {
    fn status(&self) -> OsBackendStatus {
        self.status.clone()
    }

    fn put(
        &mut self,
        service: &str,
        account: &str,
        material: &[u8],
    ) -> Result<(), OsSecretBackendError> {
        self.values.insert(
            (service.to_string(), account.to_string()),
            material.to_vec(),
        );
        Ok(())
    }

    fn get(&mut self, service: &str, account: &str) -> Result<Vec<u8>, OsSecretBackendError> {
        self.values
            .get(&(service.to_string(), account.to_string()))
            .cloned()
            .ok_or(OsSecretBackendError::Missing)
    }

    fn delete(&mut self, service: &str, account: &str) -> Result<(), OsSecretBackendError> {
        self.values
            .remove(&(service.to_string(), account.to_string()));
        Ok(())
    }
}

fn reference() -> SecretRef {
    let mut reference = SecretRef::new(
        SecretId::new("secret_os_provider").unwrap(),
        SecretPurpose::ProviderCredential,
        DestinationClass::ConfiguredProvider,
    );
    reference.provider = Some(ProviderId::new("provider_main").unwrap());
    reference
}

#[test]
fn os_backend_crud_rotate_revoke_and_metadata_never_persist_plaintext() {
    let mut vault = OsSecretVault::new(
        selected_os_backend_kind(),
        "org.yulab.rho",
        FakeNativeService::available(),
    );
    let reference = vault
        .put(
            reference(),
            SecretMaterial::new(b"CANARY_OS_SECRET".to_vec()),
        )
        .unwrap();
    assert_eq!(
        vault.resolve(&reference).unwrap().expose_to_child_process(),
        b"CANARY_OS_SECRET"
    );
    vault
        .rotate(&reference, SecretMaterial::new(b"ROTATED_SECRET".to_vec()))
        .unwrap();
    assert_eq!(
        vault.resolve(&reference).unwrap().expose_to_child_process(),
        b"ROTATED_SECRET"
    );
    let metadata = serde_json::to_string(&vault.metadata()).unwrap();
    assert!(!metadata.contains("CANARY_OS_SECRET"));
    assert!(!metadata.contains("ROTATED_SECRET"));
    vault.revoke(&reference).unwrap();
    assert!(matches!(
        vault.resolve(&reference),
        Err(OsSecretBackendError::Denied(_))
    ));
}

#[test]
fn os_backend_locked_unavailable_denied_are_actionable_and_never_fallback_plaintext() {
    for status in [
        OsBackendStatus::Locked {
            action: "Unlock the login keychain".to_string(),
        },
        OsBackendStatus::Unavailable {
            action: "Install and unlock a Secret Service".to_string(),
        },
        OsBackendStatus::Denied {
            action: "Grant credential access".to_string(),
        },
    ] {
        let mut vault = OsSecretVault::new(
            selected_os_backend_kind(),
            "org.yulab.rho",
            FakeNativeService {
                status,
                values: BTreeMap::new(),
            },
        );
        let error = vault
            .put(
                reference(),
                SecretMaterial::new(b"CANARY_NO_FALLBACK".to_vec()),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            OsSecretBackendError::Locked(_)
                | OsSecretBackendError::Unavailable(_)
                | OsSecretBackendError::Denied(_)
        ));
        assert!(!error.to_string().contains("CANARY_NO_FALLBACK"));
    }
}

#[test]
fn os_backend_platform_selection_is_explicit() {
    #[cfg(target_os = "macos")]
    assert_eq!(
        selected_os_backend_kind(),
        OsSecretBackendKind::MacOsKeychain
    );
    #[cfg(target_os = "windows")]
    assert_eq!(
        selected_os_backend_kind(),
        OsSecretBackendKind::WindowsCredentialManager
    );
    #[cfg(all(unix, not(target_os = "macos")))]
    assert_eq!(selected_os_backend_kind(), OsSecretBackendKind::LibSecret);
}

#[test]
fn os_backend_source_forbids_plaintext_argv_config_sqlite_and_diagnostics() {
    let source = include_str!("../src/os_backend.rs")
        .split("pub fn os_backend_boundary")
        .next()
        .unwrap();
    for forbidden in [
        "Command::new",
        "std::env::set_var",
        "rusqlite",
        "fs::write",
        "println!",
    ] {
        assert!(
            !source.contains(forbidden),
            "OS backend leaked sink {forbidden}"
        );
    }
    let (_, does_not_own) = os_backend_boundary();
    assert!(does_not_own.contains(&"plaintext_fallback"));
    assert!(does_not_own.contains(&"secret_in_argv"));
}
