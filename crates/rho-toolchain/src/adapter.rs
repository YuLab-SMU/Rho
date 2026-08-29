use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::{
    CommandSpec, ComputeHost, ComputeIsolation, TargetRegistryDocument, ToolchainConfigDocument,
    ToolchainError, ToolchainPlan, ToolchainPlanKind,
};

const CONTAINER_PROJECT_ROOT: &str = "/workspace";

/// Convert an admitted logical plan into the exact local execution boundary.
/// Remote hosts remain unavailable until the authenticated remote helper exists.
pub fn adapt_plan_for_target(
    config: &ToolchainConfigDocument,
    targets: &TargetRegistryDocument,
    plan: &ToolchainPlan,
) -> Result<ToolchainPlan, ToolchainError> {
    let target = targets
        .registry
        .resolve(&config.config.compute.default_target)?;
    if !matches!(target.host, ComputeHost::Local) {
        return Err(ToolchainError::InvalidTarget(
            "SSH execution requires the remote Toolchain Helper".to_string(),
        ));
    }
    match &target.isolation {
        ComputeIsolation::Native => Ok(plan.clone()),
        ComputeIsolation::Docker { engine, image } => {
            if !matches!(plan.kind, ToolchainPlanKind::Run | ToolchainPlanKind::Live) {
                return Err(ToolchainError::InvalidTarget(
                    "immutable Docker targets do not perform sync, lock, or package installation; rebuild the pinned image explicitly"
                        .to_string(),
                ));
            }
            let commands = plan
                .commands
                .iter()
                .map(|command| docker_command(config, engine, image, command))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ToolchainPlan {
                kind: plan.kind,
                commands,
                may_update_lockfiles: false,
                may_install_packages: false,
            })
        }
        ComputeIsolation::Conda { environment, .. } => {
            let commands = plan
                .commands
                .iter()
                .map(|command| conda_command(config, environment, command))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ToolchainPlan {
                kind: plan.kind,
                commands,
                may_update_lockfiles: plan.may_update_lockfiles,
                may_install_packages: plan.may_install_packages,
            })
        }
    }
}

fn docker_command(
    config: &ToolchainConfigDocument,
    engine: &str,
    image: &str,
    command: &CommandSpec,
) -> Result<CommandSpec, ToolchainError> {
    ensure_project_cwd(config, &command.cwd)?;
    let mut args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--read-only".to_string(),
        "--network=none".to_string(),
        "--mount".to_string(),
        format!(
            "type=bind,source={},target={CONTAINER_PROJECT_ROOT}",
            config.project_root.to_string_lossy()
        ),
        "--tmpfs".to_string(),
        "/tmp:rw,nosuid,nodev,size=512m".to_string(),
        "--workdir".to_string(),
        translate_project_path(config, &command.cwd)?,
    ];
    for (key, value) in &command.env {
        args.push("--env".to_string());
        args.push(format!(
            "{key}={}",
            translate_embedded_project_path(config, value)
        ));
    }
    args.push("--env".to_string());
    args.push(format!(
        "RHO_COMPUTE_TARGET={}",
        config.config.compute.default_target
    ));
    args.push(image.to_string());
    args.push(translate_program(config, &command.program));
    args.extend(
        command
            .args
            .iter()
            .map(|argument| translate_embedded_project_path(config, argument)),
    );
    Ok(CommandSpec {
        program: PathBuf::from(engine),
        args,
        cwd: config.project_root.clone(),
        env: BTreeMap::new(),
    })
}

fn conda_command(
    config: &ToolchainConfigDocument,
    environment: &str,
    command: &CommandSpec,
) -> Result<CommandSpec, ToolchainError> {
    ensure_project_cwd(config, &command.cwd)?;
    let mut args = vec![
        "run".to_string(),
        "--no-capture-output".to_string(),
        "--name".to_string(),
        environment.to_string(),
    ];
    args.push(command.program.to_string_lossy().into_owned());
    args.extend(command.args.iter().cloned());
    Ok(CommandSpec {
        program: PathBuf::from("conda"),
        args,
        cwd: command.cwd.clone(),
        env: {
            let mut environment = command.env.clone();
            environment.insert(
                "RHO_COMPUTE_TARGET".to_string(),
                config.config.compute.default_target.clone(),
            );
            environment
        },
    })
}

fn ensure_project_cwd(config: &ToolchainConfigDocument, cwd: &Path) -> Result<(), ToolchainError> {
    let resolved = cwd.canonicalize()?;
    if !resolved.starts_with(&config.project_root) {
        return Err(ToolchainError::PathContainment(resolved));
    }
    Ok(())
}

fn translate_project_path(
    config: &ToolchainConfigDocument,
    path: &Path,
) -> Result<String, ToolchainError> {
    let resolved = path.canonicalize()?;
    let relative = resolved
        .strip_prefix(&config.project_root)
        .map_err(|_| ToolchainError::PathContainment(resolved.clone()))?;
    let mut translated = PathBuf::from(CONTAINER_PROJECT_ROOT);
    translated.push(relative);
    Ok(translated.to_string_lossy().replace('\\', "/"))
}

fn translate_embedded_project_path(config: &ToolchainConfigDocument, value: &str) -> String {
    let candidate = Path::new(value);
    if candidate.is_absolute()
        && let Ok(resolved) = candidate.canonicalize()
        && let Ok(relative) = resolved.strip_prefix(&config.project_root)
    {
        let mut translated = PathBuf::from(CONTAINER_PROJECT_ROOT);
        translated.push(relative);
        return translated.to_string_lossy().replace('\\', "/");
    }
    let root = config.project_root.to_string_lossy();
    if value == root {
        return CONTAINER_PROJECT_ROOT.to_string();
    }
    let with_separator = format!("{}{sep}", root, sep = std::path::MAIN_SEPARATOR);
    if let Some(relative) = value.strip_prefix(&with_separator) {
        return format!("{CONTAINER_PROJECT_ROOT}/{}", relative.replace('\\', "/"));
    }
    value.to_string()
}

fn translate_program(config: &ToolchainConfigDocument, program: &Path) -> String {
    translate_embedded_project_path(config, &program.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::{load_target_registry, load_toolchain_config};

    fn configured_target(
        isolation: &str,
    ) -> (
        tempfile::TempDir,
        ToolchainConfigDocument,
        TargetRegistryDocument,
    ) {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("rho.toml"),
            "schema = 2\n[runtime.python]\nversion = \"3.12\"\nmanager = \"uv\"\nproject = \"pyproject.toml\"\nlockfile = \"uv.lock\"\n[compute]\ndefault_target = \"compute\"\n",
        )
        .unwrap();
        fs::write(root.path().join("pyproject.toml"), "[project]").unwrap();
        fs::write(root.path().join("uv.lock"), "version = 1").unwrap();
        fs::write(
            root.path().join("targets.yaml"),
            format!("schema: 1\ntargets:\n  compute:\n    host:\n      kind: local\n    isolation:\n{isolation}\n"),
        )
        .unwrap();
        let config = load_toolchain_config(root.path()).unwrap();
        let targets = load_target_registry(root.path()).unwrap();
        (root, config, targets)
    }

    #[test]
    fn docker_run_is_immutable_offline_and_project_scoped() {
        let (root, config, targets) = configured_target(
            "      kind: docker\n      engine: docker\n      image: registry/rho@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let script = root.path().join("analysis.py");
        fs::write(&script, "print(1)").unwrap();
        let logical = ToolchainPlan {
            kind: ToolchainPlanKind::Run,
            commands: vec![CommandSpec {
                program: PathBuf::from("python"),
                args: vec![script.to_string_lossy().into_owned()],
                cwd: config.project_root.clone(),
                env: BTreeMap::new(),
            }],
            may_update_lockfiles: false,
            may_install_packages: false,
        };
        let adapted = adapt_plan_for_target(&config, &targets, &logical).unwrap();
        let command = &adapted.commands[0];
        assert_eq!(command.program, PathBuf::from("docker"));
        assert!(command.args.contains(&"--network=none".to_string()));
        assert!(command.args.contains(&"--read-only".to_string()));
        assert!(
            command
                .args
                .iter()
                .any(|arg| arg == "/workspace/analysis.py")
        );
        assert!(command.args.iter().any(|arg| arg.contains("@sha256:")));
        assert!(!adapted.may_install_packages && !adapted.may_update_lockfiles);
    }

    #[test]
    fn docker_never_hides_sync_or_lock_in_an_ephemeral_container() {
        let (_root, config, targets) = configured_target(
            "      kind: docker\n      image: registry/rho@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );
        let sync = ToolchainPlan {
            kind: ToolchainPlanKind::Sync,
            commands: vec![CommandSpec {
                program: PathBuf::from("uv"),
                args: vec!["sync".to_string()],
                cwd: config.project_root.clone(),
                env: BTreeMap::new(),
            }],
            may_update_lockfiles: false,
            may_install_packages: true,
        };
        assert!(adapt_plan_for_target(&config, &targets, &sync).is_err());
    }

    #[test]
    fn conda_run_uses_the_pinned_environment_boundary() {
        let (_root, config, targets) = configured_target(
            "      kind: conda\n      environment: rho-analysis\n      explicit_spec_sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        );
        let logical = ToolchainPlan {
            kind: ToolchainPlanKind::Run,
            commands: vec![CommandSpec {
                program: PathBuf::from("python"),
                args: vec!["analysis.py".to_string()],
                cwd: config.project_root.clone(),
                env: BTreeMap::new(),
            }],
            may_update_lockfiles: false,
            may_install_packages: false,
        };
        let adapted = adapt_plan_for_target(&config, &targets, &logical).unwrap();
        assert_eq!(adapted.commands[0].program, PathBuf::from("conda"));
        assert_eq!(
            &adapted.commands[0].args[..4],
            ["run", "--no-capture-output", "--name", "rho-analysis"]
        );
    }
}
