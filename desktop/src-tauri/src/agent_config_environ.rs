//! Bounded reader for one credential from the startup-pinned user
//! `.Renviron`.
//!
//! The helper deliberately delegates `.Renviron` parsing to the configured R
//! runtime. It launches R with one constant script, passes the already
//! validated variable name as an ordinary argument, pins the exact user
//! environment file discovered at startup, and prevents project startup files
//! or inherited credentials from becoming authority.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail, ensure};
use zeroize::Zeroizing;

const USER_ENVIRON_READ_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_CREDENTIAL_BYTES: usize = 4_096;
const MAX_STDOUT_BYTES: u64 = (2 * MAX_CREDENTIAL_BYTES + 4) as u64;
const MAX_STDERR_BYTES: u64 = 16 * 1024;
const MAX_USER_ENVIRON_BYTES: u64 = 256 * 1024;
const MAX_ENVIRONMENT_NAME_BYTES: usize = 256;
const MAX_PRESENCE_VARIABLES: usize = 256;
const MAX_PRESENCE_ARGUMENT_BYTES: usize = 16 * 1024;

/// Inherited variables that can redirect R startup code, package loading, a
/// shell wrapper, or the platform dynamic loader. The selected `Rscript` still
/// inherits ordinary runtime necessities such as `PATH`, locale, and system
/// temporary-directory settings.
const STARTUP_SURFACE_ENVIRONMENT_NAMES: &[&str] = &[
    "R_PROFILE",
    "R_PROFILE_USER",
    "R_LIBS",
    "R_LIBS_USER",
    "R_LIBS_SITE",
    "R_HOME",
    "R_USER",
    "R_ARCH",
    "BASH_ENV",
    "ENV",
    "LD_AUDIT",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_FALLBACK_FRAMEWORK_PATH",
];

const HELPER_FAILURE: &str = "Rho could not read the selected user R environment credential.";
const HELPER_TIMEOUT: &str = "The user R environment credential read timed out.";
const HELPER_OUTPUT_FAILURE: &str =
    "The user R environment credential helper exceeded its output limit.";
const HELPER_PROTOCOL_FAILURE: &str =
    "Rho received an invalid user R environment credential response.";

/// Constant R program used for every selected variable. The variable name is
/// supplied as `argv`, never interpolated into executable R source. Hex keeps
/// newlines and protocol punctuation in a value from changing output framing.
const USER_ENVIRON_READ_EXPRESSION: &str = r#"args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) {
  quit(save = "no", status = 64L, runLast = FALSE)
}
value <- Sys.getenv(args[[1L]], unset = NA_character_)
if (is.na(value) || !nzchar(value)) {
  cat("0\n")
  quit(save = "no", status = 0L, runLast = FALSE)
}
encoded <- paste(sprintf("%02x", as.integer(charToRaw(enc2utf8(value)))), collapse = "")
cat("1:", encoded, "\n", sep = "")
"#;

const USER_ENVIRON_PRESENCE_EXPRESSION: &str = r#"args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1L) {
  quit(save = "no", status = 64L, runLast = FALSE)
}
values <- Sys.getenv(args, unset = NA_character_)
present <- !is.na(values) & nzchar(values)
cat(paste(ifelse(present, "1", "0"), collapse = ""), "\n", sep = "")
"#;

#[derive(Clone, Copy)]
struct HelperLimits {
    timeout: Duration,
    max_stdout_bytes: u64,
    max_stderr_bytes: u64,
}

impl Default for HelperLimits {
    fn default() -> Self {
        Self {
            timeout: USER_ENVIRON_READ_TIMEOUT,
            max_stdout_bytes: MAX_STDOUT_BYTES,
            max_stderr_bytes: MAX_STDERR_BYTES,
        }
    }
}

#[derive(Clone, Copy)]
enum HelperMode {
    Exact,
    Presence,
}

impl HelperMode {
    fn expression(self) -> &'static str {
        match self {
            Self::Exact => USER_ENVIRON_READ_EXPRESSION,
            Self::Presence => USER_ENVIRON_PRESENCE_EXPRESSION,
        }
    }
}

struct UserEnvironSnapshot {
    bytes: Zeroizing<Vec<u8>>,
}

#[cfg(unix)]
struct StagedUserEnviron {
    _file: File,
    path: PathBuf,
}

#[cfg(windows)]
struct StagedUserEnviron {
    path: PathBuf,
    cancel: Arc<AtomicBool>,
    writer: Option<JoinHandle<std::result::Result<(), ()>>>,
}

#[cfg(not(any(unix, windows)))]
struct StagedUserEnviron {
    path: PathBuf,
}

impl StagedUserEnviron {
    fn path(&self) -> &Path {
        #[cfg(unix)]
        {
            &self.path
        }
        #[cfg(windows)]
        {
            &self.path
        }
        #[cfg(not(any(unix, windows)))]
        {
            &self.path
        }
    }

    fn finish(&mut self) -> Result<()> {
        #[cfg(windows)]
        {
            self.cancel.store(true, Ordering::Release);
            if let Some(writer) = self.writer.take() {
                super::join_r_probe_thread(writer, "user R environment snapshot pipe")
                    .map_err(|_| anyhow!(HELPER_FAILURE))?
                    .map_err(|_| anyhow!(HELPER_FAILURE))?
                    .map_err(|_| anyhow!(HELPER_FAILURE))?;
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for StagedUserEnviron {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

/// Read exactly one non-empty credential from the startup-pinned user
/// `.Renviron` with the configured R runtime.
///
/// The caller owns the process-environment precedence check and must call this
/// function only when that source is absent. `declared_sensitive_names` must
/// contain every configured `api_key_env`; all of them, the selected name, and
/// generic credential-bearing inherited names are removed before R starts.
/// R then learns the selected value only by loading `r_environ_user`.
pub(crate) fn read_user_environ_credential(
    rscript: &Path,
    r_environ_user: &Path,
    variable: &str,
    declared_sensitive_names: &BTreeSet<String>,
) -> Result<Option<Zeroizing<String>>> {
    let inherited_environment_names = std::env::vars_os()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    read_user_environ_credential_with_command(
        Command::new(rscript),
        r_environ_user,
        variable,
        declared_sensitive_names,
        &inherited_environment_names,
        HelperLimits::default(),
    )
}

/// Batch presence-only Settings probe. One helper handles the validated,
/// deduplicated variable set and emits only one bit per sorted name, so no
/// credential value crosses the child-process boundary and provider count
/// cannot multiply the process timeout.
pub(crate) fn user_environ_credentials_present(
    rscript: &Path,
    r_environ_user: &Path,
    variables: &BTreeSet<String>,
    declared_sensitive_names: &BTreeSet<String>,
) -> Result<BTreeMap<String, bool>> {
    if variables.is_empty() {
        return Ok(BTreeMap::new());
    }
    let inherited_environment_names = std::env::vars_os()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    user_environ_credentials_present_with_command(
        Command::new(rscript),
        r_environ_user,
        variables,
        declared_sensitive_names,
        &inherited_environment_names,
        HelperLimits::default(),
    )
}

fn user_environ_credentials_present_with_command(
    command: Command,
    r_environ_user: &Path,
    variables: &BTreeSet<String>,
    declared_sensitive_names: &BTreeSet<String>,
    inherited_environment_names: &[OsString],
    limits: HelperLimits,
) -> Result<BTreeMap<String, bool>> {
    validate_presence_variables(variables)?;
    let ordered_variables = variables.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_user_environ_helper_with_command(
        command,
        r_environ_user,
        &ordered_variables,
        declared_sensitive_names,
        inherited_environment_names,
        HelperLimits {
            max_stdout_bytes: u64::try_from(variables.len() + 2)
                .map_err(|_| anyhow!(HELPER_FAILURE))?,
            ..limits
        },
        HelperMode::Presence,
    )?;
    parse_presence_stdout(&output, variables)
}

fn read_user_environ_credential_with_command(
    command: Command,
    r_environ_user: &Path,
    variable: &str,
    declared_sensitive_names: &BTreeSet<String>,
    inherited_environment_names: &[OsString],
    limits: HelperLimits,
) -> Result<Option<Zeroizing<String>>> {
    let variables = [variable];
    let output = run_user_environ_helper_with_command(
        command,
        r_environ_user,
        &variables,
        declared_sensitive_names,
        inherited_environment_names,
        limits,
        HelperMode::Exact,
    )?;
    parse_helper_stdout(&output)
}

fn run_user_environ_helper_with_command(
    command: Command,
    r_environ_user: &Path,
    variables: &[&str],
    declared_sensitive_names: &BTreeSet<String>,
    inherited_environment_names: &[OsString],
    limits: HelperLimits,
    mode: HelperMode,
) -> Result<Zeroizing<Vec<u8>>> {
    validate_helper_variables(variables)?;
    let snapshot = read_user_environ_snapshot(r_environ_user)?;
    run_user_environ_helper_with_snapshot(
        command,
        snapshot,
        variables,
        declared_sensitive_names,
        inherited_environment_names,
        limits,
        mode,
    )
}

fn run_user_environ_helper_with_snapshot(
    mut command: Command,
    snapshot: UserEnvironSnapshot,
    variables: &[&str],
    declared_sensitive_names: &BTreeSet<String>,
    inherited_environment_names: &[OsString],
    limits: HelperLimits,
    mode: HelperMode,
) -> Result<Zeroizing<Vec<u8>>> {
    validate_helper_variables(variables)?;

    // A fresh system-temporary cwd prevents any project `.Renviron` or
    // `.Rprofile` from entering R's startup search. Keep every helper artifact
    // inside it so the whole containment boundary is removed on return.
    let sandbox = tempfile::Builder::new()
        .prefix("rho-user-environ-")
        .tempdir()
        .map_err(|_| anyhow!("Rho could not prepare the user R environment credential helper."))?;
    let empty_site_environ = tempfile::NamedTempFile::new_in(sandbox.path())
        .map_err(|_| anyhow!("Rho could not prepare the user R environment credential helper."))?;
    let mut script = tempfile::Builder::new()
        .prefix("rho-user-environ-")
        .suffix(".R")
        .tempfile_in(sandbox.path())
        .map_err(|_| anyhow!("Rho could not prepare the user R environment credential helper."))?;
    script
        .write_all(mode.expression().as_bytes())
        .and_then(|_| script.flush())
        .map_err(|_| anyhow!("Rho could not prepare the user R environment credential helper."))?;
    let mut staged_user_environ =
        stage_user_environ_snapshot(snapshot, sandbox.path(), &mut command)?;

    configure_helper_command(
        &mut command,
        staged_user_environ.path(),
        empty_site_environ.path(),
        script.path(),
        variables,
        declared_sensitive_names,
        sandbox.path(),
        inherited_environment_names,
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    super::hide_console_window(&mut command);
    super::configure_r_probe_process_containment(&mut command);

    let containment =
        super::RProbeProcessContainment::new().map_err(|_| anyhow!(HELPER_FAILURE))?;
    let spawned = command.spawn().map_err(|_| anyhow!(HELPER_FAILURE))?;
    let mut child = super::RProbeChildGuard::new(spawned, containment, None)
        .map_err(|_| anyhow!(HELPER_FAILURE))?;
    let stdout_pipe = match child.child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_and_reap(&mut child);
            bail!(HELPER_FAILURE);
        }
    };
    let stderr_pipe = match child.child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_and_reap(&mut child);
            bail!(HELPER_FAILURE);
        }
    };
    let output_limit_exceeded = Arc::new(AtomicBool::new(false));
    let reader_failed = Arc::new(AtomicBool::new(false));
    let stdout_reader = match spawn_bounded_reader(
        "rho-user-environ-stdout",
        stdout_pipe,
        limits.max_stdout_bytes,
        Arc::clone(&output_limit_exceeded),
        Arc::clone(&reader_failed),
    ) {
        Ok(reader) => reader,
        Err(()) => {
            terminate_and_reap(&mut child);
            bail!(HELPER_FAILURE);
        }
    };
    let stderr_reader = match spawn_bounded_reader(
        "rho-user-environ-stderr",
        stderr_pipe,
        limits.max_stderr_bytes,
        Arc::clone(&output_limit_exceeded),
        Arc::clone(&reader_failed),
    ) {
        Ok(reader) => reader,
        Err(()) => {
            terminate_and_reap(&mut child);
            let _ = join_bounded_reader(stdout_reader);
            bail!(HELPER_FAILURE);
        }
    };

    let started = Instant::now();
    let (status, process_error) = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // A successful direct child may still have descendants holding
                // inherited pipe handles. Terminate the containment before
                // bounded reader joins so they cannot hang the Settings path.
                let _ = child.terminate_process_tree();
                break (Some(status), None);
            }
            Ok(None) => {}
            Err(_) => {
                terminate_and_reap(&mut child);
                break (None, Some(HELPER_FAILURE));
            }
        }

        if started.elapsed() >= limits.timeout {
            terminate_and_reap(&mut child);
            break (None, Some(HELPER_TIMEOUT));
        }
        if output_limit_exceeded.load(Ordering::Acquire) {
            terminate_and_reap(&mut child);
            break (None, Some(HELPER_OUTPUT_FAILURE));
        }
        if reader_failed.load(Ordering::Acquire) {
            terminate_and_reap(&mut child);
            break (None, Some(HELPER_FAILURE));
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL.min(limits.timeout));
    };

    let stdout_result = join_bounded_reader(stdout_reader);
    let stderr_result = join_bounded_reader(stderr_reader);
    let staged_result = staged_user_environ.finish();
    let stdout = stdout_result?;
    let _stderr = stderr_result?;
    if output_limit_exceeded.load(Ordering::Acquire) {
        bail!(HELPER_OUTPUT_FAILURE);
    }
    if reader_failed.load(Ordering::Acquire) {
        bail!(HELPER_FAILURE);
    }
    if let Some(error) = process_error {
        bail!(error);
    }
    staged_result?;
    ensure!(
        status.is_some_and(|status| status.success()),
        HELPER_FAILURE
    );
    ensure!(
        stdout.len() as u64 <= limits.max_stdout_bytes,
        HELPER_OUTPUT_FAILURE
    );
    Ok(stdout)
}

#[allow(clippy::too_many_arguments)]
fn configure_helper_command(
    command: &mut Command,
    r_environ_user: &Path,
    empty_site_environ: &Path,
    script: &Path,
    variables: &[&str],
    declared_sensitive_names: &BTreeSet<String>,
    neutral_workdir: &Path,
    inherited_environment_names: &[OsString],
) {
    command
        .args([
            "--no-restore",
            "--no-save",
            "--no-site-file",
            "--no-init-file",
        ])
        .arg(script)
        .args(variables)
        .current_dir(neutral_workdir);

    for name in inherited_environment_names {
        if name
            .to_str()
            .is_some_and(rho_kernel::is_sensitive_environment_name)
        {
            command.env_remove(name);
        }
    }
    for name in declared_sensitive_names {
        command.env_remove(name);
    }
    for variable in variables {
        command.env_remove(variable);
    }
    for name in STARTUP_SURFACE_ENVIRONMENT_NAMES {
        command.env_remove(name);
    }
    command
        .env("R_DEFAULT_PACKAGES", "NULL")
        .env("R_ENVIRON", empty_site_environ)
        .env("R_ENVIRON_USER", r_environ_user);
}

fn validate_environment_name(variable: &str) -> Result<()> {
    ensure!(
        !variable.is_empty() && variable.len() <= MAX_ENVIRONMENT_NAME_BYTES,
        "The selected credential environment name is invalid."
    );
    let mut characters = variable.chars();
    let first = characters
        .next()
        .filter(|character| *character == '_' || character.is_ascii_alphabetic())
        .ok_or_else(|| anyhow!("The selected credential environment name is invalid."))?;
    let _ = first;
    ensure!(
        characters.all(|character| character == '_' || character.is_ascii_alphanumeric()),
        "The selected credential environment name is invalid."
    );
    Ok(())
}

fn validate_helper_variables(variables: &[&str]) -> Result<()> {
    ensure!(
        !variables.is_empty(),
        "The user R environment credential helper requires at least one variable."
    );
    let mut total_bytes = 0_usize;
    for variable in variables {
        validate_environment_name(variable)?;
        total_bytes = total_bytes
            .checked_add(variable.len() + 1)
            .ok_or_else(|| anyhow!("The credential environment variable list is too large."))?;
    }
    ensure!(
        total_bytes <= MAX_PRESENCE_ARGUMENT_BYTES,
        "The credential environment variable list is too large."
    );
    Ok(())
}

fn validate_presence_variables(variables: &BTreeSet<String>) -> Result<()> {
    ensure!(
        !variables.is_empty() && variables.len() <= MAX_PRESENCE_VARIABLES,
        "The credential environment variable list is too large."
    );
    let ordered = variables.iter().map(String::as_str).collect::<Vec<_>>();
    validate_helper_variables(&ordered)
}

fn read_user_environ_snapshot(path: &Path) -> Result<UserEnvironSnapshot> {
    ensure!(
        path.is_absolute(),
        "The user R environment credential helper requires an absolute user environment path."
    );

    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| anyhow!("The startup-pinned user R environment file is unavailable."))?
    };
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| anyhow!("The startup-pinned user R environment file is unavailable."))?;
        let metadata = file
            .metadata()
            .map_err(|_| anyhow!("The startup-pinned user R environment file is unavailable."))?;
        ensure!(
            metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "The startup-pinned user R environment path must be a regular file, not a reparse point."
        );
        file
    };
    #[cfg(not(any(unix, windows)))]
    let file = {
        let path_metadata = std::fs::symlink_metadata(path)
            .map_err(|_| anyhow!("The startup-pinned user R environment file is unavailable."))?;
        ensure!(
            !path_metadata.file_type().is_symlink(),
            "The startup-pinned user R environment path must not be a symbolic link."
        );
        OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(|_| anyhow!("The startup-pinned user R environment file is unavailable."))?
    };

    read_user_environ_snapshot_from_file(file)
}

fn read_user_environ_snapshot_from_file(mut file: File) -> Result<UserEnvironSnapshot> {
    let metadata = file
        .metadata()
        .map_err(|_| anyhow!("The startup-pinned user R environment file is unavailable."))?;
    ensure!(
        metadata.file_type().is_file(),
        "The startup-pinned user R environment path must be a regular file."
    );
    ensure!(
        metadata.len() <= MAX_USER_ENVIRON_BYTES,
        "The startup-pinned user R environment file exceeds the supported size limit."
    );

    // Reserve the complete byte budget once. Growing a secret-bearing Vec can
    // free an uncleared prior allocation.
    let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_USER_ENVIRON_BYTES as usize + 1));
    Read::by_ref(&mut file)
        .take(MAX_USER_ENVIRON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow!("The startup-pinned user R environment file is unavailable."))?;
    ensure!(
        bytes.len() as u64 <= MAX_USER_ENVIRON_BYTES,
        "The startup-pinned user R environment file exceeds the supported size limit."
    );
    Ok(UserEnvironSnapshot { bytes })
}

#[cfg(unix)]
fn stage_user_environ_snapshot(
    snapshot: UserEnvironSnapshot,
    sandbox: &Path,
    command: &mut Command,
) -> Result<StagedUserEnviron> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;

    // `tempfile()` is unlinked immediately on Unix. The plaintext snapshot is
    // therefore reachable only through this process-owned descriptor and the
    // exact child descriptor inherited below; a crash cannot leave a named
    // credential file behind.
    let mut file = tempfile::tempfile_in(sandbox)
        .map_err(|_| anyhow!("Rho could not prepare the user R environment credential helper."))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| anyhow!("Rho could not prepare the user R environment credential helper."))?;
    file.write_all(&snapshot.bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.seek(SeekFrom::Start(0)).map(|_| ()))
        .map_err(|_| anyhow!("Rho could not prepare the user R environment credential helper."))?;
    drop(snapshot);

    let descriptor = file.as_raw_fd();
    let descriptor_root = if Path::new("/dev/fd").is_dir() {
        "/dev/fd"
    } else if Path::new("/proc/self/fd").is_dir() {
        "/proc/self/fd"
    } else {
        bail!("The user R environment credential helper cannot expose its secure snapshot.")
    };
    let path = PathBuf::from(format!("{descriptor_root}/{descriptor}"));

    // Keep CLOEXEC in the parent. Clear it only after fork in this exact child,
    // avoiding a window where another concurrently spawned process could
    // inherit the secret-bearing descriptor.
    unsafe {
        command.pre_exec(move || {
            let flags = libc::fcntl(descriptor, libc::F_GETFD);
            if flags < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(StagedUserEnviron { _file: file, path })
}

#[cfg(windows)]
struct WindowsPipeHandle(*mut std::ffi::c_void);

#[cfg(windows)]
unsafe impl Send for WindowsPipeHandle {}

#[cfg(windows)]
impl Drop for WindowsPipeHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buffer_size: u32,
        in_buffer_size: u32,
        default_timeout_ms: u32,
        security_attributes: *const std::ffi::c_void,
    ) -> *mut std::ffi::c_void;
    fn ConnectNamedPipe(pipe: *mut std::ffi::c_void, overlapped: *mut std::ffi::c_void) -> i32;
    fn WriteFile(
        file: *mut std::ffi::c_void,
        buffer: *const std::ffi::c_void,
        bytes_to_write: u32,
        bytes_written: *mut u32,
        overlapped: *mut std::ffi::c_void,
    ) -> i32;
    fn FlushFileBuffers(file: *mut std::ffi::c_void) -> i32;
    fn DisconnectNamedPipe(pipe: *mut std::ffi::c_void) -> i32;
    fn CloseHandle(object: *mut std::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
}

#[cfg(windows)]
fn stage_user_environ_snapshot(
    snapshot: UserEnvironSnapshot,
    _sandbox: &Path,
    _command: &mut Command,
) -> Result<StagedUserEnviron> {
    use std::os::windows::ffi::OsStrExt;

    const PIPE_ACCESS_OUTBOUND: u32 = 0x0000_0002;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
    const PIPE_READMODE_BYTE: u32 = 0x0000_0000;
    const PIPE_NOWAIT: u32 = 0x0000_0001;
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
    const INVALID_HANDLE_VALUE: *mut std::ffi::c_void = (-1_isize) as *mut std::ffi::c_void;

    // A random local byte pipe gives R a pathname-compatible snapshot without
    // ever materializing the secret-bearing `.Renviron` bytes as a durable
    // Windows file. The server is single-instance and rejects remote clients.
    let path = PathBuf::from(format!(
        r"\\.\pipe\rho-user-environ-{}",
        uuid::Uuid::new_v4()
    ));
    let wide_name = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let pipe = unsafe {
        CreateNamedPipeW(
            wide_name.as_ptr(),
            PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            u32::try_from(MAX_USER_ENVIRON_BYTES + 1).unwrap_or(u32::MAX),
            0,
            50,
            std::ptr::null(),
        )
    };
    ensure!(
        pipe != INVALID_HANDLE_VALUE && !pipe.is_null(),
        "Rho could not prepare the user R environment credential helper."
    );
    let pipe = WindowsPipeHandle(pipe);
    let cancel = Arc::new(AtomicBool::new(false));
    let writer_cancel = Arc::clone(&cancel);
    let writer = std::thread::Builder::new()
        .name("rho-user-environ-snapshot".to_string())
        .spawn(move || write_windows_snapshot_pipe(pipe, snapshot, writer_cancel))
        .map_err(|_| anyhow!("Rho could not prepare the user R environment credential helper."))?;
    Ok(StagedUserEnviron {
        path,
        cancel,
        writer: Some(writer),
    })
}

#[cfg(windows)]
fn write_windows_snapshot_pipe(
    pipe: WindowsPipeHandle,
    snapshot: UserEnvironSnapshot,
    cancel: Arc<AtomicBool>,
) -> std::result::Result<(), ()> {
    const ERROR_BROKEN_PIPE: u32 = 109;
    const ERROR_NO_DATA: u32 = 232;
    const ERROR_PIPE_NOT_CONNECTED: u32 = 233;
    const ERROR_PIPE_CONNECTED: u32 = 535;
    const ERROR_PIPE_LISTENING: u32 = 536;

    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(());
        }
        let connected = unsafe { ConnectNamedPipe(pipe.0, std::ptr::null_mut()) };
        if connected != 0 {
            break;
        }
        match unsafe { GetLastError() } {
            ERROR_PIPE_CONNECTED => break,
            ERROR_PIPE_LISTENING => std::thread::sleep(PROCESS_POLL_INTERVAL),
            _ => return Err(()),
        }
    }

    let mut written_total = 0_usize;
    while written_total < snapshot.bytes.len() {
        if cancel.load(Ordering::Acquire) {
            return Err(());
        }
        let remaining = &snapshot.bytes[written_total..];
        let request = u32::try_from(remaining.len()).unwrap_or(u32::MAX);
        let mut written = 0_u32;
        let result = unsafe {
            WriteFile(
                pipe.0,
                remaining.as_ptr().cast(),
                request,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if result != 0 && written > 0 {
            written_total += written as usize;
            continue;
        }
        match unsafe { GetLastError() } {
            ERROR_NO_DATA => std::thread::sleep(PROCESS_POLL_INTERVAL),
            ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED => return Err(()),
            _ => return Err(()),
        }
    }

    if unsafe { FlushFileBuffers(pipe.0) } == 0 {
        return Err(());
    }
    unsafe {
        DisconnectNamedPipe(pipe.0);
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn stage_user_environ_snapshot(
    snapshot: UserEnvironSnapshot,
    _sandbox: &Path,
    _command: &mut Command,
) -> Result<StagedUserEnviron> {
    drop(snapshot);
    bail!("Secure user R environment snapshots are unavailable on this platform.")
}

fn terminate_and_reap(child: &mut super::RProbeChildGuard<'_>) {
    let _ = child.terminate_process_tree();
    if !child.reaped {
        let _ = child.wait("reaping user R environment credential helper");
    }
}

fn spawn_bounded_reader<R>(
    thread_name: &str,
    mut reader: R,
    limit: u64,
    output_limit_exceeded: Arc<AtomicBool>,
    reader_failed: Arc<AtomicBool>,
) -> std::result::Result<JoinHandle<std::result::Result<Zeroizing<Vec<u8>>, ()>>, ()>
where
    R: Read + Send + 'static,
{
    std::thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            // Allocate the complete retention budget once. A growing Vec could
            // free an earlier secret-bearing allocation without clearing it.
            let retention_limit = usize::try_from(limit).unwrap_or(usize::MAX);
            let mut output = Zeroizing::new(Vec::with_capacity(retention_limit));
            let mut chunk = Zeroizing::new([0_u8; 4 * 1024]);
            loop {
                let read = match reader.read(&mut *chunk) {
                    Ok(0) => return Ok(output),
                    Ok(read) => read,
                    Err(_) => {
                        reader_failed.store(true, Ordering::Release);
                        return Err(());
                    }
                };
                let remaining = limit.saturating_sub(output.len() as u64);
                if read as u64 > remaining {
                    let keep = usize::try_from(remaining).unwrap_or(0).min(read);
                    output.extend_from_slice(&chunk[..keep]);
                    output_limit_exceeded.store(true, Ordering::Release);
                    return Ok(output);
                }
                output.extend_from_slice(&chunk[..read]);
            }
        })
        .map_err(|_| ())
}

fn join_bounded_reader(
    reader: JoinHandle<std::result::Result<Zeroizing<Vec<u8>>, ()>>,
) -> Result<Zeroizing<Vec<u8>>> {
    super::join_r_probe_thread(reader, "user R environment helper pipe")
        .map_err(|_| anyhow!(HELPER_FAILURE))?
        .map_err(|_| anyhow!(HELPER_FAILURE))?
        .map_err(|_| anyhow!(HELPER_FAILURE))
}

fn parse_presence_stdout(
    stdout: &[u8],
    variables: &BTreeSet<String>,
) -> Result<BTreeMap<String, bool>> {
    let bits = if let Some(bits) = stdout.strip_suffix(b"\r\n") {
        bits
    } else if let Some(bits) = stdout.strip_suffix(b"\n") {
        bits
    } else {
        bail!(HELPER_PROTOCOL_FAILURE)
    };
    ensure!(bits.len() == variables.len(), HELPER_PROTOCOL_FAILURE);
    variables
        .iter()
        .zip(bits)
        .map(|(variable, bit)| match bit {
            b'0' => Ok((variable.clone(), false)),
            b'1' => Ok((variable.clone(), true)),
            _ => bail!(HELPER_PROTOCOL_FAILURE),
        })
        .collect()
}

fn parse_helper_stdout(stdout: &[u8]) -> Result<Option<Zeroizing<String>>> {
    std::str::from_utf8(stdout).map_err(|_| anyhow!(HELPER_PROTOCOL_FAILURE))?;
    let body = if let Some(body) = stdout.strip_suffix(b"\r\n") {
        body
    } else if let Some(body) = stdout.strip_suffix(b"\n") {
        body
    } else {
        bail!(HELPER_PROTOCOL_FAILURE)
    };
    ensure!(
        !body.iter().any(|byte| byte.is_ascii_control()),
        HELPER_PROTOCOL_FAILURE
    );
    if body == b"0" {
        return Ok(None);
    }

    let encoded = body
        .strip_prefix(b"1:")
        .filter(|encoded| !encoded.is_empty() && encoded.len() % 2 == 0)
        .ok_or_else(|| anyhow!(HELPER_PROTOCOL_FAILURE))?;
    ensure!(
        encoded.len() <= 2 * MAX_CREDENTIAL_BYTES,
        HELPER_PROTOCOL_FAILURE
    );

    let mut decoded = Zeroizing::new(Vec::with_capacity(encoded.len() / 2));
    for pair in encoded.chunks_exact(2) {
        let high = hex_nibble(pair[0]).ok_or_else(|| anyhow!(HELPER_PROTOCOL_FAILURE))?;
        let low = hex_nibble(pair[1]).ok_or_else(|| anyhow!(HELPER_PROTOCOL_FAILURE))?;
        decoded.push((high << 4) | low);
    }
    ensure!(
        !decoded.is_empty()
            && decoded.len() <= MAX_CREDENTIAL_BYTES
            && !decoded.iter().any(|byte| byte.is_ascii_control()),
        HELPER_PROTOCOL_FAILURE
    );
    let decoded_text =
        std::str::from_utf8(&decoded).map_err(|_| anyhow!(HELPER_PROTOCOL_FAILURE))?;
    ensure!(
        !decoded_text.chars().any(char::is_control),
        HELPER_PROTOCOL_FAILURE
    );

    // UTF-8 was checked immediately above. Move the zeroized byte allocation
    // into a zeroizing String without creating a second secret-bearing copy.
    let bytes = std::mem::take(&mut *decoded);
    // SAFETY: `from_utf8` accepted these exact bytes before the move.
    let value = unsafe { String::from_utf8_unchecked(bytes) };
    Ok(Some(Zeroizing::new(value)))
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    fn fake_rscript(directory: &Path, body: &str) -> std::path::PathBuf {
        let path = directory.join("fake-rscript");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&path, permissions).unwrap();
        path
    }

    fn test_limits() -> HelperLimits {
        HelperLimits {
            timeout: Duration::from_secs(3),
            max_stdout_bytes: MAX_STDOUT_BYTES,
            max_stderr_bytes: MAX_STDERR_BYTES,
        }
    }

    #[test]
    fn helper_protocol_decodes_only_exact_safe_utf8_values() {
        let decoded = parse_helper_stdout(b"1:736b2d757365722de99baa\n")
            .unwrap()
            .unwrap();
        assert_eq!(decoded.as_str(), "sk-user-\u{96ea}");
        assert!(parse_helper_stdout(b"0\n").unwrap().is_none());

        for invalid in [
            b"1:line\n".as_slice(),
            b"1:610a62\n".as_slice(),
            b"1:ff\n".as_slice(),
            b"1:c285\n".as_slice(),
            b"1:61\0\n".as_slice(),
            b"1:61".as_slice(),
            b"1:\n".as_slice(),
        ] {
            assert!(parse_helper_stdout(invalid).is_err());
        }
        assert!(parse_helper_stdout(&[b'1', b':', 0xff, b'\n']).is_err());
    }

    #[test]
    fn helper_protocol_rejects_decoded_values_over_the_credential_bound() {
        let mut response = Vec::with_capacity(2 * MAX_CREDENTIAL_BYTES + 5);
        response.extend_from_slice(b"1:");
        response.extend(std::iter::repeat_n(b'6', 2 * (MAX_CREDENTIAL_BYTES + 1)));
        response.push(b'\n');
        assert!(parse_helper_stdout(&response).is_err());
    }

    #[test]
    fn user_environ_path_must_be_an_absolute_regular_file() {
        let directory = tempfile::TempDir::new().unwrap();
        let regular = directory.path().join(".Renviron");
        std::fs::write(&regular, b"SELECTED_KEY=value\n").unwrap();
        read_user_environ_snapshot(&regular).unwrap();
        assert!(read_user_environ_snapshot(directory.path()).is_err());
        assert!(read_user_environ_snapshot(Path::new("relative/.Renviron")).is_err());
    }

    #[test]
    fn user_environ_input_is_bounded_before_it_reaches_r() {
        let directory = tempfile::TempDir::new().unwrap();
        let oversized = directory.path().join(".Renviron");
        let file = File::create(&oversized).unwrap();
        file.set_len(MAX_USER_ENVIRON_BYTES + 1).unwrap();
        let error = read_user_environ_snapshot(&oversized).err().unwrap();
        assert_eq!(
            error.to_string(),
            "The startup-pinned user R environment file exceeds the supported size limit."
        );
    }

    #[cfg(unix)]
    #[test]
    fn user_environ_path_rejects_a_symlink_even_when_its_target_is_regular() {
        let directory = tempfile::TempDir::new().unwrap();
        let regular = directory.path().join("outside-project.Renviron");
        let linked = directory.path().join(".Renviron");
        std::fs::write(&regular, b"SELECTED_KEY=value\n").unwrap();
        std::os::unix::fs::symlink(&regular, &linked).unwrap();
        assert!(read_user_environ_snapshot(&linked).is_err());
    }

    #[test]
    fn batch_presence_protocol_is_boolean_only_and_order_bound() {
        let variables = BTreeSet::from([
            "ALPHA_API_KEY".to_string(),
            "BETA_API_KEY".to_string(),
            "GAMMA_API_KEY".to_string(),
        ]);
        let projected = parse_presence_stdout(b"101\n", &variables).unwrap();
        assert_eq!(projected.get("ALPHA_API_KEY"), Some(&true));
        assert_eq!(projected.get("BETA_API_KEY"), Some(&false));
        assert_eq!(projected.get("GAMMA_API_KEY"), Some(&true));
        for invalid in [b"10\n".as_slice(), b"10x\n", b"101extra\n"] {
            assert!(parse_presence_stdout(invalid, &variables).is_err());
        }
    }

    #[test]
    fn batch_presence_input_is_deduplicated_and_bounded() {
        let deduplicated = ["DUPLICATE_KEY", "DUPLICATE_KEY", "OTHER_KEY"]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        assert_eq!(deduplicated.len(), 2);
        validate_presence_variables(&deduplicated).unwrap();

        let too_many = (0..=MAX_PRESENCE_VARIABLES)
            .map(|index| format!("KEY_{index}"))
            .collect::<BTreeSet<_>>();
        assert!(validate_presence_variables(&too_many).is_err());

        let oversized_arguments = (0..100)
            .map(|index| format!("KEY_{index}_{}", "X".repeat(180)))
            .collect::<BTreeSet<_>>();
        assert!(oversized_arguments.len() <= MAX_PRESENCE_VARIABLES);
        assert!(validate_presence_variables(&oversized_arguments).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn batch_presence_uses_one_child_for_sorted_unique_names() {
        let directory = tempfile::TempDir::new().unwrap();
        let user_environ = directory.path().join(".Renviron");
        std::fs::write(
            &user_environ,
            b"ALPHA_API_KEY=alpha-secret\nBETA_API_KEY=beta-secret\n",
        )
        .unwrap();
        let fake = fake_rscript(
            directory.path(),
            r#"
[ "$#" -eq 7 ] || exit 10
[ "$1" = "--no-restore" ] || exit 11
[ "$2" = "--no-save" ] || exit 12
[ "$3" = "--no-site-file" ] || exit 13
[ "$4" = "--no-init-file" ] || exit 14
[ "$6" = "ALPHA_API_KEY" ] && [ "$7" = "BETA_API_KEY" ] || exit 15
grep -q 'ifelse(present' "$5" || exit 16
if grep -q 'charToRaw' "$5"; then exit 17; fi
[ -z "${ALPHA_API_KEY+x}" ] && [ -z "${BETA_API_KEY+x}" ] || exit 18
printf '10\n'
"#,
        );
        let mut command = Command::new(fake);
        command
            .env("ALPHA_API_KEY", "inherited-alpha-secret")
            .env("BETA_API_KEY", "inherited-beta-secret");
        let variables = ["BETA_API_KEY", "ALPHA_API_KEY", "ALPHA_API_KEY"]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        let presence = user_environ_credentials_present_with_command(
            command,
            &user_environ,
            &variables,
            &variables,
            &variables.iter().map(OsString::from).collect::<Vec<_>>(),
            test_limits(),
        )
        .unwrap();
        assert_eq!(
            presence,
            BTreeMap::from([
                ("ALPHA_API_KEY".to_string(), true),
                ("BETA_API_KEY".to_string(), false),
            ])
        );
    }

    #[cfg(unix)]
    #[test]
    fn child_receives_only_selected_argument_and_exact_pinned_startup_files() {
        let directory = tempfile::TempDir::new().unwrap();
        let evidence_path = directory.path().join("helper-cwd.txt");
        let user_environ = directory.path().join(".Renviron");
        std::fs::write(
            &user_environ,
            b"SELECTED_ONLY_KEY=sk-user-\xe9\x9b\xaa\nOTHER_DECLARED_KEY=do-not-read\n",
        )
        .unwrap();
        let fake = fake_rscript(
            directory.path(),
            r#"
[ "$#" -eq 6 ] || exit 10
[ "$1" = "--no-restore" ] || exit 11
[ "$2" = "--no-save" ] || exit 12
[ "$3" = "--no-site-file" ] || exit 13
[ "$4" = "--no-init-file" ] || exit 14
[ "$6" = "SELECTED_ONLY_KEY" ] || exit 15
[ -f "$5" ] || exit 16
[ "$(pwd -P)" = "$(cd "$(dirname "$5")" && pwd -P)" ] || exit 17
[ -r "$R_ENVIRON_USER" ] || exit 18
grep -q '^SELECTED_ONLY_KEY=sk-user-' "$R_ENVIRON_USER" || exit 19
[ -f "$R_ENVIRON" ] && [ ! -s "$R_ENVIRON" ] || exit 17
[ -z "${R_PROFILE+x}" ] && [ -z "${R_PROFILE_USER+x}" ] || exit 20
[ -z "${R_LIBS+x}" ] && [ -z "${R_LIBS_USER+x}" ] && [ -z "${R_LIBS_SITE+x}" ] || exit 21
[ -z "${R_HOME+x}" ] && [ -z "${R_USER+x}" ] && [ -z "${R_ARCH+x}" ] || exit 22
[ -z "${BASH_ENV+x}" ] && [ -z "${LD_PRELOAD+x}" ] && [ -z "${DYLD_INSERT_LIBRARIES+x}" ] || exit 23
[ "$R_DEFAULT_PACKAGES" = "NULL" ] || exit 24
[ -z "${SELECTED_ONLY_KEY+x}" ] || exit 25
[ -z "${OTHER_DECLARED_KEY+x}" ] || exit 26
[ -z "${GITHUB_TOKEN+x}" ] || exit 27
[ "${ORDINARY_VALUE-unset}" = "kept" ] || exit 28
pwd -P > "$EVIDENCE_PATH"
printf '1:736b2d757365722de99baa\n'
"#,
        );

        let mut command = Command::new(fake);
        command
            .env("R_ENVIRON_USER", "/attacker/project/.Renviron")
            .env("R_ENVIRON", "/attacker/site.Renviron")
            .env("R_PROFILE", "/attacker/site.Rprofile")
            .env("R_PROFILE_USER", "/attacker/project/.Rprofile")
            .env("R_LIBS", "/attacker/libs")
            .env("R_LIBS_USER", "/attacker/user-libs")
            .env("R_LIBS_SITE", "/attacker/site-libs")
            .env("R_HOME", "/attacker/R")
            .env("R_USER", "/attacker/user")
            .env("R_ARCH", "/attacker/arch")
            .env("BASH_ENV", "/attacker/bash-env")
            .env("LD_PRELOAD", "/attacker/preload")
            .env("DYLD_INSERT_LIBRARIES", "/attacker/dyld")
            .env("SELECTED_ONLY_KEY", "inherited-selected-secret")
            .env("OTHER_DECLARED_KEY", "inherited-other-secret")
            .env("GITHUB_TOKEN", "inherited-generic-secret")
            .env("ORDINARY_VALUE", "kept")
            .env("EVIDENCE_PATH", &evidence_path);
        let declared = BTreeSet::from([
            "SELECTED_ONLY_KEY".to_string(),
            "OTHER_DECLARED_KEY".to_string(),
        ]);
        let inherited = [
            "SELECTED_ONLY_KEY",
            "OTHER_DECLARED_KEY",
            "GITHUB_TOKEN",
            "ORDINARY_VALUE",
            "R_ENVIRON_USER",
            "R_ENVIRON",
            "R_PROFILE",
            "R_PROFILE_USER",
        ]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();

        let value = read_user_environ_credential_with_command(
            command,
            &user_environ,
            "SELECTED_ONLY_KEY",
            &declared,
            &inherited,
            test_limits(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(value.as_str(), "sk-user-\u{96ea}");
        let helper_cwd = std::fs::read_to_string(evidence_path).unwrap();
        assert!(!Path::new(helper_cwd.trim()).exists());
    }

    #[cfg(unix)]
    #[test]
    fn path_swap_after_open_cannot_change_the_snapshot_read_by_child() {
        let directory = tempfile::TempDir::new().unwrap();
        let user_environ = directory.path().join(".Renviron");
        let opened_original = directory.path().join("opened-original.Renviron");
        let attacker = directory.path().join("attacker.Renviron");
        std::fs::write(&user_environ, b"SELECTED_KEY=opened-original-secret\n").unwrap();
        std::fs::write(&attacker, b"SELECTED_KEY=swapped-attacker-secret\n").unwrap();

        let snapshot = read_user_environ_snapshot(&user_environ).unwrap();
        std::fs::rename(&user_environ, &opened_original).unwrap();
        std::os::unix::fs::symlink(&attacker, &user_environ).unwrap();

        let fake = fake_rscript(
            directory.path(),
            r#"
grep -q '^SELECTED_KEY=opened-original-secret$' "$R_ENVIRON_USER" || exit 31
if grep -q 'swapped-attacker-secret' "$R_ENVIRON_USER"; then exit 32; fi
printf '1:6f70656e65642d6f726967696e616c2d736563726574\n'
"#,
        );
        let output = run_user_environ_helper_with_snapshot(
            Command::new(fake),
            snapshot,
            &["SELECTED_KEY"],
            &BTreeSet::from(["SELECTED_KEY".to_string()]),
            &[],
            test_limits(),
            HelperMode::Exact,
        )
        .unwrap();
        let value = parse_helper_stdout(&output).unwrap().unwrap();
        assert_eq!(value.as_str(), "opened-original-secret");
    }

    #[cfg(unix)]
    #[test]
    fn helper_timeout_kills_and_reaps_the_child() {
        let directory = tempfile::TempDir::new().unwrap();
        let fake = fake_rscript(directory.path(), "exec sleep 5");
        let user_environ = directory.path().join(".Renviron");
        std::fs::write(&user_environ, b"SELECTED_KEY=value\n").unwrap();
        let started = Instant::now();
        let error = read_user_environ_credential_with_command(
            Command::new(fake),
            &user_environ,
            "SELECTED_KEY",
            &BTreeSet::from(["SELECTED_KEY".to_string()]),
            &[],
            HelperLimits {
                timeout: Duration::from_millis(80),
                ..test_limits()
            },
        )
        .unwrap_err();
        assert_eq!(error.to_string(), HELPER_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn successful_child_descendant_holding_pipes_is_terminated_before_bounded_join() {
        let directory = tempfile::TempDir::new().unwrap();
        let fake = fake_rscript(directory.path(), "(sleep 30) & printf '0\\n'; exit 0");
        let user_environ = directory.path().join(".Renviron");
        std::fs::write(&user_environ, b"SELECTED_KEY=unused\n").unwrap();
        let started = Instant::now();
        let value = read_user_environ_credential_with_command(
            Command::new(fake),
            &user_environ,
            "SELECTED_KEY",
            &BTreeSet::from(["SELECTED_KEY".to_string()]),
            &[],
            HelperLimits {
                timeout: Duration::from_secs(10),
                ..test_limits()
            },
        )
        .unwrap();
        assert!(value.is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn helper_rejects_oversized_stdout_and_stderr() {
        let directory = tempfile::TempDir::new().unwrap();
        let user_environ = directory.path().join(".Renviron");
        std::fs::write(&user_environ, b"SELECTED_KEY=value\n").unwrap();
        let declared = BTreeSet::from(["SELECTED_KEY".to_string()]);

        for body in [
            "printf '1:'; i=0; while [ \"$i\" -lt 5000 ]; do printf '61'; i=$((i + 1)); done; printf '\\n'",
            "i=0; while [ \"$i\" -lt 17000 ]; do printf 'x' >&2; i=$((i + 1)); done; printf '0\\n'",
        ] {
            let fake = fake_rscript(directory.path(), body);
            let error = read_user_environ_credential_with_command(
                Command::new(fake),
                &user_environ,
                "SELECTED_KEY",
                &declared,
                &[],
                test_limits(),
            )
            .unwrap_err();
            assert_eq!(error.to_string(), HELPER_OUTPUT_FAILURE);
        }
    }

    #[cfg(unix)]
    #[test]
    fn helper_errors_never_echo_stdout_stderr_or_file_content() {
        let directory = tempfile::TempDir::new().unwrap();
        let fake = fake_rscript(
            directory.path(),
            "printf 'stdout-super-secret'; printf 'stderr-super-secret' >&2; exit 7",
        );
        let user_environ = directory.path().join(".Renviron");
        std::fs::write(&user_environ, b"SELECTED_KEY=file-super-secret\n").unwrap();
        let error = read_user_environ_credential_with_command(
            Command::new(fake),
            &user_environ,
            "SELECTED_KEY",
            &BTreeSet::from(["SELECTED_KEY".to_string()]),
            &[],
            test_limits(),
        )
        .unwrap_err();
        let message = error.to_string();
        assert_eq!(message, HELPER_FAILURE);
        for secret in [
            "stdout-super-secret",
            "stderr-super-secret",
            "file-super-secret",
        ] {
            assert!(!message.contains(secret));
        }
    }
}
