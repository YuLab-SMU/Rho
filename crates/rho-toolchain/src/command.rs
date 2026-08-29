use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    TargetAdmission, TargetAdmissionMode, TargetRegistryDocument, ToolchainConfigDocument,
    ToolchainError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolchainPlanKind {
    Run,
    Live,
    Sync,
    Lock,
    PackageInstall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolchainPlan {
    pub kind: ToolchainPlanKind,
    pub commands: Vec<CommandSpec>,
    pub may_update_lockfiles: bool,
    pub may_install_packages: bool,
}

fn require_admission(
    config: &ToolchainConfigDocument,
    targets: &TargetRegistryDocument,
    admission: &TargetAdmission,
    mode: TargetAdmissionMode,
) -> Result<(), ToolchainError> {
    admission.validate(config, targets, mode)
}

fn contained_existing_path(
    project_root: &Path,
    path: &Path,
) -> Result<(PathBuf, PathBuf), ToolchainError> {
    let project_root = project_root.canonicalize()?;
    let path = path.canonicalize()?;
    if !path.starts_with(&project_root) {
        return Err(ToolchainError::PathContainment(path));
    }
    Ok((project_root, path))
}

fn r_string(value: &Path) -> String {
    let source = value.to_string_lossy();
    format!(
        "\"{}\"",
        source
            .replace('\\', "\\\\")
            .replace('\"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

fn environment_for_project(project_root: &Path) -> BTreeMap<String, String> {
    let profile = project_root.join(".Rprofile");
    let environ = project_root.join(".Renviron");
    BTreeMap::from([
        (
            "RENV_PROJECT".to_string(),
            project_root.to_string_lossy().into_owned(),
        ),
        ("RENV_CONFIG_AUTO_SNAPSHOT".to_string(), "FALSE".to_string()),
        (
            "RENV_CONFIG_SYNCHRONIZED_CHECK".to_string(),
            "FALSE".to_string(),
        ),
        ("RENV_CONFIG_STARTUP_QUIET".to_string(), "TRUE".to_string()),
        (
            "R_PROFILE_USER".to_string(),
            if profile.is_file() && !profile.is_symlink() {
                profile.to_string_lossy().into_owned()
            } else {
                null_device().to_string()
            },
        ),
        (
            "R_ENVIRON_USER".to_string(),
            if environ.is_file() && !environ.is_symlink() {
                environ.to_string_lossy().into_owned()
            } else {
                null_device().to_string()
            },
        ),
    ])
}

fn rscript_expression(rscript: &Path, project_root: &Path, expression: String) -> CommandSpec {
    CommandSpec {
        program: rscript.to_path_buf(),
        args: vec!["--no-save".to_string(), "-e".to_string(), expression],
        cwd: project_root.to_path_buf(),
        env: environment_for_project(project_root),
    }
}

/// Execute rig's adjacent Rscript with a positional script file. Rscript turns
/// this into the underlying `--file=<path>` commandArgs identity; Rho never
/// rewrites the script as `source()` or a `-e` expression.
pub fn r_run_plan(
    config: &ToolchainConfigDocument,
    targets: &TargetRegistryDocument,
    admission: &TargetAdmission,
    rscript: &Path,
    script: &Path,
    args: &[String],
    live: bool,
) -> Result<ToolchainPlan, ToolchainError> {
    require_admission(
        config,
        targets,
        admission,
        if live {
            TargetAdmissionMode::Live
        } else {
            TargetAdmissionMode::Run
        },
    )?;
    let (project_root, script) = contained_existing_path(&config.project_root, script)?;
    let mut command_args = vec![
        "--no-save".to_string(),
        "--no-restore".to_string(),
        "--no-site-file".to_string(),
        script.to_string_lossy().into_owned(),
    ];
    command_args.extend(args.iter().cloned());
    Ok(ToolchainPlan {
        kind: if live {
            ToolchainPlanKind::Live
        } else {
            ToolchainPlanKind::Run
        },
        commands: vec![CommandSpec {
            program: rscript.to_path_buf(),
            args: command_args,
            cwd: project_root.clone(),
            env: environment_for_project(&project_root),
        }],
        may_update_lockfiles: false,
        may_install_packages: false,
    })
}

pub fn python_run_plan(
    config: &ToolchainConfigDocument,
    targets: &TargetRegistryDocument,
    admission: &TargetAdmission,
    uv: &Path,
    command: &[String],
    live: bool,
) -> Result<ToolchainPlan, ToolchainError> {
    require_admission(
        config,
        targets,
        admission,
        if live {
            TargetAdmissionMode::Live
        } else {
            TargetAdmissionMode::Run
        },
    )?;
    let python = config.config.runtime.python.as_ref().ok_or_else(|| {
        ToolchainError::InvalidConfig(
            "[runtime.python] is required for Python execution".to_string(),
        )
    })?;
    if command.is_empty() {
        return Err(ToolchainError::InvalidConfig(
            "Python run command cannot be empty".to_string(),
        ));
    }
    let project = config.resolve_project_path(&python.project)?;
    let mut args = vec![
        "run".to_string(),
        "--project".to_string(),
        project.parent().unwrap().to_string_lossy().into_owned(),
        "--locked".to_string(),
        "--no-sync".to_string(),
        "--python".to_string(),
        python.version.to_string(),
        "--".to_string(),
    ];
    args.extend(command.iter().cloned());
    Ok(ToolchainPlan {
        kind: if live {
            ToolchainPlanKind::Live
        } else {
            ToolchainPlanKind::Run
        },
        commands: vec![CommandSpec {
            program: uv.to_path_buf(),
            args,
            cwd: config.project_root.clone(),
            env: BTreeMap::new(),
        }],
        may_update_lockfiles: false,
        may_install_packages: false,
    })
}

pub fn sync_plan(
    config: &ToolchainConfigDocument,
    targets: &TargetRegistryDocument,
    admission: &TargetAdmission,
    rscript: Option<&Path>,
    uv: &Path,
) -> Result<ToolchainPlan, ToolchainError> {
    require_admission(config, targets, admission, TargetAdmissionMode::Sync)?;
    let mut commands = Vec::new();
    if let Some(r) = &config.config.runtime.r {
        let rscript = rscript.ok_or_else(|| {
            ToolchainError::InvalidConfig("rig-selected Rscript is required for R sync".to_string())
        })?;
        let lockfile = config.resolve_project_path(&r.lockfile)?;
        commands.push(rscript_expression(
            rscript,
            &config.project_root,
            format!(
                "renv::restore(project={}, lockfile={}, prompt=FALSE)",
                r_string(&config.project_root),
                r_string(&lockfile)
            ),
        ));
    }
    if let Some(python) = &config.config.runtime.python {
        let project = config.resolve_project_path(&python.project)?;
        commands.push(CommandSpec {
            program: uv.to_path_buf(),
            args: vec![
                "sync".to_string(),
                "--project".to_string(),
                project.parent().unwrap().to_string_lossy().into_owned(),
                "--locked".to_string(),
                "--python".to_string(),
                python.version.to_string(),
            ],
            cwd: config.project_root.clone(),
            env: BTreeMap::new(),
        });
    }
    Ok(ToolchainPlan {
        kind: ToolchainPlanKind::Sync,
        commands,
        may_update_lockfiles: false,
        may_install_packages: true,
    })
}

pub fn lock_plan(
    config: &ToolchainConfigDocument,
    targets: &TargetRegistryDocument,
    admission: &TargetAdmission,
    rscript: Option<&Path>,
    uv: &Path,
) -> Result<ToolchainPlan, ToolchainError> {
    require_admission(config, targets, admission, TargetAdmissionMode::Lock)?;
    let mut commands = Vec::new();
    if let Some(r) = &config.config.runtime.r {
        let rscript = rscript.ok_or_else(|| {
            ToolchainError::InvalidConfig("rig-selected Rscript is required for R lock".to_string())
        })?;
        let lockfile = config.resolve_project_path(&r.lockfile)?;
        commands.push(rscript_expression(
            rscript,
            &config.project_root,
            format!(
                "renv::snapshot(project={}, lockfile={}, prompt=FALSE)",
                r_string(&config.project_root),
                r_string(&lockfile)
            ),
        ));
    }
    if let Some(python) = &config.config.runtime.python {
        let project = config.resolve_project_path(&python.project)?;
        commands.push(CommandSpec {
            program: uv.to_path_buf(),
            args: vec![
                "lock".to_string(),
                "--project".to_string(),
                project.parent().unwrap().to_string_lossy().into_owned(),
                "--python".to_string(),
                python.version.to_string(),
            ],
            cwd: config.project_root.clone(),
            env: BTreeMap::new(),
        });
    }
    Ok(ToolchainPlan {
        kind: ToolchainPlanKind::Lock,
        commands,
        may_update_lockfiles: true,
        may_install_packages: false,
    })
}

pub fn r_package_install_plan(
    config: &ToolchainConfigDocument,
    targets: &TargetRegistryDocument,
    admission: &TargetAdmission,
    rscript: &Path,
    package: &str,
) -> Result<ToolchainPlan, ToolchainError> {
    require_admission(
        config,
        targets,
        admission,
        TargetAdmissionMode::PackageInstall,
    )?;
    if config.config.runtime.r.is_none() {
        return Err(ToolchainError::InvalidConfig(
            "[runtime.r] is required for R package installation".to_string(),
        ));
    }
    if package.is_empty()
        || package.len() > 256
        || package.chars().any(|character| {
            character.is_control() || matches!(character, '\'' | '\"' | '\n' | '\r')
        })
    {
        return Err(ToolchainError::InvalidConfig(
            "R package reference is invalid".to_string(),
        ));
    }
    let expression = format!(
        "pak::pkg_install(\"{package}\", lib=renv::paths$library(project={}), upgrade=FALSE, ask=FALSE)",
        r_string(&config.project_root)
    );
    Ok(ToolchainPlan {
        kind: ToolchainPlanKind::PackageInstall,
        commands: vec![rscript_expression(
            rscript,
            &config.project_root,
            expression,
        )],
        may_update_lockfiles: false,
        may_install_packages: true,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::{
        DoctorReport, DoctorStatus, TargetAdmissionMode, load_target_registry,
        load_toolchain_config,
    };

    const CONFIG: &str = r#"schema = 1
[runtime.r]
version = "4.5.2"
manager = "rig"
environment = "renv"
lockfile = "renv.lock"
installer = "pak"
[runtime.python]
version = "3.12"
manager = "uv"
project = "pyproject.toml"
lockfile = "uv.lock"
"#;

    fn config() -> (
        tempfile::TempDir,
        ToolchainConfigDocument,
        TargetRegistryDocument,
        TargetAdmission,
    ) {
        let root = tempdir().unwrap();
        fs::write(root.path().join("rho.toml"), CONFIG).unwrap();
        fs::write(root.path().join("renv.lock"), "{}").unwrap();
        fs::write(root.path().join("pyproject.toml"), "[project]").unwrap();
        fs::write(root.path().join("uv.lock"), "version = 1").unwrap();
        let config = load_toolchain_config(root.path()).unwrap();
        let targets = load_target_registry(root.path()).unwrap();
        let report = DoctorReport {
            schema_version: 1,
            status: DoctorStatus::Ready,
            project_root: config.project_root.clone(),
            rho_toml_sha256: config.sha256.clone(),
            target_id: "local".to_string(),
            target_registry_sha256: None,
            host_kind: "local".to_string(),
            isolation_kind: "native".to_string(),
            r_version: Some("4.5.2".to_string()),
            rscript: Some(PathBuf::from("/R/Rscript")),
            python_version: Some("3.12".to_string()),
            python: Some(config.project_root.join(".venv/bin/python")),
            checks: Vec::new(),
        };
        let admission = TargetAdmission::from_verified_report(
            &config,
            &targets,
            TargetAdmissionMode::Run,
            report,
        )
        .unwrap();
        (root, config, targets, admission)
    }

    #[test]
    fn ordinary_runs_never_install_or_update_locks() {
        let (root, config, targets, admission) = config();
        let script = root.path().join("analysis.R");
        fs::write(&script, "print(1)").unwrap();
        let r = r_run_plan(
            &config,
            &targets,
            &admission,
            Path::new("/R/Rscript"),
            &script,
            &["x".into()],
            false,
        )
        .unwrap();
        assert_eq!(
            r.commands[0].args[3],
            script.canonicalize().unwrap().to_string_lossy()
        );
        assert!(!r.commands[0].args.iter().any(|arg| arg == "-e"));
        assert!(!r.may_install_packages && !r.may_update_lockfiles);

        let python = python_run_plan(
            &config,
            &targets,
            &admission,
            Path::new("uv"),
            &["python".into(), "analysis.py".into()],
            false,
        )
        .unwrap();
        assert!(
            python.commands[0]
                .args
                .windows(2)
                .any(|args| args == ["--locked", "--no-sync"])
        );
        assert!(python.commands[0].args.contains(&"3.12".to_string()));
        assert!(!python.may_install_packages && !python.may_update_lockfiles);
    }

    #[test]
    fn stale_local_admission_never_authorizes_a_remote_target() {
        let (root, _config, _targets, admission) = config();
        let configured = CONFIG.replacen("schema = 1", "schema = 2", 1)
            + "\n[compute]\ndefault_target = \"remote\"\n";
        fs::write(root.path().join("rho.toml"), configured).unwrap();
        fs::write(
            root.path().join("targets.yaml"),
            "schema: 1\ntargets:\n  remote:\n    host:\n      kind: ssh\n      host: compute.example\n      host_fingerprint: SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDE\n      remote_root: /data/projects\n    isolation:\n      kind: native\n",
        )
        .unwrap();
        let config = load_toolchain_config(root.path()).unwrap();
        let targets = load_target_registry(root.path()).unwrap();
        assert!(
            python_run_plan(
                &config,
                &targets,
                &admission,
                Path::new("uv"),
                &["python".to_string()],
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn sync_and_lock_keep_external_effects_explicit() {
        let (_root, config, targets, admission) = config();
        let sync_admission = admission
            .for_mode(&config, &targets, TargetAdmissionMode::Sync)
            .unwrap();
        let sync = sync_plan(
            &config,
            &targets,
            &sync_admission,
            Some(Path::new("/R/Rscript")),
            Path::new("uv"),
        )
        .unwrap();
        assert_eq!(sync.commands.len(), 2);
        assert!(!sync.may_update_lockfiles);
        assert!(sync.may_install_packages);
        assert!(sync.commands[0].args.join(" ").contains("renv::restore"));
        assert!(sync.commands[1].args.contains(&"--locked".to_string()));

        let lock_admission = admission
            .for_mode(&config, &targets, TargetAdmissionMode::Lock)
            .unwrap();
        let lock = lock_plan(
            &config,
            &targets,
            &lock_admission,
            Some(Path::new("/R/Rscript")),
            Path::new("uv"),
        )
        .unwrap();
        assert_eq!(lock.commands.len(), 2);
        assert!(lock.may_update_lockfiles);
        assert!(!lock.may_install_packages);
        assert!(lock.commands[0].args.join(" ").contains("renv::snapshot"));
        assert_eq!(lock.commands[1].args[0], "lock");
    }
}
