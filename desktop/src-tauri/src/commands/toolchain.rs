use rho_toolchain::{DoctorStatus, doctor_for_target, load_target_registry};
use serde::Serialize;
use tauri::State;

use crate::AppState;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ToolchainDoctorCheckView {
    pub(crate) id: String,
    pub(crate) status: String,
    pub(crate) detail: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ToolchainDoctorView {
    pub(crate) status: String,
    pub(crate) configured: bool,
    pub(crate) rho_toml_sha256: Option<String>,
    pub(crate) target_id: String,
    pub(crate) target_registry_sha256: Option<String>,
    pub(crate) host_kind: String,
    pub(crate) isolation_kind: String,
    pub(crate) r_version: Option<String>,
    pub(crate) rscript: Option<String>,
    pub(crate) python_version: Option<String>,
    pub(crate) python: Option<String>,
    pub(crate) checks: Vec<ToolchainDoctorCheckView>,
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn toolchain_doctor(
    state: State<'_, AppState>,
) -> Result<ToolchainDoctorView, String> {
    let project_root = state.project_root.read().await.clone();
    if !project_root.join("rho.toml").exists() {
        return Ok(ToolchainDoctorView {
            status: "unmanaged".to_string(),
            configured: false,
            rho_toml_sha256: None,
            target_id: "local".to_string(),
            target_registry_sha256: None,
            host_kind: "local".to_string(),
            isolation_kind: "native".to_string(),
            r_version: None,
            rscript: None,
            python_version: None,
            python: None,
            checks: vec![ToolchainDoctorCheckView {
                id: "rho.toml".to_string(),
                status: "unmanaged".to_string(),
                detail: "No rho.toml; the current project runtime remains unmanaged.".to_string(),
            }],
        });
    }
    let rho_home = crate::agent_llm::agent_config::rho_home().map_err(crate::display_error)?;
    let expected_root = project_root.clone();
    let view = tauri::async_runtime::spawn_blocking(move || {
        let result = load_target_registry(&rho_home)
            .and_then(|targets| doctor_for_target(&project_root, &targets));
        match result {
            Ok(report) => ToolchainDoctorView {
                status: match report.status {
                    DoctorStatus::Ready => "ready",
                    DoctorStatus::Failed => "failed",
                }
                .to_string(),
                configured: true,
                rho_toml_sha256: Some(report.rho_toml_sha256),
                target_id: report.target_id,
                target_registry_sha256: report.target_registry_sha256,
                host_kind: report.host_kind,
                isolation_kind: report.isolation_kind,
                r_version: report.r_version,
                rscript: report
                    .rscript
                    .map(|path| path.to_string_lossy().into_owned()),
                python_version: report.python_version,
                python: report
                    .python
                    .map(|path| path.to_string_lossy().into_owned()),
                checks: report
                    .checks
                    .into_iter()
                    .map(|check| ToolchainDoctorCheckView {
                        id: check.id,
                        status: match check.status {
                            DoctorStatus::Ready => "ready",
                            DoctorStatus::Failed => "failed",
                        }
                        .to_string(),
                        detail: check.detail,
                    })
                    .collect(),
            },
            Err(error) => ToolchainDoctorView {
                status: "failed".to_string(),
                configured: true,
                rho_toml_sha256: None,
                target_id: "unknown".to_string(),
                target_registry_sha256: None,
                host_kind: "unknown".to_string(),
                isolation_kind: "unknown".to_string(),
                r_version: None,
                rscript: None,
                python_version: None,
                python: None,
                checks: vec![ToolchainDoctorCheckView {
                    id: "toolchain".to_string(),
                    status: "failed".to_string(),
                    detail: error.to_string(),
                }],
            },
        }
    })
    .await
    .map_err(|error| format!("Toolchain Doctor task failed: {error}"))?;
    if *state.project_root.read().await != expected_root {
        return Err("Toolchain Doctor result is stale after a project switch".to_string());
    }
    Ok(view)
}
