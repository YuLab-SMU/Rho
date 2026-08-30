use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use rho_toolchain::{
    CommandSpec, DoctorStatus, OperationKind, TargetAdmission, TargetAdmissionMode, admit_target,
    doctor_for_target, execute_journaled_operation, load_target_registry, load_toolchain_config,
    monitor_target_resource,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::AppState;
use crate::application_state::ResourceGovernanceCache;
use crate::startup_runtime::runtime_config;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ToolchainDoctorCheckView {
    pub(crate) id: String,
    pub(crate) status: String,
    pub(crate) detail: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub(crate) struct ToolchainInitializeRequest {
    confirmed: bool,
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

pub(crate) async fn prepare_workspace_target_admission_for(
    state: &AppState,
    project_root: &std::path::Path,
) -> Result<Option<TargetAdmission>> {
    if !project_root.join("rho.toml").exists() {
        return Ok(None);
    }
    let rho_home = crate::agent_llm::agent_config::rho_home()?;
    let root_for_task = project_root.to_path_buf();
    let admission = tauri::async_runtime::spawn_blocking(move || {
        let targets = load_target_registry(&rho_home)?;
        admit_target(&root_for_task, &targets, TargetAdmissionMode::Workspace)
    })
    .await
    .context("Workspace Target Admission task failed")??;
    if admission.host_kind() != "local" || admission.isolation_kind() != "native" {
        bail!(
            "Workspace Target Admission selected {}/{}; this desktop build cannot substitute the local Ark runtime for that target",
            admission.host_kind(),
            admission.isolation_kind()
        );
    }
    let runtime = runtime_config(state)?;
    let admitted_rscript = admission
        .doctor_report()
        .rscript
        .as_ref()
        .context("Workspace Target Admission omitted the configured Rscript")?
        .canonicalize()
        .context("resolving the admitted Workspace Rscript")?;
    let runtime_rscript = runtime
        .rscript
        .canonicalize()
        .context("resolving the desktop Workspace Rscript")?;
    ensure!(
        admitted_rscript == runtime_rscript,
        "Workspace Target Admission resolved another Rscript; restart Rho with the rho.toml runtime"
    );
    Ok(Some(admission))
}

pub(crate) async fn prepare_workspace_target_admission(
    state: &AppState,
) -> Result<Option<TargetAdmission>> {
    let project_root = state.project_root.read().await.clone();
    *state.target_admission.write().await = None;
    *state.resource_governance.write().await = None;
    let admission = prepare_workspace_target_admission_for(state, &project_root).await?;
    ensure!(
        *state.project_root.read().await == project_root,
        "Workspace Target Admission is stale after a project switch"
    );
    Ok(admission)
}

pub(crate) async fn require_target_admission(
    state: &AppState,
    mode: TargetAdmissionMode,
) -> Result<Option<TargetAdmission>> {
    let project_root = state.project_root.read().await.clone();
    let configured = project_root.join("rho.toml").exists();
    let cached = state.target_admission.read().await.clone();
    if !configured {
        if cached.is_some() {
            bail!("rho.toml changed after Workspace Target Admission; restart Workspace R");
        }
        return Ok(None);
    }
    let cached = cached
        .context("Target Admission is unavailable for the managed project; restart Workspace R")?;
    let governance = state
        .resource_governance
        .read()
        .await
        .clone()
        .filter(|governance| {
            governance.project_root == project_root
                && governance.rho_toml_sha256 == cached.rho_toml_sha256()
                && governance.target_registry_sha256.as_deref() == cached.target_registry_sha256()
                && governance.target_id == cached.target_id()
                && governance.observed_at.elapsed() <= std::time::Duration::from_secs(15)
        });
    if let Some(governance) = governance.as_ref()
        && !governance.admission_allowed
    {
        bail!(
            "Resource governance blocks target {}: {}",
            governance.target_id,
            governance.reasons.join("; ")
        );
    }
    let refresh_governance = governance.is_none();
    let rho_home = crate::agent_llm::agent_config::rho_home()?;
    let root_for_task = project_root.clone();
    let (admission, refreshed) = tauri::async_runtime::spawn_blocking(move || {
        let config = load_toolchain_config(&root_for_task)?;
        let targets = load_target_registry(&rho_home)?;
        let admission = cached.for_mode(&config, &targets, mode)?;
        let refreshed = if refresh_governance {
            Some((
                monitor_target_resource(&root_for_task, &targets, admission.target_id())?,
                config.sha256,
                targets.sha256,
            ))
        } else {
            None
        };
        Ok::<_, rho_toolchain::ToolchainError>((admission, refreshed))
    })
    .await
    .context("Target Admission validation task failed")??;
    ensure!(
        *state.project_root.read().await == project_root,
        "Target Admission is stale after a project switch"
    );
    if let Some((resources, rho_toml_sha256, target_registry_sha256)) = refreshed {
        let governance = ResourceGovernanceCache {
            project_root,
            rho_toml_sha256,
            target_registry_sha256,
            target_id: resources.target_id.clone(),
            observed_at: std::time::Instant::now(),
            admission_allowed: resources.admission_allowed,
            reasons: resources.governance_reasons.clone(),
        };
        let allowed = governance.admission_allowed;
        let reason = governance.reasons.join("; ");
        *state.resource_governance.write().await = Some(governance);
        if !allowed {
            bail!(
                "Resource governance blocks target {}: {}",
                admission.target_id(),
                reason
            );
        }
    }
    Ok(Some(admission))
}

fn initialize_project_toolchain(
    project_root: &Path,
    rscript: &Path,
    version: &str,
    rho_home: &Path,
) -> Result<()> {
    let source = format!(
        "schema = 2\n\n[runtime.r]\nversion = {quoted}\nmanager = \"rig\"\nenvironment = \"renv\"\nlockfile = \"renv.lock\"\ninstaller = \"pak\"\n\n[compute]\ndefault_target = \"local\"\nrequired_capabilities = [\"cpu\"]\n",
        quoted = serde_json::to_string(version)?,
    );
    crate::project::atomic_write(&project_root.join("rho.toml"), source.as_bytes())?;
    let config = load_toolchain_config(project_root)?;
    let targets = load_target_registry(rho_home)?;
    let project = serde_json::to_string(&project_root.to_string_lossy().as_ref())?;
    let expression = format!(
        "if (!requireNamespace('renv', quietly=TRUE)) quit(status=41); renv::init(project={project}, bare=TRUE, restart=FALSE); renv::snapshot(project={project}, prompt=FALSE)"
    );
    execute_journaled_operation(
        &config,
        &format!("initialize-{}", Uuid::new_v4().simple()),
        OperationKind::Sync,
        &[CommandSpec {
            program: rscript.to_path_buf(),
            args: vec!["--vanilla".to_string(), "-e".to_string(), expression],
            cwd: project_root.to_path_buf(),
            env: BTreeMap::new(),
        }],
        &targets,
        true,
    )?;
    Ok(())
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn toolchain_initialize(
    request: ToolchainInitializeRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !request.confirmed {
        return Err("Project environment setup requires explicit confirmation".to_string());
    }
    let project_root = state.project_root.read().await.clone();
    if project_root.join("rho.toml").exists() {
        return Err("rho.toml already exists; refresh Toolchains instead".to_string());
    }
    let runtime = runtime_config(&state).map_err(crate::display_error)?;
    let version = runtime
        .r_version
        .split_whitespace()
        .find(|value| {
            value
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        })
        .unwrap_or(runtime.r_version.as_str())
        .trim()
        .to_string();
    rho_toolchain::ExactVersion::parse(&version).map_err(crate::display_error)?;
    let root_for_task = project_root.clone();
    let rscript = runtime.rscript.clone();
    let rho_home = crate::agent_llm::agent_config::rho_home().map_err(crate::display_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        initialize_project_toolchain(&root_for_task, &rscript, &version, &rho_home)
    })
    .await
    .map_err(|error| format!("Toolchain initialization task failed: {error}"))?
    .map_err(crate::display_error)?;
    if *state.project_root.read().await != project_root {
        return Err("Toolchain initialization became stale after a project switch".to_string());
    }
    *state.target_admission.write().await = None;
    *state.resource_governance.write().await = None;
    Ok(())
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn toolchain_doctor(
    state: State<'_, AppState>,
) -> Result<ToolchainDoctorView, String> {
    let project_root = state.project_root.read().await.clone();
    if !project_root.join("rho.toml").exists() {
        let runtime = runtime_config(&state).ok();
        return Ok(ToolchainDoctorView {
            status: "unmanaged".to_string(),
            configured: false,
            rho_toml_sha256: None,
            target_id: "local".to_string(),
            target_registry_sha256: None,
            host_kind: "local".to_string(),
            isolation_kind: "native".to_string(),
            r_version: runtime.as_ref().map(|runtime| runtime.r_version.clone()),
            rscript: runtime
                .as_ref()
                .map(|runtime| runtime.rscript.to_string_lossy().into_owned()),
            python_version: None,
            python: None,
            checks: vec![
                ToolchainDoctorCheckView {
                    id: "workspace-r".to_string(),
                    status: if runtime.is_some() { "ready" } else { "failed" }.to_string(),
                    detail: runtime.as_ref().map_or_else(
                        || "The startup R runtime is unavailable.".to_string(),
                        |runtime| {
                            format!(
                                "Detected R {} at {}",
                                runtime.r_version,
                                runtime.rscript.display()
                            )
                        },
                    ),
                },
                ToolchainDoctorCheckView {
                    id: "rho.toml".to_string(),
                    status: "unmanaged".to_string(),
                    detail: "No rho.toml yet; Rho can initialize this project automatically."
                        .to_string(),
                },
            ],
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn automatic_setup_journals_renv_before_reporting_managed_state() {
        use std::os::unix::fs::PermissionsExt;

        let project = tempfile::tempdir().unwrap();
        let rho_home = tempfile::tempdir().unwrap();
        let rscript = project.path().join("fake-rscript");
        std::fs::write(
            &rscript,
            "#!/bin/sh\nmkdir -p renv\ntouch .Rprofile renv.lock renv/activate.R\n",
        )
        .unwrap();
        std::fs::set_permissions(&rscript, std::fs::Permissions::from_mode(0o700)).unwrap();

        initialize_project_toolchain(project.path(), &rscript, "4.5.2", rho_home.path()).unwrap();
        let config = load_toolchain_config(project.path()).unwrap();
        assert_eq!(config.config.schema, 2);
        assert_eq!(
            config.config.runtime.r.unwrap().version.to_string(),
            "4.5.2"
        );
        assert!(project.path().join("renv.lock").is_file());
        let operations = project.path().join(".rho/toolchain/operations");
        assert_eq!(std::fs::read_dir(operations).unwrap().count(), 1);
    }
}
