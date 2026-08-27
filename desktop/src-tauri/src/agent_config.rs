//! COMPAT-1A: plaintext canonical model configuration store (schema V6).
//!
//! Owning contract:
//! `docs/plans/active-2026-08-27-compat-1-plaintext-config-store-spec.md`
//! (umbrella: `proposed-2026-08-27-rho-model-config-and-agent-compat-layer-spec.md`,
//! revision 3).
//!
//! This module is the V6 plaintext successor to the V5 app-data
//! `llm-profiles.json` store in `agent_llm.rs`. COMPAT-1A ships the module
//! and its in-module tests only, wired as a private submodule so no
//! shared-authority path changes; the COMPAT-1B cutover (integration lane)
//! points turns, connection tests, and Settings at this store and deletes
//! the V1–V5 schema and vault code.
//!
//! Recorded decisions for this slice:
//!
//! - YAML crate: `serde_norway` (0.9.42), the community-maintained
//!   API-compatible fork of the archived `serde_yaml`. The contract's first
//!   choice `serde_yml` proved unusable for this crate: its 0.0.13 release is
//!   a self-declared unmaintained deprecation shim over `noyalib` whose every
//!   re-exported item is `#[deprecated]`, so each call site would emit a
//!   warning and fail this workspace's zero-new-warnings gate. Only this
//!   module imports the YAML crate, so any later swap stays local to this
//!   file.
//! - Rho home, two user-level path styles (owner direction 2026-08-27,
//!   following the codex / claude code / opencode dot-directory convention):
//!   `~/.rho` is the primary, extensible Rho home that will later hold more
//!   than configuration, while a pre-existing XDG-style `${XDG_CONFIG_HOME}/rho`
//!   (or literal `~/.config/rho` when `XDG_CONFIG_HOME` is unset) is honored
//!   when it already exists. `RHO_HOME` overrides both; when neither
//!   directory exists the default is `~/.rho`, created on first write. The
//!   home is never created at resolution time — only `save_config` creates
//!   directories.
//! - "Preferences" in the contract's content-model list: V5 persists no
//!   standalone preferences section. The selected-model preference is the
//!   `agent.chat` capability route (`AgentLlmSettingsView` documents the
//!   route as the persisted authority), so the V6 schema carries it
//!   unchanged inside `capability_routes` and no new section is invented.
//! - The V5 `credential_source` provider field is deliberately dropped: the
//!   owner's plaintext direction replaces stored source metadata with pure
//!   presence-based resolution (session → environment → file literal), so
//!   the field could only contradict the resolver.
//! - Load reasons and error contexts never include file contents. The file
//!   is plaintext and may hold credentials, so reasons carry only I/O
//!   diagnostics or parser locations, never parser messages that can embed
//!   offending values. This keeps the redaction boundary identical to
//!   `agent_llm.rs` even though the on-disk file is readable.

// COMPAT-1A is deliberately unwired: outside tests nothing calls this module
// yet. The COMPAT-1B cutover consumes the API and drops this allowance.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::project::atomic_write;

/// Schema marker written to and required from `config.yaml`.
pub(crate) const CONFIG_SCHEMA_VERSION: u32 = 6;
/// Canonical file name inside the Rho home.
pub(crate) const CONFIG_FILE_NAME: &str = "config.yaml";
/// Environment override for the Rho home.
pub(crate) const RHO_HOME_ENV: &str = "RHO_HOME";
/// freedesktop base used to construct the XDG-style variant
/// (`${XDG_CONFIG_HOME}/rho`, or `~/.config/rho` when unset).
pub(crate) const XDG_CONFIG_HOME_ENV: &str = "XDG_CONFIG_HOME";
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
pub(crate) fn rho_home() -> Option<PathBuf> {
    rho_home_with(
        |name| std::env::var_os(name),
        dirs::home_dir,
        |path| path.exists(),
    )
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
}

/// One provider entry. `api_key` is the optional plaintext literal; it is
/// held in `Zeroizing<String>` and redacted from `Debug` output.
#[derive(Clone, Serialize, Deserialize)]
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
}

/// Capability value plus its provenance, identical to the V5 shape.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AgentConfigCapabilityValue {
    pub value: String,
    #[serde(default)]
    pub source: String,
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
    /// is attempted in this slice.
    UnsupportedSchemaVersion { path: PathBuf, found: u64 },
    /// The file is unreadable, empty, oversized, not valid YAML, missing a
    /// numeric `schema_version`, or shaped unlike the V6 schema.
    Malformed { path: PathBuf, reason: String },
}

/// Load `config.yaml` from a resolved Rho home, reporting the truthful
/// outcome.
pub(crate) fn load_config(home: &Path) -> AgentConfigLoad {
    let path = config_file_path(home);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return AgentConfigLoad::Missing { path };
        }
        Err(error) => {
            return AgentConfigLoad::Malformed {
                path,
                reason: format!("the file could not be read: {error}"),
            };
        }
    };
    parse_config_bytes(&path, &bytes)
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

/// Write the configuration atomically: the resolved Rho home is created
/// `0700` when missing (never re-chmodded when it already exists), the file
/// is written via the crate's write-temp-then-rename helper and hardened to
/// `0600` on unix (best-effort elsewhere).
pub(crate) fn save_config(home: &Path, config: &AgentConfig) -> Result<()> {
    ensure_rho_home(home)?;
    save_config_with(home, config, |path, bytes| atomic_write(path, bytes))?;
    harden_config_file_permissions(&config_file_path(home))?;
    Ok(())
}

/// Serialize-and-write core with the writer injected, mirroring the
/// `save_settings_with` failure-injection idiom in `agent_llm.rs`.
fn save_config_with<F>(home: &Path, config: &AgentConfig, mut write: F) -> Result<()>
where
    F: FnMut(&Path, &[u8]) -> Result<()>,
{
    ensure!(
        config.schema_version == CONFIG_SCHEMA_VERSION,
        "Refusing to write a model configuration with schema_version {} (expected {CONFIG_SCHEMA_VERSION}).",
        config.schema_version
    );
    let path = config_file_path(home);
    let document = serde_norway::to_string(config)
        .with_context(|| format!("serializing the model configuration {}", path.display()))?;
    ensure!(
        document.len() <= MAX_CONFIG_BYTES,
        "The model configuration exceeds the {} KiB limit.",
        MAX_CONFIG_BYTES / 1024
    );
    write(&path, document.as_bytes())
        .with_context(|| format!("writing the model configuration {}", path.display()))
}

/// Create the Rho home (and missing parents) `0700` on unix. An existing
/// directory is left untouched: pre-existing loose permissions are reported
/// by [`permission_issues`], never silently repaired.
fn ensure_rho_home(home: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(home)
            .with_context(|| format!("creating the Rho home {}", home.display()))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(home)
            .with_context(|| format!("creating the Rho home {}", home.display()))
    }
}

#[cfg(unix)]
fn harden_config_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("hardening the model configuration {}", path.display()))
}

#[cfg(not(unix))]
fn harden_config_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

/// Which file object's permissions are being reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfigPermissionSubject {
    RhoHome,
    ConfigFile,
}

/// One loose-permissions finding: the object, its actual mode, and the mode
/// Rho uses for objects it creates. Report-only by contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigPermissionIssue {
    pub subject: ConfigPermissionSubject,
    pub path: PathBuf,
    pub actual_mode: u32,
    pub expected_mode: u32,
}

/// Report pre-existing loose permissions on the resolved Rho home and the
/// configuration file without changing anything. Missing objects and objects
/// that cannot be stat'ed produce no finding; non-unix platforms report
/// nothing (hardening there is best-effort at write time).
#[cfg(unix)]
pub(crate) fn permission_issues(home: &Path) -> Vec<ConfigPermissionIssue> {
    use std::os::unix::fs::PermissionsExt;
    let mut issues = Vec::new();
    let mut inspect = |subject: ConfigPermissionSubject, path: &Path, expected_mode: u32| {
        if let Ok(metadata) = std::fs::metadata(path) {
            let actual_mode = metadata.permissions().mode() & 0o777;
            if actual_mode & 0o077 != 0 {
                issues.push(ConfigPermissionIssue {
                    subject,
                    path: path.to_path_buf(),
                    actual_mode,
                    expected_mode,
                });
            }
        }
    };
    inspect(ConfigPermissionSubject::RhoHome, home, 0o700);
    inspect(
        ConfigPermissionSubject::ConfigFile,
        &config_file_path(home),
        0o600,
    );
    issues
}

#[cfg(not(unix))]
pub(crate) fn permission_issues(_home: &Path) -> Vec<ConfigPermissionIssue> {
    Vec::new()
}

/// Effective credential source for a provider, per the owner's precedence
/// ruling (session → environment → config-file literal → not configured).
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
pub(crate) struct AgentCredentialResolution {
    pub source: AgentCredentialSource,
    pub value: Option<Zeroizing<String>>,
    pub env_shadows_file: bool,
}

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
        }
    }

    fn fixture_config() -> AgentConfig {
        let mut capabilities = BTreeMap::new();
        capabilities.insert(
            "function_call".to_string(),
            AgentConfigCapabilityValue {
                value: "yes".to_string(),
                source: "user".to_string(),
            },
        );
        capabilities.insert(
            "vision_input".to_string(),
            AgentConfigCapabilityValue {
                value: "no".to_string(),
                source: "aisdk_catalog".to_string(),
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
            }),
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
                },
                AgentConfigCapabilityRoute {
                    capability: "agent.act".to_string(),
                    model_id: "model-deepseek-chat".to_string(),
                    model_type: "language".to_string(),
                    required_model_capabilities: vec!["function_call".to_string()],
                },
            ],
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
        assert_eq!(resolved, Some(override_home));
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
