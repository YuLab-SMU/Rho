//! Read-only broker permission grants and constrained handles (P2-2).
//!
//! A plugin receives an *opaque* handle token, never a mutable permission
//! object. The broker owns the authoritative `PluginGrant` state and
//! revalidates every privileged call against the exact plugin instance,
//! package digest, project/scope/generation, permission kind, resource, and
//! expiry. This module is broker-side logic only: it performs no filesystem,
//! network, Workspace R, or credential operation itself, and it never logs the
//! raw token.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::digest::PackageDigest;
use crate::host::HostInstanceId;
use crate::{ActivationGeneration, ExtensionError, PluginId, ScopeId};

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

/// The authoritative broker grant record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginGrant {
    /// Opaque handle digest; the raw token is never persisted or logged.
    pub handle_digest: String,
    pub plugin_id: PluginId,
    pub host_instance_id: HostInstanceId,
    pub package_digest: PackageDigest,
    pub project_id: ScopeId,
    pub scope_id: ScopeId,
    pub activation_generation: ActivationGeneration,
    pub permission: PermissionKind,
    pub constraints: PermissionConstraints,
    pub grant_source: GrantSource,
    pub created_at_millis: u64,
    pub expires_at_millis: Option<u64>,
    pub revoked_at_millis: Option<u64>,
    /// `allow once` grants are consumed after a single successful use.
    pub used: bool,
}

impl PluginGrant {
    pub fn is_active(&self, now_millis: u64) -> bool {
        self.revoked_at_millis.is_none() && !self.consumed(now_millis)
    }

    fn consumed(&self, now_millis: u64) -> bool {
        self.used
            || self
                .expires_at_millis
                .map(|expiry| now_millis >= expiry)
                .unwrap_or(false)
    }
}

/// An opaque capability handle surfaced to a plugin. It carries only a
/// non-secret identifier and never the authorization state itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityHandle {
    pub id: String,
    pub permission: PermissionKind,
    pub scope_id: ScopeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_millis: Option<u64>,
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
    WrongPlugin,
    WrongHostSession,
    WrongProject,
    WrongScope,
    WrongGeneration,
    WrongPackageDigest,
    WrongPermission,
    ConstraintViolation,
}

/// A broker-owned grant store. This is the reference monitor for read-only
/// permissions: it grants, revokes, and revalidates. It performs no I/O and
/// stores no raw tokens — only SHA-256 digests of the opaque handle id.
#[derive(Debug, Default)]
pub struct GrantStore {
    grants: std::collections::BTreeMap<String, PluginGrant>,
}

/// The exact parameters required to issue a read-only grant.
#[derive(Debug, Clone)]
pub struct GrantRequest {
    pub plugin_id: PluginId,
    pub host_instance_id: HostInstanceId,
    pub package_digest: PackageDigest,
    pub project_id: ScopeId,
    pub scope_id: ScopeId,
    pub activation_generation: ActivationGeneration,
    pub permission: PermissionKind,
    pub constraints: PermissionConstraints,
    pub grant_source: GrantSource,
    pub ttl: Option<Duration>,
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
    pub now_millis: u64,
}

impl GrantStore {
    pub fn new() -> Self {
        Self {
            grants: std::collections::BTreeMap::new(),
        }
    }

    /// Issue a grant and return the opaque handle (the only copy of the raw
    /// id the caller sees). The broker stores only the digest.
    pub fn grant(&mut self, request: GrantRequest) -> Result<CapabilityHandle, ExtensionError> {
        validate_constraints(request.permission, &request.constraints)?;
        let now = now_millis();
        let handle_id = format!("handle.{}", uuid::Uuid::new_v4().simple());
        let handle_digest = sha256_hex(handle_id.as_bytes());

        let expires_at_millis = request
            .ttl
            .map(|ttl| now.saturating_add(ttl.as_millis() as u64));

        let grant = PluginGrant {
            handle_digest: handle_digest.clone(),
            plugin_id: request.plugin_id,
            host_instance_id: request.host_instance_id,
            package_digest: request.package_digest,
            project_id: request.project_id.clone(),
            scope_id: request.scope_id.clone(),
            activation_generation: request.activation_generation,
            permission: request.permission,
            constraints: request.constraints,
            grant_source: request.grant_source,
            created_at_millis: now,
            expires_at_millis,
            revoked_at_millis: None,
            used: false,
        };
        self.grants.insert(handle_digest, grant);

        Ok(CapabilityHandle {
            id: handle_id,
            permission: request.permission,
            scope_id: request.scope_id,
            expires_at_millis,
        })
    }

    /// Revoke a grant identified by its opaque handle id. Returns `false` when
    /// the handle is unknown.
    pub fn revoke(&mut self, handle_id: &str) -> bool {
        let handle_digest = sha256_hex(handle_id.as_bytes());
        match self.grants.get_mut(&handle_digest) {
            Some(grant) => {
                grant.revoked_at_millis = Some(now_millis());
                true
            }
            None => false,
        }
    }

    /// Revalidate a privileged call against the stored grant.
    ///
    /// `now_millis` is injected for determinism in tests.
    pub fn revalidate(&mut self, request: RevalidationRequest) -> Revalidation {
        let handle_digest = sha256_hex(request.handle_id.as_bytes());
        let Some(grant) = self.grants.get_mut(&handle_digest) else {
            return Revalidation::Denied(GrantErrorKind::UnknownHandle);
        };

        if grant.revoked_at_millis.is_some() {
            return Revalidation::Denied(GrantErrorKind::Revoked);
        }
        if grant
            .expires_at_millis
            .map(|expiry| request.now_millis >= expiry)
            .unwrap_or(false)
        {
            return Revalidation::Denied(GrantErrorKind::Expired);
        }
        if grant.used {
            return Revalidation::Denied(GrantErrorKind::Consumed);
        }
        if grant.plugin_id != request.plugin_id {
            return Revalidation::Denied(GrantErrorKind::WrongPlugin);
        }
        if grant.host_instance_id != request.host_instance_id {
            return Revalidation::Denied(GrantErrorKind::WrongHostSession);
        }
        if grant.project_id != request.project_id {
            return Revalidation::Denied(GrantErrorKind::WrongProject);
        }
        if grant.scope_id != request.scope_id {
            return Revalidation::Denied(GrantErrorKind::WrongScope);
        }
        if grant.activation_generation != request.generation {
            return Revalidation::Denied(GrantErrorKind::WrongGeneration);
        }
        if grant.package_digest != request.package_digest {
            return Revalidation::Denied(GrantErrorKind::WrongPackageDigest);
        }
        if grant.permission != request.permission {
            return Revalidation::Denied(GrantErrorKind::WrongPermission);
        }
        if !permission_use_allowed(
            grant.permission,
            &grant.constraints,
            &request.permission_use,
        ) {
            return Revalidation::Denied(GrantErrorKind::ConstraintViolation);
        }

        // `allow once` consumes the grant on first successful revalidation.
        if grant.grant_source == GrantSource::AllowOnce {
            grant.used = true;
        }
        Revalidation::Allowed
    }
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

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn granted_handle() -> (GrantStore, CapabilityHandle, PluginGrant) {
        let mut store = GrantStore::new();
        let handle = store
            .grant(GrantRequest {
                plugin_id: plugin("org.example.a"),
                host_instance_id: host("instance.a"),
                package_digest: digest("pkg"),
                project_id: scope("scope.project"),
                scope_id: scope("scope.project"),
                activation_generation: generation(1),
                permission: PermissionKind::ProjectFsRead,
                constraints: file_constraints(),
                grant_source: GrantSource::Project,
                ttl: None,
            })
            .unwrap();
        let grant = store
            .grants
            .get(&sha256_hex(handle.id.as_bytes()))
            .unwrap()
            .clone();
        (store, handle, grant)
    }

    fn revalidation(handle: &CapabilityHandle, now: u64) -> RevalidationRequest {
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
            now_millis: now,
        }
    }

    #[test]
    fn grant_and_revalidate_project_scoped() {
        let (mut store, handle, grant) = granted_handle();
        assert_ne!(handle.id, grant.handle_digest);
        let outcome = store.revalidate(revalidation(&handle, 1000));
        assert_eq!(outcome, Revalidation::Allowed);
    }

    #[test]
    fn wrong_plugin_and_host_session_are_denied() {
        let (mut store, handle, _) = granted_handle();
        let mut wrong_plugin = revalidation(&handle, 1000);
        wrong_plugin.plugin_id = plugin("org.example.other");
        assert_eq!(
            store.revalidate(wrong_plugin),
            Revalidation::Denied(GrantErrorKind::WrongPlugin)
        );

        let mut wrong_host = revalidation(&handle, 1000);
        wrong_host.host_instance_id = host("instance.other");
        assert_eq!(
            store.revalidate(wrong_host),
            Revalidation::Denied(GrantErrorKind::WrongHostSession)
        );
    }

    #[test]
    fn file_path_and_byte_constraints_are_revalidated_per_call() {
        let (mut store, handle, _) = granted_handle();
        let mut outside = revalidation(&handle, 1000);
        outside.permission_use = PermissionUse::ProjectFsRead {
            relative_path: "secrets/input.csv".to_string(),
            requested_bytes: 10,
        };
        assert_eq!(
            store.revalidate(outside),
            Revalidation::Denied(GrantErrorKind::ConstraintViolation)
        );

        let mut oversized = revalidation(&handle, 1000);
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
        let (mut store, handle, _) = granted_handle();
        let mut request = revalidation(&handle, 1000);
        request.project_id = scope("scope.other");
        let outcome = store.revalidate(request);
        assert_eq!(outcome, Revalidation::Denied(GrantErrorKind::WrongProject));
    }

    #[test]
    fn wrong_digest_denied() {
        let (mut store, handle, _) = granted_handle();
        let mut request = revalidation(&handle, 1000);
        request.package_digest = digest("OTHER");
        let outcome = store.revalidate(request);
        assert_eq!(
            outcome,
            Revalidation::Denied(GrantErrorKind::WrongPackageDigest)
        );
    }

    #[test]
    fn revoke_denies_subsequent_calls() {
        let (mut store, handle, _) = granted_handle();
        assert!(store.revoke(&handle.id));
        let outcome = store.revalidate(revalidation(&handle, 1000));
        assert_eq!(outcome, Revalidation::Denied(GrantErrorKind::Revoked));
    }

    #[test]
    fn allow_once_is_consumed() {
        let mut store = GrantStore::new();
        let handle = store
            .grant(GrantRequest {
                plugin_id: plugin("org.example.a"),
                host_instance_id: host("instance.a"),
                package_digest: digest("pkg"),
                project_id: scope("scope.project"),
                scope_id: scope("scope.project"),
                activation_generation: generation(1),
                permission: PermissionKind::NetworkFetch,
                constraints: network_constraints(),
                grant_source: GrantSource::AllowOnce,
                ttl: None,
            })
            .unwrap();
        let mut request = revalidation(&handle, 1000);
        request.permission = PermissionKind::NetworkFetch;
        request.permission_use = PermissionUse::NetworkFetch {
            scheme: "https".to_string(),
            host: "api.bioconductor.org".to_string(),
            method: "GET".to_string(),
            requested_response_bytes: 1024,
        };

        let first = store.revalidate(request.clone());
        assert_eq!(first, Revalidation::Allowed);
        let second = store.revalidate(request);
        assert_eq!(second, Revalidation::Denied(GrantErrorKind::Consumed));
    }

    #[test]
    fn expired_grant_denied() {
        // Use a ttl of 1 ms and revalidate far in the future so the injected
        // `now_millis` is unambiguously past the pinned expiry.
        let mut store = GrantStore::new();
        let handle = store
            .grant(GrantRequest {
                plugin_id: plugin("org.example.a"),
                host_instance_id: host("instance.a"),
                package_digest: digest("pkg"),
                project_id: scope("scope.project"),
                scope_id: scope("scope.project"),
                activation_generation: generation(1),
                permission: PermissionKind::ProjectFsRead,
                constraints: file_constraints(),
                grant_source: GrantSource::Project,
                ttl: Some(Duration::from_millis(1)),
            })
            .unwrap();
        let outcome = store.revalidate(revalidation(&handle, u64::MAX));
        assert_eq!(outcome, Revalidation::Denied(GrantErrorKind::Expired));
    }

    #[test]
    fn network_host_method_and_size_are_revalidated() {
        let mut store = GrantStore::new();
        let handle = store
            .grant(GrantRequest {
                plugin_id: plugin("org.example.a"),
                host_instance_id: host("instance.a"),
                package_digest: digest("pkg"),
                project_id: scope("scope.project"),
                scope_id: scope("scope.project"),
                activation_generation: generation(1),
                permission: PermissionKind::NetworkFetch,
                constraints: network_constraints(),
                grant_source: GrantSource::Project,
                ttl: None,
            })
            .unwrap();
        let mut request = revalidation(&handle, 1000);
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
        let mut store = GrantStore::new();
        let result = store.grant(GrantRequest {
            plugin_id: plugin("org.example.a"),
            host_instance_id: host("instance.a"),
            package_digest: digest("pkg"),
            project_id: scope("scope.project"),
            scope_id: scope("scope.project"),
            activation_generation: generation(1),
            permission: PermissionKind::ProjectFsRead,
            constraints: PermissionConstraints::default(),
            grant_source: GrantSource::Project,
            ttl: None,
        });
        assert!(result.is_err());
    }
}
