use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
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
use uuid::Uuid;

use crate::{
    platform::{PlatformSandboxProfile, platform_wrapper},
    snapshot::ProjectSnapshot,
};

pub const MAX_SANDBOX_LOG_LINE_BYTES: usize = 4096;
pub const MAX_SANDBOX_LOG_ITEMS: usize = 256;
pub const MAX_SANDBOX_ENV_ITEMS: usize = 16;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SandboxMode {
    ObserverOnly,
    ControlledMutation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxQuota {
    pub deadline_ms: u64,
    pub max_disk_bytes: u64,
    pub max_log_bytes: u64,
    pub max_memory_bytes: u64,
    pub max_processes: u32,
    pub cpu_time_ms: u64,
}

impl Default for SandboxQuota {
    fn default() -> Self {
        Self {
            deadline_ms: 30_000,
            max_disk_bytes: 64 * 1024 * 1024,
            max_log_bytes: 4 * 1024 * 1024,
            max_memory_bytes: 512 * 1024 * 1024,
            max_processes: 32,
            cpu_time_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxMountView {
    pub workspace: String,
    pub scratch: String,
    pub staging: String,
    pub workspace_read_only: bool,
    pub authoritative_project_mounted: bool,
    pub workspace_socket_mounted: bool,
    pub database_mounted: bool,
    pub artifact_store_mounted: bool,
    pub secret_store_mounted: bool,
}

pub struct SandboxLayout {
    root: PathBuf,
    mount_view: SandboxMountView,
}

impl SandboxLayout {
    pub fn materialize(
        sandbox_parent: impl AsRef<Path>,
        snapshot: &ProjectSnapshot,
    ) -> Result<Self, SandboxProcessError> {
        fs::create_dir_all(sandbox_parent.as_ref())?;
        let root = sandbox_parent
            .as_ref()
            .join(format!("sandbox_{}", Uuid::now_v7().simple()));
        let workspace = root.join("workspace");
        let scratch = root.join("scratch");
        let staging = root.join("staging");
        fs::create_dir_all(&workspace)?;
        fs::create_dir_all(&scratch)?;
        fs::create_dir_all(&staging)?;
        for entry in &snapshot.manifest().files {
            let relative = safe_relative(&entry.relative_path)?;
            let destination = workspace.join(&relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            let bytes = snapshot.read(&entry.relative_path).ok_or_else(|| {
                SandboxProcessError::SnapshotMismatch(entry.relative_path.clone())
            })?;
            fs::write(&destination, bytes)?;
            set_read_only(&destination)?;
        }
        set_tree_read_only(&workspace)?;
        Ok(Self {
            root,
            mount_view: SandboxMountView {
                workspace: "/workspace".to_string(),
                scratch: "/scratch".to_string(),
                staging: "/staging".to_string(),
                workspace_read_only: true,
                authoritative_project_mounted: false,
                workspace_socket_mounted: false,
                database_mounted: false,
                artifact_store_mounted: false,
                secret_store_mounted: false,
            },
        })
    }

    pub fn mount_view(&self) -> &SandboxMountView {
        &self.mount_view
    }

    pub fn root_for_supervisor(&self) -> &Path {
        &self.root
    }

    pub fn scratch_for_supervisor(&self) -> PathBuf {
        self.root.join("scratch")
    }

    pub fn staging_for_supervisor(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub fn workspace_for_supervisor(&self) -> PathBuf {
        self.root.join("workspace")
    }

    pub fn permits_host_path(&self, candidate: &Path) -> bool {
        candidate
            .canonicalize()
            .ok()
            .is_some_and(|path| path.starts_with(&self.root))
    }
}

pub struct ScopedLeaseEnvironment {
    values: BTreeMap<String, String>,
}

impl ScopedLeaseEnvironment {
    pub fn new(values: BTreeMap<String, String>) -> Result<Self, SandboxProcessError> {
        if values.len() > MAX_SANDBOX_ENV_ITEMS
            || values.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "AISDK_PROVIDER_TOKEN" | "SSH_AUTH_SOCK" | "SSL_CERT_FILE"
                )
            })
        {
            return Err(SandboxProcessError::EnvironmentRejected);
        }
        Ok(Self { values })
    }

    fn expose_once(self) -> BTreeMap<String, String> {
        self.values
    }
}

impl std::fmt::Debug for ScopedLeaseEnvironment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ScopedLeaseEnvironment(REDACTED)")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxLaunchSpec {
    pub executable: PathBuf,
    pub executable_sha256: String,
    pub argv: Vec<String>,
    pub mode: SandboxMode,
    pub quota: SandboxQuota,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SandboxProcessState {
    Running,
    CancelRequested,
    QuotaTerminated,
    ProcessDead,
    Reaped,
    ReconcileRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxTermination {
    pub state: SandboxProcessState,
    pub reason_code: String,
    pub whole_tree_confirmed_dead: bool,
    pub cleanup_confirmed: bool,
}

#[derive(Debug, Error)]
pub enum SandboxProcessError {
    #[error("sandbox IO failed")]
    Io(#[from] std::io::Error),
    #[error("sandbox path is unsafe")]
    UnsafePath,
    #[error("snapshot bytes do not match manifest at {0}")]
    SnapshotMismatch(String),
    #[error("sandbox executable digest mismatch")]
    DigestMismatch,
    #[error("sandbox mutation disabled because platform guarantees are unavailable: {0}")]
    MutationGuaranteeUnavailable(String),
    #[error("sandbox environment is not an exact scoped allowlist")]
    EnvironmentRejected,
    #[error("sandbox spawn failed")]
    SpawnFailed,
}

struct ReaderState {
    receiver: Receiver<Vec<u8>>,
    dropped: Arc<AtomicU64>,
    reader: Option<JoinHandle<()>>,
}

pub struct SandboxSupervisor {
    child: Option<Child>,
    root: PathBuf,
    started: Instant,
    quota: SandboxQuota,
    stdout: ReaderState,
    stderr: ReaderState,
    log_bytes: u64,
    log_drops: u64,
    logs: VecDeque<Vec<u8>>,
    state: SandboxProcessState,
}

impl SandboxSupervisor {
    pub fn launch(
        layout: SandboxLayout,
        platform: &PlatformSandboxProfile,
        spec: &SandboxLaunchSpec,
        lease_environment: ScopedLeaseEnvironment,
    ) -> Result<Self, SandboxProcessError> {
        if spec.mode == SandboxMode::ControlledMutation && !platform.external_mutation_enabled {
            return Err(SandboxProcessError::MutationGuaranteeUnavailable(
                platform.reason.clone(),
            ));
        }
        if sandbox_executable_digest(&spec.executable)? != spec.executable_sha256 {
            return Err(SandboxProcessError::DigestMismatch);
        }
        let mut environment = lease_environment.expose_once();
        environment.insert("HOME".to_string(), "/scratch".to_string());
        environment.insert("TMPDIR".to_string(), "/scratch".to_string());
        environment.insert(
            "RHO_SANDBOX_WORKSPACE".to_string(),
            "/workspace".to_string(),
        );
        environment.insert("RHO_SANDBOX_STAGING".to_string(), "/staging".to_string());
        environment.insert("R_ENVIRON_USER".to_string(), "/dev/null".to_string());
        environment.insert("R_PROFILE_USER".to_string(), "/dev/null".to_string());

        let wrapper = platform_wrapper(platform, layout.root_for_supervisor());
        if spec.mode == SandboxMode::ControlledMutation && wrapper.is_none() {
            return Err(SandboxProcessError::MutationGuaranteeUnavailable(
                "platform enforcement wrapper unavailable".to_string(),
            ));
        }
        let mut command = if let Some((program, mut arguments)) = wrapper {
            arguments.push("--".to_string());
            arguments.push(spec.executable.display().to_string());
            arguments.extend(spec.argv.clone());
            let mut command = Command::new(program);
            command.args(arguments);
            command
        } else {
            let mut command = Command::new(&spec.executable);
            command.args(&spec.argv);
            command
        };
        command
            .current_dir(layout.scratch_for_supervisor())
            .env_clear()
            .envs(environment)
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
            .map_err(|_| SandboxProcessError::SpawnFailed)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(SandboxProcessError::SpawnFailed)?;
        let stderr = child
            .stderr
            .take()
            .ok_or(SandboxProcessError::SpawnFailed)?;
        let stdout = reader_state(stdout);
        let stderr = reader_state(stderr);
        Ok(Self {
            child: Some(child),
            root: layout.root,
            started: Instant::now(),
            quota: spec.quota.clone(),
            stdout,
            stderr,
            log_bytes: 0,
            log_drops: 0,
            logs: VecDeque::new(),
            state: SandboxProcessState::Running,
        })
    }

    pub fn poll(&mut self) {
        self.drain_logs();
        if self.started.elapsed() >= Duration::from_millis(self.quota.deadline_ms)
            || directory_bytes(&self.root) > self.quota.max_disk_bytes
            || self.log_bytes > self.quota.max_log_bytes
        {
            self.state = SandboxProcessState::QuotaTerminated;
            self.terminate_tree();
            return;
        }
        if let Some(child) = self.child.as_mut()
            && matches!(child.try_wait(), Ok(Some(_)))
        {
            self.state = SandboxProcessState::ProcessDead;
            self.reap_and_cleanup();
        }
    }

    pub fn cancel(&mut self) -> SandboxTermination {
        if self.child.is_none() {
            return SandboxTermination {
                state: self.state,
                reason_code: "already_terminal".to_string(),
                whole_tree_confirmed_dead: self.state == SandboxProcessState::Reaped,
                cleanup_confirmed: !self.root.exists(),
            };
        }
        self.state = SandboxProcessState::CancelRequested;
        self.terminate_tree();
        SandboxTermination {
            state: self.state,
            reason_code: "cancelled".to_string(),
            whole_tree_confirmed_dead: self.state == SandboxProcessState::Reaped,
            cleanup_confirmed: !self.root.exists(),
        }
    }

    pub fn finish(mut self) -> SandboxTermination {
        while self.child.is_some()
            && self.started.elapsed() < Duration::from_millis(self.quota.deadline_ms)
        {
            self.poll();
            if self.child.is_some() {
                thread::sleep(Duration::from_millis(5));
            }
        }
        if self.child.is_some() {
            self.state = SandboxProcessState::ReconcileRequired;
            self.terminate_tree();
        }
        SandboxTermination {
            state: self.state,
            reason_code: if self.state == SandboxProcessState::Reaped {
                "process_reaped"
            } else {
                "explicit_reconcile"
            }
            .to_string(),
            whole_tree_confirmed_dead: self.state == SandboxProcessState::Reaped,
            cleanup_confirmed: !self.root.exists(),
        }
    }

    pub fn state(&self) -> SandboxProcessState {
        self.state
    }

    pub fn pop_bounded_log(&mut self) -> Option<Vec<u8>> {
        self.logs.pop_front()
    }

    pub fn log_drops(&self) -> u64 {
        self.log_drops
            + self.stdout.dropped.load(Ordering::Relaxed)
            + self.stderr.dropped.load(Ordering::Relaxed)
    }

    fn drain_logs(&mut self) {
        for receiver in [&self.stdout.receiver, &self.stderr.receiver] {
            while let Ok(line) = receiver.try_recv() {
                self.log_bytes = self.log_bytes.saturating_add(line.len() as u64);
                if self.log_bytes > self.quota.max_log_bytes
                    || self.logs.len() >= MAX_SANDBOX_LOG_ITEMS
                {
                    self.log_drops += 1;
                } else {
                    self.logs.push_back(line);
                }
            }
        }
    }

    fn terminate_tree(&mut self) {
        if let Some(child) = self.child.as_mut() {
            terminate_process_tree(child);
            let _ = child.kill();
            let _ = child.wait();
        }
        self.state = SandboxProcessState::ProcessDead;
        self.reap_and_cleanup();
    }

    fn reap_and_cleanup(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        for reader in [&mut self.stdout, &mut self.stderr] {
            if let Some(handle) = reader.reader.take() {
                let _ = handle.join();
            }
        }
        self.drain_logs();
        let cleanup = make_tree_removable(&self.root).and_then(|_| fs::remove_dir_all(&self.root));
        self.state = if cleanup.is_ok() {
            SandboxProcessState::Reaped
        } else {
            SandboxProcessState::ReconcileRequired
        };
    }
}

impl Drop for SandboxSupervisor {
    fn drop(&mut self) {
        if self.child.is_some() {
            self.terminate_tree();
        } else if self.root.exists() {
            let _ = make_tree_removable(&self.root).and_then(|_| fs::remove_dir_all(&self.root));
        }
    }
}

fn reader_state(reader: impl std::io::Read + Send + 'static) -> ReaderState {
    let (sender, receiver) = sync_channel(MAX_SANDBOX_LOG_ITEMS);
    let dropped = Arc::new(AtomicU64::new(0));
    let counter = dropped.clone();
    let handle = thread::spawn(move || {
        for line in BufReader::new(reader).split(b'\n') {
            let Ok(mut line) = line else { break };
            if line.len() > MAX_SANDBOX_LOG_LINE_BYTES {
                line.truncate(MAX_SANDBOX_LOG_LINE_BYTES);
                counter.fetch_add(1, Ordering::Relaxed);
            }
            if sender.try_send(line).is_err() {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }
    });
    ReaderState {
        receiver,
        dropped,
        reader: Some(handle),
    }
}

fn safe_relative(value: &str) -> Result<PathBuf, SandboxProcessError> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(SandboxProcessError::UnsafePath);
    }
    Ok(path.to_path_buf())
}

fn make_tree_removable(root: &Path) -> Result<(), std::io::Error> {
    if !root.exists() {
        return Ok(());
    }
    if root.is_dir() {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            make_tree_removable(&entry.path())?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if root.is_dir() { 0o700 } else { 0o600 };
        fs::set_permissions(root, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(root)?.permissions();
        permissions.set_readonly(false);
        fs::set_permissions(root, permissions)?;
    }
    Ok(())
}

fn set_read_only(path: &Path) -> Result<(), std::io::Error> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
}

fn set_tree_read_only(root: &Path) -> Result<(), std::io::Error> {
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                directories.push(entry.path());
            }
        }
        set_read_only(&directory)?;
    }
    Ok(())
}

pub fn sandbox_executable_digest(path: &Path) -> Result<String, SandboxProcessError> {
    let bytes = fs::read(path)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn directory_bytes(root: &Path) -> u64 {
    fn visit(path: &Path, total: &mut u64) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                visit(&entry.path(), total);
            } else if metadata.is_file() {
                *total = total.saturating_add(metadata.len());
            }
        }
    }
    let mut total = 0;
    visit(root, &mut total);
    total
}

fn terminate_process_tree(child: &mut Child) {
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
}

pub fn process_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "snapshot_mount",
            "scratch_staging",
            "scoped_environment",
            "quota_deadline",
            "tree_reap_cleanup",
        ],
        &[
            "authoritative_project_mount",
            "workspace_socket",
            "rho_database",
            "artifact_store_internal",
            "secret_store",
            "silent_guarantee_downgrade",
        ],
    )
}
