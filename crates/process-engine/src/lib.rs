//! Bounded native subprocess supervision, shared by builds and ordinary plugin backends.
#![forbid(unsafe_code)]
#[cfg(windows)]
use process_wrap::tokio::JobObject;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
pub use rho_plugin_protocol::{OutputCapture, ProcessReport, ProcessTermination};
use std::{
    io,
    process::{ExitStatus, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
    task::JoinHandle,
};

// Dropping the caller's channel does not authorize cancellation.
async fn wait_cancellation(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

pub struct ProcessOptions {
    pub timeout: Duration,
    pub output_limit_bytes: usize,
    pub stdin: Option<Vec<u8>>,
}

struct ChildGuard {
    child: Box<dyn ChildWrapper>,
    armed: bool,
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.child.start_kill();
        }
    }
}
struct Readers(Vec<JoinHandle<io::Result<()>>>);
impl Drop for Readers {
    fn drop(&mut self) {
        for reader in &self.0 {
            reader.abort();
        }
    }
}
enum End {
    Exited(io::Result<ExitStatus>),
    Cancelled,
    TimedOut,
}

/// Shared bounded subprocess mechanism. The caller supplies a configured Command;
/// domains interpret this report and alone decide which facts to commit.
pub async fn run_command(
    mut command: Command,
    options: ProcessOptions,
    mut cancelled: watch::Receiver<bool>,
) -> io::Result<ProcessReport> {
    if options.timeout.is_zero()
        || options.output_limit_bytes == 0
        || options.output_limit_bytes > 16 * 1024 * 1024
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid process timeout/output bound",
        ));
    }
    if *cancelled.borrow() {
        return Ok(report_before_start(ProcessTermination::Cancelled));
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if options.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut command = CommandWrap::from(command);
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());
    #[cfg(windows)]
    command.wrap(JobObject);
    let started = Instant::now();
    let child = command.spawn()?;
    let mut guard = ChildGuard { child, armed: true };
    let pid = guard.child.id();
    let stdout = Arc::new(Mutex::new(empty_capture()));
    let stderr = Arc::new(Mutex::new(empty_capture()));
    let stdin_error = Arc::new(Mutex::new(None));
    let mut readers = Readers(Vec::new());
    if let Some(pipe) = guard.child.stdout().take() {
        readers.0.push(tokio::spawn(capture(
            pipe,
            stdout.clone(),
            options.output_limit_bytes,
        )));
    }
    if let Some(pipe) = guard.child.stderr().take() {
        readers.0.push(tokio::spawn(capture(
            pipe,
            stderr.clone(),
            options.output_limit_bytes,
        )));
    }
    if let Some(mut pipe) = guard.child.stdin().take() {
        let input = options.stdin.unwrap_or_default();
        let error = stdin_error.clone();
        readers.0.push(tokio::spawn(async move {
            if let Err(failure) = pipe.write_all(&input).await {
                *error.lock().unwrap_or_else(|e| e.into_inner()) = Some(failure.to_string());
            }
            Ok(())
        }));
    }
    let end = {
        // Our only child wrapper is ProcessGroup/JobObject (KillOnDrop configures
        // Command only). Wait on its direct inner leader so surviving background
        // children cannot postpone cleanup. Keep the wrapper alive for group kill.
        let leader = guard.child.inner_mut();
        tokio::select! {
            biased;
            status=leader.wait()=>End::Exited(status),
            _=wait_cancellation(&mut cancelled)=>End::Cancelled,
            _=tokio::time::sleep(options.timeout)=>End::TimedOut,
        }
    };
    let mut cleanup_error = None;
    let (mut status, mut termination) = match end {
        End::Exited(Ok(status)) => (Some(status), ProcessTermination::Exited),
        End::Exited(Err(error)) => {
            cleanup_error = Some(error.to_string());
            (None, ProcessTermination::Uncertain)
        }
        End::Cancelled | End::TimedOut => match guard.child.inner_mut().try_wait() {
            Ok(Some(status)) => (Some(status), ProcessTermination::Exited),
            _ => (
                None,
                if matches!(end, End::Cancelled) {
                    ProcessTermination::Cancelled
                } else {
                    ProcessTermination::TimedOut
                },
            ),
        },
    };
    // A local command cannot leave background group members owning its streams
    // after the leader exits. This also kills the whole group on timeout/cancel.
    if let Err(error) = guard.child.start_kill()
        && !already_gone(&error)
    {
        cleanup_error = Some(error.to_string());
    }
    // Cleanup has now been attempted. Do not signal a cached Unix PGID again
    // after awaiting streams: the leader may be reaped and the ID reused.
    // Native KillOnDrop still owns any unreaped leader if this future is dropped.
    guard.armed = false;
    if status.is_none() {
        match tokio::time::timeout(Duration::from_secs(5), guard.child.inner_mut().wait()).await {
            Ok(Ok(exit)) => status = Some(exit),
            other => cleanup_error = Some(format!("process exit was not confirmed: {other:?}")),
        }
    }
    let drain = async {
        for reader in &mut readers.0 {
            // A writer's broken pipe is normal if the child intentionally stops
            // consuming stdin; read completeness is recorded by each capture.
            let _ = reader.await;
        }
    };
    if tokio::time::timeout(Duration::from_secs(2), drain)
        .await
        .is_err()
    {
        cleanup_error
            .get_or_insert_with(|| "output streams did not close after group cleanup".into());
    }
    let stdout = stdout.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let stderr = stderr.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if status.is_none() || cleanup_error.is_some() || !stdout.eof || !stderr.eof {
        termination = ProcessTermination::Uncertain;
    }
    Ok(ProcessReport {
        pid,
        exit_signal: status.and_then(exit_signal),
        exit_code: status.and_then(|status| status.code()),
        termination,
        stdout,
        stderr,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        supervision: supervision().into(),
        stdin_error: stdin_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        cleanup_requested: true,
        cleanup_error,
    })
}
fn exit_signal(status: ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}
fn supervision() -> &'static str {
    #[cfg(unix)]
    {
        "unix_process_group"
    }
    #[cfg(windows)]
    {
        "windows_job_object"
    }
    #[cfg(not(any(unix, windows)))]
    {
        "child_only"
    }
}
fn already_gone(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(nix::errno::Errno::ESRCH as i32)
    }
    #[cfg(not(unix))]
    {
        error.kind() == io::ErrorKind::NotFound
    }
}
fn empty_capture() -> OutputCapture {
    OutputCapture {
        bytes: Vec::new(),
        total_bytes: 0,
        truncated: false,
        eof: false,
    }
}
fn report_before_start(termination: ProcessTermination) -> ProcessReport {
    let mut empty = empty_capture();
    empty.eof = true;
    ProcessReport {
        pid: None,
        exit_code: None,
        exit_signal: None,
        termination,
        stdout: empty.clone(),
        stderr: empty,
        elapsed_ms: 0,
        supervision: supervision().into(),
        stdin_error: None,
        cleanup_requested: false,
        cleanup_error: None,
    }
}
async fn capture(
    mut input: impl AsyncRead + Unpin,
    output: Arc<Mutex<OutputCapture>>,
    limit: usize,
) -> io::Result<()> {
    let mut buffer = [0_u8; 8192];
    loop {
        let count = input.read(&mut buffer).await?;
        let mut output = output.lock().unwrap_or_else(|e| e.into_inner());
        if count == 0 {
            output.eof = true;
            return Ok(());
        }
        output.total_bytes = output.total_bytes.saturating_add(count as u64);
        let retained = limit.saturating_sub(output.bytes.len()).min(count);
        output.bytes.extend_from_slice(&buffer[..retained]);
        output.truncated |= retained < count;
    }
}
