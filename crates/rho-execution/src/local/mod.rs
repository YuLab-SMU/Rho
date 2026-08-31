use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, sync_channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rho_protocol::{ArtifactRef, EffectClass, ExecutionId, OperationId, RetryClass};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const MAX_LOCAL_ARGV_ITEMS: usize = 128;
pub const MAX_LOCAL_ARG_BYTES: usize = 64 * 1024;
pub const MAX_LOCAL_ENV_ITEMS: usize = 64;
pub const MAX_LOCAL_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_LOCAL_QUEUE_ITEMS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalExecutionSpec {
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub executable: PathBuf,
    pub executable_sha256: String,
    pub argv: Vec<String>,
    pub working_set_root: PathBuf,
    pub working_directory: PathBuf,
    pub input_artifacts: Vec<ArtifactRef>,
    pub output_staging: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub secret_lease_ids: Vec<String>,
    pub network_profile: String,
    pub effect_class: EffectClass,
    pub retry_class: RetryClass,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatedLocalExecutionSpec(LocalExecutionSpec);

impl ValidatedLocalExecutionSpec {
    pub fn spec(&self) -> &LocalExecutionSpec {
        &self.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub executable_sha256: String,
    pub launch_nonce: String,
    pub started_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LocalSubmitOutcome {
    SpawnAcknowledged {
        identity: ProcessIdentity,
    },
    Duplicate {
        identity: ProcessIdentity,
    },
    Uncertain {
        identity: ProcessIdentity,
        reason_code: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalTerminalObservation {
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub reason_code: String,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub output_truncated: bool,
}

pub trait SubmitIntentRecorder {
    fn record_submit_intent(&mut self, spec: &ValidatedLocalExecutionSpec) -> Result<(), String>;
    fn record_process_handle(
        &mut self,
        execution_id: &ExecutionId,
        identity: &ProcessIdentity,
    ) -> Result<(), String>;
}

#[derive(Debug, Error)]
pub enum LocalExecutorError {
    #[error("local executable is missing or outside validated root")]
    ExecutableUnavailable,
    #[error("local executable digest mismatch")]
    DigestMismatch,
    #[error("local executor rejects shell-command launch paths")]
    ShellPathRejected,
    #[error("local argv/environment/lease/network bounds are invalid")]
    InvalidManifest,
    #[error("local working set is not contained and read-only")]
    WorkingSetRejected,
    #[error("local output staging is not contained, separate, and writable")]
    OutputStagingRejected,
    #[error("durable submit intent failed before spawn")]
    IntentRecordFailed,
    #[error("local process spawn failed before ACK")]
    SpawnFailed,
    #[error("local execution {0} is unknown")]
    UnknownExecution(ExecutionId),
}

struct PipeReader {
    receiver: Receiver<Vec<u8>>,
    dropped: Arc<AtomicU64>,
    thread: Option<JoinHandle<()>>,
}

struct RunningLocalProcess {
    spec: ValidatedLocalExecutionSpec,
    identity: ProcessIdentity,
    child: Child,
    stdout: PipeReader,
    stderr: PipeReader,
    stdout_bytes: Vec<u8>,
    stderr_bytes: Vec<u8>,
    started: Instant,
    output_truncated: bool,
}

#[derive(Default)]
pub struct LocalProcessExecutor {
    running: BTreeMap<ExecutionId, RunningLocalProcess>,
    submitted_operations: BTreeMap<OperationId, ProcessIdentity>,
    terminal: BTreeMap<ExecutionId, LocalTerminalObservation>,
}

impl LocalProcessExecutor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn prepare(
        spec: LocalExecutionSpec,
    ) -> Result<ValidatedLocalExecutionSpec, LocalExecutorError> {
        validate_spec(&spec)?;
        Ok(ValidatedLocalExecutionSpec(spec))
    }

    pub fn submit(
        &mut self,
        spec: ValidatedLocalExecutionSpec,
        recorder: &mut impl SubmitIntentRecorder,
    ) -> Result<LocalSubmitOutcome, LocalExecutorError> {
        if let Some(identity) = self.submitted_operations.get(&spec.0.operation_id).cloned() {
            return Ok(LocalSubmitOutcome::Duplicate { identity });
        }
        recorder
            .record_submit_intent(&spec)
            .map_err(|_| LocalExecutorError::IntentRecordFailed)?;
        let mut command = Command::new(&spec.0.executable);
        command
            .args(&spec.0.argv)
            .current_dir(&spec.0.working_directory)
            .env_clear()
            .envs(&spec.0.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|_| LocalExecutorError::SpawnFailed)?;
        let identity = ProcessIdentity {
            pid: child.id(),
            executable_sha256: spec.0.executable_sha256.clone(),
            launch_nonce: ExecutionId::generate().into_string(),
            started_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        let stdout = pipe_reader(child.stdout.take().ok_or(LocalExecutorError::SpawnFailed)?);
        let stderr = pipe_reader(child.stderr.take().ok_or(LocalExecutorError::SpawnFailed)?);
        self.submitted_operations
            .insert(spec.0.operation_id.clone(), identity.clone());
        self.running.insert(
            spec.0.execution_id.clone(),
            RunningLocalProcess {
                spec: spec.clone(),
                identity: identity.clone(),
                child,
                stdout,
                stderr,
                stdout_bytes: Vec::new(),
                stderr_bytes: Vec::new(),
                started: Instant::now(),
                output_truncated: false,
            },
        );
        if recorder
            .record_process_handle(&spec.0.execution_id, &identity)
            .is_err()
        {
            return Ok(LocalSubmitOutcome::Uncertain {
                identity,
                reason_code: "spawn_acknowledged_handle_record_failed".to_string(),
            });
        }
        Ok(LocalSubmitOutcome::SpawnAcknowledged { identity })
    }

    pub fn poll(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<Option<&LocalTerminalObservation>, LocalExecutorError> {
        if self.terminal.contains_key(execution_id) {
            return Ok(self.terminal.get(execution_id));
        }
        let mut running = self
            .running
            .remove(execution_id)
            .ok_or_else(|| LocalExecutorError::UnknownExecution(execution_id.clone()))?;
        drain_reader(
            &running.stdout,
            &mut running.stdout_bytes,
            &mut running.output_truncated,
        );
        drain_reader(
            &running.stderr,
            &mut running.stderr_bytes,
            &mut running.output_truncated,
        );
        if running.started.elapsed() >= Duration::from_millis(running.spec.0.timeout_ms) {
            terminate_tree(&mut running.child);
            let status = running.child.wait().ok();
            let terminal = finish_observation(running, status, "timeout");
            self.terminal.insert(execution_id.clone(), terminal);
            return Ok(self.terminal.get(execution_id));
        }
        match running.child.try_wait() {
            Ok(Some(status)) => {
                let terminal = finish_observation(running, Some(status), "process_exit");
                self.terminal.insert(execution_id.clone(), terminal);
                Ok(self.terminal.get(execution_id))
            }
            Ok(None) | Err(_) => {
                self.running.insert(execution_id.clone(), running);
                Ok(None)
            }
        }
    }

    pub fn cancel(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<&LocalTerminalObservation, LocalExecutorError> {
        if self.terminal.contains_key(execution_id) {
            return Ok(self.terminal.get(execution_id).expect("checked"));
        }
        let mut running = self
            .running
            .remove(execution_id)
            .ok_or_else(|| LocalExecutorError::UnknownExecution(execution_id.clone()))?;
        terminate_tree(&mut running.child);
        let status = running.child.wait().ok();
        let terminal = finish_observation(running, status, "cancelled_process_tree_confirmed");
        self.terminal.insert(execution_id.clone(), terminal);
        Ok(self.terminal.get(execution_id).expect("inserted"))
    }

    pub fn process_identity(&self, execution_id: &ExecutionId) -> Option<&ProcessIdentity> {
        self.running
            .get(execution_id)
            .map(|running| &running.identity)
            .or_else(|| {
                self.terminal
                    .get(execution_id)
                    .and_then(|terminal| self.submitted_operations.get(&terminal.operation_id))
            })
    }
}

impl Drop for LocalProcessExecutor {
    fn drop(&mut self) {
        for running in self.running.values_mut() {
            terminate_tree(&mut running.child);
            let _ = running.child.wait();
        }
    }
}

pub fn replay_after_stage(
    retry_class: RetryClass,
    spawn_acknowledged: bool,
    outcome_unknown: bool,
) -> bool {
    if !spawn_acknowledged {
        return true;
    }
    if outcome_unknown && retry_class == RetryClass::NonIdempotent {
        return false;
    }
    matches!(
        retry_class,
        RetryClass::PureRead | RetryClass::IdempotentWrite
    )
}

pub fn local_executable_digest(path: &Path) -> Result<String, LocalExecutorError> {
    let bytes = fs::read(path).map_err(|_| LocalExecutorError::ExecutableUnavailable)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn validate_spec(spec: &LocalExecutionSpec) -> Result<(), LocalExecutorError> {
    let executable = spec
        .executable
        .canonicalize()
        .map_err(|_| LocalExecutorError::ExecutableUnavailable)?;
    if local_executable_digest(&executable)? != spec.executable_sha256 {
        return Err(LocalExecutorError::DigestMismatch);
    }
    let basename = executable
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        basename.as_str(),
        "sh" | "bash" | "zsh" | "fish" | "cmd" | "cmd.exe" | "powershell" | "pwsh"
    ) || spec
        .argv
        .iter()
        .any(|argument| argument == "-c" || argument == "/C")
    {
        return Err(LocalExecutorError::ShellPathRejected);
    }
    if spec.argv.len() > MAX_LOCAL_ARGV_ITEMS
        || spec.argv.iter().map(String::len).sum::<usize>() > MAX_LOCAL_ARG_BYTES
        || spec.environment.len() > MAX_LOCAL_ENV_ITEMS
        || spec.secret_lease_ids.len() > MAX_LOCAL_ENV_ITEMS
        || !matches!(
            spec.network_profile.as_str(),
            "deny" | "provider_only" | "allowlisted"
        )
        || spec.timeout_ms == 0
    {
        return Err(LocalExecutorError::InvalidManifest);
    }
    let working_root = spec
        .working_set_root
        .canonicalize()
        .map_err(|_| LocalExecutorError::WorkingSetRejected)?;
    let working_directory = spec
        .working_directory
        .canonicalize()
        .map_err(|_| LocalExecutorError::WorkingSetRejected)?;
    if !working_directory.starts_with(&working_root) || !tree_is_read_only(&working_root) {
        return Err(LocalExecutorError::WorkingSetRejected);
    }
    let staging = spec
        .output_staging
        .canonicalize()
        .map_err(|_| LocalExecutorError::OutputStagingRejected)?;
    if staging.starts_with(&working_root)
        || !is_writable_directory(&staging)
        || spec.environment.keys().any(|key| {
            !matches!(
                key.as_str(),
                "PATH" | "LANG" | "HOME" | "TMPDIR" | "R_ENVIRON_USER" | "R_PROFILE_USER"
            )
        })
    {
        return Err(LocalExecutorError::OutputStagingRejected);
    }
    Ok(())
}

fn tree_is_read_only(root: &Path) -> bool {
    let Ok(metadata) = fs::metadata(root) else {
        return false;
    };
    if !metadata.permissions().readonly() {
        return false;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            return false;
        };
        if !metadata.permissions().readonly() {
            return false;
        }
        if metadata.is_dir() && !tree_is_read_only(&path) {
            return false;
        }
    }
    true
}

fn is_writable_directory(path: &Path) -> bool {
    path.is_dir()
        && !fs::metadata(path)
            .map(|value| value.permissions().readonly())
            .unwrap_or(true)
}

fn pipe_reader(reader: impl std::io::Read + Send + 'static) -> PipeReader {
    let (sender, receiver) = sync_channel(MAX_LOCAL_QUEUE_ITEMS);
    let dropped = Arc::new(AtomicU64::new(0));
    let counter = dropped.clone();
    let thread = thread::spawn(move || {
        for line in BufReader::new(reader).split(b'\n') {
            let Ok(line) = line else { break };
            if sender.try_send(line).is_err() {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }
    });
    PipeReader {
        receiver,
        dropped,
        thread: Some(thread),
    }
}

fn drain_reader(reader: &PipeReader, output: &mut Vec<u8>, truncated: &mut bool) {
    while let Ok(line) = reader.receiver.try_recv() {
        if output.len().saturating_add(line.len()).saturating_add(1) > MAX_LOCAL_CAPTURE_BYTES {
            *truncated = true;
            continue;
        }
        output.extend_from_slice(&line);
        output.push(b'\n');
    }
    if reader.dropped.load(Ordering::Relaxed) > 0 {
        *truncated = true;
    }
}

fn finish_observation(
    mut running: RunningLocalProcess,
    status: Option<ExitStatus>,
    reason: &str,
) -> LocalTerminalObservation {
    for reader in [&mut running.stdout, &mut running.stderr] {
        if let Some(thread) = reader.thread.take() {
            let _ = thread.join();
        }
    }
    drain_reader(
        &running.stdout,
        &mut running.stdout_bytes,
        &mut running.output_truncated,
    );
    drain_reader(
        &running.stderr,
        &mut running.stderr_bytes,
        &mut running.output_truncated,
    );
    let exit_code = status.as_ref().and_then(ExitStatus::code);
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.as_ref().and_then(ExitStatusExt::signal)
    };
    #[cfg(not(unix))]
    let signal = None;
    LocalTerminalObservation {
        execution_id: running.spec.0.execution_id,
        operation_id: running.spec.0.operation_id,
        exit_code,
        signal,
        reason_code: if reason == "process_exit" {
            if exit_code == Some(0) {
                "succeeded"
            } else if signal.is_some() {
                "signal"
            } else {
                "nonzero_exit"
            }
        } else {
            reason
        }
        .to_string(),
        stdout: running.stdout_bytes,
        stderr: running.stderr_bytes,
        output_truncated: running.output_truncated,
    }
}

fn terminate_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let group = format!("-{}", child.id());
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

pub fn local_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "validated_argv",
            "durable_submit_boundary",
            "bounded_stdio",
            "process_identity",
            "output_staging",
        ],
        &[
            "shell_string",
            "interactive_workspace",
            "inherited_environment",
            "direct_project_write",
            "automatic_non_idempotent_replay",
        ],
    )
}
