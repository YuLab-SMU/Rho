use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use chrono::Utc;
use rho_server::coordinator::AgentRuntimeModelProfile;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::project::atomic_write;

const SETTINGS_FILE_NAME: &str = "llm-profiles.json";
const MAX_ID_LENGTH: usize = 120;
const MAX_NAME_LENGTH: usize = 160;
const MAX_MODEL_ID_LENGTH: usize = 240;
const MAX_URL_LENGTH: usize = 512;
const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentLlmSettings {
    pub schema_version: u32,
    pub selected_model_id: String,
    pub providers: Vec<AgentProviderProfile>,
    pub models: Vec<AgentModelProfile>,
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
    pub capabilities: AgentModelCapabilities,
    pub last_test: Option<AgentModelTestResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModelCapabilities {
    pub tool_calling: String,
    pub reasoning: String,
    pub vision_input: String,
    pub source: String,
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
    pub capabilities: AgentModelCapabilities,
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
    pub capabilities: AgentModelCapabilities,
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
    pub selected_model_id: String,
    pub providers: Vec<AgentProviderProfileView>,
    pub models: Vec<AgentModelProfileView>,
    pub selected_model: Option<AgentSelectedModelView>,
    pub user_environ: AgentUserEnvironInfo,
    pub validation_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedAgentModel {
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

#[derive(Debug, Default)]
pub struct AgentModelTestState {
    pub pid: Option<u32>,
    pub cancel_requested: bool,
}

pub type AgentModelTestControl = Arc<Mutex<AgentModelTestState>>;

pub fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_FILE_NAME)
}

pub fn default_settings() -> AgentLlmSettings {
    AgentLlmSettings {
        schema_version: 1,
        selected_model_id: "model-deepseek-v4-flash".to_string(),
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
            capabilities: AgentModelCapabilities {
                tool_calling: "yes".to_string(),
                reasoning: "yes".to_string(),
                vision_input: "no".to_string(),
                source: "catalog".to_string(),
            },
            last_test: None,
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
    let settings: AgentLlmSettings = serde_json::from_slice(&bytes)
        .with_context(|| format!("decoding Agent LLM settings {}", path.display()))?;
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn save_settings(data_dir: &Path, settings: &AgentLlmSettings) -> Result<()> {
    validate_settings(settings)?;
    let path = settings_path(data_dir);
    let bytes = serde_json::to_vec_pretty(settings)?;
    atomic_write(&path, &bytes)
        .with_context(|| format!("writing Agent LLM settings {}", path.display()))
}

pub fn save_provider(data_dir: &Path, provider: AgentProviderProfile) -> Result<AgentLlmSettings> {
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
    save_settings(data_dir, &settings)?;
    Ok(settings)
}

pub fn delete_provider(data_dir: &Path, provider_id: &str) -> Result<AgentLlmSettings> {
    let mut settings = load_settings(data_dir)?;
    ensure!(
        !settings
            .models
            .iter()
            .any(|model| model.provider_id == provider_id),
        "Delete the provider's models before removing the provider."
    );
    let before = settings.providers.len();
    settings
        .providers
        .retain(|provider| provider.id != provider_id);
    ensure!(
        settings.providers.len() != before,
        "Unknown provider: {provider_id}"
    );
    save_settings(data_dir, &settings)?;
    Ok(settings)
}

pub fn save_model(data_dir: &Path, model: AgentModelProfile) -> Result<AgentLlmSettings> {
    let mut settings = load_settings(data_dir)?;
    if let Some(slot) = settings.models.iter_mut().find(|item| item.id == model.id) {
        *slot = model;
    } else {
        settings.models.push(model);
    }
    save_settings(data_dir, &settings)?;
    Ok(settings)
}

pub fn delete_model(data_dir: &Path, request: &DeleteModelRequest) -> Result<AgentLlmSettings> {
    let mut settings = load_settings(data_dir)?;
    let existing = settings
        .models
        .iter()
        .find(|model| model.id == request.model_id)
        .cloned()
        .with_context(|| format!("Unknown model: {}", request.model_id))?;
    if settings.selected_model_id == request.model_id {
        let replacement_id = request
            .replacement_model_id
            .as_deref()
            .context("Select another enabled model before deleting the current default.")?;
        let replacement = settings
            .models
            .iter()
            .find(|model| model.id == replacement_id)
            .with_context(|| format!("Unknown replacement model: {replacement_id}"))?;
        ensure!(
            replacement.enabled,
            "Replacement model must remain enabled."
        );
        ensure!(
            replacement.id != existing.id,
            "Replacement model must differ from the deleted model."
        );
        settings.selected_model_id = replacement.id.clone();
    }
    settings.models.retain(|model| model.id != request.model_id);
    save_settings(data_dir, &settings)?;
    Ok(settings)
}

pub fn select_model(data_dir: &Path, model_id: &str) -> Result<AgentLlmSettings> {
    let mut settings = load_settings(data_dir)?;
    let model = settings
        .models
        .iter()
        .find(|item| item.id == model_id)
        .with_context(|| format!("Unknown model: {model_id}"))?;
    ensure!(model.enabled, "Selected model must be enabled.");
    settings.selected_model_id = model_id.to_string();
    save_settings(data_dir, &settings)?;
    Ok(settings)
}

pub fn settings_view(data_dir: &Path, rscript: &Path) -> Result<AgentLlmSettingsView> {
    let settings = load_settings(data_dir)?;
    let user_environ = resolve_user_environ(rscript)?;
    let statuses = credential_status_map(rscript, &user_environ.path, &settings.providers)?;
    Ok(build_settings_view(settings, user_environ, statuses))
}

pub fn refresh_credentials_view(data_dir: &Path, rscript: &Path) -> Result<AgentLlmSettingsView> {
    settings_view(data_dir, rscript)
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
models <- models[models$type == "language", , drop = FALSE]
if (!nrow(models)) {
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
field_flag <- function(data, row, name) {
  if (!(name %in% names(data))) {
    return(FALSE)
  }
  value <- data[[name]][[row]]
  isTRUE(as.logical(value)[[1L]])
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
    capabilities = list(
      tool_calling = if (field_flag(models, i, "function_call")) "yes" else "no",
      reasoning = if (field_flag(models, i, "reasoning")) "yes" else "no",
      vision_input = if (field_flag(models, i, "vision_input")) "yes" else "no",
      source = "catalog"
    )
  )
})
cat(jsonlite::toJSON(unname(rows), auto_unbox = TRUE, null = "null"))
"#;
    run_r_json(rscript, script, &[], None, None, None)
}

pub fn open_user_environ(rscript: &Path) -> Result<AgentUserEnvironInfo> {
    let info = resolve_user_environ(rscript)?;
    let path = PathBuf::from(&info.path);
    if !path.exists() {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        atomic_write(&path, b"")?;
    }
    open_path(&path)?;
    Ok(info)
}

pub fn test_model(
    data_dir: &Path,
    rscript: &Path,
    agent_package: &Path,
    model_id: &str,
    test_control: Option<&AgentModelTestControl>,
) -> Result<AgentLlmSettingsView> {
    let settings = load_settings(data_dir)?;
    let user_environ = resolve_user_environ(rscript)?;
    let resolved = resolve_model_with_settings(&settings, Some(model_id))?;
    let credential_statuses =
        credential_status_map(rscript, &user_environ.path, &settings.providers)?;
    let provider_status = credential_statuses.get(&resolved.provider_id).cloned();
    let credential_status = provider_status.unwrap_or_else(|| {
        credential_statuses
            .get(&resolved.runtime_profile.runtime_provider_id)
            .cloned()
            .unwrap_or_else(|| {
                let provider = settings
                    .providers
                    .iter()
                    .find(|item| item.id == resolved.provider_id);
                provider
                    .map(credential_label_for_provider)
                    .unwrap_or_else(|| "not_detected".to_string())
            })
    });
    let result = if credential_status == "not_detected" && resolved.runtime_profile.api_key_required
    {
        AgentConnectionTestResponse {
            status: "error".to_string(),
            credential_status: "not_detected".to_string(),
            model_resolved: false,
            latency_ms: None,
            capabilities: inferred_capabilities(&resolved.runtime_profile),
            message: "Credential was not detected in the effective user environment file."
                .to_string(),
            error_class: Some("credential".to_string()),
        }
    } else {
        run_connection_test(
            rscript,
            agent_package,
            &user_environ.path,
            &resolved.runtime_profile,
            test_control,
        )?
    };
    let mut latest_settings = load_settings(data_dir)?;
    let latest_resolved = resolve_model_with_settings(&latest_settings, Some(model_id))?;
    ensure!(
        latest_resolved.runtime_profile == resolved.runtime_profile,
        "The model configuration changed during the connection test; the test result was not saved."
    );
    update_model_after_test(&mut latest_settings, model_id, &result)?;
    save_settings(data_dir, &latest_settings)?;
    let statuses = credential_status_map(rscript, &user_environ.path, &latest_settings.providers)?;
    Ok(build_settings_view(latest_settings, user_environ, statuses))
}

pub fn resolve_model_for_turn(
    data_dir: &Path,
    requested_model_id: Option<&str>,
) -> Result<ResolvedAgentModel> {
    let settings = load_settings(data_dir)?;
    resolve_model_with_settings(&settings, requested_model_id)
}

pub fn validate_settings(settings: &AgentLlmSettings) -> Result<()> {
    ensure!(
        settings.schema_version == 1,
        "Unsupported Agent LLM schema version."
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
    let selected = settings
        .models
        .iter()
        .find(|model| model.id == settings.selected_model_id)
        .context("Selected model must exist.")?;
    ensure!(selected.enabled, "Selected model must remain enabled.");
    Ok(())
}

pub fn resolve_user_environ(rscript: &Path) -> Result<AgentUserEnvironInfo> {
    resolve_user_environ_with_inherited(rscript, std::env::var_os("R_ENVIRON_USER"))
}

fn resolve_user_environ_with_inherited(
    rscript: &Path,
    inherited: Option<OsString>,
) -> Result<AgentUserEnvironInfo> {
    if let Some(inherited) = inherited
        && !inherited.is_empty()
    {
        return Ok(AgentUserEnvironInfo {
            path: PathBuf::from(inherited)
                .to_string_lossy()
                .replace('\\', "/"),
            source: "inherited".to_string(),
        });
    }
    let script = r#"
path <- normalizePath(path.expand("~/.Renviron"), winslash = "/", mustWork = FALSE)
cat(path)
"#;
    let path: String = run_r_text(rscript, script, &[], None)?;
    let trimmed = path.trim().to_string();
    ensure!(
        !trimmed.is_empty(),
        "Could not resolve the user R environment file."
    );
    Ok(AgentUserEnvironInfo {
        path: trimmed,
        source: "default".to_string(),
    })
}

fn build_settings_view(
    settings: AgentLlmSettings,
    user_environ: AgentUserEnvironInfo,
    statuses: HashMap<String, String>,
) -> AgentLlmSettingsView {
    let provider_map = settings
        .providers
        .iter()
        .map(|provider| (provider.id.clone(), provider.display_name.clone()))
        .collect::<HashMap<_, _>>();
    let providers = settings
        .providers
        .iter()
        .cloned()
        .map(|profile| AgentProviderProfileView {
            credential_status: statuses
                .get(&profile.id)
                .cloned()
                .unwrap_or_else(|| credential_label_for_provider(&profile)),
            profile,
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
                selected: profile.id == settings.selected_model_id,
                act_enabled: profile.enabled && profile.capabilities.tool_calling == "yes",
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
                tool_calling: model.profile.capabilities.tool_calling.clone(),
                act_enabled: model.act_enabled,
            });
    AgentLlmSettingsView {
        schema_version: settings.schema_version,
        selected_model_id: settings.selected_model_id,
        providers,
        models,
        selected_model,
        user_environ,
        validation_error: None,
    }
}

fn resolve_model_with_settings(
    settings: &AgentLlmSettings,
    requested_model_id: Option<&str>,
) -> Result<ResolvedAgentModel> {
    let target_id = requested_model_id.unwrap_or(&settings.selected_model_id);
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
    let runtime_profile = AgentRuntimeModelProfile {
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
        tool_calling: model.capabilities.tool_calling.clone(),
        provider_display_name: provider.display_name.clone(),
        model_display_name: model.display_name.clone(),
    };
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
    Ok(ResolvedAgentModel {
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
    if model.capabilities.source != "declared" {
        model.capabilities = result.capabilities.clone();
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
            provider.base_url.is_none() && provider.base_url_env.is_none(),
            "Built-in providers do not accept custom base URLs in V1."
        );
    }
    Ok(())
}

fn validate_model(model: &AgentModelProfile) -> Result<()> {
    validate_bounded(&model.id, "Model ID", MAX_ID_LENGTH)?;
    validate_bounded(&model.provider_id, "Provider reference", MAX_ID_LENGTH)?;
    validate_bounded(&model.display_name, "Model display name", MAX_NAME_LENGTH)?;
    validate_bounded(&model.model_id, "Provider model ID", MAX_MODEL_ID_LENGTH)?;
    validate_capabilities(&model.capabilities)?;
    Ok(())
}

fn validate_capabilities(capabilities: &AgentModelCapabilities) -> Result<()> {
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

fn credential_status_map(
    rscript: &Path,
    user_environ_path: &str,
    providers: &[AgentProviderProfile],
) -> Result<HashMap<String, String>> {
    let script = r#"
args <- commandArgs(TRUE)
required <- jsonlite::fromJSON(args[[1]], simplifyVector = FALSE)
statuses <- lapply(required, function(item) {
  env_name <- if (is.null(item$env_name)) "" else as.character(item$env_name[[1L]])
  required <- isTRUE(item$required)
  if (!required) {
    return(list(provider_id = item$provider_id, status = "not_required"))
  }
  value <- Sys.getenv(env_name, unset = "")
  status <- if (nzchar(value)) "detected" else "not_detected"
  list(provider_id = item$provider_id, status = status)
})
cat(jsonlite::toJSON(unname(statuses), auto_unbox = TRUE, null = "null"))
"#;
    let payload = providers
        .iter()
        .map(|provider| {
            json!({
                "provider_id": provider.id,
                "env_name": provider.api_key_env.clone().unwrap_or_default(),
                "required": provider.api_key_required
            })
        })
        .collect::<Vec<_>>();
    let rows: Vec<Value> = run_r_json(
        rscript,
        script,
        &[serde_json::to_string(&payload)?],
        Some(user_environ_path),
        None,
        None,
    )?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some((
                row.get("provider_id")?.as_str()?.to_string(),
                row.get("status")?.as_str()?.to_string(),
            ))
        })
        .collect())
}

fn selector_status(
    model: &AgentModelProfile,
    statuses: &HashMap<String, String>,
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
        .cloned()
        .unwrap_or_else(|| credential_label_for_provider(provider));
    if credential_status == "not_detected" && provider.api_key_required {
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
        "not_detected".to_string()
    }
}

fn inferred_capabilities(profile: &AgentRuntimeModelProfile) -> AgentModelCapabilities {
    AgentModelCapabilities {
        tool_calling: profile.tool_calling.clone(),
        reasoning: "unknown".to_string(),
        vision_input: "unknown".to_string(),
        source: "unknown".to_string(),
    }
}

fn run_connection_test(
    rscript: &Path,
    agent_package: &Path,
    user_environ_path: &str,
    profile: &AgentRuntimeModelProfile,
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
        Some(user_environ_path),
        Some(serde_json::to_string(profile)?),
        test_control,
    )
}

fn run_r_text(
    rscript: &Path,
    script: &str,
    args: &[String],
    user_environ: Option<&str>,
) -> Result<String> {
    let script_file = write_r_probe_script(script)?;
    let mut command = Command::new(rscript);
    hide_console_window(&mut command);
    configure_r_probe(&mut command, user_environ);
    command.arg(script_file.path()).args(args);
    let output = command.output().context("running Rscript probe")?;
    ensure!(
        output.status.success(),
        "R probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_r_json<T: for<'de> Deserialize<'de>>(
    rscript: &Path,
    script: &str,
    args: &[String],
    user_environ: Option<&str>,
    stdin: Option<String>,
    test_control: Option<&AgentModelTestControl>,
) -> Result<T> {
    let script_file = write_r_probe_script(script)?;
    let mut command = Command::new(rscript);
    hide_console_window(&mut command);
    configure_r_probe(&mut command, user_environ);
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

fn open_path(path: &Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        hide_console_window(&mut command);
        command.arg(path);
        command.spawn().context("opening file in explorer")?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .context("opening file")?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .context("opening file")?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    bail!("Opening the user environment file is unsupported on this platform.")
}

fn configure_r_probe(command: &mut Command, user_environ: Option<&str>) {
    if let Some(path) = user_environ {
        command
            .args([
                "--no-save",
                "--no-restore",
                "--no-site-file",
                "--no-init-file",
            ])
            .env("R_ENVIRON_USER", path);
    } else {
        command.arg("--vanilla");
    }
}

fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn default_migration_preserves_deepseek_flash() {
        let settings = default_settings();
        assert_eq!(settings.selected_model_id, "model-deepseek-v4-flash");
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
        assert_eq!(loaded.selected_model_id, settings.selected_model_id);
        assert_eq!(loaded.models[0].display_name, "DeepSeek V4 Flash");
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
        settings.selected_model_id = "missing".to_string();
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
    fn inherited_r_environ_user_is_preserved() {
        let temp = TempDir::new().unwrap();
        let environ = temp.path().join("custom.Renviron");
        let resolved = resolve_user_environ_with_inherited(
            Path::new("Rscript"),
            Some(environ.clone().into_os_string()),
        )
        .unwrap();
        assert_eq!(resolved.path, environ.to_string_lossy().replace('\\', "/"));
        assert_eq!(resolved.source, "inherited");
    }

    #[test]
    fn user_environ_probes_do_not_disable_environ_loading() {
        let mut command = Command::new("Rscript");
        configure_r_probe(&mut command, Some("C:/Users/test/.Renviron"));
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|value| value == "--vanilla"));
        assert!(args.iter().any(|value| value == "--no-init-file"));
        let environ = command
            .get_envs()
            .find(|(name, _)| *name == "R_ENVIRON_USER")
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().to_string());
        assert_eq!(environ.as_deref(), Some("C:/Users/test/.Renviron"));
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
