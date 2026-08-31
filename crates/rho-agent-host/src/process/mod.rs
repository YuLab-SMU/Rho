//! Deterministic provider child-process supervision.

use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, sync_channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const MAX_PROVIDER_STDOUT_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_PROVIDER_STDERR_LINE_BYTES: usize = 4096;
pub const MAX_PROVIDER_QUEUE_ITEMS: usize = 256;
pub const MAX_PROVIDER_ARGV_ITEMS: usize = 64;
pub const MAX_PROVIDER_ENV_ITEMS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovedProviderProcess {
    pub executable: PathBuf,
    pub executable_sha256: String,
    pub argv: Vec<String>,
    pub working_directory: PathBuf,
    pub isolated_root: PathBuf,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProcessState {
    Prepared,
    Spawned,
    Handshaking,
    Healthy,
    CancelSent,
    GracefulCloseSent,
    Terminating,
    ProcessDead,
    Reaped,
    SpawnFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessDiagnostic {
    pub code: String,
    pub detail: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProcessMetrics {
    pub stdout_queue_drops: u64,
    pub stderr_queue_drops: u64,
    pub protocol_frames: u64,
    pub diagnostics: u64,
}

#[derive(Debug, Error)]
pub enum ProviderProcessError {
    #[error("provider executable is outside approved isolated root")]
    ExecutableOutsideRoot,
    #[error("provider working directory is outside isolated root")]
    WorkingDirectoryOutsideRoot,
    #[error("provider executable digest mismatch")]
    DigestMismatch,
    #[error("provider argv or environment exceeds bound")]
    LaunchBounds,
    #[error("provider environment contains a forbidden key")]
    ForbiddenEnvironment,
    #[error("provider spawn failed: {0}")]
    SpawnFailed(String),
    #[error("provider handshake deadline expired")]
    HandshakeTimeout,
    #[error("provider stdin is unavailable")]
    StdinUnavailable,
    #[error("provider IO failed: {0}")]
    Io(String),
}

#[derive(Debug)]
enum ReaderItem {
    Line(Vec<u8>),
    Eof,
}

pub struct ProviderSupervisor {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout_rx: Receiver<ReaderItem>,
    stderr_rx: Receiver<ReaderItem>,
    readers: Vec<JoinHandle<()>>,
    state: ProviderProcessState,
    stdout_frames: VecDeque<Vec<u8>>,
    stderr_diagnostics: VecDeque<ProcessDiagnostic>,
    metrics: ProcessMetrics,
    stdout_reader_drops: Arc<AtomicU64>,
    stderr_reader_drops: Arc<AtomicU64>,
}

impl ProviderSupervisor {
    pub fn spawn(spec: &ApprovedProviderProcess) -> Result<Self, ProviderProcessError> {
        validate_launch(spec)?;
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.argv)
            .current_dir(&spec.working_directory)
            .env_clear()
            .envs(&spec.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|error| ProviderProcessError::SpawnFailed(redact_error(&error.to_string())))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderProcessError::SpawnFailed("provider stdout pipe unavailable".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProviderProcessError::SpawnFailed("provider stderr pipe unavailable".to_string())
        })?;
        let (stdout_tx, stdout_rx) = sync_channel(MAX_PROVIDER_QUEUE_ITEMS);
        let (stderr_tx, stderr_rx) = sync_channel(MAX_PROVIDER_QUEUE_ITEMS);
        let stdout_reader_drops = Arc::new(AtomicU64::new(0));
        let stderr_reader_drops = Arc::new(AtomicU64::new(0));
        let stdout_drop_counter = stdout_reader_drops.clone();
        let stderr_drop_counter = stderr_reader_drops.clone();
        let stdout_reader = thread::spawn(move || {
            read_lines_bounded(
                BufReader::new(stdout),
                MAX_PROVIDER_STDOUT_FRAME_BYTES,
                stdout_tx,
                stdout_drop_counter,
            )
        });
        let stderr_reader = thread::spawn(move || {
            read_lines_bounded(
                BufReader::new(stderr),
                MAX_PROVIDER_STDERR_LINE_BYTES,
                stderr_tx,
                stderr_drop_counter,
            )
        });
        Ok(Self {
            child: Some(child),
            stdin,
            stdout_rx,
            stderr_rx,
            readers: vec![stdout_reader, stderr_reader],
            state: ProviderProcessState::Spawned,
            stdout_frames: VecDeque::new(),
            stderr_diagnostics: VecDeque::new(),
            metrics: ProcessMetrics::default(),
            stdout_reader_drops,
            stderr_reader_drops,
        })
    }

    pub fn begin_handshake(&mut self) {
        if self.state == ProviderProcessState::Spawned {
            self.state = ProviderProcessState::Handshaking;
        }
    }

    pub fn confirm_handshake(&mut self) {
        if self.state == ProviderProcessState::Handshaking {
            self.state = ProviderProcessState::Healthy;
        }
    }

    pub fn enforce_handshake_deadline(
        &mut self,
        started: Instant,
        deadline: Duration,
    ) -> Result<(), ProviderProcessError> {
        if self.state == ProviderProcessState::Handshaking && started.elapsed() >= deadline {
            self.terminate_and_reap();
            return Err(ProviderProcessError::HandshakeTimeout);
        }
        Ok(())
    }

    pub fn send_protocol_frame(&mut self, frame: &[u8]) -> Result<(), ProviderProcessError> {
        if frame.len() > MAX_PROVIDER_STDOUT_FRAME_BYTES {
            return Err(ProviderProcessError::LaunchBounds);
        }
        let stdin = self
            .stdin
            .as_mut()
            .ok_or(ProviderProcessError::StdinUnavailable)?;
        stdin
            .write_all(frame)
            .and_then(|_| stdin.flush())
            .map_err(|error| ProviderProcessError::Io(redact_error(&error.to_string())))
    }

    pub fn request_cancel(&mut self, frame: &[u8]) -> Result<(), ProviderProcessError> {
        if matches!(
            self.state,
            ProviderProcessState::ProcessDead | ProviderProcessState::Reaped
        ) {
            return Ok(());
        }
        self.send_protocol_frame(frame)?;
        self.state = ProviderProcessState::CancelSent;
        Ok(())
    }

    pub fn poll(&mut self) {
        drain_stdout(&self.stdout_rx, &mut self.stdout_frames, &mut self.metrics);
        drain_stderr(
            &self.stderr_rx,
            &mut self.stderr_diagnostics,
            &mut self.metrics,
        );
        self.metrics.stdout_queue_drops += self.stdout_reader_drops.swap(0, Ordering::Relaxed);
        self.metrics.stderr_queue_drops += self.stderr_reader_drops.swap(0, Ordering::Relaxed);
        if let Some(child) = self.child.as_mut()
            && matches!(child.try_wait(), Ok(Some(_)))
        {
            self.state = ProviderProcessState::ProcessDead;
        }
    }

    pub fn pop_protocol_frame(&mut self) -> Option<Vec<u8>> {
        self.stdout_frames.pop_front()
    }

    pub fn pop_diagnostic(&mut self) -> Option<ProcessDiagnostic> {
        self.stderr_diagnostics.pop_front()
    }

    pub fn graceful_close_and_reap(&mut self, close_frame: &[u8], deadline: Duration) {
        if matches!(
            self.state,
            ProviderProcessState::ProcessDead | ProviderProcessState::Reaped
        ) {
            self.reap();
            return;
        }
        let _ = self.send_protocol_frame(close_frame);
        self.stdin.take();
        self.state = ProviderProcessState::GracefulCloseSent;
        let started = Instant::now();
        while started.elapsed() < deadline {
            self.poll();
            if self.state == ProviderProcessState::ProcessDead {
                self.reap();
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        self.terminate_and_reap();
    }

    pub fn terminate_and_reap(&mut self) {
        self.state = ProviderProcessState::Terminating;
        if let Some(child) = self.child.as_mut() {
            terminate_process_tree(child);
            let _ = child.kill();
            let _ = child.wait();
        }
        self.state = ProviderProcessState::ProcessDead;
        self.reap();
    }

    pub fn state(&self) -> ProviderProcessState {
        self.state
    }

    pub fn metrics(&self) -> &ProcessMetrics {
        &self.metrics
    }

    pub fn orphan_detected(&mut self) -> bool {
        self.poll();
        self.child.is_some()
            && !matches!(
                self.state,
                ProviderProcessState::ProcessDead | ProviderProcessState::Reaped
            )
    }

    fn reap(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        self.stdin.take();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
        self.state = ProviderProcessState::Reaped;
    }
}

impl Drop for ProviderSupervisor {
    fn drop(&mut self) {
        if self.child.is_some() {
            self.terminate_and_reap();
        }
    }
}

pub fn executable_digest(path: &Path) -> Result<String, ProviderProcessError> {
    let bytes = fs::read(path)
        .map_err(|error| ProviderProcessError::Io(redact_error(&error.to_string())))?;
    let digest = Sha256::digest(bytes);
    Ok(format!("sha256:{digest:x}"))
}

pub fn validate_launch(spec: &ApprovedProviderProcess) -> Result<(), ProviderProcessError> {
    if spec.argv.len() > MAX_PROVIDER_ARGV_ITEMS || spec.environment.len() > MAX_PROVIDER_ENV_ITEMS
    {
        return Err(ProviderProcessError::LaunchBounds);
    }
    let root = spec
        .isolated_root
        .canonicalize()
        .map_err(|error| ProviderProcessError::Io(redact_error(&error.to_string())))?;
    let executable = spec
        .executable
        .canonicalize()
        .map_err(|error| ProviderProcessError::SpawnFailed(redact_error(&error.to_string())))?;
    let workdir = spec
        .working_directory
        .canonicalize()
        .map_err(|error| ProviderProcessError::Io(redact_error(&error.to_string())))?;
    if !executable.starts_with(&root) {
        return Err(ProviderProcessError::ExecutableOutsideRoot);
    }
    if !workdir.starts_with(&root) {
        return Err(ProviderProcessError::WorkingDirectoryOutsideRoot);
    }
    if executable_digest(&executable)? != spec.executable_sha256 {
        return Err(ProviderProcessError::DigestMismatch);
    }
    const ALLOWED_ENV: [&str; 6] = [
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "AISDK_PROVIDER_TOKEN",
        "SSL_CERT_FILE",
    ];
    if spec
        .environment
        .keys()
        .any(|key| !ALLOWED_ENV.contains(&key.as_str()))
    {
        return Err(ProviderProcessError::ForbiddenEnvironment);
    }
    Ok(())
}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = format!("-{}", child.id());
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &process_group])
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
}

fn read_lines_bounded<R: std::io::Read>(
    reader: BufReader<R>,
    max_bytes: usize,
    sender: std::sync::mpsc::SyncSender<ReaderItem>,
    dropped: Arc<AtomicU64>,
) {
    for line in reader.split(b'\n') {
        let Ok(mut line) = line else { break };
        if line.len() > max_bytes {
            line.truncate(max_bytes);
        }
        if sender.try_send(ReaderItem::Line(line)).is_err() {
            dropped.fetch_add(1, Ordering::Relaxed);
            continue;
        }
    }
    let _ = sender.try_send(ReaderItem::Eof);
}

fn drain_stdout(
    receiver: &Receiver<ReaderItem>,
    queue: &mut VecDeque<Vec<u8>>,
    metrics: &mut ProcessMetrics,
) {
    while let Ok(ReaderItem::Line(line)) = receiver.try_recv() {
        if queue.len() >= MAX_PROVIDER_QUEUE_ITEMS {
            metrics.stdout_queue_drops += 1;
        } else {
            queue.push_back(line);
            metrics.protocol_frames += 1;
        }
    }
}

fn drain_stderr(
    receiver: &Receiver<ReaderItem>,
    queue: &mut VecDeque<ProcessDiagnostic>,
    metrics: &mut ProcessMetrics,
) {
    while let Ok(ReaderItem::Line(line)) = receiver.try_recv() {
        if queue.len() >= MAX_PROVIDER_QUEUE_ITEMS {
            metrics.stderr_queue_drops += 1;
        } else {
            let detail = String::from_utf8_lossy(&line);
            let redacted = redact_error(&detail);
            queue.push_back(ProcessDiagnostic {
                code: "provider_stderr".to_string(),
                detail: redacted.clone(),
                truncated: line.len() >= MAX_PROVIDER_STDERR_LINE_BYTES,
            });
            metrics.diagnostics += 1;
        }
    }
}

fn redact_error(detail: &str) -> String {
    let one_line = detail.replace(['\r', '\n'], " ");
    let mut redacted = one_line;
    for marker in ["Bearer ", "token=", "secret=", "password="] {
        if let Some(start) = redacted
            .to_ascii_lowercase()
            .find(&marker.to_ascii_lowercase())
        {
            redacted.truncate(start);
            redacted.push_str("[REDACTED]");
        }
    }
    redacted
        .chars()
        .take(MAX_PROVIDER_STDERR_LINE_BYTES)
        .collect()
}

pub fn process_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "approved_spawn",
            "bounded_stdio",
            "cancel_kill_reap",
            "orphan_detection",
        ],
        &[
            "semantic_log",
            "general_environment",
            "effect_authority",
            "provider_raw_frame_persistence",
        ],
    )
}
