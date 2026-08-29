use rho_toolchain::{DoctorStatus, doctor};
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
    let expected_root = project_root.clone();
    let view = tauri::async_runtime::spawn_blocking(move || match doctor(&project_root) {
        Ok(report) => ToolchainDoctorView {
            status: match report.status {
                DoctorStatus::Ready => "ready",
                DoctorStatus::Failed => "failed",
            }
            .to_string(),
            configured: true,
            rho_toml_sha256: Some(report.rho_toml_sha256),
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
    })
    .await
    .map_err(|error| format!("Toolchain Doctor task failed: {error}"))?;
    if *state.project_root.read().await != expected_root {
        return Err("Toolchain Doctor result is stale after a project switch".to_string());
    }
    Ok(view)
}
