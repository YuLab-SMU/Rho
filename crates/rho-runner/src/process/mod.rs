use std::{
    collections::{BTreeMap, VecDeque},
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, sync_channel},
    },
    thread::{self, JoinHandle},
    time::{SystemTime, UNIX_EPOCH},
};

use rho_protocol::ExecutionId;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::journal::RunnerProcessHandle;

pub const MAX_RUNNER_LOG_ITEMS: usize = 256;
pub const MAX_RUNNER_LOG_LINE_BYTES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovedRunnerLaunch {
    pub execution_id: ExecutionId,
    pub executable: String,
    pub argv: Vec<String>,
    pub working_directory: String,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunnerProcessObservation {
    Running,
    ExitedSuccess,
    ExitedFailure,
    Missing,
    IdentityMismatch,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct BoundedRunnerLogs {
    pub stdout: Vec<Vec<u8>>,
    pub stderr: Vec<Vec<u8>>,
    pub dropped: u64,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RunnerProcessError {
    #[error("runner process spawn failed")]
    Spawn,
    #[error("runner process handle is unknown")]
    Unknown,
    #[error("runner process identity mismatch")]
    IdentityMismatch,
}

pub trait RunnerProcessPort {
    fn spawn(
        &mut self,
        launch: &ApprovedRunnerLaunch,
    ) -> Result<RunnerProcessHandle, RunnerProcessError>;
    fn observe(
        &mut self,
        handle: &RunnerProcessHandle,
    ) -> Result<RunnerProcessObservation, RunnerProcessError>;
    fn cancel(&mut self, handle: &RunnerProcessHandle) -> Result<bool, RunnerProcessError>;
    fn take_logs(
        &mut self,
        handle: &RunnerProcessHandle,
    ) -> Result<BoundedRunnerLogs, RunnerProcessError>;
}

struct PipeReader {
    receiver: Receiver<Vec<u8>>,
    dropped: Arc<AtomicU64>,
    thread: Option<JoinHandle<()>>,
}

struct RunnerChild {
    child: Child,
    stdout: PipeReader,
    stderr: PipeReader,
    stdout_lines: VecDeque<Vec<u8>>,
    stderr_lines: VecDeque<Vec<u8>>,
}

#[derive(Default)]
pub struct OsRunnerProcessPort {
    children: BTreeMap<String, RunnerChild>,
}

impl RunnerProcessPort for OsRunnerProcessPort {
    fn spawn(
        &mut self,
        launch: &ApprovedRunnerLaunch,
    ) -> Result<RunnerProcessHandle, RunnerProcessError> {
        let mut command = Command::new(&launch.executable);
        command
            .args(&launch.argv)
            .current_dir(&launch.working_directory)
            .env_clear()
            .envs(&launch.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|_| RunnerProcessError::Spawn)?;
        let stdout = pipe_reader(child.stdout.take().ok_or(RunnerProcessError::Spawn)?);
        let stderr = pipe_reader(child.stderr.take().ok_or(RunnerProcessError::Spawn)?);
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let handle = RunnerProcessHandle {
            handle_id: format!("runner_handle_{}_{}", launch.execution_id.as_str(), started),
            pid: Some(child.id()),
            start_identity: format!("{}:{started}", child.id()),
        };
        self.children.insert(
            handle.handle_id.clone(),
            RunnerChild {
                child,
                stdout,
                stderr,
                stdout_lines: VecDeque::new(),
                stderr_lines: VecDeque::new(),
            },
        );
        Ok(handle)
    }

    fn observe(
        &mut self,
        handle: &RunnerProcessHandle,
    ) -> Result<RunnerProcessObservation, RunnerProcessError> {
        let child = self
            .children
            .get_mut(&handle.handle_id)
            .ok_or(RunnerProcessError::Unknown)?;
        drain_child(child);
        if Some(child.child.id()) != handle.pid {
            return Ok(RunnerProcessObservation::IdentityMismatch);
        }
        match child.child.try_wait() {
            Ok(None) => Ok(RunnerProcessObservation::Running),
            Ok(Some(status)) => {
                join_readers(child);
                if status.success() {
                    Ok(RunnerProcessObservation::ExitedSuccess)
                } else {
                    Ok(RunnerProcessObservation::ExitedFailure)
                }
            }
            Err(_) => Ok(RunnerProcessObservation::Unknown),
        }
    }

    fn cancel(&mut self, handle: &RunnerProcessHandle) -> Result<bool, RunnerProcessError> {
        let child = self
            .children
            .get_mut(&handle.handle_id)
            .ok_or(RunnerProcessError::Unknown)?;
        if Some(child.child.id()) != handle.pid {
            return Err(RunnerProcessError::IdentityMismatch);
        }
        terminate_tree(&mut child.child);
        let _ = child.child.wait();
        join_readers(child);
        Ok(true)
    }

    fn take_logs(
        &mut self,
        handle: &RunnerProcessHandle,
    ) -> Result<BoundedRunnerLogs, RunnerProcessError> {
        let child = self
            .children
            .get_mut(&handle.handle_id)
            .ok_or(RunnerProcessError::Unknown)?;
        drain_child(child);
        Ok(BoundedRunnerLogs {
            stdout: child.stdout_lines.drain(..).collect(),
            stderr: child.stderr_lines.drain(..).collect(),
            dropped: child.stdout.dropped.swap(0, Ordering::Relaxed)
                + child.stderr.dropped.swap(0, Ordering::Relaxed),
        })
    }
}

impl Drop for OsRunnerProcessPort {
    fn drop(&mut self) {
        for child in self.children.values_mut() {
            terminate_tree(&mut child.child);
            let _ = child.child.wait();
            join_readers(child);
        }
    }
}

fn pipe_reader(reader: impl std::io::Read + Send + 'static) -> PipeReader {
    let (sender, receiver) = sync_channel(MAX_RUNNER_LOG_ITEMS);
    let dropped = Arc::new(AtomicU64::new(0));
    let counter = dropped.clone();
    let thread = thread::spawn(move || {
        for line in BufReader::new(reader).split(b'\n') {
            let Ok(mut line) = line else { break };
            if line.len() > MAX_RUNNER_LOG_LINE_BYTES {
                line.truncate(MAX_RUNNER_LOG_LINE_BYTES);
                counter.fetch_add(1, Ordering::Relaxed);
            }
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

fn drain_child(child: &mut RunnerChild) {
    while let Ok(line) = child.stdout.receiver.try_recv() {
        if child.stdout_lines.len() < MAX_RUNNER_LOG_ITEMS {
            child.stdout_lines.push_back(line);
        } else {
            child.stdout.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    while let Ok(line) = child.stderr.receiver.try_recv() {
        if child.stderr_lines.len() < MAX_RUNNER_LOG_ITEMS {
            child.stderr_lines.push_back(line);
        } else {
            child.stderr.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn join_readers(child: &mut RunnerChild) {
    for reader in [&mut child.stdout, &mut child.stderr] {
        if let Some(thread) = reader.thread.take() {
            let _ = thread.join();
        }
    }
    drain_child(child);
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
