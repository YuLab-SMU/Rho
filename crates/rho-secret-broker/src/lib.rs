#![forbid(unsafe_code)]
//! Target owner for opaque secret references, scoped leases, injection and redaction.
//!
//! The broker persists only metadata-shaped truth. Secret material stays in memory
//! or in an environment reference and is never serializable, cloneable, or part of
//! prompts/events/diagnostics.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

use rho_protocol::{DestinationClass, OperationId, ProviderId, SecretId, SecretPurpose, SecretRef};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

pub mod injection;
pub mod os_backend;

pub use injection::*;
pub use os_backend::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretBrokerBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> SecretBrokerBoundary {
    SecretBrokerBoundary {
        owns: &[
            "secret_ref",
            "scoped_lease",
            "redaction",
            "backend_selection",
            "audit_metadata",
        ],
        does_not_own: &[
            "policy_authority",
            "provider_prompting",
            "general_child_environment",
            "plaintext_persistence",
        ],
    }
}

pub struct SecretMaterial {
    bytes: Zeroizing<Vec<u8>>,
}

impl SecretMaterial {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes: Zeroizing::new(bytes),
        }
    }

    pub fn expose_to_child_process(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Debug for SecretMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretMaterial(REDACTED)")
    }
}

impl fmt::Display for SecretMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("REDACTED")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretBackendKind {
    Memory,
    EnvReference,
    MacOsKeychain,
    WindowsCredentialManager,
    LibSecret,
    OsUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretMetadata {
    pub secret_ref: SecretRef,
    pub backend: SecretBackendKind,
    pub revoked: bool,
    pub material_recoverable_after_crash: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretLeaseScope {
    pub purpose: SecretPurpose,
    pub provider: Option<ProviderId>,
    pub destination: DestinationClass,
    pub audience: String,
    pub operation_id: OperationId,
    pub expires_at_ms: u64,
    pub child_env_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretLease {
    lease_id: String,
    secret_id: SecretId,
    scope: SecretLeaseScope,
}

impl SecretLease {
    pub fn opaque_id(&self) -> &str {
        &self.lease_id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecretAuditRecord {
    pub secret_id: SecretId,
    pub operation_id: Option<OperationId>,
    pub action: String,
    pub purpose: SecretPurpose,
    pub destination: DestinationClass,
    pub audience: Option<String>,
    pub redacted_reference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ChildEnvironment {
    pub vars: BTreeMap<String, String>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SecretBrokerError {
    #[error("secret {0} not found")]
    NotFound(SecretId),
    #[error("secret {0} is revoked")]
    Revoked(SecretId),
    #[error("lease {0} is expired")]
    LeaseExpired(String),
    #[error("lease {0} has already been used")]
    LeaseAlreadyUsed(String),
    #[error("lease does not match purpose/provider/destination/audience/operation")]
    LeaseScopeMismatch,
    #[error("env reference {0} is not available")]
    EnvReferenceUnavailable(String),
}

struct SecretEntry {
    metadata: SecretMetadata,
    material: Option<SecretMaterial>,
    env_var: Option<String>,
}

impl fmt::Debug for SecretEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretEntry")
            .field("metadata", &self.metadata)
            .field("material", &self.material.as_ref().map(|_| "REDACTED"))
            .field("env_var", &self.env_var)
            .finish()
    }
}

#[derive(Debug, Default)]
pub struct SecretBroker {
    secrets: BTreeMap<SecretId, SecretEntry>,
    leases: BTreeMap<String, SecretLease>,
    used_leases: BTreeSet<String>,
    audit: Vec<SecretAuditRecord>,
}

impl SecretBroker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put_memory(&mut self, secret_ref: SecretRef, material: SecretMaterial) -> SecretRef {
        self.insert(secret_ref, SecretBackendKind::Memory, Some(material), None)
    }

    pub fn put_env_reference(
        &mut self,
        secret_ref: SecretRef,
        env_var: impl Into<String>,
    ) -> SecretRef {
        self.insert(
            secret_ref,
            SecretBackendKind::EnvReference,
            None,
            Some(env_var.into()),
        )
    }

    pub fn issue_lease(
        &mut self,
        secret_ref: &SecretRef,
        scope: SecretLeaseScope,
    ) -> Result<SecretLease, SecretBrokerError> {
        self.ensure_scope(secret_ref, &scope)?;
        let lease = SecretLease {
            lease_id: format!(
                "secret-lease:{}:{}",
                secret_ref.secret_id.as_str(),
                scope.operation_id.as_str()
            ),
            secret_id: secret_ref.secret_id.clone(),
            scope,
        };
        self.leases.insert(lease.lease_id.clone(), lease.clone());
        self.audit.push(SecretAuditRecord {
            secret_id: secret_ref.secret_id.clone(),
            operation_id: Some(lease.scope.operation_id.clone()),
            action: "lease_issued".to_string(),
            purpose: lease.scope.purpose,
            destination: lease.scope.destination,
            audience: Some(lease.scope.audience.clone()),
            redacted_reference: redacted_reference(secret_ref),
        });
        Ok(lease)
    }

    pub fn resolve_scoped(
        &self,
        lease: &SecretLease,
        scope: &SecretLeaseScope,
        now_ms: u64,
    ) -> Result<SecretMaterial, SecretBrokerError> {
        self.validate_lease(lease, scope, now_ms, true)?;
        let entry = self
            .secrets
            .get(&lease.secret_id)
            .ok_or_else(|| SecretBrokerError::NotFound(lease.secret_id.clone()))?;
        if entry.metadata.revoked {
            return Err(SecretBrokerError::Revoked(lease.secret_id.clone()));
        }
        if let Some(material) = &entry.material {
            return Ok(SecretMaterial::new(
                material.expose_to_child_process().to_vec(),
            ));
        }
        let env_var = entry
            .env_var
            .clone()
            .ok_or_else(|| SecretBrokerError::NotFound(lease.secret_id.clone()))?;
        let value = std::env::var(&env_var)
            .map_err(|_| SecretBrokerError::EnvReferenceUnavailable(env_var))?;
        Ok(SecretMaterial::new(value.into_bytes()))
    }

    pub fn inject_once(
        &mut self,
        lease: &SecretLease,
        scope: &SecretLeaseScope,
        now_ms: u64,
        child: &mut ChildEnvironment,
    ) -> Result<(), SecretBrokerError> {
        self.validate_lease(lease, scope, now_ms, true)?;
        let material = self.resolve_scoped(lease, scope, now_ms)?;
        child.vars.insert(
            scope.child_env_key.clone(),
            String::from_utf8_lossy(material.expose_to_child_process()).to_string(),
        );
        self.used_leases.insert(lease.lease_id.clone());
        self.audit.push(SecretAuditRecord {
            secret_id: lease.secret_id.clone(),
            operation_id: Some(scope.operation_id.clone()),
            action: "inject_once".to_string(),
            purpose: scope.purpose,
            destination: scope.destination,
            audience: Some(scope.audience.clone()),
            redacted_reference: format!("{}:{:?}", lease.secret_id, scope.purpose),
        });
        Ok(())
    }

    pub fn revoke(&mut self, secret_ref: &SecretRef) -> Result<(), SecretBrokerError> {
        let entry = self
            .secrets
            .get_mut(&secret_ref.secret_id)
            .ok_or_else(|| SecretBrokerError::NotFound(secret_ref.secret_id.clone()))?;
        entry.metadata.revoked = true;
        self.audit.push(SecretAuditRecord {
            secret_id: secret_ref.secret_id.clone(),
            operation_id: None,
            action: "revoke".to_string(),
            purpose: secret_ref.purpose,
            destination: secret_ref.destination_scope,
            audience: None,
            redacted_reference: redacted_reference(secret_ref),
        });
        Ok(())
    }

    pub fn rotate(&mut self, secret_ref: SecretRef, material: SecretMaterial) -> SecretRef {
        self.put_memory(secret_ref, material)
    }

    pub fn audit_metadata(&self) -> &[SecretAuditRecord] {
        &self.audit
    }

    pub fn recover_metadata_after_crash(&self) -> Vec<SecretMetadata> {
        self.secrets
            .values()
            .map(|entry| {
                let mut metadata = entry.metadata.clone();
                if metadata.backend == SecretBackendKind::Memory {
                    metadata.material_recoverable_after_crash = false;
                }
                metadata
            })
            .collect()
    }

    pub fn from_recovered_metadata(metadata: Vec<SecretMetadata>) -> Self {
        let mut broker = Self::new();
        for mut item in metadata {
            item.material_recoverable_after_crash = false;
            broker.secrets.insert(
                item.secret_ref.secret_id.clone(),
                SecretEntry {
                    metadata: item,
                    material: None,
                    env_var: None,
                },
            );
        }
        broker
    }

    pub fn redact_text(&self, text: &str) -> String {
        let mut secrets = Vec::new();
        for entry in self.secrets.values() {
            if let Some(material) = &entry.material {
                secrets.push(material.expose_to_child_process().to_vec());
            }
            if let Some(env_var) = &entry.env_var
                && let Ok(value) = std::env::var(env_var)
            {
                secrets.push(value.into_bytes());
            }
        }
        redact_secret_forms(text, secrets)
    }

    fn insert(
        &mut self,
        secret_ref: SecretRef,
        backend: SecretBackendKind,
        material: Option<SecretMaterial>,
        env_var: Option<String>,
    ) -> SecretRef {
        let metadata = SecretMetadata {
            secret_ref: secret_ref.clone(),
            backend,
            revoked: false,
            material_recoverable_after_crash: material.is_none(),
        };
        self.secrets.insert(
            secret_ref.secret_id.clone(),
            SecretEntry {
                metadata,
                material,
                env_var,
            },
        );
        self.audit.push(SecretAuditRecord {
            secret_id: secret_ref.secret_id.clone(),
            operation_id: None,
            action: "put".to_string(),
            purpose: secret_ref.purpose,
            destination: secret_ref.destination_scope,
            audience: None,
            redacted_reference: redacted_reference(&secret_ref),
        });
        secret_ref
    }

    fn ensure_scope(
        &self,
        secret_ref: &SecretRef,
        scope: &SecretLeaseScope,
    ) -> Result<(), SecretBrokerError> {
        let entry = self
            .secrets
            .get(&secret_ref.secret_id)
            .ok_or_else(|| SecretBrokerError::NotFound(secret_ref.secret_id.clone()))?;
        if entry.metadata.revoked {
            return Err(SecretBrokerError::Revoked(secret_ref.secret_id.clone()));
        }
        if secret_ref.purpose != scope.purpose
            || secret_ref.provider != scope.provider
            || secret_ref.destination_scope != scope.destination
        {
            return Err(SecretBrokerError::LeaseScopeMismatch);
        }
        Ok(())
    }

    fn validate_lease(
        &self,
        lease: &SecretLease,
        scope: &SecretLeaseScope,
        now_ms: u64,
        check_single_use: bool,
    ) -> Result<(), SecretBrokerError> {
        if now_ms > lease.scope.expires_at_ms {
            return Err(SecretBrokerError::LeaseExpired(lease.lease_id.clone()));
        }
        if check_single_use && self.used_leases.contains(&lease.lease_id) {
            return Err(SecretBrokerError::LeaseAlreadyUsed(lease.lease_id.clone()));
        }
        if &lease.scope != scope {
            return Err(SecretBrokerError::LeaseScopeMismatch);
        }
        if !self.leases.contains_key(&lease.lease_id) {
            return Err(SecretBrokerError::LeaseScopeMismatch);
        }
        Ok(())
    }
}

pub fn redacted_reference(secret: &SecretRef) -> String {
    format!("{}:{:?}", secret.secret_id, secret.purpose)
}
