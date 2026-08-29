use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::command::CommandSpec;
use crate::receipt::validate_identity;
use crate::{TargetRegistryDocument, ToolchainConfigDocument, ToolchainError};

const MAX_JOURNAL_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTPUT_PREVIEW_BYTES: usize = 64 * 1024;
const MAX_OPERATION_EFFECTS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Run,
    Live,
    Sync,
    Lock,
    RPackageInstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectStatus {
    Running,
    Succeeded,
    Failed,
    StartFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalEffectRecord {
    pub sequence: usize,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub status: EffectStatus,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub stdout_preview: String,
    pub stderr_preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationJournal {
    pub schema_version: u16,
    pub operation_id: String,
    pub kind: OperationKind,
    pub status: OperationStatus,
    pub project_root: PathBuf,
    pub rho_toml_sha256: String,
    pub target_id: String,
    pub target_registry_sha256: Option<String>,
    pub host_kind: String,
    pub isolation_kind: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub partial_effects_possible: bool,
    pub effects: Vec<ExternalEffectRecord>,
    pub error: Option<String>,
}

pub fn operation_journal_path(
    project_root: &Path,
    operation_id: &str,
) -> Result<PathBuf, ToolchainError> {
    validate_identity(operation_id)?;
    Ok(project_root
        .join(".rho")
        .join("toolchain")
        .join("operations")
        .join(operation_id)
        .join("operation.json"))
}

pub fn read_operation_journal(
    project_root: &Path,
    operation_id: &str,
) -> Result<OperationJournal, ToolchainError> {
    let project_root = project_root.canonicalize()?;
    let path = operation_journal_path(&project_root, operation_id)?;
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ToolchainError::InvalidJournal(
            "operation journal is not a regular file".to_string(),
        ));
    }
    if metadata.len() > MAX_JOURNAL_BYTES as u64 {
        return Err(ToolchainError::InvalidJournal(
            "operation journal exceeds the byte bound".to_string(),
        ));
    }
    let journal: OperationJournal = serde_json::from_slice(&fs::read(path)?)?;
    if journal.schema_version != 1
        || journal.operation_id != operation_id
        || journal.project_root != project_root
        || journal
            .effects
            .iter()
            .enumerate()
            .any(|(index, effect)| effect.sequence != index + 1)
    {
        return Err(ToolchainError::InvalidJournal(
            "operation journal identity or effect sequence is invalid".to_string(),
        ));
    }
    Ok(journal)
}

pub fn execute_journaled_operation(
    config: &ToolchainConfigDocument,
    operation_id: &str,
    kind: OperationKind,
    commands: &[CommandSpec],
    targets: &TargetRegistryDocument,
    confirmed: bool,
) -> Result<OperationJournal, ToolchainError> {
    if !confirmed {
        return Err(ToolchainError::InvalidJournal(
            "explicit toolchain effects require confirmation".to_string(),
        ));
    }
    if commands.is_empty() || commands.len() > MAX_OPERATION_EFFECTS {
        return Err(ToolchainError::InvalidJournal(format!(
            "operation must contain 1..={MAX_OPERATION_EFFECTS} external effects"
        )));
    }
    let target_id = &config.config.compute.default_target;
    let target = targets.registry.resolve(target_id)?;
    let missing_capability = config
        .config
        .compute
        .required_capabilities
        .iter()
        .find(|capability| !target.capabilities.contains(capability));
    if let Some(capability) = missing_capability {
        return Err(ToolchainError::InvalidJournal(format!(
            "target lacks required capability {capability}"
        )));
    }
    let path = operation_journal_path(&config.project_root, operation_id)?;
    ensure_safe_parent(&config.project_root, path.parent().unwrap())?;
    if path.exists() {
        return Err(ToolchainError::InvalidJournal(format!(
            "operation identity already exists: {operation_id}"
        )));
    }
    let mut journal = OperationJournal {
        schema_version: 1,
        operation_id: operation_id.to_string(),
        kind,
        status: OperationStatus::Running,
        project_root: config.project_root.clone(),
        rho_toml_sha256: config.sha256.clone(),
        target_id: target_id.clone(),
        target_registry_sha256: targets.sha256.clone(),
        host_kind: target.host_kind().to_string(),
        isolation_kind: target.isolation_kind().to_string(),
        started_at: Utc::now().to_rfc3339(),
        finished_at: None,
        partial_effects_possible: false,
        effects: Vec::new(),
        error: None,
    };
    persist(&path, &journal)?;

    for (index, spec) in commands.iter().enumerate() {
        validate_command(config, spec)?;
        journal.effects.push(ExternalEffectRecord {
            sequence: index + 1,
            program: spec.program.clone(),
            args: spec.args.clone(),
            cwd: spec.cwd.clone(),
            status: EffectStatus::Running,
            started_at: Utc::now().to_rfc3339(),
            finished_at: None,
            exit_code: None,
            stdout_preview: String::new(),
            stderr_preview: String::new(),
        });
        // The running marker is durable before spawn. Recovery can therefore
        // distinguish an effect that might have started from one never reached.
        persist(&path, &journal)?;

        let mut process = Command::new(&spec.program);
        process
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .envs(&spec.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = match process.output() {
            Ok(output) => output,
            Err(error) => {
                let effect = journal.effects.last_mut().unwrap();
                effect.status = EffectStatus::StartFailed;
                effect.finished_at = Some(Utc::now().to_rfc3339());
                effect.stderr_preview = bounded_preview(error.to_string().as_bytes());
                journal.status = OperationStatus::Failed;
                journal.finished_at = Some(Utc::now().to_rfc3339());
                journal.partial_effects_possible = journal.effects[..index]
                    .iter()
                    .any(|effect| effect.status == EffectStatus::Succeeded);
                journal.error = Some(format!("effect {} failed to start", index + 1));
                persist(&path, &journal)?;
                return Err(ToolchainError::CommandStart(error.to_string()));
            }
        };
        let effect = journal.effects.last_mut().unwrap();
        effect.finished_at = Some(Utc::now().to_rfc3339());
        effect.exit_code = output.status.code();
        effect.stdout_preview = bounded_preview(&output.stdout);
        effect.stderr_preview = bounded_preview(&output.stderr);
        if output.status.success() {
            effect.status = EffectStatus::Succeeded;
            persist(&path, &journal)?;
            continue;
        }
        effect.status = EffectStatus::Failed;
        journal.status = OperationStatus::Failed;
        journal.finished_at = Some(Utc::now().to_rfc3339());
        journal.partial_effects_possible = true;
        journal.error = Some(format!(
            "effect {} exited with {}",
            index + 1,
            output
                .status
                .code()
                .map_or_else(|| "signal".to_string(), |code| code.to_string())
        ));
        persist(&path, &journal)?;
        return Err(ToolchainError::CommandFailed(
            journal.error.clone().unwrap(),
        ));
    }

    journal.status = OperationStatus::Succeeded;
    journal.finished_at = Some(Utc::now().to_rfc3339());
    journal.partial_effects_possible = false;
    persist(&path, &journal)?;
    Ok(journal)
}

fn validate_command(
    config: &ToolchainConfigDocument,
    command: &CommandSpec,
) -> Result<(), ToolchainError> {
    if command.args.len() > 1024 || command.env.len() > 128 {
        return Err(ToolchainError::InvalidJournal(
            "external effect exceeds argument or environment bounds".to_string(),
        ));
    }
    let cwd = command.cwd.canonicalize()?;
    if !cwd.starts_with(&config.project_root) {
        return Err(ToolchainError::PathContainment(cwd));
    }
    Ok(())
}

fn bounded_preview(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_OUTPUT_PREVIEW_BYTES)]).into_owned()
}

fn ensure_safe_parent(project_root: &Path, parent: &Path) -> Result<(), ToolchainError> {
    let mut current = project_root.to_path_buf();
    for component in parent
        .strip_prefix(project_root)
        .map_err(|_| ToolchainError::PathContainment(parent.to_path_buf()))?
    {
        current.push(component);
        if current.exists() {
            if fs::symlink_metadata(&current)?.file_type().is_symlink() {
                return Err(ToolchainError::SymbolicLink(current));
            }
        } else {
            fs::create_dir(&current)?;
        }
    }
    Ok(())
}

fn persist(path: &Path, journal: &OperationJournal) -> Result<(), ToolchainError> {
    let bytes = serde_json::to_vec_pretty(journal)?;
    if bytes.len() > MAX_JOURNAL_BYTES {
        return Err(ToolchainError::InvalidJournal(
            "operation journal exceeds the byte bound".to_string(),
        ));
    }
    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    fs::write(&temporary, bytes)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::{load_target_registry, load_toolchain_config};

    fn fixture() -> (
        tempfile::TempDir,
        ToolchainConfigDocument,
        TargetRegistryDocument,
    ) {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("rho.toml"),
            "schema = 1\n[runtime.python]\nversion = \"3.12\"\nmanager = \"uv\"\nproject = \"pyproject.toml\"\nlockfile = \"uv.lock\"\n",
        )
        .unwrap();
        let config = load_toolchain_config(root.path()).unwrap();
        let targets = load_target_registry(root.path()).unwrap();
        (root, config, targets)
    }

    #[cfg(unix)]
    #[test]
    fn unconfirmed_effects_never_create_operation_state() {
        let (_root, config, targets) = fixture();
        let commands = vec![CommandSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".to_string(), "exit 0".to_string()],
            cwd: config.project_root.clone(),
            env: Default::default(),
        }];
        assert!(
            execute_journaled_operation(
                &config,
                "sync-unconfirmed",
                OperationKind::Sync,
                &commands,
                &targets,
                false,
            )
            .is_err()
        );
        assert!(!config.project_root.join(".rho").exists());
    }

    #[cfg(unix)]
    #[test]
    fn failed_effect_preserves_truthful_partial_effects_journal() {
        let (root, config, targets) = fixture();
        let marker = root.path().join("effect.txt");
        let commands = vec![CommandSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec![
                "-c".to_string(),
                format!("printf applied > '{}'; exit 7", marker.display()),
            ],
            cwd: config.project_root.clone(),
            env: Default::default(),
        }];
        assert!(
            execute_journaled_operation(
                &config,
                "sync-001",
                OperationKind::Sync,
                &commands,
                &targets,
                true,
            )
            .is_err()
        );
        assert_eq!(fs::read_to_string(marker).unwrap(), "applied");
        let path = operation_journal_path(&config.project_root, "sync-001").unwrap();
        let journal: OperationJournal = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(journal.status, OperationStatus::Failed);
        assert!(journal.partial_effects_possible);
        assert_eq!(journal.target_id, "local");
        assert_eq!(journal.host_kind, "local");
        assert_eq!(journal.isolation_kind, "native");
        assert_eq!(journal.effects[0].exit_code, Some(7));
        assert_eq!(journal.effects[0].status, EffectStatus::Failed);
    }

    #[cfg(unix)]
    #[test]
    fn successful_effects_are_recorded_in_order() {
        let (_root, config, targets) = fixture();
        let commands = vec![CommandSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".to_string(), "printf ok".to_string()],
            cwd: config.project_root.clone(),
            env: Default::default(),
        }];
        let journal = execute_journaled_operation(
            &config,
            "lock-001",
            OperationKind::Lock,
            &commands,
            &targets,
            true,
        )
        .unwrap();
        assert_eq!(journal.status, OperationStatus::Succeeded);
        assert!(!journal.partial_effects_possible);
        assert_eq!(journal.effects[0].stdout_preview, "ok");
    }
}
