use crate::AppState;
use crate::agent_llm::{
    self as service, AgentCapabilityRoute, AgentCapabilityRouteDeleteRequest,
    AgentCapabilityRouteSaveRequest, AgentConfigPermissionRepairRequest,
    AgentContextCapacityRequest, AgentLlmCredentialDeleteRequest, AgentLlmCredentialRevealView,
    AgentLlmCredentialWriteRequest, AgentLlmSettingsView, AgentModelCapabilitiesRequest,
    AgentModelCapabilityDeclarationRequest, AgentModelDiscoveryResponse, AgentModelSaveRequest,
    AgentModelTestRequest, AgentProviderConnectRequest, AgentProviderSaveRequest,
    DeleteModelRequest, DeleteProviderRequest,
};
use crate::startup_runtime::{display_error, runtime_config, write_startup_log};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentLlmSelectRequest {
    pub(crate) model_id: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) expected_revision: u64,
    pub(crate) expected_config_snapshot_id: String,
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentLlmCredentialRevealRequest {
    pub(crate) provider_id: String,
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_settings(
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let result = (|| {
        let config = runtime_config(&state)?;
        service::settings_view(
            &config.data_dir,
            &config.rscript,
            config.r_environ_user.as_deref(),
        )
    })();
    match result {
        Ok(view) => Ok(view),
        Err(error) => {
            write_startup_log(&format!(
                "agent_llm_settings outcome=failed detail={error:#}"
            ));
            Err(display_error(error))
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct AgentProviderConnectView {
    settings: AgentLlmSettingsView,
    discovery: AgentModelDiscoveryResponse,
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_connect_provider(
    request: AgentProviderConnectRequest,
    state: State<'_, AppState>,
) -> Result<AgentProviderConnectView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let data_dir = config.data_dir.clone();
    let rscript = config.rscript.clone();
    let r_environ_user = config.r_environ_user.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (settings, discovery) =
            service::connect_provider(&data_dir, &rscript, r_environ_user.as_deref(), &request)?;
        let settings = service::settings_view_from_settings(
            &data_dir,
            &rscript,
            r_environ_user.as_deref(),
            settings,
        )?;
        Ok::<_, anyhow::Error>(AgentProviderConnectView {
            settings,
            discovery,
        })
    })
    .await
    .map_err(display_error)?
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_save_provider(
    request: AgentProviderSaveRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = service::save_provider(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_delete_provider(
    request: DeleteProviderRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = service::delete_provider(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_set_credential(
    request: AgentLlmCredentialWriteRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    service::set_credential(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_delete_credential(
    request: AgentLlmCredentialDeleteRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    service::delete_credential(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
    )
    .map_err(display_error)
}

/// CRED-REVEAL-1C: one explicit click runs one fresh exact-source read and
/// resolves once with the outcome plus, on `revealed`, the stored value for
/// inline display. No OS prompt, window-focus check, or revision pin.
#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_view_credential(
    request: AgentLlmCredentialRevealRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmCredentialRevealView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let data_dir = config.data_dir.clone();
    let rscript = config.rscript.clone();
    let r_environ_user = config.r_environ_user.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service::view_provider_credential(
            &data_dir,
            &rscript,
            r_environ_user.as_deref(),
            &request.provider_id,
        )
    })
    .await
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_save_model(
    request: AgentModelSaveRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = service::save_model(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_set_context_capacity(
    request: AgentContextCapacityRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings =
        service::set_context_capacity(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_declare_model_capability(
    request: AgentModelCapabilityDeclarationRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings =
        service::declare_model_capability(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_delete_model(
    request: DeleteModelRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = service::delete_model(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_select_model(
    request: AgentLlmSelectRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = service::save_capability_route(
        &config.data_dir,
        request.expected_revision,
        &request.expected_config_snapshot_id,
        AgentCapabilityRoute {
            capability: "agent.chat".to_string(),
            model_id: request.model_id,
            model_type: "language".to_string(),
            required_model_capabilities: Vec::new(),
        },
    )
    .map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_save_capability_route(
    request: AgentCapabilityRouteSaveRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = service::save_capability_route(
        &config.data_dir,
        request.expected_revision,
        &request.expected_config_snapshot_id,
        request.route,
    )
    .map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_delete_capability_route(
    request: AgentCapabilityRouteDeleteRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings =
        service::delete_capability_route(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_declare_model_capabilities(
    request: AgentModelCapabilitiesRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings =
        service::declare_model_capabilities(&config.data_dir, &request).map_err(display_error)?;
    service::settings_view_from_settings(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        settings,
    )
    .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn agent_llm_refresh_credentials(
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    service::refresh_credentials_view(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_test_model(
    request: AgentModelTestRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let data_dir = config.data_dir.clone();
    let rscript = config.rscript.clone();
    let r_environ_user = config.r_environ_user.clone();
    let agent_package = config.agent_package.clone();
    let test_control = state.agent_llm_test_control.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service::test_model(
            &data_dir,
            &rscript,
            r_environ_user.as_deref(),
            &agent_package,
            &request,
            Some(&test_control),
        )
    })
    .await
    .map_err(display_error)?
    .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn agent_llm_cancel_test(state: State<'_, AppState>) -> Result<Value, String> {
    let cancelled = service::cancel_test(&state.agent_llm_test_control).map_err(display_error)?;
    Ok(json!({ "status": if cancelled { "cancelled" } else { "idle" } }))
}

#[tauri::command]
pub(crate) async fn agent_llm_catalog(state: State<'_, AppState>) -> Result<Value, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let entries = service::catalog(&config.data_dir, &config.rscript).map_err(display_error)?;
    serde_json::to_value(entries).map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_discover_models(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<AgentModelDiscoveryResponse, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let data_dir = config.data_dir.clone();
    let rscript = config.rscript.clone();
    let r_environ_user = config.r_environ_user.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service::discover_models(&data_dir, &rscript, r_environ_user.as_deref(), &provider_id)
    })
    .await
    .map_err(display_error)?
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_llm_repair_config_permissions(
    request: AgentConfigPermissionRepairRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    service::repair_config_permissions(
        &config.data_dir,
        &config.rscript,
        config.r_environ_user.as_deref(),
        &request,
    )
    .map_err(display_error)
}
