use std::collections::BTreeMap;

use rho_protocol::{SecretId, SecretRef};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{SecretBackendKind, SecretMaterial, SecretMetadata};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OsSecretBackendKind {
    MacOsKeychain,
    WindowsCredentialManager,
    LibSecret,
    PlatformUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum OsBackendStatus {
    Available,
    Locked { action: String },
    Unavailable { action: String },
    Denied { action: String },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum OsSecretBackendError {
    #[error("OS secret backend is locked: {0}")]
    Locked(String),
    #[error("OS secret backend is unavailable: {0}")]
    Unavailable(String),
    #[error("OS secret backend access was denied: {0}")]
    Denied(String),
    #[error("OS secret backend entry is missing")]
    Missing,
    #[error("OS secret backend operation failed without exposing material")]
    Failed,
}

/// Narrow bridge to a native Keychain/Credential Manager/libsecret API.
/// Implementations receive material only in process memory and must never put
/// it in argv, environment, logs, config, SQLite, or diagnostics.
pub trait NativeCredentialService {
    fn status(&self) -> OsBackendStatus;
    fn put(
        &mut self,
        service: &str,
        account: &str,
        material: &[u8],
    ) -> Result<(), OsSecretBackendError>;
    fn get(&mut self, service: &str, account: &str) -> Result<Vec<u8>, OsSecretBackendError>;
    fn delete(&mut self, service: &str, account: &str) -> Result<(), OsSecretBackendError>;
}

pub struct OsSecretVault<S> {
    kind: OsSecretBackendKind,
    service_name: String,
    native: S,
    metadata: BTreeMap<SecretId, SecretMetadata>,
}

impl<S: NativeCredentialService> OsSecretVault<S> {
    pub fn new(kind: OsSecretBackendKind, service_name: impl Into<String>, native: S) -> Self {
        Self {
            kind,
            service_name: service_name.into(),
            native,
            metadata: BTreeMap::new(),
        }
    }

    pub fn status(&self) -> OsBackendStatus {
        self.native.status()
    }

    pub fn put(
        &mut self,
        secret_ref: SecretRef,
        material: SecretMaterial,
    ) -> Result<SecretRef, OsSecretBackendError> {
        ensure_available(self.native.status())?;
        self.native.put(
            &self.service_name,
            secret_ref.secret_id.as_str(),
            material.expose_to_child_process(),
        )?;
        self.metadata.insert(
            secret_ref.secret_id.clone(),
            SecretMetadata {
                secret_ref: secret_ref.clone(),
                backend: backend_kind(self.kind),
                revoked: false,
                material_recoverable_after_crash: true,
            },
        );
        Ok(secret_ref)
    }

    pub fn resolve(
        &mut self,
        secret_ref: &SecretRef,
    ) -> Result<SecretMaterial, OsSecretBackendError> {
        ensure_available(self.native.status())?;
        let metadata = self
            .metadata
            .get(&secret_ref.secret_id)
            .ok_or(OsSecretBackendError::Missing)?;
        if metadata.revoked {
            return Err(OsSecretBackendError::Denied(
                "secret is revoked; create a new credential".to_string(),
            ));
        }
        let bytes = self
            .native
            .get(&self.service_name, secret_ref.secret_id.as_str())?;
        Ok(SecretMaterial::new(bytes))
    }

    pub fn rotate(
        &mut self,
        secret_ref: &SecretRef,
        material: SecretMaterial,
    ) -> Result<(), OsSecretBackendError> {
        ensure_available(self.native.status())?;
        if !self.metadata.contains_key(&secret_ref.secret_id) {
            return Err(OsSecretBackendError::Missing);
        }
        self.native.put(
            &self.service_name,
            secret_ref.secret_id.as_str(),
            material.expose_to_child_process(),
        )
    }

    pub fn revoke(&mut self, secret_ref: &SecretRef) -> Result<(), OsSecretBackendError> {
        let metadata = self
            .metadata
            .get_mut(&secret_ref.secret_id)
            .ok_or(OsSecretBackendError::Missing)?;
        metadata.revoked = true;
        self.native
            .delete(&self.service_name, secret_ref.secret_id.as_str())
    }

    pub fn metadata(&self) -> Vec<SecretMetadata> {
        self.metadata.values().cloned().collect()
    }
}

pub fn selected_os_backend_kind() -> OsSecretBackendKind {
    #[cfg(target_os = "macos")]
    {
        OsSecretBackendKind::MacOsKeychain
    }
    #[cfg(target_os = "windows")]
    {
        OsSecretBackendKind::WindowsCredentialManager
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        OsSecretBackendKind::LibSecret
    }
    #[cfg(not(any(unix, windows)))]
    {
        OsSecretBackendKind::PlatformUnavailable
    }
}

fn ensure_available(status: OsBackendStatus) -> Result<(), OsSecretBackendError> {
    match status {
        OsBackendStatus::Available => Ok(()),
        OsBackendStatus::Locked { action } => Err(OsSecretBackendError::Locked(action)),
        OsBackendStatus::Unavailable { action } => Err(OsSecretBackendError::Unavailable(action)),
        OsBackendStatus::Denied { action } => Err(OsSecretBackendError::Denied(action)),
    }
}

fn backend_kind(kind: OsSecretBackendKind) -> SecretBackendKind {
    match kind {
        OsSecretBackendKind::MacOsKeychain => SecretBackendKind::MacOsKeychain,
        OsSecretBackendKind::WindowsCredentialManager => {
            SecretBackendKind::WindowsCredentialManager
        }
        OsSecretBackendKind::LibSecret => SecretBackendKind::LibSecret,
        OsSecretBackendKind::PlatformUnavailable => SecretBackendKind::OsUnavailable,
    }
}

pub fn os_backend_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &["native_crud", "backend_status", "secret_ref_metadata"],
        &[
            "plaintext_fallback",
            "secret_in_argv",
            "secret_in_config",
            "secret_in_sqlite",
            "secret_in_diagnostic",
        ],
    )
}
