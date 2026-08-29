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
    if !matches!(target.host, ComputeHost::Local) {
        report.checks.push(failed(
            "target-adapter",
            "SSH execution requires the authenticated remote Toolchain Helper",
        ));
        report.status = DoctorStatus::Failed;
        return Ok(report);
    }
    if let ComputeIsolation::Docker {
        engine,
        image,
        r_library,
        python_environment,
    } = &target.isolation
    {
        match doctor_docker(config, engine, image, r_library, python_environment) {
            Ok((r_version, rscript, python_version, python, checks)) => {
                report.r_version = r_version;
                report.rscript = rscript;
                report.python_version = python_version;
                report.python = python;
                report.checks.extend(checks);
            }
            Err(error) => report
                .checks
                .push(failed("docker", bounded(&error.to_string()))),
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
        return Ok(report);
    }
    if let ComputeIsolation::Conda {
        environment,
        explicit_spec_sha256,
    } = &target.isolation
    {
        match doctor_conda(config, environment, explicit_spec_sha256) {
            Ok((r_version, rscript, python_version, python, checks)) => {
                report.r_version = r_version;
                report.rscript = rscript;
                report.python_version = python_version;
                report.python = python;
                report.checks.extend(checks);
            }
            Err(error) => report
                .checks
                .push(failed("conda", bounded(&error.to_string()))),
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

type DockerDoctorOutcome = (
    Option<String>,
    Option<PathBuf>,
    Option<String>,
    Option<PathBuf>,
    Vec<DoctorCheck>,
);

fn doctor_docker(
    config: &ToolchainConfigDocument,
    engine_name: &str,
    image: &str,
    r_library: &str,
    python_environment: &str,
) -> Result<DockerDoctorOutcome, ToolchainError> {
    let engine = find_program(engine_name).ok_or_else(|| {
        ToolchainError::CommandStart(format!("{engine_name} was not found on PATH"))
    })?;
    execute(&CommandSpec {
        program: engine.clone(),
        args: vec![
            "image".to_string(),
            "inspect".to_string(),
            image.to_string(),
        ],
        cwd: config.project_root.clone(),
        env: Default::default(),
    })?;
    let mut checks = vec![ready(
        "container-image",
        format!("immutable image {image} is available"),
    )];
    let probe = DockerProbe {
        config,
        engine: &engine,
        image,
        r_library,
        python_environment,
    };
    let mut r_version = None;
    let mut rscript = None;
    if let Some(r) = &config.config.runtime.r {
        let inventory = execute(&probe.command("rig", &["list", "--json"], &[]))?;
        let inventory = parse_rig_inventory(&inventory)?;
        let installation = resolve_r_installation(&inventory, &r.version)?;
        let selected_rscript = installation
            .binary
            .parent()
            .ok_or_else(|| ToolchainError::MissingRscript(installation.binary.clone()))?
            .join(if cfg!(windows) {
                "Rscript.exe"
            } else {
                "Rscript"
            });
        execute(&probe.command(&selected_rscript.to_string_lossy(), &["--version"], &[]))?;
        let lockfile = format!("/workspace/{}", r.lockfile);
        let project = "/workspace";
        let expression = format!(
            ".libPaths(c(\"{r_library}\", .libPaths())); if (!(requireNamespace(\"renv\", quietly=TRUE) && requireNamespace(\"pak\", quietly=TRUE) && requireNamespace(\"jsonlite\", quietly=TRUE))) quit(status=41); lock <- jsonlite::read_json(\"{lockfile}\", simplifyVector=FALSE); records <- lock$Packages; installed <- installed.packages(); ok <- all(vapply(names(records), function(name) name %in% rownames(installed) && identical(as.character(installed[name, \"Version\"]), records[[name]]$Version), logical(1))); cat(\"RHO_DOCKER_RENV_READY=\", if (isTRUE(ok)) \"true\" else \"false\", \"\\n\", sep=\"\"); cat(\"RHO_DOCKER_PROJECT={project}\\n\")"
        );
        let output = execute(&probe.command(
            &selected_rscript.to_string_lossy(),
            &["--no-save", "-e", &expression],
            &[],
        ))?;
        let output = String::from_utf8_lossy(&output);
        if marker(&output, "RHO_DOCKER_RENV_READY=").as_deref() != Some("true") {
            return Err(ToolchainError::CommandFailed(
                "container R library does not realize renv.lock".to_string(),
            ));
        }
        r_version = Some(r.version.to_string());
        rscript = Some(selected_rscript);
        checks.push(ready(
            "docker-r",
            format!("exact R {} and renv lock ready", r.version),
        ));
    }
    let mut python_version = None;
    let mut python = None;
    if let Some(python_config) = &config.config.runtime.python {
        let project = format!("/workspace/{}", python_config.project);
        let version_request = python_config.version.to_string();
        execute(&probe.command(
            "uv",
            &[
                "sync",
                "--project",
                &project,
                "--locked",
                "--check",
                "--python",
                &version_request,
            ],
            &[("UV_PROJECT_ENVIRONMENT", python_environment)],
        ))?;
        let python_path = PathBuf::from(python_environment).join("bin/python");
        let output = execute(&probe.command(&python_path.to_string_lossy(), &["--version"], &[]))?;
        if !String::from_utf8_lossy(&output).contains(&python_config.version.to_string()) {
            return Err(ToolchainError::CommandFailed(
                "container Python environment reports the wrong version".to_string(),
            ));
        }
        python_version = Some(python_config.version.to_string());
        python = Some(python_path);
        checks.push(ready(
            "docker-python",
            format!("Python {} and uv lock ready", python_config.version),
        ));
    }
    Ok((r_version, rscript, python_version, python, checks))
}

struct DockerProbe<'a> {
    config: &'a ToolchainConfigDocument,
    engine: &'a Path,
    image: &'a str,
    r_library: &'a str,
    python_environment: &'a str,
}

impl DockerProbe<'_> {
    fn command(
        &self,
        program: &str,
        program_args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> CommandSpec {
        let mut args = vec![
            "run".to_string(),
            "--rm".to_string(),
            "--read-only".to_string(),
            "--network=none".to_string(),
            "--mount".to_string(),
            format!(
                "type=bind,source={},target=/workspace,readonly",
                self.config.project_root.to_string_lossy()
            ),
            "--tmpfs".to_string(),
            "/tmp:rw,nosuid,nodev,size=512m".to_string(),
            "--workdir".to_string(),
            "/workspace".to_string(),
        ];
        for (key, value) in [
            ("RENV_PATHS_LIBRARY", self.r_library),
            ("UV_PROJECT_ENVIRONMENT", self.python_environment),
        ]
        .into_iter()
        .chain(extra_env.iter().copied())
        {
            args.push("--env".to_string());
            args.push(format!("{key}={value}"));
        }
        args.push(self.image.to_string());
        args.push(program.to_string());
        args.extend(program_args.iter().map(|value| (*value).to_string()));
        CommandSpec {
            program: self.engine.to_path_buf(),
            args,
            cwd: self.config.project_root.clone(),
            env: Default::default(),
        }
    }
}

fn doctor_conda(
    config: &ToolchainConfigDocument,
    environment: &str,
    expected_explicit_sha256: &str,
) -> Result<DockerDoctorOutcome, ToolchainError> {
    let conda = find_program("conda")
        .ok_or_else(|| ToolchainError::CommandStart("conda was not found on PATH".to_string()))?;
    let explicit = Command::new(&conda)
        .args(["list", "--explicit", "--name", environment])
        .current_dir(&config.project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| ToolchainError::CommandStart(error.to_string()))?;
    if !explicit.status.success() {
        return Err(ToolchainError::CommandFailed(bounded(
            &String::from_utf8_lossy(&explicit.stderr),
        )));
    }
    if explicit.stdout.len() > MAX_DOCTOR_OUTPUT_BYTES {
        return Err(ToolchainError::CommandFailed(
            "conda explicit specification exceeded the byte bound".to_string(),
        ));
    }
    let actual_explicit_sha256 = hex_sha256(&explicit.stdout);
    if actual_explicit_sha256 != expected_explicit_sha256 {
        return Err(ToolchainError::CommandFailed(format!(
            "Conda explicit specification changed: expected {expected_explicit_sha256}, got {actual_explicit_sha256}"
        )));
    }
    let probe = CondaProbe {
        config,
        conda: &conda,
        environment,
    };
    let mut checks = vec![ready(
        "conda-explicit",
        format!("environment {environment} matches its explicit specification"),
    )];
    let mut r_version = None;
    let mut rscript = None;
    if let Some(r) = &config.config.runtime.r {
        let inventory = execute(&probe.command("rig", &["list", "--json"], &[]))?;
        let inventory = parse_rig_inventory(&inventory)?;
        let installation = resolve_r_installation(&inventory, &r.version)?;
        let selected_rscript = installation.rscript()?;
        let version =
            execute(&probe.command(&selected_rscript.to_string_lossy(), &["--version"], &[]))?;
        if !String::from_utf8_lossy(&version).contains(&r.version.to_string()) {
            return Err(ToolchainError::CommandFailed(
                "Conda Rscript reports the wrong R version".to_string(),
            ));
        }
        let lockfile = config.resolve_project_path(&r.lockfile)?;
        regular_file(&lockfile, &r.lockfile)?;
        regular_file(
            &config.project_root.join("renv/activate.R"),
            "renv/activate.R",
        )?;
        regular_file(&config.project_root.join(".Rprofile"), ".Rprofile")?;
        let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
        execute(&probe.command(
            &selected_rscript.to_string_lossy(),
            &[
                "--no-save",
                "-e",
                "if (!(requireNamespace(\"renv\", quietly=TRUE) && requireNamespace(\"pak\", quietly=TRUE))) quit(status=41)",
            ],
            &[
                ("R_PROFILE_USER", null_device),
                ("R_ENVIRON_USER", null_device),
            ],
        ))?;
        let project = serde_json::to_string(&config.project_root.to_string_lossy().as_ref())?;
        let expression = format!(
            "renv::load(project={project}, quiet=TRUE); result <- renv::status(project={project}, sources=FALSE); locked <- result$lockfile$Packages; installed <- result$library$Packages; locked_names <- sort(names(locked)); ok <- all(locked_names %in% names(installed)) && all(vapply(locked_names, function(name) identical(locked[[name]]$Version, installed[[name]]$Version), logical(1))); jsonlite <- if (requireNamespace(\"jsonlite\", quietly=TRUE)) as.character(packageVersion(\"jsonlite\")) else \"\"; cat(\"RHO_CONDA_RENV_READY=\", if (isTRUE(ok)) \"true\" else \"false\", \"\\n\", sep=\"\"); cat(\"RHO_CONDA_JSONLITE=\", jsonlite, \"\\n\", sep=\"\")"
        );
        let output = execute(&probe.command(
            &selected_rscript.to_string_lossy(),
            &["--no-save", "-e", &expression],
            &[
                ("R_PROFILE_USER", null_device),
                ("R_ENVIRON_USER", null_device),
                ("RENV_CONFIG_AUTO_SNAPSHOT", "FALSE"),
            ],
        ))?;
        let output = String::from_utf8_lossy(&output);
        if marker(&output, "RHO_CONDA_RENV_READY=").as_deref() != Some("true")
            || marker(&output, "RHO_CONDA_JSONLITE=")
                .as_deref()
                .is_none_or(str::is_empty)
        {
            return Err(ToolchainError::CommandFailed(
                "Conda R environment does not realize renv.lock and jsonlite".to_string(),
            ));
        }
        r_version = Some(r.version.to_string());
        rscript = Some(selected_rscript);
        checks.push(ready(
            "conda-r",
            format!("exact R {} and renv lock ready", r.version),
        ));
    }
    let mut python_version = None;
    let mut python = None;
    if let Some(python_config) = &config.config.runtime.python {
        let project = config.resolve_project_path(&python_config.project)?;
        let lockfile = config.resolve_project_path(&python_config.lockfile)?;
        regular_file(&project, &python_config.project)?;
        regular_file(&lockfile, &python_config.lockfile)?;
        let project_root = project.parent().unwrap().to_string_lossy().into_owned();
        let version_request = python_config.version.to_string();
        execute(&probe.command(
            "uv",
            &[
                "sync",
                "--project",
                &project_root,
                "--locked",
                "--check",
                "--python",
                &version_request,
            ],
            &[],
        ))?;
        let python_path = if cfg!(windows) {
            project.parent().unwrap().join(".venv/Scripts/python.exe")
        } else {
            project.parent().unwrap().join(".venv/bin/python")
        };
        executable_file(&python_path, ".venv Python")?;
        let output = execute(&probe.command(&python_path.to_string_lossy(), &["--version"], &[]))?;
        if !String::from_utf8_lossy(&output).contains(&version_request) {
            return Err(ToolchainError::CommandFailed(
                "Conda Python environment reports the wrong project Python".to_string(),
            ));
        }
        python_version = Some(version_request);
        python = Some(python_path);
        checks.push(ready("conda-python", "uv lock and project .venv ready"));
    }
    Ok((r_version, rscript, python_version, python, checks))
}

struct CondaProbe<'a> {
    config: &'a ToolchainConfigDocument,
    conda: &'a Path,
    environment: &'a str,
}

impl CondaProbe<'_> {
    fn command(
        &self,
        program: &str,
        program_args: &[&str],
        environment: &[(&str, &str)],
    ) -> CommandSpec {
        let mut args = vec![
            "run".to_string(),
            "--no-capture-output".to_string(),
            "--name".to_string(),
            self.environment.to_string(),
            program.to_string(),
        ];
        args.extend(program_args.iter().map(|value| (*value).to_string()));
        CommandSpec {
            program: self.conda.to_path_buf(),
            args,
            cwd: self.config.project_root.clone(),
            env: environment
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect(),
        }
    }
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
