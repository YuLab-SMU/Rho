use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, path::BaseDirectory};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::startup_runtime::{
    bounded_diagnostic, display_error, hide_console_window, normalized_display_path,
    write_startup_log,
};
use crate::update::{self, ReleaseChannel, SOURCE_URL, WEBSITE_URL};
use crate::{AppState, platform, shutdown_application};

const RHO_LICENSE_RESOURCE: &str = "licenses/rho/LICENSE.txt";

#[derive(Serialize, specta::Type)]
struct AppRuntimeInfo {
    rscript: Option<String>,
    r_version: Option<String>,
    agent_available: Option<bool>,
    acp_agent: Option<String>,
    acp_protocol: Option<String>,
}

#[derive(Serialize, specta::Type)]
pub(crate) struct AppInfo {
    version: String,
    channel: ReleaseChannel,
    commit: String,
    platform: String,
    executable_path: String,
    frontend_entry: String,
    website_url: &'static str,
    source_url: &'static str,
    runtime: AppRuntimeInfo,
}

#[derive(Serialize)]
pub(crate) struct NativeUpdateCheckResult {
    status: &'static str,
    channel: ReleaseChannel,
    installed_version: String,
    available_version: Option<String>,
    published_at: Option<String>,
    summary: Option<String>,
}

struct NativePendingUpdate {
    update: tauri_plugin_updater::Update,
    channel: ReleaseChannel,
}

pub(crate) struct NativeUpdaterState {
    operation_gate: Mutex<()>,
    pending: Mutex<Option<NativePendingUpdate>>,
}

impl NativeUpdaterState {
    pub(crate) fn new() -> Self {
        Self {
            operation_gate: Mutex::new(()),
            pending: Mutex::new(None),
        }
    }
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    let version = env!("CARGO_PKG_VERSION").to_string();
    let channel = semver::Version::parse(&version)
        .map(|value| ReleaseChannel::for_version(&value))
        .map_err(display_error)?;
    let runtime = state.config.read().ok().and_then(|config| config.clone());
    Ok(AppInfo {
        version,
        channel,
        commit: env!("RHO_BUILD_COMMIT").to_string(),
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        executable_path: std::env::current_exe()
            .map(|path| normalized_display_path(&path))
            .unwrap_or_else(|_| "unavailable".to_string()),
        frontend_entry: env!("RHO_FRONTEND_ENTRY").to_string(),
        website_url: WEBSITE_URL,
        source_url: SOURCE_URL,
        runtime: AppRuntimeInfo {
            rscript: runtime
                .as_ref()
                .map(|value| value.rscript.to_string_lossy().into_owned()),
            r_version: runtime.as_ref().map(|value| value.r_version.clone()),
            agent_available: runtime.as_ref().map(|value| value.agent_runtime.available),
            acp_agent: runtime
                .as_ref()
                .and_then(|value| value.agent_runtime.active_agent_label.clone()),
            acp_protocol: runtime.and_then(|value| value.agent_runtime.protocol),
        },
    })
}

fn native_updater_error(code: &str, error: impl std::fmt::Display) -> String {
    write_startup_log(&format!(
        "Native updater {code}: {}",
        bounded_diagnostic(&error.to_string())
    ));
    format!("{code}: The signed update operation did not complete.")
}

fn pending_native_update_matches(expected_version: &str, available_version: &str) -> bool {
    expected_version.len() <= 128
        && available_version.len() <= 128
        && semver::Version::parse(expected_version).is_ok()
        && semver::Version::parse(available_version).is_ok()
        && expected_version == available_version
}

#[tauri::command]
pub(crate) async fn check_for_updates(
    app: AppHandle,
    updater_state: State<'_, NativeUpdaterState>,
) -> Result<NativeUpdateCheckResult, String> {
    let _operation = updater_state.operation_gate.lock().await;
    *updater_state.pending.lock().await = None;

    if !update::native_updater_supported() {
        return Err(
            "UPDATE_PLATFORM_UNAVAILABLE: native updates are not available for this platform."
                .to_string(),
        );
    }

    let installed_version = env!("CARGO_PKG_VERSION").to_string();
    let parsed_installed = semver::Version::parse(&installed_version)
        .map_err(|error| native_updater_error("UPDATE_INVALID", error))?;
    let channel = ReleaseChannel::for_version(&parsed_installed);
    let endpoint = reqwest::Url::parse(update::native_manifest_url(channel))
        .map_err(|error| native_updater_error("UPDATE_INVALID", error))?;
    let native_updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| native_updater_error("UPDATE_INVALID", error))?
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| native_updater_error("UPDATE_INVALID", error))?;
    let available = native_updater
        .check()
        .await
        .map_err(|error| native_updater_error("UPDATE_NETWORK", error))?;

    let Some(update) = available else {
        return Ok(NativeUpdateCheckResult {
            status: "up_to_date",
            channel,
            installed_version,
            available_version: None,
            published_at: None,
            summary: None,
        });
    };

    update::validate_native_update_candidate_metadata(
        &update.version,
        &update.download_url,
        &update.signature,
    )
    .map_err(|error| native_updater_error("UPDATE_INVALID", error))?;

    let summary = update::normalized_native_update_notes(update.body.as_deref())
        .map_err(|error| native_updater_error("UPDATE_INVALID", error))?;
    let result = NativeUpdateCheckResult {
        status: "update_available",
        channel,
        installed_version,
        available_version: Some(update.version.clone()),
        published_at: update.date.map(|value| value.to_string()),
        summary: Some(summary),
    };
    *updater_state.pending.lock().await = Some(NativePendingUpdate { update, channel });
    Ok(result)
}

#[tauri::command]
pub(crate) async fn install_native_update(
    expected_version: String,
    app: AppHandle,
    state: State<'_, AppState>,
    updater_state: State<'_, NativeUpdaterState>,
) -> Result<(), String> {
    let _operation = updater_state.operation_gate.lock().await;
    let Some(pending) = updater_state.pending.lock().await.take() else {
        return Err("UPDATE_STALE: Check for updates again before installing.".to_string());
    };
    if !pending_native_update_matches(&expected_version, &pending.update.version) {
        *updater_state.pending.lock().await = Some(pending);
        return Err("UPDATE_STALE: The selected update is no longer current. Check again before installing.".to_string());
    }

    let bytes = match update::download_and_verify_native_update(&pending.update).await {
        Ok(bytes) => bytes,
        Err(error) => {
            *updater_state.pending.lock().await = Some(pending);
            return Err(native_updater_error("UPDATE_DOWNLOAD", error));
        }
    };

    if state.shutdown_started.swap(true, Ordering::SeqCst) {
        *updater_state.pending.lock().await = Some(pending);
        return Err(
            "UPDATE_STALE: Rho is already closing. Restart it, then check for updates again."
                .to_string(),
        );
    }
    if let Err(error) = shutdown_application(&state).await {
        state.shutdown_started.store(false, Ordering::SeqCst);
        *updater_state.pending.lock().await = Some(pending);
        return Err(native_updater_error("UPDATE_SHUTDOWN", error));
    }

    write_startup_log(&format!(
        "Native updater verified the download for {} channel; beginning controlled installer handoff.",
        pending.channel.as_str()
    ));
    if let Err(error) = update::install_verified_native_update(&pending.update, &bytes) {
        write_startup_log(&format!(
            "Native updater install failed after verified download for {} channel: {}",
            pending.channel.as_str(),
            bounded_diagnostic(&error.to_string())
        ));
        app.request_restart();
        return Err("UPDATE_INSTALL: The signed update could not be installed. Rho is restarting its existing version.".to_string());
    }
    Err(
        "UPDATE_INSTALL: Native updater handoff unexpectedly returned without restarting Rho."
            .to_string(),
    )
}

#[tauri::command]
pub(crate) async fn open_rho_website(url: String) -> Result<(), String> {
    update::validate_product_url(&url).map_err(display_error)?;
    let mut command = platform::open_url_command(&url);
    hide_console_window(&mut command);
    command.spawn().map_err(display_error)?;
    Ok(())
}

fn ensure_bundled_license_file(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).context("checking bundled Rho license")?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "bundled Rho license is not a regular file"
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn show_rho_license(app: AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .resolve(RHO_LICENSE_RESOURCE, BaseDirectory::Resource)
        .map_err(|_| {
            "The bundled Rho license file could not be located. Reinstall Rho and try again."
                .to_string()
        })?;
    ensure_bundled_license_file(&path).map_err(|_| {
        "The bundled Rho license file is unavailable. Reinstall Rho and try again.".to_string()
    })?;
    let mut command = platform::reveal_path_command(&path);
    hide_console_window(&mut command);
    command
        .spawn()
        .map_err(|_| "The bundled Rho license file could not be shown.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn shell_app_info_serialization_matches_generated_contract() {
        let app = serde_json::to_value(AppInfo {
            version: "0.4.1-dev.17".to_string(),
            channel: ReleaseChannel::Development,
            commit: "fixture-commit".to_string(),
            platform: "fixture-platform".to_string(),
            executable_path: "/fixture/rho".to_string(),
            frontend_entry: "assets/index-fixture.js".to_string(),
            website_url: WEBSITE_URL,
            source_url: SOURCE_URL,
            runtime: AppRuntimeInfo {
                rscript: Some("/fixture/Rscript".to_string()),
                r_version: Some("4.5.1".to_string()),
                agent_available: Some(true),
                acp_agent: Some("claude-code-acp".to_string()),
                acp_protocol: Some("acp/1".to_string()),
            },
        })
        .unwrap();
        assert_eq!(app["channel"], "development");
        assert_eq!(app["runtime"]["agent_available"], true);
        assert_eq!(app["runtime"]["acp_protocol"], "acp/1");
    }

    #[test]
    fn native_updater_install_requires_the_exact_checked_semver() {
        assert!(pending_native_update_matches(
            "0.4.0-dev.40",
            "0.4.0-dev.40"
        ));
        assert!(!pending_native_update_matches(
            "0.4.0-dev.40",
            "0.4.0-dev.41"
        ));
        assert!(!pending_native_update_matches("not-semver", "0.4.0-dev.40"));
        assert!(!pending_native_update_matches("0.4.0-dev.40", "not-semver"));
        assert!(!pending_native_update_matches(
            &"0".repeat(129),
            "0.4.0-dev.40"
        ));
        assert!(!pending_native_update_matches(
            "0.4.0-dev.40",
            &"0".repeat(129)
        ));
    }

    #[test]
    fn bundled_license_boundary_accepts_only_a_regular_file() {
        let root = TempDir::new().unwrap();
        let license = root.path().join("LICENSE.txt");
        std::fs::write(&license, "license").unwrap();
        assert!(ensure_bundled_license_file(&license).is_ok());
        assert!(ensure_bundled_license_file(&root.path().join("missing")).is_err());
        assert!(ensure_bundled_license_file(root.path()).is_err());

        #[cfg(unix)]
        {
            let link = root.path().join("license-link");
            std::os::unix::fs::symlink(&license, &link).unwrap();
            assert!(ensure_bundled_license_file(&link).is_err());
        }
    }
}
