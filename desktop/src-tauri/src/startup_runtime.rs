mod probe;

pub(crate) use probe::*;

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::project::atomic_write;
use crate::{AppState, git, platform};

pub(crate) const BRIDGE_STATE: &str = include_str!("../../../r/rho.bridge/R/state.R");
pub(crate) const BRIDGE_EXECUTE: &str = include_str!("../../../r/rho.bridge/R/execute.R");
pub(crate) const BRIDGE_WORKSPACE: &str = include_str!("../../../r/rho.bridge/R/workspace.R");
pub(crate) const BRIDGE_COMPLETION: &str = include_str!("../../../r/rho.bridge/R/completion.R");
pub(crate) const BRIDGE_LINTR: &str = include_str!("../../../r/rho.bridge/R/lintr.R");
pub(crate) const BRIDGE_TARGETS: &str = include_str!("../../../r/rho.bridge/R/targets.R");
pub(crate) const BRIDGE_FORMATTING: &str = include_str!("../../../r/rho.bridge/R/formatting.R");
pub(crate) const AGENT_STATE: &str = include_str!("../../../r/rho.agent/R/aaa-state.R");
pub(crate) const AGENT_TRANSPORT: &str = include_str!("../../../r/rho.agent/R/transport.R");
pub(crate) const AGENT_ADAPTER: &str = include_str!("../../../r/rho.agent/R/aisdk_adapter.R");
#[derive(Clone)]
pub(crate) struct RuntimeConfig {
    pub(crate) data_dir: PathBuf,
    pub(crate) kernelspec: PathBuf,
    pub(crate) rscript: PathBuf,
    pub(crate) r_version: String,
    pub(crate) r_home: String,
    pub(crate) r_libs: String,
    pub(crate) path_sep: String,
    pub(crate) process_path: OsString,
    pub(crate) r_profile_user: Option<PathBuf>,
    pub(crate) r_environ_user: Option<PathBuf>,
    pub(crate) bridge_package: PathBuf,
    pub(crate) agent_package: PathBuf,
    pub(crate) agent_runtime: AgentRuntimeStatus,
    pub(crate) store_path: PathBuf,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StartupSeverity {
    Recoverable,
    Fatal,
}

#[derive(Clone, Serialize, specta::Type)]
pub(crate) struct StartupIssue {
    pub(crate) code: String,
    pub(crate) phase: String,
    pub(crate) severity: StartupSeverity,
    pub(crate) title: String,
    pub(crate) message: String,
    pub(crate) technical_detail: String,
    pub(crate) actions: Vec<String>,
    pub(crate) diagnostics_path: String,
}

#[derive(Clone, Serialize, specta::Type)]
pub(crate) struct StartupRuntimeView {
    pub(crate) rscript: String,
    pub(crate) r_version: String,
    pub(crate) agent_runtime: AgentRuntimeStatus,
}

#[derive(Clone, Serialize, specta::Type)]
pub(crate) struct StartupView {
    pub(crate) phase: String,
    pub(crate) busy: bool,
    pub(crate) runtime: Option<StartupRuntimeView>,
    pub(crate) issue: Option<StartupIssue>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub(crate) struct AgentDependencyStatus {
    pub(crate) package: String,
    pub(crate) status: String,
    pub(crate) installed_version: Option<String>,
    pub(crate) required_version: String,
    pub(crate) resolved_path: Option<String>,
    pub(crate) detail: Option<String>,
    pub(crate) remediation: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub(crate) struct AgentRuntimeStatus {
    pub(crate) available: bool,
    #[serde(default = "default_agent_runtime_status")]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) rscript: Option<String>,
    #[serde(default)]
    pub(crate) r_version: Option<String>,
    pub(crate) aisdk_version: Option<String>,
    #[serde(default)]
    pub(crate) provider_adapters_available: bool,
    #[serde(default = "default_provider_health")]
    pub(crate) provider_health: String,
    #[serde(default)]
    pub(crate) dependencies: Vec<AgentDependencyStatus>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub(crate) struct AgentRuntimeStatusView {
    pub(crate) available: bool,
    pub(crate) status: String,
    pub(crate) rscript: Option<String>,
    pub(crate) r_version: Option<String>,
    pub(crate) aisdk_version: Option<String>,
    pub(crate) provider_adapters_available: bool,
    pub(crate) provider_health: String,
    pub(crate) dependencies: Vec<AgentDependencyStatus>,
    pub(crate) error: Option<String>,
}

impl From<AgentRuntimeStatus> for AgentRuntimeStatusView {
    fn from(status: AgentRuntimeStatus) -> Self {
        Self {
            available: status.available,
            status: status.status,
            rscript: status.rscript,
            r_version: status.r_version,
            aisdk_version: status.aisdk_version,
            provider_adapters_available: status.provider_adapters_available,
            provider_health: status.provider_health,
            dependencies: status.dependencies,
            error: status.error,
        }
    }
}

#[cfg(test)]
pub(crate) fn deferred_agent_runtime_status() -> AgentRuntimeStatus {
    deferred_agent_runtime_status_for(None, None)
}

pub(crate) fn deferred_agent_runtime_status_for(
    rscript: Option<&Path>,
    r_version: Option<&str>,
) -> AgentRuntimeStatus {
    AgentRuntimeStatus {
        available: false,
        status: "checking".to_string(),
        rscript: rscript.map(normalized_display_path),
        r_version: r_version.map(str::to_string),
        aisdk_version: None,
        provider_adapters_available: false,
        provider_health: "not_checked".to_string(),
        dependencies: vec![
            checking_agent_dependency("aisdk", MINIMUM_AGENT_AISDK_VERSION),
            checking_agent_dependency("aisdk.providers", MINIMUM_AGENT_AISDK_PROVIDERS_VERSION),
        ],
        error: Some("Agent runtime check is continuing in the background.".to_string()),
    }
}

pub(crate) fn default_agent_runtime_status() -> String {
    "needs_attention".to_string()
}

pub(crate) fn default_provider_health() -> String {
    "not_checked".to_string()
}

pub(crate) fn checking_agent_dependency(
    package: &str,
    required_version: &str,
) -> AgentDependencyStatus {
    AgentDependencyStatus {
        package: package.to_string(),
        status: "checking".to_string(),
        installed_version: None,
        required_version: required_version.to_string(),
        resolved_path: None,
        detail: None,
        remediation: None,
    }
}

pub(crate) fn normalized_display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[derive(Debug)]
pub(crate) struct RRuntimeProbe {
    pub(crate) r_home: String,
    pub(crate) r_bin: String,
    pub(crate) r_arch: String,
    pub(crate) path_sep: String,
    pub(crate) r_version: String,
    pub(crate) r_libs: String,
    pub(crate) r_profile_user: Option<PathBuf>,
    pub(crate) r_environ_user: Option<PathBuf>,
}

pub(crate) const RUNTIME_CACHE_VERSION: u32 = 2;
pub(crate) const MINIMUM_AGENT_AISDK_VERSION: &str = "1.5.0";
pub(crate) const MINIMUM_AGENT_AISDK_PROVIDERS_VERSION: &str = "0.1.0";
pub(crate) const REVIEWED_AISDK_REMOTE: &str =
    "YuLab-SMU/aisdk@1e2fa54358dda647a6d5cbf64c0625642c673e4c";
pub(crate) const REVIEWED_AISDK_PROVIDERS_REMOTE: &str =
    "YuLab-SMU/aisdk.providers@5cf315e5eedad7d83b224c96595da346e1192a85";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct RuntimeFileSignature {
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) modified_unix_ms: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct RuntimeCacheFile {
    pub(crate) version: u32,
    pub(crate) rscript: RuntimeFileSignature,
    pub(crate) ark: RuntimeFileSignature,
    pub(crate) r_profile_user: Option<RuntimeFileSignature>,
    pub(crate) r_environ_user: Option<RuntimeFileSignature>,
    pub(crate) r_home: String,
    pub(crate) r_bin: String,
    pub(crate) r_arch: String,
    pub(crate) path_sep: String,
    pub(crate) r_version: String,
    pub(crate) r_libs: String,
}

pub(crate) struct ProbeProcessOutput {
    pub(crate) success: bool,
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) elapsed_ms: u128,
    pub(crate) timed_out: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum RProbeStartup {
    Controlled,
    UserProfile,
}

#[derive(Clone, Copy)]
pub(crate) struct RUserStartupFiles<'a> {
    pub(crate) profile: Option<&'a Path>,
    pub(crate) environ: Option<&'a Path>,
}

pub(crate) static STARTUP_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn runtime_config(state: &AppState) -> Result<RuntimeConfig> {
    state
        .config
        .read()
        .map_err(|_| anyhow::anyhow!("STARTUP_NOT_READY: runtime state lock is unavailable"))?
        .clone()
        .context("STARTUP_NOT_READY: finish Rho startup before using the workbench")
}

pub(crate) fn current_startup_view(state: &AppState) -> StartupView {
    state
        .startup
        .read()
        .map(|view| view.clone())
        .unwrap_or_else(|_| StartupView {
            phase: "failed".to_string(),
            busy: false,
            runtime: None,
            issue: Some(startup_issue(
                "APP_STATE_UNAVAILABLE",
                "shell_ready",
                StartupSeverity::Fatal,
                "Rho could not read its startup state",
                "Restart Rho. If the problem continues, open the diagnostic log.",
                "startup state lock was poisoned".to_string(),
                vec!["open_log".to_string(), "exit".to_string()],
            )),
        })
}

pub(crate) async fn bootstrap_runtime(state: &AppState, selected: Option<PathBuf>) -> StartupView {
    if selected.is_none()
        && state
            .config
            .read()
            .map(|config| config.is_some())
            .unwrap_or(false)
    {
        return current_startup_view(state);
    }
    if let Ok(mut view) = state.startup.write() {
        if view.busy {
            return view.clone();
        }
        view.phase = "probing_runtime".to_string();
        view.busy = true;
        view.issue = None;
    }

    if let Some(path) = selected {
        if let Ok(mut preferred) = state.selected_rscript.write() {
            *preferred = Some(path.clone());
        }
        if let Err(error) = persist_selected_rscript(&state.data_dir, &path) {
            write_startup_log(&format!("Could not persist selected Rscript: {error:#}"));
        }
    }

    let data_dir = state.data_dir.clone();
    let ark = state.ark.clone();
    let preferred = state
        .selected_rscript
        .read()
        .ok()
        .and_then(|path| path.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        prepare_runtime_files_with_rscript(data_dir, ark, preferred.as_deref())
    })
    .await;

    let view = match result {
        Ok(Ok(config)) => {
            git::set_process_path(config.process_path.clone());
            let runtime = StartupRuntimeView {
                rscript: config.rscript.to_string_lossy().replace('\\', "/"),
                r_version: config.r_version.clone(),
                agent_runtime: config.agent_runtime.clone(),
            };
            if let Ok(mut stored) = state.config.write() {
                *stored = Some(config);
            }
            write_startup_log("Runtime bootstrap completed");
            StartupView {
                phase: "runtime_ready".to_string(),
                busy: false,
                runtime: Some(runtime),
                issue: None,
            }
        }
        Ok(Err(error)) => {
            let detail = format!("{error:#}");
            write_startup_log(&format!("Runtime bootstrap failed: {detail}"));
            StartupView {
                phase: "needs_attention".to_string(),
                busy: false,
                runtime: None,
                issue: Some(classify_startup_error(&detail)),
            }
        }
        Err(error) => {
            let detail = format!("runtime bootstrap task failed: {error}");
            write_startup_log(&detail);
            StartupView {
                phase: "needs_attention".to_string(),
                busy: false,
                runtime: None,
                issue: Some(startup_issue(
                    "R_PROBE_SPAWN_FAILED",
                    "probing_base_r",
                    StartupSeverity::Recoverable,
                    "Rho could not check R",
                    &format!(
                        "Retry the check or choose {} manually.",
                        platform::rscript_display_name()
                    ),
                    detail,
                    startup_recovery_actions(),
                )),
            }
        }
    };
    if let Ok(mut stored) = state.startup.write() {
        *stored = view.clone();
    }
    view
}

pub(crate) fn write_source(path: &Path, content: &str) -> Result<()> {
    atomic_write(path, content.as_bytes())
}

pub(crate) fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(crate) fn display_error_chain(error: &anyhow::Error) -> String {
    bounded_diagnostic(&format!("{error:#}"))
}

pub(crate) fn startup_log_path() -> PathBuf {
    STARTUP_LOG_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("rho-desktop-startup.log"))
}

pub(crate) fn initialize_startup_log(data_dir: &Path) {
    let directory = data_dir.join("logs");
    let path = if std::fs::create_dir_all(&directory).is_ok() {
        directory.join("startup.jsonl")
    } else {
        std::env::temp_dir().join("rho-desktop-startup.log")
    };
    let _ = STARTUP_LOG_PATH.set(path);
}

pub(crate) fn write_startup_log(message: &str) {
    write_startup_event(json!({ "message": bounded_diagnostic(message) }));
}

pub(crate) fn write_startup_event(event: Value) {
    let path = startup_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let timestamp = chrono::Utc::now().to_rfc3339();
        let envelope = json!({
            "timestamp": timestamp,
            "event": event,
        });
        let _ = writeln!(file, "{envelope}");
    }
}

pub(crate) fn selected_rscript_path(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime").join("selected-rscript.txt")
}

pub(crate) fn load_selected_rscript(data_dir: &Path) -> Option<PathBuf> {
    std::fs::read_to_string(selected_rscript_path(data_dir))
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
}

pub(crate) fn persist_selected_rscript(data_dir: &Path, path: &Path) -> Result<()> {
    if let Some(parent) = selected_rscript_path(data_dir).parent() {
        std::fs::create_dir_all(parent)?;
    }
    atomic_write(
        &selected_rscript_path(data_dir),
        path.to_string_lossy().as_bytes(),
    )
}

pub(crate) fn startup_recovery_actions() -> Vec<String> {
    vec![
        "retry".to_string(),
        "choose_rscript".to_string(),
        "copy_diagnostics".to_string(),
        "open_log".to_string(),
        "exit".to_string(),
    ]
}

pub(crate) fn startup_issue(
    code: &str,
    phase: &str,
    severity: StartupSeverity,
    title: &str,
    message: &str,
    technical_detail: String,
    actions: Vec<String>,
) -> StartupIssue {
    StartupIssue {
        code: code.to_string(),
        phase: phase.to_string(),
        severity,
        title: title.to_string(),
        message: message.to_string(),
        technical_detail,
        actions,
        diagnostics_path: startup_log_path().to_string_lossy().replace('\\', "/"),
    }
}

pub(crate) fn classify_startup_error(detail: &str) -> StartupIssue {
    let (code, phase, title, message, actions): (&str, &str, &str, String, Vec<String>) =
        if detail.contains("bundled Ark executable") {
            (
                "ARK_RESOURCE_MISSING",
                "checking_installation",
                "Rho installation needs repair",
                "The bundled Workspace R engine is missing. Reinstall Rho, then retry.".to_string(),
                vec![
                    "retry".to_string(),
                    "open_log".to_string(),
                    "exit".to_string(),
                ],
            )
        } else if detail.contains("selected Rscript path") || detail.contains("RHO_RSCRIPT") {
            (
                "R_PATH_INVALID",
                "locating_r",
                "The selected R installation is unavailable",
                format!(
                    "Choose {} from an R 4.4 or later installation.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        } else if detail.contains("R_ARCH_MISMATCH") {
            (
                "R_ARCH_MISMATCH",
                "probing_base_r",
                "This R architecture is not supported",
                platform::r_architecture_requirement_message().to_string(),
                startup_recovery_actions(),
            )
        } else if detail.contains("Rscript was not found")
            || detail.contains("Rscript.exe was not found")
        {
            (
                "R_NOT_FOUND",
                "locating_r",
                "R was not found",
                format!(
                    "Rho requires R 4.4 or later. Install R or choose {} manually.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        } else if detail.contains("requires R 4.4") {
            (
                "R_VERSION_UNSUPPORTED",
                "probing_base_r",
                "This R version is not supported",
                "Choose an R 4.4 or later installation, then retry.".to_string(),
                startup_recovery_actions(),
            )
        } else if detail.contains("timed_out=true") {
            (
                "R_PROBE_TIMED_OUT",
                "probing_base_r",
                "R took too long to start",
                format!(
                    "Retry the runtime check or choose another {}.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        } else if detail.contains("R runtime probe failed") {
            (
                "R_PROBE_EXITED",
                "probing_base_r",
                "R could not complete its runtime check",
                format!(
                    "Your R installation was not changed. Retry or choose another {}.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        } else if detail.contains("absent from runtime probe") {
            (
                "R_PROBE_OUTPUT_INVALID",
                "probing_base_r",
                "R returned an incomplete runtime result",
                "Retry the runtime check and copy diagnostics if it continues.".to_string(),
                startup_recovery_actions(),
            )
        } else {
            (
                "R_PROBE_SPAWN_FAILED",
                "probing_base_r",
                "Rho could not prepare the R runtime",
                format!(
                    "Retry the check or choose {} manually.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        };
    startup_issue(
        code,
        phase,
        StartupSeverity::Recoverable,
        title,
        &message,
        detail.to_string(),
        actions,
    )
}
