use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use chrono::Utc;
use rho_server::coordinator::{AgentRuntimeCapabilityRoute, AgentRuntimeModelProfile};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::project::atomic_write;

// Plaintext YAML model-configuration parser and file I/O. Runtime settings
// are implemented in this module; the helpers have no production call sites.
#[path = "agent_config.rs"]
pub(crate) mod agent_config;
#[path = "agent_config_environ.rs"]
mod agent_config_environ;

const SETTINGS_SCHEMA_VERSION: u32 = agent_config::CONFIG_SCHEMA_VERSION;
const MAX_ID_LENGTH: usize = 120;
const MAX_NAME_LENGTH: usize = 160;
const MAX_MODEL_ID_LENGTH: usize = 240;
const MAX_URL_LENGTH: usize = 512;
const MAX_CAPABILITY_NAME_LENGTH: usize = 80;
const MAX_CAPABILITY_ROUTES: usize = 32;
const MAX_REQUIRED_CAPABILITIES: usize = 16;
const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(30);
const MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_MODEL_DISCOVERY_BYTES: usize = 1024 * 1024;
const MAX_DISCOVERED_MODELS: usize = 100;
const MAX_R_PROBE_STDOUT_BYTES: usize = 1024 * 1024;
const MAX_R_PROBE_STDERR_BYTES: usize = 64 * 1024;
#[cfg(unix)]
const R_PROBE_TERMINATION_GRACE: Duration = Duration::from_millis(250);
const R_PROBE_PIPE_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
const CONNECTION_TEST_PROCESS_FAILURE: &str =
    "Rho could not complete the Provider connection test.";
const CONNECTION_TEST_PROTOCOL_FAILURE: &str =
    "Rho received an invalid Provider connection-test response.";
const CONNECTION_TEST_TIMEOUT_FAILURE: &str = "The Provider connection test timed out.";
const CONNECTION_TEST_CANCELLED: &str = "Agent model test cancelled.";
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_CREDENTIAL_BYTES: usize = 4_096;
const MAX_CREDENTIAL_BYTES_LABEL: &str = "4096-byte";
const CREDENTIAL_AUDIT_FILE_NAME: &str = "agent-credential-audit.jsonl";
const CREDENTIAL_AUDIT_LOCK_FILE_NAME: &str = "agent-credential-audit.lock";
const MAX_CREDENTIAL_AUDIT_BYTES: usize = 256 * 1024;
const CREDENTIAL_AUDIT_KEEP_BYTES: usize = 128 * 1024;
const MAX_CREDENTIAL_AUDIT_RECOVERY_BYTES: usize = 4 * 1024 * 1024;
const MAX_CREDENTIAL_AUDIT_ROW_BYTES: usize = 8 * 1024;

static SETTINGS_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CREDENTIAL_SESSION: OnceLock<CredentialSession> = OnceLock::new();
static CONFIG_SNAPSHOTS: OnceLock<Mutex<HashMap<String, ConfigSnapshotRecord>>> = OnceLock::new();

fn settings_mutation_guard() -> MutexGuard<'static, ()> {
    SETTINGS_MUTATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn after_settings_mutation<T>(
    guard: MutexGuard<'_, ()>,
    refresh: impl FnOnce() -> Result<T>,
) -> Result<T> {
    drop(guard);
    refresh()
}

trait CredentialStore {
    fn get(&self, provider_id: &str) -> Result<Option<Zeroizing<String>>>;
}

#[derive(Debug, Clone, Copy)]
struct ConfigCredentialStore<'a> {
    config: &'a agent_config::AgentConfig,
}

impl<'a> ConfigCredentialStore<'a> {
    fn from_config(config: &'a agent_config::AgentConfig) -> Self {
        Self { config }
    }
}

#[derive(Default)]
struct CredentialSession {
    /// Session-only credentials (CRED-SEC2). These are never written to any
    /// durable store and are dropped by explicit delete or app shutdown.
    session_only: Mutex<HashMap<String, Zeroizing<String>>>,
}

impl CredentialSession {
    fn has_session_credential(&self, provider_id: &str) -> bool {
        self.session_only
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(provider_id)
    }

    fn session_credential_zeroizing(&self, provider_id: &str) -> Option<Zeroizing<String>> {
        self.session_only
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(provider_id)
            .map(|credential| Zeroizing::new(credential.as_str().to_string()))
    }

    fn set_session_credential(&self, provider_id: &str, credential: &str) {
        self.session_only
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                provider_id.to_string(),
                Zeroizing::new(credential.to_string()),
            );
    }

    fn clear_session_credential(&self, provider_id: &str) {
        self.session_only
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(provider_id);
    }

    fn clear(&self) {
        self.session_only
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}

fn credential_session() -> &'static CredentialSession {
    CREDENTIAL_SESSION.get_or_init(CredentialSession::default)
}

impl CredentialStore for ConfigCredentialStore<'_> {
    fn get(&self, provider_id: &str) -> Result<Option<Zeroizing<String>>> {
        Ok(self
            .config
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .and_then(|provider| provider.api_key.as_deref())
            .filter(|value| !value.is_empty())
            .map(|value| Zeroizing::new(value.to_string())))
    }
}

const CREDENTIAL_SOURCE_CONFIG_FILE: &str = "config_file";
const CREDENTIAL_SOURCE_ENVIRONMENT: &str = "environment";
const CREDENTIAL_SOURCE_SESSION: &str = "session";
const CREDENTIAL_SOURCE_NOT_CONFIGURED: &str = "not_configured";

fn resolve_provider_credential_with_runtime(
    settings: &AgentLlmSettings,
    provider: &AgentProviderProfile,
    credential_store: &impl CredentialStore,
    rscript: Option<&Path>,
    r_environ_user: Option<&Path>,
) -> Result<(Option<Zeroizing<String>>, &'static str)> {
    validate_settings(settings)?;
    if let Some(value) = credential_session().session_credential_zeroizing(&provider.id) {
        validate_resolved_credential(value.as_str())?;
        return Ok((Some(value), CREDENTIAL_SOURCE_SESSION));
    }
    if let Some(value) = environment_credential(provider)? {
        validate_resolved_credential(&value)?;
        return Ok((Some(value), CREDENTIAL_SOURCE_ENVIRONMENT));
    }
    if let (Some(rscript), Some(r_environ_user), Some(variable)) =
        (rscript, r_environ_user, provider.api_key_env.as_deref())
    {
        let declared_sensitive_names = settings
            .providers
            .iter()
            .filter_map(|provider| provider.api_key_env.clone())
            .filter(|name| !name.is_empty())
            .collect::<std::collections::BTreeSet<_>>();
        if let Some(value) = agent_config_environ::read_user_environ_credential(
            rscript,
            r_environ_user,
            variable,
            &declared_sensitive_names,
        )? {
            validate_resolved_credential(value.as_str())?;
            return Ok((Some(value), CREDENTIAL_SOURCE_ENVIRONMENT));
        }
    }
    Ok(match credential_store.get(&provider.id)? {
        Some(value) => {
            validate_resolved_credential(&value)?;
            (Some(value), CREDENTIAL_SOURCE_CONFIG_FILE)
        }
        None => (None, CREDENTIAL_SOURCE_NOT_CONFIGURED),
    })
}

fn validate_resolved_credential(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= MAX_CREDENTIAL_BYTES
            && !value.chars().any(char::is_control),
        "The resolved Provider credential is invalid."
    );
    Ok(())
}

fn environment_credential(provider: &AgentProviderProfile) -> Result<Option<Zeroizing<String>>> {
    let Some(name) = provider.api_key_env.as_deref() else {
        return Ok(None);
    };
    // `std::env::var` panics for names containing `=` or NUL. Keep that API
    // behind the same validation boundary as every execution entry point so a
    // syntactically valid but semantically invalid config.yaml remains an
    // ordinary configuration error.
    validate_env_name(Some(name), provider.api_key_required)?;
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(Some(Zeroizing::new(value))),
        Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            bail!("The environment variable {name} does not contain valid UTF-8.")
        }
    }
}

fn environment_credential_present(provider: &AgentProviderProfile) -> bool {
    let Some(name) = provider.api_key_env.as_deref() else {
        return false;
    };
    if validate_env_name(Some(name), provider.api_key_required).is_err() {
        return false;
    }
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

fn credential_audit_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CREDENTIAL_AUDIT_FILE_NAME)
}

/// CRED-SEC4: append one redacted credential-access event. The event never
/// contains credential values, lengths, prefixes, suffixes, or environment
/// contents. An audit failure never blocks the credential operation; it is
/// recorded in the startup log instead.
fn record_credential_audit(
    data_dir: &Path,
    event: &str,
    provider_id: &str,
    source: &str,
    outcome: &str,
    detail: Option<&str>,
) {
    if let Err(error) =
        append_credential_audit(data_dir, event, provider_id, source, outcome, detail)
    {
        let _ = error;
        crate::startup_runtime::write_startup_log(
            "agent_llm_credential_audit outcome=failed detail=redacted",
        );
    }
}

fn append_credential_audit(
    data_dir: &Path,
    event: &str,
    provider_id: &str,
    source: &str,
    outcome: &str,
    detail: Option<&str>,
) -> Result<()> {
    let _audit_guard = reveal_audit_guard();
    let _process_guard = CrossProcessAuditLock::acquire(data_dir)?;
    append_credential_audit_locked(data_dir, event, provider_id, source, outcome, detail)
}

fn append_credential_audit_locked(
    data_dir: &Path,
    event: &str,
    provider_id: &str,
    source: &str,
    outcome: &str,
    detail: Option<&str>,
) -> Result<()> {
    let line = serde_json::to_string(&serde_json::json!({
        "recorded_at": Utc::now().to_rfc3339(),
        "event": event,
        "provider_id": provider_id,
        "credential_source": source,
        "outcome": outcome,
        "detail": detail,
        "config_schema_version": (event == "config_store_adopted")
            .then_some(agent_config::CONFIG_SCHEMA_VERSION),
    }))?;
    ensure!(
        line.len() + 1 <= MAX_CREDENTIAL_AUDIT_ROW_BYTES,
        "The redacted credential audit row exceeds its bounded size."
    );
    let path = credential_audit_path(data_dir);
    let mut bytes = read_credential_audit_bounded(&path)?;
    bytes.extend_from_slice(line.as_bytes());
    bytes.push(b'\n');
    rotate_credential_audit_bytes(&mut bytes)?;
    atomic_write(&path, &bytes)
        .with_context(|| format!("writing the credential audit log {}", path.display()))
}

fn record_config_store_adopted(data_dir: &Path, config_path: &Path) {
    let _audit_guard = reveal_audit_guard();
    let _process_guard = match CrossProcessAuditLock::acquire(data_dir) {
        Ok(guard) => guard,
        Err(_error) => {
            crate::startup_runtime::write_startup_log(
                "agent_config_store_adopted outcome=failed detail=redacted",
            );
            return;
        }
    };
    let audit_path = credential_audit_path(data_dir);
    let retained = match read_credential_audit_bounded(&audit_path) {
        Ok(bytes) => bytes,
        Err(_error) => {
            crate::startup_runtime::write_startup_log(
                "agent_config_store_adopted outcome=failed detail=redacted",
            );
            return;
        }
    };
    let exact_path = match normalized_config_adoption_identity(config_path) {
        Ok(path) => path,
        Err(_error) => {
            crate::startup_runtime::write_startup_log(
                "agent_config_store_adopted outcome=failed detail=redacted",
            );
            return;
        }
    };
    let already_recorded = retained
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_slice::<serde_json::Value>(line).ok())
        .any(|row| {
            row.get("event").and_then(serde_json::Value::as_str) == Some("config_store_adopted")
                && row.get("detail").and_then(serde_json::Value::as_str)
                    == Some(exact_path.as_str())
        });
    if !already_recorded
        && let Err(error) = append_credential_audit_locked(
            data_dir,
            "config_store_adopted",
            "",
            CREDENTIAL_SOURCE_CONFIG_FILE,
            "ok",
            Some(&exact_path),
        )
    {
        let _ = error;
        crate::startup_runtime::write_startup_log(
            "agent_config_store_adopted outcome=failed detail=redacted",
        );
    }
}

struct CrossProcessAuditLock {
    file: std::fs::File,
}

#[cfg(windows)]
#[repr(C)]
struct AuditOverlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: *mut std::ffi::c_void,
}

#[cfg(windows)]
impl AuditOverlapped {
    fn zeroed() -> Self {
        Self {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: std::ptr::null_mut(),
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LockFileEx(
        file: *mut std::ffi::c_void,
        flags: u32,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut AuditOverlapped,
    ) -> i32;
    fn UnlockFileEx(
        file: *mut std::ffi::c_void,
        reserved: u32,
        bytes_low: u32,
        bytes_high: u32,
        overlapped: *mut AuditOverlapped,
    ) -> i32;
}

impl CrossProcessAuditLock {
    fn acquire(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("creating the credential audit directory")?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(data_dir.join(CREDENTIAL_AUDIT_LOCK_FILE_NAME))
            .context("opening the credential audit lock")?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            loop {
                let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
                if result == 0 {
                    break;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(anyhow::Error::new(error))
                        .context("locking the credential audit journal");
                }
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x0000_0002;
            let mut overlapped = AuditOverlapped::zeroed();
            let result = unsafe {
                LockFileEx(
                    file.as_raw_handle(),
                    LOCKFILE_EXCLUSIVE_LOCK,
                    0,
                    u32::MAX,
                    u32::MAX,
                    &mut overlapped,
                )
            };
            if result == 0 {
                return Err(anyhow::Error::new(io::Error::last_os_error()))
                    .context("locking the credential audit journal");
            }
        }
        Ok(Self { file })
    }
}

impl Drop for CrossProcessAuditLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mut overlapped = AuditOverlapped::zeroed();
            let _ = unsafe {
                UnlockFileEx(
                    self.file.as_raw_handle(),
                    0,
                    u32::MAX,
                    u32::MAX,
                    &mut overlapped,
                )
            };
        }
    }
}

fn read_credential_audit_bounded(path: &Path) -> Result<Vec<u8>> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(anyhow::Error::new(error)).context("inspecting audit journal"),
    };
    ensure!(
        metadata.is_file(),
        "The credential audit journal is not a file."
    );
    let byte_len = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    ensure!(
        byte_len <= MAX_CREDENTIAL_AUDIT_RECOVERY_BYTES,
        "The credential audit journal exceeds its bounded recovery size."
    );
    let file = std::fs::File::open(path).context("opening audit journal")?;
    let mut bytes = Vec::with_capacity(byte_len.min(MAX_CREDENTIAL_AUDIT_BYTES));
    file.take((MAX_CREDENTIAL_AUDIT_RECOVERY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .context("reading audit journal")?;
    ensure!(
        bytes.len() <= MAX_CREDENTIAL_AUDIT_RECOVERY_BYTES,
        "The credential audit journal changed beyond its bounded recovery size."
    );

    // Drop corrupt/partial rows while retaining every valid historical
    // adoption identity. This is bounded recovery, never an unbounded whole-
    // journal allocation.
    let mut recovered = Vec::with_capacity(bytes.len().min(MAX_CREDENTIAL_AUDIT_BYTES));
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        if line.len() > MAX_CREDENTIAL_AUDIT_ROW_BYTES
            || serde_json::from_slice::<serde_json::Value>(line).is_err()
        {
            continue;
        }
        recovered.extend_from_slice(line);
        recovered.push(b'\n');
    }
    Ok(recovered)
}

fn normalized_config_adoption_identity(path: &Path) -> Result<String> {
    ensure!(
        path.is_absolute(),
        "The adopted configuration path is not absolute."
    );
    ensure!(
        !path.components().any(|component| matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )),
        "The adopted configuration path is not normalized."
    );
    Ok(path.as_os_str().to_string_lossy().into_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentLlmSettings {
    pub schema_version: u32,
    pub revision: u64,
    pub providers: Vec<AgentProviderProfile>,
    pub models: Vec<AgentModelProfile>,
    pub capability_routes: Vec<AgentCapabilityRoute>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentProviderProfile {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub registered_provider_id: Option<String>,
    pub api_key_env: Option<String>,
    pub api_key_required: bool,
    pub base_url: Option<String>,
    pub base_url_env: Option<String>,
    pub wire_api: Option<String>,
    pub disable_stream_options: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentModelProfile {
    pub id: String,
    pub provider_id: String,
    pub display_name: String,
    pub model_id: String,
    pub enabled: bool,
    pub model_type: AgentCapabilityValue,
    pub capabilities: BTreeMap<String, AgentCapabilityValue>,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub context_window_tokens: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub reserved_output_tokens: u64,
    pub context_capacity_source: String,
    pub last_test: Option<AgentModelTestResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConnectionCapabilities {
    pub tool_calling: String,
    pub reasoning: String,
    pub vision_input: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentCapabilityValue {
    pub value: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentCapabilityRoute {
    pub capability: String,
    pub model_id: String,
    pub model_type: String,
    pub required_model_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentModelCapabilityPatch {
    pub model_type: Option<String>,
    #[serde(default)]
    pub capabilities: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentModelTestResult {
    pub status: String,
    pub checked_at: String,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    pub latency_ms: Option<u64>,
    pub error_class: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConnectionTestResponse {
    pub status: String,
    pub credential_status: String,
    pub model_resolved: bool,
    pub latency_ms: Option<u64>,
    pub capabilities: AgentConnectionCapabilities,
    pub message: String,
    pub error_class: Option<String>,
}

struct SecretString(String);

impl std::fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl SecretString {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgentConnectionCapabilities {
    tool_calling: SecretString,
    reasoning: SecretString,
    vision_input: SecretString,
    source: SecretString,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAgentConnectionTestResponse {
    status: SecretString,
    credential_status: SecretString,
    model_resolved: bool,
    latency_ms: Option<u64>,
    capabilities: RawAgentConnectionCapabilities,
    #[serde(rename = "message")]
    _message: serde::de::IgnoredAny,
    error_class: Option<SecretString>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentCatalogEntry {
    pub provider: String,
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub model_type: AgentCapabilityValue,
    pub capabilities: BTreeMap<String, AgentCapabilityValue>,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    pub context_window_tokens: Option<u64>,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentDiscoveredModel {
    pub id: String,
    pub display_name: String,
    pub model_type: AgentCapabilityValue,
    pub capabilities: BTreeMap<String, AgentCapabilityValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentModelDiscoveryResponse {
    pub status: String,
    pub provider_id: String,
    pub models: Vec<AgentDiscoveredModel>,
    pub truncated: bool,
    pub message: String,
    pub error_class: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AgentUserEnvironInfo {
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AgentProviderProfileView {
    #[serde(flatten)]
    pub profile: AgentProviderProfile,
    pub credential_status: String,
    /// Presentation-only description of the effective presence-based source.
    pub credential_effective_source: String,
    pub env_shadows_file: bool,
    pub session_credential_present: bool,
    pub config_file_credential_present: bool,
    /// Resolved endpoint shown in Settings. Reviewed Provider defaults are
    /// projected explicitly instead of appearing as an unexplained blank.
    pub effective_base_url: Option<String>,
    pub base_url_source: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AgentConfigPermissionIssueView {
    pub subject: String,
    pub path: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub actual_mode: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_mode: u64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AgentConfigStoreView {
    pub home_path: Option<String>,
    pub config_path: Option<String>,
    pub status: String,
    pub detail: Option<String>,
    #[specta(type = Option<rho_store::RuntimeOutputIpcNumber>)]
    pub found_schema_version: Option<u64>,
    /// Opaque process-local capability; never a raw content digest.
    pub config_snapshot_id: String,
    pub permission_issues: Vec<AgentConfigPermissionIssueView>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AgentModelProfileView {
    #[serde(flatten)]
    pub profile: AgentModelProfile,
    pub provider_display_name: String,
    pub selected: bool,
    pub selector_status: String,
    pub act_enabled: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AgentCapabilityRouteView {
    pub capability: String,
    pub label: String,
    pub description: String,
    pub model_id: Option<String>,
    pub model_display_name: Option<String>,
    pub provider_display_name: Option<String>,
    pub model_type: String,
    pub required_model_capabilities: Vec<String>,
    pub configured: bool,
    pub inherited_from: Option<String>,
    pub compatibility: String,
    pub credential_status: String,
    pub consumer_status: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AgentSelectedModelView {
    pub id: String,
    pub display_name: String,
    pub provider_display_name: String,
    pub selector_status: String,
    pub tool_calling: String,
    pub act_enabled: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AgentLlmSettingsView {
    pub schema_version: u32,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub revision: u64,
    /// Compatibility projection for the existing composer. The canonical
    /// authority is the `agent.chat` route, not this derived field.
    pub selected_model_id: String,
    pub providers: Vec<AgentProviderProfileView>,
    pub models: Vec<AgentModelProfileView>,
    pub selected_model: Option<AgentSelectedModelView>,
    pub capability_routes: Vec<AgentCapabilityRouteView>,
    pub user_environ: AgentUserEnvironInfo,
    pub config_store: AgentConfigStoreView,
    pub validation_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedAgentModel {
    pub settings_revision: u64,
    pub route_capability: String,
    pub effective_model_ref: String,
    pub runtime_profile: AgentRuntimeModelProfile,
    pub credential_environment_names: Vec<String>,
    pub provider_id: String,
    pub provider_display_name: String,
    pub model_display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteModelRequest {
    pub model_id: String,
    pub replacement_model_id: Option<String>,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteProviderRequest {
    pub provider_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProviderSaveRequest {
    pub provider: AgentProviderProfile,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLlmCredentialDeleteRequest {
    pub provider_id: String,
    pub target: AgentCredentialWriteTarget,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCapabilityRouteSaveRequest {
    pub route: AgentCapabilityRoute,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCapabilityRouteDeleteRequest {
    pub capability: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelCapabilitiesRequest {
    pub model_id: String,
    pub patch: AgentModelCapabilityPatch,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentContextCapacityRequest {
    pub model_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub context_window_tokens: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub reserved_output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelCapabilityDeclarationRequest {
    pub model_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
    pub capability: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelSaveRequest {
    pub model: AgentModelProfile,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelTestRequest {
    pub model_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentCredentialWriteTarget {
    ConfigFile,
    Session,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLlmCredentialWriteRequest {
    pub provider_id: String,
    pub credential: String,
    pub target: AgentCredentialWriteTarget,
    pub confirm_replace: bool,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfigPermissionRepairRequest {
    pub expected_config_path: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub expected_config_snapshot_id: String,
}

#[derive(Debug, Clone)]
struct ConfigSnapshotRecord {
    home: PathBuf,
    config_path: PathBuf,
    content_identity: String,
    permission_identity: String,
    revision: u64,
}

#[derive(Debug, Default)]
pub struct AgentModelTestState {
    pub pid: Option<u32>,
    pub cancel_requested: bool,
}

pub type AgentModelTestControl = Arc<Mutex<AgentModelTestState>>;

fn capability_value(value: &str, source: &str) -> AgentCapabilityValue {
    AgentCapabilityValue {
        value: value.to_string(),
        source: source.to_string(),
    }
}

fn unknown_capabilities() -> BTreeMap<String, AgentCapabilityValue> {
    capability_names()
        .iter()
        .map(|name| ((*name).to_string(), capability_value("unknown", "unknown")))
        .collect()
}

fn capability_names() -> &'static [&'static str] {
    &[
        "function_call",
        "reasoning",
        "vision_input",
        "image_output",
        "image_edit",
        "audio_input",
        "audio_output",
        "structured_output",
        "web_search",
    ]
}

fn model_capability<'a>(model: &'a AgentModelProfile, name: &str) -> &'a AgentCapabilityValue {
    model.capabilities.get(name).unwrap_or_else(|| {
        // Validation guarantees the bounded vocabulary is complete before any
        // model reaches this helper.
        unreachable!("validated model is missing capability {name}")
    })
}

fn model_function_call(model: &AgentModelProfile) -> &str {
    &model_capability(model, "function_call").value
}

fn chat_model_id(settings: &AgentLlmSettings) -> Result<&str> {
    settings
        .capability_routes
        .iter()
        .find(|route| route.capability == "agent.chat")
        .map(|route| route.model_id.as_str())
        .context("The required agent.chat route is missing.")
}

fn increment_revision(settings: &mut AgentLlmSettings) -> Result<()> {
    settings.revision = settings
        .revision
        .checked_add(1)
        .context("Agent LLM settings revision overflowed.")?;
    Ok(())
}

fn config_to_settings(config: &agent_config::AgentConfig) -> AgentLlmSettings {
    AgentLlmSettings {
        schema_version: agent_config::CONFIG_SCHEMA_VERSION,
        revision: config.revision,
        providers: config
            .providers
            .iter()
            .map(|provider| AgentProviderProfile {
                id: provider.id.clone(),
                display_name: provider.display_name.clone(),
                kind: provider.kind.clone(),
                registered_provider_id: provider.registered_provider_id.clone(),
                api_key_env: provider.api_key_env.clone(),
                api_key_required: provider.api_key_required,
                base_url: provider.base_url.clone(),
                base_url_env: provider.base_url_env.clone(),
                wire_api: provider.wire_api.clone(),
                disable_stream_options: provider.disable_stream_options,
            })
            .collect(),
        models: config
            .models
            .iter()
            .map(|model| AgentModelProfile {
                id: model.id.clone(),
                provider_id: model.provider_id.clone(),
                display_name: model.display_name.clone(),
                model_id: model.model_id.clone(),
                enabled: model.enabled,
                model_type: AgentCapabilityValue {
                    value: model.model_type.value.clone(),
                    source: model.model_type.source.clone(),
                },
                capabilities: model
                    .capabilities
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.clone(),
                            AgentCapabilityValue {
                                value: value.value.clone(),
                                source: value.source.clone(),
                            },
                        )
                    })
                    .collect(),
                context_window_tokens: model.context_window_tokens,
                reserved_output_tokens: model.reserved_output_tokens,
                context_capacity_source: model.context_capacity_source.clone(),
                last_test: model.last_test.as_ref().map(|result| AgentModelTestResult {
                    status: result.status.clone(),
                    checked_at: result.checked_at.clone(),
                    latency_ms: result.latency_ms,
                    error_class: result.error_class.clone(),
                    message: result.message.clone(),
                }),
            })
            .collect(),
        capability_routes: config
            .capability_routes
            .iter()
            .map(|route| AgentCapabilityRoute {
                capability: route.capability.clone(),
                model_id: route.model_id.clone(),
                model_type: route.model_type.clone(),
                required_model_capabilities: route.required_model_capabilities.clone(),
            })
            .collect(),
    }
}

fn apply_settings_to_config(config: &mut agent_config::AgentConfig, settings: &AgentLlmSettings) {
    let file_credentials = config
        .providers
        .iter_mut()
        .filter_map(|provider| {
            provider
                .api_key
                .take()
                .map(|key| (provider.id.clone(), key))
        })
        .collect::<HashMap<_, _>>();
    config.schema_version = agent_config::CONFIG_SCHEMA_VERSION;
    config.revision = settings.revision;
    config.providers = settings
        .providers
        .iter()
        .map(|provider| agent_config::AgentConfigProvider {
            id: provider.id.clone(),
            display_name: provider.display_name.clone(),
            kind: provider.kind.clone(),
            registered_provider_id: provider.registered_provider_id.clone(),
            api_key_env: provider.api_key_env.clone(),
            api_key_required: provider.api_key_required,
            base_url: provider.base_url.clone(),
            base_url_env: provider.base_url_env.clone(),
            wire_api: provider.wire_api.clone(),
            disable_stream_options: provider.disable_stream_options,
            api_key: file_credentials.get(&provider.id).cloned(),
            extra: BTreeMap::new(),
        })
        .collect();
    config.models = settings
        .models
        .iter()
        .map(|model| agent_config::AgentConfigModel {
            id: model.id.clone(),
            provider_id: model.provider_id.clone(),
            display_name: model.display_name.clone(),
            model_id: model.model_id.clone(),
            enabled: model.enabled,
            model_type: agent_config::AgentConfigCapabilityValue {
                value: model.model_type.value.clone(),
                source: model.model_type.source.clone(),
                extra: BTreeMap::new(),
            },
            capabilities: model
                .capabilities
                .iter()
                .map(|(name, value)| {
                    (
                        name.clone(),
                        agent_config::AgentConfigCapabilityValue {
                            value: value.value.clone(),
                            source: value.source.clone(),
                            extra: BTreeMap::new(),
                        },
                    )
                })
                .collect(),
            context_window_tokens: model.context_window_tokens,
            reserved_output_tokens: model.reserved_output_tokens,
            context_capacity_source: model.context_capacity_source.clone(),
            last_test: model.last_test.as_ref().map(|result| {
                agent_config::AgentConfigModelTestResult {
                    status: result.status.clone(),
                    checked_at: result.checked_at.clone(),
                    latency_ms: result.latency_ms,
                    error_class: result.error_class.clone(),
                    message: result.message.clone(),
                    extra: BTreeMap::new(),
                }
            }),
            extra: BTreeMap::new(),
        })
        .collect();
    config.capability_routes = settings
        .capability_routes
        .iter()
        .map(|route| agent_config::AgentConfigCapabilityRoute {
            capability: route.capability.clone(),
            model_id: route.model_id.clone(),
            model_type: route.model_type.clone(),
            required_model_capabilities: route.required_model_capabilities.clone(),
            extra: BTreeMap::new(),
        })
        .collect();
}

fn empty_config() -> agent_config::AgentConfig {
    agent_config::AgentConfig {
        schema_version: agent_config::CONFIG_SCHEMA_VERSION,
        revision: 0,
        providers: Vec::new(),
        models: Vec::new(),
        capability_routes: Vec::new(),
        extra: BTreeMap::new(),
    }
}

struct LoadedV6Document {
    config: agent_config::AgentConfig,
}

fn load_v6_document(data_dir: &Path) -> Result<LoadedV6Document> {
    let home = agent_config::rho_home()?;
    let snapshot = agent_config::read_config_snapshot(&home)?;
    // Adoption means that the canonical path was safely inspectable, not just
    // that environment/path resolution produced a string.  In particular, do
    // not permanently adopt a symlink, wrong-type object, or unreadable path.
    record_config_store_adopted(data_dir, &agent_config::config_file_path(&home));
    match snapshot.load {
        agent_config::AgentConfigLoad::Loaded(config) => Ok(LoadedV6Document { config }),
        agent_config::AgentConfigLoad::Missing { path } => bail!(
            "No canonical model configuration exists at {}.",
            path.display()
        ),
        agent_config::AgentConfigLoad::UnsupportedSchemaVersion { path, found } => {
            bail!(
                "The canonical model configuration at {} uses unsupported schema version {found}.",
                path.display()
            )
        }
        agent_config::AgentConfigLoad::Malformed { path, reason } => {
            bail!(
                "The canonical model configuration at {} is unavailable: {reason}.",
                path.display()
            )
        }
    }
}

fn config_snapshot_store() -> &'static Mutex<HashMap<String, ConfigSnapshotRecord>> {
    CONFIG_SNAPSHOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mint_config_snapshot(record: ConfigSnapshotRecord) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    let mut snapshots = config_snapshot_store()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if snapshots.len() >= 128 {
        // Opaque capabilities are intentionally short-lived. Random eviction
        // keeps the registry bounded without exposing timing or content data.
        if let Some(oldest) = snapshots.keys().next().cloned() {
            snapshots.remove(&oldest);
        }
    }
    snapshots.insert(token.clone(), record);
    token
}

fn config_permission_views(
    issues: &[agent_config::ConfigPermissionIssue],
) -> Vec<AgentConfigPermissionIssueView> {
    issues
        .iter()
        .map(|issue| AgentConfigPermissionIssueView {
            subject: match issue.subject {
                agent_config::ConfigPermissionSubject::RhoHome => "rho_home",
                agent_config::ConfigPermissionSubject::ConfigFile => "config_file",
            }
            .to_string(),
            path: issue.path.display().to_string(),
            actual_mode: u64::from(issue.actual_mode),
            expected_mode: u64::from(issue.expected_mode),
        })
        .collect()
}

fn inspect_config_store(
    data_dir: &Path,
) -> Result<(AgentConfigStoreView, Option<agent_config::AgentConfig>)> {
    let home = match agent_config::rho_home() {
        Ok(home) => home,
        Err(_error) => {
            return Ok((
                AgentConfigStoreView {
                    home_path: None,
                    config_path: None,
                    status: "home_unavailable".to_string(),
                    detail: Some(
                        "The canonical Rho home could not be resolved safely.".to_string(),
                    ),
                    found_schema_version: None,
                    config_snapshot_id: uuid::Uuid::new_v4().to_string(),
                    permission_issues: Vec::new(),
                },
                None,
            ));
        }
    };
    let config_path = agent_config::config_file_path(&home);
    let snapshot = match agent_config::read_config_snapshot(&home) {
        Ok(snapshot) => snapshot,
        Err(_error) => {
            return Ok((
                AgentConfigStoreView {
                    home_path: Some(home.display().to_string()),
                    config_path: Some(config_path.display().to_string()),
                    status: "unavailable".to_string(),
                    detail: Some(
                        "The canonical model configuration could not be read safely.".to_string(),
                    ),
                    found_schema_version: None,
                    // An unregistered capability makes every mutation fail
                    // closed while still giving the UI an opaque snapshot.
                    config_snapshot_id: uuid::Uuid::new_v4().to_string(),
                    permission_issues: Vec::new(),
                },
                None,
            ));
        }
    };
    let permission_state = match agent_config::permission_state(&home) {
        Ok(state) => state,
        Err(_error) => {
            return Ok((
                AgentConfigStoreView {
                    home_path: Some(home.display().to_string()),
                    config_path: Some(config_path.display().to_string()),
                    status: "unavailable".to_string(),
                    detail: Some(
                        "The canonical model configuration metadata could not be inspected safely."
                            .to_string(),
                    ),
                    found_schema_version: None,
                    config_snapshot_id: uuid::Uuid::new_v4().to_string(),
                    permission_issues: Vec::new(),
                },
                None,
            ));
        }
    };
    record_config_store_adopted(data_dir, &config_path);
    let content_identity = snapshot.content_identity;
    let load = snapshot.load;
    let (status, detail, found_schema_version, revision, config) = match load {
        agent_config::AgentConfigLoad::Loaded(config) => (
            "loaded".to_string(),
            config.has_unknown_fields().then(|| {
                "This file contains fields this Rho version does not own; durable Settings edits are disabled.".to_string()
            }),
            Some(u64::from(config.schema_version)),
            config.revision,
            Some(config),
        ),
        agent_config::AgentConfigLoad::Missing { .. } => (
            "missing".to_string(),
            None,
            None,
            0,
            None,
        ),
        agent_config::AgentConfigLoad::UnsupportedSchemaVersion { found, .. } => (
            "unsupported_schema_version".to_string(),
            None,
            Some(found),
            0,
            None,
        ),
        agent_config::AgentConfigLoad::Malformed { reason, .. } => (
            "malformed".to_string(),
            Some(reason),
            None,
            0,
            None,
        ),
    };
    let config_snapshot_id = mint_config_snapshot(ConfigSnapshotRecord {
        home: home.clone(),
        config_path: config_path.clone(),
        content_identity,
        permission_identity: permission_state.identity,
        revision,
    });
    Ok((
        AgentConfigStoreView {
            home_path: Some(home.display().to_string()),
            config_path: Some(config_path.display().to_string()),
            status,
            detail,
            found_schema_version,
            config_snapshot_id,
            permission_issues: config_permission_views(&permission_state.issues),
        },
        config,
    ))
}

#[derive(Debug)]
struct VerifiedConfigMutation {
    token: String,
    record: ConfigSnapshotRecord,
    config: Option<agent_config::AgentConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigMutationPolicy {
    DurableYaml,
    SessionOnly,
    PermissionRepair,
}

fn verify_config_mutation(
    expected_revision: u64,
    expected_config_snapshot_id: &str,
    policy: ConfigMutationPolicy,
) -> Result<VerifiedConfigMutation> {
    let record = config_snapshot_store()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(expected_config_snapshot_id)
        .cloned()
        .context("The model configuration snapshot expired. Reload Settings and try again.")?;
    ensure!(
        record.revision == expected_revision,
        "Model settings changed while this editor was open. Reload and try again."
    );
    ensure!(
        agent_config::rho_home()? == record.home,
        "The canonical model configuration path changed. Reload Settings and try again."
    );
    let permissions = agent_config::permission_state(&record.home)?;
    ensure!(
        permissions.identity == record.permission_identity,
        "The canonical model configuration permissions changed. Reload Settings and try again."
    );
    if policy == ConfigMutationPolicy::DurableYaml {
        ensure!(
            permissions.issues.is_empty(),
            "The canonical model configuration has loose permissions. Use the explicit repair action before saving."
        );
    }
    let snapshot = agent_config::read_config_snapshot(&record.home)?;
    ensure!(
        snapshot.content_identity == record.content_identity,
        "The canonical model configuration changed outside Rho. Reload Settings and try again."
    );
    let config = match snapshot.load {
        agent_config::AgentConfigLoad::Loaded(config) => {
            if policy == ConfigMutationPolicy::DurableYaml {
                ensure!(
                    !config.has_unknown_fields(),
                    "The canonical model configuration contains unsupported fields. Edit it directly before using Settings mutations."
                );
            }
            Some(config)
        }
        agent_config::AgentConfigLoad::Missing { .. } => None,
        agent_config::AgentConfigLoad::UnsupportedSchemaVersion { .. }
            if policy == ConfigMutationPolicy::PermissionRepair =>
        {
            None
        }
        agent_config::AgentConfigLoad::UnsupportedSchemaVersion { .. } => {
            bail!("The canonical model configuration uses an unsupported schema version.")
        }
        agent_config::AgentConfigLoad::Malformed { .. }
            if policy == ConfigMutationPolicy::PermissionRepair =>
        {
            None
        }
        agent_config::AgentConfigLoad::Malformed { reason, .. } => {
            bail!("The canonical model configuration is unavailable: {reason}.")
        }
    };
    Ok(VerifiedConfigMutation {
        token: expected_config_snapshot_id.to_string(),
        record,
        config,
    })
}

fn consume_config_snapshot(token: &str) {
    config_snapshot_store()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(token);
}

fn commit_settings_mutation(
    mutation: VerifiedConfigMutation,
    settings: &AgentLlmSettings,
) -> Result<()> {
    commit_settings_mutation_with(mutation, settings, |home, config, expected_identity| {
        agent_config::save_config_cas(home, config, expected_identity).map(|_| ())
    })
}

fn commit_settings_mutation_with<F>(
    mutation: VerifiedConfigMutation,
    settings: &AgentLlmSettings,
    write: F,
) -> Result<()>
where
    F: FnOnce(&Path, &agent_config::AgentConfig, &str) -> Result<()>,
{
    // Every durable mutation crosses one final whole-document invariant. A
    // locally valid model/provider edit must not persist a document whose
    // existing capability routes that evidence has made incompatible.
    validate_settings(settings)?;
    let mut config = mutation.config.unwrap_or_else(empty_config);
    apply_settings_to_config(&mut config, settings);
    write(
        &mutation.record.home,
        &config,
        &mutation.record.content_identity,
    )?;
    consume_config_snapshot(&mutation.token);
    Ok(())
}

pub fn load_settings(data_dir: &Path) -> Result<AgentLlmSettings> {
    let loaded = load_v6_document(data_dir)?;
    let settings = config_to_settings(&loaded.config);
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn save_provider(
    _data_dir: &Path,
    request: &AgentProviderSaveRequest,
) -> Result<AgentLlmSettings> {
    let _provider_op_lock = credential_operation_lock(&request.provider.id);
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    validate_provider(&request.provider)?;
    let mut settings = mutation
        .config
        .as_ref()
        .map(config_to_settings)
        .unwrap_or_else(|| config_to_settings(&empty_config()));
    if let Some(slot) = settings
        .providers
        .iter_mut()
        .find(|provider| provider.id == request.provider.id)
    {
        *slot = request.provider.clone();
    } else {
        settings.providers.push(request.provider.clone());
    }
    increment_revision(&mut settings)?;
    validate_settings(&settings)?;
    commit_settings_mutation(mutation, &settings)?;
    Ok(settings)
}

pub fn delete_provider(
    data_dir: &Path,
    request: &DeleteProviderRequest,
) -> Result<AgentLlmSettings> {
    let _provider_op_lock = credential_operation_lock(&request.provider_id);
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let config = mutation
        .config
        .as_ref()
        .context("Create config.yaml before deleting a provider.")?;
    let file_credential_present = config
        .providers
        .iter()
        .find(|provider| provider.id == request.provider_id)
        .and_then(|provider| provider.api_key.as_deref())
        .is_some_and(|value| !value.is_empty());
    let session_credential_present =
        credential_session().has_session_credential(&request.provider_id);
    let mut settings = config_to_settings(config);
    let provider_id = request.provider_id.as_str();
    validate_bounded(provider_id, "Provider ID", MAX_ID_LENGTH)?;
    ensure!(
        settings
            .providers
            .iter()
            .any(|provider| provider.id == provider_id),
        "Unknown provider: {provider_id}"
    );
    let model_ids = settings
        .models
        .iter()
        .filter(|model| model.provider_id == provider_id)
        .map(|model| model.id.clone())
        .collect::<HashSet<_>>();
    ensure!(
        !settings.capability_routes.iter().any(|route| {
            route.capability == "agent.chat" && model_ids.contains(&route.model_id)
        }),
        "Assign Chat to a model from another provider before deleting this provider."
    );
    settings
        .capability_routes
        .retain(|route| !model_ids.contains(&route.model_id));
    settings
        .models
        .retain(|model| model.provider_id != provider_id);
    settings
        .providers
        .retain(|provider| provider.id != provider_id);
    increment_revision(&mut settings)?;
    validate_settings(&settings)?;
    commit_settings_mutation(mutation, &settings)?;
    credential_session().clear_session_credential(provider_id);
    if file_credential_present || session_credential_present {
        record_credential_audit(
            data_dir,
            "provider_credential_delete",
            provider_id,
            "config_file_and_session",
            "ok",
            None,
        );
    }
    Ok(settings)
}

pub fn set_credential(data_dir: &Path, request: &AgentLlmCredentialWriteRequest) -> Result<()> {
    let _provider_op_lock = credential_operation_lock(&request.provider_id);
    let _guard = settings_mutation_guard();
    let mut mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        match request.target {
            AgentCredentialWriteTarget::ConfigFile => ConfigMutationPolicy::DurableYaml,
            AgentCredentialWriteTarget::Session => ConfigMutationPolicy::SessionOnly,
        },
    )?;
    let config = mutation
        .config
        .as_mut()
        .context("Create config.yaml with this provider before saving its API key.")?;
    let provider = config
        .providers
        .iter_mut()
        .find(|provider| provider.id == request.provider_id)
        .with_context(|| format!("Unknown provider: {}", request.provider_id))?;
    ensure!(
        provider.api_key_required,
        "This provider does not require an API key."
    );
    ensure!(
        !request.credential.is_empty(),
        "Enter an API key before saving."
    );
    ensure!(
        !request.credential.chars().any(char::is_control),
        "The API key contains control characters or line breaks. Paste the key exactly as issued."
    );
    ensure!(
        request.credential.len() <= MAX_CREDENTIAL_BYTES,
        "The API key exceeds the {MAX_CREDENTIAL_BYTES_LABEL} storage limit."
    );
    let replacing = match request.target {
        AgentCredentialWriteTarget::Session => {
            credential_session().has_session_credential(&request.provider_id)
        }
        AgentCredentialWriteTarget::ConfigFile => provider
            .api_key
            .as_deref()
            .is_some_and(|value| !value.is_empty()),
    };
    ensure!(
        request.confirm_replace || !replacing,
        "An API key already exists in that target. Confirm replacement to overwrite it."
    );
    match request.target {
        AgentCredentialWriteTarget::Session => {
            credential_session().set_session_credential(&request.provider_id, &request.credential);
            consume_config_snapshot(&mutation.token);
        }
        AgentCredentialWriteTarget::ConfigFile => {
            provider.api_key = Some(Zeroizing::new(request.credential.clone()));
            config.revision = config
                .revision
                .checked_add(1)
                .context("Agent LLM settings revision overflowed.")?;
            agent_config::save_config_cas(
                &mutation.record.home,
                config,
                &mutation.record.content_identity,
            )?;
            consume_config_snapshot(&mutation.token);
        }
    }
    record_credential_audit(
        data_dir,
        if replacing {
            "credential_replace"
        } else {
            "credential_set"
        },
        &request.provider_id,
        match request.target {
            AgentCredentialWriteTarget::ConfigFile => CREDENTIAL_SOURCE_CONFIG_FILE,
            AgentCredentialWriteTarget::Session => CREDENTIAL_SOURCE_SESSION,
        },
        "ok",
        None,
    );
    Ok(())
}

pub fn delete_credential(data_dir: &Path, request: &AgentLlmCredentialDeleteRequest) -> Result<()> {
    let _provider_op_lock = credential_operation_lock(&request.provider_id);
    let _guard = settings_mutation_guard();
    let mut mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        match request.target {
            AgentCredentialWriteTarget::ConfigFile => ConfigMutationPolicy::DurableYaml,
            AgentCredentialWriteTarget::Session => ConfigMutationPolicy::SessionOnly,
        },
    )?;
    let config = mutation
        .config
        .as_mut()
        .context("Create config.yaml before deleting a credential.")?;
    let provider = config
        .providers
        .iter_mut()
        .find(|provider| provider.id == request.provider_id)
        .with_context(|| format!("Unknown provider: {}", request.provider_id))?;
    match request.target {
        AgentCredentialWriteTarget::Session => {
            credential_session().clear_session_credential(&request.provider_id);
            consume_config_snapshot(&mutation.token);
        }
        AgentCredentialWriteTarget::ConfigFile => {
            provider.api_key = None;
            config.revision = config
                .revision
                .checked_add(1)
                .context("Agent LLM settings revision overflowed.")?;
            agent_config::save_config_cas(
                &mutation.record.home,
                config,
                &mutation.record.content_identity,
            )?;
            consume_config_snapshot(&mutation.token);
        }
    }
    record_credential_audit(
        data_dir,
        "credential_delete",
        &request.provider_id,
        match request.target {
            AgentCredentialWriteTarget::ConfigFile => CREDENTIAL_SOURCE_CONFIG_FILE,
            AgentCredentialWriteTarget::Session => CREDENTIAL_SOURCE_SESSION,
        },
        "ok",
        None,
    );
    Ok(())
}

pub fn save_model(_data_dir: &Path, request: &AgentModelSaveRequest) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let mut settings = mutation
        .config
        .as_ref()
        .map(config_to_settings)
        .unwrap_or_else(|| config_to_settings(&empty_config()));
    let model = request.model.clone();
    if let Some(existing) = settings.models.iter().find(|item| item.id == model.id) {
        ensure!(
            existing.model_type == model.model_type && existing.capabilities == model.capabilities,
            "Use the capability declaration command to change model evidence."
        );
        ensure!(
            model.enabled
                || existing.enabled == model.enabled
                || !settings
                    .capability_routes
                    .iter()
                    .any(|route| route.model_id == model.id),
            "Reassign this model's capability routes before disabling it."
        );
    }
    if let Some(slot) = settings.models.iter_mut().find(|item| item.id == model.id) {
        *slot = model;
    } else {
        settings.models.push(model);
    }
    increment_revision(&mut settings)?;
    validate_settings(&settings)?;
    commit_settings_mutation(mutation, &settings)?;
    Ok(settings)
}

pub fn set_context_capacity(
    _data_dir: &Path,
    request: &AgentContextCapacityRequest,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let mut settings = mutation
        .config
        .as_ref()
        .map(config_to_settings)
        .context("Create config.yaml before editing model capacity.")?;
    let model = settings
        .models
        .iter_mut()
        .find(|model| model.id == request.model_id)
        .with_context(|| format!("Unknown model: {}", request.model_id))?;
    model.context_window_tokens = request.context_window_tokens;
    model.reserved_output_tokens = request.reserved_output_tokens;
    model.context_capacity_source = "user_declared".to_string();
    validate_model(model)?;
    increment_revision(&mut settings)?;
    commit_settings_mutation(mutation, &settings)?;
    Ok(settings)
}

pub fn declare_model_capability(
    _data_dir: &Path,
    request: &AgentModelCapabilityDeclarationRequest,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let mut settings = mutation
        .config
        .as_ref()
        .map(config_to_settings)
        .context("Create config.yaml before declaring model capabilities.")?;

    apply_model_capability_declaration(&mut settings, request)?;
    increment_revision(&mut settings)?;
    commit_settings_mutation(mutation, &settings)?;
    Ok(settings)
}

fn apply_model_capability_declaration(
    settings: &mut AgentLlmSettings,
    request: &AgentModelCapabilityDeclarationRequest,
) -> Result<()> {
    let model = settings
        .models
        .iter_mut()
        .find(|model| model.id == request.model_id)
        .with_context(|| format!("Unknown model: {}", request.model_id))?;
    if request.capability == "model_type" {
        ensure!(
            matches!(
                request.value.as_str(),
                "language" | "embedding" | "image" | "unknown"
            ),
            "Model type must be language, embedding, image or unknown."
        );
        model.model_type = capability_value(&request.value, "user_declared");
    } else {
        ensure!(
            capability_names().contains(&request.capability.as_str()),
            "Unsupported model capability: {}",
            request.capability
        );
        ensure!(
            matches!(request.value.as_str(), "yes" | "no" | "unknown"),
            "Capability values must be yes, no or unknown."
        );
        model.capabilities.insert(
            request.capability.clone(),
            capability_value(&request.value, "user_declared"),
        );
    }
    validate_model(model)
}

pub fn delete_model(_data_dir: &Path, request: &DeleteModelRequest) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let mut settings = mutation
        .config
        .as_ref()
        .map(config_to_settings)
        .context("Create config.yaml before deleting models.")?;
    let _existing = settings
        .models
        .iter()
        .find(|model| model.id == request.model_id)
        .cloned()
        .with_context(|| format!("Unknown model: {}", request.model_id))?;
    ensure!(
        !settings
            .capability_routes
            .iter()
            .any(|route| route.model_id == request.model_id),
        "Reassign or remove this model's capability routes before deleting it."
    );
    settings.models.retain(|model| model.id != request.model_id);
    increment_revision(&mut settings)?;
    validate_settings(&settings)?;
    commit_settings_mutation(mutation, &settings)?;
    Ok(settings)
}

pub fn save_capability_route(
    _data_dir: &Path,
    expected_revision: u64,
    expected_config_snapshot_id: &str,
    route: AgentCapabilityRoute,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        expected_revision,
        expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let mut settings = mutation
        .config
        .as_ref()
        .map(config_to_settings)
        .context("Create config.yaml before selecting a model.")?;
    validate_route_candidate(&settings, &route, true)?;
    if let Some(slot) = settings
        .capability_routes
        .iter_mut()
        .find(|item| item.capability == route.capability)
    {
        *slot = route;
    } else {
        ensure!(
            settings.capability_routes.len() < MAX_CAPABILITY_ROUTES,
            "Capability routes are limited to 32."
        );
        settings.capability_routes.push(route);
    }
    settings
        .capability_routes
        .sort_by(|left, right| left.capability.cmp(&right.capability));
    increment_revision(&mut settings)?;
    commit_settings_mutation(mutation, &settings)?;
    Ok(settings)
}

pub fn delete_capability_route(
    _data_dir: &Path,
    request: &AgentCapabilityRouteDeleteRequest,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let mut settings = mutation
        .config
        .as_ref()
        .map(config_to_settings)
        .context("Create config.yaml before deleting a capability route.")?;
    validate_capability_name(&request.capability)?;
    ensure!(
        request.capability != "agent.chat",
        "The required agent.chat route cannot be removed."
    );
    let before = settings.capability_routes.len();
    settings
        .capability_routes
        .retain(|route| route.capability != request.capability);
    ensure!(
        settings.capability_routes.len() != before,
        "Unknown capability route: {}",
        request.capability
    );
    increment_revision(&mut settings)?;
    validate_settings(&settings)?;
    commit_settings_mutation(mutation, &settings)?;
    Ok(settings)
}

pub fn declare_model_capabilities(
    _data_dir: &Path,
    request: &AgentModelCapabilitiesRequest,
) -> Result<AgentLlmSettings> {
    ensure!(
        request.patch.model_type.is_some() || !request.patch.capabilities.is_empty(),
        "Declare at least one model type or capability value."
    );
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let mut settings = mutation
        .config
        .as_ref()
        .map(config_to_settings)
        .context("Create config.yaml before declaring model capabilities.")?;
    let model = settings
        .models
        .iter_mut()
        .find(|model| model.id == request.model_id)
        .with_context(|| format!("Unknown model: {}", request.model_id))?;
    if let Some(model_type) = &request.patch.model_type {
        ensure!(
            matches!(
                model_type.as_str(),
                "language" | "embedding" | "image" | "unknown"
            ),
            "Model type must be language, embedding, image or unknown."
        );
        model.model_type = capability_value(model_type, "user_declared");
    }
    for (name, value) in &request.patch.capabilities {
        ensure!(
            capability_names().contains(&name.as_str()),
            "Unsupported model capability: {name}"
        );
        ensure!(
            matches!(value.as_str(), "yes" | "no" | "unknown"),
            "Capability values must be yes, no or unknown."
        );
        model
            .capabilities
            .insert(name.clone(), capability_value(value, "user_declared"));
    }
    validate_model(model)?;
    increment_revision(&mut settings)?;
    validate_settings(&settings)?;
    commit_settings_mutation(mutation, &settings)?;
    Ok(settings)
}

pub fn settings_view(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
) -> Result<AgentLlmSettingsView> {
    let _guard = settings_mutation_guard();
    let (config_store, config) = inspect_config_store(data_dir)?;
    let mut settings =
        config
            .as_ref()
            .map(config_to_settings)
            .unwrap_or_else(|| AgentLlmSettings {
                schema_version: agent_config::CONFIG_SCHEMA_VERSION,
                revision: 0,
                providers: Vec::new(),
                models: Vec::new(),
                capability_routes: Vec::new(),
            });
    let validation_error = config.as_ref().and_then(|_| {
        validate_settings(&settings)
            .err()
            .map(|error| format!("{error:#}"))
    });
    if let Some(validation_error) = validation_error {
        return Ok(build_invalid_settings_view(
            settings,
            system_credential_info(),
            config.as_ref(),
            config_store,
            validation_error,
        ));
    }
    if let Some(entries) = catalog_cached(data_dir, rscript).ok() {
        project_catalog_capacity(&mut settings, &entries);
    }
    let statuses = credential_status_map(
        &settings.providers,
        config.as_ref(),
        rscript,
        r_environ_user,
    );
    Ok(build_settings_view(
        settings,
        system_credential_info(),
        statuses,
        config_store,
    ))
}

pub fn settings_view_from_settings(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
    mut settings: AgentLlmSettings,
) -> Result<AgentLlmSettingsView> {
    // A committed mutation must never be reported as a save failure merely
    // because a presentation refresh is unavailable. `inspect_config_store`
    // projects unsafe/unreadable state without returning an I/O error; when a
    // later writer has already changed the document (even without advancing
    // its revision), prefer that one fresh snapshot so the returned view is
    // not a mixed old/new authority.
    let _guard = settings_mutation_guard();
    let (config_store, config) = inspect_config_store(data_dir)?;
    if let Some(config) = config.as_ref() {
        settings = config_to_settings(config);
    }
    if let Err(error) = validate_settings(&settings) {
        return Ok(build_invalid_settings_view(
            settings,
            system_credential_info(),
            config.as_ref(),
            config_store,
            format!("{error:#}"),
        ));
    }
    if let Some(entries) = catalog_cached(data_dir, rscript).ok() {
        project_catalog_capacity(&mut settings, &entries);
    }
    let statuses = credential_status_map(
        &settings.providers,
        config.as_ref(),
        rscript,
        r_environ_user,
    );
    Ok(build_settings_view(
        settings,
        system_credential_info(),
        statuses,
        config_store,
    ))
}

pub fn refresh_credentials_view(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
) -> Result<AgentLlmSettingsView> {
    settings_view(data_dir, rscript, r_environ_user)
}

pub fn repair_config_permissions(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
    request: &AgentConfigPermissionRepairRequest,
) -> Result<AgentLlmSettingsView> {
    let _guard = settings_mutation_guard();
    let mutation = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::PermissionRepair,
    )?;
    let expected_path = PathBuf::from(&request.expected_config_path);
    ensure!(
        expected_path == mutation.record.config_path,
        "The canonical model configuration path changed. Reload Settings and try again."
    );
    agent_config::repair_permissions(
        &mutation.record.home,
        &expected_path,
        &mutation.record.content_identity,
    )?;
    consume_config_snapshot(&mutation.token);
    drop(_guard);
    settings_view(data_dir, rscript, r_environ_user)
}

pub fn clear_session_credentials() {
    credential_session().clear();
}

pub fn catalog(data_dir: &Path, rscript: &Path) -> Result<Vec<AgentCatalogEntry>> {
    let settings = load_settings(data_dir)?;
    let probe_environment_names = provider_probe_environment_names(&settings);
    let script = r#"
if (!requireNamespace("aisdk", quietly = TRUE)) {
  stop("aisdk is unavailable")
}
models <- aisdk::list_models()
if (!is.data.frame(models) || !nrow(models)) {
  cat("[]")
  quit(save = "no", status = 0L)
}
field_value <- function(data, row, name, default = "") {
  if (!(name %in% names(data))) {
    return(default)
  }
  value <- data[[name]][[row]]
  if (length(value) == 0L || is.null(value) || is.na(value)) {
    return(default)
  }
  as.character(value)[[1L]]
}
field_capability <- function(data, row, name) {
  if (!(name %in% names(data))) {
    return(list(value = "unknown", source = "unknown"))
  }
  value <- data[[name]][[row]]
  if (length(value) == 0L || is.null(value) || is.na(value)) {
    return(list(value = "unknown", source = "unknown"))
  }
  list(
    value = if (isTRUE(as.logical(value)[[1L]])) "yes" else "no",
    source = "aisdk_catalog"
  )
}
field_number <- function(data, row, name) {
  if (!(name %in% names(data))) {
    return(NULL)
  }
  value <- data[[name]][[row]]
  if (length(value) == 0L || is.null(value) || is.na(value)) {
    return(NULL)
  }
  as.numeric(value)[[1L]]
}
rows <- lapply(seq_len(nrow(models)), function(i) {
  id <- field_value(models, i, "id", "")
  family <- field_value(models, i, "family", id)
  description <- field_value(models, i, "description", NA_character_)
  list(
    provider = field_value(models, i, "provider", ""),
    id = id,
    display_name = family,
    description = if (is.na(description)) NULL else description,
    model_type = list(
      value = field_value(models, i, "type", "unknown"),
      source = if ("type" %in% names(models) && !is.na(models$type[[i]])) "aisdk_catalog" else "unknown"
    ),
    capabilities = list(
      function_call = field_capability(models, i, "function_call"),
      reasoning = field_capability(models, i, "reasoning"),
      vision_input = field_capability(models, i, "vision_input"),
      image_output = field_capability(models, i, "image_output"),
      image_edit = field_capability(models, i, "image_edit"),
      audio_input = field_capability(models, i, "audio_input"),
      audio_output = field_capability(models, i, "audio_output"),
      structured_output = field_capability(models, i, "structured_output"),
      web_search = field_capability(models, i, "web_search")
    ),
    context_window_tokens = field_number(models, i, "context_window"),
    max_output_tokens = field_number(models, i, "max_output")
  )
})
cat(jsonlite::toJSON(unname(rows), auto_unbox = TRUE, null = "null"))
"#;
    run_r_json(
        rscript,
        script,
        RProbeRequest {
            args: &[],
            user_environ: None,
            stdin: None,
            scrub_environment_names: &probe_environment_names,
            environment_overrides: &[],
            failure_disclosure: RProbeFailureDisclosure::BoundedDiagnostic,
            test_control: None,
        },
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelDiscoveryFormat {
    OpenAi,
    Anthropic,
    Gemini,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelDiscoveryAuth {
    Bearer,
    Anthropic,
    Gemini,
}

#[derive(Debug, Clone)]
struct ModelDiscoveryTarget {
    url: reqwest::Url,
    format: ModelDiscoveryFormat,
    auth: ModelDiscoveryAuth,
}

static CATALOG_CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<Vec<AgentCatalogEntry>>>>> =
    OnceLock::new();

fn catalog_cache_store() -> &'static Mutex<HashMap<PathBuf, Arc<Vec<AgentCatalogEntry>>>> {
    CATALOG_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Process-wide catalog cache keyed by the Rscript path. Only successful
/// probes are cached; a failed probe is retried on the next call.
pub fn catalog_cached(data_dir: &Path, rscript: &Path) -> Result<Arc<Vec<AgentCatalogEntry>>> {
    catalog_cached_with(data_dir, rscript, catalog)
}

fn catalog_cached_with<F>(
    data_dir: &Path,
    rscript: &Path,
    probe: F,
) -> Result<Arc<Vec<AgentCatalogEntry>>>
where
    F: FnOnce(&Path, &Path) -> Result<Vec<AgentCatalogEntry>>,
{
    let key = rscript.to_path_buf();
    if let Some(hit) = catalog_cache_store().lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }
    let entries = Arc::new(probe(data_dir, rscript)?);
    catalog_cache_store()
        .lock()
        .unwrap()
        .insert(key, entries.clone());
    Ok(entries)
}

fn catalog_entry_for_model<'a>(
    provider_key: &str,
    provider_model_id: &str,
    entries: &'a [AgentCatalogEntry],
) -> Option<&'a AgentCatalogEntry> {
    entries.iter().find(|entry| {
        entry.provider.eq_ignore_ascii_case(provider_key) && entry.id == provider_model_id
    })
}

fn provider_catalog_key(provider: &AgentProviderProfile) -> String {
    provider
        .registered_provider_id
        .as_deref()
        .unwrap_or(&provider.kind)
        .to_ascii_lowercase()
}

/// Presentation-only projection: models still at the durable conservative
/// default show the catalog capacity facts when an exact Provider/model-ID
/// catalog match carries both values. Durable settings are never rewritten.
fn project_catalog_capacity(settings: &mut AgentLlmSettings, entries: &[AgentCatalogEntry]) {
    let provider_keys = settings
        .providers
        .iter()
        .map(|provider| (provider.id.clone(), provider_catalog_key(provider)))
        .collect::<HashMap<_, _>>();
    for model in &mut settings.models {
        if model.context_capacity_source != "conservative_default" {
            continue;
        }
        let Some(provider_key) = provider_keys.get(&model.provider_id) else {
            continue;
        };
        let Some(entry) = catalog_entry_for_model(provider_key, &model.model_id, entries) else {
            continue;
        };
        let (Some(context_window), Some(max_output)) =
            (entry.context_window_tokens, entry.max_output_tokens)
        else {
            continue;
        };
        model.context_window_tokens = context_window;
        model.reserved_output_tokens = max_output;
        model.context_capacity_source = "catalog".to_string();
    }
}

pub fn discover_models(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
    provider_id: &str,
) -> Result<AgentModelDiscoveryResponse> {
    let loaded = load_v6_document(data_dir)?;
    let settings = config_to_settings(&loaded.config);
    validate_settings(&settings)?;
    let client = model_discovery_client()?;
    let credential_store = ConfigCredentialStore::from_config(&loaded.config);
    let mut response = discover_models_with_store(
        data_dir,
        &settings,
        provider_id,
        &credential_store,
        Some(rscript),
        r_environ_user,
        &client,
    )?;
    if response.status == "ready" && !response.models.is_empty() {
        if let Some(provider) = settings
            .providers
            .iter()
            .find(|item| item.id == provider_id)
        {
            if let Ok(entries) = catalog_cached(data_dir, rscript) {
                enrich_discovered_models(provider, &mut response.models, &entries);
            }
        }
    }
    Ok(response)
}

fn enrich_discovered_models(
    provider: &AgentProviderProfile,
    models: &mut [AgentDiscoveredModel],
    entries: &[AgentCatalogEntry],
) {
    let provider_key = provider_catalog_key(provider);
    for model in models {
        if let Some(entry) = catalog_entry_for_model(&provider_key, &model.id, entries) {
            model.model_type = entry.model_type.clone();
            model.capabilities = entry.capabilities.clone();
        }
    }
}

fn model_discovery_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(MODEL_DISCOVERY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .user_agent("Rho model discovery")
        .build()
        .context("building the bounded Provider model-discovery client")
}

fn discover_models_with_store(
    data_dir: &Path,
    settings: &AgentLlmSettings,
    provider_id: &str,
    credential_store: &impl CredentialStore,
    rscript: Option<&Path>,
    r_environ_user: Option<&Path>,
    client: &reqwest::blocking::Client,
) -> Result<AgentModelDiscoveryResponse> {
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .with_context(|| format!("Unknown provider: {provider_id}"))?;
    let Some(target) = model_discovery_target(provider)? else {
        return Ok(model_discovery_result(
            provider_id,
            "unsupported",
            Vec::new(),
            false,
            "This provider does not expose a supported model list. Enter a model ID manually.",
            Some("unsupported"),
        ));
    };

    let credential = if provider.api_key_required {
        match resolve_provider_credential_with_runtime(
            &settings,
            provider,
            credential_store,
            rscript,
            r_environ_user,
        ) {
            Ok((Some(value), source)) => {
                record_credential_audit(
                    data_dir,
                    "credential_discovery_read",
                    provider_id,
                    source,
                    "detected",
                    None,
                );
                Some(value)
            }
            Ok((None, source)) => {
                record_credential_audit(
                    data_dir,
                    "credential_discovery_read",
                    provider_id,
                    source,
                    "not_detected",
                    None,
                );
                return Ok(model_discovery_result(
                    provider_id,
                    "error",
                    Vec::new(),
                    false,
                    "No API key is available from this provider's configured credential source. Save a key or enter a model ID manually.",
                    Some("credential"),
                ));
            }
            Err(_) => {
                record_credential_audit(
                    data_dir,
                    "credential_discovery_read",
                    provider_id,
                    CREDENTIAL_SOURCE_NOT_CONFIGURED,
                    "unavailable",
                    None,
                );
                return Ok(model_discovery_result(
                    provider_id,
                    "error",
                    Vec::new(),
                    false,
                    "The configured credential source is unavailable. Retry or enter a model ID manually.",
                    Some("credential"),
                ));
            }
        }
    } else {
        None
    };

    let mut request = client
        .get(target.url)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(secret) = credential.as_deref() {
        request = match target.auth {
            ModelDiscoveryAuth::Bearer => request.bearer_auth(secret),
            ModelDiscoveryAuth::Anthropic => request
                .header("x-api-key", secret)
                .header("anthropic-version", "2023-06-01"),
            ModelDiscoveryAuth::Gemini => request.header("x-goog-api-key", secret),
        };
    }

    let response = match request.send() {
        Ok(response) => response,
        Err(error) => {
            let (class, message) = if error.is_timeout() {
                (
                    "timeout",
                    "Model discovery timed out. Retry or enter a model ID manually.",
                )
            } else {
                (
                    "network",
                    "Rho could not reach the provider model list. Retry or enter a model ID manually.",
                )
            };
            return Ok(model_discovery_result(
                provider_id,
                "error",
                Vec::new(),
                false,
                message,
                Some(class),
            ));
        }
    };

    let status = response.status();
    if !status.is_success() {
        let (result_status, class, message) = match status.as_u16() {
            401 | 403 => (
                "error",
                "auth",
                "The provider rejected the stored API key. Replace the key or enter a model ID manually.",
            ),
            404 => (
                "unsupported",
                "unsupported",
                "This provider does not expose a model list at the configured endpoint. Enter a model ID manually.",
            ),
            429 => (
                "error",
                "rate_limit",
                "The provider rate-limited model discovery. Retry later or enter a model ID manually.",
            ),
            300..=399 => (
                "unsupported",
                "unsupported",
                "The provider redirected its model list. Rho does not forward API keys across redirects; enter a model ID manually.",
            ),
            _ => (
                "error",
                "response",
                "The provider model list returned an error. Retry or enter a model ID manually.",
            ),
        };
        return Ok(model_discovery_result(
            provider_id,
            result_status,
            Vec::new(),
            false,
            message,
            Some(class),
        ));
    }

    let mut bounded = response.take((MAX_MODEL_DISCOVERY_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    if bounded.read_to_end(&mut bytes).is_err() {
        return Ok(model_discovery_result(
            provider_id,
            "error",
            Vec::new(),
            false,
            "Rho could not read the provider model list. Retry or enter a model ID manually.",
            Some("network"),
        ));
    }
    if bytes.len() > MAX_MODEL_DISCOVERY_BYTES {
        return Ok(model_discovery_result(
            provider_id,
            "error",
            Vec::new(),
            false,
            "The provider model list exceeded Rho's 1 MiB safety limit. Enter a model ID manually.",
            Some("response"),
        ));
    }

    let (models, truncated) = match parse_discovered_models(target.format, &bytes) {
        Ok(result) => result,
        Err(_) => {
            return Ok(model_discovery_result(
                provider_id,
                "error",
                Vec::new(),
                false,
                "The provider returned an invalid model list. Retry or enter a model ID manually.",
                Some("response"),
            ));
        }
    };
    let message = if models.is_empty() {
        "The provider returned no usable generation models. Enter a model ID manually.".to_string()
    } else if truncated {
        format!(
            "Loaded the first {} models. The provider reported additional models.",
            models.len()
        )
    } else {
        format!("Loaded {} available models.", models.len())
    };
    Ok(model_discovery_result(
        provider_id,
        "ready",
        models,
        truncated,
        &message,
        None,
    ))
}

fn model_discovery_target(provider: &AgentProviderProfile) -> Result<Option<ModelDiscoveryTarget>> {
    let Some((default_base_url, format, auth)) = provider_discovery_contract(provider) else {
        return Ok(None);
    };
    if provider.base_url.is_none() && provider.base_url_env.is_some() {
        // Environment-derived Base URLs remain runtime-only. Discovery never
        // expands them into new credential-bearing network authority or falls
        // back to a different default endpoint.
        return Ok(None);
    }
    let Some(base_url) = provider.base_url.as_deref().or(default_base_url) else {
        return Ok(None);
    };
    Ok(Some(ModelDiscoveryTarget {
        url: provider_models_url(base_url, format)?,
        format,
        auth,
    }))
}

fn reviewed_registered_provider_id(provider: &AgentProviderProfile) -> Option<&str> {
    let id = provider.registered_provider_id.as_deref()?;
    reviewed_registered_provider_ids()
        .iter()
        .find(|candidate| id.eq_ignore_ascii_case(candidate))
        .copied()
}

fn reviewed_registered_provider_ids() -> &'static [&'static str] {
    &[
        "deepseek",
        "moonshot",
        "kimi",
        "stepfun",
        "volcengine",
        "aihubmix",
        "xai",
        "openrouter",
        "bailian",
        "nvidia",
    ]
}

fn provider_default_base_url(provider: &AgentProviderProfile) -> Option<&'static str> {
    match provider.kind.as_str() {
        "openai" => Some("https://api.openai.com/v1"),
        "anthropic" => Some("https://api.anthropic.com/v1"),
        "gemini" => Some("https://generativelanguage.googleapis.com/v1beta/models"),
        "registered" => match reviewed_registered_provider_id(provider)? {
            "deepseek" => Some("https://api.deepseek.com"),
            "moonshot" => Some("https://api.moonshot.cn/v1"),
            "kimi" => Some("https://api.kimi.com/coding/v1"),
            "stepfun" => Some("https://api.stepfun.com/v1"),
            "volcengine" => Some("https://ark.cn-beijing.volces.com/api/v3"),
            "aihubmix" => Some("https://aihubmix.com/v1"),
            "xai" => Some("https://api.x.ai/v1"),
            "openrouter" => Some("https://openrouter.ai/api/v1"),
            "bailian" => Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "nvidia" => Some("https://integrate.api.nvidia.com/v1"),
            _ => None,
        },
        _ => None,
    }
}

fn provider_base_url_presentation(provider: &AgentProviderProfile) -> (Option<String>, String) {
    if let Some(base_url) = &provider.base_url {
        return (Some(base_url.clone()), "configured".to_string());
    }
    if let Some(environment_name) = &provider.base_url_env {
        let resolved = validate_env_name(Some(environment_name), false)
            .ok()
            .and_then(|_| std::env::var(environment_name).ok())
            .filter(|value| validate_base_url(Some(value)).is_ok());
        return (
            resolved.or_else(|| Some(format!("${environment_name}"))),
            "environment".to_string(),
        );
    }
    match provider_default_base_url(provider) {
        Some(base_url) => (Some(base_url.to_string()), "provider_default".to_string()),
        None => (None, "not_configured".to_string()),
    }
}

fn provider_discovery_contract(
    provider: &AgentProviderProfile,
) -> Option<(
    Option<&'static str>,
    ModelDiscoveryFormat,
    ModelDiscoveryAuth,
)> {
    let provider_id = reviewed_registered_provider_id(provider);
    let anthropic = provider.kind == "anthropic"
        || provider.wire_api.as_deref() == Some("anthropic_messages")
        || provider_id == Some("kimi");
    let gemini = provider.kind == "gemini";
    let supported = matches!(
        provider.kind.as_str(),
        "openai" | "anthropic" | "gemini" | "openai_compatible" | "local_openai_compatible"
    ) || provider_id.is_some();
    supported.then(|| {
        if gemini {
            (
                provider_default_base_url(provider),
                ModelDiscoveryFormat::Gemini,
                ModelDiscoveryAuth::Gemini,
            )
        } else if anthropic {
            (
                provider_default_base_url(provider),
                ModelDiscoveryFormat::Anthropic,
                ModelDiscoveryAuth::Anthropic,
            )
        } else {
            (
                provider_default_base_url(provider),
                ModelDiscoveryFormat::OpenAi,
                ModelDiscoveryAuth::Bearer,
            )
        }
    })
}

fn provider_models_url(base_url: &str, format: ModelDiscoveryFormat) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|_| anyhow::anyhow!("The configured Base URL is invalid."))?;
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "The configured Base URL must use HTTP or HTTPS."
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "The configured Base URL must not contain credentials."
    );
    url.set_fragment(None);
    if !url.path().trim_end_matches('/').ends_with("/models") {
        let path = format!("{}/models", url.path().trim_end_matches('/'));
        url.set_path(&path);
    }
    if matches!(
        format,
        ModelDiscoveryFormat::Anthropic | ModelDiscoveryFormat::Gemini
    ) {
        let parameter = if format == ModelDiscoveryFormat::Gemini {
            ("pageSize", "100")
        } else {
            ("limit", "100")
        };
        if !url.query_pairs().any(|(name, _)| name == parameter.0) {
            url.query_pairs_mut().append_pair(parameter.0, parameter.1);
        }
    }
    Ok(url)
}

fn parse_discovered_models(
    format: ModelDiscoveryFormat,
    bytes: &[u8],
) -> Result<(Vec<AgentDiscoveredModel>, bool)> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).context("decoding the Provider model list")?;
    let object = value
        .as_object()
        .context("the Provider model list must be a JSON object")?;
    let (entries, mut truncated) = match format {
        ModelDiscoveryFormat::OpenAi | ModelDiscoveryFormat::Anthropic => (
            object
                .get("data")
                .and_then(serde_json::Value::as_array)
                .context("the Provider model list has no data array")?,
            object
                .get("has_more")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        ),
        ModelDiscoveryFormat::Gemini => (
            object
                .get("models")
                .and_then(serde_json::Value::as_array)
                .context("the Gemini model list has no models array")?,
            object
                .get("nextPageToken")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|token| !token.is_empty()),
        ),
    };
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for entry in entries {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        if format == ModelDiscoveryFormat::Gemini {
            let supports_generation = entry
                .get("supportedGenerationMethods")
                .or_else(|| entry.get("supportedActions"))
                .and_then(serde_json::Value::as_array)
                .is_some_and(|methods| {
                    methods.iter().any(|method| {
                        method
                            .as_str()
                            .is_some_and(|method| method.eq_ignore_ascii_case("generateContent"))
                    })
                });
            if !supports_generation {
                continue;
            }
        }
        let id = match format {
            ModelDiscoveryFormat::Gemini => entry
                .get("baseModelId")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    entry
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .map(|value| value.strip_prefix("models/").unwrap_or(value))
                }),
            _ => entry.get("id").and_then(serde_json::Value::as_str),
        }
        .map(str::trim)
        .unwrap_or_default();
        if id.is_empty()
            || id.chars().count() > MAX_MODEL_ID_LENGTH
            || id.chars().any(char::is_control)
            || !seen.insert(id.to_string())
        {
            continue;
        }
        if models.len() == MAX_DISCOVERED_MODELS {
            truncated = true;
            break;
        }
        let display_name = entry
            .get(if format == ModelDiscoveryFormat::Gemini {
                "displayName"
            } else {
                "display_name"
            })
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
            .unwrap_or(id);
        let mut capabilities = unknown_capabilities();
        if format == ModelDiscoveryFormat::Gemini {
            if let Some(reasoning) = entry.get("thinking").and_then(serde_json::Value::as_bool) {
                capabilities.insert(
                    "reasoning".to_string(),
                    capability_value(if reasoning { "yes" } else { "no" }, "provider_response"),
                );
            }
        }
        models.push(AgentDiscoveredModel {
            id: id.to_string(),
            display_name: truncate_chars(display_name, MAX_NAME_LENGTH),
            model_type: capability_value("unknown", "unknown"),
            capabilities,
        });
    }
    models.sort_by(|left, right| {
        left.display_name
            .to_ascii_lowercase()
            .cmp(&right.display_name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok((models, truncated))
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn model_discovery_result(
    provider_id: &str,
    status: &str,
    models: Vec<AgentDiscoveredModel>,
    truncated: bool,
    message: &str,
    error_class: Option<&str>,
) -> AgentModelDiscoveryResponse {
    AgentModelDiscoveryResponse {
        status: status.to_string(),
        provider_id: provider_id.to_string(),
        models,
        truncated,
        message: message.to_string(),
        error_class: error_class.map(str::to_string),
    }
}

pub fn test_model(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
    agent_package: &Path,
    request: &AgentModelTestRequest,
    test_control: Option<&AgentModelTestControl>,
) -> Result<AgentLlmSettingsView> {
    let initial = {
        let _guard = settings_mutation_guard();
        verify_config_mutation(
            request.expected_revision,
            &request.expected_config_snapshot_id,
            ConfigMutationPolicy::DurableYaml,
        )?
    };
    let settings = initial
        .config
        .as_ref()
        .map(config_to_settings)
        .context("Create config.yaml before testing a model.")?;
    validate_settings(&settings)?;
    let test_model = settings
        .models
        .iter()
        .find(|model| model.id == request.model_id)
        .with_context(|| format!("Unknown model: {}", request.model_id))?;
    ensure!(
        test_model.model_type.value == "language",
        "Only language models use the text connection test. Image and embedding probes are not installed."
    );
    let resolved = resolve_model_with_settings(&settings, Some(&request.model_id))?;
    let probe_environment_names = provider_probe_environment_names(&settings);
    let credential_store = ConfigCredentialStore::from_config(
        initial
            .config
            .as_ref()
            .context("Create config.yaml before testing a model.")?,
    );
    let credential_override = credential_override_with_store(
        data_dir,
        &settings,
        &resolved.provider_id,
        &credential_store,
        Some(rscript),
        r_environ_user,
        "credential_test_read",
    )
    .map_err(|_| anyhow::anyhow!("The configured credential source is unavailable."))?;
    ensure!(
        credential_override.is_some() || !resolved.runtime_profile.api_key_required,
        "No API key is available for this provider."
    );
    let result = run_connection_test(
        rscript,
        agent_package,
        &resolved.runtime_profile,
        &probe_environment_names,
        credential_override.as_ref(),
        test_control,
    )?;
    let _guard = settings_mutation_guard();
    let latest = verify_config_mutation(
        request.expected_revision,
        &request.expected_config_snapshot_id,
        ConfigMutationPolicy::DurableYaml,
    )?;
    let mut latest_settings = latest
        .config
        .as_ref()
        .map(config_to_settings)
        .context("The canonical model configuration disappeared during the connection test.")?;
    validate_settings(&latest_settings)?;
    let latest_resolved = resolve_model_with_settings(&latest_settings, Some(&request.model_id))?;
    ensure!(
        latest_resolved.runtime_profile == resolved.runtime_profile,
        "The model configuration changed during the connection test; the test result was not saved."
    );
    update_model_after_test(&mut latest_settings, &request.model_id, &result)?;
    increment_revision(&mut latest_settings)?;
    commit_settings_mutation(latest, &latest_settings)?;
    // `settings_view` acquires this same non-reentrant process mutex. The CAS
    // has committed, so release the mutation guard before the read-back.
    after_settings_mutation(_guard, || settings_view(data_dir, rscript, r_environ_user))
}

pub fn resolve_model_for_turn(
    data_dir: &Path,
    requested_model_id: Option<&str>,
    mode: &str,
) -> Result<ResolvedAgentModel> {
    let settings = load_settings(data_dir)?;
    resolve_model_for_turn_with_settings(&settings, requested_model_id, mode)
}

pub fn resolve_model_for_task(
    data_dir: &Path,
    requested_model_id: Option<&str>,
    mode: &str,
    task_kind: &str,
) -> Result<ResolvedAgentModel> {
    let settings = load_settings(data_dir)?;
    resolve_model_for_task_with_settings(&settings, requested_model_id, mode, task_kind)
}

pub fn resolve_model_and_credential_for_turn(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
    requested_model_id: Option<&str>,
    mode: &str,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let _guard = settings_mutation_guard();
    let loaded = load_v6_document(data_dir)?;
    let settings = config_to_settings(&loaded.config);
    validate_settings(&settings)?;
    let credential_store = ConfigCredentialStore::from_config(&loaded.config);
    resolve_model_and_credential_for_turn_with_store(
        data_dir,
        &settings,
        requested_model_id,
        mode,
        &credential_store,
        Some(rscript),
        r_environ_user,
    )
}

pub fn resolve_model_and_credential_for_task(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
    requested_model_id: Option<&str>,
    mode: &str,
    task_kind: &str,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let _guard = settings_mutation_guard();
    let loaded = load_v6_document(data_dir)?;
    let settings = config_to_settings(&loaded.config);
    validate_settings(&settings)?;
    let credential_store = ConfigCredentialStore::from_config(&loaded.config);
    resolve_model_and_credential_for_task_with_store(
        data_dir,
        &settings,
        requested_model_id,
        mode,
        task_kind,
        &credential_store,
        Some(rscript),
        r_environ_user,
    )
}

fn resolve_model_and_credential_for_task_with_store(
    data_dir: &Path,
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
    mode: &str,
    task_kind: &str,
    credential_store: &impl CredentialStore,
    rscript: Option<&Path>,
    r_environ_user: Option<&Path>,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let resolved =
        resolve_model_for_task_with_settings(settings, requested_model_id, mode, task_kind)?;
    let credential = credential_override_with_store(
        data_dir,
        settings,
        &resolved.provider_id,
        credential_store,
        rscript,
        r_environ_user,
        "credential_turn_inject",
    )?;
    ensure!(
        !resolved.runtime_profile.api_key_required || credential.is_some(),
        "Problem repair is unavailable because the effective agent.act Provider credential is missing."
    );
    Ok((resolved, credential))
}

fn resolve_model_for_task_with_settings(
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
    mode: &str,
    task_kind: &str,
) -> Result<ResolvedAgentModel> {
    ensure!(
        task_kind == "problem_repair",
        "Unsupported typed Agent task."
    );
    ensure!(mode == "ask", "Problem repair must use read-only Ask mode.");
    let resolved = resolve_model_for_turn_with_settings(settings, requested_model_id, "act")
        .context(
            "Problem repair requires a compatible function-calling model on the effective agent.act route.",
        )?;
    Ok(resolved)
}

fn resolve_model_and_credential_for_turn_with_store(
    data_dir: &Path,
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
    mode: &str,
    credential_store: &impl CredentialStore,
    rscript: Option<&Path>,
    r_environ_user: Option<&Path>,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let resolved = resolve_model_for_turn_with_settings(settings, requested_model_id, mode)?;
    let credential = credential_override_with_store(
        data_dir,
        settings,
        &resolved.provider_id,
        credential_store,
        rscript,
        r_environ_user,
        "credential_turn_inject",
    )?;
    Ok((resolved, credential))
}

fn resolve_model_for_turn_with_settings(
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
    mode: &str,
) -> Result<ResolvedAgentModel> {
    validate_settings(settings)?;
    ensure!(
        matches!(mode, "ask" | "plan" | "act"),
        "Unsupported Agent mode."
    );
    let (target_id, resolved_route) = if mode == "act" {
        if let Some(route) = settings
            .capability_routes
            .iter()
            .find(|route| route.capability == "agent.act")
        {
            (route.model_id.as_str(), "agent.act")
        } else {
            (chat_model_id(settings)?, "agent.chat")
        }
    } else {
        (chat_model_id(settings)?, "agent.chat")
    };
    if let Some(requested) = requested_model_id {
        ensure!(
            requested == target_id,
            "Per-turn model overrides are unavailable. Assign the model to the effective capability route first."
        );
    }
    let resolved = resolve_model_id_with_settings(settings, target_id, resolved_route)?;
    if mode == "act" {
        ensure!(
            resolved.runtime_profile.tool_calling == "yes",
            "Act is unavailable because its effective model does not declare function_call=yes."
        );
    }
    Ok(resolved)
}

fn credential_override_with_store(
    data_dir: &Path,
    settings: &AgentLlmSettings,
    provider_id: &str,
    credential_store: &impl CredentialStore,
    rscript: Option<&Path>,
    r_environ_user: Option<&Path>,
    audit_event: &str,
) -> Result<Option<(String, String)>> {
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .with_context(|| format!("Unknown provider: {provider_id}"))?;
    if !provider.api_key_required {
        return Ok(None);
    }
    let resolved = resolve_provider_credential_with_runtime(
        settings,
        provider,
        credential_store,
        rscript,
        r_environ_user,
    );
    let source = resolved
        .as_ref()
        .map(|(_, source)| *source)
        .unwrap_or(CREDENTIAL_SOURCE_NOT_CONFIGURED);
    record_credential_audit(
        data_dir,
        audit_event,
        provider_id,
        source,
        match &resolved {
            Ok((Some(_), _)) => "detected",
            Ok((None, _)) => "not_detected",
            Err(_) => "unavailable",
        },
        None,
    );
    let (value, _) = resolved?;
    let Some(value) = value else {
        return Ok(None);
    };
    let env_name = provider
        .api_key_env
        .clone()
        .context("The provider has no API key environment name.")?;
    Ok(Some((env_name, value.as_str().to_string())))
}

fn provider_probe_environment_names(settings: &AgentLlmSettings) -> Vec<String> {
    let mut names = settings
        .providers
        .iter()
        .flat_map(|provider| {
            [
                provider.api_key_env.as_ref(),
                provider.base_url_env.as_ref(),
            ]
            .into_iter()
            .flatten()
            .cloned()
        })
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

pub fn validate_settings(settings: &AgentLlmSettings) -> Result<()> {
    ensure!(
        settings.schema_version == SETTINGS_SCHEMA_VERSION,
        "Unsupported Agent LLM schema version."
    );
    ensure!(
        !settings.providers.is_empty(),
        "At least one provider is required."
    );
    ensure!(
        !settings.models.is_empty(),
        "At least one model is required."
    );
    let mut provider_ids = HashSet::new();
    for provider in &settings.providers {
        validate_provider(provider)?;
        ensure!(
            provider_ids.insert(provider.id.clone()),
            "Provider IDs must be unique."
        );
    }
    let provider_map = settings
        .providers
        .iter()
        .map(|provider| (provider.id.as_str(), provider))
        .collect::<HashMap<_, _>>();
    let mut model_ids = HashSet::new();
    for model in &settings.models {
        validate_model(model)?;
        ensure!(
            model_ids.insert(model.id.clone()),
            "Model IDs must be unique."
        );
        ensure!(
            provider_map.contains_key(model.provider_id.as_str()),
            "Each model must reference an existing provider."
        );
    }
    ensure!(
        !settings.capability_routes.is_empty()
            && settings.capability_routes.len() <= MAX_CAPABILITY_ROUTES,
        "Agent LLM settings must contain between 1 and 32 capability routes."
    );
    let mut route_names = HashSet::new();
    for route in &settings.capability_routes {
        ensure!(
            route_names.insert(route.capability.clone()),
            "Capability route names must be unique."
        );
        validate_route_candidate(settings, route, false)?;
    }
    ensure!(
        settings
            .capability_routes
            .iter()
            .filter(|route| route.capability == "agent.chat")
            .count()
            == 1,
        "Exactly one agent.chat route is required."
    );
    Ok(())
}

fn standard_route_contract(capability: &str) -> Option<(&'static str, &'static [&'static str])> {
    match capability {
        "agent.chat" => Some(("language", &[])),
        "agent.act" => Some(("language", &["function_call"])),
        "vision.inspect" => Some(("language", &["vision_input"])),
        "image.generate" => Some(("image", &["image_output"])),
        "image.edit" => Some(("image", &["image_edit"])),
        "embedding.default" => Some(("embedding", &[])),
        _ => None,
    }
}

fn validate_capability_name(value: &str) -> Result<()> {
    validate_bounded(value, "Capability route", MAX_CAPABILITY_NAME_LENGTH)?;
    ensure!(
        value.chars().all(|character| character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-')),
        "Capability routes use lowercase canonical ASCII names."
    );
    ensure!(
        value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase()),
        "Capability routes must start with a lowercase letter."
    );
    Ok(())
}

fn validate_route_candidate(
    settings: &AgentLlmSettings,
    route: &AgentCapabilityRoute,
    reject_unknown: bool,
) -> Result<()> {
    validate_capability_name(&route.capability)?;
    validate_bounded(&route.model_id, "Route model ID", MAX_ID_LENGTH)?;
    ensure!(
        matches!(
            route.model_type.as_str(),
            "language" | "embedding" | "image"
        ),
        "Route model type must be language, embedding or image."
    );
    ensure!(
        route.required_model_capabilities.len() <= MAX_REQUIRED_CAPABILITIES,
        "A route may require at most 16 model capabilities."
    );
    let mut required = HashSet::new();
    for name in &route.required_model_capabilities {
        validate_capability_name(name)?;
        ensure!(
            capability_names().contains(&name.as_str()),
            "Unsupported required model capability: {name}"
        );
        ensure!(
            required.insert(name),
            "Required model capabilities must be unique."
        );
    }
    if let Some((model_type, capabilities)) = standard_route_contract(&route.capability) {
        ensure!(
            route.model_type == model_type,
            "The {} route requires model type {model_type}.",
            route.capability
        );
        ensure!(
            route.required_model_capabilities
                == capabilities
                    .iter()
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>(),
            "The {} route has a fixed capability contract.",
            route.capability
        );
    }
    let model = settings
        .models
        .iter()
        .find(|model| model.id == route.model_id)
        .with_context(|| format!("Unknown route model: {}", route.model_id))?;
    ensure!(model.enabled, "Capability routes require an enabled model.");
    ensure!(
        model.model_type.value == "unknown" || model.model_type.value == route.model_type,
        "The selected model type is incompatible with this route."
    );
    if reject_unknown {
        ensure!(
            model.model_type.value != "unknown",
            "Declare this model's type before assigning the route."
        );
    }
    for name in &route.required_model_capabilities {
        let value = model_capability(model, name);
        ensure!(
            value.value != "no",
            "The selected model is incompatible with required capability {name}."
        );
        if reject_unknown {
            ensure!(
                value.value == "yes",
                "Declare required capability {name} before assigning the route."
            );
        }
    }
    Ok(())
}

fn system_credential_info() -> AgentUserEnvironInfo {
    AgentUserEnvironInfo {
        path: String::new(),
        source: "system".to_string(),
    }
}

fn build_settings_view(
    settings: AgentLlmSettings,
    user_environ: AgentUserEnvironInfo,
    statuses: HashMap<String, CredentialPresentation>,
    config_store: AgentConfigStoreView,
) -> AgentLlmSettingsView {
    let selected_model_id = chat_model_id(&settings).unwrap_or_default().to_string();
    let provider_map = settings
        .providers
        .iter()
        .map(|provider| (provider.id.clone(), provider.display_name.clone()))
        .collect::<HashMap<_, _>>();
    let providers = settings
        .providers
        .iter()
        .cloned()
        .map(|profile| {
            let credential = statuses
                .get(&profile.id)
                .cloned()
                .unwrap_or_else(|| credential_presentation_for_provider(&profile));
            let (effective_base_url, base_url_source) = provider_base_url_presentation(&profile);
            AgentProviderProfileView {
                credential_status: credential.status,
                credential_effective_source: credential.source,
                env_shadows_file: credential.env_shadows_file,
                session_credential_present: credential.session_present,
                config_file_credential_present: credential.config_file_present,
                effective_base_url,
                base_url_source,
                profile,
            }
        })
        .collect::<Vec<_>>();
    let models = settings
        .models
        .iter()
        .cloned()
        .map(|profile| {
            let selector_status = selector_status(&profile, &statuses, &settings.providers);
            AgentModelProfileView {
                provider_display_name: provider_map
                    .get(&profile.provider_id)
                    .cloned()
                    .unwrap_or_else(|| "Provider".to_string()),
                selected: profile.id == selected_model_id,
                act_enabled: profile.enabled && model_function_call(&profile) == "yes",
                selector_status,
                profile,
            }
        })
        .collect::<Vec<_>>();
    let selected_model =
        models
            .iter()
            .find(|model| model.selected)
            .map(|model| AgentSelectedModelView {
                id: model.profile.id.clone(),
                display_name: model.profile.display_name.clone(),
                provider_display_name: model.provider_display_name.clone(),
                selector_status: model.selector_status.clone(),
                tool_calling: model_function_call(&model.profile).to_string(),
                act_enabled: model.act_enabled,
            });
    let capability_routes = build_capability_route_views(&settings, &statuses);
    AgentLlmSettingsView {
        schema_version: settings.schema_version,
        revision: settings.revision,
        selected_model_id,
        providers,
        models,
        selected_model,
        capability_routes,
        user_environ,
        config_store,
        validation_error: None,
    }
}

/// Projects a parseable V6 document that failed semantic validation. This
/// path deliberately does not probe process/user environments, resolve
/// credentials, or call helpers whose `unreachable!` branches rely on a
/// complete validated capability vocabulary. The raw profiles remain visible
/// beside `validation_error` so the operator can repair config.yaml directly.
fn build_invalid_settings_view(
    settings: AgentLlmSettings,
    user_environ: AgentUserEnvironInfo,
    config: Option<&agent_config::AgentConfig>,
    config_store: AgentConfigStoreView,
    validation_error: String,
) -> AgentLlmSettingsView {
    let selected_model_id = settings
        .capability_routes
        .iter()
        .find(|route| route.capability == "agent.chat")
        .map(|route| route.model_id.clone())
        .unwrap_or_default();
    let provider_map = settings
        .providers
        .iter()
        .map(|provider| (provider.id.clone(), provider.display_name.clone()))
        .collect::<HashMap<_, _>>();
    let providers = settings
        .providers
        .iter()
        .cloned()
        .map(|profile| {
            let session_present = credential_session().has_session_credential(&profile.id);
            let config_file_present = config
                .and_then(|config| {
                    config
                        .providers
                        .iter()
                        .find(|provider| provider.id == profile.id)
                })
                .and_then(|provider| provider.api_key.as_deref())
                .is_some_and(|value| !value.is_empty());
            let (effective_base_url, base_url_source) = if let Some(base_url) = &profile.base_url {
                (Some(base_url.clone()), "configured".to_string())
            } else if let Some(environment_name) = &profile.base_url_env {
                (
                    Some(format!("${environment_name}")),
                    "environment".to_string(),
                )
            } else {
                match provider_default_base_url(&profile) {
                    Some(base_url) => (Some(base_url.to_string()), "provider_default".to_string()),
                    None => (None, "not_configured".to_string()),
                }
            };
            AgentProviderProfileView {
                credential_status: if profile.api_key_required {
                    "unavailable"
                } else {
                    "not_required"
                }
                .to_string(),
                credential_effective_source: if profile.api_key_required {
                    "unchecked"
                } else {
                    "not_required"
                }
                .to_string(),
                env_shadows_file: false,
                session_credential_present: session_present,
                config_file_credential_present: config_file_present,
                effective_base_url,
                base_url_source,
                profile,
            }
        })
        .collect::<Vec<_>>();
    let models = settings
        .models
        .iter()
        .cloned()
        .map(|profile| AgentModelProfileView {
            provider_display_name: provider_map
                .get(&profile.provider_id)
                .cloned()
                .unwrap_or_else(|| "Provider".to_string()),
            selected: profile.id == selected_model_id,
            selector_status: "Error".to_string(),
            act_enabled: false,
            profile,
        })
        .collect::<Vec<_>>();
    let selected_model =
        models
            .iter()
            .find(|model| model.selected)
            .map(|model| AgentSelectedModelView {
                id: model.profile.id.clone(),
                display_name: model.profile.display_name.clone(),
                provider_display_name: model.provider_display_name.clone(),
                selector_status: model.selector_status.clone(),
                tool_calling: model
                    .profile
                    .capabilities
                    .get("function_call")
                    .map(|value| value.value.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                act_enabled: false,
            });
    let capability_routes = settings
        .capability_routes
        .iter()
        .map(|route| {
            let model = settings
                .models
                .iter()
                .find(|model| model.id == route.model_id);
            let provider = model.and_then(|model| {
                settings
                    .providers
                    .iter()
                    .find(|provider| provider.id == model.provider_id)
            });
            AgentCapabilityRouteView {
                capability: route.capability.clone(),
                label: route.capability.clone(),
                description: "Invalid configuration; edit config.yaml and reload Settings."
                    .to_string(),
                model_id: Some(route.model_id.clone()),
                model_display_name: model.map(|model| model.display_name.clone()),
                provider_display_name: provider.map(|provider| provider.display_name.clone()),
                model_type: route.model_type.clone(),
                required_model_capabilities: route.required_model_capabilities.clone(),
                configured: true,
                inherited_from: None,
                compatibility: "invalid_config".to_string(),
                credential_status: "unavailable".to_string(),
                consumer_status: "unavailable".to_string(),
            }
        })
        .collect();
    AgentLlmSettingsView {
        schema_version: settings.schema_version,
        revision: settings.revision,
        selected_model_id,
        providers,
        models,
        selected_model,
        capability_routes,
        user_environ,
        config_store,
        validation_error: Some(validation_error),
    }
}

fn build_capability_route_views(
    settings: &AgentLlmSettings,
    statuses: &HashMap<String, CredentialPresentation>,
) -> Vec<AgentCapabilityRouteView> {
    let standard = [
        ("agent.chat", "Chat", "Ask and Plan turns"),
        ("agent.act", "Act", "Tool-enabled Act turns"),
        ("vision.inspect", "Inspect images", "Consumer not installed"),
        (
            "image.generate",
            "Generate images",
            "Consumer not installed",
        ),
        ("image.edit", "Edit images", "Consumer not installed"),
        ("embedding.default", "Embeddings", "Consumer not installed"),
    ];
    let chat_route = settings
        .capability_routes
        .iter()
        .find(|route| route.capability == "agent.chat");
    let mut views = standard
        .iter()
        .map(|(capability, label, description)| {
            let configured = settings
                .capability_routes
                .iter()
                .find(|route| route.capability == *capability);
            let inherited = if configured.is_none() && *capability == "agent.act" {
                chat_route
            } else {
                None
            };
            let effective = configured.or(inherited);
            build_capability_route_view(
                settings,
                statuses,
                capability,
                label,
                description,
                configured,
                effective,
                inherited.map(|_| "agent.chat".to_string()),
            )
        })
        .collect::<Vec<_>>();
    for route in settings.capability_routes.iter().filter(|route| {
        !standard
            .iter()
            .any(|(capability, _, _)| *capability == route.capability)
    }) {
        views.push(build_capability_route_view(
            settings,
            statuses,
            &route.capability,
            &route.capability,
            "Custom route; unavailable until a typed consumer is registered",
            Some(route),
            Some(route),
            None,
        ));
    }
    views
}

#[allow(clippy::too_many_arguments)]
fn build_capability_route_view(
    settings: &AgentLlmSettings,
    statuses: &HashMap<String, CredentialPresentation>,
    capability: &str,
    label: &str,
    description: &str,
    configured: Option<&AgentCapabilityRoute>,
    effective: Option<&AgentCapabilityRoute>,
    inherited_from: Option<String>,
) -> AgentCapabilityRouteView {
    let model = effective.and_then(|route| {
        settings
            .models
            .iter()
            .find(|model| model.id == route.model_id)
    });
    let provider = model.and_then(|model| {
        settings
            .providers
            .iter()
            .find(|provider| provider.id == model.provider_id)
    });
    let required = standard_route_contract(capability)
        .map(|(_, values)| values.iter().map(|value| value.to_string()).collect())
        .or_else(|| effective.map(|route| route.required_model_capabilities.clone()))
        .unwrap_or_default();
    let expected_type = standard_route_contract(capability)
        .map(|(value, _)| value.to_string())
        .or_else(|| effective.map(|route| route.model_type.clone()))
        .unwrap_or_else(|| "unknown".to_string());
    let compatibility = match model {
        None => "unassigned",
        Some(model)
            if model.model_type.value != "unknown" && model.model_type.value != expected_type =>
        {
            "incompatible"
        }
        Some(model)
            if required
                .iter()
                .any(|name| model_capability(model, name).value == "no") =>
        {
            "incompatible"
        }
        Some(model)
            if model.model_type.value == "unknown"
                || required
                    .iter()
                    .any(|name| model_capability(model, name).value == "unknown") =>
        {
            "needs_review"
        }
        Some(_) => "compatible",
    };
    let credential_status = provider
        .and_then(|provider| statuses.get(&provider.id))
        .map(|status| status.status.clone())
        .unwrap_or_else(|| "unavailable".to_string());
    AgentCapabilityRouteView {
        capability: capability.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        model_id: model.map(|model| model.id.clone()),
        model_display_name: model.map(|model| model.display_name.clone()),
        provider_display_name: provider.map(|provider| provider.display_name.clone()),
        model_type: expected_type,
        required_model_capabilities: required,
        configured: configured.is_some(),
        inherited_from,
        compatibility: compatibility.to_string(),
        credential_status,
        consumer_status: if matches!(capability, "agent.chat" | "agent.act") {
            "available".to_string()
        } else {
            "not_installed".to_string()
        },
    }
}

fn resolve_model_with_settings(
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
) -> Result<ResolvedAgentModel> {
    let target_id = match requested_model_id {
        Some(value) => value,
        None => chat_model_id(settings)?,
    };
    resolve_model_id_with_settings(settings, target_id, "agent.chat")
}

fn resolve_model_id_with_settings(
    settings: &AgentLlmSettings,
    target_id: &str,
    route_capability: &str,
) -> Result<ResolvedAgentModel> {
    let model = settings
        .models
        .iter()
        .find(|item| item.id == target_id)
        .with_context(|| format!("Unknown Agent model: {target_id}"))?;
    ensure!(model.enabled, "Selected Agent model is disabled.");
    let provider = settings
        .providers
        .iter()
        .find(|item| item.id == model.provider_id)
        .with_context(|| format!("Missing provider for Agent model {}", model.display_name))?;
    let runtime_provider_id = format!(
        "rho_profile_provider_{}",
        provider
            .id
            .chars()
            .map(|value| if value.is_ascii_alphanumeric() {
                value
            } else {
                '_'
            })
            .collect::<String>()
    );
    let effective_model_ref = if provider.kind == "registered" {
        format!(
            "{}:{}",
            provider
                .registered_provider_id
                .as_deref()
                .context("Registered providers require a registered provider ID.")?,
            model.model_id
        )
    } else {
        format!("{runtime_provider_id}:{}", model.model_id)
    };
    let (route_model_type, required_model_capabilities) = settings
        .capability_routes
        .iter()
        .find(|route| route.capability == route_capability && route.model_id == model.id)
        .map(|route| {
            (
                route.model_type.clone(),
                route.required_model_capabilities.clone(),
            )
        })
        .unwrap_or_else(|| (model.model_type.value.clone(), Vec::new()));
    let runtime_profile = AgentRuntimeModelProfile {
        settings_revision: settings.revision,
        route_capability: route_capability.to_string(),
        profile_id: model.id.clone(),
        provider_kind: provider.kind.clone(),
        runtime_provider_id: runtime_provider_id.clone(),
        registered_provider_id: provider.registered_provider_id.clone(),
        model_id: model.model_id.clone(),
        api_key_env: provider.api_key_env.clone(),
        api_key_required: provider.api_key_required,
        base_url: provider.base_url.clone(),
        base_url_env: provider.base_url_env.clone(),
        wire_api: provider.wire_api.clone(),
        disable_stream_options: provider.disable_stream_options.unwrap_or(false),
        tool_calling: model_function_call(model).to_string(),
        provider_display_name: provider.display_name.clone(),
        model_display_name: model.display_name.clone(),
        context_window_tokens: model.context_window_tokens,
        reserved_output_tokens: model.reserved_output_tokens,
        context_capacity_source: model.context_capacity_source.clone(),
        capability_routes: vec![AgentRuntimeCapabilityRoute {
            capability: route_capability.to_string(),
            model: effective_model_ref.clone(),
            model_type: route_model_type,
            required_model_capabilities,
        }],
        plugin_tools: Vec::new(),
    };
    let mut credential_environment_names = settings
        .providers
        .iter()
        .filter_map(|provider| provider.api_key_env.clone())
        .collect::<Vec<_>>();
    credential_environment_names.sort();
    credential_environment_names.dedup();
    Ok(ResolvedAgentModel {
        settings_revision: settings.revision,
        route_capability: route_capability.to_string(),
        effective_model_ref,
        runtime_profile,
        credential_environment_names,
        provider_id: provider.id.clone(),
        provider_display_name: provider.display_name.clone(),
        model_display_name: model.display_name.clone(),
    })
}

fn update_model_after_test(
    settings: &mut AgentLlmSettings,
    model_id: &str,
    result: &AgentConnectionTestResponse,
) -> Result<()> {
    let model = settings
        .models
        .iter_mut()
        .find(|item| item.id == model_id)
        .with_context(|| format!("Unknown model: {model_id}"))?;
    model.last_test = Some(AgentModelTestResult {
        status: result.status.clone(),
        checked_at: Utc::now().to_rfc3339(),
        latency_ms: result.latency_ms,
        error_class: result.error_class.clone(),
        message: Some(result.message.clone()),
    });
    for (name, value) in [
        ("function_call", result.capabilities.tool_calling.as_str()),
        ("reasoning", result.capabilities.reasoning.as_str()),
        ("vision_input", result.capabilities.vision_input.as_str()),
    ] {
        if model_capability(model, name).source != "user_declared" {
            let source = if value == "unknown" {
                "unknown"
            } else {
                "provider_response"
            };
            model
                .capabilities
                .insert(name.to_string(), capability_value(value, source));
        }
    }
    Ok(())
}

fn validate_provider(provider: &AgentProviderProfile) -> Result<()> {
    validate_bounded(&provider.id, "Provider ID", MAX_ID_LENGTH)?;
    validate_bounded(
        &provider.display_name,
        "Provider display name",
        MAX_NAME_LENGTH,
    )?;
    ensure!(
        matches!(
            provider.kind.as_str(),
            "registered"
                | "openai"
                | "anthropic"
                | "gemini"
                | "openai_compatible"
                | "local_openai_compatible"
        ),
        "Unsupported provider type."
    );
    if provider.kind == "registered" {
        validate_optional_bounded(
            provider.registered_provider_id.as_deref(),
            "Registered provider ID",
            MAX_NAME_LENGTH,
        )?;
        ensure!(
            provider.registered_provider_id.is_some(),
            "Registered providers require a provider ID."
        );
        if provider.base_url.is_some() || provider.base_url_env.is_some() {
            ensure!(
                reviewed_registered_provider_id(provider).is_some(),
                "Base URL overrides are available only for reviewed registered providers."
            );
        }
    }
    validate_env_name(provider.api_key_env.as_deref(), provider.api_key_required)?;
    validate_env_name(provider.base_url_env.as_deref(), false)?;
    validate_base_url(provider.base_url.as_deref())?;
    ensure!(
        !(provider.base_url.is_some() && provider.base_url_env.is_some()),
        "Use either Base URL or Base URL environment, not both."
    );
    if matches!(
        provider.kind.as_str(),
        "openai_compatible" | "local_openai_compatible"
    ) {
        ensure!(
            provider.base_url.is_some() || provider.base_url_env.is_some(),
            "Compatible providers require a base URL source."
        );
        ensure!(
            matches!(
                provider.wire_api.as_deref(),
                Some("chat_completions") | Some("responses") | Some("anthropic_messages")
            ),
            "Compatible providers require a supported wire API."
        );
    } else {
        ensure!(
            matches!(
                provider.wire_api.as_deref(),
                None | Some("chat_completions") | Some("responses") | Some("anthropic_messages")
            ),
            "Built-in providers accept only a bounded optional Base URL override and supported wire API."
        );
    }
    Ok(())
}

fn validate_model(model: &AgentModelProfile) -> Result<()> {
    validate_bounded(&model.id, "Model ID", MAX_ID_LENGTH)?;
    validate_bounded(&model.provider_id, "Provider reference", MAX_ID_LENGTH)?;
    validate_bounded(&model.display_name, "Model display name", MAX_NAME_LENGTH)?;
    validate_bounded(&model.model_id, "Provider model ID", MAX_MODEL_ID_LENGTH)?;
    validate_capability_value(&model.model_type, true)?;
    ensure!(
        matches!(
            model.model_type.value.as_str(),
            "language" | "embedding" | "image" | "unknown"
        ),
        "Model type must be language, embedding, image or unknown."
    );
    ensure!(
        model.capabilities.len() == capability_names().len()
            && capability_names()
                .iter()
                .all(|name| model.capabilities.contains_key(*name)),
        "Model capabilities must use the complete supported vocabulary."
    );
    for (name, value) in &model.capabilities {
        ensure!(
            capability_names().contains(&name.as_str()),
            "Unsupported model capability: {name}"
        );
        validate_capability_value(value, false)?;
    }
    ensure!(
        model.context_window_tokens >= 4_096,
        "Model context window must be at least 4,096 tokens."
    );
    ensure!(
        model.reserved_output_tokens >= 256
            && model.reserved_output_tokens < model.context_window_tokens,
        "Reserved output tokens must be at least 256 and smaller than the context window."
    );
    ensure!(
        matches!(
            model.context_capacity_source.as_str(),
            "catalog" | "user_declared" | "conservative_default"
        ),
        "Context capacity provenance is unsupported."
    );
    Ok(())
}

fn validate_capability_value(value: &AgentCapabilityValue, model_type: bool) -> Result<()> {
    if !model_type {
        ensure!(
            matches!(value.value.as_str(), "yes" | "no" | "unknown"),
            "Capability values must be yes, no or unknown."
        );
    }
    ensure!(
        matches!(
            value.source.as_str(),
            "aisdk_catalog" | "provider_response" | "user_declared" | "unknown"
        ),
        "Capability provenance is unsupported."
    );
    ensure!(
        value.value != "unknown" || value.source == "unknown" || value.source == "user_declared",
        "Unknown values require unknown or user-declared provenance."
    );
    Ok(())
}

fn validate_bounded(value: &str, label: &str, max: usize) -> Result<()> {
    ensure!(!value.trim().is_empty(), "{label} must not be empty.");
    ensure!(value.chars().count() <= max, "{label} is too long.");
    Ok(())
}

fn validate_optional_bounded(value: Option<&str>, label: &str, max: usize) -> Result<()> {
    if let Some(value) = value {
        validate_bounded(value, label, max)?;
    }
    Ok(())
}

fn validate_env_name(value: Option<&str>, required: bool) -> Result<()> {
    let value = value.unwrap_or("").trim();
    if value.is_empty() {
        ensure!(!required, "Missing required environment variable name.");
        return Ok(());
    }
    let mut chars = value.chars();
    let first = chars
        .next()
        .context("Environment variable name is empty.")?;
    ensure!(
        first == '_' || first.is_ascii_alphabetic(),
        "Environment variable names must start with a letter or underscore."
    );
    ensure!(
        chars.all(|character| character == '_' || character.is_ascii_alphanumeric()),
        "Environment variable names may contain only letters, digits and underscores."
    );
    Ok(())
}

fn validate_base_url(value: Option<&str>) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let value = value.trim();
    validate_bounded(value, "Base URL", MAX_URL_LENGTH)?;
    ensure!(
        value.starts_with("http://") || value.starts_with("https://"),
        "Base URLs must use http or https."
    );
    let without_scheme = value
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    let authority = without_scheme.split('/').next().unwrap_or_default();
    ensure!(
        !authority.contains('@'),
        "Base URLs must not contain user information."
    );
    if let Some((_, query)) = value.split_once('?') {
        let lowered = query.to_ascii_lowercase();
        for marker in ["key=", "token=", "secret=", "password=", "authorization="] {
            ensure!(
                !lowered.contains(marker),
                "Put signed or secret-bearing endpoints in an environment variable."
            );
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CredentialPresentation {
    status: String,
    source: String,
    env_shadows_file: bool,
    session_present: bool,
    config_file_present: bool,
}

fn credential_status_map(
    providers: &[AgentProviderProfile],
    config: Option<&agent_config::AgentConfig>,
    rscript: &Path,
    r_environ_user: Option<&Path>,
) -> HashMap<String, CredentialPresentation> {
    let declared_sensitive_names = providers
        .iter()
        .filter_map(|provider| provider.api_key_env.clone())
        .filter(|name| !name.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    let user_presence_variables = if r_environ_user.is_some() {
        providers
            .iter()
            .filter(|provider| {
                provider.api_key_required
                    && !credential_session().has_session_credential(&provider.id)
                    && !environment_credential_present(provider)
            })
            .filter_map(|provider| provider.api_key_env.clone())
            .filter(|name| !name.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
    } else {
        std::collections::BTreeSet::new()
    };
    let user_environment_presence = match r_environ_user {
        Some(r_environ_user) => agent_config_environ::user_environ_credentials_present(
            rscript,
            r_environ_user,
            &user_presence_variables,
            &declared_sensitive_names,
        ),
        None => Ok(BTreeMap::new()),
    };
    providers
        .iter()
        .map(|provider| {
            let session_present = credential_session().has_session_credential(&provider.id);
            let process_environment_present = environment_credential_present(provider);
            let queried_user_environment = provider
                .api_key_env
                .as_ref()
                .is_some_and(|name| user_presence_variables.contains(name));
            let user_environment_present = provider
                .api_key_env
                .as_ref()
                .and_then(|name| user_environment_presence.as_ref().ok()?.get(name))
                .copied()
                .unwrap_or(false);
            let user_environment_unavailable =
                queried_user_environment && user_environment_presence.is_err();
            let environment_present = process_environment_present || user_environment_present;
            let config_file_present = config
                .and_then(|config| {
                    config
                        .providers
                        .iter()
                        .find(|candidate| candidate.id == provider.id)
                })
                .and_then(|provider| provider.api_key.as_deref())
                .is_some_and(|value| !value.is_empty());
            let source = if !provider.api_key_required {
                "not_required"
            } else if session_present {
                CREDENTIAL_SOURCE_SESSION
            } else if environment_present {
                CREDENTIAL_SOURCE_ENVIRONMENT
            } else if user_environment_unavailable {
                CREDENTIAL_SOURCE_NOT_CONFIGURED
            } else if config_file_present {
                CREDENTIAL_SOURCE_CONFIG_FILE
            } else {
                CREDENTIAL_SOURCE_NOT_CONFIGURED
            };
            let presentation = CredentialPresentation {
                status: if !provider.api_key_required {
                    "not_required"
                } else if user_environment_unavailable {
                    "unavailable"
                } else if session_present || environment_present || config_file_present {
                    "detected"
                } else {
                    "not_detected"
                }
                .to_string(),
                source: source.to_string(),
                env_shadows_file: environment_present && config_file_present && !session_present,
                session_present,
                config_file_present,
            };
            (provider.id.clone(), presentation)
        })
        .collect()
}

fn selector_status(
    model: &AgentModelProfile,
    statuses: &HashMap<String, CredentialPresentation>,
    providers: &[AgentProviderProfile],
) -> String {
    if !model.enabled {
        return "Disabled".to_string();
    }
    let Some(provider) = providers.iter().find(|item| item.id == model.provider_id) else {
        return "Error".to_string();
    };
    let credential_status = statuses
        .get(&provider.id)
        .map(|status| status.status.clone())
        .unwrap_or_else(|| credential_label_for_provider(provider));
    if matches!(credential_status.as_str(), "not_detected" | "unavailable")
        && provider.api_key_required
    {
        return "Key missing".to_string();
    }
    if let Some(last_test) = &model.last_test {
        if last_test.status == "ready" {
            return "Ready".to_string();
        }
        if last_test.status == "error" {
            return "Error".to_string();
        }
    }
    "Untested".to_string()
}

fn credential_label_for_provider(provider: &AgentProviderProfile) -> String {
    if !provider.api_key_required {
        "not_required".to_string()
    } else {
        "unchecked".to_string()
    }
}

fn credential_presentation_for_provider(provider: &AgentProviderProfile) -> CredentialPresentation {
    CredentialPresentation {
        status: credential_label_for_provider(provider),
        source: if provider.api_key_required {
            "unchecked".to_string()
        } else {
            "not_required".to_string()
        },
        env_shadows_file: false,
        session_present: false,
        config_file_present: false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RProbeFailureDisclosure {
    BoundedDiagnostic,
    SuppressDiagnostic,
}

struct RProbeRequest<'a> {
    args: &'a [String],
    user_environ: Option<&'a str>,
    stdin: Option<String>,
    scrub_environment_names: &'a [String],
    environment_overrides: &'a [(&'a str, &'a str)],
    failure_disclosure: RProbeFailureDisclosure,
    test_control: Option<&'a AgentModelTestControl>,
}

struct BoundedPipeOutput {
    bytes: Zeroizing<Vec<u8>>,
    truncated: bool,
}

fn drain_bounded<R: Read>(mut reader: R, limit: usize) -> io::Result<BoundedPipeOutput> {
    // Allocate the fixed retention budget once. Growing a Zeroizing<Vec<_>>
    // would let Vec free prior allocations without clearing their contents.
    let mut bytes = Zeroizing::new(Vec::with_capacity(limit));
    let mut truncated = false;
    let mut chunk = Zeroizing::new([0_u8; 8 * 1024]);
    loop {
        let count = reader.read(&mut *chunk)?;
        if count == 0 {
            break;
        }
        let retained = limit.saturating_sub(bytes.len()).min(count);
        bytes.extend_from_slice(&chunk[..retained]);
        truncated |= retained < count;
    }
    chunk.zeroize();
    Ok(BoundedPipeOutput { bytes, truncated })
}

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "kill"]
    fn unix_kill_process(pid: i32, signal: i32) -> i32;
}

#[cfg(unix)]
fn signal_r_probe_process_group(pid: u32, signal: i32) -> Result<bool> {
    let process_group = i32::try_from(pid).context("Rscript process id exceeds pid_t")?;
    let result = unsafe { unix_kill_process(-process_group, signal) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(3) {
        Ok(false)
    } else {
        Err(error).with_context(|| format!("signalling Rscript process group {process_group}"))
    }
}

#[cfg(unix)]
fn r_probe_process_group_exists(pid: u32) -> Result<bool> {
    signal_r_probe_process_group(pid, 0)
}

#[cfg(unix)]
fn terminate_r_probe_process_group(pid: u32) -> Result<()> {
    if !signal_r_probe_process_group(pid, 15)? {
        return Ok(());
    }
    let deadline = Instant::now() + R_PROBE_TERMINATION_GRACE;
    while Instant::now() < deadline {
        if !r_probe_process_group_exists(pid)? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = signal_r_probe_process_group(pid, 9)?;
    Ok(())
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct JobObjectIoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: JobObjectIoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct ThreadEntry32 {
    size: u32,
    usage_count: u32,
    thread_id: u32,
    owner_process_id: u32,
    base_priority: i32,
    priority_delta: i32,
    flags: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(
        attributes: *const std::ffi::c_void,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn SetInformationJobObject(
        job: *mut std::ffi::c_void,
        information_class: i32,
        information: *const std::ffi::c_void,
        information_length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: *mut std::ffi::c_void, process: *mut std::ffi::c_void) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut std::ffi::c_void;
    fn Thread32First(snapshot: *mut std::ffi::c_void, entry: *mut ThreadEntry32) -> i32;
    fn Thread32Next(snapshot: *mut std::ffi::c_void, entry: *mut ThreadEntry32) -> i32;
    fn OpenThread(
        desired_access: u32,
        inherit_handle: i32,
        thread_id: u32,
    ) -> *mut std::ffi::c_void;
    fn ResumeThread(thread: *mut std::ffi::c_void) -> u32;
    fn TerminateJobObject(job: *mut std::ffi::c_void, exit_code: u32) -> i32;
    fn CloseHandle(object: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
struct WindowsOwnedHandle(*mut std::ffi::c_void);

#[cfg(windows)]
impl Drop for WindowsOwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
struct WindowsRProbeJob {
    handle: WindowsOwnedHandle,
}

#[cfg(windows)]
impl WindowsRProbeJob {
    fn new() -> Result<Self> {
        const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

        let information_length =
            u32::try_from(std::mem::size_of::<JobObjectExtendedLimitInformation>())
                .context("Rscript Job Object configuration is too large")?;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        ensure!(!handle.is_null(), "creating Rscript Job Object failed");
        let handle = WindowsOwnedHandle(handle);
        let mut information: JobObjectExtendedLimitInformation = unsafe { std::mem::zeroed() };
        information.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.0,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                std::ptr::addr_of!(information).cast(),
                information_length,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error()).context("configuring Rscript Job Object");
        }
        Ok(Self { handle })
    }

    fn assign(&self, child: &Child) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        let assigned = unsafe {
            AssignProcessToJobObject(
                self.handle.0,
                child.as_raw_handle().cast::<std::ffi::c_void>(),
            )
        };
        if assigned == 0 {
            Err(io::Error::last_os_error()).context("assigning Rscript to Job Object")
        } else {
            Ok(())
        }
    }

    fn resume(&self, child: &Child) -> Result<()> {
        const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
        const THREAD_SUSPEND_RESUME: u32 = 0x0000_0002;
        const ERROR_NO_MORE_FILES: i32 = 18;
        const INVALID_HANDLE_VALUE: *mut std::ffi::c_void = (-1_isize) as *mut std::ffi::c_void;
        const RESUME_FAILED: u32 = u32::MAX;

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        ensure!(
            snapshot != INVALID_HANDLE_VALUE,
            "enumerating suspended Rscript threads failed"
        );
        let snapshot = WindowsOwnedHandle(snapshot);
        let mut entry: ThreadEntry32 = unsafe { std::mem::zeroed() };
        entry.size = u32::try_from(std::mem::size_of::<ThreadEntry32>())
            .context("Rscript thread descriptor is too large")?;
        if unsafe { Thread32First(snapshot.0, &mut entry) } == 0 {
            return Err(io::Error::last_os_error())
                .context("enumerating suspended Rscript threads");
        }

        let mut resumed = false;
        loop {
            if entry.owner_process_id == child.id() {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.thread_id) };
                ensure!(!thread.is_null(), "opening suspended Rscript thread failed");
                let thread = WindowsOwnedHandle(thread);
                let previous = unsafe { ResumeThread(thread.0) };
                if previous == RESUME_FAILED {
                    return Err(io::Error::last_os_error())
                        .context("resuming suspended Rscript thread");
                }
                ensure!(
                    previous == 1,
                    "suspended Rscript thread had an unexpected suspend count"
                );
                resumed = true;
            }

            if unsafe { Thread32Next(snapshot.0, &mut entry) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_MORE_FILES) {
                    break;
                }
                return Err(error).context("enumerating suspended Rscript threads");
            }
        }
        ensure!(resumed, "the suspended Rscript thread was not found");
        Ok(())
    }

    fn terminate(&self) -> Result<()> {
        let terminated = unsafe { TerminateJobObject(self.handle.0, 1) };
        if terminated == 0 {
            Err(io::Error::last_os_error()).context("terminating Rscript Job Object")
        } else {
            Ok(())
        }
    }
}

struct RProbeProcessContainment {
    #[cfg(windows)]
    job: WindowsRProbeJob,
}

impl RProbeProcessContainment {
    fn new() -> Result<Self> {
        Ok(Self {
            #[cfg(windows)]
            job: WindowsRProbeJob::new()?,
        })
    }

    fn attach_and_start(&self, child: &Child) -> Result<()> {
        #[cfg(windows)]
        {
            self.job.assign(child)?;
            self.job.resume(child)?;
        }
        #[cfg(not(windows))]
        let _ = child;
        Ok(())
    }

    fn terminate(&self, _pid: u32) -> Result<()> {
        #[cfg(unix)]
        terminate_r_probe_process_group(_pid)?;
        #[cfg(windows)]
        self.job.terminate()?;
        #[cfg(not(any(unix, windows)))]
        let _ = _pid;
        Ok(())
    }
}

fn configure_r_probe_process_containment(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = command;
}

fn join_r_probe_thread<T>(
    thread: std::thread::JoinHandle<T>,
    label: &'static str,
) -> Result<std::thread::Result<T>> {
    let deadline = Instant::now() + R_PROBE_PIPE_JOIN_TIMEOUT;
    while !thread.is_finished() {
        ensure!(Instant::now() < deadline, "timed out waiting for {label}");
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(thread.join())
}

struct RProbeChildGuard<'a> {
    child: Child,
    pid: u32,
    containment: RProbeProcessContainment,
    test_control: Option<&'a AgentModelTestControl>,
    reaped: bool,
    containment_terminated: bool,
    control_cleared: bool,
}

impl<'a> RProbeChildGuard<'a> {
    fn new(
        child: Child,
        containment: RProbeProcessContainment,
        test_control: Option<&'a AgentModelTestControl>,
    ) -> Result<Self> {
        let pid = child.id();
        let guard = Self {
            child,
            pid,
            containment,
            test_control,
            reaped: false,
            containment_terminated: false,
            control_cleared: false,
        };
        guard.containment.attach_and_start(&guard.child)?;
        if let Some(control) = test_control {
            let mut state = control
                .lock()
                .map_err(|_| anyhow::anyhow!("locking Agent model test state"))?;
            state.pid = Some(pid);
            state.cancel_requested = false;
        }
        Ok(guard)
    }

    fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>> {
        let status = self
            .child
            .try_wait()
            .context("checking Rscript JSON probe status")?;
        if status.is_some() {
            self.reaped = true;
        }
        Ok(status)
    }

    fn wait(&mut self, context: &'static str) -> Result<std::process::ExitStatus> {
        let status = self.child.wait().context(context)?;
        self.reaped = true;
        Ok(status)
    }

    fn finish_control(&mut self) -> Result<bool> {
        let Some(control) = self.test_control else {
            self.control_cleared = true;
            return Ok(false);
        };
        let mut state = control
            .lock()
            .map_err(|_| anyhow::anyhow!("locking Agent model test state"))?;
        let cancelled = state.pid == Some(self.pid) && state.cancel_requested;
        if state.pid == Some(self.pid) {
            state.pid = None;
            state.cancel_requested = false;
        }
        self.control_cleared = true;
        Ok(cancelled)
    }

    fn terminate_process_tree(&mut self) -> Result<()> {
        if self.containment_terminated {
            return Ok(());
        }
        let termination = self.containment.terminate(self.pid);
        if termination.is_ok() {
            self.containment_terminated = true;
        }
        if !self.reaped {
            let _ = self.child.kill();
        }
        termination
    }
}

impl Drop for RProbeChildGuard<'_> {
    fn drop(&mut self) {
        let _ = self.terminate_process_tree();
        if !self.reaped {
            let _ = self.child.wait();
            self.reaped = true;
        }
        if !self.control_cleared
            && let Some(control) = self.test_control
        {
            let mut state = match control.lock() {
                Ok(state) => state,
                Err(poisoned) => {
                    control.clear_poison();
                    poisoned.into_inner()
                }
            };
            if state.pid == Some(self.pid) {
                state.pid = None;
                state.cancel_requested = false;
            }
        }
    }
}

fn connection_test_error_message(error_class: &str) -> &'static str {
    match error_class {
        "credential" => "The Provider rejected the configured credential.",
        "timeout" => CONNECTION_TEST_TIMEOUT_FAILURE,
        "endpoint" => "The Provider endpoint or model configuration was rejected.",
        "network" => "Rho could not reach the Provider.",
        _ => "The Provider connection test failed.",
    }
}

fn normalize_connection_test_response(
    response: RawAgentConnectionTestResponse,
) -> Result<AgentConnectionTestResponse> {
    ensure!(
        matches!(response.status.as_str(), "ready" | "error"),
        "{CONNECTION_TEST_PROTOCOL_FAILURE}"
    );
    ensure!(
        matches!(
            response.credential_status.as_str(),
            "detected" | "not_detected" | "not_required"
        ),
        "{CONNECTION_TEST_PROTOCOL_FAILURE}"
    );
    ensure!(
        [
            response.capabilities.tool_calling.as_str(),
            response.capabilities.reasoning.as_str(),
            response.capabilities.vision_input.as_str(),
        ]
        .into_iter()
        .all(|value| matches!(value, "yes" | "no" | "unknown")),
        "{CONNECTION_TEST_PROTOCOL_FAILURE}"
    );
    ensure!(
        matches!(
            response.capabilities.source.as_str(),
            "catalog" | "probe" | "unknown"
        ),
        "{CONNECTION_TEST_PROTOCOL_FAILURE}"
    );
    ensure!(
        response.model_resolved == (response.status.as_str() == "ready"),
        "{CONNECTION_TEST_PROTOCOL_FAILURE}"
    );
    ensure!(
        response.status.as_str() != "ready"
            || matches!(
                response.credential_status.as_str(),
                "detected" | "not_required"
            ),
        "{CONNECTION_TEST_PROTOCOL_FAILURE}"
    );

    let (message, error_class) = if response.status.as_str() == "ready" {
        ("Connection succeeded.".to_string(), None)
    } else {
        let error_class = match response.error_class.as_ref().map(SecretString::as_str) {
            Some(value)
                if matches!(
                    value,
                    "credential" | "timeout" | "endpoint" | "network" | "provider"
                ) =>
            {
                value
            }
            _ => "provider",
        };
        (
            connection_test_error_message(error_class).to_string(),
            Some(error_class.to_string()),
        )
    };
    Ok(AgentConnectionTestResponse {
        status: response.status.as_str().to_string(),
        credential_status: response.credential_status.as_str().to_string(),
        model_resolved: response.model_resolved,
        latency_ms: response.latency_ms,
        capabilities: AgentConnectionCapabilities {
            tool_calling: response.capabilities.tool_calling.as_str().to_string(),
            reasoning: response.capabilities.reasoning.as_str().to_string(),
            vision_input: response.capabilities.vision_input.as_str().to_string(),
            source: response.capabilities.source.as_str().to_string(),
        },
        message,
        error_class,
    })
}

fn run_connection_test(
    rscript: &Path,
    agent_package: &Path,
    profile: &AgentRuntimeModelProfile,
    probe_environment_names: &[String],
    credential_override: Option<&(String, String)>,
    test_control: Option<&AgentModelTestControl>,
) -> Result<AgentConnectionTestResponse> {
    let script = r#"
args <- commandArgs(TRUE)
source(file.path(args[[1]], "R", "aaa-state.R"))
source(file.path(args[[1]], "R", "transport.R"))
source(file.path(args[[1]], "R", "aisdk_adapter.R"))
input <- file("stdin", open = "r", encoding = "UTF-8")
profile_json <- paste(readLines(input, warn = FALSE), collapse = "\n")
close(input)
profile <- jsonlite::fromJSON(profile_json, simplifyVector = FALSE)
result <- rho_test_model_profile(profile)
cat(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null"))
"#;
    let base_url_override = profile
        .base_url_env
        .as_deref()
        .and_then(|name| std::env::var(name).ok())
        .map(Zeroizing::new);
    let mut environment_overrides = Vec::with_capacity(2);
    if let (Some(name), Some(value)) = (profile.base_url_env.as_deref(), &base_url_override) {
        environment_overrides.push((name, value.as_str()));
    }
    if let Some((name, value)) = credential_override {
        environment_overrides.push((name.as_str(), value.as_str()));
    }
    let args = [agent_package.to_string_lossy().replace('\\', "/")];
    let response: RawAgentConnectionTestResponse = run_r_json(
        rscript,
        script,
        RProbeRequest {
            args: &args,
            user_environ: None,
            stdin: Some(serde_json::to_string(profile)?),
            scrub_environment_names: probe_environment_names,
            environment_overrides: &environment_overrides,
            failure_disclosure: RProbeFailureDisclosure::SuppressDiagnostic,
            test_control,
        },
    )
    .map_err(project_suppressed_r_probe_error)?;
    normalize_connection_test_response(response).map_err(project_suppressed_r_probe_error)
}

fn run_r_json<T: for<'de> Deserialize<'de>>(
    rscript: &Path,
    script: &str,
    request: RProbeRequest<'_>,
) -> Result<T> {
    let script_file = write_r_probe_script(script)?;
    let mut command = Command::new(rscript);
    hide_console_window(&mut command);
    configure_r_probe(
        &mut command,
        request.user_environ,
        request.scrub_environment_names,
        std::env::vars_os().map(|(name, _)| name),
        request.environment_overrides,
    );
    command.arg(script_file.path()).args(request.args);
    run_r_json_command(
        command,
        request.stdin,
        request.failure_disclosure,
        request.test_control,
    )
}

fn run_r_json_command<T: for<'de> Deserialize<'de>>(
    command: Command,
    stdin: Option<String>,
    failure_disclosure: RProbeFailureDisclosure,
    test_control: Option<&AgentModelTestControl>,
) -> Result<T> {
    let timeout = (failure_disclosure == RProbeFailureDisclosure::SuppressDiagnostic)
        .then_some(CONNECTION_TEST_TIMEOUT);
    run_r_json_command_with_timeout(command, stdin, failure_disclosure, test_control, timeout)
}

fn run_r_json_command_with_timeout<T: for<'de> Deserialize<'de>>(
    command: Command,
    stdin: Option<String>,
    failure_disclosure: RProbeFailureDisclosure,
    test_control: Option<&AgentModelTestControl>,
    timeout: Option<Duration>,
) -> Result<T> {
    run_r_json_command_with_options(
        command,
        stdin,
        failure_disclosure,
        test_control,
        timeout,
        RProbeTestFault::default(),
    )
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InjectedRProbeFault {
    AfterSpawn,
    AfterPipeSetup,
    Reader,
    TryWait,
    Wait,
}

#[derive(Debug, Clone, Default)]
struct RProbeTestFault {
    #[cfg(test)]
    injected: Option<InjectedRProbeFault>,
    #[cfg(test)]
    spawned_pid: Option<Arc<std::sync::atomic::AtomicU32>>,
}

#[cfg(test)]
#[allow(dead_code)]
fn run_r_json_command_with_fault<T: for<'de> Deserialize<'de>>(
    command: Command,
    stdin: Option<String>,
    failure_disclosure: RProbeFailureDisclosure,
    test_control: Option<&AgentModelTestControl>,
    timeout: Option<Duration>,
    injected: InjectedRProbeFault,
    spawned_pid: Arc<std::sync::atomic::AtomicU32>,
) -> Result<T> {
    run_r_json_command_with_options(
        command,
        stdin,
        failure_disclosure,
        test_control,
        timeout,
        RProbeTestFault {
            injected: Some(injected),
            spawned_pid: Some(spawned_pid),
        },
    )
}

fn run_r_json_command_with_options<T: for<'de> Deserialize<'de>>(
    command: Command,
    stdin: Option<String>,
    failure_disclosure: RProbeFailureDisclosure,
    test_control: Option<&AgentModelTestControl>,
    timeout: Option<Duration>,
    test_fault: RProbeTestFault,
) -> Result<T> {
    let result = run_r_json_command_with_options_unprojected(
        command,
        stdin,
        failure_disclosure,
        test_control,
        timeout,
        test_fault,
    );
    match failure_disclosure {
        RProbeFailureDisclosure::BoundedDiagnostic => result,
        RProbeFailureDisclosure::SuppressDiagnostic => {
            result.map_err(project_suppressed_r_probe_error)
        }
    }
}

fn project_suppressed_r_probe_error(error: anyhow::Error) -> anyhow::Error {
    let message = error.to_string();
    match message.as_str() {
        CONNECTION_TEST_PROCESS_FAILURE
        | CONNECTION_TEST_PROTOCOL_FAILURE
        | CONNECTION_TEST_TIMEOUT_FAILURE
        | CONNECTION_TEST_CANCELLED => anyhow::anyhow!(message),
        _ => anyhow::anyhow!(CONNECTION_TEST_PROCESS_FAILURE),
    }
}

fn run_r_json_command_with_options_unprojected<T: for<'de> Deserialize<'de>>(
    mut command: Command,
    stdin: Option<String>,
    failure_disclosure: RProbeFailureDisclosure,
    test_control: Option<&AgentModelTestControl>,
    timeout: Option<Duration>,
    _test_fault: RProbeTestFault,
) -> Result<T> {
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    configure_r_probe_process_containment(&mut command);
    let containment = RProbeProcessContainment::new()?;
    let child = command.spawn().context("spawning Rscript JSON probe")?;
    #[cfg(test)]
    if let Some(spawned_pid) = &_test_fault.spawned_pid {
        spawned_pid.store(child.id(), std::sync::atomic::Ordering::SeqCst);
    }
    let mut child = RProbeChildGuard::new(child, containment, test_control)?;
    #[cfg(test)]
    if _test_fault.injected == Some(InjectedRProbeFault::AfterSpawn) {
        bail!("injected post-spawn setup failure")
    }
    let stdin_handle = if stdin.is_some() {
        Some(child.child.stdin.take().context("opening Rscript stdin")?)
    } else {
        None
    };
    let stdout = child
        .child
        .stdout
        .take()
        .context("opening Rscript stdout")?;
    let stderr = child
        .child
        .stderr
        .take()
        .context("opening Rscript stderr")?;
    #[cfg(test)]
    let inject_reader_failure = _test_fault.injected == Some(InjectedRProbeFault::Reader);
    #[cfg(not(test))]
    let inject_reader_failure = false;
    let (reader_error_sender, reader_error_receiver) = std::sync::mpsc::channel();
    let stdout_error_sender = reader_error_sender.clone();
    let stdout_thread = std::thread::spawn(move || {
        let result = if inject_reader_failure {
            Err(io::Error::other("injected Rscript stdout reader failure"))
        } else {
            drain_bounded(stdout, MAX_R_PROBE_STDOUT_BYTES)
        };
        if result.is_err() {
            let _ = stdout_error_sender.send(());
        }
        result
    });
    let stderr_error_sender = reader_error_sender.clone();
    let stderr_thread = std::thread::spawn(move || {
        let result = drain_bounded(stderr, MAX_R_PROBE_STDERR_BYTES);
        if result.is_err() {
            let _ = stderr_error_sender.send(());
        }
        result
    });
    drop(reader_error_sender);
    let stdin_thread = stdin_handle.zip(stdin).map(|(mut handle, stdin_payload)| {
        std::thread::spawn(move || {
            use std::io::Write;
            let stdin_payload = Zeroizing::new(stdin_payload);
            handle.write_all(stdin_payload.as_bytes())
        })
    });
    #[cfg(test)]
    if _test_fault.injected == Some(InjectedRProbeFault::AfterPipeSetup) {
        bail!("injected post-pipe setup failure")
    }
    let started = Instant::now();
    let mut timed_out = false;
    let mut reader_failed = false;
    let status = loop {
        #[cfg(test)]
        if _test_fault.injected == Some(InjectedRProbeFault::TryWait) {
            bail!("injected process-status failure")
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if reader_error_receiver.try_recv().is_ok() {
            reader_failed = true;
            let _ = child.terminate_process_tree();
            if child.try_wait()?.is_none() {
                let _ = child.child.kill();
            }
            break child.wait("waiting after Rscript pipe-reader failure")?;
        }
        if timeout.is_some_and(|limit| started.elapsed() >= limit) {
            timed_out = true;
            let _ = child.terminate_process_tree();
            #[cfg(test)]
            if _test_fault.injected == Some(InjectedRProbeFault::Wait) {
                bail!("injected process-wait failure")
            }
            if child.try_wait()?.is_none() {
                let _ = child.child.kill();
            }
            break child.wait("waiting for timed-out Rscript JSON probe")?;
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    };
    let termination_result = child.terminate_process_tree();
    let was_cancelled = child.finish_control()?;
    let stdin_result =
        stdin_thread.map(|thread| join_r_probe_thread(thread, "Rscript stdin writer"));
    let stdout_result = join_r_probe_thread(stdout_thread, "Rscript stdout reader");
    let stderr_result = join_r_probe_thread(stderr_thread, "Rscript stderr reader");
    if was_cancelled {
        bail!("{CONNECTION_TEST_CANCELLED}");
    }
    if timed_out {
        bail!("{CONNECTION_TEST_TIMEOUT_FAILURE}");
    }
    if let Err(error) = termination_result {
        if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic {
            return Err(error);
        }
        bail!("{CONNECTION_TEST_PROCESS_FAILURE}")
    }
    if !status.success() && failure_disclosure == RProbeFailureDisclosure::SuppressDiagnostic {
        bail!("{CONNECTION_TEST_PROCESS_FAILURE}")
    }
    if reader_failed && failure_disclosure == RProbeFailureDisclosure::SuppressDiagnostic {
        bail!("{CONNECTION_TEST_PROCESS_FAILURE}")
    }
    if let Some(result) = stdin_result {
        match result {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error)))
                if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic =>
            {
                return Err(error).context("writing Rscript stdin");
            }
            Ok(Err(_)) if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic => {
                bail!("joining Rscript stdin writer")
            }
            Err(error) if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic => {
                return Err(error);
            }
            _ => bail!("{CONNECTION_TEST_PROCESS_FAILURE}"),
        }
    }
    let stdout = match stdout_result {
        Ok(Ok(Ok(output))) => output,
        Ok(Ok(Err(error))) if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic => {
            return Err(error).context("reading Rscript stdout");
        }
        Ok(Err(_)) if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic => {
            bail!("joining Rscript stdout reader")
        }
        Err(error) if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic => {
            return Err(error);
        }
        _ => bail!("{CONNECTION_TEST_PROCESS_FAILURE}"),
    };
    let stderr = match stderr_result {
        Ok(Ok(Ok(output))) => output,
        Ok(Ok(Err(error))) if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic => {
            return Err(error).context("reading Rscript stderr");
        }
        Ok(Err(_)) if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic => {
            bail!("joining Rscript stderr reader")
        }
        Err(error) if failure_disclosure == RProbeFailureDisclosure::BoundedDiagnostic => {
            return Err(error);
        }
        _ => bail!("{CONNECTION_TEST_PROCESS_FAILURE}"),
    };
    if !status.success() {
        let diagnostic = crate::startup_runtime::bounded_diagnostic(
            String::from_utf8_lossy(&stderr.bytes).as_ref(),
        );
        let suffix = if stderr.truncated { " [truncated]" } else { "" };
        bail!("R probe failed: {diagnostic}{suffix}")
    }
    if stdout.truncated {
        match failure_disclosure {
            RProbeFailureDisclosure::SuppressDiagnostic => {
                bail!("{CONNECTION_TEST_PROTOCOL_FAILURE}")
            }
            RProbeFailureDisclosure::BoundedDiagnostic => {
                bail!("R probe returned an oversized JSON response.")
            }
        }
    }
    match serde_json::from_slice(&stdout.bytes) {
        Ok(value) => Ok(value),
        Err(_) if failure_disclosure == RProbeFailureDisclosure::SuppressDiagnostic => {
            bail!("{CONNECTION_TEST_PROTOCOL_FAILURE}")
        }
        Err(error) => Err(error).context("decoding R JSON probe result"),
    }
}

fn write_r_probe_script(script: &str) -> Result<tempfile::NamedTempFile> {
    use std::io::Write;

    let mut script_file = tempfile::Builder::new()
        .prefix("rho-agent-probe-")
        .suffix(".R")
        .tempfile()
        .context("creating Agent R probe script file")?;
    script_file
        .write_all(script.as_bytes())
        .context("writing Agent R probe script file")?;
    script_file
        .flush()
        .context("flushing Agent R probe script file")?;
    Ok(script_file)
}

pub fn cancel_test(test_control: &AgentModelTestControl) -> Result<bool> {
    let pid = {
        let mut guard = test_control
            .lock()
            .map_err(|_| anyhow::anyhow!("locking Agent model test state"))?;
        let pid = guard.pid;
        if pid.is_some() {
            guard.cancel_requested = true;
        }
        pid
    };
    let Some(pid) = pid else {
        return Ok(false);
    };
    kill_process(pid)?;
    Ok(true)
}

fn kill_process(pid: u32) -> Result<()> {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        hide_console_window(&mut command);
        let status = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .context("cancelling Agent model test")?;
        ensure!(status.success(), "Cancelling the Agent model test failed.");
        return Ok(());
    }
    #[cfg(unix)]
    {
        let _ = signal_r_probe_process_group(pid, 15)
            .context("cancelling Agent model test process group")?;
        return Ok(());
    }
    #[cfg(not(any(windows, unix)))]
    bail!("Cancelling an Agent model test is unsupported on this platform.")
}

fn configure_r_probe(
    command: &mut Command,
    _user_environ: Option<&str>,
    scrub_environment_names: &[String],
    inherited_environment_names: impl IntoIterator<Item = OsString>,
    environment_overrides: &[(&str, &str)],
) {
    command.arg("--vanilla");
    configure_probe_environment(
        command,
        scrub_environment_names,
        inherited_environment_names,
        environment_overrides,
    );
}

fn configure_probe_environment(
    command: &mut Command,
    scrub_environment_names: &[String],
    inherited_environment_names: impl IntoIterator<Item = OsString>,
    environment_overrides: &[(&str, &str)],
) {
    for name in inherited_environment_names {
        if name
            .to_str()
            .is_some_and(rho_kernel::is_sensitive_environment_name)
        {
            command.env_remove(name);
        }
    }
    for name in scrub_environment_names {
        command.env_remove(name);
    }
    for (name, value) in environment_overrides {
        command.env(name, value);
    }
}

fn hide_console_window(_command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _command.creation_flags(0x0800_0000);
    }
}

// ---------------------------------------------------------------------------
// CRED-REVEAL-1C simple inline credential view
//
// One repeatable, explicitly user-triggered flow: provider admission
// (exists, API key required, eligible exact source), a fresh direct
// exact-source read that never consults the runtime read-through cache, a
// best-effort CRED-SEC4 audit row, and a single response that carries the
// plaintext value only on `revealed` for inline display in the Settings
// WebView. There is no OS prompt, focus check, revision pin, or retained
// grant; every View click runs the full flow again.
// ---------------------------------------------------------------------------

/// Fixed terminal vocabulary for `agent_llm_view_credential`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentLlmCredentialRevealOutcome {
    Revealed,
    CredentialMissing,
    CredentialUnavailable,
}

/// The response carries the stored value only on `Revealed`; every failure
/// outcome resolves with `credential: None` and no store-layer detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct AgentLlmCredentialRevealView {
    pub outcome: AgentLlmCredentialRevealOutcome,
    pub credential: Option<String>,
    pub source: Option<String>,
    pub env_shadows_file: bool,
}

const REVEAL_AUDIT_EVENT: &str = "credential_reveal";

static REVEAL_AUDIT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CREDENTIAL_OPERATION_STATE: OnceLock<(Mutex<HashSet<String>>, Condvar)> = OnceLock::new();

fn reveal_audit_guard() -> MutexGuard<'static, ()> {
    REVEAL_AUDIT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn credential_operation_state() -> &'static (Mutex<HashSet<String>>, Condvar) {
    CREDENTIAL_OPERATION_STATE.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()))
}

/// Owned registry token for one Provider's credential-operation lane. The
/// registry stores only active IDs and removes them on drop, so a churn of
/// custom Provider IDs cannot leak one process-lifetime mutex per ID.
struct CredentialOperationGuard {
    provider_id: String,
}

impl CredentialOperationGuard {
    fn acquire(provider_id: &str) -> Self {
        let (active, ready) = credential_operation_state();
        let mut active = active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while active.contains(provider_id) {
            active = ready
                .wait(active)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        active.insert(provider_id.to_string());
        Self {
            provider_id: provider_id.to_string(),
        }
    }
}

impl Drop for CredentialOperationGuard {
    fn drop(&mut self) {
        let (active, ready) = credential_operation_state();
        let mut active = active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active.remove(&self.provider_id);
        ready.notify_all();
    }
}

/// Blocking handle over one Provider's credential-operation slot. Rho-owned
/// credential mutations hold this while they work so concurrent mutations on
/// the same Provider serialize.
fn credential_operation_lock(provider_id: &str) -> CredentialOperationGuard {
    CredentialOperationGuard::acquire(provider_id)
}

/// Rotates oversized audit bytes down to the keep bound on a newline
/// boundary. Shared by both audit writers so rotation behavior is identical.
fn rotate_credential_audit_bytes(bytes: &mut Vec<u8>) -> Result<()> {
    if bytes.len() <= MAX_CREDENTIAL_AUDIT_BYTES {
        return Ok(());
    }
    let adoption_rows = bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let row = serde_json::from_slice::<serde_json::Value>(line).ok()?;
            (row.get("event").and_then(serde_json::Value::as_str) == Some("config_store_adopted"))
                .then(|| {
                let schema = row
                    .get("config_schema_version")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(u64::from(agent_config::CONFIG_SCHEMA_VERSION));
                let path = row.get("detail").and_then(serde_json::Value::as_str)?;
                Some(((schema, path.to_string()), line.to_vec()))
            })?
        })
        .collect::<BTreeMap<_, _>>();
    let adoption_bytes = adoption_rows
        .values()
        .map(|line| line.len() + 1)
        .sum::<usize>();
    ensure!(
        adoption_bytes + MAX_CREDENTIAL_AUDIT_ROW_BYTES <= MAX_CREDENTIAL_AUDIT_BYTES,
        "The credential audit adoption-identity capacity is exhausted."
    );

    let tail_budget = CREDENTIAL_AUDIT_KEEP_BYTES.min(MAX_CREDENTIAL_AUDIT_BYTES - adoption_bytes);
    let unaligned = bytes.len().saturating_sub(tail_budget);
    let tail_start = if unaligned == 0 {
        0
    } else {
        bytes[unaligned..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| unaligned + offset + 1)
            .unwrap_or(bytes.len())
    };
    let mut rotated = Vec::with_capacity(MAX_CREDENTIAL_AUDIT_BYTES);
    for line in adoption_rows.values() {
        rotated.extend_from_slice(line);
        rotated.push(b'\n');
    }
    for line in bytes[tail_start..]
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let is_adoption = serde_json::from_slice::<serde_json::Value>(line)
            .ok()
            .is_some_and(|row| {
                row.get("event").and_then(serde_json::Value::as_str) == Some("config_store_adopted")
            });
        if is_adoption {
            continue;
        }
        ensure!(
            rotated.len() + line.len() + 1 <= MAX_CREDENTIAL_AUDIT_BYTES,
            "The credential audit tail exceeds its bounded rotation size."
        );
        rotated.extend_from_slice(line);
        rotated.push(b'\n');
    }
    *bytes = rotated;
    Ok(())
}

/// CRED-REVEAL-1C entry point behind `agent_llm_view_credential`: one
/// explicit click, one fresh exact-source read, one response. Failures carry
/// no store-layer detail, and the best-effort audit row records provider ID,
/// source, outcome, and time only — never the value.
pub(crate) fn view_provider_credential(
    data_dir: &Path,
    rscript: &Path,
    r_environ_user: Option<&Path>,
    provider_id: &str,
) -> AgentLlmCredentialRevealView {
    let refuse = |outcome: AgentLlmCredentialRevealOutcome| {
        record_credential_audit(
            data_dir,
            REVEAL_AUDIT_EVENT,
            provider_id,
            CREDENTIAL_SOURCE_NOT_CONFIGURED,
            match outcome {
                AgentLlmCredentialRevealOutcome::Revealed => "revealed",
                AgentLlmCredentialRevealOutcome::CredentialMissing => "credential_missing",
                AgentLlmCredentialRevealOutcome::CredentialUnavailable => "credential_unavailable",
            },
            None,
        );
        AgentLlmCredentialRevealView {
            outcome,
            credential: None,
            source: None,
            env_shadows_file: false,
        }
    };
    if provider_id.is_empty()
        || provider_id.len() > MAX_ID_LENGTH
        || provider_id.chars().any(char::is_control)
    {
        return refuse(AgentLlmCredentialRevealOutcome::CredentialUnavailable);
    }
    let loaded = match load_v6_document(data_dir) {
        Ok(loaded) => loaded,
        Err(_) => return refuse(AgentLlmCredentialRevealOutcome::CredentialUnavailable),
    };
    let settings = config_to_settings(&loaded.config);
    if validate_settings(&settings).is_err() {
        return refuse(AgentLlmCredentialRevealOutcome::CredentialUnavailable);
    }
    let Some(provider) = settings.providers.iter().find(|p| p.id == provider_id) else {
        return refuse(AgentLlmCredentialRevealOutcome::CredentialUnavailable);
    };
    if !provider.api_key_required {
        return refuse(AgentLlmCredentialRevealOutcome::CredentialUnavailable);
    }
    let file_present = loaded
        .config
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .and_then(|provider| provider.api_key.as_deref())
        .is_some_and(|value| !value.is_empty());
    let store = ConfigCredentialStore::from_config(&loaded.config);
    let (secret, source) = match resolve_provider_credential_with_runtime(
        &settings,
        provider,
        &store,
        Some(rscript),
        r_environ_user,
    ) {
        Ok((Some(secret), source)) => (secret, source),
        Ok((None, _)) => return refuse(AgentLlmCredentialRevealOutcome::CredentialMissing),
        Err(_) => return refuse(AgentLlmCredentialRevealOutcome::CredentialUnavailable),
    };
    // CRED-SEC4 best-effort: an audit failure never blocks or alters a view.
    record_credential_audit(
        data_dir,
        REVEAL_AUDIT_EVENT,
        provider_id,
        source,
        "revealed",
        None,
    );
    let credential = secret.as_str().to_string();
    drop(secret); // zeroized here; only the IPC-bound copy survives
    AgentLlmCredentialRevealView {
        outcome: AgentLlmCredentialRevealOutcome::Revealed,
        credential: Some(credential),
        source: Some(source.to_string()),
        env_shadows_file: source == CREDENTIAL_SOURCE_ENVIRONMENT && file_present,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::Cell;

    fn semantic_invalid_settings() -> AgentLlmSettings {
        let mut capabilities = capability_names()
            .iter()
            .map(|name| ((*name).to_string(), capability_value("unknown", "unknown")))
            .collect::<BTreeMap<_, _>>();
        capabilities.remove("function_call");
        AgentLlmSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            revision: 7,
            providers: vec![AgentProviderProfile {
                id: "invalid-provider-test".to_string(),
                display_name: "Invalid provider".to_string(),
                kind: "openai".to_string(),
                registered_provider_id: None,
                // Rust's environment APIs panic on `=`. This value must never
                // cross the semantic validation boundary.
                api_key_env: Some("INVALID=API_KEY".to_string()),
                api_key_required: true,
                base_url: None,
                base_url_env: Some("INVALID=BASE_URL".to_string()),
                wire_api: None,
                disable_stream_options: None,
            }],
            models: vec![AgentModelProfile {
                id: "invalid-model-test".to_string(),
                provider_id: "invalid-provider-test".to_string(),
                display_name: "Invalid model".to_string(),
                model_id: "invalid-model".to_string(),
                enabled: true,
                model_type: capability_value("language", "user_declared"),
                capabilities,
                context_window_tokens: 8_192,
                reserved_output_tokens: 1_024,
                context_capacity_source: "user_declared".to_string(),
                last_test: None,
            }],
            capability_routes: vec![AgentCapabilityRoute {
                capability: "agent.chat".to_string(),
                model_id: "invalid-model-test".to_string(),
                model_type: "language".to_string(),
                required_model_capabilities: Vec::new(),
            }],
        }
    }

    fn test_config_store_view() -> AgentConfigStoreView {
        AgentConfigStoreView {
            home_path: Some("/test/.rho".to_string()),
            config_path: Some("/test/.rho/config.yaml".to_string()),
            status: "loaded".to_string(),
            detail: None,
            found_schema_version: Some(u64::from(SETTINGS_SCHEMA_VERSION)),
            config_snapshot_id: "opaque-test-snapshot".to_string(),
            permission_issues: Vec::new(),
        }
    }

    fn routed_settings() -> AgentLlmSettings {
        let mut capabilities = unknown_capabilities();
        capabilities.insert(
            "function_call".to_string(),
            capability_value("yes", "aisdk_catalog"),
        );
        AgentLlmSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            revision: 3,
            providers: vec![AgentProviderProfile {
                id: "provider-route-invariant".to_string(),
                display_name: "Route invariant provider".to_string(),
                kind: "openai".to_string(),
                registered_provider_id: None,
                api_key_env: None,
                api_key_required: false,
                base_url: None,
                base_url_env: None,
                wire_api: None,
                disable_stream_options: None,
            }],
            models: vec![AgentModelProfile {
                id: "model-route-invariant".to_string(),
                provider_id: "provider-route-invariant".to_string(),
                display_name: "Route invariant model".to_string(),
                model_id: "route-invariant-model".to_string(),
                enabled: true,
                model_type: capability_value("language", "aisdk_catalog"),
                capabilities,
                context_window_tokens: 8_192,
                reserved_output_tokens: 1_024,
                context_capacity_source: "catalog".to_string(),
                last_test: None,
            }],
            capability_routes: vec![
                AgentCapabilityRoute {
                    capability: "agent.chat".to_string(),
                    model_id: "model-route-invariant".to_string(),
                    model_type: "language".to_string(),
                    required_model_capabilities: Vec::new(),
                },
                AgentCapabilityRoute {
                    capability: "agent.act".to_string(),
                    model_id: "model-route-invariant".to_string(),
                    model_type: "language".to_string(),
                    required_model_capabilities: vec!["function_call".to_string()],
                },
            ],
        }
    }

    fn verified_mutation_for(settings: &AgentLlmSettings) -> VerifiedConfigMutation {
        let mut config = empty_config();
        apply_settings_to_config(&mut config, settings);
        VerifiedConfigMutation {
            token: "route-invariant-snapshot".to_string(),
            record: ConfigSnapshotRecord {
                home: PathBuf::from("/test/.rho"),
                config_path: PathBuf::from("/test/.rho/config.yaml"),
                content_identity: "route-invariant-content".to_string(),
                permission_identity: "route-invariant-permissions".to_string(),
                revision: settings.revision,
            },
            config: Some(config),
        }
    }

    fn assert_commit_rejected_before_write(
        mutation: VerifiedConfigMutation,
        settings: &AgentLlmSettings,
    ) {
        let write_attempted = Cell::new(false);
        let result = commit_settings_mutation_with(
            mutation,
            settings,
            |_home, _config, _expected_identity| {
                write_attempted.set(true);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(
            !write_attempted.get(),
            "an invalid whole-document route state must be rejected before persistence"
        );
    }

    #[test]
    fn committed_refresh_releases_non_reentrant_settings_lock() {
        let lock = Mutex::new(());
        let guard = lock.lock().unwrap();
        let refreshed = after_settings_mutation(guard, || {
            assert!(
                lock.try_lock().is_ok(),
                "the read-back refresh must run after the mutation guard is released"
            );
            Ok("refreshed")
        })
        .unwrap();
        assert_eq!(refreshed, "refreshed");
    }

    #[test]
    fn parseable_semantic_invalid_v6_has_a_safe_settings_projection() {
        let invalid = semantic_invalid_settings();
        let mut config = empty_config();
        apply_settings_to_config(&mut config, &invalid);
        let yaml = serde_norway::to_string(&config).unwrap();
        let parsed: agent_config::AgentConfig = serde_norway::from_str(&yaml).unwrap();
        let settings = config_to_settings(&parsed);
        let validation_error = validate_settings(&settings).unwrap_err().to_string();

        let view = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            build_invalid_settings_view(
                settings,
                system_credential_info(),
                Some(&parsed),
                test_config_store_view(),
                validation_error,
            )
        }))
        .expect("invalid Settings projection must not panic");

        assert!(view.validation_error.is_some());
        assert_eq!(view.providers[0].credential_status, "unavailable");
        assert!(!view.models[0].act_enabled);
        assert_eq!(
            view.selected_model.as_ref().unwrap().tool_calling,
            "unknown"
        );
    }

    #[test]
    fn invalid_environment_name_is_rejected_before_runtime_resolution() {
        let settings = semantic_invalid_settings();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            resolve_model_for_turn_with_settings(&settings, None, "ask")
        }))
        .expect("runtime validation must return an error instead of panicking");
        assert!(result.is_err());

        let provider = &settings.providers[0];
        let direct_probe = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            environment_credential(provider)
        }))
        .expect("environment validation must guard std::env APIs");
        assert!(direct_probe.is_err());
        assert!(!environment_credential_present(provider));
    }

    #[test]
    fn capability_declaration_cannot_persist_a_broken_chat_route() {
        let mut settings = routed_settings();
        validate_settings(&settings).unwrap();
        let mutation = verified_mutation_for(&settings);
        let request = AgentModelCapabilityDeclarationRequest {
            model_id: "model-route-invariant".to_string(),
            expected_revision: settings.revision,
            expected_config_snapshot_id: mutation.token.clone(),
            capability: "model_type".to_string(),
            value: "embedding".to_string(),
        };

        apply_model_capability_declaration(&mut settings, &request).unwrap();
        increment_revision(&mut settings).unwrap();
        assert_commit_rejected_before_write(mutation, &settings);
    }

    #[test]
    fn connection_test_evidence_cannot_persist_a_broken_act_route() {
        let mut settings = routed_settings();
        validate_settings(&settings).unwrap();
        let mutation = verified_mutation_for(&settings);
        let result = AgentConnectionTestResponse {
            status: "ready".to_string(),
            credential_status: "not_required".to_string(),
            model_resolved: true,
            latency_ms: Some(1),
            capabilities: AgentConnectionCapabilities {
                tool_calling: "no".to_string(),
                reasoning: "unknown".to_string(),
                vision_input: "unknown".to_string(),
                source: "probe".to_string(),
            },
            message: "Connection succeeded.".to_string(),
            error_class: None,
        };

        update_model_after_test(&mut settings, "model-route-invariant", &result).unwrap();
        increment_revision(&mut settings).unwrap();
        assert_commit_rejected_before_write(mutation, &settings);
    }
}
