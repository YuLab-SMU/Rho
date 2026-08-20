//! Read-only broker permission grants and constrained handles (P2-2).
//!
//! A plugin receives an *opaque* handle token, never a mutable permission
//! object. The broker owns the authoritative `PluginGrant` state and
//! revalidates every privileged call against the exact plugin instance,
//! package digest, project/scope/generation, permission kind, resource, and
//! expiry. This module is broker-side logic only: it performs no filesystem,
//! network, Workspace R, or credential operation itself, and it never logs the
//! raw token.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::digest::PackageDigest;
use crate::host::HostInstanceId;
use crate::{
    ActivationGeneration, ExtensionError, PermissionRequest, PluginId, PluginVersion, RuntimeKind,
    ScopeId,
};

/// Maximum unused lifetime of an `allow once` handle.
pub const MAX_ALLOW_ONCE_TTL: Duration = Duration::from_secs(5 * 60);
/// Maximum lifetime of a project decision before trusted review is required.
pub const MAX_PROJECT_GRANT_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The initial, read-only permission set. Writes, process spawn, arbitrary R
/// evaluation, package install, raw credentials, and clipboard are all
/// deferred and must never appear in this set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    /// Read files inside the canonical project root only.
    ProjectFsRead,
    /// Inspect Workspace R metadata/preview with exact bounds.
    WorkspaceRInspect,
    /// Fetch over HTTPS with exact host/method/redirect/byte/time constraints.
    NetworkFetch,
}

impl PermissionKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "project.fs.read" => Some(Self::ProjectFsRead),
            "workspace.r.inspect" => Some(Self::WorkspaceRInspect),
            "network.fetch" => Some(Self::NetworkFetch),
            _ => None,
        }
    }

    pub fn as_static_str(self) -> &'static str {
        match self {
            Self::ProjectFsRead => "project.fs.read",
            Self::WorkspaceRInspect => "workspace.r.inspect",
            Self::NetworkFetch => "network.fetch",
        }
    }
}

/// Where a grant came from. Only two sources exist in initial Phase 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantSource {
    /// Single-use `allow once`.
    AllowOnce,
    /// Bounded to the current project.
    Project,
}

/// Resource-level constraints bound to a grant. Kept intentionally small; the
/// exact semantics are validated at the authoritative boundary, not here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionConstraints {
    /// Allowed relative path globs (project.fs.read).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// Allowed operation names (workspace.r.inspect).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<String>,
    /// Allowed URL schemes (network.fetch).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub schemes: Vec<String>,
    /// Allowed hosts (network.fetch).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
    /// Allowed HTTP methods (network.fetch).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
    /// Maximum bytes read or returned for filesystem/Workspace R operations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    /// Maximum response bytes for this permission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_response_bytes: Option<u64>,
}

impl PermissionConstraints {
    pub fn from_manifest(request: &PermissionRequest) -> Result<Self, ExtensionError> {
        let permission = PermissionKind::parse(&request.name).ok_or_else(|| {
            ExtensionError::ManifestValidation {
                reason: format!("unsupported permission request: {}", request.name),
            }
        })?;
        let constraints = Self {
            paths: request.paths.clone(),
            operations: request.operations.clone(),
            schemes: request.schemes.clone(),
            hosts: request.hosts.clone(),
            methods: request.methods.clone(),
            max_bytes: request.max_bytes,
            max_response_bytes: request.max_response_bytes,
        };
        validate_constraints(permission, &constraints)?;
        Ok(constraints)
    }

    /// Canonical JSON used by both durable decisions and the live reference
    /// monitor. `serde_json::Map` is key-sorted in this workspace, so parsing
    /// and serializing the value yields a deterministic encoding.
    pub fn canonical_json(&self) -> Result<String, ExtensionError> {
        let value =
            serde_json::to_value(self).map_err(|error| ExtensionError::ManifestValidation {
                reason: format!("permission constraints could not be encoded: {error}"),
            })?;
        serde_json::to_string(&value).map_err(|error| ExtensionError::ManifestValidation {
            reason: format!("permission constraints could not be canonicalized: {error}"),
        })
    }

    pub fn digest(&self) -> Result<String, ExtensionError> {
        self.canonical_json()
            .map(|canonical| sha256_hex(canonical.as_bytes()))
    }
}

/// Exact Workspace lineage optionally bound to a live grant. Filesystem and
/// network grants use `None`; Workspace inspection grants require `Some`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceGrantIdentity {
    pub workspace_id: String,
    pub kernel_instance_id: String,
    pub state_revision: u64,
    pub project_revision: u64,
}

/// The authoritative broker grant record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginGrant {
    pub durable_grant_id: String,
    /// Opaque handle digest; the raw token is never persisted or logged.
    pub handle_digest: String,
    pub normalized_project_root: String,
    pub plugin_id: PluginId,
    pub plugin_version: PluginVersion,
    pub runtime_kind: RuntimeKind,
    pub host_instance_id: HostInstanceId,
    pub package_digest: PackageDigest,
    pub project_id: ScopeId,
    pub scope_id: ScopeId,
    pub activation_generation: ActivationGeneration,
    pub permission: PermissionKind,
    pub constraints: PermissionConstraints,
    pub constraints_digest: String,
    pub grant_source: GrantSource,
    pub policy_revision: u64,
    pub workspace: Option<WorkspaceGrantIdentity>,
    pub created_at_millis: u64,
    pub expires_at_millis: u64,
    pub revoked_at_millis: Option<u64>,
    /// `allow once` grants are consumed after a single successful use.
    pub used: bool,
    /// Admission reserves an allow-once grant so two concurrent calls cannot
    /// both start. Failure before dispatch releases this reservation.
    pub in_flight: bool,
}

impl PluginGrant {
    pub fn is_active(&self, now_millis: u64) -> bool {
        self.revoked_at_millis.is_none() && !self.consumed(now_millis)
    }

    fn consumed(&self, now_millis: u64) -> bool {
        self.used || now_millis >= self.expires_at_millis
    }
}

/// An opaque capability handle surfaced to a plugin. It carries only a
/// non-secret identifier and never the authorization state itself.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityHandle {
    pub id: String,
    pub permission: PermissionKind,
    pub scope_id: ScopeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_millis: Option<u64>,
}

impl std::fmt::Debug for CapabilityHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CapabilityHandle")
            .field("id", &"<redacted>")
            .field("permission", &self.permission)
            .field("scope_id", &self.scope_id)
            .field("expires_at_millis", &self.expires_at_millis)
            .finish()
    }
}

/// Revalidation outcome for a privileged call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Revalidation {
    Allowed,
    Denied(GrantErrorKind),
}

/// Why a revalidation was denied. Stable, non-sensitive, and auditable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantErrorKind {
    UnknownHandle,
    Revoked,
    Expired,
    Consumed,
    InFlight,
    NotAdmitted,
    WrongPlugin,
    WrongHostSession,
    WrongProject,
    WrongScope,
    WrongGeneration,
    WrongPackageDigest,
    WrongPermission,
    WrongWorkspace,
    ConstraintViolation,
}

/// A broker-owned grant store. This is the reference monitor for read-only
/// permissions: it grants, revokes, and revalidates. It performs no I/O and
/// stores no raw tokens — only SHA-256 digests of the opaque handle id.
pub trait GrantClock: Send + Sync {
    fn now_millis(&self) -> u64;
}

pub trait GrantTokenSource: Send + Sync {
    fn next_token(&self) -> [u8; 32];
}

#[derive(Debug, Default)]
pub struct SystemGrantClock;

impl GrantClock for SystemGrantClock {
    fn now_millis(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }
}

#[derive(Debug, Default)]
pub struct OsGrantTokenSource;

impl GrantTokenSource for OsGrantTokenSource {
    fn next_token(&self) -> [u8; 32] {
        rand::random()
    }
}

pub struct GrantStore {
    grants: std::collections::BTreeMap<String, PluginGrant>,
    durable_handles: std::collections::BTreeMap<String, String>,
    clock: Arc<dyn GrantClock>,
    token_source: Arc<dyn GrantTokenSource>,
}

impl std::fmt::Debug for GrantStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GrantStore")
            .field("grant_count", &self.grants.len())
            .finish_non_exhaustive()
    }
}

impl Default for GrantStore {
    fn default() -> Self {
        Self::new()
    }
}

/// The exact parameters required to issue a read-only grant.
#[derive(Debug, Clone)]
pub struct GrantRequest {
    pub durable_grant_id: String,
    pub normalized_project_root: String,
    pub plugin_id: PluginId,
    pub plugin_version: PluginVersion,
    pub runtime_kind: RuntimeKind,
    pub host_instance_id: HostInstanceId,
    pub package_digest: PackageDigest,
    pub project_id: ScopeId,
    pub scope_id: ScopeId,
    pub activation_generation: ActivationGeneration,
    pub permission: PermissionKind,
    pub constraints: PermissionConstraints,
    pub constraints_digest: String,
    pub grant_source: GrantSource,
    pub policy_revision: u64,
    pub workspace: Option<WorkspaceGrantIdentity>,
    pub expires_at_millis: u64,
}

/// The exact resource and operation requested for one privileged call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionUse {
    ProjectFsRead {
        /// Broker-normalized, project-relative UTF-8 path.
        relative_path: String,
        requested_bytes: u64,
    },
    WorkspaceRInspect {
        operation: String,
        requested_bytes: u64,
    },
    NetworkFetch {
        scheme: String,
        host: String,
        method: String,
        requested_response_bytes: u64,
    },
}

/// The exact parameters revalidated on every privileged call.
#[derive(Debug, Clone)]
pub struct RevalidationRequest {
    pub handle_id: String,
    pub plugin_id: PluginId,
    pub host_instance_id: HostInstanceId,
    pub package_digest: PackageDigest,
    pub project_id: ScopeId,
    pub scope_id: ScopeId,
    pub generation: ActivationGeneration,
    pub permission: PermissionKind,
    pub permission_use: PermissionUse,
    pub workspace: Option<WorkspaceGrantIdentity>,
}

impl GrantStore {
    pub fn new() -> Self {
        Self::with_sources(Arc::new(SystemGrantClock), Arc::new(OsGrantTokenSource))
    }

    pub fn with_sources(
        clock: Arc<dyn GrantClock>,
        token_source: Arc<dyn GrantTokenSource>,
    ) -> Self {
        Self {
            grants: std::collections::BTreeMap::new(),
            durable_handles: std::collections::BTreeMap::new(),
            clock,
            token_source,
        }
    }

    /// Issue a grant and return the opaque handle (the only copy of the raw
    /// id the caller sees). The broker stores only the digest.
    pub fn grant(&mut self, request: GrantRequest) -> Result<CapabilityHandle, ExtensionError> {
        validate_constraints(request.permission, &request.constraints)?;
        validate_grant_request(&request)?;
        let now = self.clock.now_millis();
        if request.expires_at_millis <= now {
            return Err(ExtensionError::ManifestValidation {
                reason: "grant expiry must be in the future".to_string(),
            });
        }
        let maximum_ttl = match request.grant_source {
            GrantSource::AllowOnce => MAX_ALLOW_ONCE_TTL,
            GrantSource::Project => MAX_PROJECT_GRANT_TTL,
        };
        if request.expires_at_millis.saturating_sub(now) > maximum_ttl.as_millis() as u64 {
            return Err(ExtensionError::ManifestValidation {
                reason: "grant expiry exceeds its source policy".to_string(),
            });
        }
        if let Some(existing_digest) = self.durable_handles.get(&request.durable_grant_id).cloned()
        {
            if self
                .grants
                .get(&existing_digest)
                .is_some_and(|grant| grant.is_active(now))
            {
                return Err(ExtensionError::ManifestValidation {
                    reason: "durable grant already has a live handle".to_string(),
                });
            }
            self.durable_handles.remove(&request.durable_grant_id);
        }
        let handle_id = format!("handle.{}", hex_encode(&self.token_source.next_token()));
        let handle_digest = sha256_hex(handle_id.as_bytes());
        if self.grants.contains_key(&handle_digest) {
            return Err(ExtensionError::ManifestValidation {
                reason: "handle token source produced a duplicate token".to_string(),
            });
        }

        let grant = PluginGrant {
            durable_grant_id: request.durable_grant_id.clone(),
            handle_digest: handle_digest.clone(),
            normalized_project_root: request.normalized_project_root,
            plugin_id: request.plugin_id,
            plugin_version: request.plugin_version,
            runtime_kind: request.runtime_kind,
            host_instance_id: request.host_instance_id,
            package_digest: request.package_digest,
            project_id: request.project_id.clone(),
            scope_id: request.scope_id.clone(),
            activation_generation: request.activation_generation,
            permission: request.permission,
            constraints: request.constraints,
            constraints_digest: request.constraints_digest,
            grant_source: request.grant_source,
            policy_revision: request.policy_revision,
            workspace: request.workspace,
            created_at_millis: now,
            expires_at_millis: request.expires_at_millis,
            revoked_at_millis: None,
            used: false,
            in_flight: false,
        };
        self.durable_handles
            .insert(request.durable_grant_id, handle_digest.clone());
        self.grants.insert(handle_digest, grant);

        Ok(CapabilityHandle {
            id: handle_id,
            permission: request.permission,
            scope_id: request.scope_id,
            expires_at_millis: Some(request.expires_at_millis),
        })
    }

    /// Revoke a grant identified by its opaque handle id. Returns `false` when
    /// the handle is unknown.
    pub fn revoke(&mut self, handle_id: &str) -> bool {
        let handle_digest = sha256_hex(handle_id.as_bytes());
        match self.grants.get_mut(&handle_digest) {
            Some(grant) => {
                grant.revoked_at_millis = Some(self.clock.now_millis());
                true
            }
            None => false,
        }
    }

    /// Revoke the exact in-memory handle derived from one durable grant.
    pub fn revoke_durable_grant(&mut self, durable_grant_id: &str) -> bool {
        let Some(handle_digest) = self.durable_handles.get(durable_grant_id).cloned() else {
            return false;
        };
        let Some(grant) = self.grants.get_mut(&handle_digest) else {
            return false;
        };
        grant.revoked_at_millis = Some(self.clock.now_millis());
        true
    }

    pub fn has_live_durable_grant(&self, durable_grant_id: &str) -> bool {
        let now = self.clock.now_millis();
        self.durable_handles
            .get(durable_grant_id)
            .and_then(|digest| self.grants.get(digest))
            .is_some_and(|grant| grant.is_active(now))
    }

    pub fn active_handle_count(&self) -> usize {
        let now = self.clock.now_millis();
        self.grants
            .values()
            .filter(|grant| grant.is_active(now))
            .count()
    }

    /// Invalidate all live authority for an exact normalized project.
    pub fn invalidate_project(&mut self, normalized_project_root: &str) -> usize {
        let now = self.clock.now_millis();
        let mut invalidated = 0;
        for grant in self.grants.values_mut() {
            if grant.normalized_project_root == normalized_project_root
                && grant.revoked_at_millis.is_none()
            {
                grant.revoked_at_millis = Some(now);
                invalidated += 1;
            }
        }
        invalidated
    }

    pub fn invalidate_host(&mut self, host_instance_id: &HostInstanceId) -> usize {
        let now = self.clock.now_millis();
        let mut invalidated = 0;
        for grant in self.grants.values_mut() {
            if &grant.host_instance_id == host_instance_id && grant.revoked_at_millis.is_none() {
                grant.revoked_at_millis = Some(now);
                invalidated += 1;
            }
        }
        invalidated
    }

    pub fn invalidate_workspace(&mut self, workspace: &WorkspaceGrantIdentity) -> usize {
        let now = self.clock.now_millis();
        let mut invalidated = 0;
        for grant in self.grants.values_mut() {
            if grant.workspace.as_ref() == Some(workspace) && grant.revoked_at_millis.is_none() {
                grant.revoked_at_millis = Some(now);
                invalidated += 1;
            }
        }
        invalidated
    }

    /// Revalidate a privileged call against the stored grant.
    pub fn revalidate(&mut self, request: RevalidationRequest) -> Revalidation {
        let handle_digest = sha256_hex(request.handle_id.as_bytes());
        let Some(grant) = self.grants.get_mut(&handle_digest) else {
            return Revalidation::Denied(GrantErrorKind::UnknownHandle);
        };
        let now_millis = self.clock.now_millis();
        if let Some(error) = revalidation_error(grant, &request, now_millis, false) {
            return Revalidation::Denied(error);
        }

        // Reserve `allow once` on admission. The operation owner must report
        // success, pre-dispatch failure, or uncertain completion explicitly.
        if grant.grant_source == GrantSource::AllowOnce {
            grant.in_flight = true;
        }
        Revalidation::Allowed
    }

    /// Recheck the exact call after broker work and before any result becomes
    /// visible. An allow-once grant must still hold its original reservation.
    pub fn revalidate_admitted(&self, request: &RevalidationRequest) -> Revalidation {
        let handle_digest = sha256_hex(request.handle_id.as_bytes());
        let Some(grant) = self.grants.get(&handle_digest) else {
            return Revalidation::Denied(GrantErrorKind::UnknownHandle);
        };
        match revalidation_error(grant, request, self.clock.now_millis(), true) {
            Some(error) => Revalidation::Denied(error),
            None => Revalidation::Allowed,
        }
    }

    pub fn durable_grant_id_for_handle(&self, handle_id: &str) -> Option<&str> {
        let handle_digest = sha256_hex(handle_id.as_bytes());
        self.grants
            .get(&handle_digest)
            .map(|grant| grant.durable_grant_id.as_str())
    }

    pub fn complete_success(&mut self, handle_id: &str) -> bool {
        self.complete(handle_id, CompletionClass::Success)
    }

    pub fn complete_failure_before_dispatch(&mut self, handle_id: &str) -> bool {
        self.complete(handle_id, CompletionClass::FailureBeforeDispatch)
    }

    pub fn complete_uncertain(&mut self, handle_id: &str) -> bool {
        self.complete(handle_id, CompletionClass::Uncertain)
    }

    fn complete(&mut self, handle_id: &str, completion: CompletionClass) -> bool {
        let handle_digest = sha256_hex(handle_id.as_bytes());
        let Some(grant) = self.grants.get_mut(&handle_digest) else {
            return false;
        };
        if grant.grant_source != GrantSource::AllowOnce || !grant.in_flight {
            return false;
        }
        grant.in_flight = false;
        match completion {
            CompletionClass::Success | CompletionClass::Uncertain => grant.used = true,
            CompletionClass::FailureBeforeDispatch => {}
        }
        true
    }
}

#[derive(Debug, Clone, Copy)]
enum CompletionClass {
    Success,
    FailureBeforeDispatch,
    Uncertain,
}

fn revalidation_error(
    grant: &PluginGrant,
    request: &RevalidationRequest,
    now_millis: u64,
    admitted: bool,
) -> Option<GrantErrorKind> {
    if grant.revoked_at_millis.is_some() {
        return Some(GrantErrorKind::Revoked);
    }
    if now_millis >= grant.expires_at_millis {
        return Some(GrantErrorKind::Expired);
    }
    if grant.used {
        return Some(GrantErrorKind::Consumed);
    }
    if admitted && grant.grant_source == GrantSource::AllowOnce && !grant.in_flight {
        return Some(GrantErrorKind::NotAdmitted);
    }
    if !admitted && grant.in_flight {
        return Some(GrantErrorKind::InFlight);
    }
    if grant.plugin_id != request.plugin_id {
        return Some(GrantErrorKind::WrongPlugin);
    }
    if grant.host_instance_id != request.host_instance_id {
        return Some(GrantErrorKind::WrongHostSession);
    }
    if grant.project_id != request.project_id {
        return Some(GrantErrorKind::WrongProject);
    }
    if grant.scope_id != request.scope_id {
        return Some(GrantErrorKind::WrongScope);
    }
    if grant.activation_generation != request.generation {
        return Some(GrantErrorKind::WrongGeneration);
    }
    if grant.package_digest != request.package_digest {
        return Some(GrantErrorKind::WrongPackageDigest);
    }
    if grant.permission != request.permission {
        return Some(GrantErrorKind::WrongPermission);
    }
    if grant.workspace != request.workspace {
        return Some(GrantErrorKind::WrongWorkspace);
    }
    if !permission_use_allowed(
        grant.permission,
        &grant.constraints,
        &request.permission_use,
    ) {
        return Some(GrantErrorKind::ConstraintViolation);
    }
    None
}

fn validate_grant_request(request: &GrantRequest) -> Result<(), ExtensionError> {
    let valid_opaque_id = |value: &str| {
        !value.is_empty()
            && value.len() <= crate::MAX_IDENTIFIER_BYTES
            && value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            })
    };
    if !valid_opaque_id(&request.durable_grant_id) {
        return Err(ExtensionError::ManifestValidation {
            reason: "durable grant id is invalid".to_string(),
        });
    }
    if request.normalized_project_root.trim().is_empty()
        || request.normalized_project_root == "legacy_unscoped"
        || request.normalized_project_root.contains('\\')
    {
        return Err(ExtensionError::ManifestValidation {
            reason: "grant requires an explicit normalized project root".to_string(),
        });
    }
    if request.runtime_kind != RuntimeKind::Wasm {
        return Err(ExtensionError::ManifestValidation {
            reason: "live plugin grants require the Wasm runtime".to_string(),
        });
    }
    if request.project_id != request.scope_id {
        return Err(ExtensionError::ManifestValidation {
            reason: "initial plugin grants must use the exact project scope".to_string(),
        });
    }
    if request.policy_revision == 0 {
        return Err(ExtensionError::ManifestValidation {
            reason: "grant policy revision must be positive".to_string(),
        });
    }
    if request.constraints.digest()? != request.constraints_digest {
        return Err(ExtensionError::ManifestValidation {
            reason: "grant constraints digest does not match canonical constraints".to_string(),
        });
    }
    let workspace_shape_valid = match request.permission {
        PermissionKind::WorkspaceRInspect => request.workspace.is_some(),
        PermissionKind::ProjectFsRead | PermissionKind::NetworkFetch => request.workspace.is_none(),
    };
    if !workspace_shape_valid {
        return Err(ExtensionError::ManifestValidation {
            reason: "grant Workspace identity does not match its permission".to_string(),
        });
    }
    if request.workspace.as_ref().is_some_and(|identity| {
        identity.workspace_id.is_empty()
            || identity.workspace_id.len() > 256
            || identity.kernel_instance_id.is_empty()
            || identity.kernel_instance_id.len() > 256
            || identity
                .workspace_id
                .chars()
                .chain(identity.kernel_instance_id.chars())
                .any(char::is_control)
    }) {
        return Err(ExtensionError::ManifestValidation {
            reason: "grant Workspace identity is invalid".to_string(),
        });
    }
    Ok(())
}

fn validate_constraints(
    permission: PermissionKind,
    constraints: &PermissionConstraints,
) -> Result<(), ExtensionError> {
    let valid = match permission {
        PermissionKind::ProjectFsRead => {
            !constraints.paths.is_empty()
                && constraints.operations.is_empty()
                && constraints.schemes.is_empty()
                && constraints.hosts.is_empty()
                && constraints.methods.is_empty()
                && matches!(constraints.max_bytes, Some(value) if value > 0)
                && constraints.max_response_bytes.is_none()
                && constraints
                    .paths
                    .iter()
                    .all(|path| valid_relative_pattern(path))
        }
        PermissionKind::WorkspaceRInspect => {
            constraints.paths.is_empty()
                && !constraints.operations.is_empty()
                && constraints.schemes.is_empty()
                && constraints.hosts.is_empty()
                && constraints.methods.is_empty()
                && matches!(constraints.max_bytes, Some(value) if value > 0)
                && constraints.max_response_bytes.is_none()
        }
        PermissionKind::NetworkFetch => {
            constraints.paths.is_empty()
                && constraints.operations.is_empty()
                && !constraints.schemes.is_empty()
                && !constraints.hosts.is_empty()
                && !constraints.methods.is_empty()
                && constraints.max_bytes.is_none()
                && matches!(constraints.max_response_bytes, Some(value) if value > 0)
                && constraints.schemes.iter().all(|scheme| scheme == "https")
                && constraints
                    .hosts
                    .iter()
                    .all(|host| valid_host_pattern(host))
                && constraints
                    .methods
                    .iter()
                    .all(|method| matches!(method.as_str(), "GET" | "HEAD"))
        }
    };
    if !valid {
        return Err(ExtensionError::ManifestValidation {
            reason: format!(
                "invalid constraints for permission {}",
                permission.as_static_str()
            ),
        });
    }
    Ok(())
}

fn permission_use_allowed(
    permission: PermissionKind,
    constraints: &PermissionConstraints,
    permission_use: &PermissionUse,
) -> bool {
    match (permission, permission_use) {
        (
            PermissionKind::ProjectFsRead,
            PermissionUse::ProjectFsRead {
                relative_path,
                requested_bytes,
            },
        ) => {
            valid_relative_path(relative_path)
                && constraints
                    .paths
                    .iter()
                    .any(|pattern| glob_matches(pattern, relative_path))
                && constraints
                    .max_bytes
                    .is_some_and(|maximum| *requested_bytes <= maximum)
        }
        (
            PermissionKind::WorkspaceRInspect,
            PermissionUse::WorkspaceRInspect {
                operation,
                requested_bytes,
            },
        ) => {
            constraints
                .operations
                .iter()
                .any(|allowed| allowed == operation)
                && constraints
                    .max_bytes
                    .is_some_and(|maximum| *requested_bytes <= maximum)
        }
        (
            PermissionKind::NetworkFetch,
            PermissionUse::NetworkFetch {
                scheme,
                host,
                method,
                requested_response_bytes,
            },
        ) => {
            constraints.schemes.iter().any(|allowed| allowed == scheme)
                && constraints
                    .hosts
                    .iter()
                    .any(|allowed| host_matches(allowed, host))
                && constraints.methods.iter().any(|allowed| allowed == method)
                && constraints
                    .max_response_bytes
                    .is_some_and(|maximum| *requested_response_bytes <= maximum)
        }
        _ => false,
    }
}

fn valid_relative_pattern(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains(':')
        && !path.split(['/', '\\']).any(|component| component == "..")
}

fn valid_relative_path(path: &str) -> bool {
    valid_relative_pattern(path)
        && !path.contains('\\')
        && !path
            .split('/')
            .any(|component| component.is_empty() || component == ".")
}

fn valid_host_pattern(host: &str) -> bool {
    let domain = host.strip_prefix("*.").unwrap_or(host);
    !domain.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('*')
        && domain.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
}

fn host_matches(pattern: &str, host: &str) -> bool {
    if !valid_host_pattern(pattern) || !valid_host_pattern(host) || host.starts_with("*.") {
        return false;
    }
    match pattern.strip_prefix("*.") {
        Some(suffix) => {
            host.len() > suffix.len()
                && host.ends_with(suffix)
                && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
        }
        None => pattern == host,
    }
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    fn visit(
        pattern: &[u8],
        value: &[u8],
        pattern_index: usize,
        value_index: usize,
        seen: &mut std::collections::BTreeSet<(usize, usize)>,
    ) -> bool {
        if !seen.insert((pattern_index, value_index)) {
            return false;
        }
        if pattern_index == pattern.len() {
            return value_index == value.len();
        }
        if pattern[pattern_index] == b'*' {
            let double = pattern.get(pattern_index + 1) == Some(&b'*');
            let next = pattern_index + if double { 2 } else { 1 };
            if visit(pattern, value, next, value_index, seen) {
                return true;
            }
            if double
                && pattern.get(next) == Some(&b'/')
                && visit(pattern, value, next + 1, value_index, seen)
            {
                return true;
            }
            return value_index < value.len()
                && (double || value[value_index] != b'/')
                && visit(pattern, value, pattern_index, value_index + 1, seen);
        }
        if value_index == value.len() {
            return false;
        }
        if pattern[pattern_index] == b'?'
            && value[value_index] != b'/'
            && visit(pattern, value, pattern_index + 1, value_index + 1, seen)
        {
            return true;
        }
        pattern[pattern_index] == value[value_index]
            && visit(pattern, value, pattern_index + 1, value_index + 1, seen)
    }

    visit(
        pattern.as_bytes(),
        value.as_bytes(),
        0,
        0,
        &mut std::collections::BTreeSet::new(),
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    use std::fmt::Write;
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Debug)]
    struct TestClock(AtomicU64);

    impl TestClock {
        fn new(now: u64) -> Self {
            Self(AtomicU64::new(now))
        }

        fn set(&self, now: u64) {
            self.0.store(now, Ordering::SeqCst);
        }
    }

    impl GrantClock for TestClock {
        fn now_millis(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[derive(Debug, Default)]
    struct TestTokenSource(AtomicU64);

    impl GrantTokenSource for TestTokenSource {
        fn next_token(&self) -> [u8; 32] {
            let sequence = self.0.fetch_add(1, Ordering::SeqCst).to_be_bytes();
            let mut token = [0_u8; 32];
            token[24..].copy_from_slice(&sequence);
            token
        }
    }

    fn scope(id: &str) -> ScopeId {
        ScopeId::new(id).unwrap()
    }

    fn plugin(id: &str) -> PluginId {
        PluginId::new(id).unwrap()
    }

    fn generation(value: u64) -> ActivationGeneration {
        ActivationGeneration::new(value).unwrap()
    }

    fn digest(seed: &str) -> PackageDigest {
        PackageDigest::from_inventory(&[(seed.as_bytes(), seed.as_bytes())])
    }

    fn host(id: &str) -> HostInstanceId {
        HostInstanceId::new(id).unwrap()
    }

    fn file_constraints() -> PermissionConstraints {
        PermissionConstraints {
            paths: vec!["data/**/*.csv".to_string()],
            max_bytes: Some(1024),
            ..Default::default()
        }
    }

    fn network_constraints() -> PermissionConstraints {
        PermissionConstraints {
            schemes: vec!["https".to_string()],
            hosts: vec![
                "bioconductor.org".to_string(),
                "*.bioconductor.org".to_string(),
            ],
            methods: vec!["GET".to_string()],
            max_response_bytes: Some(4096),
            ..Default::default()
        }
    }

    fn test_store(now: u64) -> (GrantStore, Arc<TestClock>) {
        let clock = Arc::new(TestClock::new(now));
        let store = GrantStore::with_sources(clock.clone(), Arc::new(TestTokenSource::default()));
        (store, clock)
    }

    fn grant_request(
        durable_grant_id: &str,
        permission: PermissionKind,
        constraints: PermissionConstraints,
        grant_source: GrantSource,
        expires_at_millis: u64,
    ) -> GrantRequest {
        let constraints_digest = constraints.digest().unwrap();
        GrantRequest {
            durable_grant_id: durable_grant_id.to_string(),
            normalized_project_root: "D:/project/a".to_string(),
            plugin_id: plugin("org.example.a"),
            plugin_version: PluginVersion::parse("1.0.0").unwrap(),
            runtime_kind: RuntimeKind::Wasm,
            host_instance_id: host("instance.a"),
            package_digest: digest("pkg"),
            project_id: scope("scope.project"),
            scope_id: scope("scope.project"),
            activation_generation: generation(1),
            permission,
            constraints,
            constraints_digest,
            grant_source,
            policy_revision: 1,
            workspace: (permission == PermissionKind::WorkspaceRInspect).then(|| {
                WorkspaceGrantIdentity {
                    workspace_id: "workspace.a".to_string(),
                    kernel_instance_id: "kernel.a".to_string(),
                    state_revision: 2,
                    project_revision: 3,
                }
            }),
            expires_at_millis,
        }
    }

    fn granted_handle() -> (GrantStore, CapabilityHandle, PluginGrant, Arc<TestClock>) {
        let (mut store, clock) = test_store(1_000);
        let handle = store
            .grant(grant_request(
                "grant.a",
                PermissionKind::ProjectFsRead,
                file_constraints(),
                GrantSource::Project,
                60_000,
            ))
            .unwrap();
        let grant = store
            .grants
            .get(&sha256_hex(handle.id.as_bytes()))
            .unwrap()
            .clone();
        (store, handle, grant, clock)
    }

    fn revalidation(handle: &CapabilityHandle) -> RevalidationRequest {
        RevalidationRequest {
            handle_id: handle.id.clone(),
            plugin_id: plugin("org.example.a"),
            host_instance_id: host("instance.a"),
            package_digest: digest("pkg"),
            project_id: scope("scope.project"),
            scope_id: scope("scope.project"),
            generation: generation(1),
            permission: PermissionKind::ProjectFsRead,
            permission_use: PermissionUse::ProjectFsRead {
                relative_path: "data/nested/input.csv".to_string(),
                requested_bytes: 512,
            },
            workspace: None,
        }
    }

    #[test]
    fn grant_and_revalidate_project_scoped() {
        let (mut store, handle, grant, _) = granted_handle();
        assert_ne!(handle.id, grant.handle_digest);
        assert_eq!(handle.id.len(), "handle.".len() + 64);
        let outcome = store.revalidate(revalidation(&handle));
        assert_eq!(outcome, Revalidation::Allowed);
    }

    #[test]
    fn wrong_plugin_and_host_session_are_denied() {
        let (mut store, handle, _, _) = granted_handle();
        let mut wrong_plugin = revalidation(&handle);
        wrong_plugin.plugin_id = plugin("org.example.other");
        assert_eq!(
            store.revalidate(wrong_plugin),
            Revalidation::Denied(GrantErrorKind::WrongPlugin)
        );

        let mut wrong_host = revalidation(&handle);
        wrong_host.host_instance_id = host("instance.other");
        assert_eq!(
            store.revalidate(wrong_host),
            Revalidation::Denied(GrantErrorKind::WrongHostSession)
        );
    }

    #[test]
    fn file_path_and_byte_constraints_are_revalidated_per_call() {
        let (mut store, handle, _, _) = granted_handle();
        let mut outside = revalidation(&handle);
        outside.permission_use = PermissionUse::ProjectFsRead {
            relative_path: "secrets/input.csv".to_string(),
            requested_bytes: 10,
        };
        assert_eq!(
            store.revalidate(outside),
            Revalidation::Denied(GrantErrorKind::ConstraintViolation)
        );

        let mut oversized = revalidation(&handle);
        oversized.permission_use = PermissionUse::ProjectFsRead {
            relative_path: "data/nested/input.csv".to_string(),
            requested_bytes: 1025,
        };
        assert_eq!(
            store.revalidate(oversized),
            Revalidation::Denied(GrantErrorKind::ConstraintViolation)
        );
    }

    #[test]
    fn wrong_project_denied() {
        let (mut store, handle, _, _) = granted_handle();
        let mut request = revalidation(&handle);
        request.project_id = scope("scope.other");
        let outcome = store.revalidate(request);
        assert_eq!(outcome, Revalidation::Denied(GrantErrorKind::WrongProject));
    }

    #[test]
    fn wrong_digest_denied() {
        let (mut store, handle, _, _) = granted_handle();
        let mut request = revalidation(&handle);
        request.package_digest = digest("OTHER");
        let outcome = store.revalidate(request);
        assert_eq!(
            outcome,
            Revalidation::Denied(GrantErrorKind::WrongPackageDigest)
        );
    }

    #[test]
    fn revoke_denies_subsequent_calls() {
        let (mut store, handle, _, _) = granted_handle();
        assert!(store.revoke(&handle.id));
        let outcome = store.revalidate(revalidation(&handle));
        assert_eq!(outcome, Revalidation::Denied(GrantErrorKind::Revoked));
    }

    #[test]
    fn allow_once_is_reserved_then_consumed_only_after_success() {
        let (mut store, _) = test_store(1_000);
        let handle = store
            .grant(grant_request(
                "grant.once",
                PermissionKind::NetworkFetch,
                network_constraints(),
                GrantSource::AllowOnce,
                2_000,
            ))
            .unwrap();
        let mut request = revalidation(&handle);
        request.permission = PermissionKind::NetworkFetch;
        request.permission_use = PermissionUse::NetworkFetch {
            scheme: "https".to_string(),
            host: "api.bioconductor.org".to_string(),
            method: "GET".to_string(),
            requested_response_bytes: 1024,
        };

        let first = store.revalidate(request.clone());
        assert_eq!(first, Revalidation::Allowed);
        assert_eq!(store.revalidate_admitted(&request), Revalidation::Allowed);
        assert_eq!(
            store.revalidate(request.clone()),
            Revalidation::Denied(GrantErrorKind::InFlight)
        );
        assert!(store.complete_failure_before_dispatch(&handle.id));
        assert_eq!(store.revalidate(request.clone()), Revalidation::Allowed);
        assert!(store.complete_success(&handle.id));
        assert_eq!(
            store.revalidate(request),
            Revalidation::Denied(GrantErrorKind::Consumed)
        );
    }

    #[test]
    fn expired_grant_denied() {
        let (mut store, clock) = test_store(1_000);
        let handle = store
            .grant(grant_request(
                "grant.expiring",
                PermissionKind::ProjectFsRead,
                file_constraints(),
                GrantSource::Project,
                1_001,
            ))
            .unwrap();
        clock.set(1_001);
        let outcome = store.revalidate(revalidation(&handle));
        assert_eq!(outcome, Revalidation::Denied(GrantErrorKind::Expired));
    }

    #[test]
    fn network_host_method_and_size_are_revalidated() {
        let (mut store, _) = test_store(1_000);
        let handle = store
            .grant(grant_request(
                "grant.network",
                PermissionKind::NetworkFetch,
                network_constraints(),
                GrantSource::Project,
                60_000,
            ))
            .unwrap();
        let mut request = revalidation(&handle);
        request.permission = PermissionKind::NetworkFetch;
        request.permission_use = PermissionUse::NetworkFetch {
            scheme: "https".to_string(),
            host: "evil.example".to_string(),
            method: "POST".to_string(),
            requested_response_bytes: 4097,
        };
        assert_eq!(
            store.revalidate(request),
            Revalidation::Denied(GrantErrorKind::ConstraintViolation)
        );
    }

    #[test]
    fn empty_constraints_fail_closed_at_grant_time() {
        let (mut store, _) = test_store(1_000);
        let result = store.grant(grant_request(
            "grant.empty",
            PermissionKind::ProjectFsRead,
            PermissionConstraints::default(),
            GrantSource::Project,
            60_000,
        ));
        assert!(result.is_err());
    }

    #[test]
    fn durable_identity_and_constraints_digest_are_fail_closed() {
        let (mut store, _) = test_store(1_000);
        let mut wrong_digest = grant_request(
            "grant.a",
            PermissionKind::ProjectFsRead,
            file_constraints(),
            GrantSource::Project,
            60_000,
        );
        wrong_digest.constraints_digest = "0".repeat(64);
        assert!(store.grant(wrong_digest).is_err());

        let mut wrong_runtime = grant_request(
            "grant.b",
            PermissionKind::ProjectFsRead,
            file_constraints(),
            GrantSource::Project,
            60_000,
        );
        wrong_runtime.runtime_kind = RuntimeKind::WebWorker;
        assert!(store.grant(wrong_runtime).is_err());

        let mut workspace_missing = grant_request(
            "grant.c",
            PermissionKind::WorkspaceRInspect,
            PermissionConstraints {
                operations: vec!["metadata".to_string()],
                max_bytes: Some(1024),
                ..Default::default()
            },
            GrantSource::Project,
            60_000,
        );
        workspace_missing.workspace = None;
        assert!(store.grant(workspace_missing).is_err());
        assert_eq!(store.active_handle_count(), 0);
    }

    #[test]
    fn durable_revoke_and_project_invalidation_never_need_raw_handle() {
        let (mut store, _) = test_store(1_000);
        let first = store
            .grant(grant_request(
                "grant.a",
                PermissionKind::ProjectFsRead,
                file_constraints(),
                GrantSource::Project,
                60_000,
            ))
            .unwrap();
        assert!(store.has_live_durable_grant("grant.a"));
        assert!(store.revoke_durable_grant("grant.a"));
        assert_eq!(
            store.revalidate(revalidation(&first)),
            Revalidation::Denied(GrantErrorKind::Revoked)
        );
        let replacement = store
            .grant(grant_request(
                "grant.a",
                PermissionKind::ProjectFsRead,
                file_constraints(),
                GrantSource::Project,
                60_000,
            ))
            .unwrap();
        assert_ne!(replacement.id, first.id);
        assert!(store.has_live_durable_grant("grant.a"));

        let second = store
            .grant(grant_request(
                "grant.b",
                PermissionKind::ProjectFsRead,
                file_constraints(),
                GrantSource::Project,
                60_000,
            ))
            .unwrap();
        assert_eq!(store.invalidate_project("D:/project/a"), 2);
        assert_eq!(
            store.revalidate(revalidation(&second)),
            Revalidation::Denied(GrantErrorKind::Revoked)
        );
    }

    #[test]
    fn duplicate_token_and_excessive_duration_fail_without_overwrite() {
        #[derive(Debug)]
        struct RepeatingToken;
        impl GrantTokenSource for RepeatingToken {
            fn next_token(&self) -> [u8; 32] {
                [7; 32]
            }
        }
        let clock = Arc::new(TestClock::new(1_000));
        let mut store = GrantStore::with_sources(clock, Arc::new(RepeatingToken));
        store
            .grant(grant_request(
                "grant.a",
                PermissionKind::ProjectFsRead,
                file_constraints(),
                GrantSource::Project,
                60_000,
            ))
            .unwrap();
        assert!(
            store
                .grant(grant_request(
                    "grant.b",
                    PermissionKind::ProjectFsRead,
                    file_constraints(),
                    GrantSource::Project,
                    60_000,
                ))
                .is_err()
        );
        assert!(
            store
                .grant(grant_request(
                    "grant.c",
                    PermissionKind::ProjectFsRead,
                    file_constraints(),
                    GrantSource::Project,
                    1_000 + MAX_PROJECT_GRANT_TTL.as_millis() as u64 + 1,
                ))
                .is_err()
        );
        assert_eq!(store.active_handle_count(), 1);
    }

    #[test]
    fn admitted_call_observes_revoke_and_glob_grammar_distinguishes_star_from_double_star() {
        let (mut store, _) = test_store(1_000);
        let handle = store
            .grant(grant_request(
                "grant.once",
                PermissionKind::ProjectFsRead,
                file_constraints(),
                GrantSource::AllowOnce,
                2_000,
            ))
            .unwrap();
        let request = revalidation(&handle);
        assert_eq!(store.revalidate(request.clone()), Revalidation::Allowed);
        assert!(store.revoke_durable_grant("grant.once"));
        assert_eq!(
            store.revalidate_admitted(&request),
            Revalidation::Denied(GrantErrorKind::Revoked)
        );

        assert!(glob_matches("data/*.csv", "data/input.csv"));
        assert!(!glob_matches("data/*.csv", "data/nested/input.csv"));
        assert!(glob_matches("data/**/*.csv", "data/nested/input.csv"));
        assert!(glob_matches("data/**/*.csv", "data/input.csv"));
        assert!(glob_matches("data/input?.csv", "data/input1.csv"));
        assert!(!glob_matches("data/input?.csv", "data/input/1.csv"));
    }
}
