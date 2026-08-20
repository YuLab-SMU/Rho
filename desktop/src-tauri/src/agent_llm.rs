use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use chrono::Utc;
use rho_server::coordinator::{AgentRuntimeCapabilityRoute, AgentRuntimeModelProfile};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::project::atomic_write;

const SETTINGS_FILE_NAME: &str = "llm-profiles.json";
const SETTINGS_V1_BACKUP_FILE_NAME: &str = "llm-profiles.v1.backup.json";
const SETTINGS_SCHEMA_VERSION: u32 = 2;
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
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
const CREDENTIAL_SERVICE: &str = "Rho Agent LLM";
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;

static SETTINGS_MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SYSTEM_CREDENTIAL_OBSERVATIONS: OnceLock<Mutex<HashMap<String, CredentialObservation>>> =
    OnceLock::new();
static SYSTEM_CREDENTIAL_SESSION: OnceLock<SessionCredentialCache> = OnceLock::new();

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

#[derive(Debug, Default, Clone, Copy)]
struct SystemCredentialStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialObservation {
    Detected,
    NotDetected,
    Unavailable,
}

#[derive(Default)]
struct SessionCredentialCache {
    entries: Mutex<HashMap<String, Option<Zeroizing<String>>>>,
}

impl SessionCredentialCache {
    fn get_or_load<F>(&self, provider_id: &str, load: F) -> Result<Option<String>>
    where
        F: FnOnce() -> Result<Option<String>>,
    {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = entries.get(provider_id) {
            return Ok(cached
                .as_ref()
                .map(|credential| credential.as_str().to_string()));
        }
        let loaded = load()?;
        entries.insert(
            provider_id.to_string(),
            loaded
                .as_ref()
                .map(|credential| Zeroizing::new(credential.clone())),
        );
        Ok(loaded)
    }

    fn set(&self, provider_id: &str, credential: &str) {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                provider_id.to_string(),
                Some(Zeroizing::new(credential.to_string())),
            );
    }

    fn mark_missing(&self, provider_id: &str) {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(provider_id.to_string(), None);
    }

    fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }
}

fn system_credential_session() -> &'static SessionCredentialCache {
    SYSTEM_CREDENTIAL_SESSION.get_or_init(SessionCredentialCache::default)
}

fn system_credential_observations() -> &'static Mutex<HashMap<String, CredentialObservation>> {
    SYSTEM_CREDENTIAL_OBSERVATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_system_credential_observation(provider_id: &str, observation: CredentialObservation) {
    system_credential_observations()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(provider_id.to_string(), observation);
}

fn current_system_credential_observations() -> HashMap<String, CredentialObservation> {
    system_credential_observations()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn clear_system_credential_session() {
    system_credential_session().clear();
    system_credential_observations()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
}

impl CredentialStore for SystemCredentialStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>> {
        let result = system_credential_session()
            .get_or_load(provider_id, || system_credential_get(provider_id));
        record_system_credential_observation(
            provider_id,
            match &result {
                Ok(Some(_)) => CredentialObservation::Detected,
                Ok(None) => CredentialObservation::NotDetected,
                Err(_) => CredentialObservation::Unavailable,
            },
        );
        result
    }

    fn set(&self, provider_id: &str, credential: &str) -> Result<()> {
        let result = system_credential_set(provider_id, credential);
        if result.is_ok() {
            system_credential_session().set(provider_id, credential);
            record_system_credential_observation(provider_id, CredentialObservation::Detected);
        }
        result
    }

    fn delete(&self, provider_id: &str) -> Result<()> {
        let result = system_credential_delete(provider_id);
        if result.is_ok() {
            system_credential_session().mark_missing(provider_id);
            record_system_credential_observation(provider_id, CredentialObservation::NotDetected);
        }
        result
    }
}

#[cfg(windows)]
const SYSTEM_CREDENTIAL_STORE_LABEL: &str = "Windows Credential Manager";
#[cfg(target_os = "macos")]
const SYSTEM_CREDENTIAL_STORE_LABEL: &str = "macOS Keychain";
#[cfg(target_os = "linux")]
const SYSTEM_CREDENTIAL_STORE_LABEL: &str = "Linux Secret Service";

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn system_credential_entry_for_service(service: &str, provider_id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, provider_id)
        .with_context(|| format!("opening {SYSTEM_CREDENTIAL_STORE_LABEL}"))
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn keyring_credential_get(service: &str, provider_id: &str) -> Result<Option<String>> {
    match system_credential_entry_for_service(service, provider_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(anyhow::anyhow!(
            "reading {SYSTEM_CREDENTIAL_STORE_LABEL}: {error}"
        )),
    }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn keyring_credential_set(service: &str, provider_id: &str, credential: &str) -> Result<()> {
    system_credential_entry_for_service(service, provider_id)?
        .set_password(credential)
        .with_context(|| format!("saving the API key in {SYSTEM_CREDENTIAL_STORE_LABEL}"))
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn keyring_credential_delete(service: &str, provider_id: &str) -> Result<()> {
    match system_credential_entry_for_service(service, provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(anyhow::anyhow!(
            "deleting the API key from {SYSTEM_CREDENTIAL_STORE_LABEL}: {error}"
        )),
    }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn system_credential_get(provider_id: &str) -> Result<Option<String>> {
    keyring_credential_get(CREDENTIAL_SERVICE, provider_id)
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn system_credential_set(provider_id: &str, credential: &str) -> Result<()> {
    keyring_credential_set(CREDENTIAL_SERVICE, provider_id, credential)
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn system_credential_delete(provider_id: &str) -> Result<()> {
    keyring_credential_delete(CREDENTIAL_SERVICE, provider_id)
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn system_credential_get(_provider_id: &str) -> Result<Option<String>> {
    bail!("System credential storage is unavailable on this platform.")
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn system_credential_set(_provider_id: &str, _credential: &str) -> Result<()> {
    bail!("System credential storage is unavailable on this platform.")
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn system_credential_delete(_provider_id: &str) -> Result<()> {
    bail!("System credential storage is unavailable on this platform.")
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
    providers: Vec<AgentProviderProfile>,
    models: Vec<AgentModelProfileV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModelProfile {
    pub id: String,
    pub provider_id: String,
    pub display_name: String,
    pub model_id: String,
    pub enabled: bool,
    pub model_type: AgentCapabilityValue,
    pub capabilities: BTreeMap<String, AgentCapabilityValue>,
    pub last_test: Option<AgentModelTestResult>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModelTestResult {
    pub status: String,
    pub checked_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentCatalogEntry {
    pub provider: String,
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub model_type: AgentCapabilityValue,
    pub capabilities: BTreeMap<String, AgentCapabilityValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentDiscoveredModel {
    pub id: String,
    pub display_name: String,
    pub model_type: AgentCapabilityValue,
    pub capabilities: BTreeMap<String, AgentCapabilityValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModelDiscoveryResponse {
    pub status: String,
    pub provider_id: String,
    pub models: Vec<AgentDiscoveredModel>,
    pub truncated: bool,
    pub message: String,
    pub error_class: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentUserEnvironInfo {
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentProviderProfileView {
    #[serde(flatten)]
    pub profile: AgentProviderProfile,
    pub credential_status: String,
    pub credential_source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentModelProfileView {
    #[serde(flatten)]
    pub profile: AgentModelProfile,
    pub provider_display_name: String,
    pub selected: bool,
    pub selector_status: String,
    pub act_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct AgentSelectedModelView {
    pub id: String,
    pub display_name: String,
    pub provider_display_name: String,
    pub selector_status: String,
    pub tool_calling: String,
    pub act_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentLlmSettingsView {
    pub schema_version: u32,
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
    pub provider_id: String,
    pub provider_display_name: String,
    pub model_display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
        }],
        models: vec![AgentModelProfile {
            id: "model-deepseek-v4-flash".to_string(),
            provider_id: "provider-deepseek-existing".to_string(),
            display_name: "DeepSeek V4 Flash".to_string(),
            model_id: "deepseek-v4-flash".to_string(),
            enabled: true,
            model_type: capability_value("language", "aisdk_catalog"),
            capabilities,
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
        2 => serde_json::from_value(envelope)
            .with_context(|| format!("decoding V2 Agent LLM settings {}", path.display()))?,
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
        if version == 1 {
            let backup_path = settings_v1_backup_path(data_dir);
            if backup_path.exists() {
                let existing = std::fs::read(&backup_path).with_context(|| {
                    format!("reading Agent LLM V1 backup {}", backup_path.display())
                })?;
                ensure!(
                    existing == current,
                    "The existing Agent LLM V1 backup does not match the migration source."
                );
            } else {
                write(&backup_path, &current).with_context(|| {
                    format!("writing Agent LLM V1 backup {}", backup_path.display())
                })?;
            }
        } else {
            ensure!(version == 2, "Unsupported Agent LLM schema version.");
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
                last_test: model.last_test,
            }
        })
        .collect::<Vec<_>>();
    let settings = AgentLlmSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        revision: 0,
        providers: legacy.providers,
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

pub fn save_provider(data_dir: &Path, provider: AgentProviderProfile) -> Result<AgentLlmSettings> {
    let _guard = settings_mutation_guard();
    let mut settings = load_settings(data_dir)?;
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
    Ok(settings)
}

pub fn delete_provider(
    data_dir: &Path,
    request: &DeleteProviderRequest,
) -> Result<AgentLlmSettings> {
    delete_provider_with_store(data_dir, request, &SystemCredentialStore)
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
    let _guard = settings_mutation_guard();
    let mut settings = load_settings(data_dir)?;
    ensure!(
        settings.revision == request.expected_revision,
        "Model settings changed while this provider delete confirmation was open. Reload and review the updated impact."
    );
    let provider_id = request.provider_id.as_str();
    validate_bounded(provider_id, "Provider ID", MAX_ID_LENGTH)?;
    settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .with_context(|| format!("Unknown provider: {provider_id}"))?;
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
    let previous_credential = credential_store.get(provider_id)?;
    credential_store.delete(provider_id)?;
    if let Err(save_error) = save(data_dir, &settings) {
        let recovery = if let Some(credential) = previous_credential.as_deref() {
            if let Err(restore_error) = credential_store.set(provider_id, credential) {
                return Err(anyhow::anyhow!(
                    "Provider metadata could not be saved ({save_error:#}), and its system credential could not be restored ({restore_error:#})."
                ));
            }
            "Provider metadata could not be saved; its system credential was restored"
        } else {
            "Provider metadata could not be saved; no system credential needed restoration"
        };
        return Err(save_error.context(recovery));
    }
    Ok(settings)
}

pub fn set_credential(data_dir: &Path, provider_id: &str, credential: &str) -> Result<()> {
    set_credential_with_store(data_dir, provider_id, credential, &SystemCredentialStore)
}

fn set_credential_with_store(
    data_dir: &Path,
    provider_id: &str,
    credential: &str,
    credential_store: &impl CredentialStore,
) -> Result<()> {
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
    ensure!(!credential.is_empty(), "Enter an API key before saving.");
    ensure!(
        credential.len() <= MAX_CREDENTIAL_BYTES,
        "The API key exceeds the 16 KiB storage limit."
    );
    credential_store.set(provider_id, credential)
}

pub fn delete_credential(data_dir: &Path, provider_id: &str) -> Result<()> {
    delete_credential_with_store(data_dir, provider_id, &SystemCredentialStore)
}

fn delete_credential_with_store(
    data_dir: &Path,
    provider_id: &str,
    credential_store: &impl CredentialStore,
) -> Result<()> {
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
    credential_store.delete(provider_id)
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

pub fn settings_view(data_dir: &Path, _rscript: &Path) -> Result<AgentLlmSettingsView> {
    let _guard = settings_mutation_guard();
    let settings = load_settings(data_dir)?;
    settings_view_from_settings(settings)
}

pub fn settings_view_from_settings(settings: AgentLlmSettings) -> Result<AgentLlmSettingsView> {
    let observations = current_system_credential_observations();
    Ok(settings_view_from_settings_with_observations(
        settings,
        &observations,
    ))
}

fn settings_view_from_settings_with_observations(
    settings: AgentLlmSettings,
    observations: &HashMap<String, CredentialObservation>,
) -> AgentLlmSettingsView {
    let statuses = credential_status_map(&settings.providers, observations);
    build_settings_view(settings, system_credential_info(), statuses)
}

pub fn refresh_credentials_view(data_dir: &Path, rscript: &Path) -> Result<AgentLlmSettingsView> {
    clear_system_credential_session();
    settings_view(data_dir, rscript)
}

pub fn clear_session_credentials() {
    clear_system_credential_session();
}

pub fn catalog(rscript: &Path) -> Result<Vec<AgentCatalogEntry>> {
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
    )
  )
})
cat(jsonlite::toJSON(unname(rows), auto_unbox = TRUE, null = "null"))
"#;
    run_r_json(rscript, script, &[], None, None, None, None)
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

pub fn discover_models(
    data_dir: &Path,
    rscript: &Path,
    provider_id: &str,
) -> Result<AgentModelDiscoveryResponse> {
    let client = model_discovery_client()?;
    let mut response =
        discover_models_with_store(data_dir, provider_id, &SystemCredentialStore, &client)?;
    if response.status == "ready" && !response.models.is_empty() {
        let settings = load_settings(data_dir)?;
        if let Some(provider) = settings
            .providers
            .iter()
            .find(|item| item.id == provider_id)
        {
            if let Ok(entries) = catalog(rscript) {
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
    let provider_key = provider
        .registered_provider_id
        .as_deref()
        .unwrap_or(&provider.kind)
        .to_ascii_lowercase();
    for model in models {
        if let Some(entry) = entries.iter().find(|entry| {
            entry.provider.eq_ignore_ascii_case(&provider_key) && entry.id == model.id
        }) {
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
        match credential_store.get(provider_id) {
            Ok(Some(value)) => Some(value),
            Ok(None) => {
                return Ok(model_discovery_result(
                    provider_id,
                    "error",
                    Vec::new(),
                    false,
                    "No API key is stored for this provider. Save a key or enter a model ID manually.",
                    Some("credential"),
                ));
            }
            Err(_) => {
                return Ok(model_discovery_result(
                    provider_id,
                    "error",
                    Vec::new(),
                    false,
                    "The system credential store is unavailable. Retry or enter a model ID manually.",
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
    let credential_override =
        credential_override_with_store(&settings, &resolved.provider_id, &SystemCredentialStore);
    let result = match credential_override {
        Err(_) => AgentConnectionTestResponse {
            status: "error".to_string(),
            credential_status: "unavailable".to_string(),
            model_resolved: false,
            latency_ms: None,
            capabilities: inferred_capabilities(&resolved.runtime_profile),
            message: "The system credential store is unavailable.".to_string(),
            error_class: Some("credential".to_string()),
        },
        Ok(None) if resolved.runtime_profile.api_key_required => AgentConnectionTestResponse {
            status: "error".to_string(),
            credential_status: "not_detected".to_string(),
            model_resolved: false,
            latency_ms: None,
            capabilities: inferred_capabilities(&resolved.runtime_profile),
            message: "No API key is available for this provider.".to_string(),
            error_class: Some("credential".to_string()),
        },
        Ok(credential_override) => run_connection_test(
            rscript,
            agent_package,
            &resolved.runtime_profile,
            credential_override.as_ref(),
            test_control,
        )?,
    };
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
    settings_view_from_settings(latest_settings)
}

pub fn resolve_model_for_turn(
    data_dir: &Path,
    requested_model_id: Option<&str>,
    mode: &str,
) -> Result<ResolvedAgentModel> {
    let settings = load_settings(data_dir)?;
    resolve_model_for_turn_with_settings(&settings, requested_model_id, mode)
}

pub fn resolve_model_and_credential_for_turn(
    data_dir: &Path,
    requested_model_id: Option<&str>,
    mode: &str,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let _guard = settings_mutation_guard();
    let settings = load_settings(data_dir)?;
    resolve_model_and_credential_for_turn_with_store(
        &settings,
        requested_model_id,
        mode,
        &SystemCredentialStore,
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
        &settings,
        requested_model_id,
        mode,
        task_kind,
        &SystemCredentialStore,
    )
}

fn resolve_model_and_credential_for_task_with_store(
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
    mode: &str,
    task_kind: &str,
    credential_store: &impl CredentialStore,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    ensure!(
        task_kind == "problem_repair",
        "Unsupported typed Agent task."
    );
    ensure!(mode == "ask", "Problem repair must use read-only Ask mode.");
    let resolved = resolve_model_for_turn_with_settings(settings, requested_model_id, "act")
        .context(
            "Problem repair requires a compatible function-calling model on the effective agent.act route.",
        )?;
    let credential =
        credential_override_with_store(settings, &resolved.provider_id, credential_store)?;
    ensure!(
        !resolved.runtime_profile.api_key_required || credential.is_some(),
        "Problem repair is unavailable because the effective agent.act Provider credential is missing."
    );
    Ok((resolved, credential))
}

fn resolve_model_and_credential_for_turn_with_store(
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
    mode: &str,
    credential_store: &impl CredentialStore,
) -> Result<(ResolvedAgentModel, Option<(String, String)>)> {
    let resolved = resolve_model_for_turn_with_settings(settings, requested_model_id, mode)?;
    let credential =
        credential_override_with_store(settings, &resolved.provider_id, credential_store)?;
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
    settings: &AgentLlmSettings,
    provider_id: &str,
    credential_store: &impl CredentialStore,
) -> Result<Option<(String, String)>> {
    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .with_context(|| format!("Unknown provider: {provider_id}"))?;
    if !provider.api_key_required {
        return Ok(None);
    }
    let Some(value) = credential_store.get(provider_id)? else {
        return Ok(None);
    };
    let env_name = provider
        .api_key_env
        .clone()
        .context("The provider has no API key environment name.")?;
    Ok(Some((env_name, value)))
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
        validate_provider(provider)?;
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
            AgentProviderProfileView {
                credential_status: credential.status,
                credential_source: credential.source,
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
        capability_routes: vec![AgentRuntimeCapabilityRoute {
            capability: route_capability.to_string(),
            model: effective_model_ref.clone(),
            model_type: route_model_type,
            required_model_capabilities,
        }],
    };
    Ok(ResolvedAgentModel {
        settings_revision: settings.revision,
        route_capability: route_capability.to_string(),
        effective_model_ref,
        runtime_profile,
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
            model.capabilities.insert(
                name.to_string(),
                capability_value(value, "provider_response"),
            );
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
    providers: &[AgentProviderProfile],
    observations: &HashMap<String, CredentialObservation>,
) -> HashMap<String, CredentialPresentation> {
    providers
        .iter()
        .map(|provider| {
            let presentation = if !provider.api_key_required {
                credential_presentation_for_provider(provider)
            } else {
                match observations.get(&provider.id) {
                    Some(CredentialObservation::Detected) => CredentialPresentation {
                        status: "detected".to_string(),
                        source: "system".to_string(),
                    },
                    Some(CredentialObservation::NotDetected) => CredentialPresentation {
                        status: "not_detected".to_string(),
                        source: "none".to_string(),
                    },
                    Some(CredentialObservation::Unavailable) => CredentialPresentation {
                        status: "unavailable".to_string(),
                        source: "unavailable".to_string(),
                    },
                    None => credential_presentation_for_provider(provider),
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

fn inferred_capabilities(profile: &AgentRuntimeModelProfile) -> AgentModelCapabilitiesV1 {
    AgentModelCapabilitiesV1 {
        tool_calling: profile.tool_calling.clone(),
        reasoning: "unknown".to_string(),
        vision_input: "unknown".to_string(),
        source: "unknown".to_string(),
    }
}

fn run_connection_test(
    rscript: &Path,
    agent_package: &Path,
    profile: &AgentRuntimeModelProfile,
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
    run_r_json(
        rscript,
        script,
        &[agent_package.to_string_lossy().replace('\\', "/")],
        None,
        Some(serde_json::to_string(profile)?),
        credential_override.map(|(name, value)| (name.as_str(), value.as_str())),
        test_control,
    )
}

fn run_r_json<T: for<'de> Deserialize<'de>>(
    rscript: &Path,
    script: &str,
    args: &[String],
    user_environ: Option<&str>,
    stdin: Option<String>,
    credential_override: Option<(&str, &str)>,
    test_control: Option<&AgentModelTestControl>,
) -> Result<T> {
    let script_file = write_r_probe_script(script)?;
    let mut command = Command::new(rscript);
    hide_console_window(&mut command);
    configure_r_probe(&mut command, user_environ);
    if let Some((name, value)) = credential_override {
        command.env(name, value);
    }
    command.arg(script_file.path()).args(args);
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let mut child = command.spawn().context("spawning Rscript JSON probe")?;
    let pid = child.id();
    if let Some(control) = test_control {
        let mut guard = control
            .lock()
            .map_err(|_| anyhow::anyhow!("locking Agent model test state"))?;
        guard.pid = Some(pid);
        guard.cancel_requested = false;
    }
    if let Some(stdin_payload) = stdin {
        use std::io::Write;
        let mut handle = child.stdin.take().context("opening Rscript stdin")?;
        handle.write_all(stdin_payload.as_bytes())?;
    }
    let mut stdout = child.stdout.take().context("opening Rscript stdout")?;
    let mut stderr = child.stderr.take().context("opening Rscript stderr")?;
    let stdout_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .context("checking Rscript JSON probe status")?
        {
            break status;
        }
        if test_control.is_some() && started.elapsed() >= CONNECTION_TEST_TIMEOUT {
            timed_out = true;
            let _ = kill_process(pid);
            break child
                .wait()
                .context("waiting for timed-out Rscript JSON probe")?;
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    };
    let stdout_bytes = stdout_thread
        .join()
        .map_err(|_| anyhow::anyhow!("joining Rscript stdout reader"))?;
    let stderr_bytes = stderr_thread
        .join()
        .map_err(|_| anyhow::anyhow!("joining Rscript stderr reader"))?;
    let was_cancelled = if let Some(control) = test_control {
        let mut guard = control
            .lock()
            .map_err(|_| anyhow::anyhow!("locking Agent model test state"))?;
        let cancelled = guard.cancel_requested;
        guard.pid = None;
        guard.cancel_requested = false;
        cancelled
    } else {
        false
    };
    if was_cancelled {
        bail!("Agent model test cancelled.");
    }
    if timed_out {
        bail!("Agent model test timed out after 30 seconds.");
    }
    ensure!(
        status.success(),
        "R probe failed: {}",
        String::from_utf8_lossy(&stderr_bytes)
    );
    serde_json::from_slice(&stdout_bytes).context("decoding R JSON probe result")
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
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .context("cancelling Agent model test")?;
        ensure!(status.success(), "Cancelling the Agent model test failed.");
        return Ok(());
    }
    #[cfg(not(any(windows, unix)))]
    bail!("Cancelling an Agent model test is unsupported on this platform.")
}

fn configure_r_probe(command: &mut Command, _user_environ: Option<&str>) {
    command.arg("--vanilla");
}

fn hide_console_window(_command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _command.creation_flags(0x0800_0000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };
    use std::thread;
    use tempfile::TempDir;

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

    fn delete_provider_request(settings: &AgentLlmSettings) -> DeleteProviderRequest {
        DeleteProviderRequest {
            provider_id: "provider-deepseek-existing".to_string(),
            expected_revision: settings.revision,
        }
    }

    #[cfg(target_os = "macos")]
    struct NativeKeychainCleanup {
        service: String,
        account: String,
    }

    #[cfg(target_os = "macos")]
    impl Drop for NativeKeychainCleanup {
        fn drop(&mut self) {
            if let Ok(entry) = keyring::Entry::new(&self.service, &self.account) {
                let _ = entry.delete_credential();
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opt-in MAC3 smoke touches a unique disposable macOS Keychain entry"]
    fn macos_native_keychain_set_get_replace_delete_and_cleanup() {
        let identifier = uuid::Uuid::new_v4().to_string();
        let service = format!("Rho MAC3 Keychain Test {identifier}");
        let account = format!("provider-mac3-{identifier}");
        let _cleanup = NativeKeychainCleanup {
            service: service.clone(),
            account: account.clone(),
        };

        assert_eq!(keyring_credential_get(&service, &account).unwrap(), None);
        keyring_credential_set(&service, &account, "mac3-disposable-first").unwrap();
        assert_eq!(
            keyring_credential_get(&service, &account)
                .unwrap()
                .as_deref(),
            Some("mac3-disposable-first")
        );
        keyring_credential_set(&service, &account, "mac3-disposable-replacement").unwrap();
        assert_eq!(
            keyring_credential_get(&service, &account)
                .unwrap()
                .as_deref(),
            Some("mac3-disposable-replacement")
        );
        keyring_credential_delete(&service, &account).unwrap();
        keyring_credential_delete(&service, &account).unwrap();
        assert_eq!(keyring_credential_get(&service, &account).unwrap(), None);
    }

    #[cfg(target_os = "linux")]
    struct LinuxSecretServiceCleanup {
        service: String,
        account: String,
    }

    #[cfg(target_os = "linux")]
    impl Drop for LinuxSecretServiceCleanup {
        fn drop(&mut self) {
            if let Ok(entry) = keyring::Entry::new(&self.service, &self.account) {
                let _ = entry.delete_credential();
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "opt-in LIN6 smoke touches a unique disposable Linux Secret Service entry"]
    fn linux_secret_service_set_get_replace_delete_and_cleanup() {
        let identifier = uuid::Uuid::new_v4().to_string();
        let service = format!("Rho LIN6 Secret Service Test {identifier}");
        let account = format!("provider-lin6-{identifier}");
        let _cleanup = LinuxSecretServiceCleanup {
            service: service.clone(),
            account: account.clone(),
        };

        assert_eq!(keyring_credential_get(&service, &account).unwrap(), None);
        keyring_credential_set(&service, &account, "lin6-disposable-first").unwrap();
        assert_eq!(
            keyring_credential_get(&service, &account)
                .unwrap()
                .as_deref(),
            Some("lin6-disposable-first")
        );
        keyring_credential_set(&service, &account, "lin6-disposable-replacement").unwrap();
        assert_eq!(
            keyring_credential_get(&service, &account)
                .unwrap()
                .as_deref(),
            Some("lin6-disposable-replacement")
        );
        keyring_credential_delete(&service, &account).unwrap();
        keyring_credential_delete(&service, &account).unwrap();
        assert_eq!(keyring_credential_get(&service, &account).unwrap(), None);
    }

    #[test]
    fn default_migration_preserves_deepseek_flash() {
        let settings = default_settings();
        assert_eq!(chat_model_id(&settings).unwrap(), "model-deepseek-v4-flash");
        assert_eq!(settings.schema_version, 2);
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

    fn legacy_settings_bytes() -> Vec<u8> {
        serde_json::to_vec_pretty(&AgentLlmSettingsV1 {
            schema_version: 1,
            selected_model_id: "model-deepseek-v4-flash".to_string(),
            providers: default_settings().providers,
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

    #[test]
    fn v1_read_projects_without_rewrite_then_first_mutation_backs_up_and_migrates() {
        let directory = TempDir::new().unwrap();
        let legacy = legacy_settings_bytes();
        std::fs::write(settings_path(directory.path()), &legacy).unwrap();

        let projected = load_settings(directory.path()).unwrap();
        assert_eq!(projected.schema_version, 2);
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
        assert_eq!(reopened.schema_version, 2);
        assert_eq!(reopened.revision, 1);
        assert_eq!(reopened.models[0].model_type.source, "user_declared");
    }

    #[test]
    fn v1_migration_backup_and_v2_write_failures_leave_recoverable_source() {
        let directory = TempDir::new().unwrap();
        let legacy = legacy_settings_bytes();
        let path = settings_path(directory.path());
        std::fs::write(&path, &legacy).unwrap();
        let projected = load_settings(directory.path()).unwrap();

        let result = save_settings_with(directory.path(), &projected, |target, _| {
            if target == settings_v1_backup_path(directory.path()) {
                bail!("injected backup failure")
            }
            unreachable!("V2 write must not run after backup failure")
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert!(!settings_v1_backup_path(directory.path()).exists());

        let result = save_settings_with(directory.path(), &projected, |target, bytes| {
            if target == settings_v1_backup_path(directory.path()) {
                atomic_write(target, bytes)
            } else {
                bail!("injected V2 write failure")
            }
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert_eq!(
            std::fs::read(settings_v1_backup_path(directory.path())).unwrap(),
            legacy
        );
        assert_eq!(load_settings(directory.path()).unwrap().schema_version, 2);
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

        let (chat, chat_credential) =
            resolve_model_and_credential_for_turn_with_store(&settings, None, "ask", &store)
                .unwrap();
        assert_eq!(chat.route_capability, "agent.chat");
        assert_eq!(chat.provider_id, "provider-deepseek-existing");
        assert_eq!(chat_credential.unwrap().1, "chat-secret");

        let (act, act_credential) =
            resolve_model_and_credential_for_turn_with_store(&settings, None, "act", &store)
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

        let (resolved, credential) = resolve_model_and_credential_for_task_with_store(
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
        assert!(
            resolve_model_and_credential_for_task_with_store(
                &settings,
                None,
                "act",
                "problem_repair",
                &store,
            )
            .is_err()
        );
        assert!(
            resolve_model_and_credential_for_task_with_store(
                &settings,
                Some("model-deepseek-v4-flash"),
                "ask",
                "problem_repair",
                &store,
            )
            .is_err()
        );
    }

    #[test]
    fn problem_repair_blocks_chat_only_unknown_and_missing_credential_routes() {
        let mut settings = default_settings();
        settings.models[0].capabilities.insert(
            "function_call".to_string(),
            capability_value("no", "user_declared"),
        );
        let store = MemoryCredentialStore::default();
        assert!(
            resolve_model_and_credential_for_task_with_store(
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
            &store,
        )
        .unwrap();
        set_credential_with_store(directory.path(), "provider-second", "second-secret", &store)
            .unwrap();
        set_credential_with_store(
            directory.path(),
            "provider-deepseek-existing",
            "replacement-secret",
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
        assert!(set_credential_with_store(directory.path(), "missing", "secret", &store).is_err());
        assert!(
            set_credential_with_store(directory.path(), "provider-deepseek-existing", "", &store,)
                .is_err()
        );
        assert!(
            set_credential_with_store(
                directory.path(),
                "provider-deepseek-existing",
                &"x".repeat(MAX_CREDENTIAL_BYTES + 1),
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
                &store,
            )
            .is_err()
        );
        assert!(store.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn settings_projection_is_lazy_and_never_reads_provider_credentials() {
        let settings = default_settings();
        let store = MemoryCredentialStore {
            entries: Mutex::new(HashMap::from([(
                "provider-deepseek-existing".to_string(),
                "secret-that-must-not-be-read".to_string(),
            )])),
            ..Default::default()
        };
        let view = settings_view_from_settings_with_observations(settings, &HashMap::new());
        let provider = view
            .providers
            .iter()
            .find(|provider| provider.profile.id == "provider-deepseek-existing")
            .unwrap();

        assert_eq!(provider.credential_status, "unchecked");
        assert_eq!(provider.credential_source, "unchecked");
        assert!(store.get_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn session_cache_reads_each_provider_once_and_caches_missing_values() {
        let cache = SessionCredentialCache::default();
        let loads = AtomicUsize::new(0);
        let first = cache
            .get_or_load("provider-first", || {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(Some("first-secret".to_string()))
            })
            .unwrap();
        let repeated = cache
            .get_or_load("provider-first", || {
                panic!("cached Provider must not call Keychain again")
            })
            .unwrap();
        let missing = cache
            .get_or_load("provider-missing", || {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            })
            .unwrap();
        let repeated_missing = cache
            .get_or_load("provider-missing", || {
                panic!("known-missing Provider must not call Keychain again")
            })
            .unwrap();

        assert_eq!(first.as_deref(), Some("first-secret"));
        assert_eq!(repeated.as_deref(), Some("first-secret"));
        assert_eq!(missing, None);
        assert_eq!(repeated_missing, None);
        assert_eq!(loads.load(Ordering::SeqCst), 2);
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn session_cache_replaces_deletes_clears_and_retries_failures() {
        let cache = SessionCredentialCache::default();
        cache.set("provider", "first-secret");
        assert_eq!(
            cache
                .get_or_load("provider", || panic!("set value must be cached"))
                .unwrap()
                .as_deref(),
            Some("first-secret")
        );
        cache.set("provider", "replacement-secret");
        assert_eq!(
            cache
                .get_or_load("provider", || panic!("replacement must be cached"))
                .unwrap()
                .as_deref(),
            Some("replacement-secret")
        );
        cache.mark_missing("provider");
        assert_eq!(
            cache
                .get_or_load("provider", || panic!("delete state must be cached"))
                .unwrap(),
            None
        );

        let attempts = AtomicUsize::new(0);
        assert!(
            cache
                .get_or_load("provider-retry", || {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    bail!("injected Keychain denial")
                })
                .is_err()
        );
        assert_eq!(
            cache
                .get_or_load("provider-retry", || {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Ok(Some("retry-secret".to_string()))
                })
                .unwrap()
                .as_deref(),
            Some("retry-secret")
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        cache.clear();
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn non_secret_observations_project_exact_credential_states() {
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
        let observations = HashMap::from([
            (
                "provider-deepseek-existing".to_string(),
                CredentialObservation::Detected,
            ),
            (
                "provider-missing".to_string(),
                CredentialObservation::NotDetected,
            ),
            (
                "provider-unavailable".to_string(),
                CredentialObservation::Unavailable,
            ),
        ]);
        let statuses = credential_status_map(&settings.providers, &observations);

        assert_eq!(statuses["provider-deepseek-existing"].status, "detected");
        assert_eq!(statuses["provider-deepseek-existing"].source, "system");
        assert_eq!(statuses["provider-missing"].status, "not_detected");
        assert_eq!(statuses["provider-missing"].source, "none");
        assert_eq!(statuses["provider-unavailable"].status, "unavailable");
        assert_eq!(statuses["provider-unavailable"].source, "unavailable");
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
                .contains("system credential was restored")
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
            &store,
        )
        .unwrap();

        let settings = load_settings(directory.path()).unwrap();
        let resolved = resolve_model_with_settings(&settings, None).unwrap();
        let credential =
            credential_override_with_store(&settings, &resolved.provider_id, &store).unwrap();
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
        }];

        enrich_discovered_models(&provider, &mut models, &entries);
        assert_eq!(models[0].model_type.value, "language");
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
        configure_r_probe(&mut command, Some("C:/Users/test/.Renviron"));
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
        configure_r_probe(&mut command, None);
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
}
