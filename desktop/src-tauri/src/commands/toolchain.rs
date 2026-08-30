use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use rho_toolchain::{
    CommandSpec, DoctorStatus, OperationKind, TargetAdmission, TargetAdmissionMode, admit_target,
    doctor_for_target, execute_journaled_operation, load_target_registry, load_toolchain_config,
    monitor_target_resource,
};
use serde::Serialize;
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

fn project_contains_r_source(project_root: &Path) -> Result<bool> {
    let mut pending = vec![project_root.to_path_buf()];
    let mut inspected = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            inspected += 1;
            if inspected > 2_000 {
                return Ok(false);
            }
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                let name = entry.file_name();
                if !matches!(
                    name.to_str(),
                    Some(".git" | ".rho" | "renv" | ".venv" | "node_modules" | "target")
                ) {
                    pending.push(path);
                }
            } else if file_type.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("r"))
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn r_home_from_rscript(rscript: &Path) -> Result<std::path::PathBuf> {
    let canonical = rscript
        .canonicalize()
        .context("resolving the Workspace Rscript")?;
    let mut home = canonical
        .parent()
        .context("Workspace Rscript has no parent directory")?;
    while home
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "bin" | "x64" | "i386"))
    {
        home = home
            .parent()
            .context("Workspace Rscript has an incomplete installation path")?;
    }
    Ok(home.to_path_buf())
}

fn runtime_exact_version(runtime: &crate::startup_runtime::RuntimeConfig) -> Result<String> {
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
    rho_toolchain::ExactVersion::parse(&version)?;
    Ok(version)
}

fn archive_invalid_toolchain_config(project_root: &Path) -> Result<()> {
    let source = project_root.join("rho.toml");
    if !source.exists() {
        return Ok(());
    }
    let recovery = project_root.join(".rho/toolchain/recovery");
    std::fs::create_dir_all(&recovery)?;
    std::fs::rename(
        source,
        recovery.join(format!("rho-{}.toml", Uuid::new_v4().simple())),
    )?;
    Ok(())
}

async fn local_toolchain_requires_repair(project_root: &Path, rho_home: &Path) -> Result<bool> {
    let root = project_root.to_path_buf();
    let home = rho_home.to_path_buf();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let targets = load_target_registry(&home)?;
        doctor_for_target(&root, &targets)
    })
    .await
    .context("automatic project environment diagnosis task failed")??;
    Ok(report.status != DoctorStatus::Ready
        || report
            .checks
            .iter()
            .any(|check| check.status != DoctorStatus::Ready))
}

pub(crate) async fn prepare_workspace_target_admission_for(
    state: &AppState,
    project_root: &std::path::Path,
) -> Result<Option<TargetAdmission>> {
    if !project_root.join("rho.toml").exists() {
        if !project_contains_r_source(project_root)? {
            return Ok(None);
        }
        initialize_project_automatically(state, project_root).await?;
    }
    let admit = |rho_home: std::path::PathBuf, root: std::path::PathBuf| async move {
        tauri::async_runtime::spawn_blocking(move || {
            let targets = load_target_registry(&rho_home)?;
            admit_target(&root, &targets, TargetAdmissionMode::Workspace)
        })
        .await
        .context("Workspace Target Admission task failed")?
        .map_err(anyhow::Error::from)
    };
    let rho_home = crate::agent_llm::agent_config::rho_home()?;
    let admission = match admit(rho_home.clone(), project_root.to_path_buf()).await {
        Ok(admission) => admission,
        Err(error) => match load_toolchain_config(project_root) {
            Ok(config) => {
                if config.config.compute.default_target != rho_toolchain::LOCAL_TARGET_ID
                    || config.config.runtime.r.is_none()
                    || !local_toolchain_requires_repair(project_root, &rho_home).await?
                {
                    return Err(error);
                }
                repair_project_automatically(state, project_root).await?;
                admit(rho_home, project_root.to_path_buf()).await?
            }
            Err(_) => {
                archive_invalid_toolchain_config(project_root)?;
                initialize_project_automatically(state, project_root).await?;
                admit(rho_home, project_root.to_path_buf()).await?
            }
        },
    };
    if admission.host_kind() != "local" || admission.isolation_kind() != "native" {
        bail!(
            "Workspace Target Admission selected {}/{}; this desktop build cannot substitute the local Ark runtime for that target",
            admission.host_kind(),
            admission.isolation_kind()
        );
    }
    let runtime = runtime_config(state)?;
    let runtime_version = runtime_exact_version(&runtime)?;
    ensure!(
        admission.doctor_report().r_version.as_deref() == Some(runtime_version.as_str()),
        "Workspace Target Admission resolved R {}, but desktop R {} is active",
        admission
            .doctor_report()
            .r_version
            .as_deref()
            .unwrap_or("unknown"),
        runtime_version
    );
    let admitted_r_home = r_home_from_rscript(
        admission
            .doctor_report()
            .rscript
            .as_deref()
            .context("Workspace Target Admission omitted the configured Rscript")?,
    )?;
    let runtime_r_home = r_home_from_rscript(&runtime.rscript)?;
    ensure!(
        admitted_r_home == runtime_r_home,
        "Workspace Target Admission resolved another R installation; restart Rho with the rho.toml runtime"
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
        "if (!requireNamespace('renv', quietly=TRUE)) quit(status=41); renv::init(project={project}, bare=TRUE, restart=FALSE); renv::install(c('jsonlite', 'pak'), project={project}); renv::snapshot(project={project}, prompt=FALSE)"
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

fn repair_local_project_toolchain(
    project_root: &Path,
    rscript: &Path,
    rho_home: &Path,
) -> Result<()> {
    let config = load_toolchain_config(project_root)?;
    ensure!(
        config.config.compute.default_target == rho_toolchain::LOCAL_TARGET_ID,
        "Automatic repair applies only to the local target"
    );
    ensure!(
        config.config.runtime.r.is_some(),
        "Automatic repair requires the managed R runtime"
    );
    let targets = load_target_registry(rho_home)?;
    let project = serde_json::to_string(&project_root.to_string_lossy().as_ref())?;
    let expression = format!(
        "if (!requireNamespace('renv', quietly=TRUE)) quit(status=41); renv::load(project={project}, quiet=TRUE); renv::restore(project={project}, prompt=FALSE); renv::install(c('jsonlite', 'pak')); renv::snapshot(project={project}, prompt=FALSE)"
    );
    execute_journaled_operation(
        &config,
        &format!("repair-{}", Uuid::new_v4().simple()),
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

async fn initialize_project_automatically(state: &AppState, project_root: &Path) -> Result<()> {
    let runtime = runtime_config(state)?;
    let version = runtime_exact_version(&runtime)?;
    let rho_home = crate::agent_llm::agent_config::rho_home()?;
    let root = project_root.to_path_buf();
    let rscript = runtime.rscript;
    tauri::async_runtime::spawn_blocking(move || {
        initialize_project_toolchain(&root, &rscript, &version, &rho_home)
    })
    .await
    .context("automatic project environment setup task failed")??;
    Ok(())
}

async fn repair_project_automatically(state: &AppState, project_root: &Path) -> Result<()> {
    let config = load_toolchain_config(project_root)?;
    if config.config.compute.default_target != rho_toolchain::LOCAL_TARGET_ID
        || config.config.runtime.r.is_none()
    {
        bail!("Automatic repair is unavailable for this target");
    }
    let runtime = runtime_config(state)?;
    let rho_home = crate::agent_llm::agent_config::rho_home()?;
    let root = project_root.to_path_buf();
    let rscript = runtime.rscript;
    tauri::async_runtime::spawn_blocking(move || {
        repair_local_project_toolchain(&root, &rscript, &rho_home)
    })
    .await
    .context("automatic project environment repair task failed")??;
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
    fn automatic_setup_discovery_does_not_follow_project_symlinks() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("outside.R"), "x <- 1").unwrap();
        symlink(outside.path(), project.path().join("linked")).unwrap();
        assert!(!project_contains_r_source(project.path()).unwrap());
        std::fs::write(project.path().join("analysis.R"), "x <- 1").unwrap();
        assert!(project_contains_r_source(project.path()).unwrap());
    }

    #[test]
    fn invalid_toolchain_config_is_preserved_before_automatic_rebuild() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("rho.toml"), "not valid toml = [").unwrap();
        archive_invalid_toolchain_config(project.path()).unwrap();
        assert!(!project.path().join("rho.toml").exists());
        let recovery = project.path().join(".rho/toolchain/recovery");
        let archived = std::fs::read_dir(recovery)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            std::fs::read_to_string(archived).unwrap(),
            "not valid toml = ["
        );
    }

    #[test]
    fn rscript_paths_with_and_without_bin_resolve_to_the_same_r_home() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("R");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(home.join("Rscript"), "").unwrap();
        std::fs::write(home.join("bin/Rscript"), "").unwrap();
        assert_eq!(
            r_home_from_rscript(&home.join("Rscript")).unwrap(),
            r_home_from_rscript(&home.join("bin/Rscript")).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn automatic_setup_journals_renv_before_reporting_managed_state() {
        use std::os::unix::fs::PermissionsExt;

        let project = tempfile::tempdir().unwrap();
        let rho_home = tempfile::tempdir().unwrap();
        let rscript = project.path().join("fake-rscript");
        std::fs::write(
            &rscript,
            "#!/bin/sh\nprintf '%s' \"$*\" > invocation.txt\nmkdir -p renv\ntouch .Rprofile renv.lock renv/activate.R\n",
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
        assert_eq!(std::fs::read_dir(&operations).unwrap().count(), 1);

        repair_local_project_toolchain(project.path(), &rscript, rho_home.path()).unwrap();
        assert_eq!(std::fs::read_dir(operations).unwrap().count(), 2);
        assert!(
            std::fs::read_to_string(project.path().join("invocation.txt"))
                .unwrap()
                .contains("renv::load")
        );
    }
}
