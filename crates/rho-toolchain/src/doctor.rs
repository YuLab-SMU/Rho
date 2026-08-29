use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::config::hex_sha256;
use crate::rig::rig_inventory_command;
use crate::{
    CommandSpec, ComputeHost, ComputeIsolation, ComputeTarget, LOCAL_TARGET_ID,
    TargetRegistryDocument, ToolchainConfigDocument, ToolchainError, load_toolchain_config,
    parse_rig_inventory, resolve_r_installation,
};

const MAX_DOCTOR_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorStatus {
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DoctorCheck {
    pub id: String,
    pub status: DoctorStatus,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DoctorReport {
    pub schema_version: u16,
    pub status: DoctorStatus,
    pub project_root: PathBuf,
    pub rho_toml_sha256: String,
    pub target_id: String,
    pub target_registry_sha256: Option<String>,
    pub host_kind: String,
    pub isolation_kind: String,
    pub r_version: Option<String>,
    pub rscript: Option<PathBuf>,
    pub python_version: Option<String>,
    pub python: Option<PathBuf>,
    pub checks: Vec<DoctorCheck>,
}

pub fn doctor(project_root: &Path) -> Result<DoctorReport, ToolchainError> {
    let config = load_toolchain_config(project_root)?;
    doctor_with_target(
        &config,
        LOCAL_TARGET_ID,
        &ComputeTarget::local_native(),
        None,
    )
}

pub fn doctor_for_target(
    project_root: &Path,
    targets: &TargetRegistryDocument,
) -> Result<DoctorReport, ToolchainError> {
    let config = load_toolchain_config(project_root)?;
    let target_id = &config.config.compute.default_target;
    let target = targets.registry.resolve(target_id)?;
    doctor_with_target(&config, target_id, target, targets.sha256.clone())
}

fn doctor_with_target(
    config: &ToolchainConfigDocument,
    target_id: &str,
    target: &ComputeTarget,
    target_registry_sha256: Option<String>,
) -> Result<DoctorReport, ToolchainError> {
    let mut report = DoctorReport {
        schema_version: 1,
        status: DoctorStatus::Ready,
        project_root: config.project_root.clone(),
        rho_toml_sha256: config.sha256.clone(),
        target_id: target_id.to_string(),
        target_registry_sha256,
        host_kind: target.host_kind().to_string(),
        isolation_kind: target.isolation_kind().to_string(),
        r_version: None,
        rscript: None,
        python_version: None,
        python: None,
        checks: vec![ready("rho.toml", "strict configuration loaded")],
    };
    let missing_capabilities = config
        .config
        .compute
        .required_capabilities
        .iter()
        .filter(|capability| !target.capabilities.contains(capability))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_capabilities.is_empty() {
        report.checks.push(failed(
            "target-capabilities",
            format!("target lacks {}", missing_capabilities.join(", ")),
        ));
    }
    if !matches!(target.host, ComputeHost::Local)
        || !matches!(target.isolation, ComputeIsolation::Native)
    {
        report.checks.push(failed(
            "target-adapter",
            format!(
                "{}/{} execution adapter is not admitted yet",
                target.host_kind(),
                target.isolation_kind()
            ),
        ));
        report.status = DoctorStatus::Failed;
        return Ok(report);
    }

    if let Some(r) = &config.config.runtime.r {
        match doctor_r(config, r.version.to_string(), &r.lockfile) {
            Ok((rscript, checks)) => {
                report.r_version = Some(r.version.to_string());
                report.rscript = Some(rscript);
                report.checks.extend(checks);
            }
            Err(error) => report.checks.push(failed("r", bounded(&error.to_string()))),
        }
    }
    if let Some(python) = &config.config.runtime.python {
        match doctor_python(config, python.version.to_string()) {
            Ok((executable, checks)) => {
                report.python_version = Some(python.version.to_string());
                report.python = Some(executable);
                report.checks.extend(checks);
            }
            Err(error) => report
                .checks
                .push(failed("python", bounded(&error.to_string()))),
        }
    }
    report.status = if report
        .checks
        .iter()
        .all(|check| check.status == DoctorStatus::Ready)
    {
        DoctorStatus::Ready
    } else {
        DoctorStatus::Failed
    };
    Ok(report)
}

fn doctor_r(
    config: &ToolchainConfigDocument,
    exact_version: String,
    lockfile: &str,
) -> Result<(PathBuf, Vec<DoctorCheck>), ToolchainError> {
    let rig = find_program("rig")
        .ok_or_else(|| ToolchainError::CommandStart("rig was not found on PATH".to_string()))?;
    let inventory_output = execute(&rig_inventory_command(&rig, &config.project_root))?;
    let inventory = parse_rig_inventory(&inventory_output)?;
    let expected = crate::ExactVersion::parse(&exact_version)?;
    let installation = resolve_r_installation(&inventory, &expected)?;
    let rscript = installation.rscript()?;
    let version_output = execute(&CommandSpec {
        program: rscript.clone(),
        args: vec!["--version".to_string()],
        cwd: config.project_root.clone(),
        env: Default::default(),
    })?;
    if !String::from_utf8_lossy(&version_output).contains(&exact_version) {
        return Err(ToolchainError::CommandFailed(format!(
            "Rscript does not report exact R {exact_version}"
        )));
    }
    let renv_lock = config.resolve_project_path(lockfile)?;
    let activate = config.project_root.join("renv").join("activate.R");
    let profile = config.project_root.join(".Rprofile");
    regular_file(&renv_lock, lockfile)?;
    regular_file(&activate, "renv/activate.R")?;
    regular_file(&profile, ".Rprofile")?;
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    execute(&CommandSpec {
        program: rscript.clone(),
        args: vec![
            "--no-save".to_string(),
            "-e".to_string(),
            "if (!(requireNamespace(\"renv\", quietly=TRUE) && requireNamespace(\"pak\", quietly=TRUE))) quit(status=41)".to_string(),
        ],
        cwd: config.project_root.clone(),
        env: std::collections::BTreeMap::from([
            ("R_PROFILE_USER".to_string(), null_device.to_string()),
            ("R_ENVIRON_USER".to_string(), null_device.to_string()),
        ]),
    })?;
    let project = serde_json::to_string(&config.project_root.to_string_lossy().as_ref())?;
    let expression = format!(
        "renv::load(project={project}, quiet=TRUE); result <- renv::status(project={project}, sources=FALSE); locked <- result$lockfile$Packages; installed <- result$library$Packages; locked_names <- sort(names(locked)); installed_names <- sort(names(installed)); same_versions <- all(locked_names %in% installed_names) && all(vapply(locked_names, function(name) identical(locked[[name]]$Version, installed[[name]]$Version), logical(1))); jsonlite_version <- if (requireNamespace(\"jsonlite\", quietly=TRUE)) as.character(packageVersion(\"jsonlite\")) else \"\"; cat(\"RHO_RENV_SYNCHRONIZED=\", if (isTRUE(same_versions)) \"true\" else \"false\", \"\\n\", sep=\"\"); cat(\"RHO_JSONLITE_VERSION=\", jsonlite_version, \"\\n\", sep=\"\"); cat(\"RHO_PROJECT_LIBRARY=\", renv::paths$library(project={project}), \"\\n\", sep=\"\")"
    );
    let project_probe = execute(&CommandSpec {
        program: rscript.clone(),
        args: vec!["--no-save".to_string(), "-e".to_string(), expression],
        cwd: config.project_root.clone(),
        env: std::collections::BTreeMap::from([
            ("R_PROFILE_USER".to_string(), null_device.to_string()),
            ("R_ENVIRON_USER".to_string(), null_device.to_string()),
            ("RENV_CONFIG_AUTO_SNAPSHOT".to_string(), "FALSE".to_string()),
        ]),
    })?;
    let project_probe = String::from_utf8_lossy(&project_probe);
    let synchronized = marker(&project_probe, "RHO_RENV_SYNCHRONIZED=");
    let jsonlite = marker(&project_probe, "RHO_JSONLITE_VERSION=");
    let library = marker(&project_probe, "RHO_PROJECT_LIBRARY=");
    if synchronized.as_deref() != Some("true")
        || jsonlite.as_deref().is_none_or(str::is_empty)
        || library
            .as_deref()
            .is_none_or(|path| !Path::new(path).starts_with(&config.project_root))
    {
        return Err(ToolchainError::CommandFailed(
            "renv lock, project library, or jsonlite is not ready".to_string(),
        ));
    }
    let library = library.unwrap();
    let jsonlite = jsonlite.unwrap();
    Ok((
        rscript,
        vec![
            ready("rig", format!("exact R {exact_version} resolved")),
            ready("renv", format!("project library {library}")),
            ready(
                "r-packages",
                format!("renv, pak, jsonlite {jsonlite} ready"),
            ),
            ready("renv.lock", format!("sha256 {}", file_sha256(&renv_lock)?)),
        ],
    ))
}

fn doctor_python(
    config: &ToolchainConfigDocument,
    exact_version: String,
) -> Result<(PathBuf, Vec<DoctorCheck>), ToolchainError> {
    let uv = find_program("uv")
        .ok_or_else(|| ToolchainError::CommandStart("uv was not found on PATH".to_string()))?;
    execute(&CommandSpec {
        program: uv.clone(),
        args: vec!["--version".to_string()],
        cwd: config.project_root.clone(),
        env: Default::default(),
    })?;
    let python_config = config.config.runtime.python.as_ref().unwrap();
    let pyproject = config.resolve_project_path(&python_config.project)?;
    let uv_lock = config.resolve_project_path(&python_config.lockfile)?;
    let python_project = pyproject.parent().unwrap();
    regular_file(&pyproject, &python_config.project)?;
    regular_file(&uv_lock, &python_config.lockfile)?;
    execute(&CommandSpec {
        program: uv.clone(),
        args: vec![
            "sync".to_string(),
            "--project".to_string(),
            python_project.to_string_lossy().into_owned(),
            "--locked".to_string(),
            "--check".to_string(),
            "--python".to_string(),
            exact_version.clone(),
        ],
        cwd: config.project_root.clone(),
        env: Default::default(),
    })?;
    let python = if cfg!(windows) {
        python_project.join(".venv/Scripts/python.exe")
    } else {
        python_project.join(".venv/bin/python")
    };
    executable_file(&python, ".venv Python")?;
    let output = execute(&CommandSpec {
        program: python.clone(),
        args: vec!["--version".to_string()],
        cwd: config.project_root.clone(),
        env: Default::default(),
    })?;
    if !String::from_utf8_lossy(&output).contains(&exact_version) {
        return Err(ToolchainError::CommandFailed(format!(
            ".venv does not report exact Python {exact_version}"
        )));
    }
    Ok((
        python,
        vec![
            ready("uv", format!("exact Python {exact_version} selected")),
            ready(
                "pyproject.toml",
                format!("sha256 {}", file_sha256(&pyproject)?),
            ),
            ready("uv.lock", format!("sha256 {}", file_sha256(&uv_lock)?)),
            ready(".venv", "project environment ready"),
        ],
    ))
}

fn execute(spec: &CommandSpec) -> Result<Vec<u8>, ToolchainError> {
    let output = Command::new(&spec.program)
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .envs(&spec.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| ToolchainError::CommandStart(error.to_string()))?;
    if !output.status.success() {
        return Err(ToolchainError::CommandFailed(bounded(
            &String::from_utf8_lossy(&output.stderr),
        )));
    }
    let mut combined = output.stdout;
    combined.extend(output.stderr);
    if combined.len() > MAX_DOCTOR_OUTPUT_BYTES {
        return Err(ToolchainError::CommandFailed(
            "doctor command output exceeded the byte bound".to_string(),
        ));
    }
    Ok(combined)
}

fn regular_file(path: &Path, label: &str) -> Result<(), ToolchainError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| ToolchainError::CommandFailed(format!("{label} is missing")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ToolchainError::CommandFailed(format!(
            "{label} is not a regular file"
        )));
    }
    Ok(())
}

fn executable_file(path: &Path, label: &str) -> Result<(), ToolchainError> {
    let resolved = path
        .canonicalize()
        .map_err(|_| ToolchainError::CommandFailed(format!("{label} is missing")))?;
    if !resolved.is_file() {
        return Err(ToolchainError::CommandFailed(format!(
            "{label} does not resolve to a file"
        )));
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, ToolchainError> {
    Ok(hex_sha256(&fs::read(path)?))
}

fn find_program(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .flat_map(|directory| {
            if cfg!(windows) {
                vec![directory.join(format!("{name}.exe")), directory.join(name)]
            } else {
                vec![directory.join(name)]
            }
        })
        .find(|candidate| candidate.is_file())
}

fn marker(source: &str, prefix: &str) -> Option<String> {
    source
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix).map(str::to_string))
}

fn ready(id: impl Into<String>, detail: impl Into<String>) -> DoctorCheck {
    DoctorCheck {
        id: id.into(),
        status: DoctorStatus::Ready,
        detail: detail.into(),
    }
}

fn failed(id: impl Into<String>, detail: impl Into<String>) -> DoctorCheck {
    DoctorCheck {
        id: id.into(),
        status: DoctorStatus::Failed,
        detail: detail.into(),
    }
}

fn bounded(value: &str) -> String {
    value.chars().take(4_096).collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn remote_container_target_is_resolved_before_any_local_runtime_probe() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("rho.toml"),
            "schema = 2\n[runtime.python]\nversion = \"3.12\"\nmanager = \"uv\"\nproject = \"pyproject.toml\"\nlockfile = \"uv.lock\"\n[compute]\ndefault_target = \"lab\"\nrequired_capabilities = [\"gpu\"]\n",
        )
        .unwrap();
        let rho_home = tempdir().unwrap();
        fs::write(
            rho_home.path().join("targets.yaml"),
            "schema: 1\ntargets:\n  lab:\n    host:\n      kind: ssh\n      host: gpu.example\n      host_fingerprint: SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDE\n      remote_root: /data/projects\n    isolation:\n      kind: docker\n      image: registry/rho@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    capabilities: [cpu, gpu]\n",
        )
        .unwrap();
        let targets = crate::load_target_registry(rho_home.path()).unwrap();
        let report = doctor_for_target(root.path(), &targets).unwrap();
        assert_eq!(report.target_id, "lab");
        assert_eq!(report.host_kind, "ssh");
        assert_eq!(report.isolation_kind, "docker");
        assert_eq!(report.status, DoctorStatus::Failed);
        assert!(
            report
                .checks
                .iter()
                .any(|check| check.id == "target-adapter")
        );
    }

    #[test]
    fn missing_external_tools_are_reported_without_mutating_the_project() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("rho.toml"),
            "schema = 1\n[runtime.r]\nversion = \"4.5.2\"\nmanager = \"rig\"\nenvironment = \"renv\"\nlockfile = \"renv.lock\"\ninstaller = \"pak\"\n",
        )
        .unwrap();
        let old = env::var_os("PATH");
        unsafe { env::set_var("PATH", root.path()) };
        let report = doctor(root.path()).unwrap();
        if let Some(old) = old {
            unsafe { env::set_var("PATH", old) };
        }
        assert_eq!(report.status, DoctorStatus::Failed);
        assert!(report.checks.iter().any(|check| check.id == "r"));
        assert!(!root.path().join(".rho").exists());
    }
}
