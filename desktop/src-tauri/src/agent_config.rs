//! Canonical plaintext model configuration and file I/O (schema V6).
//!
//! Runtime settings, Agent turns, and connection tests use `<Rho home>/config.yaml`.
//! This module owns its schema, path resolution, parsing, safe replacement,
//! optimistic identity checks, and credential-safe error reporting.
//!
//! Implementation notes:
//!
//! - `serde_norway` keeps YAML parsing local to this file.
//! - `RHO_HOME` wins; otherwise an existing `~/.rho` wins over an existing
//!   XDG configuration directory, and a new installation defaults to
//!   `~/.rho`. Resolution does not create directories; saving does.
//! - The selected model remains the `agent.chat` capability route inside
//!   `capability_routes`; there is no separate preferences section.
//! - Credentials resolve by presence (session → environment → file literal),
//!   so persisted provider records carry no separate credential-source flag.
//! - Load reasons and error contexts never include file contents. The file
//!   is plaintext and may hold credentials, so reasons carry only I/O
//!   diagnostics or parser locations.

use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Schema marker written to and required from `config.yaml`.
pub(crate) const CONFIG_SCHEMA_VERSION: u32 = 6;
/// Canonical file name inside the Rho home.
pub(crate) const CONFIG_FILE_NAME: &str = "config.yaml";
/// Environment override for the Rho home.
pub(crate) const RHO_HOME_ENV: &str = "RHO_HOME";
/// freedesktop base used to construct the XDG-style variant
/// (`${XDG_CONFIG_HOME}/rho`, or `~/.config/rho` when unset).
pub(crate) const XDG_CONFIG_HOME_ENV: &str = "XDG_CONFIG_HOME";
/// Prefix used inside the broker's process-local snapshot record for a
/// configuration path that did not exist when it was read. The complete
/// identity also binds the normalized path and (when present) the opened Rho
/// home object; it is never projected across IPC.
pub(crate) const MISSING_CONFIG_IDENTITY: &str = "missing";
/// Matches the V5 settings bound so a hostile or accidental giant file is
/// rejected before parsing rather than during it.
const MAX_CONFIG_BYTES: usize = 256 * 1024;

/// Resolve the Rho home: `RHO_HOME` when set (non-empty), then `~/.rho` when
/// it already exists, then the XDG-style variant when it already exists,
/// otherwise the default `~/.rho` (created on first write by
/// [`save_config`]). Returns `None` when no home directory can be
/// determined; callers decide how to report that. `dirs::home_dir()` is used
/// deliberately: `dirs::config_dir()` returns `~/Library/Application Support`
/// on macOS, which would break XDG parity.
pub(crate) fn rho_home() -> Result<PathBuf> {
    let home_override = std::env::var_os(RHO_HOME_ENV);
    let xdg_override = std::env::var_os(XDG_CONFIG_HOME_ENV);
    if let Some(value) = home_override.as_ref().filter(|value| !value.is_empty()) {
        let home_override = PathBuf::from(value);
        ensure!(
            home_override.is_absolute(),
            "RHO_HOME must be an absolute literal path."
        );
    }
    if let Some(value) = xdg_override.as_ref().filter(|value| !value.is_empty()) {
        ensure!(
            Path::new(value).is_absolute(),
            "XDG_CONFIG_HOME must be an absolute path when it is set."
        );
    }
    let resolved = rho_home_with(
        |name| match name {
            RHO_HOME_ENV => home_override.clone(),
            XDG_CONFIG_HOME_ENV => xdg_override.clone(),
            _ => None,
        },
        dirs::home_dir,
        |path| path.exists(),
    )
    .context("Rho could not resolve the current user's home directory")?;
    normalize_absolute_literal(&resolved)
}

fn normalize_absolute_literal(path: &Path) -> Result<PathBuf> {
    use std::path::Component;

    ensure!(path.is_absolute(), "The Rho home must be an absolute path.");
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(value) => normalized.push(value),
            Component::CurDir | Component::ParentDir => {
                bail!("The Rho home must be a normalized literal path.")
            }
        }
    }
    Ok(normalized)
}

/// Pure core of [`rho_home`] with the environment, home-directory, and
/// existence lookups injected so the precedence matrix stays hermetic in
/// tests. Empty-string environment values count as unset, the same rule as
/// credentials.
fn rho_home_with<E, H, X>(env: E, home: H, exists: X) -> Option<PathBuf>
where
    E: Fn(&str) -> Option<OsString>,
    H: FnOnce() -> Option<PathBuf>,
    X: Fn(&Path) -> bool,
{
    if let Some(home_override) = env(RHO_HOME_ENV).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home_override));
    }
    let home = home()?;
    let dot_rho = home.join(".rho");
    if exists(&dot_rho) {
        return Some(dot_rho);
    }
    let xdg_variant = match env(XDG_CONFIG_HOME_ENV).filter(|value| !value.is_empty()) {
        Some(xdg) => PathBuf::from(xdg).join("rho"),
        None => home.join(".config").join("rho"),
    };
    if exists(&xdg_variant) {
        return Some(xdg_variant);
    }
    Some(dot_rho)
}

/// Path of the canonical configuration file under a resolved Rho home.
pub(crate) fn config_file_path(home: &Path) -> PathBuf {
    home.join(CONFIG_FILE_NAME)
}

/// V6 plaintext model configuration. Unknown fields are ignored on load so
/// forward compatibility holds; the V5 content model is mirrored field for
/// field (aisdk naming where concepts overlap: `base_url`, `wire_api`,
/// `api_key_env`, literal `api_key`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AgentConfig {
    pub schema_version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub providers: Vec<AgentConfigProvider>,
    #[serde(default)]
    pub models: Vec<AgentConfigModel>,
    #[serde(default)]
    pub capability_routes: Vec<AgentConfigCapabilityRoute>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, serde_norway::Value>,
}

/// One provider entry. `api_key` is the optional plaintext literal; it is
/// held in `Zeroizing<String>` and redacted from `Debug` output.
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct AgentConfigProvider {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub registered_provider_id: Option<String>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub api_key_required: bool,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub base_url_env: Option<String>,
    #[serde(default)]
    pub wire_api: Option<String>,
    #[serde(default)]
    pub disable_stream_options: Option<bool>,
    #[serde(default)]
    pub api_key: Option<Zeroizing<String>>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, serde_norway::Value>,
}

impl std::fmt::Debug for AgentConfigProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentConfigProvider")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("kind", &self.kind)
            .field("registered_provider_id", &self.registered_provider_id)
            .field("api_key_env", &self.api_key_env)
            .field("api_key_required", &self.api_key_required)
            .field("base_url", &self.base_url)
            .field("base_url_env", &self.base_url_env)
            .field("wire_api", &self.wire_api)
            .field("disable_stream_options", &self.disable_stream_options)
            .field("api_key", &self.api_key.as_ref().map(|_| "[redacted]"))
            .finish()
    }
}

/// One model entry: capability metadata plus runtime options, mirroring V5.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct AgentConfigModel {
    pub id: String,
    pub provider_id: String,
    #[serde(default)]
    pub display_name: String,
    pub model_id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub model_type: AgentConfigCapabilityValue,
    #[serde(default)]
    pub capabilities: BTreeMap<String, AgentConfigCapabilityValue>,
    #[serde(default)]
    pub context_window_tokens: u64,
    #[serde(default)]
    pub reserved_output_tokens: u64,
    #[serde(default)]
    pub context_capacity_source: String,
    #[serde(default)]
    pub last_test: Option<AgentConfigModelTestResult>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, serde_norway::Value>,
}

/// Capability value plus its provenance, identical to the V5 shape.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AgentConfigCapabilityValue {
    pub value: String,
    #[serde(default)]
    pub source: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, serde_norway::Value>,
}

/// Last connection-test outcome persisted on a model, identical to V5.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AgentConfigModelTestResult {
    pub status: String,
    pub checked_at: String,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub error_class: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, serde_norway::Value>,
}

/// Capability → model routing entry, identical to the V5 shape. The
/// `agent.chat` route is the persisted selected-model preference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AgentConfigCapabilityRoute {
    pub capability: String,
    pub model_id: String,
    #[serde(default)]
    pub model_type: String,
    #[serde(default)]
    pub required_model_capabilities: Vec<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, serde_norway::Value>,
}

impl AgentConfig {
    /// Unknown YAML is tolerated on read for forward compatibility, but a V6
    /// mutation must never erase it. COMPAT-1B therefore fails closed rather
    /// than rewriting a document containing fields this build does not own.
    pub(crate) fn has_unknown_fields(&self) -> bool {
        !self.extra.is_empty()
            || self
                .providers
                .iter()
                .any(|provider| !provider.extra.is_empty())
            || self.models.iter().any(|model| {
                !model.extra.is_empty()
                    || !model.model_type.extra.is_empty()
                    || model
                        .capabilities
                        .values()
                        .any(|value| !value.extra.is_empty())
                    || model
                        .last_test
                        .as_ref()
                        .is_some_and(|result| !result.extra.is_empty())
            })
            || self
                .capability_routes
                .iter()
                .any(|route| !route.extra.is_empty())
    }
}

/// Truthful load outcome: never panic, never guess; callers decide policy.
/// Reasons are content-free by construction (see the module header).
#[derive(Debug)]
pub(crate) enum AgentConfigLoad {
    /// No `config.yaml` exists at the resolved Rho home. The path is carried
    /// so callers can name it in re-entry copy.
    Missing { path: PathBuf },
    /// A V6 configuration parsed successfully.
    Loaded(AgentConfig),
    /// The file declares a different schema version; no upgrade or downgrade
    /// is attempted.
    UnsupportedSchemaVersion { path: PathBuf, found: u64 },
    /// The file is unreadable, empty, oversized, not valid YAML, missing a
    /// numeric `schema_version`, or shaped unlike the V6 schema.
    Malformed { path: PathBuf, reason: String },
}

#[derive(Debug)]
pub(crate) struct AgentConfigRead {
    pub load: AgentConfigLoad,
    pub content_identity: String,
}

/// Which file object's permissions are being reported.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfigPermissionSubject {
    RhoHome,
    ConfigFile,
}

/// One loose-permissions finding: the object, its actual mode, and the mode
/// Rho uses for objects it creates. On Windows the mode values are opaque
/// permission-state markers because ACLs do not map to POSIX mode bits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigPermissionIssue {
    pub subject: ConfigPermissionSubject,
    pub path: PathBuf,
    pub actual_mode: u32,
    pub expected_mode: u32,
}

/// Strict permission inspection used by the opaque Settings snapshot. Unlike
/// the presentation-only issue list, this identity fails when an existing
/// object cannot be inspected and binds the final opened path objects.
#[derive(Debug, Clone)]
pub(crate) struct ConfigPermissionState {
    pub identity: String,
    pub issues: Vec<ConfigPermissionIssue>,
}

struct SecureConfigRead {
    bytes: Option<Zeroizing<Vec<u8>>>,
    content_identity: String,
    permission_state: ConfigPermissionState,
}

/// Load `config.yaml` from a resolved Rho home, reporting the truthful
/// outcome.
#[cfg(test)]
pub(crate) fn load_config(home: &Path) -> AgentConfigLoad {
    match read_config_snapshot(home) {
        Ok(snapshot) => snapshot.load,
        Err(error) => AgentConfigLoad::Malformed {
            path: config_file_path(home),
            reason: format!("the configuration path is unavailable: {error}"),
        },
    }
}

/// Open and bound the canonical file exactly once. On Unix this uses a real
/// no-follow directory handle plus `openat(O_NOFOLLOW)`, so a path swap cannot
/// redirect the read outside the selected Rho home.
pub(crate) fn read_config_snapshot(home: &Path) -> Result<AgentConfigRead> {
    let path = config_file_path(home);
    let snapshot = secure_store::read(home)?;
    let Some(bytes) = snapshot.bytes else {
        return Ok(AgentConfigRead {
            load: AgentConfigLoad::Missing { path },
            content_identity: snapshot.content_identity,
        });
    };
    Ok(AgentConfigRead {
        load: parse_config_bytes(&path, &bytes),
        content_identity: snapshot.content_identity,
    })
}

fn identity_for_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn identity_for_parts(parts: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    format!("{:x}", digest.finalize())
}

fn path_identity_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect()
    }
    #[cfg(not(any(unix, windows)))]
    {
        path.as_os_str().to_string_lossy().as_bytes().to_vec()
    }
}

fn missing_home_identity(home: &Path) -> String {
    let path = path_identity_bytes(home);
    format!(
        "{MISSING_CONFIG_IDENTITY}:home:{}",
        identity_for_parts(&[b"rho-home", &path])
    )
}

/// Platform store for the one canonical plaintext configuration file.
///
/// The Unix implementation keeps the selected Rho home open and performs
/// config-file operations relative to that descriptor.  The portable
/// implementation uses no-follow/reparse-point checks where the platform API
/// exposes them and verifies path metadata around replacement.
mod secure_store {
    #[cfg(unix)]
    use super::ConfigPermissionSubject;
    use super::{
        CONFIG_FILE_NAME, ConfigPermissionIssue, ConfigPermissionState, MAX_CONFIG_BYTES,
        SecureConfigRead, config_file_path, identity_for_bytes, identity_for_parts,
        missing_home_identity, path_identity_bytes,
    };
    use anyhow::Result;
    use std::path::Path;

    pub(super) fn read(home: &Path) -> Result<SecureConfigRead> {
        platform::read(home)
    }

    pub(super) fn write(
        home: &Path,
        bytes: &[u8],
        expected_identity: Option<&str>,
    ) -> Result<String> {
        platform::write(home, bytes, expected_identity)
    }

    pub(super) fn repair(
        home: &Path,
        expected_identity: &str,
    ) -> Result<Vec<ConfigPermissionIssue>> {
        platform::repair(home, expected_identity)
    }

    #[cfg(all(test, unix))]
    pub(super) fn write_with_precommit_hook<F>(
        home: &Path,
        bytes: &[u8],
        expected_identity: Option<&str>,
        hook: F,
    ) -> Result<String>
    where
        F: FnOnce(),
    {
        platform::write_with_test_precommit(home, bytes, expected_identity, hook)
    }

    #[cfg(all(test, unix))]
    pub(super) fn repair_with_prevalidation_hook<F>(
        home: &Path,
        expected_identity: &str,
        hook: F,
    ) -> Result<Vec<ConfigPermissionIssue>>
    where
        F: FnOnce(),
    {
        platform::repair_with_test_prevalidation(home, expected_identity, hook)
    }

    fn missing_permission_state(home: &Path) -> ConfigPermissionState {
        let path = path_identity_bytes(home);
        ConfigPermissionState {
            identity: identity_for_parts(&[b"config-permissions-missing-home", &path]),
            issues: Vec::new(),
        }
    }

    #[cfg(unix)]
    mod platform {
        use super::*;
        use anyhow::{Context, anyhow, bail, ensure};
        use std::ffi::CString;
        use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
        use std::io::{ErrorKind, Read, Write};
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
        use std::path::Path;
        use zeroize::Zeroizing;

        const HOME_MODE: u32 = 0o700;
        const CONFIG_MODE: u32 = 0o600;

        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        struct HomeIdentity {
            device: u64,
            inode: u64,
            mode: u32,
        }

        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        struct FileIdentity {
            device: u64,
            inode: u64,
            mode: u32,
            size: u64,
            modified_seconds: i64,
            modified_nanoseconds: i64,
            changed_seconds: i64,
            changed_nanoseconds: i64,
        }

        impl HomeIdentity {
            fn from_metadata(metadata: &Metadata) -> Self {
                Self {
                    device: metadata.dev(),
                    inode: metadata.ino(),
                    mode: metadata.mode() & 0o7777,
                }
            }

            fn object_matches(self, other: Self) -> bool {
                self.device == other.device && self.inode == other.inode
            }

            fn append_to(self, bytes: &mut Vec<u8>) {
                bytes.extend_from_slice(&self.device.to_le_bytes());
                bytes.extend_from_slice(&self.inode.to_le_bytes());
                bytes.extend_from_slice(&self.mode.to_le_bytes());
            }
        }

        impl FileIdentity {
            fn from_metadata(metadata: &Metadata) -> Self {
                Self {
                    device: metadata.dev(),
                    inode: metadata.ino(),
                    mode: metadata.mode() & 0o7777,
                    size: metadata.size(),
                    modified_seconds: metadata.mtime(),
                    modified_nanoseconds: metadata.mtime_nsec(),
                    changed_seconds: metadata.ctime(),
                    changed_nanoseconds: metadata.ctime_nsec(),
                }
            }

            fn append_permission_parts(self, bytes: &mut Vec<u8>) {
                bytes.extend_from_slice(&self.device.to_le_bytes());
                bytes.extend_from_slice(&self.inode.to_le_bytes());
                bytes.extend_from_slice(&self.mode.to_le_bytes());
            }
        }

        struct OpenedSnapshot {
            read: SecureConfigRead,
            file_identity: Option<FileIdentity>,
        }

        struct TemporaryEntry<'a> {
            home: &'a File,
            name: CString,
            armed: bool,
        }

        impl Drop for TemporaryEntry<'_> {
            fn drop(&mut self) {
                if self.armed {
                    unsafe {
                        libc::unlinkat(self.home.as_raw_fd(), self.name.as_ptr(), 0);
                    }
                }
            }
        }

        pub(super) fn read(home: &Path) -> Result<SecureConfigRead> {
            let Some((home_file, home_metadata)) = open_home(home)? else {
                return Ok(SecureConfigRead {
                    bytes: None,
                    content_identity: missing_home_identity(home),
                    permission_state: missing_permission_state(home),
                });
            };
            let snapshot = read_from_open_home(home, &home_file, &home_metadata)?;
            verify_home_path(home, HomeIdentity::from_metadata(&home_metadata))?;
            Ok(snapshot.read)
        }

        pub(super) fn write(
            home: &Path,
            bytes: &[u8],
            expected_identity: Option<&str>,
        ) -> Result<String> {
            write_with_precommit(home, bytes, expected_identity, || {})
        }

        #[cfg(test)]
        pub(super) fn write_with_test_precommit<F>(
            home: &Path,
            bytes: &[u8],
            expected_identity: Option<&str>,
            hook: F,
        ) -> Result<String>
        where
            F: FnOnce(),
        {
            write_with_precommit(home, bytes, expected_identity, hook)
        }

        fn write_with_precommit<F>(
            home: &Path,
            bytes: &[u8],
            expected_identity: Option<&str>,
            precommit_hook: F,
        ) -> Result<String>
        where
            F: FnOnce(),
        {
            ensure!(
                bytes.len() <= MAX_CONFIG_BYTES,
                "The model configuration exceeds the supported size limit."
            );
            let home_created = ensure_home_exists(home)?;
            let (home_file, home_metadata) = open_home(home)?
                .ok_or_else(|| anyhow!("The canonical Rho home is unavailable."))?;
            let home_identity = HomeIdentity::from_metadata(&home_metadata);
            let initial = read_from_open_home(home, &home_file, &home_metadata)?;
            ensure!(
                initial.read.permission_state.issues.is_empty(),
                "The canonical model configuration has loose permissions. Repair them before saving."
            );
            if let Some(expected) = expected_identity {
                let current_expected = if home_created {
                    missing_home_identity(home)
                } else {
                    initial.read.content_identity.clone()
                };
                ensure!(
                    current_expected == expected,
                    "The canonical model configuration changed outside Rho. Reload Settings and try again."
                );
            }

            let temporary_name = CString::new(format!(
                ".{CONFIG_FILE_NAME}.{}.{}.tmp",
                std::process::id(),
                uuid::Uuid::new_v4()
            ))
            .expect("generated temporary config name contains no NUL");
            let descriptor = unsafe {
                libc::openat(
                    home_file.as_raw_fd(),
                    temporary_name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    CONFIG_MODE,
                )
            };
            if descriptor < 0 {
                return Err(anyhow!(
                    "The model configuration temporary file could not be created."
                ));
            }
            let mut temporary_file = unsafe { File::from_raw_fd(descriptor) };
            let mut temporary_entry = TemporaryEntry {
                home: &home_file,
                name: temporary_name,
                armed: true,
            };
            temporary_file
                .write_all(bytes)
                .context("writing the model configuration temporary file")?;
            temporary_file
                .sync_all()
                .context("syncing the model configuration temporary file")?;

            precommit_hook();
            let current_home_metadata =
                refresh_home_metadata(home, &home_file, home_identity, Some(HOME_MODE))?;
            let current = read_from_open_home(home, &home_file, &current_home_metadata)?;
            ensure!(
                current.read.content_identity == initial.read.content_identity
                    && current.read.permission_state.identity
                        == initial.read.permission_state.identity,
                "The canonical model configuration changed outside Rho. Reload Settings and try again."
            );
            refresh_home_metadata(home, &home_file, home_identity, Some(HOME_MODE))?;

            let target_name = CString::new(CONFIG_FILE_NAME).expect("constant contains no NUL");
            let renamed = unsafe {
                libc::renameat(
                    home_file.as_raw_fd(),
                    temporary_entry.name.as_ptr(),
                    home_file.as_raw_fd(),
                    target_name.as_ptr(),
                )
            };
            if renamed != 0 {
                return Err(anyhow!(
                    "The model configuration could not be replaced atomically."
                ));
            }
            temporary_entry.armed = false;
            drop(temporary_file);
            home_file
                .sync_all()
                .context("syncing the canonical Rho home after configuration replacement")?;

            let committed_home_metadata =
                refresh_home_metadata(home, &home_file, home_identity, Some(HOME_MODE))?;
            let committed = read_from_open_home(home, &home_file, &committed_home_metadata)?;
            let committed_identity = identity_for_bytes(bytes);
            ensure!(
                committed.read.content_identity == committed_identity,
                "The model configuration replacement could not be verified."
            );
            refresh_home_metadata(home, &home_file, home_identity, Some(HOME_MODE))?;
            Ok(committed_identity)
        }

        pub(super) fn repair(
            home: &Path,
            expected_identity: &str,
        ) -> Result<Vec<ConfigPermissionIssue>> {
            repair_with_prevalidation(home, expected_identity, || {})
        }

        #[cfg(test)]
        pub(super) fn repair_with_test_prevalidation<F>(
            home: &Path,
            expected_identity: &str,
            hook: F,
        ) -> Result<Vec<ConfigPermissionIssue>>
        where
            F: FnOnce(),
        {
            repair_with_prevalidation(home, expected_identity, hook)
        }

        fn repair_with_prevalidation<F>(
            home: &Path,
            expected_identity: &str,
            prevalidation_hook: F,
        ) -> Result<Vec<ConfigPermissionIssue>>
        where
            F: FnOnce(),
        {
            let Some((home_file, home_metadata)) = open_home(home)? else {
                ensure!(
                    missing_home_identity(home) == expected_identity,
                    "The canonical model configuration changed outside Rho. Reload Settings and try again."
                );
                return Ok(Vec::new());
            };
            let home_identity = HomeIdentity::from_metadata(&home_metadata);
            let initial = read_from_open_home(home, &home_file, &home_metadata)?;
            ensure!(
                initial.read.content_identity == expected_identity,
                "The canonical model configuration changed outside Rho. Reload Settings and try again."
            );
            verify_home_path(home, home_identity)?;

            if let Some(expected_file_identity) = initial.file_identity {
                let file = open_config(&home_file)?.ok_or_else(|| {
                    anyhow!("The canonical model configuration changed outside Rho.")
                })?;
                ensure!(
                    FileIdentity::from_metadata(&file.metadata().context(
                        "inspecting the canonical model configuration before permission repair"
                    )?) == expected_file_identity,
                    "The canonical model configuration changed outside Rho. Reload Settings and try again."
                );
                file.set_permissions(fs::Permissions::from_mode(CONFIG_MODE))
                    .context("repairing model configuration permissions")?;
            }
            home_file
                .set_permissions(fs::Permissions::from_mode(HOME_MODE))
                .context("repairing Rho home permissions")?;

            prevalidation_hook();
            let repaired_metadata =
                refresh_home_metadata(home, &home_file, home_identity, Some(HOME_MODE))?;
            let repaired = read_from_open_home(home, &home_file, &repaired_metadata)?;
            ensure!(
                repaired.read.content_identity == expected_identity,
                "The canonical model configuration changed during permission repair. Reload Settings and try again."
            );
            ensure!(
                repaired.read.permission_state.issues.is_empty(),
                "The canonical model configuration permissions changed during repair. Reload Settings and try again."
            );
            refresh_home_metadata(home, &home_file, home_identity, Some(HOME_MODE))?;
            Ok(repaired.read.permission_state.issues)
        }

        fn ensure_home_exists(home: &Path) -> Result<bool> {
            if open_home(home)?.is_some() {
                return Ok(false);
            }
            let parent = home
                .parent()
                .ok_or_else(|| anyhow!("The canonical Rho home has no parent directory."))?;
            let mut builder = DirBuilder::new();
            builder.recursive(true).mode(HOME_MODE);
            builder
                .create(parent)
                .context("creating the canonical Rho home parent")?;
            let mut home_builder = DirBuilder::new();
            home_builder.mode(HOME_MODE);
            match home_builder.create(home) {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    open_home(home)?.ok_or_else(|| {
                        anyhow!("The canonical Rho home changed while it was being created.")
                    })?;
                    Ok(false)
                }
                Err(error) => Err(error).context("creating the canonical Rho home"),
            }
        }

        fn open_home(home: &Path) -> Result<Option<(File, Metadata)>> {
            let file = match OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(home)
            {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(_) => bail!(
                    "The canonical Rho home must be an available directory, not a symbolic link."
                ),
            };
            let metadata = file
                .metadata()
                .context("inspecting the canonical Rho home")?;
            ensure!(
                metadata.is_dir(),
                "The canonical Rho home must be a directory."
            );
            Ok(Some((file, metadata)))
        }

        fn open_config(home: &File) -> Result<Option<File>> {
            let name = CString::new(CONFIG_FILE_NAME).expect("constant contains no NUL");
            let descriptor = unsafe {
                libc::openat(
                    home.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == ErrorKind::NotFound {
                    return Ok(None);
                }
                bail!(
                    "The canonical model configuration must be an available regular file, not a symbolic link."
                );
            }
            Ok(Some(unsafe { File::from_raw_fd(descriptor) }))
        }

        fn read_from_open_home(
            home_path: &Path,
            home: &File,
            home_metadata: &Metadata,
        ) -> Result<OpenedSnapshot> {
            let home_identity = HomeIdentity::from_metadata(home_metadata);
            let mut issues = permission_issues(home_path, home_identity, None);
            let Some(mut file) = open_config(home)? else {
                return Ok(OpenedSnapshot {
                    read: SecureConfigRead {
                        bytes: None,
                        content_identity: missing_config_identity(home_path, home_identity),
                        permission_state: ConfigPermissionState {
                            identity: permission_identity(home_path, home_identity, None),
                            issues,
                        },
                    },
                    file_identity: None,
                });
            };
            let metadata_before = file
                .metadata()
                .context("inspecting the canonical model configuration")?;
            ensure!(
                metadata_before.is_file(),
                "The canonical model configuration must be a regular file."
            );
            ensure!(
                metadata_before.len() <= MAX_CONFIG_BYTES as u64,
                "The canonical model configuration exceeds the supported size limit."
            );
            let file_identity = FileIdentity::from_metadata(&metadata_before);
            issues.extend(permission_issues(
                home_path,
                home_identity,
                Some(file_identity),
            ));
            issues.sort_by_key(|issue| match issue.subject {
                ConfigPermissionSubject::RhoHome => 0,
                ConfigPermissionSubject::ConfigFile => 1,
            });
            issues.dedup_by_key(|issue| issue.subject);

            let mut bytes = Zeroizing::new(Vec::with_capacity(
                usize::try_from(metadata_before.len())
                    .unwrap_or(MAX_CONFIG_BYTES)
                    .min(MAX_CONFIG_BYTES),
            ));
            {
                let mut bounded = (&mut file).take((MAX_CONFIG_BYTES + 1) as u64);
                bounded
                    .read_to_end(&mut bytes)
                    .context("reading the canonical model configuration")?;
            }
            ensure!(
                bytes.len() <= MAX_CONFIG_BYTES,
                "The canonical model configuration exceeds the supported size limit."
            );
            ensure!(
                FileIdentity::from_metadata(
                    &file
                        .metadata()
                        .context("re-inspecting the canonical model configuration")?
                ) == file_identity,
                "The canonical model configuration changed while it was being read."
            );
            let current = open_config(home)?.ok_or_else(|| {
                anyhow!("The canonical model configuration changed while it was being read.")
            })?;
            ensure!(
                FileIdentity::from_metadata(
                    &current
                        .metadata()
                        .context("verifying the canonical model configuration path")?
                ) == file_identity,
                "The canonical model configuration changed while it was being read."
            );

            Ok(OpenedSnapshot {
                read: SecureConfigRead {
                    content_identity: identity_for_bytes(&bytes),
                    bytes: Some(bytes),
                    permission_state: ConfigPermissionState {
                        identity: permission_identity(
                            home_path,
                            home_identity,
                            Some(file_identity),
                        ),
                        issues,
                    },
                },
                file_identity: Some(file_identity),
            })
        }

        fn verify_home_path(home: &Path, expected: HomeIdentity) -> Result<()> {
            let metadata =
                fs::symlink_metadata(home).context("verifying the canonical Rho home path")?;
            ensure!(
                !metadata.file_type().is_symlink() && metadata.is_dir(),
                "The canonical Rho home path changed or became a symbolic link."
            );
            ensure!(
                expected == HomeIdentity::from_metadata(&metadata),
                "The canonical Rho home path changed while it was in use."
            );
            Ok(())
        }

        /// Refresh both the already-open directory descriptor and its current
        /// path entry immediately before a mutation commits. Object identity
        /// alone is insufficient: a concurrent chmod on the same inode must
        /// make a save fail closed instead of replacing config.yaml from a
        /// newly loose home.
        fn refresh_home_metadata(
            home_path: &Path,
            home: &File,
            expected_object: HomeIdentity,
            required_mode: Option<u32>,
        ) -> Result<Metadata> {
            let opened_metadata = home
                .metadata()
                .context("refreshing the opened canonical Rho home")?;
            ensure!(
                opened_metadata.is_dir(),
                "The opened canonical Rho home is no longer a directory."
            );
            let opened_identity = HomeIdentity::from_metadata(&opened_metadata);
            ensure!(
                expected_object.object_matches(opened_identity),
                "The opened canonical Rho home changed while it was in use."
            );

            let path_metadata = fs::symlink_metadata(home_path)
                .context("refreshing the canonical Rho home path")?;
            ensure!(
                !path_metadata.file_type().is_symlink() && path_metadata.is_dir(),
                "The canonical Rho home path changed or became a symbolic link."
            );
            let path_identity = HomeIdentity::from_metadata(&path_metadata);
            ensure!(
                expected_object.object_matches(path_identity)
                    && opened_identity.object_matches(path_identity)
                    && opened_identity.mode == path_identity.mode,
                "The canonical Rho home path or permissions changed while it was in use."
            );
            if let Some(mode) = required_mode {
                ensure!(
                    opened_identity.mode == mode && path_identity.mode == mode,
                    "The canonical Rho home permissions changed. Reload Settings and try again."
                );
            }
            Ok(opened_metadata)
        }

        fn missing_config_identity(home: &Path, identity: HomeIdentity) -> String {
            let path = path_identity_bytes(home);
            let mut object = Vec::new();
            object.extend_from_slice(&identity.device.to_le_bytes());
            object.extend_from_slice(&identity.inode.to_le_bytes());
            format!(
                "missing:file:{}",
                identity_for_parts(&[b"rho-config-missing", &path, &object])
            )
        }

        fn permission_identity(
            home: &Path,
            home_identity: HomeIdentity,
            file_identity: Option<FileIdentity>,
        ) -> String {
            let path = path_identity_bytes(home);
            let mut objects = Vec::new();
            home_identity.append_to(&mut objects);
            match file_identity {
                Some(identity) => {
                    objects.push(1);
                    identity.append_permission_parts(&mut objects);
                }
                None => objects.push(0),
            }
            identity_for_parts(&[b"config-permissions", &path, &objects])
        }

        fn permission_issues(
            home: &Path,
            home_identity: HomeIdentity,
            file_identity: Option<FileIdentity>,
        ) -> Vec<ConfigPermissionIssue> {
            let mut issues = Vec::new();
            if home_identity.mode != HOME_MODE {
                issues.push(ConfigPermissionIssue {
                    subject: ConfigPermissionSubject::RhoHome,
                    path: home.to_path_buf(),
                    actual_mode: home_identity.mode,
                    expected_mode: HOME_MODE,
                });
            }
            if let Some(identity) = file_identity
                && identity.mode != CONFIG_MODE
            {
                issues.push(ConfigPermissionIssue {
                    subject: ConfigPermissionSubject::ConfigFile,
                    path: config_file_path(home),
                    actual_mode: identity.mode,
                    expected_mode: CONFIG_MODE,
                });
            }
            issues
        }
    }

    #[cfg(not(unix))]
    mod platform {
        use super::*;
        use anyhow::{Context, anyhow, ensure};
        use std::fs::{self, File, Metadata, OpenOptions};
        use std::io::{ErrorKind, Read, Write};
        use std::path::{Path, PathBuf};
        use zeroize::Zeroizing;

        struct TemporaryPath {
            path: PathBuf,
            armed: bool,
        }

        impl Drop for TemporaryPath {
            fn drop(&mut self) {
                if self.armed {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }

        pub(super) fn read(home: &Path) -> Result<SecureConfigRead> {
            let Some(home_metadata) = checked_home_metadata(home)? else {
                return Ok(SecureConfigRead {
                    bytes: None,
                    content_identity: missing_home_identity(home),
                    permission_state: missing_permission_state(home),
                });
            };
            let home_identity = metadata_identity(&home_metadata, true);
            let path = config_file_path(home);
            let Some(mut file) = checked_config_file(&path)? else {
                return Ok(SecureConfigRead {
                    bytes: None,
                    content_identity: missing_config_identity(home, &home_identity),
                    permission_state: ConfigPermissionState {
                        identity: permission_identity(home, &home_identity, None),
                        issues: Vec::new(),
                    },
                });
            };
            let metadata = file
                .metadata()
                .context("inspecting the model configuration")?;
            ensure!(
                !is_link_or_reparse(&metadata)
                    && metadata.is_file()
                    && metadata.len() <= MAX_CONFIG_BYTES as u64,
                "The canonical model configuration is not a supported regular file."
            );
            let file_identity = metadata_identity(&metadata, false);
            let mut bytes = Zeroizing::new(Vec::new());
            {
                let mut bounded = (&mut file).take((MAX_CONFIG_BYTES + 1) as u64);
                bounded
                    .read_to_end(&mut bytes)
                    .context("reading the canonical model configuration")?;
            }
            ensure!(
                bytes.len() <= MAX_CONFIG_BYTES,
                "The canonical model configuration exceeds the supported size limit."
            );
            ensure!(
                metadata_identity(
                    &file
                        .metadata()
                        .context("re-inspecting the model configuration")?,
                    false,
                ) == file_identity,
                "The canonical model configuration changed while it was being read."
            );
            verify_home(home, &home_identity)?;
            Ok(SecureConfigRead {
                content_identity: identity_for_bytes(&bytes),
                bytes: Some(bytes),
                permission_state: ConfigPermissionState {
                    identity: permission_identity(home, &home_identity, Some(&file_identity)),
                    // Portable ACLs do not map truthfully to POSIX modes.  New
                    // files inherit the user's protected directory ACL.
                    issues: Vec::new(),
                },
            })
        }

        pub(super) fn write(
            home: &Path,
            bytes: &[u8],
            expected_identity: Option<&str>,
        ) -> Result<String> {
            ensure!(
                bytes.len() <= MAX_CONFIG_BYTES,
                "The model configuration exceeds the supported size limit."
            );
            let home_created = ensure_home_exists(home)?;
            let initial = read(home)?;
            if let Some(expected) = expected_identity {
                let current_expected = if home_created {
                    missing_home_identity(home)
                } else {
                    initial.content_identity.clone()
                };
                ensure!(
                    current_expected == expected,
                    "The canonical model configuration changed outside Rho. Reload Settings and try again."
                );
            }
            let temporary_path = home.join(format!(
                ".{CONFIG_FILE_NAME}.{}.{}.tmp",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            let mut temporary = TemporaryPath {
                path: temporary_path.clone(),
                armed: true,
            };
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
                .context("creating the model configuration temporary file")?;
            file.write_all(bytes)
                .context("writing the model configuration temporary file")?;
            file.sync_all()
                .context("syncing the model configuration temporary file")?;
            drop(file);
            let current = read(home)?;
            ensure!(
                current.content_identity == initial.content_identity
                    && current.permission_state.identity == initial.permission_state.identity,
                "The canonical model configuration changed outside Rho. Reload Settings and try again."
            );
            replace_atomically(&temporary_path, &config_file_path(home))?;
            temporary.armed = false;
            let committed = read(home)?;
            let identity = identity_for_bytes(bytes);
            ensure!(
                committed.content_identity == identity,
                "The model configuration replacement could not be verified."
            );
            Ok(identity)
        }

        pub(super) fn repair(
            home: &Path,
            expected_identity: &str,
        ) -> Result<Vec<ConfigPermissionIssue>> {
            let current = read(home)?;
            ensure!(
                current.content_identity == expected_identity,
                "The canonical model configuration changed outside Rho. Reload Settings and try again."
            );
            Ok(current.permission_state.issues)
        }

        fn checked_home_metadata(home: &Path) -> Result<Option<Metadata>> {
            let metadata = match fs::symlink_metadata(home) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error).context("inspecting the canonical Rho home"),
            };
            ensure!(
                !is_link_or_reparse(&metadata) && metadata.is_dir(),
                "The canonical Rho home must be a directory, not a link or reparse point."
            );
            Ok(Some(metadata))
        }

        fn ensure_home_exists(home: &Path) -> Result<bool> {
            if checked_home_metadata(home)?.is_some() {
                return Ok(false);
            }
            let parent = home
                .parent()
                .ok_or_else(|| anyhow!("The canonical Rho home has no parent directory."))?;
            fs::create_dir_all(parent).context("creating the canonical Rho home parent")?;
            match fs::create_dir(home) {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    checked_home_metadata(home)?.ok_or_else(|| {
                        anyhow!("The canonical Rho home changed while it was being created.")
                    })?;
                    Ok(false)
                }
                Err(error) => Err(error).context("creating the canonical Rho home"),
            }
        }

        #[cfg(windows)]
        fn replace_atomically(source: &Path, destination: &Path) -> Result<()> {
            use std::os::windows::ffi::OsStrExt;

            const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
            const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn MoveFileExW(
                    existing_file_name: *const u16,
                    new_file_name: *const u16,
                    flags: u32,
                ) -> i32;
            }

            let source = source
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let destination = destination
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let replaced = unsafe {
                MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            ensure!(
                replaced != 0,
                "The model configuration could not be replaced atomically."
            );
            Ok(())
        }

        #[cfg(not(windows))]
        fn replace_atomically(source: &Path, destination: &Path) -> Result<()> {
            fs::rename(source, destination).context("replacing the model configuration atomically")
        }

        fn checked_config_file(path: &Path) -> Result<Option<File>> {
            let metadata = match fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error).context("inspecting the model configuration path"),
            };
            ensure!(
                !is_link_or_reparse(&metadata) && metadata.is_file(),
                "The canonical model configuration must be a regular file, not a link or reparse point."
            );
            open_config_file(path).map(Some)
        }

        #[cfg(windows)]
        fn open_config_file(path: &Path) -> Result<File> {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .map_err(|_| anyhow!("The canonical model configuration is unavailable."))
        }

        #[cfg(not(windows))]
        fn open_config_file(path: &Path) -> Result<File> {
            OpenOptions::new()
                .read(true)
                .open(path)
                .map_err(|_| anyhow!("The canonical model configuration is unavailable."))
        }

        fn verify_home(home: &Path, expected: &[u8]) -> Result<()> {
            let metadata = checked_home_metadata(home)?
                .ok_or_else(|| anyhow!("The canonical Rho home changed while it was in use."))?;
            ensure!(
                metadata_identity(&metadata, true) == expected,
                "The canonical Rho home changed while it was in use."
            );
            Ok(())
        }

        fn missing_config_identity(home: &Path, home_identity: &[u8]) -> String {
            let path = path_identity_bytes(home);
            format!(
                "missing:file:{}",
                identity_for_parts(&[b"rho-config-missing", &path, home_identity])
            )
        }

        fn permission_identity(
            home: &Path,
            home_identity: &[u8],
            file_identity: Option<&[u8]>,
        ) -> String {
            let path = path_identity_bytes(home);
            let marker = [u8::from(file_identity.is_some())];
            identity_for_parts(&[
                b"config-permissions",
                &path,
                home_identity,
                &marker,
                file_identity.unwrap_or_default(),
            ])
        }

        #[cfg(windows)]
        fn is_link_or_reparse(metadata: &Metadata) -> bool {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
            metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        }

        #[cfg(not(windows))]
        fn is_link_or_reparse(metadata: &Metadata) -> bool {
            metadata.file_type().is_symlink()
        }

        #[cfg(windows)]
        fn metadata_identity(metadata: &Metadata, directory: bool) -> Vec<u8> {
            use std::os::windows::fs::MetadataExt;
            let mut identity = Vec::new();
            identity.extend_from_slice(&metadata.file_attributes().to_le_bytes());
            identity.extend_from_slice(&metadata.creation_time().to_le_bytes());
            if !directory {
                identity.extend_from_slice(&metadata.last_write_time().to_le_bytes());
                identity.extend_from_slice(&metadata.file_size().to_le_bytes());
            }
            identity
        }

        #[cfg(not(windows))]
        fn metadata_identity(metadata: &Metadata, directory: bool) -> Vec<u8> {
            let mut identity = Vec::new();
            identity.push(u8::from(metadata.permissions().readonly()));
            identity.push(u8::from(metadata.is_dir()));
            identity.push(u8::from(metadata.is_file()));
            if !directory {
                identity.extend_from_slice(&metadata.len().to_le_bytes());
            }
            identity
        }
    }
}

fn parse_config_bytes(path: &Path, bytes: &[u8]) -> AgentConfigLoad {
    if bytes.len() > MAX_CONFIG_BYTES {
        return AgentConfigLoad::Malformed {
            path: path.to_path_buf(),
            reason: format!("the file exceeds the {} KiB limit", MAX_CONFIG_BYTES / 1024),
        };
    }
    if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
        return AgentConfigLoad::Malformed {
            path: path.to_path_buf(),
            reason: "the file is empty".to_string(),
        };
    }
    let probe = match serde_norway::from_slice::<SchemaVersionProbe>(bytes) {
        Ok(probe) => probe,
        Err(error) => {
            return AgentConfigLoad::Malformed {
                path: path.to_path_buf(),
                reason: content_free_parse_reason(&error),
            };
        }
    };
    let Some(found) = probe.schema_version else {
        return AgentConfigLoad::Malformed {
            path: path.to_path_buf(),
            reason: "the file is missing a numeric schema_version".to_string(),
        };
    };
    if found != u64::from(CONFIG_SCHEMA_VERSION) {
        return AgentConfigLoad::UnsupportedSchemaVersion {
            path: path.to_path_buf(),
            found,
        };
    }
    match serde_norway::from_slice::<AgentConfig>(bytes) {
        Ok(config) => AgentConfigLoad::Loaded(config),
        Err(error) => AgentConfigLoad::Malformed {
            path: path.to_path_buf(),
            reason: content_free_parse_reason(&error),
        },
    }
}

/// Parser diagnostics without the parser message: serde `invalid type`
/// messages can embed the offending value, and the file is plaintext that
/// may hold credentials. Location (line/column) is content-free and kept.
fn content_free_parse_reason(error: &serde_norway::Error) -> String {
    match error.location() {
        Some(location) => format!(
            "the file is not valid V6 YAML (line {}, column {})",
            location.line(),
            location.column()
        ),
        None => "the file is not valid V6 YAML".to_string(),
    }
}

#[derive(Debug, Deserialize)]
struct SchemaVersionProbe {
    schema_version: Option<u64>,
}

fn serialize_config(config: &AgentConfig) -> Result<Zeroizing<String>> {
    ensure!(
        config.schema_version == CONFIG_SCHEMA_VERSION,
        "Refusing to write a model configuration with schema_version {} (expected {CONFIG_SCHEMA_VERSION}).",
        config.schema_version
    );
    let document = Zeroizing::new(
        serde_norway::to_string(config).context("serializing the model configuration")?,
    );
    ensure!(
        document.len() <= MAX_CONFIG_BYTES,
        "The model configuration exceeds the {} KiB limit.",
        MAX_CONFIG_BYTES / 1024
    );
    Ok(document)
}

/// Write the configuration atomically. Existing loose or uninspectable
/// objects remain read-only; only newly created objects are hardened as part
/// of creation. Platform implementations bind the entire operation to opened
/// handles and make rename the last fallible commit point.
#[cfg(test)]
pub(crate) fn save_config(home: &Path, config: &AgentConfig) -> Result<()> {
    let document = serialize_config(config)?;
    secure_store::write(home, document.as_bytes(), None)?;
    Ok(())
}

/// Compare the exact current snapshot identity under the caller's
/// settings-mutation lock, then atomically replace the V6 file. Existing-file
/// identities hash the exact bytes; missing-file identities additionally bind
/// the selected path and opened Rho-home object. These values stay internal to
/// the snapshot registry and are never projected through Settings IPC.
pub(crate) fn save_config_cas(
    home: &Path,
    config: &AgentConfig,
    expected_identity: &str,
) -> Result<String> {
    ensure!(
        !config.has_unknown_fields(),
        "The model configuration contains fields this Rho version does not own. Edit the file directly or remove the unsupported fields before using Settings."
    );
    let document = serialize_config(config)?;
    secure_store::write(home, document.as_bytes(), Some(expected_identity))
}

/// Serialize-and-write core with the writer injected, mirroring the
/// `save_settings_with` failure-injection idiom in `agent_llm.rs`.
#[cfg(test)]
fn save_config_with<F>(home: &Path, config: &AgentConfig, mut write: F) -> Result<()>
where
    F: FnMut(&Path, &[u8]) -> Result<()>,
{
    let path = config_file_path(home);
    let document = serialize_config(config)
        .with_context(|| format!("serializing the model configuration {}", path.display()))?;
    write(&path, document.as_bytes())
        .with_context(|| format!("writing the model configuration {}", path.display()))
}

pub(crate) fn permission_state(home: &Path) -> Result<ConfigPermissionState> {
    Ok(secure_store::read(home)?.permission_state)
}

/// Report pre-existing loose permissions on the resolved Rho home and the
/// configuration file without changing anything. Missing objects and objects
/// that cannot be stat'ed produce no finding; non-unix platforms report
/// nothing (hardening there is best-effort at write time).
#[cfg(test)]
pub(crate) fn permission_issues(home: &Path) -> Vec<ConfigPermissionIssue> {
    permission_state(home)
        .map(|state| state.issues)
        .unwrap_or_default()
}

/// Explicit, path-pinned permission repair. Resolution is performed by the
/// caller and the exact path is checked again here; this helper never follows
/// a different Rho home selected after the Settings view was rendered.
pub(crate) fn repair_permissions(
    home: &Path,
    expected_config_path: &Path,
    expected_identity: &str,
) -> Result<Vec<ConfigPermissionIssue>> {
    let path = config_file_path(home);
    ensure!(
        path == expected_config_path,
        "The model configuration path changed. Reload Settings and try again."
    );
    secure_store::repair(home, expected_identity)
}

/// Effective credential source for a provider, per the owner's precedence
/// ruling (session → environment → config-file literal → not configured).
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentCredentialSource {
    Session,
    Environment,
    ConfigFile,
    NotConfigured,
}

/// Outcome of one credential resolution: the effective source, the resolved
/// value (secret-bearing, redacted from `Debug`), and whether a non-empty
/// environment value shadowed a present file literal.
#[cfg(test)]
pub(crate) struct AgentCredentialResolution {
    pub source: AgentCredentialSource,
    pub value: Option<Zeroizing<String>>,
    pub env_shadows_file: bool,
}

#[cfg(test)]
impl std::fmt::Debug for AgentCredentialResolution {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentCredentialResolution")
            .field("source", &self.source)
            .field("value", &self.value.as_ref().map(|_| "[redacted]"))
            .field("env_shadows_file", &self.env_shadows_file)
            .finish()
    }
}

/// Resolve one provider's effective credential. Pure: the session value and
/// the environment reader are injected so tests stay hermetic. Precedence is
/// session (non-empty) → `api_key_env` (present and non-empty) → literal
/// `api_key` → not configured. Empty strings count as unset at every step;
/// an empty file literal neither wins nor counts as shadowed.
#[cfg(test)]
pub(crate) fn resolve_credential(
    provider: &AgentConfigProvider,
    session_value: Option<&str>,
    env: impl Fn(&str) -> Option<String>,
) -> AgentCredentialResolution {
    let file_literal = provider
        .api_key
        .as_deref()
        .filter(|value| !value.is_empty());
    if let Some(value) = session_value.filter(|value| !value.is_empty()) {
        return AgentCredentialResolution {
            source: AgentCredentialSource::Session,
            value: Some(Zeroizing::new(value.to_string())),
            env_shadows_file: false,
        };
    }
    let environment_value = provider
        .api_key_env
        .as_deref()
        .and_then(&env)
        .filter(|value| !value.is_empty());
    if let Some(value) = environment_value {
        return AgentCredentialResolution {
            source: AgentCredentialSource::Environment,
            value: Some(Zeroizing::new(value)),
            env_shadows_file: file_literal.is_some(),
        };
    }
    if let Some(value) = file_literal {
        return AgentCredentialResolution {
            source: AgentCredentialSource::ConfigFile,
            value: Some(Zeroizing::new(value.to_string())),
            env_shadows_file: false,
        };
    }
    AgentCredentialResolution {
        source: AgentCredentialSource::NotConfigured,
        value: None,
        env_shadows_file: false,
    }
}

/// Every non-empty `api_key_env` name declared in the configuration, sorted
/// and deduplicated, for probe env-scrub derivation (CRED-REVEAL-1A).
#[cfg(test)]
pub(crate) fn declared_api_key_env_names(config: &AgentConfig) -> BTreeSet<String> {
    config
        .providers
        .iter()
        .filter_map(|provider| provider.api_key_env.clone())
        .filter(|name| !name.is_empty())
        .collect()
}

/// Env-scrub predicate: a name is credential-bearing when it is declared as
/// an `api_key_env` in the canonical registry or matches the kernel's
/// generic sensitive-name rules.
#[cfg(test)]
pub(crate) fn is_credential_environment_name(declared: &BTreeSet<String>, name: &str) -> bool {
    declared.contains(name) || rho_kernel::is_sensitive_environment_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    use tempfile::TempDir;

    static CONFIG_ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Tests that mutate process environment serialize against each other
    /// (same idiom as the reveal regression guard in `agent_llm.rs`).
    fn config_env_guard() -> MutexGuard<'static, ()> {
        CONFIG_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn minimal_provider(id: &str) -> AgentConfigProvider {
        AgentConfigProvider {
            id: id.to_string(),
            display_name: id.to_string(),
            kind: "custom".to_string(),
            registered_provider_id: None,
            api_key_env: None,
            api_key_required: false,
            base_url: None,
            base_url_env: None,
            wire_api: None,
            disable_stream_options: None,
            api_key: None,
            extra: BTreeMap::new(),
        }
    }

    fn fixture_config() -> AgentConfig {
        let mut capabilities = BTreeMap::new();
        capabilities.insert(
            "function_call".to_string(),
            AgentConfigCapabilityValue {
                value: "yes".to_string(),
                source: "user".to_string(),
                extra: BTreeMap::new(),
            },
        );
        capabilities.insert(
            "vision_input".to_string(),
            AgentConfigCapabilityValue {
                value: "no".to_string(),
                source: "aisdk_catalog".to_string(),
                extra: BTreeMap::new(),
            },
        );
        let full_provider = AgentConfigProvider {
            id: "provider-deepseek".to_string(),
            display_name: "DeepSeek".to_string(),
            kind: "registered".to_string(),
            registered_provider_id: Some("deepseek".to_string()),
            api_key_env: Some("DEEPSEEK_API_KEY".to_string()),
            api_key_required: true,
            base_url: Some("https://api.deepseek.com/v1".to_string()),
            base_url_env: Some("DEEPSEEK_BASE_URL".to_string()),
            wire_api: Some("chat_completions".to_string()),
            disable_stream_options: Some(true),
            api_key: Some(Zeroizing::new("sk-file-literal".to_string())),
            extra: BTreeMap::new(),
        };
        let full_model = AgentConfigModel {
            id: "model-deepseek-chat".to_string(),
            provider_id: "provider-deepseek".to_string(),
            display_name: "DeepSeek Chat".to_string(),
            model_id: "deepseek-chat".to_string(),
            enabled: true,
            model_type: AgentConfigCapabilityValue {
                value: "language".to_string(),
                source: "aisdk_catalog".to_string(),
                extra: BTreeMap::new(),
            },
            capabilities,
            context_window_tokens: 128_000,
            reserved_output_tokens: 8_000,
            context_capacity_source: "user".to_string(),
            last_test: Some(AgentConfigModelTestResult {
                status: "ok".to_string(),
                checked_at: "2026-08-27T00:00:00Z".to_string(),
                latency_ms: Some(123),
                error_class: None,
                message: Some("connected".to_string()),
                extra: BTreeMap::new(),
            }),
            extra: BTreeMap::new(),
        };
        let minimal_model = AgentConfigModel {
            id: "model-acme-lite".to_string(),
            provider_id: "provider-acme".to_string(),
            display_name: "ACME Lite".to_string(),
            model_id: "acme-lite".to_string(),
            enabled: false,
            model_type: AgentConfigCapabilityValue::default(),
            capabilities: BTreeMap::new(),
            context_window_tokens: 0,
            reserved_output_tokens: 0,
            context_capacity_source: String::new(),
            last_test: None,
            extra: BTreeMap::new(),
        };
        AgentConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            revision: 41,
            providers: vec![full_provider, minimal_provider("provider-acme")],
            models: vec![full_model, minimal_model],
            capability_routes: vec![
                AgentConfigCapabilityRoute {
                    capability: "agent.chat".to_string(),
                    model_id: "model-deepseek-chat".to_string(),
                    model_type: "language".to_string(),
                    required_model_capabilities: Vec::new(),
                    extra: BTreeMap::new(),
                },
                AgentConfigCapabilityRoute {
                    capability: "agent.act".to_string(),
                    model_id: "model-deepseek-chat".to_string(),
                    model_type: "language".to_string(),
                    required_model_capabilities: vec!["function_call".to_string()],
                    extra: BTreeMap::new(),
                },
            ],
            extra: BTreeMap::new(),
        }
    }

    fn write_raw(root: &Path, contents: &str) {
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(config_file_path(root), contents).unwrap();
    }

    #[test]
    fn rho_home_prefers_rho_home_override() {
        let resolved = rho_home_with(
            |name| match name {
                RHO_HOME_ENV => Some(OsString::from("/override/rho-home")),
                XDG_CONFIG_HOME_ENV => Some(OsString::from("/xdg")),
                _ => None,
            },
            || Some(PathBuf::from("/home/alice")),
            // Even when both conventional directories exist, the override wins.
            |_| true,
        );
        assert_eq!(resolved, Some(PathBuf::from("/override/rho-home")));
    }

    #[test]
    fn rho_home_prefers_existing_dot_rho_over_xdg_variant() {
        let resolved = rho_home_with(
            |_| None,
            || Some(PathBuf::from("/home/alice")),
            // Both user-level path styles exist: `~/.rho` is primary.
            |path| {
                path == Path::new("/home/alice/.rho")
                    || path == Path::new("/home/alice/.config/rho")
            },
        );
        assert_eq!(resolved, Some(PathBuf::from("/home/alice/.rho")));
    }

    #[test]
    fn rho_home_uses_existing_xdg_variant_when_dot_rho_is_absent() {
        let resolved = rho_home_with(
            |_| None,
            || Some(PathBuf::from("/home/alice")),
            |path| path == Path::new("/home/alice/.config/rho"),
        );
        assert_eq!(resolved, Some(PathBuf::from("/home/alice/.config/rho")));
        // With XDG_CONFIG_HOME set, the XDG variant is constructed from it.
        let resolved = rho_home_with(
            |name| match name {
                XDG_CONFIG_HOME_ENV => Some(OsString::from("/xdg")),
                _ => None,
            },
            || Some(PathBuf::from("/home/alice")),
            |path| path == Path::new("/xdg/rho") || path == Path::new("/home/alice/.config/rho"),
        );
        assert_eq!(resolved, Some(PathBuf::from("/xdg/rho")));
    }

    #[test]
    fn rho_home_defaults_to_dot_rho_when_nothing_exists() {
        let resolved = rho_home_with(|_| None, || Some(PathBuf::from("/home/alice")), |_| false);
        assert_eq!(resolved, Some(PathBuf::from("/home/alice/.rho")));
        // No home directory at all: truthful None, callers decide policy.
        let resolved = rho_home_with(|_| None, || None, |_| false);
        assert_eq!(resolved, None);
    }

    #[test]
    fn rho_home_treats_empty_environment_values_as_unset() {
        // Empty RHO_HOME falls through to the existence checks.
        let resolved = rho_home_with(
            |name| match name {
                RHO_HOME_ENV => Some(OsString::new()),
                _ => None,
            },
            || Some(PathBuf::from("/home/alice")),
            |path| path == Path::new("/home/alice/.rho"),
        );
        assert_eq!(resolved, Some(PathBuf::from("/home/alice/.rho")));
        // Empty XDG_CONFIG_HOME means the literal `~/.config/rho` variant.
        let resolved = rho_home_with(
            |name| match name {
                RHO_HOME_ENV | XDG_CONFIG_HOME_ENV => Some(OsString::new()),
                _ => None,
            },
            || Some(PathBuf::from("/home/alice")),
            |path| path == Path::new("/home/alice/.config/rho"),
        );
        assert_eq!(resolved, Some(PathBuf::from("/home/alice/.config/rho")));
        // Empty override with nothing existing still defaults to `~/.rho`.
        let resolved = rho_home_with(
            |name| match name {
                RHO_HOME_ENV => Some(OsString::new()),
                _ => None,
            },
            || Some(PathBuf::from("/home/alice")),
            |_| false,
        );
        assert_eq!(resolved, Some(PathBuf::from("/home/alice/.rho")));
    }

    #[test]
    fn rho_home_reads_process_environment() {
        let _serial = config_env_guard();
        let directory = TempDir::new().unwrap();
        let override_home = directory.path().join("override");
        unsafe { std::env::set_var(RHO_HOME_ENV, &override_home) };
        let resolved = rho_home();
        unsafe { std::env::remove_var(RHO_HOME_ENV) };
        assert_eq!(resolved.unwrap(), override_home);
    }

    #[test]
    fn save_and_load_round_trip_covers_every_schema_field() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        save_config(&root, &fixture_config()).unwrap();
        let path = config_file_path(&root);
        let yaml = std::fs::read_to_string(&path).unwrap();
        for field in [
            "schema_version:",
            "revision:",
            "providers:",
            "models:",
            "capability_routes:",
            "id:",
            "display_name:",
            "kind:",
            "registered_provider_id:",
            "api_key_env:",
            "api_key_required:",
            "base_url:",
            "base_url_env:",
            "wire_api:",
            "disable_stream_options:",
            "api_key:",
            "provider_id:",
            "model_id:",
            "enabled:",
            "model_type:",
            "capabilities:",
            "context_window_tokens:",
            "reserved_output_tokens:",
            "context_capacity_source:",
            "last_test:",
            "value:",
            "source:",
            "status:",
            "checked_at:",
            "latency_ms:",
            "message:",
            "capability:",
            "required_model_capabilities:",
        ] {
            assert!(yaml.contains(field), "round-trip YAML is missing {field}");
        }
        // Plaintext at rest is the directed storage mode.
        assert!(yaml.contains("sk-file-literal"));
        // The atomic write leaves nothing but the canonical file behind.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        match load_config(&root) {
            AgentConfigLoad::Loaded(loaded) => {
                assert_eq!(serde_norway::to_string(&loaded).unwrap(), yaml);
                assert_eq!(loaded.revision, 41);
                assert_eq!(loaded.providers.len(), 2);
                assert_eq!(
                    loaded.providers[0]
                        .api_key
                        .as_ref()
                        .map(|value| value.as_str()),
                    Some("sk-file-literal")
                );
                assert_eq!(loaded.models[0].capabilities["function_call"].value, "yes");
                assert_eq!(
                    loaded.capability_routes[1].required_model_capabilities,
                    vec!["function_call".to_string()]
                );
            }
            other => panic!("expected Loaded, got {other:?}"),
        }
    }

    #[test]
    fn save_config_rejects_non_v6_schema_version() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        let mut config = fixture_config();
        config.schema_version = 5;
        assert!(save_config(&root, &config).is_err());
        assert!(!config_file_path(&root).exists());
    }

    #[test]
    fn save_config_propagates_writer_failure_without_leaving_a_file() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        std::fs::create_dir_all(&root).unwrap();
        let result = save_config_with(&root, &fixture_config(), |_, _| {
            Err(anyhow::anyhow!("injected write failure"))
        });
        let error = result.unwrap_err();
        assert!(
            format!("{error:#}").contains("injected write failure"),
            "unexpected error: {error:#}"
        );
        assert!(!config_file_path(&root).exists());
        assert!(matches!(
            load_config(&root),
            AgentConfigLoad::Missing { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn save_config_creates_root_0700_and_file_0600() {
        use std::os::unix::fs::PermissionsExt;
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("nested").join("rho");
        save_config(&root, &fixture_config()).unwrap();
        let root_mode = std::fs::metadata(&root).unwrap().permissions().mode() & 0o777;
        assert_eq!(root_mode, 0o700, "root mode was {root_mode:o}");
        let file_mode = std::fs::metadata(config_file_path(&root))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, 0o600, "file mode was {file_mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn permission_issues_report_loose_modes_without_changing_them() {
        use std::os::unix::fs::PermissionsExt;
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        write_raw(&root, "schema_version: 6\n");
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(
            config_file_path(&root),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let issues = permission_issues(&root);
        assert_eq!(issues.len(), 2, "issues: {issues:?}");
        assert!(issues.iter().any(|issue| {
            issue.subject == ConfigPermissionSubject::RhoHome
                && issue.actual_mode == 0o755
                && issue.expected_mode == 0o700
        }));
        assert!(issues.iter().any(|issue| {
            issue.subject == ConfigPermissionSubject::ConfigFile
                && issue.actual_mode == 0o644
                && issue.expected_mode == 0o600
        }));
        // Report-only by contract: nothing was repaired.
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            std::fs::metadata(config_file_path(&root))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
    }

    #[cfg(unix)]
    #[test]
    fn permission_issues_are_empty_for_hardened_layout() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        save_config(&root, &fixture_config()).unwrap();
        assert!(permission_issues(&root).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn secure_store_rejects_home_and_config_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let directory = TempDir::new().unwrap();
        let target_home = directory.path().join("target-home");
        std::fs::create_dir(&target_home).unwrap();
        let linked_home = directory.path().join("linked-home");
        symlink(&target_home, &linked_home).unwrap();
        assert!(read_config_snapshot(&linked_home).is_err());

        let root = directory.path().join("rho");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let target_config = directory.path().join("outside-config.yaml");
        std::fs::write(&target_config, "schema_version: 6\n").unwrap();
        symlink(&target_config, config_file_path(&root)).unwrap();
        assert!(read_config_snapshot(&root).is_err());
    }

    #[test]
    fn save_config_cas_rejects_a_stale_external_edit_without_overwriting_it() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        save_config(&root, &fixture_config()).unwrap();
        let stale_identity = read_config_snapshot(&root).unwrap().content_identity;

        let mut external = fixture_config();
        external.revision += 1;
        let external_yaml = serde_norway::to_string(&external).unwrap();
        std::fs::write(config_file_path(&root), &external_yaml).unwrap();

        let mut attempted = fixture_config();
        attempted.revision += 2;
        assert!(save_config_cas(&root, &attempted, &stale_identity).is_err());
        assert_eq!(
            std::fs::read_to_string(config_file_path(&root)).unwrap(),
            external_yaml
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn save_config_cas_rechecks_home_mode_immediately_before_commit() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        save_config(&root, &fixture_config()).unwrap();
        let original = std::fs::read(config_file_path(&root)).unwrap();
        let identity = read_config_snapshot(&root).unwrap().content_identity;
        let mut replacement = fixture_config();
        replacement.revision += 1;
        let document = serialize_config(&replacement).unwrap();

        let result = secure_store::write_with_precommit_hook(
            &root,
            document.as_bytes(),
            Some(&identity),
            || {
                std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
            },
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(config_file_path(&root)).unwrap(), original);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn save_config_cas_accepts_the_path_bound_missing_identity() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        let missing_identity = read_config_snapshot(&root).unwrap().content_identity;
        assert!(missing_identity.starts_with(MISSING_CONFIG_IDENTITY));

        let committed = save_config_cas(&root, &fixture_config(), &missing_identity).unwrap();
        assert_eq!(
            committed,
            read_config_snapshot(&root).unwrap().content_identity
        );
    }

    #[cfg(unix)]
    #[test]
    fn repair_permissions_is_content_pinned_and_hardens_opened_objects() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        save_config(&root, &fixture_config()).unwrap();
        let identity = read_config_snapshot(&root).unwrap().content_identity;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(
            config_file_path(&root),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        let remaining = repair_permissions(&root, &config_file_path(&root), &identity).unwrap();
        assert!(remaining.is_empty());
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(config_file_path(&root))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn repair_permissions_rechecks_home_mode_before_reporting_success() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        save_config(&root, &fixture_config()).unwrap();
        let identity = read_config_snapshot(&root).unwrap().content_identity;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(
            config_file_path(&root),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        let result = secure_store::repair_with_prevalidation_hook(&root, &identity, || {
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        });
        assert!(result.is_err());
        assert!(permission_issues(&root).iter().any(|issue| {
            issue.subject == ConfigPermissionSubject::RhoHome && issue.actual_mode == 0o755
        }));
    }

    #[test]
    fn secure_store_rejects_oversized_input_before_yaml_parsing() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        save_config(&root, &fixture_config()).unwrap();
        std::fs::write(config_file_path(&root), vec![b'x'; MAX_CONFIG_BYTES + 1]).unwrap();
        assert!(read_config_snapshot(&root).is_err());
    }

    #[test]
    fn load_reports_missing_file() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        match load_config(&root) {
            AgentConfigLoad::Missing { path } => assert_eq!(path, config_file_path(&root)),
            other => panic!("expected Missing, got {other:?}"),
        }
    }

    #[test]
    fn load_tolerates_unknown_fields() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        write_raw(
            &root,
            "schema_version: 6\n\
             revision: 7\n\
             future_root_field: true\n\
             providers:\n\
             \x20 - id: provider-a\n\
             \x20   display_name: A\n\
             \x20   kind: custom\n\
             \x20   api_key_env: ACME_API_KEY\n\
             \x20   api_key_required: true\n\
             \x20   base_url: https://llm.example.org/v1\n\
             \x20   wire_api: chat_completions\n\
             \x20   future_provider_field: nested\n\
             models: []\n\
             capability_routes: []\n",
        );
        match load_config(&root) {
            AgentConfigLoad::Loaded(config) => {
                assert_eq!(config.revision, 7);
                assert_eq!(config.providers.len(), 1);
                assert_eq!(config.providers[0].id, "provider-a");
                assert_eq!(
                    config.providers[0].api_key_env.as_deref(),
                    Some("ACME_API_KEY")
                );
                assert!(config.providers[0].api_key.is_none());
            }
            other => panic!("expected Loaded, got {other:?}"),
        }
    }

    #[test]
    fn load_rejects_other_schema_versions() {
        let directory = TempDir::new().unwrap();
        for version in [0_u32, 5, 7] {
            let root = directory.path().join(format!("v{version}"));
            write_raw(&root, &format!("schema_version: {version}\n"));
            match load_config(&root) {
                AgentConfigLoad::UnsupportedSchemaVersion { found, .. } => {
                    assert_eq!(found, u64::from(version));
                }
                other => panic!("expected UnsupportedSchemaVersion for {version}, got {other:?}"),
            }
        }
    }

    #[test]
    fn load_reports_missing_schema_version_as_malformed() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        write_raw(&root, "revision: 1\nproviders: []\n");
        match load_config(&root) {
            AgentConfigLoad::Malformed { reason, .. } => {
                assert!(reason.contains("schema_version"), "reason: {reason}");
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn load_reports_malformed_yaml_without_leaking_contents() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().join("rho");
        write_raw(&root, "schema_version: 6\nproviders: [sk-onering-secret\n");
        match load_config(&root) {
            AgentConfigLoad::Malformed { reason, .. } => {
                assert!(
                    !reason.contains("sk-onering-secret"),
                    "reason leaked file contents: {reason}"
                );
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
        // A well-formed YAML document of the wrong shape is malformed too.
        let root = directory.path().join("scalar");
        write_raw(&root, "- just\n- a\n- list\n");
        assert!(matches!(
            load_config(&root),
            AgentConfigLoad::Malformed { .. }
        ));
    }

    #[test]
    fn load_reports_empty_file_as_malformed() {
        let directory = TempDir::new().unwrap();
        for (name, contents) in [("empty", ""), ("blank", "  \n\t\n")] {
            let root = directory.path().join(name);
            write_raw(&root, contents);
            match load_config(&root) {
                AgentConfigLoad::Malformed { reason, .. } => {
                    assert!(reason.contains("empty"), "reason: {reason}");
                }
                other => panic!("expected Malformed for {name}, got {other:?}"),
            }
        }
    }

    fn resolution_provider() -> AgentConfigProvider {
        AgentConfigProvider {
            api_key_env: Some("ACME_API_KEY".to_string()),
            api_key: Some(Zeroizing::new("file-key".to_string())),
            ..minimal_provider("provider-acme")
        }
    }

    #[test]
    fn credential_resolution_session_wins_over_environment_and_file() {
        let resolution = resolve_credential(&resolution_provider(), Some("session-key"), |_| {
            Some("env-key".to_string())
        });
        assert_eq!(resolution.source, AgentCredentialSource::Session);
        assert_eq!(
            resolution.value.as_ref().map(|value| value.as_str()),
            Some("session-key")
        );
        assert!(!resolution.env_shadows_file);
    }

    #[test]
    fn credential_resolution_environment_wins_over_file_and_shadows_it() {
        let resolution = resolve_credential(&resolution_provider(), None, |_| {
            Some("env-key".to_string())
        });
        assert_eq!(resolution.source, AgentCredentialSource::Environment);
        assert_eq!(
            resolution.value.as_ref().map(|value| value.as_str()),
            Some("env-key")
        );
        assert!(resolution.env_shadows_file);
    }

    #[test]
    fn credential_resolution_environment_without_file_literal_does_not_shadow() {
        let provider = AgentConfigProvider {
            api_key: None,
            ..resolution_provider()
        };
        let resolution = resolve_credential(&provider, None, |_| Some("env-key".to_string()));
        assert_eq!(resolution.source, AgentCredentialSource::Environment);
        assert!(!resolution.env_shadows_file);
    }

    #[test]
    fn credential_resolution_file_literal_wins_when_nothing_else_exists() {
        let resolution = resolve_credential(&resolution_provider(), None, |_| None);
        assert_eq!(resolution.source, AgentCredentialSource::ConfigFile);
        assert_eq!(
            resolution.value.as_ref().map(|value| value.as_str()),
            Some("file-key")
        );
        assert!(!resolution.env_shadows_file);
    }

    #[test]
    fn credential_resolution_reports_not_configured_without_any_source() {
        let provider = AgentConfigProvider {
            api_key: None,
            ..resolution_provider()
        };
        let resolution = resolve_credential(&provider, None, |_| None);
        assert_eq!(resolution.source, AgentCredentialSource::NotConfigured);
        assert!(resolution.value.is_none());
        assert!(!resolution.env_shadows_file);
    }

    #[test]
    fn credential_resolution_treats_empty_environment_as_unset() {
        let resolution = resolve_credential(&resolution_provider(), None, |_| Some(String::new()));
        assert_eq!(resolution.source, AgentCredentialSource::ConfigFile);
        assert!(!resolution.env_shadows_file);
        let provider = AgentConfigProvider {
            api_key: None,
            ..resolution_provider()
        };
        let resolution = resolve_credential(&provider, None, |_| Some(String::new()));
        assert_eq!(resolution.source, AgentCredentialSource::NotConfigured);
    }

    #[test]
    fn credential_resolution_treats_empty_session_value_as_unset() {
        let resolution = resolve_credential(&resolution_provider(), Some(""), |_| None);
        assert_eq!(resolution.source, AgentCredentialSource::ConfigFile);
        assert_eq!(
            resolution.value.as_ref().map(|value| value.as_str()),
            Some("file-key")
        );
    }

    #[test]
    fn credential_resolution_never_reads_env_without_declared_name() {
        let provider = AgentConfigProvider {
            api_key_env: None,
            ..resolution_provider()
        };
        let resolution = resolve_credential(&provider, None, |_| {
            panic!("environment read without a declared api_key_env")
        });
        assert_eq!(resolution.source, AgentCredentialSource::ConfigFile);
    }

    #[test]
    fn scrub_derivation_collects_declared_names_and_combines_predicates() {
        let mut config = fixture_config();
        config.providers.push(AgentConfigProvider {
            api_key_env: Some(String::new()),
            ..minimal_provider("provider-empty-env")
        });
        config.providers.push(AgentConfigProvider {
            api_key_env: Some("ACME_CUSTOM_KEY".to_string()),
            ..minimal_provider("provider-custom")
        });
        config.providers.push(AgentConfigProvider {
            api_key_env: Some("DEEPSEEK_API_KEY".to_string()),
            ..minimal_provider("provider-duplicate")
        });
        let declared = declared_api_key_env_names(&config);
        assert_eq!(
            declared,
            BTreeSet::from([
                "ACME_CUSTOM_KEY".to_string(),
                "DEEPSEEK_API_KEY".to_string(),
            ])
        );
        // Declared names are scrubbed even without a sensitive shape.
        assert!(is_credential_environment_name(&declared, "ACME_CUSTOM_KEY"));
        // Kernel generic and named sensitive rules still apply.
        assert!(is_credential_environment_name(&declared, "OPENAI_API_KEY"));
        assert!(is_credential_environment_name(&declared, "GITHUB_TOKEN"));
        assert!(!is_credential_environment_name(&declared, "PATH"));
        assert!(!is_credential_environment_name(&declared, "ACME_BASE_URL"));
    }

    #[test]
    fn debug_output_never_contains_secret_values() {
        let provider = resolution_provider();
        let rendered = format!("{provider:?}");
        assert!(!rendered.contains("file-key"), "provider Debug: {rendered}");
        assert!(rendered.contains("[redacted]"));
        let resolution = resolve_credential(&provider, None, |_| Some("env-secret".to_string()));
        let rendered = format!("{resolution:?}");
        assert!(
            !rendered.contains("env-secret"),
            "resolution Debug: {rendered}"
        );
        assert!(
            !rendered.contains("file-key"),
            "resolution Debug: {rendered}"
        );
        let config = fixture_config();
        let rendered = format!("{config:?}");
        assert!(
            !rendered.contains("sk-file-literal"),
            "config Debug: {rendered}"
        );
    }
}
