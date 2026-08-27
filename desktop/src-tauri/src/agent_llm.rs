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

use crate::agent_credential_vault::{self, CredentialVaultStatus};
use crate::project::atomic_write;

// Plaintext YAML model-configuration parser and file I/O. Runtime settings
// are implemented in this module; the helpers have no production call sites.
#[path = "agent_config.rs"]
pub(crate) mod agent_config;

const SETTINGS_FILE_NAME: &str = "llm-profiles.json";
const SETTINGS_V1_BACKUP_FILE_NAME: &str = "llm-profiles.v1.backup.json";
const SETTINGS_V2_BACKUP_FILE_NAME: &str = "llm-profiles.v2.backup.json";
const SETTINGS_V3_BACKUP_FILE_NAME: &str = "llm-profiles.v3.backup.json";
const SETTINGS_V4_BACKUP_FILE_NAME: &str = "llm-profiles.v4.backup.json";
const SETTINGS_SCHEMA_VERSION: u32 = 5;
const CONSERVATIVE_CONTEXT_WINDOW_TOKENS: u64 = 32_768;
const CONSERVATIVE_RESERVED_OUTPUT_TOKENS: u64 = 4_096;
const MAX_SETTINGS_BYTES: usize = 256 * 1024;
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
const MAX_CREDENTIAL_AUDIT_BYTES: usize = 256 * 1024;
const CREDENTIAL_AUDIT_KEEP_BYTES: usize = 128 * 1024;

static SETTINGS_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CREDENTIAL_SESSION: OnceLock<CredentialSession> = OnceLock::new();

fn settings_mutation_guard() -> MutexGuard<'static, ()> {
    SETTINGS_MUTATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

trait CredentialStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>>;
    fn set(&self, provider_id: &str, credential: &str) -> Result<()>;
    fn delete(&self, provider_id: &str) -> Result<()>;
}

#[derive(Debug, Clone)]
struct RhoCredentialVaultStore {
    data_dir: PathBuf,
}

impl RhoCredentialVaultStore {
    fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
        }
    }
}

#[derive(Default)]
struct CredentialSession {
    /// Session-only credentials (CRED-SEC2). These are never written to any
    /// durable store and are dropped by explicit delete or app shutdown.
    session_only: Mutex<HashMap<String, Zeroizing<String>>>,
}

impl CredentialSession {
    fn session_credential(&self, provider_id: &str) -> Option<String> {
        self.session_only
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(provider_id)
            .map(|credential| credential.as_str().to_string())
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

impl CredentialStore for RhoCredentialVaultStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>> {
        agent_credential_vault::get(&self.data_dir, provider_id)
    }

    fn set(&self, provider_id: &str, credential: &str) -> Result<()> {
        agent_credential_vault::set(&self.data_dir, provider_id, credential)
    }

    fn delete(&self, provider_id: &str) -> Result<()> {
        agent_credential_vault::delete(&self.data_dir, provider_id)
    }
}

const CREDENTIAL_SOURCE_RHO_VAULT: &str = "rho_vault";
const LEGACY_CREDENTIAL_SOURCE_SYSTEM_STORE: &str = "system_store";
const CREDENTIAL_SOURCE_ENVIRONMENT: &str = "environment";
const CREDENTIAL_SOURCE_SESSION_ONLY: &str = "session_only";
const LEGACY_CREDENTIAL_SOURCE_FILE_FALLBACK: &str = "file_fallback";

fn is_supported_credential_source(source: &str) -> bool {
    matches!(
        source,
        CREDENTIAL_SOURCE_RHO_VAULT
            | CREDENTIAL_SOURCE_ENVIRONMENT
            | CREDENTIAL_SOURCE_SESSION_ONLY
    )
}

/// Resolves the effective credential for one provider from its configured
/// source. There is no implicit fallback between sources: a missing or
/// unavailable configured source yields `None` or an error, never a silent
/// probe of another source.
fn resolve_provider_credential(
    _data_dir: &Path,
    provider: &AgentProviderProfile,
    credential_store: &impl CredentialStore,
) -> Result<Option<String>> {
    match provider.credential_source.as_str() {
        CREDENTIAL_SOURCE_RHO_VAULT => credential_store.get(&provider.id),
        CREDENTIAL_SOURCE_ENVIRONMENT => environment_credential(provider),
        CREDENTIAL_SOURCE_SESSION_ONLY => Ok(credential_session().session_credential(&provider.id)),
        other => bail!("Unsupported credential source: {other}"),
    }
}

/// Stores a credential through the provider's configured durable source.
/// `environment` is read-only and rejected by the service layer before this
/// dispatch; `session_only` writes only the in-memory session cache.
fn store_provider_credential(
    _data_dir: &Path,
    provider: &AgentProviderProfile,
    credential: &str,
    credential_store: &impl CredentialStore,
) -> Result<()> {
    match provider.credential_source.as_str() {
        CREDENTIAL_SOURCE_RHO_VAULT => credential_store.set(&provider.id, credential),
        CREDENTIAL_SOURCE_SESSION_ONLY => {
            credential_session().set_session_credential(&provider.id, credential);
            Ok(())
        }
        CREDENTIAL_SOURCE_ENVIRONMENT => bail!(
            "This provider reads its API key from an environment variable; manage it outside Rho."
        ),
        other => bail!("Unsupported credential source: {other}"),
    }
}

/// Deletes the credential held by the provider's configured source.
/// `environment` has nothing to delete and is rejected earlier.
fn delete_provider_credential(
    _data_dir: &Path,
    provider: &AgentProviderProfile,
    credential_store: &impl CredentialStore,
) -> Result<()> {
    match provider.credential_source.as_str() {
        CREDENTIAL_SOURCE_RHO_VAULT => credential_store.delete(&provider.id),
        CREDENTIAL_SOURCE_SESSION_ONLY => {
            credential_session().clear_session_credential(&provider.id);
            Ok(())
        }
        CREDENTIAL_SOURCE_ENVIRONMENT => bail!(
            "This provider reads its API key from an environment variable; manage it outside Rho."
        ),
        other => bail!("Unsupported credential source: {other}"),
    }
}

fn environment_credential(provider: &AgentProviderProfile) -> Result<Option<String>> {
    let Some(name) = provider.api_key_env.as_deref() else {
        return Ok(None);
    };
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            bail!("The environment variable {name} does not contain valid UTF-8.")
        }
    }
}

fn environment_credential_present(provider: &AgentProviderProfile) -> bool {
    provider
        .api_key_env
        .as_deref()
        .and_then(|name| std::env::var_os(name))
        .is_some_and(|value| !value.is_empty())
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
        crate::startup_runtime::write_startup_log(&format!(
            "agent_llm_credential_audit outcome=failed detail={error:#}"
        ));
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
    append_credential_audit_unlocked(data_dir, event, provider_id, source, outcome, detail)
}

fn append_credential_audit_unlocked(
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
    }))?;
    let path = credential_audit_path(data_dir);
    let mut bytes = match std::fs::read(&path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            return Err(anyhow::Error::new(error))
                .with_context(|| format!("reading the credential audit log {}", path.display()));
        }
    };
    bytes.extend_from_slice(line.as_bytes());
    bytes.push(b'\n');
    rotate_credential_audit_bytes(&mut bytes);
    atomic_write(&path, &bytes)
        .with_context(|| format!("writing the credential audit log {}", path.display()))
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentLlmSettingsV1 {
    schema_version: u32,
    selected_model_id: String,
    providers: Vec<AgentProviderProfileV3>,
    models: Vec<AgentModelProfileV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentLlmSettingsV2 {
    schema_version: u32,
    revision: u64,
    providers: Vec<AgentProviderProfileV3>,
    models: Vec<AgentModelProfileV2>,
    capability_routes: Vec<AgentCapabilityRoute>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentLlmSettingsV3 {
    schema_version: u32,
    revision: u64,
    providers: Vec<AgentProviderProfileV3>,
    models: Vec<AgentModelProfile>,
    capability_routes: Vec<AgentCapabilityRoute>,
}

/// Schema V4 introduced explicit credential sources. V5 replaces the
/// `system_store` source metadata with Rho's encrypted vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentLlmSettingsV4 {
    schema_version: u32,
    revision: u64,
    providers: Vec<AgentProviderProfile>,
    models: Vec<AgentModelProfile>,
    capability_routes: Vec<AgentCapabilityRoute>,
}

/// Provider shape before schema V4 added the explicit credential source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentProviderProfileV3 {
    id: String,
    display_name: String,
    kind: String,
    registered_provider_id: Option<String>,
    api_key_env: Option<String>,
    api_key_required: bool,
    base_url: Option<String>,
    base_url_env: Option<String>,
    wire_api: Option<String>,
    disable_stream_options: Option<bool>,
}

impl AgentProviderProfileV3 {
    /// Pre-V4 providers become Rho Vault providers without probing any legacy
    /// operating-system credential store.
    fn into_current(self) -> AgentProviderProfile {
        AgentProviderProfile {
            id: self.id,
            display_name: self.display_name,
            kind: self.kind,
            registered_provider_id: self.registered_provider_id,
            api_key_env: self.api_key_env,
            api_key_required: self.api_key_required,
            base_url: self.base_url,
            base_url_env: self.base_url_env,
            wire_api: self.wire_api,
            disable_stream_options: self.disable_stream_options,
            credential_source: CREDENTIAL_SOURCE_RHO_VAULT.to_string(),
        }
    }
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
    /// Where this provider's API key lives: `rho_vault` (default),
    /// `environment`, or `session_only`.
    pub credential_source: String,
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
struct AgentModelProfileV2 {
    id: String,
    provider_id: String,
    display_name: String,
    model_id: String,
    enabled: bool,
    model_type: AgentCapabilityValue,
    capabilities: BTreeMap<String, AgentCapabilityValue>,
    last_test: Option<AgentModelTestResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentModelProfileV1 {
    id: String,
    provider_id: String,
    display_name: String,
    model_id: String,
    enabled: bool,
    capabilities: AgentModelCapabilitiesV1,
    last_test: Option<AgentModelTestResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModelCapabilitiesV1 {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentCapabilityRoute {
    pub capability: String,
    pub model_id: String,
    pub model_type: String,
    pub required_model_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub capabilities: AgentModelCapabilitiesV1,
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
    #[cfg(test)]
    fn new(value: String) -> Self {
        Self(value)
    }

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
struct RawAgentModelCapabilitiesV1 {
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
    capabilities: RawAgentModelCapabilitiesV1,
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
    /// Presentation-only description of where the effective credential was
    /// observed. The persisted configured source is the flattened
    /// `credential_source` field on the profile itself.
    pub credential_effective_source: String,
    /// Resolved endpoint shown in Settings. Reviewed Provider defaults are
    /// projected explicitly instead of appearing as an unexplained blank.
    pub effective_base_url: Option<String>,
    pub base_url_source: String,
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
    /// Compatibility projection for the existing composer. The persisted V2
    /// authority is the `agent.chat` route, not this derived field.
    pub selected_model_id: String,
    pub providers: Vec<AgentProviderProfileView>,
    pub models: Vec<AgentModelProfileView>,
    pub selected_model: Option<AgentSelectedModelView>,
    pub capability_routes: Vec<AgentCapabilityRouteView>,
    pub user_environ: AgentUserEnvironInfo,
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
#[serde(deny_unknown_fields)]
pub struct DeleteModelRequest {
    pub model_id: String,
    pub replacement_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteProviderRequest {
    pub provider_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentContextCapacityRequest {
    pub model_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub context_window_tokens: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub reserved_output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentModelCapabilityDeclarationRequest {
    pub model_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub expected_revision: u64,
    pub capability: String,
    pub value: String,
}

#[derive(Debug, Default)]
pub struct AgentModelTestState {
    pub pid: Option<u32>,
    pub cancel_requested: bool,
}

pub type AgentModelTestControl = Arc<Mutex<AgentModelTestState>>;

pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_FILE_NAME)
}

pub fn settings_v1_backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_V1_BACKUP_FILE_NAME)
}

pub fn settings_v2_backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_V2_BACKUP_FILE_NAME)
}

pub fn settings_v3_backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_V3_BACKUP_FILE_NAME)
}

pub fn settings_v4_backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_V4_BACKUP_FILE_NAME)
}

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

pub fn default_settings() -> AgentLlmSettings {
    let mut capabilities = unknown_capabilities();
    for (name, value) in [
        ("function_call", "yes"),
        ("reasoning", "yes"),
        ("vision_input", "no"),
        ("image_output", "no"),
        ("image_edit", "no"),
        ("audio_input", "no"),
        ("audio_output", "no"),
        ("structured_output", "yes"),
        ("web_search", "no"),
    ] {
        capabilities.insert(name.to_string(), capability_value(value, "aisdk_catalog"));
    }
    AgentLlmSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        revision: 1,
        providers: vec![AgentProviderProfile {
            id: "provider-deepseek-existing".to_string(),
            display_name: "DeepSeek".to_string(),
            kind: "registered".to_string(),
            registered_provider_id: Some("deepseek".to_string()),
            api_key_env: Some("DEEPSEEK_API_KEY".to_string()),
            api_key_required: true,
            base_url: None,
            base_url_env: None,
            wire_api: None,
            disable_stream_options: None,
            credential_source: CREDENTIAL_SOURCE_RHO_VAULT.to_string(),
        }],
        models: vec![AgentModelProfile {
            id: "model-deepseek-v4-flash".to_string(),
            provider_id: "provider-deepseek-existing".to_string(),
            display_name: "DeepSeek V4 Flash".to_string(),
            model_id: "deepseek-v4-flash".to_string(),
            enabled: true,
            model_type: capability_value("language", "aisdk_catalog"),
            capabilities,
            context_window_tokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
            reserved_output_tokens: CONSERVATIVE_RESERVED_OUTPUT_TOKENS,
            context_capacity_source: "conservative_default".to_string(),
            last_test: None,
        }],
        capability_routes: vec![AgentCapabilityRoute {
            capability: "agent.chat".to_string(),
            model_id: "model-deepseek-v4-flash".to_string(),
            model_type: "language".to_string(),
            required_model_capabilities: Vec::new(),
        }],
    }
}

pub fn load_settings(data_dir: &Path) -> Result<AgentLlmSettings> {
    let path = settings_path(data_dir);
    if !path.exists() {
        let settings = default_settings();
        validate_settings(&settings)?;
        return Ok(settings);
    }
    let bytes = std::fs::read(&path)
        .with_context(|| format!("reading Agent LLM settings {}", path.display()))?;
    ensure!(
        bytes.len() <= MAX_SETTINGS_BYTES,
        "Agent LLM settings exceed the 256 KiB limit."
    );
    let envelope: serde_json::Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("decoding Agent LLM settings {}", path.display()))?;
    let schema_version = envelope
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        .context("Agent LLM settings are missing a numeric schema_version.")?;
    let settings = match schema_version {
        1 => {
            let legacy: AgentLlmSettingsV1 = serde_json::from_value(envelope)
                .with_context(|| format!("decoding V1 Agent LLM settings {}", path.display()))?;
            validate_settings_v1(&legacy)?;
            migrate_settings_v1(legacy)?
        }
        2 => {
            let legacy: AgentLlmSettingsV2 = serde_json::from_value(envelope)
                .with_context(|| format!("decoding V2 Agent LLM settings {}", path.display()))?;
            migrate_settings_v2(legacy)?
        }
        3 => {
            let legacy: AgentLlmSettingsV3 = serde_json::from_value(envelope)
                .with_context(|| format!("decoding V3 Agent LLM settings {}", path.display()))?;
            migrate_settings_v3(legacy)?
        }
        4 => {
            let legacy: AgentLlmSettingsV4 = serde_json::from_value(envelope)
                .with_context(|| format!("decoding V4 Agent LLM settings {}", path.display()))?;
            migrate_settings_v4(legacy)?
        }
        5 => serde_json::from_value(envelope)
            .with_context(|| format!("decoding V5 Agent LLM settings {}", path.display()))?,
        _ => bail!("Unsupported Agent LLM schema version."),
    };
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn save_settings(data_dir: &Path, settings: &AgentLlmSettings) -> Result<()> {
    save_settings_with(data_dir, settings, |path, bytes| atomic_write(path, bytes))
}

fn save_settings_with<F>(data_dir: &Path, settings: &AgentLlmSettings, write: F) -> Result<()>
where
    F: FnMut(&Path, &[u8]) -> Result<()>,
{
    save_settings_with_components(
        data_dir,
        settings,
        |value| serde_json::to_vec_pretty(value).map_err(Into::into),
        write,
    )
}

fn save_settings_with_components<S, F>(
    data_dir: &Path,
    settings: &AgentLlmSettings,
    serialize: S,
    mut write: F,
) -> Result<()>
where
    S: FnOnce(&AgentLlmSettings) -> Result<Vec<u8>>,
    F: FnMut(&Path, &[u8]) -> Result<()>,
{
    validate_settings(settings)?;
    let path = settings_path(data_dir);
    let bytes = serialize(settings)?;
    ensure!(
        bytes.len() <= MAX_SETTINGS_BYTES,
        "Agent LLM settings exceed the 256 KiB limit."
    );

    if path.exists() {
        let current = std::fs::read(&path)
            .with_context(|| format!("reading Agent LLM settings {}", path.display()))?;
        ensure!(
            current.len() <= MAX_SETTINGS_BYTES,
            "Existing Agent LLM settings exceed the 256 KiB limit."
        );
        let envelope: serde_json::Value = serde_json::from_slice(&current)
            .with_context(|| format!("decoding Agent LLM settings {}", path.display()))?;
        let version = envelope
            .get("schema_version")
            .and_then(serde_json::Value::as_u64)
            .context("Agent LLM settings are missing a numeric schema_version.")?;
        if matches!(version, 1 | 2 | 3 | 4) {
            let backup_path = match version {
                1 => settings_v1_backup_path(data_dir),
                2 => settings_v2_backup_path(data_dir),
                3 => settings_v3_backup_path(data_dir),
                _ => settings_v4_backup_path(data_dir),
            };
            if backup_path.exists() {
                let existing = std::fs::read(&backup_path).with_context(|| {
                    format!(
                        "reading Agent LLM migration backup {}",
                        backup_path.display()
                    )
                })?;
                ensure!(
                    existing == current,
                    "The existing Agent LLM migration backup does not match the source."
                );
            } else {
                write(&backup_path, &current).with_context(|| {
                    format!(
                        "writing Agent LLM migration backup {}",
                        backup_path.display()
                    )
                })?;
            }
        } else {
            ensure!(version == 5, "Unsupported Agent LLM schema version.");
        }
    }

    write(&path, &bytes).with_context(|| format!("writing Agent LLM settings {}", path.display()))
}

fn migrate_settings_v1(legacy: AgentLlmSettingsV1) -> Result<AgentLlmSettings> {
    let selected_model_id = legacy.selected_model_id.clone();
    let models = legacy
        .models
        .into_iter()
        .map(|model| {
            let source = match model.capabilities.source.as_str() {
                "catalog" => "aisdk_catalog",
                "declared" => "user_declared",
                "probe" => "provider_response",
                _ => "unknown",
            };
            let mut capabilities = unknown_capabilities();
            capabilities.insert(
                "function_call".to_string(),
                capability_value(&model.capabilities.tool_calling, source),
            );
            capabilities.insert(
                "reasoning".to_string(),
                capability_value(&model.capabilities.reasoning, source),
            );
            capabilities.insert(
                "vision_input".to_string(),
                capability_value(&model.capabilities.vision_input, source),
            );
            AgentModelProfile {
                id: model.id,
                provider_id: model.provider_id,
                display_name: model.display_name,
                model_id: model.model_id,
                enabled: model.enabled,
                model_type: capability_value("unknown", "unknown"),
                capabilities,
                context_window_tokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
                reserved_output_tokens: CONSERVATIVE_RESERVED_OUTPUT_TOKENS,
                context_capacity_source: "conservative_default".to_string(),
                last_test: model.last_test,
            }
        })
        .collect::<Vec<_>>();
    let settings = AgentLlmSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        revision: 0,
        providers: legacy
            .providers
            .into_iter()
            .map(AgentProviderProfileV3::into_current)
            .collect(),
        models,
        capability_routes: vec![AgentCapabilityRoute {
            capability: "agent.chat".to_string(),
            model_id: selected_model_id,
            model_type: "language".to_string(),
            required_model_capabilities: Vec::new(),
        }],
    };
    validate_settings(&settings)?;
    Ok(settings)
}

fn migrate_settings_v2(legacy: AgentLlmSettingsV2) -> Result<AgentLlmSettings> {
    ensure!(legacy.schema_version == 2, "Expected Agent LLM schema V2.");
    let settings = AgentLlmSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        revision: legacy.revision,
        providers: legacy
            .providers
            .into_iter()
            .map(AgentProviderProfileV3::into_current)
            .collect(),
        models: legacy
            .models
            .into_iter()
            .map(|model| AgentModelProfile {
                id: model.id,
                provider_id: model.provider_id,
                display_name: model.display_name,
                model_id: model.model_id,
                enabled: model.enabled,
                model_type: model.model_type,
                capabilities: model.capabilities,
                context_window_tokens: CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
                reserved_output_tokens: CONSERVATIVE_RESERVED_OUTPUT_TOKENS,
                context_capacity_source: "conservative_default".to_string(),
                last_test: model.last_test,
            })
            .collect(),
        capability_routes: legacy.capability_routes,
    };
    validate_settings(&settings)?;
    Ok(settings)
}

fn migrate_settings_v3(legacy: AgentLlmSettingsV3) -> Result<AgentLlmSettings> {
    ensure!(legacy.schema_version == 3, "Expected Agent LLM schema V3.");
    let settings = AgentLlmSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        revision: legacy.revision,
        providers: legacy
            .providers
            .into_iter()
            .map(AgentProviderProfileV3::into_current)
            .collect(),
        models: legacy.models,
        capability_routes: legacy.capability_routes,
    };
    validate_settings(&settings)?;
    Ok(settings)
}

fn migrate_settings_v4(legacy: AgentLlmSettingsV4) -> Result<AgentLlmSettings> {
    ensure!(legacy.schema_version == 4, "Expected Agent LLM schema V4.");
    let settings = AgentLlmSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        revision: legacy.revision,
        providers: legacy
            .providers
            .into_iter()
            .map(|mut provider| {
                if provider.credential_source == LEGACY_CREDENTIAL_SOURCE_SYSTEM_STORE {
                    provider.credential_source = CREDENTIAL_SOURCE_RHO_VAULT.to_string();
                }
                provider
            })
            .collect(),
        models: legacy.models,
        capability_routes: legacy.capability_routes,
    };
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn save_provider(data_dir: &Path, provider: AgentProviderProfile) -> Result<AgentLlmSettings> {
    let _provider_op_lock = credential_operation_lock(&provider.id);
    let _guard = settings_mutation_guard();
    let mut settings = load_settings(data_dir)?;
    let audited_provider_id = provider.id.clone();
    if let Some(slot) = settings
        .providers
        .iter_mut()
        .find(|item| item.id == provider.id)
    {
        *slot = provider;
    } else {
        settings.providers.push(provider);
    }
    increment_revision(&mut settings)?;
    save_settings(data_dir, &settings)?;
    // Every successful Provider profile write invalidates a staged reveal;
    // source/key-requirement changes are the critical cases, while advancing
    // on all profile writes makes the boundary conservative and auditable.
    advance_credential_generation(&audited_provider_id);
    Ok(settings)
}

pub fn delete_provider(
    data_dir: &Path,
    request: &DeleteProviderRequest,
) -> Result<AgentLlmSettings> {
    delete_provider_with_store(data_dir, request, &RhoCredentialVaultStore::new(data_dir))
}

fn delete_provider_with_store(
    data_dir: &Path,
    request: &DeleteProviderRequest,
    credential_store: &impl CredentialStore,
) -> Result<AgentLlmSettings> {
    delete_provider_with_store_and_save(data_dir, request, credential_store, save_settings)
}

fn delete_provider_with_store_and_save<F>(
    data_dir: &Path,
    request: &DeleteProviderRequest,
    credential_store: &impl CredentialStore,
    save: F,
) -> Result<AgentLlmSettings>
where
    F: FnOnce(&Path, &AgentLlmSettings) -> Result<()>,
{
    let _provider_op_lock = credential_operation_lock(&request.provider_id);
    let _guard = settings_mutation_guard();
    let mut settings = load_settings(data_dir)?;
    ensure!(
        settings.revision == request.expected_revision,
        "Model settings changed while this provider delete confirmation was open. Reload and review the updated impact."
    );
    let provider_id = request.provider_id.as_str();
    validate_bounded(provider_id, "Provider ID", MAX_ID_LENGTH)?;
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .with_context(|| format!("Unknown provider: {provider_id}"))?
        .clone();
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
    // Environment-sourced credentials are managed outside Rho; deleting the
    // provider never touches them.
    let manages_credential =
        provider.api_key_required && provider.credential_source != CREDENTIAL_SOURCE_ENVIRONMENT;
    let previous_credential = if manages_credential {
        resolve_provider_credential(data_dir, &provider, credential_store)?
    } else {
        None
    };
    if manages_credential {
        delete_provider_credential(data_dir, &provider, credential_store)?;
    }
    if let Err(save_error) = save(data_dir, &settings) {
        let recovery = if let Some(credential) = previous_credential.as_deref() {
            if let Err(restore_error) =
                store_provider_credential(data_dir, &provider, credential, credential_store)
            {
                return Err(anyhow::anyhow!(
                    "Provider metadata could not be saved ({save_error:#}), and its credential could not be restored ({restore_error:#})."
                ));
            }
            "Provider metadata could not be saved; its credential was restored"
        } else {
            "Provider metadata could not be saved; no credential needed restoration"
        };
        return Err(save_error.context(recovery));
    }
    if manages_credential {
        record_credential_audit(
            data_dir,
            "provider_credential_delete",
            provider_id,
            &provider.credential_source,
            "ok",
            None,
        );
    }
    advance_credential_generation(provider_id);
    Ok(settings)
}

pub fn set_credential(
    data_dir: &Path,
    provider_id: &str,
    credential: &str,
    confirm_replace: bool,
) -> Result<()> {
    set_credential_with_store(
        data_dir,
        provider_id,
        credential,
        confirm_replace,
        &RhoCredentialVaultStore::new(data_dir),
    )
}

fn set_credential_with_store(
    data_dir: &Path,
    provider_id: &str,
    credential: &str,
    confirm_replace: bool,
    credential_store: &impl CredentialStore,
) -> Result<()> {
    let _provider_op_lock = credential_operation_lock(provider_id);
    let _guard = settings_mutation_guard();
    let settings = load_settings(data_dir)?;
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .with_context(|| format!("Unknown provider: {provider_id}"))?;
    ensure!(
        provider.api_key_required,
        "This provider does not require an API key."
    );
    ensure!(
        provider.credential_source != CREDENTIAL_SOURCE_ENVIRONMENT,
        "This provider reads its API key from an environment variable; manage it outside Rho."
    );
    ensure!(!credential.is_empty(), "Enter an API key before saving.");
    ensure!(
        !credential.chars().any(char::is_control),
        "The API key contains control characters or line breaks. Paste the key exactly as issued."
    );
    ensure!(
        credential.len() <= MAX_CREDENTIAL_BYTES,
        "The API key exceeds the {MAX_CREDENTIAL_BYTES_LABEL} storage limit."
    );
    let existing = resolve_provider_credential(data_dir, provider, credential_store)?;
    let replacing = existing.is_some();
    ensure!(
        confirm_replace || !replacing,
        "An API key is already saved for this provider. Confirm replacement to overwrite it."
    );
    let result = store_provider_credential(data_dir, provider, credential, credential_store);
    record_credential_audit(
        data_dir,
        if replacing {
            "credential_replace"
        } else {
            "credential_set"
        },
        provider_id,
        &provider.credential_source,
        if result.is_ok() { "ok" } else { "failed" },
        None,
    );
    if result.is_ok() {
        advance_credential_generation(provider_id);
    }
    result
}

pub fn delete_credential(data_dir: &Path, provider_id: &str) -> Result<()> {
    delete_credential_with_store(
        data_dir,
        provider_id,
        &RhoCredentialVaultStore::new(data_dir),
    )
}

fn delete_credential_with_store(
    data_dir: &Path,
    provider_id: &str,
    credential_store: &impl CredentialStore,
) -> Result<()> {
    let _provider_op_lock = credential_operation_lock(provider_id);
    let _guard = settings_mutation_guard();
    let settings = load_settings(data_dir)?;
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .with_context(|| format!("Unknown provider: {provider_id}"))?;
    ensure!(
        provider.api_key_required,
        "This provider does not require an API key."
    );
    ensure!(
        provider.credential_source != CREDENTIAL_SOURCE_ENVIRONMENT,
        "This provider reads its API key from an environment variable; manage it outside Rho."
    );
    let result = delete_provider_credential(data_dir, provider, credential_store);
    record_credential_audit(
        data_dir,
        "credential_delete",
        provider_id,
        &provider.credential_source,
        if result.is_ok() { "ok" } else { "failed" },
        None,
    );
    if result.is_ok() {
        advance_credential_generation(provider_id);
    }
    result
}

pub fn save_model(data_dir: &Path, model: AgentModelProfile) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mut settings = load_settings(data_dir)?;
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
    save_settings(data_dir, &settings)?;
    Ok(settings)
}

pub fn set_context_capacity(
    data_dir: &Path,
    request: &AgentContextCapacityRequest,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    set_context_capacity_with_save(data_dir, request, save_settings)
}

fn set_context_capacity_with_save<F>(
    data_dir: &Path,
    request: &AgentContextCapacityRequest,
    save: F,
) -> Result<AgentLlmSettings>
where
    F: FnOnce(&Path, &AgentLlmSettings) -> Result<()>,
{
    let mut settings = load_settings(data_dir)?;
    ensure!(
        settings.revision == request.expected_revision,
        "Model settings changed while this context capacity editor was open. Reload and try again."
    );
    validate_bounded(&request.model_id, "Model ID", MAX_ID_LENGTH)?;
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
    save(data_dir, &settings)?;
    Ok(settings)
}

pub fn declare_model_capability(
    data_dir: &Path,
    request: &AgentModelCapabilityDeclarationRequest,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    declare_model_capability_with_save(data_dir, request, save_settings)
}

fn declare_model_capability_with_save<F>(
    data_dir: &Path,
    request: &AgentModelCapabilityDeclarationRequest,
    save: F,
) -> Result<AgentLlmSettings>
where
    F: FnOnce(&Path, &AgentLlmSettings) -> Result<()>,
{
    let mut settings = load_settings(data_dir)?;
    ensure!(
        settings.revision == request.expected_revision,
        "Model settings changed while this capability editor was open. Reload and try again."
    );
    validate_bounded(&request.model_id, "Model ID", MAX_ID_LENGTH)?;
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
    validate_model(model)?;
    increment_revision(&mut settings)?;
    save(data_dir, &settings)?;
    Ok(settings)
}

pub fn delete_model(data_dir: &Path, request: &DeleteModelRequest) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mut settings = load_settings(data_dir)?;
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
    save_settings(data_dir, &settings)?;
    Ok(settings)
}

pub fn save_capability_route(
    data_dir: &Path,
    expected_revision: u64,
    route: AgentCapabilityRoute,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    save_capability_route_with_save(data_dir, expected_revision, route, save_settings)
}

fn save_capability_route_with_save<F>(
    data_dir: &Path,
    expected_revision: u64,
    route: AgentCapabilityRoute,
    save: F,
) -> Result<AgentLlmSettings>
where
    F: FnOnce(&Path, &AgentLlmSettings) -> Result<()>,
{
    let mut settings = load_settings(data_dir)?;
    ensure!(
        settings.revision == expected_revision,
        "Model settings changed while this route editor was open. Reload and try again."
    );
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
    save(data_dir, &settings)?;
    Ok(settings)
}

pub fn delete_capability_route(
    data_dir: &Path,
    expected_revision: u64,
    capability: &str,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    delete_capability_route_with_save(data_dir, expected_revision, capability, save_settings)
}

fn delete_capability_route_with_save<F>(
    data_dir: &Path,
    expected_revision: u64,
    capability: &str,
    save: F,
) -> Result<AgentLlmSettings>
where
    F: FnOnce(&Path, &AgentLlmSettings) -> Result<()>,
{
    let mut settings = load_settings(data_dir)?;
    ensure!(
        settings.revision == expected_revision,
        "Model settings changed while this route editor was open. Reload and try again."
    );
    validate_capability_name(capability)?;
    ensure!(
        capability != "agent.chat",
        "The required agent.chat route cannot be removed."
    );
    let before = settings.capability_routes.len();
    settings
        .capability_routes
        .retain(|route| route.capability != capability);
    ensure!(
        settings.capability_routes.len() != before,
        "Unknown capability route: {capability}"
    );
    increment_revision(&mut settings)?;
    save(data_dir, &settings)?;
    Ok(settings)
}

pub fn declare_model_capabilities(
    data_dir: &Path,
    expected_revision: u64,
    model_id: &str,
    patch: AgentModelCapabilityPatch,
) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    declare_model_capabilities_with_save(
        data_dir,
        expected_revision,
        model_id,
        patch,
        save_settings,
    )
}

fn declare_model_capabilities_with_save<F>(
    data_dir: &Path,
    expected_revision: u64,
    model_id: &str,
    patch: AgentModelCapabilityPatch,
    save: F,
) -> Result<AgentLlmSettings>
where
    F: FnOnce(&Path, &AgentLlmSettings) -> Result<()>,
{
    ensure!(
        patch.model_type.is_some() || !patch.capabilities.is_empty(),
        "Declare at least one model type or capability value."
    );
    let mut settings = load_settings(data_dir)?;
    ensure!(
        settings.revision == expected_revision,
        "Model settings changed while this capability editor was open. Reload and try again."
    );
    let model = settings
        .models
        .iter_mut()
        .find(|model| model.id == model_id)
        .with_context(|| format!("Unknown model: {model_id}"))?;
    if let Some(model_type) = patch.model_type {
        ensure!(
            matches!(
                model_type.as_str(),
                "language" | "embedding" | "image" | "unknown"
            ),
            "Model type must be language, embedding, image or unknown."
        );
        model.model_type = capability_value(&model_type, "user_declared");
    }
    for (name, value) in patch.capabilities {
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
            .insert(name, capability_value(&value, "user_declared"));
    }
    increment_revision(&mut settings)?;
    save(data_dir, &settings)?;
    Ok(settings)
}

pub fn settings_view(data_dir: &Path, rscript: &Path) -> Result<AgentLlmSettingsView> {
    let _guard = settings_mutation_guard();
    let settings = load_settings(data_dir)?;
    settings_view_from_settings(data_dir, rscript, settings)
}

pub fn settings_view_from_settings(
    data_dir: &Path,
    rscript: &Path,
    settings: AgentLlmSettings,
) -> Result<AgentLlmSettingsView> {
    settings_view_from_settings_with(data_dir, settings, || {
        catalog_cached(data_dir, rscript).ok()
    })
}

fn settings_view_from_settings_with<F>(
    data_dir: &Path,
    mut settings: AgentLlmSettings,
    catalog: F,
) -> Result<AgentLlmSettingsView>
where
    F: FnOnce() -> Option<Arc<Vec<AgentCatalogEntry>>>,
{
    // Presentation-only projection: durable settings are never rewritten here;
    // the runtime execution budget keeps reading the persisted profile.
    if let Some(entries) = catalog() {
        project_catalog_capacity(&mut settings, &entries);
    }
    Ok(settings_view_from_settings_projection(data_dir, settings))
}

fn settings_view_from_settings_projection(
    data_dir: &Path,
    settings: AgentLlmSettings,
) -> AgentLlmSettingsView {
    let statuses = credential_status_map(data_dir, &settings.providers);
    build_settings_view(settings, system_credential_info(), statuses)
}

pub fn refresh_credentials_view(data_dir: &Path, rscript: &Path) -> Result<AgentLlmSettingsView> {
    settings_view(data_dir, rscript)
}

pub fn clear_session_credentials() {
    credential_session().clear();
    agent_credential_vault::clear_all_sessions();
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

#[cfg(test)]
fn catalog_cache_clear() {
    catalog_cache_store().lock().unwrap().clear();
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
    provider_id: &str,
) -> Result<AgentModelDiscoveryResponse> {
    let client = model_discovery_client()?;
    let mut response = discover_models_with_store(
        data_dir,
        provider_id,
        &RhoCredentialVaultStore::new(data_dir),
        &client,
    )?;
    if response.status == "ready" && !response.models.is_empty() {
        let settings = load_settings(data_dir)?;
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
    provider_id: &str,
    credential_store: &impl CredentialStore,
    client: &reqwest::blocking::Client,
) -> Result<AgentModelDiscoveryResponse> {
    let settings = load_settings(data_dir)?;
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
        match resolve_provider_credential(data_dir, provider, credential_store) {
            Ok(Some(value)) => {
                record_credential_audit(
                    data_dir,
                    "credential_discovery_read",
                    provider_id,
                    &provider.credential_source,
                    "detected",
                    None,
                );
                Some(value)
            }
            Ok(None) => {
                record_credential_audit(
                    data_dir,
                    "credential_discovery_read",
                    provider_id,
                    &provider.credential_source,
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
                    &provider.credential_source,
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
        let resolved = std::env::var(environment_name)
            .ok()
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
    agent_package: &Path,
    model_id: &str,
    test_control: Option<&AgentModelTestControl>,
) -> Result<AgentLlmSettingsView> {
    test_model_with_store(
        data_dir,
        rscript,
        agent_package,
        model_id,
        test_control,
        &RhoCredentialVaultStore::new(data_dir),
    )
}

fn test_model_with_store(
    data_dir: &Path,
    rscript: &Path,
    agent_package: &Path,
    model_id: &str,
    test_control: Option<&AgentModelTestControl>,
    credential_store: &impl CredentialStore,
) -> Result<AgentLlmSettingsView> {
    let settings = load_settings(data_dir)?;
    let test_model = settings
        .models
        .iter()
        .find(|model| model.id == model_id)
        .with_context(|| format!("Unknown model: {model_id}"))?;
    ensure!(
        test_model.model_type.value == "language",
        "Only language models use the text connection test. Image and embedding probes are not installed."
    );
    let resolved = resolve_model_with_settings(&settings, Some(model_id))?;
    let probe_environment_names = provider_probe_environment_names(&settings);
    let credential_override = credential_override_with_store(
        data_dir,
        &settings,
        &resolved.provider_id,
        credential_store,
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
    let mut latest_settings = load_settings(data_dir)?;
    let latest_resolved = resolve_model_with_settings(&latest_settings, Some(model_id))?;
    ensure!(
        latest_settings.revision == settings.revision
            && latest_resolved.runtime_profile == resolved.runtime_profile,
        "The model configuration changed during the connection test; the test result was not saved."
    );
    update_model_after_test(&mut latest_settings, model_id, &result)?;
    increment_revision(&mut latest_settings)?;
    save_settings(data_dir, &latest_settings)?;
    settings_view_from_settings(data_dir, rscript, latest_settings)
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
    requested_model_id: Option<&str>,
    mode: &str,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let _guard = settings_mutation_guard();
    let settings = load_settings(data_dir)?;
    resolve_model_and_credential_for_turn_with_store(
        data_dir,
        &settings,
        requested_model_id,
        mode,
        &RhoCredentialVaultStore::new(data_dir),
    )
}

pub fn resolve_model_and_credential_for_task(
    data_dir: &Path,
    requested_model_id: Option<&str>,
    mode: &str,
    task_kind: &str,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let _guard = settings_mutation_guard();
    let settings = load_settings(data_dir)?;
    resolve_model_and_credential_for_task_with_store(
        data_dir,
        &settings,
        requested_model_id,
        mode,
        task_kind,
        &RhoCredentialVaultStore::new(data_dir),
    )
}

fn resolve_model_and_credential_for_task_with_store(
    data_dir: &Path,
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
    mode: &str,
    task_kind: &str,
    credential_store: &impl CredentialStore,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let resolved =
        resolve_model_for_task_with_settings(settings, requested_model_id, mode, task_kind)?;
    let credential = credential_override_with_store(
        data_dir,
        settings,
        &resolved.provider_id,
        credential_store,
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
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let resolved = resolve_model_for_turn_with_settings(settings, requested_model_id, mode)?;
    let credential = credential_override_with_store(
        data_dir,
        settings,
        &resolved.provider_id,
        credential_store,
        "credential_turn_inject",
    )?;
    Ok((resolved, credential))
}

fn resolve_model_for_turn_with_settings(
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
    mode: &str,
) -> Result<ResolvedAgentModel> {
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
    let resolved = resolve_provider_credential(data_dir, provider, credential_store);
    record_credential_audit(
        data_dir,
        audit_event,
        provider_id,
        &provider.credential_source,
        match &resolved {
            Ok(Some(_)) => "detected",
            Ok(None) => "not_detected",
            Err(_) => "unavailable",
        },
        None,
    );
    let Some(value) = resolved? else {
        return Ok(None);
    };
    let env_name = provider
        .api_key_env
        .clone()
        .context("The provider has no API key environment name.")?;
    Ok(Some((env_name, value)))
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

fn validate_settings_v1(settings: &AgentLlmSettingsV1) -> Result<()> {
    ensure!(
        settings.schema_version == 1,
        "Expected Agent LLM schema V1."
    );
    validate_bounded(
        &settings.selected_model_id,
        "Selected model ID",
        MAX_ID_LENGTH,
    )?;
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
        validate_provider_v3(provider)?;
        ensure!(
            provider_ids.insert(&provider.id),
            "Provider IDs must be unique."
        );
    }
    let mut model_ids = HashSet::new();
    for model in &settings.models {
        validate_bounded(&model.id, "Model ID", MAX_ID_LENGTH)?;
        validate_bounded(&model.provider_id, "Provider reference", MAX_ID_LENGTH)?;
        validate_bounded(&model.display_name, "Model display name", MAX_NAME_LENGTH)?;
        validate_bounded(&model.model_id, "Provider model ID", MAX_MODEL_ID_LENGTH)?;
        validate_capabilities_v1(&model.capabilities)?;
        ensure!(model_ids.insert(&model.id), "Model IDs must be unique.");
        ensure!(
            provider_ids.contains(&model.provider_id),
            "Each model must reference an existing provider."
        );
    }
    let selected = settings
        .models
        .iter()
        .find(|model| model.id == settings.selected_model_id)
        .context("Selected model must exist.")?;
    ensure!(selected.enabled, "Selected model must remain enabled.");
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
        validation_error: None,
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

fn validate_provider_v3(provider: &AgentProviderProfileV3) -> Result<()> {
    validate_provider(&provider.clone().into_current())
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
        is_supported_credential_source(&provider.credential_source),
        "Unsupported credential source."
    );
    #[cfg(not(target_os = "linux"))]
    ensure!(
        provider.credential_source != LEGACY_CREDENTIAL_SOURCE_FILE_FALLBACK,
        "File-based credential storage is only available on Linux."
    );
    if provider.credential_source == CREDENTIAL_SOURCE_ENVIRONMENT && provider.api_key_required {
        ensure!(
            provider.api_key_env.is_some(),
            "Environment-sourced credentials require an API key environment name."
        );
    }
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

fn validate_capabilities_v1(capabilities: &AgentModelCapabilitiesV1) -> Result<()> {
    for value in [
        capabilities.tool_calling.as_str(),
        capabilities.reasoning.as_str(),
        capabilities.vision_input.as_str(),
    ] {
        ensure!(
            matches!(value, "yes" | "no" | "unknown"),
            "Capability values must be yes, no or unknown."
        );
    }
    ensure!(
        matches!(
            capabilities.source.as_str(),
            "catalog" | "declared" | "probe" | "unknown"
        ),
        "Capability source must be catalog, declared, probe or unknown."
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
}

fn credential_status_map(
    data_dir: &Path,
    providers: &[AgentProviderProfile],
) -> HashMap<String, CredentialPresentation> {
    providers
        .iter()
        .map(|provider| {
            let presentation = if !provider.api_key_required {
                credential_presentation_for_provider(provider)
            } else {
                match provider.credential_source.as_str() {
                    CREDENTIAL_SOURCE_RHO_VAULT => {
                        let status = agent_credential_vault::status(data_dir, &provider.id);
                        CredentialPresentation {
                            status: match status {
                                CredentialVaultStatus::Missing => "not_detected",
                                CredentialVaultStatus::Saved => "detected",
                                CredentialVaultStatus::Unavailable => "unavailable",
                            }
                            .to_string(),
                            source: "rho_vault".to_string(),
                        }
                    }
                    CREDENTIAL_SOURCE_ENVIRONMENT => CredentialPresentation {
                        status: if environment_credential_present(provider) {
                            "detected".to_string()
                        } else {
                            "not_detected".to_string()
                        },
                        source: "environment".to_string(),
                    },
                    CREDENTIAL_SOURCE_SESSION_ONLY => CredentialPresentation {
                        status: if credential_session()
                            .session_credential(&provider.id)
                            .is_some()
                        {
                            "detected".to_string()
                        } else {
                            "not_detected".to_string()
                        },
                        source: "session".to_string(),
                    },
                    _ => credential_presentation_for_provider(provider),
                }
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
        capabilities: AgentModelCapabilitiesV1 {
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

/// Fixed four-word terminal vocabulary for `agent_llm_view_credential`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentLlmCredentialRevealOutcome {
    Revealed,
    CredentialMissing,
    StoreUnavailable,
    SourceIneligible,
}

/// The response carries the stored value only on `Revealed`; every failure
/// outcome resolves with `credential: None` and no store-layer detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct AgentLlmCredentialRevealView {
    pub outcome: AgentLlmCredentialRevealOutcome,
    pub credential: Option<String>,
}

const REVEAL_AUDIT_EVENT: &str = "credential_reveal";

static REVEAL_AUDIT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CREDENTIAL_GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static CREDENTIAL_OPERATION_STATE: OnceLock<(Mutex<HashSet<String>>, Condvar)> = OnceLock::new();

fn reveal_audit_guard() -> MutexGuard<'static, ()> {
    REVEAL_AUDIT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn credential_generation_entries() -> &'static Mutex<HashMap<String, u64>> {
    CREDENTIAL_GENERATIONS.get_or_init(Default::default)
}

/// Monotonic token capturing Rho-owned credential state for one Provider.
/// Mutation paths advance it after every successful Rho-owned write; CRED-
/// REVEAL-1C no longer consults it, so only tests read the value.
#[cfg(test)]
fn credential_generation(provider_id: &str) -> u64 {
    credential_generation_entries()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(provider_id)
        .copied()
        .unwrap_or(0)
}

/// Called only after a Rho-owned credential mutation fully succeeded.
pub(crate) fn advance_credential_generation(provider_id: &str) {
    let mut entries = credential_generation_entries()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    entries
        .entry(provider_id.to_string())
        .and_modify(|generation| *generation = generation.saturating_add(1))
        .or_insert(1);
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
fn rotate_credential_audit_bytes(bytes: &mut Vec<u8>) {
    if bytes.len() > MAX_CREDENTIAL_AUDIT_BYTES {
        let tail_start = bytes.len() - CREDENTIAL_AUDIT_KEEP_BYTES;
        // The byte vector always ends with the just-appended row's newline.
        // Exclude that terminator from the alignment search: if an older
        // corrupt/legacy oversized line contains no newline, selecting the
        // final terminator would otherwise discard the new durable row too.
        let alignment_end = bytes.len().saturating_sub(1);
        let aligned = bytes[tail_start..alignment_end]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| tail_start + offset + 1)
            .unwrap_or(tail_start);
        let kept = bytes.split_off(aligned);
        *bytes = kept;
    }
}

/// `load_settings` correctly rejects unknown source values. The reveal
/// contract nevertheless distinguishes that fail-closed case from an
/// unavailable settings store, so inspect only the bounded V5 metadata needed
/// to classify the target Provider after validation fails. Settings never
/// contain credential values.
fn target_provider_has_ineligible_persisted_source(data_dir: &Path, provider_id: &str) -> bool {
    let Ok(bytes) = std::fs::read(settings_path(data_dir)) else {
        return false;
    };
    if bytes.len() > MAX_SETTINGS_BYTES {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    if value
        .get("schema_version")
        .and_then(serde_json::Value::as_u64)
        != Some(5)
    {
        return false;
    }
    value
        .get("providers")
        .and_then(serde_json::Value::as_array)
        .and_then(|providers| {
            providers.iter().find(|provider| {
                provider.get("id").and_then(serde_json::Value::as_str) == Some(provider_id)
            })
        })
        .and_then(|provider| {
            provider
                .get("credential_source")
                .and_then(serde_json::Value::as_str)
        })
        .is_some_and(|source| {
            source == LEGACY_CREDENTIAL_SOURCE_FILE_FALLBACK
                || !is_supported_credential_source(source)
        })
}

/// CRED-REVEAL-1C entry point behind `agent_llm_view_credential`: one
/// explicit click, one fresh exact-source read, one response. Failures carry
/// no store-layer detail, and the best-effort audit row records provider ID,
/// source, outcome, and time only — never the value.
pub(crate) fn view_provider_credential(
    data_dir: &Path,
    provider_id: &str,
) -> AgentLlmCredentialRevealView {
    let refuse = |outcome: AgentLlmCredentialRevealOutcome| AgentLlmCredentialRevealView {
        outcome,
        credential: None,
    };
    if provider_id.is_empty()
        || provider_id.len() > MAX_ID_LENGTH
        || provider_id.chars().any(char::is_control)
    {
        return refuse(AgentLlmCredentialRevealOutcome::SourceIneligible);
    }
    let settings = match load_settings(data_dir) {
        Ok(settings) => settings,
        Err(_) if target_provider_has_ineligible_persisted_source(data_dir, provider_id) => {
            return refuse(AgentLlmCredentialRevealOutcome::SourceIneligible);
        }
        Err(_) => return refuse(AgentLlmCredentialRevealOutcome::StoreUnavailable),
    };
    let Some(provider) = settings.providers.iter().find(|p| p.id == provider_id) else {
        return refuse(AgentLlmCredentialRevealOutcome::SourceIneligible);
    };
    if !provider.api_key_required || !is_supported_credential_source(&provider.credential_source) {
        return refuse(AgentLlmCredentialRevealOutcome::SourceIneligible);
    }
    // `environment` is refused before its variable is ever read; the legacy
    // file fallback has no display path.
    if matches!(
        provider.credential_source.as_str(),
        CREDENTIAL_SOURCE_ENVIRONMENT | LEGACY_CREDENTIAL_SOURCE_FILE_FALLBACK
    ) {
        return refuse(AgentLlmCredentialRevealOutcome::SourceIneligible);
    }
    let secret = match fresh_reveal_read(data_dir, provider_id, &provider.credential_source) {
        Ok(Some(secret)) => secret,
        Ok(None) => return refuse(AgentLlmCredentialRevealOutcome::CredentialMissing),
        Err(_) => return refuse(AgentLlmCredentialRevealOutcome::StoreUnavailable),
    };
    // CRED-SEC4 best-effort: an audit failure never blocks or alters a view.
    record_credential_audit(
        data_dir,
        REVEAL_AUDIT_EVENT,
        provider_id,
        &provider.credential_source,
        "revealed",
        None,
    );
    let credential = secret.as_str().to_string();
    drop(secret); // zeroized here; only the IPC-bound copy survives
    AgentLlmCredentialRevealView {
        outcome: AgentLlmCredentialRevealOutcome::Revealed,
        credential: Some(credential),
    }
}

/// Fresh exact-source read for one explicit View click. Never consults the
/// runtime read-through cache: `rho_vault` reads and decrypts the vault entry
/// directly and `session_only` reads the live session entry.
fn fresh_reveal_read(
    data_dir: &Path,
    provider_id: &str,
    source: &str,
) -> Result<Option<Zeroizing<String>>> {
    match source {
        CREDENTIAL_SOURCE_RHO_VAULT => agent_credential_vault::get(data_dir, provider_id)
            .map(|value| value.map(Zeroizing::new)),
        CREDENTIAL_SOURCE_SESSION_ONLY => {
            Ok(credential_session().session_credential_zeroizing(provider_id))
        }
        other => bail!("Unsupported credential source for viewing: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::{
        Barrier,
        atomic::{AtomicU32, AtomicUsize, Ordering},
    };
    use std::thread;
    use tempfile::TempDir;

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        if unsafe { unix_kill_process(pid, 0) } == 0 {
            return true;
        }
        io::Error::last_os_error().raw_os_error() != Some(3)
    }

    #[cfg(windows)]
    fn process_is_alive(pid: u32) -> bool {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        const WAIT_OBJECT_0: u32 = 0;
        const WAIT_TIMEOUT: u32 = 258;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(
                desired_access: u32,
                inherit_handle: i32,
                process_id: u32,
            ) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        }

        let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(87) {
                return false;
            }
            panic!("opening process {pid} failed: {error}");
        }
        let handle = WindowsOwnedHandle(handle);
        match unsafe { WaitForSingleObject(handle.0, 0) } {
            WAIT_OBJECT_0 => false,
            WAIT_TIMEOUT => true,
            status => panic!("waiting for process {pid} failed with status {status}"),
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn process_is_alive(_pid: u32) -> bool {
        false
    }

    fn assert_process_terminated(pid: u32, context: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_is_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!process_is_alive(pid), "{context}: process {pid} survived");
    }

    #[derive(Default)]
    struct MemoryCredentialStore {
        entries: Mutex<HashMap<String, String>>,
        get_calls: Mutex<Vec<String>>,
        set_calls: Mutex<Vec<String>>,
        delete_calls: Mutex<Vec<String>>,
        fail_get: bool,
        fail_set: bool,
        fail_delete: bool,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, provider_id: &str) -> Result<Option<String>> {
            self.get_calls.lock().unwrap().push(provider_id.to_string());
            ensure!(!self.fail_get, "injected credential read failure");
            Ok(self.entries.lock().unwrap().get(provider_id).cloned())
        }

        fn set(&self, provider_id: &str, credential: &str) -> Result<()> {
            self.set_calls.lock().unwrap().push(provider_id.to_string());
            ensure!(!self.fail_set, "injected credential write failure");
            self.entries
                .lock()
                .unwrap()
                .insert(provider_id.to_string(), credential.to_string());
            Ok(())
        }

        fn delete(&self, provider_id: &str) -> Result<()> {
            self.delete_calls
                .lock()
                .unwrap()
                .push(provider_id.to_string());
            ensure!(!self.fail_delete, "injected credential delete failure");
            self.entries.lock().unwrap().remove(provider_id);
            Ok(())
        }
    }

    static REVEAL_REGRESSION_LOCK: Mutex<()> = Mutex::new(());
    static REVEAL_FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(1);

    fn reveal_regression_guard() -> MutexGuard<'static, ()> {
        REVEAL_REGRESSION_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn reveal_fixture(source: &str) -> (TempDir, String, u64) {
        let directory = TempDir::new().unwrap();
        let sequence = REVEAL_FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let provider_id = format!("provider-reveal-{sequence}");
        let mut settings = default_settings();
        let old_provider_id = settings.providers[0].id.clone();
        settings.providers[0].id = provider_id.clone();
        settings.providers[0].display_name = format!("Reveal Provider {sequence}");
        settings.providers[0].credential_source = source.to_string();
        for model in &mut settings.models {
            if model.provider_id == old_provider_id {
                model.provider_id = provider_id.clone();
            }
        }
        validate_settings(&settings).unwrap();
        let revision = settings.revision;
        save_settings(directory.path(), &settings).unwrap();
        (directory, provider_id, revision)
    }

    fn spawn_discovery_server(
        status: &str,
        extra_headers: &[(&str, &str)],
        body: String,
        delay: Duration,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_string();
        let headers = extra_headers
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect::<Vec<_>>();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_discovery_request(&mut stream);
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            let mut response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            for (name, value) in headers {
                response.push_str(&format!("{name}: {value}\r\n"));
            }
            response.push_str("\r\n");
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            String::from_utf8_lossy(&request).into_owned()
        });
        (format!("http://{address}/v1"), handle)
    }

    fn read_discovery_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        while request.len() < 16 * 1024 {
            let count = stream.read(&mut chunk).unwrap_or(0);
            if count == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..count]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        request
    }

    fn spawn_stalled_discovery_server() -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_discovery_request(&mut stream);
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut closed = [0_u8; 1];
            let _ = stream.read(&mut closed);
            String::from_utf8_lossy(&request).into_owned()
        });
        (format!("http://{address}/v1"), handle)
    }

    fn save_custom_discovery_provider(directory: &TempDir, base_url: String) {
        let mut settings = default_settings();
        let provider = &mut settings.providers[0];
        provider.kind = "openai_compatible".to_string();
        provider.registered_provider_id = None;
        provider.base_url = Some(base_url);
        provider.base_url_env = None;
        provider.wire_api = Some("chat_completions".to_string());
        save_settings(directory.path(), &settings).unwrap();
    }

    fn store_with_discovery_secret(secret: &str) -> MemoryCredentialStore {
        MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                secret.to_string(),
            )])),
            ..Default::default()
        }
    }

    fn provider_removal_fixture() -> AgentLlmSettings {
        let mut settings = default_settings();
        let mut remaining_provider = settings.providers[0].clone();
        remaining_provider.id = "provider-remaining".to_string();
        remaining_provider.display_name = "Remaining Provider".to_string();
        let mut remaining_model = settings.models[0].clone();
        remaining_model.id = "model-remaining-chat".to_string();
        remaining_model.provider_id = remaining_provider.id.clone();
        remaining_model.display_name = "Remaining Chat Model".to_string();
        remaining_model.model_id = "remaining-chat-model".to_string();
        let mut second_target_model = settings.models[0].clone();
        second_target_model.id = "model-target-vision".to_string();
        second_target_model.display_name = "Target Vision Model".to_string();
        second_target_model.model_id = "target-vision-model".to_string();
        settings.providers.push(remaining_provider);
        settings.models.push(second_target_model);
        settings.models.push(remaining_model);
        settings.capability_routes[0].model_id = "model-remaining-chat".to_string();
        settings.capability_routes.push(AgentCapabilityRoute {
            capability: "agent.act".to_string(),
            model_id: "model-deepseek-v4-flash".to_string(),
            model_type: "language".to_string(),
            required_model_capabilities: vec!["function_call".to_string()],
        });
        validate_settings(&settings).unwrap();
        settings
    }

    #[test]
    fn context_capacity_update_is_revision_safe_validated_and_recovers_after_save_failure() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        let model_id = settings.models[0].id.clone();
        save_settings(directory.path(), &settings).unwrap();

        let updated = set_context_capacity(
            directory.path(),
            &AgentContextCapacityRequest {
                model_id: model_id.clone(),
                expected_revision: settings.revision,
                context_window_tokens: 131_072,
                reserved_output_tokens: 8_192,
            },
        )
        .unwrap();
        assert_eq!(updated.revision, settings.revision + 1);
        assert_eq!(updated.models[0].context_window_tokens, 131_072);
        assert_eq!(updated.models[0].reserved_output_tokens, 8_192);
        assert_eq!(updated.models[0].context_capacity_source, "user_declared");

        let stale = set_context_capacity(
            directory.path(),
            &AgentContextCapacityRequest {
                model_id: model_id.clone(),
                expected_revision: settings.revision,
                context_window_tokens: 65_536,
                reserved_output_tokens: 4_096,
            },
        )
        .unwrap_err();
        assert!(stale.to_string().contains("changed"));

        let invalid = set_context_capacity(
            directory.path(),
            &AgentContextCapacityRequest {
                model_id: model_id.clone(),
                expected_revision: updated.revision,
                context_window_tokens: 4_096,
                reserved_output_tokens: 4_096,
            },
        )
        .unwrap_err();
        assert!(
            invalid
                .to_string()
                .contains("smaller than the context window")
        );

        let before_failure = std::fs::read(settings_path(directory.path())).unwrap();
        let failed = set_context_capacity_with_save(
            directory.path(),
            &AgentContextCapacityRequest {
                model_id: model_id.clone(),
                expected_revision: updated.revision,
                context_window_tokens: 262_144,
                reserved_output_tokens: 16_384,
            },
            |_path, _settings| anyhow::bail!("injected settings write failure"),
        )
        .unwrap_err();
        assert!(
            failed
                .to_string()
                .contains("injected settings write failure")
        );
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            before_failure
        );

        let recovered = set_context_capacity(
            directory.path(),
            &AgentContextCapacityRequest {
                model_id,
                expected_revision: updated.revision,
                context_window_tokens: 262_144,
                reserved_output_tokens: 16_384,
            },
        )
        .unwrap();
        assert_eq!(recovered.revision, updated.revision + 1);
        assert_eq!(recovered.models[0].context_window_tokens, 262_144);
        assert_eq!(recovered.models[0].reserved_output_tokens, 16_384);
    }

    #[test]
    fn model_capability_declaration_sets_one_attribute_and_is_revision_safe() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        let model_id = settings.models[0].id.clone();
        save_settings(directory.path(), &settings).unwrap();

        let updated = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: model_id.clone(),
                expected_revision: settings.revision,
                capability: "vision_input".to_string(),
                value: "yes".to_string(),
            },
        )
        .unwrap();
        assert_eq!(updated.revision, settings.revision + 1);
        let model = &updated.models[0];
        assert_eq!(model.capabilities["vision_input"].value, "yes");
        assert_eq!(model.capabilities["vision_input"].source, "user_declared");
        for (name, value) in &model.capabilities {
            if name != "vision_input" {
                assert_eq!(value, &settings.models[0].capabilities[name]);
            }
        }
        assert_eq!(model.model_type, settings.models[0].model_type);
        assert_eq!(
            model.context_window_tokens,
            settings.models[0].context_window_tokens
        );
        assert_eq!(model.enabled, settings.models[0].enabled);

        let mut unrouted = model.clone();
        unrouted.id = "model-unrouted-edit".to_string();
        unrouted.model_id = "unrouted-edit".to_string();
        let with_unrouted = save_model(directory.path(), unrouted).unwrap();

        let retyped = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: "model-unrouted-edit".to_string(),
                expected_revision: with_unrouted.revision,
                capability: "model_type".to_string(),
                value: "image".to_string(),
            },
        )
        .unwrap();
        assert_eq!(retyped.revision, with_unrouted.revision + 1);
        let retyped_model = retyped
            .models
            .iter()
            .find(|model| model.id == "model-unrouted-edit")
            .unwrap();
        assert_eq!(retyped_model.model_type.value, "image");
        assert_eq!(retyped_model.model_type.source, "user_declared");
        assert_eq!(retyped_model.capabilities, updated.models[0].capabilities);

        let routed_retype = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: model_id.clone(),
                expected_revision: retyped.revision,
                capability: "model_type".to_string(),
                value: "image".to_string(),
            },
        )
        .unwrap_err();
        assert!(
            routed_retype
                .to_string()
                .contains("incompatible with this route")
        );

        let redeclared = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: model_id.clone(),
                expected_revision: retyped.revision,
                capability: "vision_input".to_string(),
                value: "unknown".to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            redeclared.models[0].capabilities["vision_input"].value,
            "unknown"
        );
        assert_eq!(
            redeclared.models[0].capabilities["vision_input"].source,
            "user_declared"
        );
    }

    #[test]
    fn model_capability_declaration_rejects_stale_unknown_and_out_of_vocabulary() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        let model_id = settings.models[0].id.clone();
        save_settings(directory.path(), &settings).unwrap();

        let stale = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: model_id.clone(),
                expected_revision: settings.revision + 1,
                capability: "reasoning".to_string(),
                value: "yes".to_string(),
            },
        )
        .unwrap_err();
        assert!(stale.to_string().contains("changed"));

        let unknown = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: "model-does-not-exist".to_string(),
                expected_revision: settings.revision,
                capability: "reasoning".to_string(),
                value: "yes".to_string(),
            },
        )
        .unwrap_err();
        assert!(unknown.to_string().contains("Unknown model"));

        let bad_capability = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: model_id.clone(),
                expected_revision: settings.revision,
                capability: "time_travel".to_string(),
                value: "yes".to_string(),
            },
        )
        .unwrap_err();
        assert!(
            bad_capability
                .to_string()
                .contains("Unsupported model capability")
        );

        let bad_value = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: model_id.clone(),
                expected_revision: settings.revision,
                capability: "reasoning".to_string(),
                value: "language".to_string(),
            },
        )
        .unwrap_err();
        assert!(bad_value.to_string().contains("yes, no or unknown"));

        let bad_type_value = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: model_id.clone(),
                expected_revision: settings.revision,
                capability: "model_type".to_string(),
                value: "yes".to_string(),
            },
        )
        .unwrap_err();
        assert!(
            bad_type_value
                .to_string()
                .contains("language, embedding, image or unknown")
        );

        let persisted = load_settings(directory.path()).unwrap();
        assert_eq!(persisted.revision, settings.revision);
        assert_eq!(persisted.models.len(), settings.models.len());
        let persisted_json = serde_json::to_value(&persisted).unwrap();
        let settings_json = serde_json::to_value(&settings).unwrap();
        assert_eq!(persisted_json, settings_json);
    }

    #[test]
    fn model_capability_declaration_write_failure_preserves_disk_state_and_recovers() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        let model_id = settings.models[0].id.clone();
        save_settings(directory.path(), &settings).unwrap();
        let before_failure = std::fs::read(settings_path(directory.path())).unwrap();

        let failed = declare_model_capability_with_save(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id: model_id.clone(),
                expected_revision: settings.revision,
                capability: "audio_input".to_string(),
                value: "no".to_string(),
            },
            |_path, _settings| anyhow::bail!("injected settings write failure"),
        )
        .unwrap_err();
        assert!(
            failed
                .to_string()
                .contains("injected settings write failure")
        );
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            before_failure
        );

        let recovered = declare_model_capability(
            directory.path(),
            &AgentModelCapabilityDeclarationRequest {
                model_id,
                expected_revision: settings.revision,
                capability: "audio_input".to_string(),
                value: "no".to_string(),
            },
        )
        .unwrap();
        assert_eq!(recovered.revision, settings.revision + 1);
        assert_eq!(recovered.models[0].capabilities["audio_input"].value, "no");
    }

    #[test]
    fn save_model_adds_new_model_and_keeps_type_and_capability_evidence_immutable() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        save_settings(directory.path(), &settings).unwrap();

        let mut added = settings.models[0].clone();
        added.id = "model-manual-new".to_string();
        added.display_name = "Manual Model".to_string();
        added.model_id = "manual-model".to_string();
        added.model_type = capability_value("unknown", "unknown");
        added.capabilities = unknown_capabilities();
        let saved = save_model(directory.path(), added.clone()).unwrap();
        assert_eq!(saved.revision, settings.revision + 1);
        assert_eq!(saved.models.len(), settings.models.len() + 1);
        let persisted_added = saved
            .models
            .iter()
            .find(|model| model.id == "model-manual-new")
            .unwrap();
        assert_eq!(
            serde_json::to_value(persisted_added).unwrap(),
            serde_json::to_value(&added).unwrap()
        );

        let mut renamed = added.clone();
        renamed.display_name = "Manual Model Renamed".to_string();
        let renamed_saved = save_model(directory.path(), renamed).unwrap();
        assert_eq!(renamed_saved.revision, saved.revision + 1);
        assert_eq!(
            renamed_saved
                .models
                .iter()
                .find(|model| model.id == "model-manual-new")
                .map(|model| model.display_name.as_str()),
            Some("Manual Model Renamed")
        );

        let mut retyped = added.clone();
        retyped.model_type = capability_value("language", "user_declared");
        let retype_error = save_model(directory.path(), retyped).unwrap_err();
        assert!(
            retype_error
                .to_string()
                .contains("capability declaration command")
        );

        let mut recapability = added.clone();
        recapability.capabilities.insert(
            "reasoning".to_string(),
            capability_value("yes", "user_declared"),
        );
        let capability_error = save_model(directory.path(), recapability).unwrap_err();
        assert!(
            capability_error
                .to_string()
                .contains("capability declaration command")
        );

        let deleted = delete_model(
            directory.path(),
            &DeleteModelRequest {
                model_id: "model-manual-new".to_string(),
                replacement_model_id: None,
            },
        )
        .unwrap();
        assert_eq!(deleted.models.len(), settings.models.len());
        assert!(
            deleted
                .models
                .iter()
                .all(|model| model.id != "model-manual-new")
        );
    }

    fn catalog_capacity_entry(
        provider_model_id: &str,
        context_window: Option<u64>,
        max_output: Option<u64>,
    ) -> AgentCatalogEntry {
        AgentCatalogEntry {
            provider: "deepseek".to_string(),
            id: provider_model_id.to_string(),
            display_name: "Catalog Model".to_string(),
            description: None,
            model_type: capability_value("language", "aisdk_catalog"),
            capabilities: unknown_capabilities(),
            context_window_tokens: context_window,
            max_output_tokens: max_output,
        }
    }

    #[test]
    fn catalog_capacity_projection_shows_catalog_values_without_touching_durable_state() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        save_settings(directory.path(), &settings).unwrap();
        let durable_before = std::fs::read(settings_path(directory.path())).unwrap();

        let view = settings_view_from_settings_with(directory.path(), settings.clone(), || {
            Some(Arc::new(vec![catalog_capacity_entry(
                "deepseek-v4-flash",
                Some(131_072),
                Some(8_192),
            )]))
        })
        .unwrap();
        let projected = &view.models[0].profile;
        assert_eq!(projected.context_window_tokens, 131_072);
        assert_eq!(projected.reserved_output_tokens, 8_192);
        assert_eq!(projected.context_capacity_source, "catalog");

        // Durable settings are never rewritten by the projection.
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            durable_before
        );
        let persisted = load_settings(directory.path()).unwrap();
        assert_eq!(
            persisted.models[0].context_window_tokens,
            CONSERVATIVE_CONTEXT_WINDOW_TOKENS
        );
        assert_eq!(
            persisted.models[0].context_capacity_source,
            "conservative_default"
        );

        // The runtime execution budget keeps reading the durable profile.
        let resolved = resolve_model_for_turn(directory.path(), None, "ask").unwrap();
        assert_eq!(
            resolved.runtime_profile.context_window_tokens,
            CONSERVATIVE_CONTEXT_WINDOW_TOKENS
        );
        assert_eq!(
            resolved.runtime_profile.reserved_output_tokens,
            CONSERVATIVE_RESERVED_OUTPUT_TOKENS
        );
        assert_eq!(
            resolved.runtime_profile.context_capacity_source,
            "conservative_default"
        );
    }

    #[test]
    fn catalog_capacity_projection_requires_exact_match_and_both_values() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        save_settings(directory.path(), &settings).unwrap();

        let no_match = settings_view_from_settings_with(directory.path(), settings.clone(), || {
            Some(Arc::new(vec![catalog_capacity_entry(
                "other-model",
                Some(131_072),
                Some(8_192),
            )]))
        })
        .unwrap();
        assert_eq!(
            no_match.models[0].profile.context_capacity_source,
            "conservative_default"
        );
        assert_eq!(
            no_match.models[0].profile.context_window_tokens,
            CONSERVATIVE_CONTEXT_WINDOW_TOKENS
        );

        let single_value =
            settings_view_from_settings_with(directory.path(), settings.clone(), || {
                Some(Arc::new(vec![catalog_capacity_entry(
                    "deepseek-v4-flash",
                    Some(131_072),
                    None,
                )]))
            })
            .unwrap();
        assert_eq!(
            single_value.models[0].profile.context_capacity_source,
            "conservative_default"
        );
        assert_eq!(
            single_value.models[0].profile.context_window_tokens,
            CONSERVATIVE_CONTEXT_WINDOW_TOKENS
        );

        let user_declared_settings = {
            let mut declared = settings.clone();
            declared.models[0].context_capacity_source = "user_declared".to_string();
            declared
        };
        let declared_view =
            settings_view_from_settings_with(directory.path(), user_declared_settings, || {
                Some(Arc::new(vec![catalog_capacity_entry(
                    "deepseek-v4-flash",
                    Some(131_072),
                    Some(8_192),
                )]))
            })
            .unwrap();
        assert_eq!(
            declared_view.models[0].profile.context_capacity_source,
            "user_declared"
        );
        assert_eq!(
            declared_view.models[0].profile.context_window_tokens,
            CONSERVATIVE_CONTEXT_WINDOW_TOKENS
        );
    }

    #[test]
    fn catalog_probe_failure_leaves_settings_view_conservative() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        save_settings(directory.path(), &settings).unwrap();
        let view = settings_view_from_settings_with(directory.path(), settings, || None).unwrap();
        assert_eq!(
            view.models[0].profile.context_capacity_source,
            "conservative_default"
        );
        assert_eq!(
            view.models[0].profile.context_window_tokens,
            CONSERVATIVE_CONTEXT_WINDOW_TOKENS
        );
    }

    #[test]
    fn catalog_cache_runs_probe_once_and_never_caches_failures() {
        catalog_cache_clear();
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        save_settings(directory.path(), &settings).unwrap();
        let rscript = Path::new("/test/catalog-cache-once-rscript");
        let runs = std::cell::Cell::new(0_u32);
        let probe = |_: &Path, _: &Path| {
            runs.set(runs.get() + 1);
            Ok(vec![catalog_capacity_entry(
                "deepseek-v4-flash",
                Some(131_072),
                Some(8_192),
            )])
        };

        let first = settings_view_from_settings_with(directory.path(), settings.clone(), || {
            catalog_cached_with(directory.path(), rscript, probe).ok()
        })
        .unwrap();
        let second = settings_view_from_settings_with(directory.path(), settings.clone(), || {
            catalog_cached_with(directory.path(), rscript, probe).ok()
        })
        .unwrap();
        assert_eq!(runs.get(), 1);
        assert_eq!(first.models[0].profile.context_capacity_source, "catalog");
        assert_eq!(second.models[0].profile.context_capacity_source, "catalog");

        let failing_rscript = Path::new("/test/catalog-cache-failing-rscript");
        let failures = std::cell::Cell::new(0_u32);
        let failing_probe = |_: &Path, _: &Path| -> Result<Vec<AgentCatalogEntry>> {
            failures.set(failures.get() + 1);
            anyhow::bail!("injected catalog probe failure")
        };
        assert!(catalog_cached_with(directory.path(), failing_rscript, failing_probe).is_err());
        assert!(catalog_cached_with(directory.path(), failing_rscript, failing_probe).is_err());
        assert_eq!(failures.get(), 2);
        catalog_cache_clear();
    }

    fn delete_provider_request(settings: &AgentLlmSettings) -> DeleteProviderRequest {
        DeleteProviderRequest {
            provider_id: "provider-deepseek-existing".to_string(),
            expected_revision: settings.revision,
        }
    }

    fn reveal_audit_rows(directory: &TempDir) -> Vec<serde_json::Value> {
        match std::fs::read_to_string(credential_audit_path(directory.path())) {
            Ok(log) => log
                .lines()
                .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => panic!("reading the reveal audit log failed: {error}"),
        }
    }

    #[test]
    fn credential_reveal_rho_vault_returns_exact_value_with_fresh_read_per_call() {
        let _serial = reveal_regression_guard();
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
        let sentinel = format!(
            "rho-reveal-vault-{}",
            REVEAL_FIXTURE_SEQUENCE.load(Ordering::Relaxed)
        );
        agent_credential_vault::set(directory.path(), &provider_id, &sentinel).unwrap();
        let settings_before = std::fs::read(settings_path(directory.path())).unwrap();

        let first = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(first.outcome, AgentLlmCredentialRevealOutcome::Revealed);
        assert_eq!(first.credential.as_deref(), Some(sentinel.as_str()));

        // A second click re-reads the store: a replaced value shows up
        // immediately, proving no read-through cache serves the view.
        let replacement = format!("{sentinel}-replaced");
        agent_credential_vault::set(directory.path(), &provider_id, &replacement).unwrap();
        let second = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(second.outcome, AgentLlmCredentialRevealOutcome::Revealed);
        assert_eq!(second.credential.as_deref(), Some(replacement.as_str()));

        // Settings bytes never change because a View happened.
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            settings_before
        );
    }

    #[test]
    fn credential_reveal_session_only_reads_the_live_entry() {
        let _serial = reveal_regression_guard();
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_SESSION_ONLY);
        let sentinel = format!("rho-reveal-session-{provider_id}");
        credential_session().set_session_credential(&provider_id, &sentinel);

        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(view.outcome, AgentLlmCredentialRevealOutcome::Revealed);
        assert_eq!(view.credential.as_deref(), Some(sentinel.as_str()));

        let rotated = format!("{sentinel}-rotated");
        credential_session().set_session_credential(&provider_id, &rotated);
        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(view.credential.as_deref(), Some(rotated.as_str()));

        credential_session().clear_session_credential(&provider_id);
        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(
            view.outcome,
            AgentLlmCredentialRevealOutcome::CredentialMissing
        );
        assert_eq!(view.credential, None);
    }

    #[test]
    fn credential_reveal_rejects_ineligible_sources_and_ids_before_any_read() {
        let _serial = reveal_regression_guard();

        // `environment` is refused before its variable is read: the sentinel
        // variable is set, yet the outcome is source_ineligible and no audit
        // row or read happens.
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_ENVIRONMENT);
        let env_name = format!(
            "RHO_REVEAL_TEST_{}",
            REVEAL_FIXTURE_SEQUENCE.load(Ordering::Relaxed)
        );
        let mut settings = load_settings(directory.path()).unwrap();
        settings.providers[0].api_key_env = Some(env_name.clone());
        save_settings(directory.path(), &settings).unwrap();
        let sentinel = format!("rho-reveal-env-{provider_id}");
        unsafe { std::env::set_var(&env_name, &sentinel) };
        let view = view_provider_credential(directory.path(), &provider_id);
        unsafe { std::env::remove_var(&env_name) };
        assert_eq!(
            view.outcome,
            AgentLlmCredentialRevealOutcome::SourceIneligible
        );
        assert_eq!(view.credential, None);
        assert!(reveal_audit_rows(&directory).is_empty());

        // Persisted out-of-vocabulary and legacy file fallback sources fail
        // closed as ineligible even though load_settings rejects them.
        for persisted_source in [
            LEGACY_CREDENTIAL_SOURCE_FILE_FALLBACK,
            "future_unknown_store",
        ] {
            let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
            let path = settings_path(directory.path());
            let mut document: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let provider = document["providers"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|provider| provider["id"] == provider_id)
                .unwrap();
            provider["credential_source"] = serde_json::json!(persisted_source);
            atomic_write(&path, &serde_json::to_vec_pretty(&document).unwrap()).unwrap();
            let view = view_provider_credential(directory.path(), &provider_id);
            assert_eq!(
                view.outcome,
                AgentLlmCredentialRevealOutcome::SourceIneligible,
                "{persisted_source}"
            );
            assert_eq!(view.credential, None);
        }

        // A provider that does not require an API key has nothing to view.
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
        let mut settings = load_settings(directory.path()).unwrap();
        settings.providers[0].api_key_required = false;
        save_settings(directory.path(), &settings).unwrap();
        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(
            view.outcome,
            AgentLlmCredentialRevealOutcome::SourceIneligible
        );

        // Malformed and unknown provider IDs are ineligible without touching
        // the store.
        let too_long = "p".repeat(MAX_ID_LENGTH + 1);
        for bad in ["", "rho\tbad", too_long.as_str(), "provider-does-not-exist"] {
            let view = view_provider_credential(directory.path(), bad);
            assert_eq!(
                view.outcome,
                AgentLlmCredentialRevealOutcome::SourceIneligible,
                "{bad:?}"
            );
            assert_eq!(view.credential, None);
        }
    }

    #[test]
    fn credential_reveal_missing_entries_and_store_failures_are_distinct() {
        let _serial = reveal_regression_guard();

        // rho_vault with no entry resolves credential_missing.
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(
            view.outcome,
            AgentLlmCredentialRevealOutcome::CredentialMissing
        );
        assert_eq!(view.credential, None);

        // A corrupted vault resolves store_unavailable, never a value.
        agent_credential_vault::set(directory.path(), &provider_id, "rho-reveal-corrupt-secret")
            .unwrap();
        atomic_write(
            &directory
                .path()
                .join(agent_credential_vault::VAULT_FILE_NAME),
            b"not-a-vault",
        )
        .unwrap();
        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(
            view.outcome,
            AgentLlmCredentialRevealOutcome::StoreUnavailable
        );
        assert_eq!(view.credential, None);

        // Unreadable settings resolve store_unavailable.
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
        atomic_write(&settings_path(directory.path()), b"{not json").unwrap();
        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(
            view.outcome,
            AgentLlmCredentialRevealOutcome::StoreUnavailable
        );
        assert_eq!(view.credential, None);
    }

    #[test]
    fn credential_reveal_audit_row_is_bounded_redacted_and_best_effort() {
        let _serial = reveal_regression_guard();
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
        let sentinel = format!("rho-reveal-audit-{provider_id}");
        agent_credential_vault::set(directory.path(), &provider_id, &sentinel).unwrap();

        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(view.outcome, AgentLlmCredentialRevealOutcome::Revealed);

        let log = std::fs::read_to_string(credential_audit_path(directory.path())).unwrap();
        assert!(!log.contains(&sentinel));
        let rows = reveal_audit_rows(&directory);
        let row = rows.last().unwrap();
        assert_eq!(row["event"], "credential_reveal");
        assert_eq!(row["provider_id"], provider_id.as_str());
        assert_eq!(row["credential_source"], CREDENTIAL_SOURCE_RHO_VAULT);
        assert_eq!(row["outcome"], "revealed");
        assert_eq!(row["detail"], serde_json::Value::Null);
        assert!(row["recorded_at"].is_string());
        let keys = row
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        assert_eq!(
            keys,
            HashSet::from([
                "credential_source".to_string(),
                "detail".to_string(),
                "event".to_string(),
                "outcome".to_string(),
                "provider_id".to_string(),
                "recorded_at".to_string(),
            ])
        );

        // Best-effort: an unwritable audit log never blocks or alters a view.
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
        let sentinel = format!("rho-reveal-audit-failure-{provider_id}");
        agent_credential_vault::set(directory.path(), &provider_id, &sentinel).unwrap();
        std::fs::create_dir(credential_audit_path(directory.path())).unwrap();
        let view = view_provider_credential(directory.path(), &provider_id);
        assert_eq!(view.outcome, AgentLlmCredentialRevealOutcome::Revealed);
        assert_eq!(view.credential.as_deref(), Some(sentinel.as_str()));
    }

    #[test]
    fn credential_reveal_view_serialization_carries_value_only_on_revealed() {
        let _serial = reveal_regression_guard();
        let sentinel = format!(
            "rho-transport-{}-secret",
            REVEAL_FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let revealed = serde_json::to_value(AgentLlmCredentialRevealView {
            outcome: AgentLlmCredentialRevealOutcome::Revealed,
            credential: Some(sentinel.clone()),
        })
        .unwrap();
        let object = revealed.as_object().unwrap();
        assert_eq!(object.len(), 2);
        assert_eq!(revealed["outcome"], "revealed");
        assert_eq!(revealed["credential"], sentinel.as_str());

        for (outcome, word) in [
            (
                AgentLlmCredentialRevealOutcome::CredentialMissing,
                "credential_missing",
            ),
            (
                AgentLlmCredentialRevealOutcome::StoreUnavailable,
                "store_unavailable",
            ),
            (
                AgentLlmCredentialRevealOutcome::SourceIneligible,
                "source_ineligible",
            ),
        ] {
            let encoded = serde_json::to_value(AgentLlmCredentialRevealView {
                outcome,
                credential: None,
            })
            .unwrap();
            assert_eq!(encoded["outcome"], word);
            assert!(encoded["credential"].is_null());
            assert!(!encoded.to_string().contains(&sentinel));
        }

        let (directory, _provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
        let settings_bytes = std::fs::read(settings_path(directory.path())).unwrap();
        assert!(!String::from_utf8_lossy(&settings_bytes).contains(&sentinel));
        let generated = include_str!("../../ui/src/transport/generated/agent-settings.ts");
        let facet = include_str!("../../ui/src/transport/agent-settings.ts");
        let mock = include_str!("../../ui/src/transport/mock.ts");
        for surface in [generated, facet, mock] {
            assert!(!surface.contains(&sentinel));
            assert!(!surface.contains("credential_value"));
            assert!(!surface.contains("revealed_secret"));
        }
    }

    #[test]
    fn credential_generation_advances_only_after_successful_rho_owned_mutations() {
        let _serial = reveal_regression_guard();
        let (directory, provider_id, _) = reveal_fixture(CREDENTIAL_SOURCE_RHO_VAULT);
        let initial = credential_generation(&provider_id);
        let failed_set = MemoryCredentialStore {
            fail_set: true,
            ..Default::default()
        };
        assert!(
            set_credential_with_store(
                directory.path(),
                &provider_id,
                "failed-set-secret",
                false,
                &failed_set,
            )
            .is_err()
        );
        assert_eq!(credential_generation(&provider_id), initial);

        let successful_store = MemoryCredentialStore::default();
        set_credential_with_store(
            directory.path(),
            &provider_id,
            "successful-set-secret",
            false,
            &successful_store,
        )
        .unwrap();
        assert_eq!(credential_generation(&provider_id), initial + 1);

        let failed_delete = MemoryCredentialStore {
            fail_delete: true,
            ..Default::default()
        };
        assert!(
            delete_credential_with_store(directory.path(), &provider_id, &failed_delete).is_err()
        );
        assert_eq!(credential_generation(&provider_id), initial + 1);
        delete_credential_with_store(directory.path(), &provider_id, &successful_store).unwrap();
        assert_eq!(credential_generation(&provider_id), initial + 2);

        let mut provider = load_settings(directory.path()).unwrap().providers[0].clone();
        provider.display_name.push_str(" Updated");
        save_provider(directory.path(), provider).unwrap();
        assert_eq!(credential_generation(&provider_id), initial + 3);

        let mut second = load_settings(directory.path()).unwrap().providers[0].clone();
        second.id = format!("{provider_id}-deletable");
        second.display_name = "Deletable Reveal Provider".to_string();
        let saved = save_provider(directory.path(), second.clone()).unwrap();
        let second_generation = credential_generation(&second.id);
        assert_eq!(second_generation, 1);
        let request = DeleteProviderRequest {
            provider_id: second.id.clone(),
            expected_revision: saved.revision,
        };
        let failed = delete_provider_with_store_and_save(
            directory.path(),
            &request,
            &MemoryCredentialStore::default(),
            |_path, _settings| bail!("injected provider save failure"),
        );
        assert!(failed.is_err());
        assert_eq!(credential_generation(&second.id), second_generation);
        delete_provider_with_store(
            directory.path(),
            &request,
            &MemoryCredentialStore::default(),
        )
        .unwrap();
        assert_eq!(credential_generation(&second.id), second_generation + 1);
    }

    #[test]
    fn default_migration_preserves_deepseek_flash() {
        let settings = default_settings();
        assert_eq!(chat_model_id(&settings).unwrap(), "model-deepseek-v4-flash");
        assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(settings.models[0].context_window_tokens, 32_768);
        assert_eq!(
            settings.models[0].context_capacity_source,
            "conservative_default"
        );
        assert_eq!(settings.models[0].model_id, "deepseek-v4-flash");
        assert_eq!(
            settings.providers[0].registered_provider_id.as_deref(),
            Some("deepseek")
        );
    }

    #[test]
    fn settings_round_trip_without_overwriting_defaults() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        save_settings(directory.path(), &settings).unwrap();
        let loaded = load_settings(directory.path()).unwrap();
        assert_eq!(
            chat_model_id(&loaded).unwrap(),
            chat_model_id(&settings).unwrap()
        );
        assert_eq!(loaded.models[0].display_name, "DeepSeek V4 Flash");
    }

    fn legacy_v3_providers() -> Vec<AgentProviderProfileV3> {
        default_settings()
            .providers
            .into_iter()
            .map(|provider| AgentProviderProfileV3 {
                id: provider.id,
                display_name: provider.display_name,
                kind: provider.kind,
                registered_provider_id: provider.registered_provider_id,
                api_key_env: provider.api_key_env,
                api_key_required: provider.api_key_required,
                base_url: provider.base_url,
                base_url_env: provider.base_url_env,
                wire_api: provider.wire_api,
                disable_stream_options: provider.disable_stream_options,
            })
            .collect()
    }

    fn legacy_settings_bytes() -> Vec<u8> {
        serde_json::to_vec_pretty(&AgentLlmSettingsV1 {
            schema_version: 1,
            selected_model_id: "model-deepseek-v4-flash".to_string(),
            providers: legacy_v3_providers(),
            models: vec![AgentModelProfileV1 {
                id: "model-deepseek-v4-flash".to_string(),
                provider_id: "provider-deepseek-existing".to_string(),
                display_name: "DeepSeek V4 Flash".to_string(),
                model_id: "deepseek-v4-flash".to_string(),
                enabled: true,
                capabilities: AgentModelCapabilitiesV1 {
                    tool_calling: "yes".to_string(),
                    reasoning: "yes".to_string(),
                    vision_input: "no".to_string(),
                    source: "catalog".to_string(),
                },
                last_test: None,
            }],
        })
        .unwrap()
    }

    fn legacy_v2_settings_bytes() -> Vec<u8> {
        let settings = default_settings();
        serde_json::to_vec_pretty(&AgentLlmSettingsV2 {
            schema_version: 2,
            revision: settings.revision,
            providers: legacy_v3_providers(),
            models: settings
                .models
                .into_iter()
                .map(|model| AgentModelProfileV2 {
                    id: model.id,
                    provider_id: model.provider_id,
                    display_name: model.display_name,
                    model_id: model.model_id,
                    enabled: model.enabled,
                    model_type: model.model_type,
                    capabilities: model.capabilities,
                    last_test: model.last_test,
                })
                .collect(),
            capability_routes: settings.capability_routes,
        })
        .unwrap()
    }

    #[test]
    fn v2_capacity_migration_is_conservative_backed_up_and_recoverable() {
        let directory = TempDir::new().unwrap();
        let legacy = legacy_v2_settings_bytes();
        let path = settings_path(directory.path());
        std::fs::write(&path, &legacy).unwrap();

        let projected = load_settings(directory.path()).unwrap();
        assert_eq!(projected.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(projected.models[0].context_window_tokens, 32_768);
        assert_eq!(projected.models[0].reserved_output_tokens, 4_096);
        assert_eq!(
            projected.models[0].context_capacity_source,
            "conservative_default"
        );
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert!(!settings_v2_backup_path(directory.path()).exists());

        let failure = save_settings_with(directory.path(), &projected, |target, bytes| {
            if target == settings_v2_backup_path(directory.path()) {
                atomic_write(target, bytes)
            } else {
                bail!("injected V3 settings write failure")
            }
        });
        assert!(failure.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert_eq!(
            std::fs::read(settings_v2_backup_path(directory.path())).unwrap(),
            legacy
        );

        save_settings(directory.path(), &projected).unwrap();
        assert_eq!(
            load_settings(directory.path()).unwrap().schema_version,
            SETTINGS_SCHEMA_VERSION
        );
    }

    #[test]
    fn v1_read_projects_without_rewrite_then_first_mutation_backs_up_and_migrates() {
        let directory = TempDir::new().unwrap();
        let legacy = legacy_settings_bytes();
        std::fs::write(settings_path(directory.path()), &legacy).unwrap();

        let projected = load_settings(directory.path()).unwrap();
        assert_eq!(projected.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(projected.revision, 0);
        assert_eq!(projected.models[0].model_type.value, "unknown");
        assert_eq!(
            projected.models[0].capabilities["function_call"].source,
            "aisdk_catalog"
        );
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            legacy
        );
        assert!(!settings_v1_backup_path(directory.path()).exists());

        let migrated = declare_model_capabilities(
            directory.path(),
            0,
            "model-deepseek-v4-flash",
            AgentModelCapabilityPatch {
                model_type: Some("language".to_string()),
                capabilities: BTreeMap::new(),
            },
        )
        .unwrap();
        assert_eq!(migrated.revision, 1);
        assert_eq!(
            std::fs::read(settings_v1_backup_path(directory.path())).unwrap(),
            legacy
        );
        let reopened = load_settings(directory.path()).unwrap();
        assert_eq!(reopened.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(reopened.revision, 1);
        assert_eq!(reopened.models[0].model_type.source, "user_declared");
    }

    #[test]
    fn v1_migration_backup_and_v3_write_failures_leave_recoverable_source() {
        let directory = TempDir::new().unwrap();
        let legacy = legacy_settings_bytes();
        let path = settings_path(directory.path());
        std::fs::write(&path, &legacy).unwrap();
        let projected = load_settings(directory.path()).unwrap();

        let result = save_settings_with(directory.path(), &projected, |target, _| {
            if target == settings_v1_backup_path(directory.path()) {
                bail!("injected backup failure")
            }
            unreachable!("V3 write must not run after backup failure")
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert!(!settings_v1_backup_path(directory.path()).exists());

        let result = save_settings_with(directory.path(), &projected, |target, bytes| {
            if target == settings_v1_backup_path(directory.path()) {
                atomic_write(target, bytes)
            } else {
                bail!("injected V3 write failure")
            }
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert_eq!(
            std::fs::read(settings_v1_backup_path(directory.path())).unwrap(),
            legacy
        );
        assert_eq!(
            load_settings(directory.path()).unwrap().schema_version,
            SETTINGS_SCHEMA_VERSION
        );
    }

    #[test]
    fn corrupt_unsupported_and_oversized_settings_fail_closed() {
        let directory = TempDir::new().unwrap();
        let path = settings_path(directory.path());
        std::fs::write(&path, b"not json").unwrap();
        assert!(load_settings(directory.path()).is_err());
        std::fs::write(&path, br#"{"schema_version":99}"#).unwrap();
        assert!(load_settings(directory.path()).is_err());
        std::fs::write(&path, vec![b'x'; MAX_SETTINGS_BYTES + 1]).unwrap();
        let error = load_settings(directory.path()).unwrap_err().to_string();
        assert!(error.contains("256 KiB"));
    }

    #[test]
    fn route_mutations_enforce_revision_contract_and_model_dependencies() {
        let directory = TempDir::new().unwrap();
        save_settings(directory.path(), &default_settings()).unwrap();
        let revision = load_settings(directory.path()).unwrap().revision;
        let route = AgentCapabilityRoute {
            capability: "agent.act".to_string(),
            model_id: "model-deepseek-v4-flash".to_string(),
            model_type: "language".to_string(),
            required_model_capabilities: vec!["function_call".to_string()],
        };
        let routed = save_capability_route(directory.path(), revision, route).unwrap();
        assert_eq!(routed.revision, revision + 1);
        assert!(
            save_capability_route(
                directory.path(),
                revision,
                routed.capability_routes[0].clone(),
            )
            .is_err()
        );

        let mut disabled = routed.models[0].clone();
        disabled.enabled = false;
        assert!(save_model(directory.path(), disabled).is_err());
        assert!(
            delete_model(
                directory.path(),
                &DeleteModelRequest {
                    model_id: "model-deepseek-v4-flash".to_string(),
                    replacement_model_id: None,
                },
            )
            .is_err()
        );
        let without_act =
            delete_capability_route(directory.path(), routed.revision, "agent.act").unwrap();
        assert_eq!(without_act.revision, routed.revision + 1);
        assert!(
            delete_capability_route(directory.path(), without_act.revision, "agent.chat",).is_err()
        );
    }

    #[test]
    fn route_mutation_write_failures_preserve_disk_state_and_recover() {
        let directory = TempDir::new().unwrap();
        save_settings(directory.path(), &default_settings()).unwrap();
        let original = std::fs::read(settings_path(directory.path())).unwrap();
        let revision = load_settings(directory.path()).unwrap().revision;
        let act_route = AgentCapabilityRoute {
            capability: "agent.act".to_string(),
            model_id: "model-deepseek-v4-flash".to_string(),
            model_type: "language".to_string(),
            required_model_capabilities: vec!["function_call".to_string()],
        };

        let result = save_capability_route_with_save(
            directory.path(),
            revision,
            act_route.clone(),
            |data_dir, settings| {
                save_settings_with_components(
                    data_dir,
                    settings,
                    |_| bail!("injected serialization failure"),
                    |_, _| unreachable!("write must not run after serialization failure"),
                )
            },
        );
        assert!(result.unwrap_err().to_string().contains("serialization"));
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            original
        );

        let result = save_capability_route_with_save(
            directory.path(),
            revision,
            act_route.clone(),
            |_, _| bail!("injected route write failure"),
        );
        assert!(result.unwrap_err().to_string().contains("injected"));
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            original
        );

        let routed = save_capability_route(directory.path(), revision, act_route).unwrap();
        let routed_bytes = std::fs::read(settings_path(directory.path())).unwrap();
        let result = delete_capability_route_with_save(
            directory.path(),
            routed.revision,
            "agent.act",
            |_, _| bail!("injected route delete failure"),
        );
        assert!(result.unwrap_err().to_string().contains("injected"));
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            routed_bytes
        );

        let result = declare_model_capabilities_with_save(
            directory.path(),
            routed.revision,
            "model-deepseek-v4-flash",
            AgentModelCapabilityPatch {
                model_type: None,
                capabilities: BTreeMap::from([("reasoning".to_string(), "no".to_string())]),
            },
            |_, _| bail!("injected capability write failure"),
        );
        assert!(result.unwrap_err().to_string().contains("injected"));
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            routed_bytes
        );

        let incompatible = declare_model_capabilities(
            directory.path(),
            routed.revision,
            "model-deepseek-v4-flash",
            AgentModelCapabilityPatch {
                model_type: None,
                capabilities: BTreeMap::from([("function_call".to_string(), "no".to_string())]),
            },
        );
        assert!(incompatible.is_err());
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            routed_bytes
        );

        let recovered = declare_model_capabilities(
            directory.path(),
            routed.revision,
            "model-deepseek-v4-flash",
            AgentModelCapabilityPatch {
                model_type: None,
                capabilities: BTreeMap::from([("reasoning".to_string(), "no".to_string())]),
            },
        )
        .unwrap();
        assert_eq!(recovered.revision, routed.revision + 1);
        assert_eq!(recovered.models[0].capabilities["reasoning"].value, "no");
    }

    #[test]
    fn simultaneous_route_writes_accept_exactly_one_revision() {
        let directory = TempDir::new().unwrap();
        save_settings(directory.path(), &default_settings()).unwrap();
        let revision = load_settings(directory.path()).unwrap().revision;
        let data_dir = Arc::new(directory.path().to_path_buf());
        let barrier = Arc::new(Barrier::new(3));
        let routes = [
            AgentCapabilityRoute {
                capability: "agent.act".to_string(),
                model_id: "model-deepseek-v4-flash".to_string(),
                model_type: "language".to_string(),
                required_model_capabilities: vec!["function_call".to_string()],
            },
            AgentCapabilityRoute {
                capability: "analysis.summarize".to_string(),
                model_id: "model-deepseek-v4-flash".to_string(),
                model_type: "language".to_string(),
                required_model_capabilities: Vec::new(),
            },
        ];
        let handles = routes
            .into_iter()
            .map(|route| {
                let data_dir = Arc::clone(&data_dir);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    save_capability_route(&data_dir, revision, route)
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes.iter().filter(|outcome| outcome.is_err()).count(),
            1
        );
        let reopened = load_settings(directory.path()).unwrap();
        assert_eq!(reopened.revision, revision + 1);
        assert_eq!(reopened.capability_routes.len(), 2);
    }

    #[test]
    fn two_provider_routes_resolve_one_effective_credential_per_turn() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        let mut provider = settings.providers[0].clone();
        provider.id = "provider-act".to_string();
        provider.display_name = "Act Provider".to_string();
        provider.registered_provider_id = Some("openai".to_string());
        provider.api_key_env = Some("OPENAI_API_KEY".to_string());
        settings.providers.push(provider);
        let mut model = settings.models[0].clone();
        model.id = "model-act".to_string();
        model.provider_id = "provider-act".to_string();
        model.display_name = "Act Model".to_string();
        model.model_id = "gpt-act".to_string();
        settings.models.push(model);
        settings.capability_routes.push(AgentCapabilityRoute {
            capability: "agent.act".to_string(),
            model_id: "model-act".to_string(),
            model_type: "language".to_string(),
            required_model_capabilities: vec!["function_call".to_string()],
        });
        validate_settings(&settings).unwrap();
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([
                (
                    "provider-deepseek-existing".to_string(),
                    "chat-secret".to_string(),
                ),
                ("provider-act".to_string(), "act-secret".to_string()),
            ])),
            ..Default::default()
        };

        let (chat, chat_credential) = resolve_model_and_credential_for_turn_with_store(
            directory.path(),
            &settings,
            None,
            "ask",
            &store,
        )
        .unwrap();
        assert_eq!(chat.route_capability, "agent.chat");
        assert_eq!(chat.provider_id, "provider-deepseek-existing");
        assert_eq!(
            chat.credential_environment_names,
            ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"]
        );
        assert_eq!(chat_credential.unwrap().1, "chat-secret");

        let (act, act_credential) = resolve_model_and_credential_for_turn_with_store(
            directory.path(),
            &settings,
            None,
            "act",
            &store,
        )
        .unwrap();
        assert_eq!(act.route_capability, "agent.act");
        assert_eq!(act.provider_id, "provider-act");
        assert_eq!(act_credential.unwrap().1, "act-secret");
        assert!(resolve_model_for_turn_with_settings(&settings, Some("model-act"), "ask").is_err());
        assert!(
            resolve_model_for_turn_with_settings(
                &settings,
                Some("model-deepseek-v4-flash"),
                "act",
            )
            .is_err()
        );
        assert_eq!(
            store.get_calls.lock().unwrap().as_slice(),
            &["provider-deepseek-existing", "provider-act"]
        );
        assert!(!serde_json::to_string(&settings).unwrap().contains("secret"));
    }

    #[test]
    fn problem_repair_uses_only_the_tool_route_credential_in_read_only_mode() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        let mut provider = settings.providers[0].clone();
        provider.id = "provider-repair".to_string();
        provider.display_name = "Repair Provider".to_string();
        provider.registered_provider_id = Some("openai".to_string());
        provider.api_key_env = Some("OPENAI_API_KEY".to_string());
        settings.providers.push(provider);
        let mut model = settings.models[0].clone();
        model.id = "model-repair".to_string();
        model.provider_id = "provider-repair".to_string();
        model.display_name = "Repair Model".to_string();
        model.model_id = "repair-model".to_string();
        settings.models.push(model);
        settings.capability_routes.push(AgentCapabilityRoute {
            capability: "agent.act".to_string(),
            model_id: "model-repair".to_string(),
            model_type: "language".to_string(),
            required_model_capabilities: vec!["function_call".to_string()],
        });
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([
                (
                    "provider-deepseek-existing".to_string(),
                    "chat-secret".to_string(),
                ),
                ("provider-repair".to_string(), "repair-secret".to_string()),
            ])),
            ..Default::default()
        };

        let preview =
            resolve_model_for_task_with_settings(&settings, None, "ask", "problem_repair").unwrap();
        assert_eq!(preview.route_capability, "agent.act");
        assert_eq!(preview.provider_id, "provider-repair");
        assert!(store.get_calls.lock().unwrap().is_empty());

        let (resolved, credential) = resolve_model_and_credential_for_task_with_store(
            directory.path(),
            &settings,
            None,
            "ask",
            "problem_repair",
            &store,
        )
        .unwrap();
        assert_eq!(resolved.route_capability, "agent.act");
        assert_eq!(resolved.provider_id, "provider-repair");
        assert_eq!(credential.unwrap().1, "repair-secret");
        assert_eq!(
            store.get_calls.lock().unwrap().as_slice(),
            &["provider-repair"]
        );
        assert!(
            resolve_model_and_credential_for_task_with_store(
                directory.path(),
                &settings,
                None,
                "act",
                "problem_repair",
                &store,
            )
            .is_err()
        );
        assert_eq!(
            store.get_calls.lock().unwrap().as_slice(),
            &["provider-repair"]
        );
        assert!(
            resolve_model_and_credential_for_task_with_store(
                directory.path(),
                &settings,
                Some("model-deepseek-v4-flash"),
                "ask",
                "problem_repair",
                &store,
            )
            .is_err()
        );
        assert_eq!(
            store.get_calls.lock().unwrap().as_slice(),
            &["provider-repair"]
        );
    }

    #[test]
    fn problem_repair_blocks_chat_only_unknown_and_missing_credential_routes() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        settings.models[0].capabilities.insert(
            "function_call".to_string(),
            capability_value("no", "user_declared"),
        );
        let store = MemoryCredentialStore::default();
        assert!(
            resolve_model_and_credential_for_task_with_store(
                directory.path(),
                &settings,
                None,
                "ask",
                "problem_repair",
                &store,
            )
            .is_err()
        );

        settings.models[0].capabilities.insert(
            "function_call".to_string(),
            capability_value("unknown", "unknown"),
        );
        assert!(
            resolve_model_and_credential_for_task_with_store(
                directory.path(),
                &settings,
                None,
                "ask",
                "problem_repair",
                &store,
            )
            .is_err()
        );

        settings.models[0].capabilities.insert(
            "function_call".to_string(),
            capability_value("yes", "user_declared"),
        );
        let error = resolve_model_and_credential_for_task_with_store(
            directory.path(),
            &settings,
            None,
            "ask",
            "problem_repair",
            &store,
        )
        .unwrap_err();
        assert!(error.to_string().contains("credential is missing"));

        settings.providers[0].api_key_required = false;
        let (resolved, credential) = resolve_model_and_credential_for_task_with_store(
            directory.path(),
            &settings,
            None,
            "ask",
            "problem_repair",
            &store,
        )
        .unwrap();
        assert_eq!(resolved.route_capability, "agent.chat");
        assert!(credential.is_none());
    }

    #[test]
    fn act_fallback_is_visible_and_requires_chat_function_call_compatibility() {
        let settings = default_settings();
        let act = resolve_model_for_turn_with_settings(&settings, None, "act").unwrap();
        assert_eq!(act.route_capability, "agent.chat");
        let statuses = HashMap::from([(
            "provider-deepseek-existing".to_string(),
            CredentialPresentation {
                status: "detected".to_string(),
                source: "system".to_string(),
            },
        )]);
        let view = build_settings_view(settings.clone(), system_credential_info(), statuses);
        let act_view = view
            .capability_routes
            .iter()
            .find(|route| route.capability == "agent.act")
            .unwrap();
        assert_eq!(act_view.inherited_from.as_deref(), Some("agent.chat"));
        assert_eq!(act_view.compatibility, "compatible");

        let mut incompatible = settings;
        incompatible.models[0].capabilities.insert(
            "function_call".to_string(),
            capability_value("no", "user_declared"),
        );
        assert!(resolve_model_for_turn_with_settings(&incompatible, None, "act").is_err());
    }

    #[test]
    fn credential_store_sets_replaces_deletes_and_isolates_providers() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        let mut second = settings.providers[0].clone();
        second.id = "provider-second".to_string();
        second.display_name = "Second".to_string();
        settings.providers.push(second);
        save_settings(directory.path(), &settings).unwrap();
        let store = MemoryCredentialStore::default();

        set_credential_with_store(
            directory.path(),
            "provider-deepseek-existing",
            "first-secret",
            false,
            &store,
        )
        .unwrap();
        set_credential_with_store(
            directory.path(),
            "provider-second",
            "second-secret",
            false,
            &store,
        )
        .unwrap();
        // CRED-SEC5: an unconfirmed replace is rejected and preserves the value.
        assert!(
            set_credential_with_store(
                directory.path(),
                "provider-deepseek-existing",
                "replacement-secret",
                false,
                &store,
            )
            .is_err()
        );
        assert_eq!(
            store.get("provider-deepseek-existing").unwrap().as_deref(),
            Some("first-secret")
        );
        set_credential_with_store(
            directory.path(),
            "provider-deepseek-existing",
            "replacement-secret",
            true,
            &store,
        )
        .unwrap();

        assert_eq!(
            store.get("provider-deepseek-existing").unwrap().as_deref(),
            Some("replacement-secret")
        );
        assert_eq!(
            store.get("provider-second").unwrap().as_deref(),
            Some("second-secret")
        );
        delete_credential_with_store(directory.path(), "provider-deepseek-existing", &store)
            .unwrap();
        delete_credential_with_store(directory.path(), "provider-deepseek-existing", &store)
            .unwrap();
        assert_eq!(store.get("provider-deepseek-existing").unwrap(), None);
        assert_eq!(
            store.get("provider-second").unwrap().as_deref(),
            Some("second-secret")
        );
    }

    #[test]
    fn credential_validation_rejects_unknown_empty_oversize_and_key_optional_provider() {
        let directory = TempDir::new().unwrap();
        let store = MemoryCredentialStore::default();
        assert!(
            set_credential_with_store(directory.path(), "missing", "secret", false, &store)
                .is_err()
        );
        assert!(
            set_credential_with_store(
                directory.path(),
                "provider-deepseek-existing",
                "",
                false,
                &store,
            )
            .is_err()
        );
        assert!(
            set_credential_with_store(
                directory.path(),
                "provider-deepseek-existing",
                &"x".repeat(MAX_CREDENTIAL_BYTES + 1),
                false,
                &store,
            )
            .is_err()
        );
        let mut settings = default_settings();
        settings.providers[0].api_key_required = false;
        settings.providers[0].api_key_env = None;
        save_settings(directory.path(), &settings).unwrap();
        assert!(
            set_credential_with_store(
                directory.path(),
                "provider-deepseek-existing",
                "secret",
                false,
                &store,
            )
            .is_err()
        );
        assert!(store.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn settings_projection_never_exposes_provider_credentials() {
        let directory = TempDir::new().unwrap();
        let settings = default_settings();
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                "secret-that-must-not-be-read".to_string(),
            )])),
            ..Default::default()
        };
        let view = settings_view_from_settings_projection(directory.path(), settings);
        let provider = view
            .providers
            .iter()
            .find(|provider| provider.profile.id == "provider-deepseek-existing")
            .unwrap();

        assert_eq!(provider.credential_status, "not_detected");
        assert_eq!(provider.credential_effective_source, "rho_vault");
        assert!(store.get_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn local_store_projects_exact_non_secret_credential_states_after_restart() {
        let directory = TempDir::new().unwrap();
        agent_credential_vault::set(
            directory.path(),
            "provider-deepseek-existing",
            "saved-secret",
        )
        .unwrap();
        agent_credential_vault::clear_session_for_test(directory.path());
        let mut settings = default_settings();
        for (id, required) in [
            ("provider-missing", true),
            ("provider-unavailable", true),
            ("provider-optional", false),
        ] {
            let mut provider = settings.providers[0].clone();
            provider.id = id.to_string();
            provider.api_key_required = required;
            provider.api_key_env = required.then(|| format!("{}_KEY", id.to_ascii_uppercase()));
            settings.providers.push(provider);
        }
        let statuses = credential_status_map(directory.path(), &settings.providers);

        assert_eq!(statuses["provider-deepseek-existing"].status, "detected");
        assert_eq!(statuses["provider-deepseek-existing"].source, "rho_vault");
        assert_eq!(statuses["provider-missing"].status, "not_detected");
        assert_eq!(statuses["provider-missing"].source, "rho_vault");
        assert_eq!(statuses["provider-unavailable"].status, "not_detected");
        assert_eq!(statuses["provider-unavailable"].source, "rho_vault");
        assert_eq!(statuses["provider-optional"].status, "not_required");
        assert_eq!(statuses["provider-optional"].source, "not_required");
    }

    #[test]
    fn credential_write_failure_preserves_existing_secret() {
        let directory = TempDir::new().unwrap();
        save_settings(directory.path(), &default_settings()).unwrap();
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                "existing-secret".to_string(),
            )])),
            fail_set: true,
            fail_delete: true,
            ..Default::default()
        };

        assert!(
            set_credential_with_store(
                directory.path(),
                "provider-deepseek-existing",
                "replacement-secret",
                true,
                &store,
            )
            .is_err()
        );
        assert_eq!(
            store.get("provider-deepseek-existing").unwrap().as_deref(),
            Some("existing-secret")
        );
    }

    #[test]
    fn provider_deletion_cascades_owned_dependencies_and_survives_reopen() {
        let directory = TempDir::new().unwrap();
        let settings = provider_removal_fixture();
        save_settings(directory.path(), &settings).unwrap();
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([
                (
                    "provider-deepseek-existing".to_string(),
                    "target-secret".to_string(),
                ),
                (
                    "provider-remaining".to_string(),
                    "remaining-secret".to_string(),
                ),
            ])),
            ..Default::default()
        };
        let request = delete_provider_request(&settings);

        let removed = delete_provider_with_store(directory.path(), &request, &store).unwrap();

        assert_eq!(removed.revision, settings.revision + 1);
        assert_eq!(removed.providers.len(), 1);
        assert_eq!(removed.providers[0].id, "provider-remaining");
        assert_eq!(removed.models.len(), 1);
        assert_eq!(removed.models[0].id, "model-remaining-chat");
        assert_eq!(removed.capability_routes.len(), 1);
        assert_eq!(removed.capability_routes[0].capability, "agent.chat");
        assert_eq!(
            removed.capability_routes[0].model_id,
            "model-remaining-chat"
        );
        assert_eq!(store.get("provider-deepseek-existing").unwrap(), None);
        assert_eq!(
            store.get("provider-remaining").unwrap().as_deref(),
            Some("remaining-secret")
        );
        assert_eq!(
            store.delete_calls.lock().unwrap().as_slice(),
            ["provider-deepseek-existing"]
        );

        let reopened = load_settings(directory.path()).unwrap();
        assert_eq!(reopened.revision, removed.revision);
        assert_eq!(reopened.providers[0].id, "provider-remaining");
        assert_eq!(reopened.models[0].id, "model-remaining-chat");
        assert_eq!(reopened.capability_routes[0].capability, "agent.chat");

        let late = delete_provider_with_store(directory.path(), &request, &store).unwrap_err();
        assert!(late.to_string().contains("changed"));
        assert_eq!(
            store.delete_calls.lock().unwrap().as_slice(),
            ["provider-deepseek-existing"]
        );
    }

    #[test]
    fn provider_deletion_handles_a_provider_without_models_or_a_stored_credential() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        let mut empty_provider = settings.providers[0].clone();
        empty_provider.id = "provider-empty".to_string();
        empty_provider.display_name = "Empty Provider".to_string();
        settings.providers.push(empty_provider);
        save_settings(directory.path(), &settings).unwrap();
        let store = MemoryCredentialStore::default();

        let removed = delete_provider_with_store(
            directory.path(),
            &DeleteProviderRequest {
                provider_id: "provider-empty".to_string(),
                expected_revision: settings.revision,
            },
            &store,
        )
        .unwrap();

        assert_eq!(removed.revision, settings.revision + 1);
        assert_eq!(removed.providers.len(), 1);
        assert_eq!(removed.providers[0].id, "provider-deepseek-existing");
        assert_eq!(removed.models.len(), 1);
        assert_eq!(removed.capability_routes.len(), 1);
        assert_eq!(
            store.delete_calls.lock().unwrap().as_slice(),
            ["provider-empty"]
        );
        validate_settings(&load_settings(directory.path()).unwrap()).unwrap();
    }

    #[test]
    fn provider_deletion_rejects_stale_unknown_and_chat_ownership_before_credential_access() {
        let directory = TempDir::new().unwrap();
        let settings = provider_removal_fixture();
        save_settings(directory.path(), &settings).unwrap();
        let original = std::fs::read(settings_path(directory.path())).unwrap();
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                "target-secret".to_string(),
            )])),
            fail_get: true,
            ..Default::default()
        };

        let stale = delete_provider_with_store(
            directory.path(),
            &DeleteProviderRequest {
                provider_id: "provider-deepseek-existing".to_string(),
                expected_revision: settings.revision + 1,
            },
            &store,
        )
        .unwrap_err();
        assert!(stale.to_string().contains("changed"));
        assert!(store.get_calls.lock().unwrap().is_empty());

        let unknown = delete_provider_with_store(
            directory.path(),
            &DeleteProviderRequest {
                provider_id: "provider-missing".to_string(),
                expected_revision: settings.revision,
            },
            &store,
        )
        .unwrap_err();
        assert!(unknown.to_string().contains("Unknown provider"));
        assert!(store.get_calls.lock().unwrap().is_empty());

        for invalid_provider_id in [String::new(), "x".repeat(MAX_ID_LENGTH + 1)] {
            let malformed = delete_provider_with_store(
                directory.path(),
                &DeleteProviderRequest {
                    provider_id: invalid_provider_id,
                    expected_revision: settings.revision,
                },
                &store,
            )
            .unwrap_err();
            assert!(
                malformed.to_string().contains("must not be empty")
                    || malformed.to_string().contains("too long")
            );
        }
        assert!(store.get_calls.lock().unwrap().is_empty());

        let mut chat_owned = settings.clone();
        chat_owned.capability_routes[0].model_id = "model-deepseek-v4-flash".to_string();
        save_settings(directory.path(), &chat_owned).unwrap();
        let chat_original = std::fs::read(settings_path(directory.path())).unwrap();
        let chat_blocked = delete_provider_with_store(
            directory.path(),
            &delete_provider_request(&chat_owned),
            &store,
        )
        .unwrap_err();
        assert!(chat_blocked.to_string().contains("Assign Chat"));
        assert!(store.get_calls.lock().unwrap().is_empty());
        assert!(store.delete_calls.lock().unwrap().is_empty());
        assert_eq!(
            store
                .entries
                .lock()
                .unwrap()
                .get("provider-deepseek-existing")
                .map(String::as_str),
            Some("target-secret")
        );
        assert_ne!(chat_original, original);
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            chat_original
        );
        assert_eq!(load_settings(directory.path()).unwrap().providers.len(), 2);
    }

    #[test]
    fn provider_deletion_credential_failures_preserve_metadata_and_secret() {
        let directory = TempDir::new().unwrap();
        let settings = provider_removal_fixture();
        save_settings(directory.path(), &settings).unwrap();
        let original = std::fs::read(settings_path(directory.path())).unwrap();
        let request = delete_provider_request(&settings);
        let read_failure = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                "target-secret".to_string(),
            )])),
            fail_get: true,
            ..Default::default()
        };

        let error =
            delete_provider_with_store(directory.path(), &request, &read_failure).unwrap_err();
        assert!(error.to_string().contains("credential read failure"));
        assert!(read_failure.delete_calls.lock().unwrap().is_empty());
        assert_eq!(
            read_failure
                .entries
                .lock()
                .unwrap()
                .get("provider-deepseek-existing")
                .map(String::as_str),
            Some("target-secret")
        );
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            original
        );

        let delete_failure = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                "target-secret".to_string(),
            )])),
            fail_delete: true,
            ..Default::default()
        };
        let error =
            delete_provider_with_store(directory.path(), &request, &delete_failure).unwrap_err();
        assert!(error.to_string().contains("credential delete failure"));
        assert_eq!(delete_failure.delete_calls.lock().unwrap().len(), 1);
        assert_eq!(
            delete_failure
                .entries
                .lock()
                .unwrap()
                .get("provider-deepseek-existing")
                .map(String::as_str),
            Some("target-secret")
        );
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            original
        );
    }

    #[test]
    fn provider_metadata_failure_restores_deleted_credential_and_allows_retry() {
        let directory = TempDir::new().unwrap();
        let settings = provider_removal_fixture();
        save_settings(directory.path(), &settings).unwrap();
        let original = std::fs::read(settings_path(directory.path())).unwrap();
        let request = delete_provider_request(&settings);
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([
                (
                    "provider-deepseek-existing".to_string(),
                    "target-secret".to_string(),
                ),
                (
                    "provider-remaining".to_string(),
                    "remaining-secret".to_string(),
                ),
            ])),
            ..Default::default()
        };

        let result =
            delete_provider_with_store_and_save(directory.path(), &request, &store, |_, _| {
                bail!("injected metadata write failure")
            });

        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("its credential was restored")
        );
        assert_eq!(
            store.get("provider-deepseek-existing").unwrap().as_deref(),
            Some("target-secret")
        );
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            original
        );
        assert_eq!(store.delete_calls.lock().unwrap().len(), 1);
        assert_eq!(store.set_calls.lock().unwrap().len(), 1);

        let recovered = delete_provider_with_store(directory.path(), &request, &store).unwrap();
        assert_eq!(recovered.providers[0].id, "provider-remaining");
        assert_eq!(store.get("provider-deepseek-existing").unwrap(), None);
        assert_eq!(
            store.get("provider-remaining").unwrap().as_deref(),
            Some("remaining-secret")
        );
    }

    #[test]
    fn provider_metadata_and_credential_restore_failure_reports_partial_recovery_truthfully() {
        let directory = TempDir::new().unwrap();
        let settings = provider_removal_fixture();
        save_settings(directory.path(), &settings).unwrap();
        let original = std::fs::read(settings_path(directory.path())).unwrap();
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                "target-secret".to_string(),
            )])),
            fail_set: true,
            ..Default::default()
        };

        let error = delete_provider_with_store_and_save(
            directory.path(),
            &delete_provider_request(&settings),
            &store,
            |_, _| bail!("injected metadata write failure"),
        )
        .unwrap_err();

        assert!(error.to_string().contains("could not be restored"));
        assert!(!error.to_string().contains("target-secret"));
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            original
        );
        assert!(
            load_settings(directory.path())
                .unwrap()
                .providers
                .iter()
                .any(|provider| provider.id == "provider-deepseek-existing")
        );
        assert!(
            !store
                .entries
                .lock()
                .unwrap()
                .contains_key("provider-deepseek-existing")
        );
        assert_eq!(store.delete_calls.lock().unwrap().len(), 1);
        assert_eq!(store.set_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn simultaneous_provider_deletions_accept_exactly_one_revision() {
        let directory = TempDir::new().unwrap();
        let settings = provider_removal_fixture();
        save_settings(directory.path(), &settings).unwrap();
        let data_dir = Arc::new(directory.path().to_path_buf());
        let request = Arc::new(delete_provider_request(&settings));
        let store = Arc::new(MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                "target-secret".to_string(),
            )])),
            ..Default::default()
        });
        let barrier = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let data_dir = Arc::clone(&data_dir);
                let request = Arc::clone(&request);
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    delete_provider_with_store(data_dir.as_path(), request.as_ref(), &*store)
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes.iter().filter(|outcome| outcome.is_err()).count(),
            1
        );
        assert_eq!(store.get_calls.lock().unwrap().len(), 1);
        assert_eq!(store.delete_calls.lock().unwrap().len(), 1);
        let reopened = load_settings(directory.path()).unwrap();
        assert_eq!(reopened.revision, settings.revision + 1);
        assert_eq!(reopened.providers[0].id, "provider-remaining");
    }

    #[test]
    fn credential_value_never_enters_settings_or_runtime_profile() {
        let directory = TempDir::new().unwrap();
        save_settings(directory.path(), &default_settings()).unwrap();
        let store = MemoryCredentialStore::default();
        let secret = "credential-value-that-must-not-persist";
        set_credential_with_store(
            directory.path(),
            "provider-deepseek-existing",
            secret,
            false,
            &store,
        )
        .unwrap();

        let settings = load_settings(directory.path()).unwrap();
        let resolved = resolve_model_with_settings(&settings, None).unwrap();
        let credential = credential_override_with_store(
            directory.path(),
            &settings,
            &resolved.provider_id,
            &store,
            "credential_test_read",
        )
        .unwrap();
        assert_eq!(
            credential.as_ref().map(|(_, value)| value.as_str()),
            Some(secret)
        );
        assert!(!serde_json::to_string(&settings).unwrap().contains(secret));
        assert!(
            !serde_json::to_string(&resolved.runtime_profile)
                .unwrap()
                .contains(secret)
        );
        assert!(
            !std::fs::read_to_string(settings_path(directory.path()))
                .unwrap()
                .contains(secret)
        );
    }

    #[test]
    fn duplicate_provider_ids_are_rejected() {
        let mut settings = default_settings();
        settings.providers.push(settings.providers[0].clone());
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn selected_model_must_exist_and_be_enabled() {
        let mut settings = default_settings();
        settings.capability_routes[0].model_id = "missing".to_string();
        assert!(validate_settings(&settings).is_err());
        let mut settings = default_settings();
        settings.models[0].enabled = false;
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn environment_variable_names_are_validated() {
        let mut settings = default_settings();
        settings.providers[0].api_key_env = Some("1BAD".to_string());
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn base_urls_reject_secret_like_query_parameters() {
        let mut settings = default_settings();
        settings.providers[0].kind = "openai_compatible".to_string();
        settings.providers[0].registered_provider_id = None;
        settings.providers[0].base_url = Some("https://example.test/v1?api_key=secret".to_string());
        settings.providers[0].wire_api = Some("chat_completions".to_string());
        settings.providers[0].api_key_env = Some("OPENAI_API_KEY".to_string());
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn reviewed_builtin_and_registered_providers_accept_optional_base_urls() {
        let mut settings = default_settings();
        settings.providers[0].base_url =
            Some("https://gateway.example.test/deepseek/v1".to_string());
        settings.providers[0].wire_api = Some("chat_completions".to_string());
        assert!(validate_settings(&settings).is_ok());

        settings.providers[0].registered_provider_id = Some("unlisted-provider".to_string());
        let error = validate_settings(&settings).unwrap_err().to_string();
        assert!(error.contains("reviewed registered providers"));

        settings.providers[0].kind = "openai".to_string();
        settings.providers[0].registered_provider_id = None;
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn provider_view_projects_reviewed_default_and_configured_base_urls() {
        let mut provider = default_settings().providers.remove(0);
        assert_eq!(
            provider_base_url_presentation(&provider),
            (
                Some("https://api.deepseek.com".to_string()),
                "provider_default".to_string()
            )
        );

        provider.base_url = Some("https://gateway.example.test/v1".to_string());
        assert_eq!(
            provider_base_url_presentation(&provider),
            (
                Some("https://gateway.example.test/v1".to_string()),
                "configured".to_string()
            )
        );
    }

    #[test]
    fn discovery_targets_cover_builtin_and_literal_custom_providers() {
        let mut provider = default_settings().providers.remove(0);
        let deepseek = model_discovery_target(&provider).unwrap().unwrap();
        assert_eq!(deepseek.url.as_str(), "https://api.deepseek.com/models");
        assert_eq!(deepseek.format, ModelDiscoveryFormat::OpenAi);
        assert_eq!(deepseek.auth, ModelDiscoveryAuth::Bearer);

        provider.kind = "anthropic".to_string();
        provider.registered_provider_id = None;
        let anthropic = model_discovery_target(&provider).unwrap().unwrap();
        assert_eq!(anthropic.url.path(), "/v1/models");
        assert_eq!(anthropic.url.query(), Some("limit=100"));
        assert_eq!(anthropic.format, ModelDiscoveryFormat::Anthropic);
        assert_eq!(anthropic.auth, ModelDiscoveryAuth::Anthropic);

        provider.kind = "gemini".to_string();
        let gemini = model_discovery_target(&provider).unwrap().unwrap();
        assert_eq!(gemini.url.path(), "/v1beta/models");
        assert_eq!(gemini.url.query(), Some("pageSize=100"));
        assert_eq!(gemini.format, ModelDiscoveryFormat::Gemini);
        assert_eq!(gemini.auth, ModelDiscoveryAuth::Gemini);

        provider.kind = "openai_compatible".to_string();
        provider.base_url = Some("https://example.test/api/v1?tenant=one".to_string());
        provider.wire_api = Some("chat_completions".to_string());
        let custom = model_discovery_target(&provider).unwrap().unwrap();
        assert_eq!(
            custom.url.as_str(),
            "https://example.test/api/v1/models?tenant=one"
        );

        provider.base_url = None;
        provider.base_url_env = Some("CUSTOM_BASE_URL".to_string());
        assert!(model_discovery_target(&provider).unwrap().is_none());

        provider = default_settings().providers.remove(0);
        provider.base_url = Some("https://gateway.example.test/team/v1".to_string());
        let overridden = model_discovery_target(&provider).unwrap().unwrap();
        assert_eq!(
            overridden.url.as_str(),
            "https://gateway.example.test/team/v1/models"
        );

        provider.base_url = None;
        provider.base_url_env = Some("DEEPSEEK_BASE_URL".to_string());
        assert!(model_discovery_target(&provider).unwrap().is_none());

        for registered_provider_id in [
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
        ] {
            provider = default_settings().providers.remove(0);
            provider.registered_provider_id = Some(registered_provider_id.to_string());
            let target = model_discovery_target(&provider).unwrap().unwrap();
            assert!(target.url.path().ends_with("/models"));
            assert!(target.url.username().is_empty());
            assert!(target.url.password().is_none());
        }
    }

    #[test]
    fn discovery_parsers_filter_dedupe_sort_and_bound_models() {
        let mut data = (0..105)
            .map(|index| {
                serde_json::json!({
                    "id": format!("model-{index:03}"),
                    "display_name": format!("Model {index:03}")
                })
            })
            .collect::<Vec<_>>();
        data.push(serde_json::json!({ "id": "model-001", "display_name": "Duplicate" }));
        data.push(serde_json::json!({ "id": "bad\nmodel", "display_name": "Bad" }));
        let bytes = serde_json::to_vec(&serde_json::json!({ "data": data })).unwrap();
        let (models, truncated) =
            parse_discovered_models(ModelDiscoveryFormat::OpenAi, &bytes).unwrap();
        assert_eq!(models.len(), MAX_DISCOVERED_MODELS);
        assert!(truncated);
        assert_eq!(models.first().unwrap().id, "model-000");
        assert_eq!(models.last().unwrap().id, "model-099");
        assert!(models.iter().all(|model| model.id != "bad\nmodel"));
        assert!(models.iter().all(|model| {
            model.model_type.source == "unknown"
                && model
                    .capabilities
                    .values()
                    .all(|value| value.source == "unknown")
        }));

        assert!(
            parse_discovered_models(ModelDiscoveryFormat::OpenAi, br#"{"models":[]}"#).is_err()
        );
        assert!(parse_discovered_models(ModelDiscoveryFormat::OpenAi, b"not json").is_err());
    }

    #[test]
    fn gemini_discovery_keeps_generation_models_and_reports_pagination() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "models": [
                {
                    "name": "models/gemini-z",
                    "baseModelId": "gemini-z",
                    "displayName": "Gemini Z",
                    "supportedGenerationMethods": ["generateContent"],
                    "thinking": true
                },
                {
                    "name": "models/text-embedding",
                    "displayName": "Embedding",
                    "supportedGenerationMethods": ["embedContent"]
                },
                {
                    "name": "models/gemini-a",
                    "displayName": "Gemini A",
                    "supportedActions": ["generateContent"],
                    "thinking": false
                }
            ],
            "nextPageToken": "next-page"
        }))
        .unwrap();
        let (models, truncated) =
            parse_discovered_models(ModelDiscoveryFormat::Gemini, &bytes).unwrap();
        assert!(truncated);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gemini-a");
        assert_eq!(models[0].capabilities["reasoning"].value, "no");
        assert_eq!(
            models[0].capabilities["reasoning"].source,
            "provider_response"
        );
        assert_eq!(models[1].id, "gemini-z");
        assert_eq!(models[1].capabilities["reasoning"].value, "yes");
    }

    #[test]
    fn anthropic_discovery_uses_human_display_names() {
        let bytes = br#"{
            "data": [
                {"id":"claude-example","display_name":"Claude Example"}
            ],
            "has_more": false
        }"#;
        let (models, truncated) =
            parse_discovered_models(ModelDiscoveryFormat::Anthropic, bytes).unwrap();
        assert!(!truncated);
        assert_eq!(models[0].id, "claude-example");
        assert_eq!(models[0].display_name, "Claude Example");
    }

    #[test]
    fn discovery_sends_only_the_expected_auth_header_and_never_mutates_settings() {
        let directory = TempDir::new().unwrap();
        let secret = "discovery-secret-never-returned";
        let body = serde_json::json!({
            "data": [
                {"id":"z-model"},
                {"id":"a-model"}
            ]
        })
        .to_string();
        let (base_url, server) = spawn_discovery_server("200 OK", &[], body, Duration::ZERO);
        save_custom_discovery_provider(&directory, base_url);
        let before = std::fs::read(settings_path(directory.path())).unwrap();
        let store = store_with_discovery_secret(secret);

        let response = discover_models_with_store(
            directory.path(),
            "provider-deepseek-existing",
            &store,
            &model_discovery_client().unwrap(),
        )
        .unwrap();
        let request = server.join().unwrap();

        assert_eq!(response.status, "ready");
        assert_eq!(response.models[0].id, "a-model");
        assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains(&format!("authorization: bearer {secret}").to_ascii_lowercase())
        );
        assert!(!serde_json::to_string(&response).unwrap().contains(secret));
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            before
        );
    }

    #[test]
    fn missing_discovery_credential_rejects_before_network_access() {
        let directory = TempDir::new().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        save_custom_discovery_provider(
            &directory,
            format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let response = discover_models_with_store(
            directory.path(),
            "provider-deepseek-existing",
            &MemoryCredentialStore::default(),
            &model_discovery_client().unwrap(),
        )
        .unwrap();
        assert_eq!(response.status, "error");
        assert_eq!(response.error_class.as_deref(), Some("credential"));
        assert!(matches!(
            listener.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    #[test]
    fn discovery_redacts_provider_error_bodies_and_refuses_redirects() {
        let directory = TempDir::new().unwrap();
        let secret = "credential-that-must-not-leak";
        let (base_url, server) = spawn_discovery_server(
            "401 Unauthorized",
            &[],
            format!("provider echoed {secret}"),
            Duration::ZERO,
        );
        save_custom_discovery_provider(&directory, base_url);
        let store = store_with_discovery_secret(secret);
        let response = discover_models_with_store(
            directory.path(),
            "provider-deepseek-existing",
            &store,
            &model_discovery_client().unwrap(),
        )
        .unwrap();
        server.join().unwrap();
        let serialized = serde_json::to_string(&response).unwrap();
        assert_eq!(response.error_class.as_deref(), Some("auth"));
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("provider echoed"));

        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let location = format!("http://{}/models", redirect_target.local_addr().unwrap());
        let (base_url, server) = spawn_discovery_server(
            "302 Found",
            &[("Location", location.as_str())],
            String::new(),
            Duration::ZERO,
        );
        save_custom_discovery_provider(&directory, base_url);
        let response = discover_models_with_store(
            directory.path(),
            "provider-deepseek-existing",
            &store,
            &model_discovery_client().unwrap(),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(response.status, "unsupported");
        assert!(matches!(
            redirect_target.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    #[test]
    fn discovery_bounds_oversized_responses_and_timeouts() {
        let directory = TempDir::new().unwrap();
        let secret = "bounded-secret";
        let (base_url, server) = spawn_discovery_server(
            "200 OK",
            &[],
            "x".repeat(MAX_MODEL_DISCOVERY_BYTES + 1),
            Duration::ZERO,
        );
        save_custom_discovery_provider(&directory, base_url);
        let store = store_with_discovery_secret(secret);
        let response = discover_models_with_store(
            directory.path(),
            "provider-deepseek-existing",
            &store,
            &model_discovery_client().unwrap(),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(response.error_class.as_deref(), Some("response"));
        assert!(response.message.contains("1 MiB"));

        let (base_url, server) = spawn_stalled_discovery_server();
        save_custom_discovery_provider(&directory, base_url);
        let short_client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(250))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        let response = discover_models_with_store(
            directory.path(),
            "provider-deepseek-existing",
            &store,
            &short_client,
        )
        .unwrap();
        assert_eq!(response.error_class.as_deref(), Some("timeout"));
        assert!(!serde_json::to_string(&response).unwrap().contains(secret));
        drop(short_client);
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
    }

    fn probe_fixture_command(mode: &str, sentinel: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "agent_llm::tests::r_probe_process_fixture",
            "--ignored",
            "--nocapture",
        ]);
        command.env("RHO_PROBE_FIXTURE_MODE", mode);
        command.env("RHO_PROBE_FIXTURE_SENTINEL", sentinel);
        command
    }

    fn successful_probe_command(payload: &str) -> Command {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "printf '%s' \"$RHO_PROBE_SUCCESS_JSON\""]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args([
                "/D",
                "/S",
                "/C",
                "<nul set /p \"=%RHO_PROBE_SUCCESS_JSON%\"",
            ]);
            command
        };
        command.env("RHO_PROBE_SUCCESS_JSON", payload);
        command
    }

    fn successful_probe_file_command(payload_path: &Path) -> Command {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "cat -- \"$RHO_PROBE_SUCCESS_JSON_FILE\""]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", "type \"%RHO_PROBE_SUCCESS_JSON_FILE%\""]);
            command
        };
        command.env("RHO_PROBE_SUCCESS_JSON_FILE", payload_path);
        command
    }

    fn assert_probe_retry_succeeds(control: &AgentModelTestControl) {
        let expected = serde_json::json!({"retry": "ready"});
        let response = run_r_json_command::<serde_json::Value>(
            successful_probe_command(&expected.to_string()),
            None,
            RProbeFailureDisclosure::SuppressDiagnostic,
            Some(control),
        )
        .unwrap();
        assert_eq!(response, expected);
        let state = control.lock().unwrap();
        assert!(state.pid.is_none());
        assert!(!state.cancel_requested);
    }

    #[test]
    #[ignore = "subprocess fixture invoked by connection-probe boundary tests"]
    fn r_probe_process_fixture() {
        let Some(mode) = std::env::var_os("RHO_PROBE_FIXTURE_MODE") else {
            return;
        };
        let mode = mode.to_string_lossy();
        let sentinel = std::env::var("RHO_PROBE_FIXTURE_SENTINEL").unwrap_or_default();
        match mode.as_ref() {
            "stderr_secret" => {
                eprint!("raw-prefix\n{sentinel}\nraw-suffix");
                std::process::exit(19);
            }
            "stderr_empty" => std::process::exit(20),
            "stderr_invalid_utf8" => {
                std::io::stderr().write_all(&[0xff, 0xfe, 0xfd]).unwrap();
                std::process::exit(21);
            }
            "stderr_exact" => {
                let mut output = vec![b'x'; MAX_R_PROBE_STDERR_BYTES];
                let start = output.len() - sentinel.len();
                output[start..].copy_from_slice(sentinel.as_bytes());
                std::io::stderr().write_all(&output).unwrap();
                std::process::exit(22);
            }
            "stderr_oversized" => {
                let mut output = vec![b'x'; MAX_R_PROBE_STDERR_BYTES + 1];
                output.extend_from_slice(sentinel.as_bytes());
                std::io::stderr().write_all(&output).unwrap();
                std::process::exit(23);
            }
            "stdout_invalid" => {
                print!("not-json::{sentinel}");
                std::io::stdout().flush().unwrap();
                std::process::exit(0);
            }
            "stdout_oversized" => {
                let mut output = vec![b'x'; MAX_R_PROBE_STDOUT_BYTES + 1];
                output.extend_from_slice(sentinel.as_bytes());
                std::io::stdout().write_all(&output).unwrap();
                std::process::exit(0);
            }
            "exit_before_stdin" => std::process::exit(24),
            "environment_json" => {
                let values = [
                    "GITHUB_TOKEN",
                    "AMBIENT_ACCESS_TOKEN",
                    "PROVIDER_A_CUSTOM_SECRET",
                    "PROVIDER_A_ENDPOINT",
                    "PROVIDER_B_CUSTOM_SECRET",
                    "PROVIDER_B_ENDPOINT",
                ]
                .into_iter()
                .map(|name| (name, std::env::var(name).ok()))
                .collect::<BTreeMap<_, _>>();
                let output = std::env::var_os("RHO_PROBE_FIXTURE_OUTPUT").unwrap();
                std::fs::write(output, serde_json::to_vec(&values).unwrap()).unwrap();
            }
            "descendant_holds_pipe" => {
                let descendant = probe_fixture_command("sleep", "unused").spawn().unwrap();
                if let Some(output) = std::env::var_os("RHO_PROBE_FIXTURE_OUTPUT") {
                    std::fs::write(output, descendant.id().to_string()).unwrap();
                }
            }
            "production_connection_test" => {
                let data_dir = PathBuf::from(std::env::var_os("RHO_PRODUCTION_DATA_DIR").unwrap());
                let rscript = PathBuf::from(std::env::var_os("RHO_PRODUCTION_RSCRIPT").unwrap());
                let calls_path = PathBuf::from(std::env::var_os("RHO_PRODUCTION_CALLS").unwrap());
                let store = MemoryCredentialStore {
                    entries: Mutex::new(HashMap::from([
                        (
                            "provider-a".to_string(),
                            "rho-selected-credential-production-fixture".to_string(),
                        ),
                        (
                            "provider-b".to_string(),
                            "rho-other-credential-production-fixture".to_string(),
                        ),
                    ])),
                    ..Default::default()
                };
                let view = test_model_with_store(
                    &data_dir,
                    &rscript,
                    Path::new("/unused/rho.agent"),
                    "model-deepseek-v4-flash",
                    None,
                    &store,
                )
                .unwrap();
                let tested = view
                    .models
                    .iter()
                    .find(|model| model.profile.id == "model-deepseek-v4-flash")
                    .unwrap();
                assert_eq!(tested.profile.last_test.as_ref().unwrap().status, "ready");
                std::fs::write(
                    calls_path,
                    serde_json::to_vec(&*store.get_calls.lock().unwrap()).unwrap(),
                )
                .unwrap();
            }
            #[cfg(unix)]
            "catalog_call" => {
                let data_dir = PathBuf::from(std::env::var_os("RHO_CATALOG_DATA_DIR").unwrap());
                let rscript = PathBuf::from(std::env::var_os("RHO_CATALOG_RSCRIPT").unwrap());
                assert!(catalog(&data_dir, &rscript).unwrap().is_empty());
            }
            "sleep" => std::thread::sleep(Duration::from_secs(60)),
            _ => std::process::exit(25),
        }
    }

    #[test]
    fn connection_probe_process_failures_never_return_child_diagnostics() {
        let sentinel = "rho-bare-credential-sentinel-1a";
        for mode in [
            "stderr_secret",
            "stderr_empty",
            "stderr_invalid_utf8",
            "stderr_exact",
            "stderr_oversized",
        ] {
            let error = run_r_json_command::<serde_json::Value>(
                probe_fixture_command(mode, sentinel),
                None,
                RProbeFailureDisclosure::SuppressDiagnostic,
                None,
            )
            .unwrap_err();
            let service_error = error.to_string();
            let tauri_error = crate::startup_runtime::display_error(&error);
            assert_eq!(service_error, CONNECTION_TEST_PROCESS_FAILURE);
            assert_eq!(tauri_error, CONNECTION_TEST_PROCESS_FAILURE);
            for forbidden in [
                sentinel,
                &sentinel[..10],
                &sentinel[sentinel.len() - 10..],
                "raw-prefix",
                "raw-suffix",
            ] {
                assert!(!service_error.contains(forbidden), "mode={mode}");
                assert!(!tauri_error.contains(forbidden), "mode={mode}");
            }
        }
    }

    #[test]
    fn connection_probe_invalid_stdout_returns_only_fixed_protocol_error() {
        let sentinel = "rho-stdout-sentinel-never-returned";
        for mode in ["stdout_invalid", "stdout_oversized"] {
            let error = run_r_json_command::<serde_json::Value>(
                probe_fixture_command(mode, sentinel),
                None,
                RProbeFailureDisclosure::SuppressDiagnostic,
                None,
            )
            .unwrap_err()
            .to_string();
            assert_eq!(
                error,
                "Rho received an invalid Provider connection-test response."
            );
            assert!(!error.contains(sentinel));
        }
    }

    #[test]
    fn connection_probe_decodes_and_normalizes_success_json() {
        let discarded_message = "rho-ignored-message-sentinel\nwith\\escapes";
        let raw_json = serde_json::json!({
            "status": "ready",
            "credential_status": "detected",
            "model_resolved": true,
            "latency_ms": 9,
            "capabilities": {
                "tool_calling": "yes",
                "reasoning": "unknown",
                "vision_input": "no",
                "source": "probe"
            },
            "message": discarded_message,
            "error_class": null
        })
        .to_string();
        let raw: RawAgentConnectionTestResponse = run_r_json_command(
            successful_probe_command(&raw_json),
            None,
            RProbeFailureDisclosure::SuppressDiagnostic,
            None,
        )
        .unwrap();
        let response = normalize_connection_test_response(raw).unwrap();
        assert_eq!(response.status, "ready");
        assert_eq!(response.message, "Connection succeeded.");
        assert!(
            !serde_json::to_string(&response)
                .unwrap()
                .contains(discarded_message)
        );
        assert!(response.error_class.is_none());
    }

    #[test]
    fn probe_capture_keeps_exact_bounds_and_drains_the_remainder() {
        for limit in [MAX_R_PROBE_STDOUT_BYTES, MAX_R_PROBE_STDERR_BYTES] {
            let exact = drain_bounded(std::io::Cursor::new(vec![b'a'; limit]), limit).unwrap();
            assert_eq!(exact.bytes.len(), limit);
            assert!(exact.bytes.capacity() >= limit);
            assert!(!exact.truncated);

            let source = vec![b'b'; limit + 8 * 1024 + 1];
            let mut cursor = std::io::Cursor::new(source.clone());
            let oversized = drain_bounded(&mut cursor, limit).unwrap();
            assert_eq!(oversized.bytes.len(), limit);
            assert!(oversized.truncated);
            assert_eq!(cursor.position(), source.len() as u64);
        }
    }

    #[test]
    fn probe_parent_exit_terminates_descendants_before_bounded_pipe_join() {
        let evidence = TempDir::new().unwrap();
        let evidence_path = evidence.path().join("descendant.pid");
        let mut command = probe_fixture_command("descendant_holds_pipe", "unused");
        command.env("RHO_PROBE_FIXTURE_OUTPUT", &evidence_path);
        let started = Instant::now();
        let error = run_r_json_command::<serde_json::Value>(
            command,
            None,
            RProbeFailureDisclosure::SuppressDiagnostic,
            None,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            error,
            "Rho received an invalid Provider connection-test response."
        );
        assert!(started.elapsed() < R_PROBE_PIPE_JOIN_TIMEOUT);
        let descendant_pid = std::fs::read_to_string(evidence_path)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        assert_process_terminated(descendant_pid, "contained probe descendant");
    }

    fn connection_response_fixture(error_class: Option<&str>) -> RawAgentConnectionTestResponse {
        RawAgentConnectionTestResponse {
            status: SecretString::new("error".to_string()),
            credential_status: SecretString::new("detected".to_string()),
            model_resolved: false,
            latency_ms: Some(7),
            capabilities: RawAgentModelCapabilitiesV1 {
                tool_calling: SecretString::new("yes".to_string()),
                reasoning: SecretString::new("unknown".to_string()),
                vision_input: SecretString::new("no".to_string()),
                source: SecretString::new("probe".to_string()),
            },
            _message: serde::de::IgnoredAny,
            error_class: error_class.map(|value| SecretString::new(value.to_string())),
        }
    }

    #[test]
    fn structured_connection_failures_use_only_allowlisted_fixed_copy() {
        let sentinel = "rho-structured-message-sentinel";
        let arbitrary_long_message = format!("{sentinel}\n{}", "x".repeat(128 * 1024));
        let expectations = [
            (
                "credential",
                "The Provider rejected the configured credential.",
                "credential",
            ),
            (
                "timeout",
                "The Provider connection test timed out.",
                "timeout",
            ),
            (
                "endpoint",
                "The Provider endpoint or model configuration was rejected.",
                "endpoint",
            ),
            ("network", "Rho could not reach the Provider.", "network"),
            (
                "provider",
                "The Provider connection test failed.",
                "provider",
            ),
            (
                "rho-error-class-sentinel-never-returned",
                "The Provider connection test failed.",
                "provider",
            ),
        ];
        for (error_class, expected_message, expected_error_class) in expectations {
            let payload_directory = TempDir::new().unwrap();
            let payload_path = payload_directory.path().join("structured-failure.json");
            std::fs::write(
                &payload_path,
                serde_json::to_vec(&serde_json::json!({
                    "status": "error",
                    "credential_status": "detected",
                    "model_resolved": false,
                    "latency_ms": 7,
                    "capabilities": {
                        "tool_calling": "yes",
                        "reasoning": "unknown",
                        "vision_input": "no",
                        "source": "probe"
                    },
                    "message": arbitrary_long_message,
                    "error_class": error_class
                }))
                .unwrap(),
            )
            .unwrap();
            let raw: RawAgentConnectionTestResponse = run_r_json_command(
                successful_probe_file_command(&payload_path),
                None,
                RProbeFailureDisclosure::SuppressDiagnostic,
                None,
            )
            .unwrap();
            let response = normalize_connection_test_response(raw).unwrap();
            assert_eq!(response.message, expected_message);
            assert_eq!(response.error_class.as_deref(), Some(expected_error_class));
            let serialized = serde_json::to_string(&response).unwrap();
            assert!(!serialized.contains(sentinel));
            assert!(
                !serialized.contains(&arbitrary_long_message),
                "error_class={error_class}"
            );
            if error_class != expected_error_class {
                assert!(!serialized.contains(error_class));
            }
        }

        let mut ready = connection_response_fixture(Some(sentinel));
        ready.status = SecretString::new("ready".to_string());
        ready.model_resolved = true;
        let ready = normalize_connection_test_response(ready).unwrap();
        assert_eq!(ready.message, "Connection succeeded.");
        assert!(ready.error_class.is_none());
        assert!(!serde_json::to_string(&ready).unwrap().contains(sentinel));

        let mut invalid = connection_response_fixture(Some("provider"));
        invalid.status = SecretString::new(sentinel.to_string());
        let error = normalize_connection_test_response(invalid)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "Rho received an invalid Provider connection-test response."
        );
        assert!(!error.contains(sentinel));

        let mut invalid_credential = connection_response_fixture(Some("provider"));
        invalid_credential.credential_status = SecretString::new(sentinel.to_string());
        let mut invalid_capability = connection_response_fixture(Some("provider"));
        invalid_capability.capabilities.tool_calling = SecretString::new(sentinel.to_string());
        let mut invalid_source = connection_response_fixture(Some("provider"));
        invalid_source.capabilities.source = SecretString::new(sentinel.to_string());
        let mut contradictory_ready = connection_response_fixture(None);
        contradictory_ready.status = SecretString::new("ready".to_string());
        contradictory_ready.model_resolved = true;
        contradictory_ready.credential_status = SecretString::new("not_detected".to_string());
        for invalid in [
            invalid_credential,
            invalid_capability,
            invalid_source,
            contradictory_ready,
        ] {
            let error = normalize_connection_test_response(invalid)
                .unwrap_err()
                .to_string();
            assert_eq!(
                error,
                "Rho received an invalid Provider connection-test response."
            );
            assert!(!error.contains(sentinel));
        }
    }

    #[test]
    fn structured_connection_message_is_safe_before_settings_persistence() {
        let sentinel = "rho-persistence-sentinel-never-stored";
        let payload_directory = TempDir::new().unwrap();
        let payload_path = payload_directory.path().join("structured-failure.json");
        std::fs::write(
            &payload_path,
            serde_json::to_vec(&serde_json::json!({
                "status": "error",
                "credential_status": "detected",
                "model_resolved": false,
                "latency_ms": 7,
                "capabilities": {
                    "tool_calling": "yes",
                    "reasoning": "unknown",
                    "vision_input": "no",
                    "source": "probe"
                },
                "message": format!("{sentinel}\n{}", "x".repeat(128 * 1024)),
                "error_class": "credential"
            }))
            .unwrap(),
        )
        .unwrap();
        let raw: RawAgentConnectionTestResponse = run_r_json_command(
            successful_probe_file_command(&payload_path),
            None,
            RProbeFailureDisclosure::SuppressDiagnostic,
            None,
        )
        .unwrap();
        let response = normalize_connection_test_response(raw).unwrap();
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        update_model_after_test(&mut settings, "model-deepseek-v4-flash", &response).unwrap();
        save_settings(directory.path(), &settings).unwrap();
        let serialized = std::fs::read_to_string(settings_path(directory.path())).unwrap();
        assert!(!serialized.contains(sentinel));
        assert!(serialized.contains("The Provider rejected the configured credential."));
    }

    #[test]
    fn agent_probe_environment_keeps_only_selected_provider_values() {
        let scrub = vec![
            "PROVIDER_A_CUSTOM_SECRET".to_string(),
            "PROVIDER_A_ENDPOINT".to_string(),
            "PROVIDER_B_CUSTOM_SECRET".to_string(),
            "PROVIDER_B_ENDPOINT".to_string(),
        ];
        let inherited = [
            "GITHUB_TOKEN",
            "AMBIENT_ACCESS_TOKEN",
            "PROVIDER_A_CUSTOM_SECRET",
            "PROVIDER_A_ENDPOINT",
            "PROVIDER_B_CUSTOM_SECRET",
            "PROVIDER_B_ENDPOINT",
            "PATH",
        ]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
        let mut command = Command::new("Rscript");
        configure_r_probe(
            &mut command,
            None,
            &scrub,
            inherited,
            &[
                ("PROVIDER_A_CUSTOM_SECRET", "selected-a"),
                ("PROVIDER_A_ENDPOINT", "https://selected-a.example.test"),
            ],
        );
        let projected = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_os_string(),
                    value.map(std::ffi::OsStr::to_os_string),
                )
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(
            projected.get(&OsString::from("PROVIDER_A_CUSTOM_SECRET")),
            Some(&Some(OsString::from("selected-a")))
        );
        assert_eq!(
            projected.get(&OsString::from("PROVIDER_A_ENDPOINT")),
            Some(&Some(OsString::from("https://selected-a.example.test")))
        );
        for removed in [
            "GITHUB_TOKEN",
            "AMBIENT_ACCESS_TOKEN",
            "PROVIDER_B_CUSTOM_SECRET",
            "PROVIDER_B_ENDPOINT",
        ] {
            assert_eq!(
                projected.get(&OsString::from(removed)),
                Some(&None),
                "{removed} was not removed"
            );
        }
        assert!(!projected.contains_key(&OsString::from("PATH")));
    }

    #[test]
    fn probe_child_sees_only_selected_provider_environment() {
        let scrub = vec![
            "PROVIDER_A_CUSTOM_SECRET".to_string(),
            "PROVIDER_A_ENDPOINT".to_string(),
            "PROVIDER_B_CUSTOM_SECRET".to_string(),
            "PROVIDER_B_ENDPOINT".to_string(),
        ];
        let inherited = [
            "GITHUB_TOKEN",
            "AMBIENT_ACCESS_TOKEN",
            "PROVIDER_A_CUSTOM_SECRET",
            "PROVIDER_A_ENDPOINT",
            "PROVIDER_B_CUSTOM_SECRET",
            "PROVIDER_B_ENDPOINT",
        ];
        let evidence = TempDir::new().unwrap();
        let evidence_path = evidence.path().join("environment.json");
        let mut command = probe_fixture_command("environment_json", "unused");
        command.env("RHO_PROBE_FIXTURE_OUTPUT", &evidence_path);
        for name in inherited {
            command.env(name, format!("inherited-{name}"));
        }
        configure_probe_environment(
            &mut command,
            &scrub,
            inherited.into_iter().map(OsString::from),
            &[
                ("PROVIDER_A_CUSTOM_SECRET", "selected-a"),
                ("PROVIDER_A_ENDPOINT", "https://selected-a.example.test"),
            ],
        );
        assert!(command.output().unwrap().status.success());
        let observed: BTreeMap<String, Option<String>> =
            serde_json::from_slice(&std::fs::read(evidence_path).unwrap()).unwrap();
        assert_eq!(
            observed.get("PROVIDER_A_CUSTOM_SECRET"),
            Some(&Some("selected-a".to_string()))
        );
        assert_eq!(
            observed.get("PROVIDER_A_ENDPOINT"),
            Some(&Some("https://selected-a.example.test".to_string()))
        );
        for removed in [
            "GITHUB_TOKEN",
            "AMBIENT_ACCESS_TOKEN",
            "PROVIDER_B_CUSTOM_SECRET",
            "PROVIDER_B_ENDPOINT",
        ] {
            assert_eq!(observed.get(removed), Some(&None), "{removed} leaked");
        }
    }

    #[test]
    fn keyless_probe_child_inherits_no_sensitive_provider_environment() {
        let scrub = vec![
            "PROVIDER_A_CUSTOM_SECRET".to_string(),
            "PROVIDER_A_ENDPOINT".to_string(),
        ];
        let inherited = [
            "GITHUB_TOKEN",
            "AMBIENT_ACCESS_TOKEN",
            "PROVIDER_A_CUSTOM_SECRET",
            "PROVIDER_A_ENDPOINT",
        ];
        let evidence = TempDir::new().unwrap();
        let evidence_path = evidence.path().join("environment.json");
        let mut command = probe_fixture_command("environment_json", "unused");
        command.env("RHO_PROBE_FIXTURE_OUTPUT", &evidence_path);
        for name in inherited {
            command.env(name, format!("inherited-{name}"));
        }
        configure_probe_environment(
            &mut command,
            &scrub,
            inherited.into_iter().map(OsString::from),
            &[],
        );
        assert!(command.output().unwrap().status.success());
        let observed: BTreeMap<String, Option<String>> =
            serde_json::from_slice(&std::fs::read(evidence_path).unwrap()).unwrap();
        for removed in inherited {
            assert_eq!(observed.get(removed), Some(&None), "{removed} leaked");
        }
    }

    #[cfg(unix)]
    #[test]
    fn catalog_loads_settings_scrub_names_without_polluting_r_arguments() {
        use std::os::unix::fs::PermissionsExt;

        let data_dir = TempDir::new().unwrap();
        let fixture_dir = TempDir::new().unwrap();
        let evidence_path = fixture_dir.path().join("catalog-environment.txt");
        let rscript_path = fixture_dir.path().join("fake-rscript");
        std::fs::write(
            &rscript_path,
            r#"#!/bin/sh
{
  printf 'argc=%s\n' "$#"
  printf 'arg1=%s\n' "$1"
  printf 'arg2=%s\n' "$2"
  printf 'custom_value=%s\n' "${RHO_CATALOG_CUSTOM_VALUE-unset}"
  printf 'custom_endpoint=%s\n' "${RHO_CATALOG_CUSTOM_ENDPOINT-unset}"
  printf 'common_secret=%s\n' "${GITHUB_TOKEN-unset}"
  printf 'ordinary=%s\n' "${RHO_CATALOG_ORDINARY-unset}"
} > "$RHO_CATALOG_EVIDENCE"
printf '[]'
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&rscript_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&rscript_path, permissions).unwrap();

        let mut settings = default_settings();
        settings.providers[0].api_key_env = Some("RHO_CATALOG_CUSTOM_VALUE".to_string());
        settings.providers[0].base_url = None;
        settings.providers[0].base_url_env = Some("RHO_CATALOG_CUSTOM_ENDPOINT".to_string());
        save_settings(data_dir.path(), &settings).unwrap();

        let mut fixture = probe_fixture_command("catalog_call", "unused");
        fixture.env("RHO_CATALOG_DATA_DIR", data_dir.path());
        fixture.env("RHO_CATALOG_RSCRIPT", &rscript_path);
        fixture.env("RHO_CATALOG_EVIDENCE", &evidence_path);
        fixture.env("RHO_CATALOG_CUSTOM_VALUE", "catalog-credential-sentinel");
        fixture.env(
            "RHO_CATALOG_CUSTOM_ENDPOINT",
            "https://catalog-endpoint-sentinel.example.test",
        );
        fixture.env("GITHUB_TOKEN", "catalog-common-secret-sentinel");
        fixture.env("RHO_CATALOG_ORDINARY", "ordinary-retained");
        let output = fixture.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );

        let evidence = std::fs::read_to_string(evidence_path).unwrap();
        assert!(evidence.contains("argc=2\n"));
        assert!(evidence.contains("arg1=--vanilla\n"));
        assert!(evidence.contains("arg2="));
        assert!(evidence.contains("custom_value=unset\n"));
        assert!(evidence.contains("custom_endpoint=unset\n"));
        assert!(evidence.contains("common_secret=unset\n"));
        assert!(evidence.contains("ordinary=ordinary-retained\n"));
        for forbidden in [
            "RHO_CATALOG_CUSTOM_VALUE",
            "RHO_CATALOG_CUSTOM_ENDPOINT",
            "catalog-credential-sentinel",
            "catalog-endpoint-sentinel",
            "catalog-common-secret-sentinel",
        ] {
            assert!(!evidence.contains(forbidden));
        }
    }

    #[test]
    fn selected_provider_probe_reads_no_other_credential() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        let mut provider_b = settings.providers[0].clone();
        provider_b.id = "provider-b".to_string();
        provider_b.api_key_env = Some("PROVIDER_B_CUSTOM_SECRET".to_string());
        provider_b.base_url_env = Some("PROVIDER_B_ENDPOINT".to_string());
        provider_b.base_url = None;
        settings.providers[0].api_key_env = Some("PROVIDER_A_CUSTOM_SECRET".to_string());
        settings.providers[0].base_url_env = Some("PROVIDER_A_ENDPOINT".to_string());
        settings.providers[0].base_url = None;
        settings.providers.push(provider_b);
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([
                (
                    "provider-deepseek-existing".to_string(),
                    "selected-secret-a".to_string(),
                ),
                ("provider-b".to_string(), "other-secret-b".to_string()),
            ])),
            ..Default::default()
        };

        let selected = credential_override_with_store(
            directory.path(),
            &settings,
            "provider-deepseek-existing",
            &store,
            "credential_test_read",
        )
        .unwrap()
        .unwrap();
        assert_eq!(selected.1, "selected-secret-a");
        assert_eq!(
            store.get_calls.lock().unwrap().as_slice(),
            &["provider-deepseek-existing"]
        );
        assert_eq!(
            provider_probe_environment_names(&settings),
            vec![
                "PROVIDER_A_CUSTOM_SECRET",
                "PROVIDER_A_ENDPOINT",
                "PROVIDER_B_CUSTOM_SECRET",
                "PROVIDER_B_ENDPOINT",
            ]
        );
    }

    #[test]
    fn production_connection_test_isolates_selected_provider_in_child() {
        let data_dir = TempDir::new().unwrap();
        let fixture_dir = TempDir::new().unwrap();
        let evidence_path = fixture_dir.path().join("production-environment.txt");
        let response_path = fixture_dir.path().join("production-response.json");
        let calls_path = fixture_dir.path().join("credential-calls.json");
        std::fs::write(
            &response_path,
            serde_json::to_vec(&serde_json::json!({
                "status": "ready",
                "credential_status": "detected",
                "model_resolved": true,
                "latency_ms": 5,
                "capabilities": {
                    "tool_calling": "yes",
                    "reasoning": "unknown",
                    "vision_input": "no",
                    "source": "probe"
                },
                "message": "untrusted child success message",
                "error_class": null
            }))
            .unwrap(),
        )
        .unwrap();

        #[cfg(unix)]
        let rscript_path = {
            use std::os::unix::fs::PermissionsExt;
            let path = fixture_dir.path().join("fake-rscript");
            std::fs::write(
                &path,
                r#"#!/bin/sh
{
  printf 'selected_key=%s\n' "${PROVIDER_A_CUSTOM_SECRET-unset}"
  printf 'selected_endpoint=%s\n' "${PROVIDER_A_ENDPOINT-unset}"
  printf 'other_key=%s\n' "${PROVIDER_B_CUSTOM_SECRET-unset}"
  printf 'other_endpoint=%s\n' "${PROVIDER_B_ENDPOINT-unset}"
  printf 'common_secret=%s\n' "${GITHUB_TOKEN-unset}"
} >> "$RHO_PRODUCTION_EVIDENCE"
cat -- "$RHO_PRODUCTION_RESPONSE"
"#,
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).unwrap();
            path
        };
        #[cfg(windows)]
        let rscript_path = {
            let path = fixture_dir.path().join("fake-rscript.cmd");
            std::fs::write(
                &path,
                "@echo off\r\n(\r\necho selected_key=%PROVIDER_A_CUSTOM_SECRET%\r\necho selected_endpoint=%PROVIDER_A_ENDPOINT%\r\necho other_key=%PROVIDER_B_CUSTOM_SECRET%\r\necho other_endpoint=%PROVIDER_B_ENDPOINT%\r\necho common_secret=%GITHUB_TOKEN%\r\n)>>\"%RHO_PRODUCTION_EVIDENCE%\"\r\ntype \"%RHO_PRODUCTION_RESPONSE%\"\r\n",
            )
            .unwrap();
            path
        };

        let mut settings = default_settings();
        settings.providers[0].id = "provider-a".to_string();
        settings.providers[0].api_key_env = Some("PROVIDER_A_CUSTOM_SECRET".to_string());
        settings.providers[0].base_url = None;
        settings.providers[0].base_url_env = Some("PROVIDER_A_ENDPOINT".to_string());
        for model in &mut settings.models {
            model.provider_id = "provider-a".to_string();
        }
        let mut provider_b = settings.providers[0].clone();
        provider_b.id = "provider-b".to_string();
        provider_b.api_key_env = Some("PROVIDER_B_CUSTOM_SECRET".to_string());
        provider_b.base_url_env = Some("PROVIDER_B_ENDPOINT".to_string());
        settings.providers.push(provider_b);
        save_settings(data_dir.path(), &settings).unwrap();

        let mut fixture = probe_fixture_command("production_connection_test", "unused");
        fixture.env("RHO_PRODUCTION_DATA_DIR", data_dir.path());
        fixture.env("RHO_PRODUCTION_RSCRIPT", &rscript_path);
        fixture.env("RHO_PRODUCTION_CALLS", &calls_path);
        fixture.env("RHO_PRODUCTION_EVIDENCE", &evidence_path);
        fixture.env("RHO_PRODUCTION_RESPONSE", &response_path);
        fixture.env(
            "PROVIDER_A_CUSTOM_SECRET",
            "rho-inherited-selected-credential-must-be-replaced",
        );
        fixture.env(
            "PROVIDER_A_ENDPOINT",
            "https://selected-provider.example.test",
        );
        fixture.env(
            "PROVIDER_B_CUSTOM_SECRET",
            "rho-inherited-other-credential-must-be-removed",
        );
        fixture.env("PROVIDER_B_ENDPOINT", "https://other-provider.example.test");
        fixture.env(
            "GITHUB_TOKEN",
            "rho-inherited-common-secret-must-be-removed",
        );
        let output = fixture.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );

        let evidence = std::fs::read_to_string(evidence_path).unwrap();
        assert!(evidence.contains("selected_key=rho-selected-credential-production-fixture\n"));
        assert!(evidence.contains("selected_endpoint=https://selected-provider.example.test\n"));
        for forbidden in [
            "rho-inherited-selected-credential-must-be-replaced",
            "rho-inherited-other-credential-must-be-removed",
            "rho-other-credential-production-fixture",
            "https://other-provider.example.test",
            "rho-inherited-common-secret-must-be-removed",
        ] {
            assert!(!evidence.contains(forbidden));
        }
        let calls: Vec<String> =
            serde_json::from_slice(&std::fs::read(calls_path).unwrap()).unwrap();
        assert_eq!(calls, vec!["provider-a"]);
    }

    #[test]
    fn probe_failure_clears_test_control_and_allows_retry() {
        let control = AgentModelTestControl::default();
        let payload = "x".repeat(2 * 1024 * 1024);
        let first = run_r_json_command::<serde_json::Value>(
            probe_fixture_command("exit_before_stdin", "unused"),
            Some(payload),
            RProbeFailureDisclosure::SuppressDiagnostic,
            Some(&control),
        );
        assert!(first.is_err());
        {
            let state = control.lock().unwrap();
            assert!(state.pid.is_none());
            assert!(!state.cancel_requested);
        }
        assert_probe_retry_succeeds(&control);
    }

    #[test]
    fn injected_post_spawn_faults_reap_tree_clear_control_and_allow_retry() {
        for fault in [
            InjectedRProbeFault::AfterSpawn,
            InjectedRProbeFault::AfterPipeSetup,
            InjectedRProbeFault::Reader,
            InjectedRProbeFault::TryWait,
            InjectedRProbeFault::Wait,
        ] {
            let control = AgentModelTestControl::default();
            let timeout = if fault == InjectedRProbeFault::Wait {
                Some(Duration::from_millis(100))
            } else {
                Some(Duration::from_secs(1))
            };
            let spawned_pid = Arc::new(AtomicU32::new(0));
            let started = Instant::now();
            let error = run_r_json_command_with_fault::<serde_json::Value>(
                probe_fixture_command("sleep", "unused"),
                None,
                RProbeFailureDisclosure::SuppressDiagnostic,
                Some(&control),
                timeout,
                fault,
                Arc::clone(&spawned_pid),
            )
            .unwrap_err()
            .to_string();
            assert_eq!(error, CONNECTION_TEST_PROCESS_FAILURE, "fault={fault:?}");
            assert!(started.elapsed() < R_PROBE_PIPE_JOIN_TIMEOUT);
            let spawned_pid = spawned_pid.load(Ordering::SeqCst);
            assert_ne!(spawned_pid, 0, "fault={fault:?}");
            assert_process_terminated(spawned_pid, &format!("fault={fault:?}"));
            {
                let state = control.lock().unwrap();
                assert!(state.pid.is_none(), "fault={fault:?}");
                assert!(!state.cancel_requested, "fault={fault:?}");
            }

            assert_probe_retry_succeeds(&control);
        }
    }

    #[test]
    fn post_spawn_test_control_lock_failure_reaps_child_and_allows_retry() {
        let poisoned_control = AgentModelTestControl::default();
        let poison_target = Arc::clone(&poisoned_control);
        let poison_result = std::panic::catch_unwind(move || {
            let _guard = poison_target.lock().unwrap();
            panic!("poison test control");
        });
        assert!(poison_result.is_err());

        let spawned_pid = Arc::new(AtomicU32::new(0));
        let error = run_r_json_command_with_fault::<serde_json::Value>(
            probe_fixture_command("sleep", "unused"),
            None,
            RProbeFailureDisclosure::SuppressDiagnostic,
            Some(&poisoned_control),
            Some(Duration::from_secs(1)),
            InjectedRProbeFault::AfterSpawn,
            Arc::clone(&spawned_pid),
        )
        .unwrap_err()
        .to_string();
        assert_eq!(error, CONNECTION_TEST_PROCESS_FAILURE);
        let spawned_pid = spawned_pid.load(Ordering::SeqCst);
        assert_ne!(spawned_pid, 0);
        assert_process_terminated(spawned_pid, "post-spawn control-lock failure");
        let state = poisoned_control.lock().unwrap();
        assert!(state.pid.is_none());
        assert!(!state.cancel_requested);
        drop(state);

        assert_probe_retry_succeeds(&poisoned_control);
    }

    #[test]
    fn probe_timeout_reaps_child_clears_control_and_uses_fixed_copy() {
        let control = AgentModelTestControl::default();
        let error = run_r_json_command_with_timeout::<serde_json::Value>(
            probe_fixture_command("sleep", "unused"),
            None,
            RProbeFailureDisclosure::SuppressDiagnostic,
            Some(&control),
            Some(Duration::from_millis(100)),
        )
        .unwrap_err()
        .to_string();
        assert_eq!(error, "The Provider connection test timed out.");
        let state = control.lock().unwrap();
        assert!(state.pid.is_none());
        assert!(!state.cancel_requested);
    }

    #[test]
    fn probe_cancellation_reaps_child_clears_control_and_allows_retry() {
        let control = AgentModelTestControl::default();
        let worker_control = Arc::clone(&control);
        let worker = std::thread::spawn(move || {
            run_r_json_command::<serde_json::Value>(
                probe_fixture_command("sleep", "unused"),
                None,
                RProbeFailureDisclosure::SuppressDiagnostic,
                Some(&worker_control),
            )
            .unwrap_err()
            .to_string()
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while control.lock().unwrap().pid.is_none() {
            assert!(Instant::now() < deadline, "probe child did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(cancel_test(&control).unwrap());
        assert_eq!(worker.join().unwrap(), "Agent model test cancelled.");
        {
            let state = control.lock().unwrap();
            assert!(state.pid.is_none());
            assert!(!state.cancel_requested);
        }
        assert_probe_retry_succeeds(&control);
    }

    #[test]
    fn fatal_connection_probe_preserves_settings_bytes_and_revision() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        settings.providers[0].api_key_required = false;
        settings.models[0].last_test = Some(AgentModelTestResult {
            status: "ready".to_string(),
            checked_at: "2026-08-26T00:00:00Z".to_string(),
            latency_ms: Some(11),
            error_class: None,
            message: Some("Previous result remains authoritative.".to_string()),
        });
        save_settings(directory.path(), &settings).unwrap();
        let before = std::fs::read(settings_path(directory.path())).unwrap();
        let revision = settings.revision;

        let error = test_model(
            directory.path(),
            &std::env::current_exe().unwrap(),
            Path::new("/unused/rho.agent"),
            "model-deepseek-v4-flash",
            None,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(error, CONNECTION_TEST_PROCESS_FAILURE);
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            before
        );
        assert_eq!(load_settings(directory.path()).unwrap().revision, revision);
        assert_eq!(
            load_settings(directory.path()).unwrap().models[0]
                .last_test
                .as_ref()
                .unwrap()
                .message
                .as_deref(),
            Some("Previous result remains authoritative.")
        );
    }

    #[test]
    fn missing_credential_is_resolved_before_child_launch() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        let provider_id = "provider-missing-before-probe";
        settings.providers[0].id = provider_id.to_string();
        settings.providers[0].credential_source = CREDENTIAL_SOURCE_SESSION_ONLY.to_string();
        for model in &mut settings.models {
            model.provider_id = provider_id.to_string();
        }
        settings.models[0].last_test = Some(AgentModelTestResult {
            status: "ready".to_string(),
            checked_at: "2026-08-26T00:00:00Z".to_string(),
            latency_ms: Some(11),
            error_class: None,
            message: Some("Previous result remains authoritative.".to_string()),
        });
        save_settings(directory.path(), &settings).unwrap();
        let before = std::fs::read(settings_path(directory.path())).unwrap();
        let revision = settings.revision;

        let error = test_model(
            directory.path(),
            Path::new("/definitely/missing/rscript"),
            Path::new("/unused/rho.agent"),
            "model-deepseek-v4-flash",
            None,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(error, "No API key is available for this provider.");
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            before
        );
        let after = load_settings(directory.path()).unwrap();
        assert_eq!(after.revision, revision);
        assert_eq!(
            after.models[0]
                .last_test
                .as_ref()
                .unwrap()
                .message
                .as_deref(),
            Some("Previous result remains authoritative.")
        );
    }

    #[test]
    fn unknown_model_and_credential_source_failure_reject_before_child_launch() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        let provider_id = "provider-source-failure-no-fallback";
        let fallback_sentinel = "rho-session-fallback-must-not-be-read";
        settings.providers[0].id = provider_id.to_string();
        for model in &mut settings.models {
            model.provider_id = provider_id.to_string();
        }
        settings.models[0].last_test = Some(AgentModelTestResult {
            status: "ready".to_string(),
            checked_at: "2026-08-26T00:00:00Z".to_string(),
            latency_ms: Some(13),
            error_class: None,
            message: Some("Previous result remains authoritative.".to_string()),
        });
        save_settings(directory.path(), &settings).unwrap();
        let before = std::fs::read(settings_path(directory.path())).unwrap();
        let revision = settings.revision;
        credential_session().set_session_credential(provider_id, fallback_sentinel);
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-not-selected".to_string(),
                "unread-other-provider-value".to_string(),
            )])),
            fail_get: true,
            ..Default::default()
        };

        let unknown = test_model_with_store(
            directory.path(),
            Path::new("/definitely/missing/rscript"),
            Path::new("/unused/rho.agent"),
            "model-not-configured",
            None,
            &store,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(unknown, "Unknown model: model-not-configured");
        assert!(store.get_calls.lock().unwrap().is_empty());

        let unavailable = test_model_with_store(
            directory.path(),
            Path::new("/definitely/missing/rscript"),
            Path::new("/unused/rho.agent"),
            "model-deepseek-v4-flash",
            None,
            &store,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            unavailable,
            "The configured credential source is unavailable."
        );
        assert_eq!(store.get_calls.lock().unwrap().as_slice(), &[provider_id]);
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            before
        );
        let after = load_settings(directory.path()).unwrap();
        assert_eq!(after.revision, revision);
        assert_eq!(
            after.models[0]
                .last_test
                .as_ref()
                .unwrap()
                .message
                .as_deref(),
            Some("Previous result remains authoritative.")
        );
        let audit = std::fs::read_to_string(credential_audit_path(directory.path())).unwrap();
        assert!(!audit.contains(fallback_sentinel));
        credential_session().clear_session_credential(provider_id);
    }

    #[test]
    fn unknown_and_unsupported_discovery_preserve_authority() {
        let directory = TempDir::new().unwrap();
        save_settings(directory.path(), &default_settings()).unwrap();
        let store = store_with_discovery_secret("secret");
        assert!(
            discover_models_with_store(
                directory.path(),
                "unknown-provider",
                &store,
                &model_discovery_client().unwrap(),
            )
            .is_err()
        );

        let mut settings = default_settings();
        settings.providers[0].registered_provider_id = Some("unlisted-provider".to_string());
        save_settings(directory.path(), &settings).unwrap();
        let response = discover_models_with_store(
            directory.path(),
            "provider-deepseek-existing",
            &store,
            &model_discovery_client().unwrap(),
        )
        .unwrap();
        assert_eq!(response.status, "unsupported");
        assert!(response.models.is_empty());
    }

    #[test]
    fn catalog_enrichment_requires_an_exact_provider_and_model_match() {
        let mut settings = default_settings();
        let provider = settings.providers.remove(0);
        let mut models = vec![
            AgentDiscoveredModel {
                id: "deepseek-v4-flash".to_string(),
                display_name: "DeepSeek V4 Flash".to_string(),
                model_type: capability_value("unknown", "unknown"),
                capabilities: unknown_capabilities(),
            },
            AgentDiscoveredModel {
                id: "unlisted-model".to_string(),
                display_name: "Unlisted".to_string(),
                model_type: capability_value("unknown", "unknown"),
                capabilities: unknown_capabilities(),
            },
        ];
        let mut catalog_capabilities = unknown_capabilities();
        catalog_capabilities.insert(
            "function_call".to_string(),
            capability_value("yes", "aisdk_catalog"),
        );
        let entries = vec![AgentCatalogEntry {
            provider: "deepseek".to_string(),
            id: "deepseek-v4-flash".to_string(),
            display_name: "DeepSeek V4 Flash".to_string(),
            description: None,
            model_type: capability_value("language", "aisdk_catalog"),
            capabilities: catalog_capabilities,
            context_window_tokens: Some(131_072),
            max_output_tokens: Some(8_192),
        }];

        enrich_discovered_models(&provider, &mut models, &entries);
        assert_eq!(models[0].model_type.value, "language");
        // The catalog capacity fields stay presentation-only for configured
        // models; discovery enrichment only projects type/capability evidence.
        assert_eq!(
            models[0].capabilities["function_call"].source,
            "aisdk_catalog"
        );
        assert_eq!(models[1].model_type.value, "unknown");
        assert!(
            models[1]
                .capabilities
                .values()
                .all(|capability| capability.source == "unknown")
        );
    }

    #[test]
    fn text_connection_test_rejects_non_language_models_before_probe() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        let mut image_model = settings.models[0].clone();
        image_model.id = "model-image".to_string();
        image_model.model_id = "image-model".to_string();
        image_model.display_name = "Image model".to_string();
        image_model.model_type = capability_value("image", "user_declared");
        image_model.capabilities = unknown_capabilities();
        settings.models.push(image_model);
        save_settings(directory.path(), &settings).unwrap();

        let error = test_model(
            directory.path(),
            Path::new("/missing/Rscript"),
            Path::new("/missing/rho.agent"),
            "model-image",
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("Only language models"));
    }

    #[test]
    fn agent_probes_always_ignore_user_environ() {
        let mut command = Command::new("Rscript");
        configure_r_probe(
            &mut command,
            Some("C:/Users/test/.Renviron"),
            &[],
            Vec::<OsString>::new(),
            &[],
        );
        assert!(command.get_args().any(|value| value == "--vanilla"));
        assert!(
            command
                .get_envs()
                .find(|(name, _)| *name == "R_ENVIRON_USER")
                .is_none()
        );
    }

    #[test]
    fn environment_free_probes_remain_vanilla() {
        let mut command = Command::new("Rscript");
        configure_r_probe(&mut command, None, &[], Vec::<OsString>::new(), &[]);
        assert!(command.get_args().any(|value| value == "--vanilla"));
    }

    #[test]
    fn writes_agent_probe_code_to_a_utf8_r_script() {
        let script_text = "cat('Agent UTF-8: 中文')\n";
        let script = write_r_probe_script(script_text).unwrap();
        assert_eq!(
            script.path().extension().and_then(|value| value.to_str()),
            Some("R")
        );
        assert_eq!(std::fs::read_to_string(script.path()).unwrap(), script_text);
    }

    #[test]
    fn resolves_requested_model_without_fallback() {
        let settings = default_settings();
        let resolved =
            resolve_model_with_settings(&settings, Some("model-deepseek-v4-flash")).unwrap();
        assert_eq!(resolved.effective_model_ref, "deepseek:deepseek-v4-flash");
        assert_eq!(resolved.runtime_profile.tool_calling, "yes");
    }

    fn legacy_v3_settings_bytes() -> Vec<u8> {
        let settings = default_settings();
        serde_json::to_vec_pretty(&AgentLlmSettingsV3 {
            schema_version: 3,
            revision: settings.revision,
            providers: legacy_v3_providers(),
            models: settings.models,
            capability_routes: settings.capability_routes,
        })
        .unwrap()
    }

    #[test]
    fn v3_credential_source_migration_defaults_to_system_store_with_backup() {
        let directory = TempDir::new().unwrap();
        let legacy = legacy_v3_settings_bytes();
        std::fs::write(settings_path(directory.path()), &legacy).unwrap();

        // A read-only open migrates in memory without rewriting the source.
        let loaded = load_settings(directory.path()).unwrap();
        assert_eq!(loaded.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(
            loaded.providers[0].credential_source,
            CREDENTIAL_SOURCE_RHO_VAULT
        );
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            legacy
        );
        assert!(!settings_v3_backup_path(directory.path()).exists());

        // The first explicit mutation writes a byte-identical V3 backup.
        let provider = loaded.providers[0].clone();
        let saved = save_provider(directory.path(), provider).unwrap();
        assert_eq!(saved.revision, loaded.revision + 1);
        assert_eq!(
            std::fs::read(settings_v3_backup_path(directory.path())).unwrap(),
            legacy
        );
        let on_disk = load_settings(directory.path()).unwrap();
        assert_eq!(on_disk.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(
            on_disk.providers[0].credential_source,
            CREDENTIAL_SOURCE_RHO_VAULT
        );
    }

    #[test]
    fn v4_settings_migrates_system_store_to_rho_vault_with_byte_identical_backup() {
        let directory = TempDir::new().unwrap();
        let mut settings = default_settings();
        settings.providers[0].credential_source = LEGACY_CREDENTIAL_SOURCE_SYSTEM_STORE.to_string();
        let mut environment_provider = settings.providers[0].clone();
        environment_provider.id = "provider-env".to_string();
        environment_provider.display_name = "Environment Provider".to_string();
        environment_provider.credential_source = CREDENTIAL_SOURCE_ENVIRONMENT.to_string();
        let mut session_provider = settings.providers[0].clone();
        session_provider.id = "provider-session".to_string();
        session_provider.display_name = "Session Provider".to_string();
        session_provider.credential_source = CREDENTIAL_SOURCE_SESSION_ONLY.to_string();
        settings.providers.push(environment_provider);
        settings.providers.push(session_provider);
        let legacy = serde_json::to_vec_pretty(&AgentLlmSettingsV4 {
            schema_version: 4,
            revision: settings.revision,
            providers: settings.providers,
            models: settings.models,
            capability_routes: settings.capability_routes,
        })
        .unwrap();
        std::fs::write(settings_path(directory.path()), &legacy).unwrap();

        let loaded = load_settings(directory.path()).unwrap();
        assert_eq!(loaded.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(
            loaded
                .providers
                .iter()
                .map(|provider| provider.credential_source.as_str())
                .collect::<Vec<_>>(),
            [
                CREDENTIAL_SOURCE_RHO_VAULT,
                CREDENTIAL_SOURCE_ENVIRONMENT,
                CREDENTIAL_SOURCE_SESSION_ONLY
            ]
        );
        assert_eq!(
            std::fs::read(settings_path(directory.path())).unwrap(),
            legacy
        );
        assert!(!settings_v4_backup_path(directory.path()).exists());

        let saved = save_provider(directory.path(), loaded.providers[0].clone()).unwrap();
        assert_eq!(saved.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(
            std::fs::read(settings_v4_backup_path(directory.path())).unwrap(),
            legacy
        );
    }

    #[test]
    fn unsupported_or_platform_gated_credential_sources_are_rejected() {
        let mut settings = default_settings();
        settings.providers[0].credential_source = "plaintext_file".to_string();
        assert!(validate_settings(&settings).is_err());

        let mut settings = default_settings();
        settings.providers[0].credential_source =
            LEGACY_CREDENTIAL_SOURCE_FILE_FALLBACK.to_string();
        assert!(validate_settings(&settings).is_err());

        let mut settings = default_settings();
        settings.providers[0].credential_source = CREDENTIAL_SOURCE_ENVIRONMENT.to_string();
        settings.providers[0].api_key_env = None;
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn environment_source_resolves_process_environment_without_touching_stores() {
        let directory = TempDir::new().unwrap();
        let variable = "RHO_TEST_CRED_SEC1_ENVIRONMENT_KEY";
        let mut settings = default_settings();
        settings.providers[0].credential_source = CREDENTIAL_SOURCE_ENVIRONMENT.to_string();
        settings.providers[0].api_key_env = Some(variable.to_string());
        save_settings(directory.path(), &settings).unwrap();
        let store = MemoryCredentialStore::default();

        unsafe { std::env::remove_var(variable) };
        let resolved = resolve_model_with_settings(&settings, None).unwrap();
        let missing = credential_override_with_store(
            directory.path(),
            &settings,
            &resolved.provider_id,
            &store,
            "credential_test_read",
        )
        .unwrap();
        assert!(missing.is_none());
        let statuses = credential_status_map(directory.path(), &settings.providers);
        assert_eq!(
            statuses["provider-deepseek-existing"].status,
            "not_detected"
        );
        assert_eq!(statuses["provider-deepseek-existing"].source, "environment");

        unsafe { std::env::set_var(variable, "env-secret") };
        let detected = credential_override_with_store(
            directory.path(),
            &settings,
            &resolved.provider_id,
            &store,
            "credential_test_read",
        )
        .unwrap();
        assert_eq!(
            detected
                .as_ref()
                .map(|(name, value)| (name.as_str(), value.as_str())),
            Some((variable, "env-secret"))
        );
        let statuses = credential_status_map(directory.path(), &settings.providers);
        assert_eq!(statuses["provider-deepseek-existing"].status, "detected");
        assert_eq!(statuses["provider-deepseek-existing"].source, "environment");
        unsafe { std::env::remove_var(variable) };

        // The environment source never touches the system store or cache.
        assert!(store.get_calls.lock().unwrap().is_empty());
        assert!(store.set_calls.lock().unwrap().is_empty());

        // Environment-managed credentials reject set/delete in Rho.
        assert!(
            set_credential_with_store(
                directory.path(),
                "provider-deepseek-existing",
                "secret",
                false,
                &store,
            )
            .is_err()
        );
        assert!(
            delete_credential_with_store(directory.path(), "provider-deepseek-existing", &store)
                .is_err()
        );
        assert!(store.set_calls.lock().unwrap().is_empty());
        assert!(store.delete_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn session_only_credentials_never_touch_durable_stores() {
        let directory = TempDir::new().unwrap();
        let provider_id = "provider-session-only-test";
        let mut settings = default_settings();
        let mut provider = settings.providers[0].clone();
        provider.id = provider_id.to_string();
        provider.display_name = "Session Only Provider".to_string();
        provider.credential_source = CREDENTIAL_SOURCE_SESSION_ONLY.to_string();
        settings.providers.push(provider);
        save_settings(directory.path(), &settings).unwrap();
        let store = MemoryCredentialStore::default();

        set_credential_with_store(
            directory.path(),
            provider_id,
            "session-secret",
            false,
            &store,
        )
        .unwrap();
        assert!(store.set_calls.lock().unwrap().is_empty());
        assert!(store.get_calls.lock().unwrap().is_empty());

        let resolved = resolve_provider_credential(
            directory.path(),
            settings.providers.last().unwrap(),
            &store,
        )
        .unwrap();
        assert_eq!(resolved.as_deref(), Some("session-secret"));
        let statuses = credential_status_map(directory.path(), &settings.providers);
        assert_eq!(statuses[provider_id].status, "detected");
        assert_eq!(statuses[provider_id].source, "session");
        assert!(store.get_calls.lock().unwrap().is_empty());

        // Refreshing presentation state must not wipe session-only
        // credentials; only explicit delete or app shutdown removes them.
        refresh_credentials_view(directory.path(), Path::new("unused-rscript")).unwrap();
        let statuses = credential_status_map(directory.path(), &settings.providers);
        assert_eq!(statuses[provider_id].status, "detected");
        assert_eq!(statuses[provider_id].source, "session");

        delete_credential_with_store(directory.path(), provider_id, &store).unwrap();
        assert!(store.delete_calls.lock().unwrap().is_empty());
        let statuses = credential_status_map(directory.path(), &settings.providers);
        assert_eq!(statuses[provider_id].status, "not_detected");
    }

    #[test]
    fn credential_entry_validation_rejects_control_characters_and_enforces_caps() {
        let directory = TempDir::new().unwrap();
        save_settings(directory.path(), &default_settings()).unwrap();
        let store = MemoryCredentialStore::default();
        for bad in [
            "sk-abc\n123",
            "sk-abc\r\n123",
            "sk-abc\t123",
            "sk-ab\u{0}cd",
        ] {
            assert!(
                set_credential_with_store(
                    directory.path(),
                    "provider-deepseek-existing",
                    bad,
                    false,
                    &store,
                )
                .is_err(),
                "control-character credential must be rejected"
            );
        }
        set_credential_with_store(
            directory.path(),
            "provider-deepseek-existing",
            &"x".repeat(MAX_CREDENTIAL_BYTES),
            false,
            &store,
        )
        .unwrap();
        assert!(
            store
                .entries
                .lock()
                .unwrap()
                .contains_key("provider-deepseek-existing")
        );
        delete_credential_with_store(directory.path(), "provider-deepseek-existing", &store)
            .unwrap();
    }

    #[test]
    fn credential_audit_records_redacted_events_and_stays_bounded() {
        let directory = TempDir::new().unwrap();
        save_settings(directory.path(), &default_settings()).unwrap();
        let store = MemoryCredentialStore::default();
        let secret = "audit-sentinel-secret-value";
        set_credential_with_store(
            directory.path(),
            "provider-deepseek-existing",
            secret,
            false,
            &store,
        )
        .unwrap();
        delete_credential_with_store(directory.path(), "provider-deepseek-existing", &store)
            .unwrap();

        let log = std::fs::read_to_string(credential_audit_path(directory.path())).unwrap();
        assert!(!log.contains(secret));
        let events = log
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event"], "credential_set");
        assert_eq!(events[0]["credential_source"], "rho_vault");
        assert_eq!(events[0]["outcome"], "ok");
        assert_eq!(events[0]["provider_id"], "provider-deepseek-existing");
        assert!(events[0]["recorded_at"].is_string());
        assert_eq!(events[1]["event"], "credential_delete");

        // The log stays within its byte budget and keeps parseable lines.
        for _ in 0..400 {
            record_credential_audit(
                directory.path(),
                "credential_turn_inject",
                "provider-deepseek-existing",
                "rho_vault",
                "detected",
                None,
            );
        }
        let bytes = std::fs::read(credential_audit_path(directory.path())).unwrap();
        assert!(bytes.len() <= MAX_CREDENTIAL_AUDIT_BYTES);
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            text.lines()
                .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok())
        );
        assert!(!text.contains(secret));
    }
}
