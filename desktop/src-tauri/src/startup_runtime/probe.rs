use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use tauri::Manager;

use super::*;

pub(crate) fn prepare_runtime_files(data_dir: PathBuf, ark: PathBuf) -> Result<RuntimeConfig> {
    prepare_runtime_files_with_rscript(data_dir, ark, None)
}

pub(crate) fn prepare_runtime_files_with_rscript(
    data_dir: PathBuf,
    ark: PathBuf,
    selected_rscript: Option<&Path>,
) -> Result<RuntimeConfig> {
    let started = Instant::now();
    ensure!(ark.is_file(), "bundled Ark executable was not found");
    std::fs::create_dir_all(&data_dir)?;
    let source_dir = data_dir.join("sources");
    let bridge_package = source_dir.join("rho.bridge");
    write_source(&bridge_package.join("R/state.R"), BRIDGE_STATE)?;
    write_source(&bridge_package.join("R/execute.R"), BRIDGE_EXECUTE)?;
    write_source(&bridge_package.join("R/workspace.R"), BRIDGE_WORKSPACE)?;
    write_source(&bridge_package.join("R/completion.R"), BRIDGE_COMPLETION)?;
    write_source(&bridge_package.join("R/lintr.R"), BRIDGE_LINTR)?;
    write_source(&bridge_package.join("R/targets.R"), BRIDGE_TARGETS)?;
    write_source(&bridge_package.join("R/formatting.R"), BRIDGE_FORMATTING)?;

    let rscript = locate_rscript(selected_rscript)?;
    let cached = load_runtime_cache(&data_dir, &rscript, &ark);
    let (
        r_home,
        r_bin,
        r_arch,
        path_sep,
        r_version,
        r_libs,
        r_profile_user,
        r_environ_user,
        agent_runtime,
    ) = if let Some(cache) = cached {
        write_startup_log(&format!(
            "startup_phase=runtime_cache outcome=hit elapsed_ms={}",
            started.elapsed().as_millis()
        ));
        let agent_runtime =
            deferred_agent_runtime_status_for(Some(&rscript), Some(&cache.r_version));
        (
            cache.r_home,
            cache.r_bin,
            cache.r_arch,
            cache.path_sep,
            cache.r_version,
            cache.r_libs,
            cache
                .r_profile_user
                .map(|signature| PathBuf::from(signature.path)),
            cache
                .r_environ_user
                .map(|signature| PathBuf::from(signature.path)),
            agent_runtime,
        )
    } else {
        let probe_started = Instant::now();
        let probe = probe_r_runtime(&rscript)?;
        let RRuntimeProbe {
            r_home,
            r_bin,
            r_arch,
            path_sep,
            r_version,
            r_libs,
            r_profile_user,
            r_environ_user,
        } = probe;
        write_startup_log(&format!(
            "startup_phase=runtime_probe elapsed_ms={} agent_probe=deferred",
            probe_started.elapsed().as_millis()
        ));
        let agent_runtime = deferred_agent_runtime_status_for(Some(&rscript), Some(&r_version));
        let cache = RuntimeCacheFile {
            version: RUNTIME_CACHE_VERSION,
            rscript: runtime_file_signature(&rscript)?,
            ark: runtime_file_signature(&ark)?,
            r_profile_user: r_profile_user
                .as_deref()
                .map(runtime_file_signature)
                .transpose()?,
            r_environ_user: r_environ_user
                .as_deref()
                .map(runtime_file_signature)
                .transpose()?,
            r_home: r_home.clone(),
            r_bin: r_bin.clone(),
            r_arch: r_arch.clone(),
            path_sep: path_sep.clone(),
            r_version: r_version.clone(),
            r_libs: r_libs.clone(),
        };
        if let Err(error) = save_runtime_cache(&data_dir, &cache) {
            write_startup_log(&format!(
                "startup_phase=runtime_cache outcome=write_failed detail={error:#}"
            ));
        }
        (
            r_home,
            r_bin,
            r_arch,
            path_sep,
            r_version,
            r_libs,
            r_profile_user,
            r_environ_user,
            agent_runtime,
        )
    };
    ensure_supported_r_architecture(&r_arch)?;
    let process_path = platform::child_process_path(Some(Path::new(&r_bin)))
        .context("constructing the desktop child-process PATH")?;
    let runtime_dir = data_dir.join("runtime");
    std::fs::create_dir_all(&runtime_dir)?;
    let empty_site_environ = runtime_dir.join("empty-site.Renviron");
    write_source(&empty_site_environ, "")?;
    let log_path = runtime_dir.join("ark.log");
    let kernelspec = runtime_dir.join("kernel.json");
    let mut argv = vec![
        json!(ark),
        json!("--connection_file"),
        json!("{connection_file}"),
        json!("--session-mode"),
        json!("console"),
        json!("--log"),
        json!(log_path),
        json!("--"),
        json!("--interactive"),
        json!("--no-site-file"),
    ];
    let mut environment = serde_json::Map::from_iter([
        ("R_HOME".to_string(), json!(r_home)),
        ("R_LIBS".to_string(), json!(r_libs)),
        (
            "PATH".to_string(),
            json!(process_path.to_string_lossy().into_owned()),
        ),
    ]);
    if let Some(r_profile_user) = &r_profile_user {
        environment.insert("R_PROFILE_USER".to_string(), json!(r_profile_user));
    } else {
        argv.push(json!("--no-init-file"));
    }
    if let Some(r_environ_user) = &r_environ_user {
        environment.insert("R_ENVIRON".to_string(), json!(empty_site_environ));
        environment.insert("R_ENVIRON_USER".to_string(), json!(r_environ_user));
    } else {
        argv.push(json!("--no-environ"));
    }
    let spec = json!({
        "argv": argv,
        "display_name": "Ark R 0.1.252 (Rho Desktop)",
        "language": "R",
        "interrupt_mode": "message",
        "kernel_protocol_version": "5.4",
        "env": environment
    });
    atomic_write(&kernelspec, &serde_json::to_vec_pretty(&spec)?)?;
    atomic_write(
        &kernelspec.with_extension("runtime.json"),
        &serde_json::to_vec_pretty(&json!({
            "r_version": r_version,
            "r_home": r_home,
            "r_bin": r_bin,
            "r_arch": r_arch,
            "path_sep": path_sep
        }))?,
    )?;
    Ok(RuntimeConfig {
        data_dir: data_dir.clone(),
        kernelspec,
        rscript,
        r_version,
        r_home,
        r_libs,
        path_sep,
        process_path,
        r_profile_user,
        r_environ_user,
        bridge_package,
        agent_runtime,
        store_path: data_dir.join("rho-desktop.sqlite"),
    })
}

pub(crate) fn runtime_cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime").join("runtime-cache.json")
}

pub(crate) fn runtime_file_signature(path: &Path) -> Result<RuntimeFileSignature> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("reading runtime metadata for {}", path.display()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or_default();
    Ok(RuntimeFileSignature {
        path: path.to_string_lossy().replace('\\', "/"),
        size: metadata.len(),
        modified_unix_ms: modified,
    })
}

pub(crate) fn runtime_signature_matches(path: &Path, expected: &RuntimeFileSignature) -> bool {
    runtime_file_signature(path)
        .map(|actual| {
            actual.path == expected.path
                && actual.size == expected.size
                && actual.modified_unix_ms == expected.modified_unix_ms
        })
        .unwrap_or(false)
}

pub(crate) fn optional_runtime_signature_matches(
    signature: Option<&RuntimeFileSignature>,
    missing_name: &str,
) -> bool {
    signature
        .map(|value| runtime_signature_matches(Path::new(&value.path), value))
        .unwrap_or_else(|| {
            let path = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
                .map(|home| home.join(missing_name));
            path.map(|value| !value.is_file()).unwrap_or(true)
        })
}

pub(crate) fn load_runtime_cache(
    data_dir: &Path,
    rscript: &Path,
    ark: &Path,
) -> Option<RuntimeCacheFile> {
    let path = runtime_cache_path(data_dir);
    let cache = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RuntimeCacheFile>(&bytes).ok())?;
    if cache.version != RUNTIME_CACHE_VERSION
        || !runtime_signature_matches(rscript, &cache.rscript)
        || !runtime_signature_matches(ark, &cache.ark)
        || !optional_runtime_signature_matches(cache.r_profile_user.as_ref(), ".Rprofile")
        || !optional_runtime_signature_matches(cache.r_environ_user.as_ref(), ".Renviron")
    {
        return None;
    }
    Some(cache)
}

pub(crate) fn save_runtime_cache(data_dir: &Path, cache: &RuntimeCacheFile) -> Result<()> {
    let path = runtime_cache_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    atomic_write(&path, &serde_json::to_vec_pretty(cache)?)
}

pub(crate) fn locate_ark(app: &tauri::App) -> Result<PathBuf> {
    let resource_dir = app
        .path()
        .resource_dir()
        .context("resolving Rho resource directory")?;
    let current_exe = std::env::current_exe().context("resolving the Rho executable path")?;
    locate_ark_from_candidates(ark_candidate_paths(
        std::env::consts::OS,
        std::env::consts::ARCH,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &resource_dir,
        &current_exe,
    ))
}

pub(crate) fn ark_candidate_paths(
    os: &str,
    arch: &str,
    manifest_dir: &Path,
    resource_dir: &Path,
    current_exe: &Path,
) -> Vec<PathBuf> {
    match (os, arch) {
        ("windows", "x86_64") => vec![
            resource_dir.join("resources/runtime/ark.exe"),
            manifest_dir.join("../resources/runtime/ark.exe"),
        ],
        ("macos", "aarch64") => vec![
            current_exe.parent().unwrap_or(current_exe).join("ark"),
            manifest_dir.join("binaries/ark-aarch64-apple-darwin"),
        ],
        ("linux", "x86_64") => vec![
            resource_dir.join("resources/runtime/ark"),
            current_exe.parent().unwrap_or(current_exe).join("ark"),
            manifest_dir.join("../resources/runtime/ark"),
            manifest_dir.join("binaries/ark-x86_64-unknown-linux-gnu"),
        ],
        ("linux", "aarch64") => vec![
            resource_dir.join("resources/runtime/ark"),
            current_exe.parent().unwrap_or(current_exe).join("ark"),
            manifest_dir.join("../resources/runtime/ark"),
            manifest_dir.join("binaries/ark-aarch64-unknown-linux-gnu"),
        ],
        _ => Vec::new(),
    }
}

pub(crate) fn locate_ark_from_candidates(candidates: Vec<PathBuf>) -> Result<PathBuf> {
    ensure!(
        !candidates.is_empty(),
        "bundled Ark is unavailable for {}-{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    Ok(candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone()))
}

pub(crate) fn development_ark_path() -> Result<PathBuf> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let current_exe = std::env::current_exe().context("resolving the Rho executable path")?;
    locate_ark_from_candidates(ark_candidate_paths(
        std::env::consts::OS,
        std::env::consts::ARCH,
        manifest_dir,
        manifest_dir,
        &current_exe,
    ))
}

pub(crate) fn locate_rscript(selected: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = selected {
        ensure!(
            path.is_file(),
            "selected Rscript path does not point to a file"
        );
        return Ok(path.to_path_buf());
    }
    if let Some(path) = std::env::var_os("RHO_RSCRIPT") {
        let path = PathBuf::from(path);
        ensure!(path.is_file(), "RHO_RSCRIPT does not point to a file");
        return Ok(path);
    }

    #[cfg(target_os = "macos")]
    for candidate in [
        PathBuf::from("/Library/Frameworks/R.framework/Resources/bin/Rscript"),
        PathBuf::from("/Library/Frameworks/R.framework/Versions/Current/Resources/bin/Rscript"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    #[cfg(target_os = "linux")]
    for candidate in [
        PathBuf::from("/usr/lib/R/bin/Rscript"),
        PathBuf::from("/usr/local/lib/R/bin/Rscript"),
        PathBuf::from("/opt/conda/bin/Rscript"),
        PathBuf::from("/opt/miniconda3/bin/Rscript"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let search_path =
        platform::child_process_path(None).context("constructing the Rscript search PATH")?;
    let executable = if cfg!(windows) {
        "Rscript.exe"
    } else {
        "Rscript"
    };
    if let Some(path) = find_executable_on_path(executable, &search_path) {
        return Ok(path);
    }

    #[cfg(windows)]
    {
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        if let Ok(entries) = std::fs::read_dir(program_files.join("R")) {
            let mut candidates = entries
                .flatten()
                .map(|entry| entry.path().join("bin/Rscript.exe"))
                .filter(|path| path.is_file())
                .collect::<Vec<_>>();
            candidates.sort();
            if let Some(path) = candidates.pop() {
                return Ok(path);
            }
        }
    }
    #[cfg(windows)]
    bail!("Rscript.exe was not found. Install R 4.4 or later, then restart Rho.");
    #[cfg(target_os = "macos")]
    bail!("Rscript was not found. Install arm64 R 4.4 or later, then restart Rho.");
    #[cfg(target_os = "linux")]
    bail!(
        "Rscript was not found. Install R 4.4 or later (for example `sudo apt install r-base` on Debian/Ubuntu), then restart Rho."
    );
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    bail!("Rscript was not found. Install R 4.4 or later, then restart Rho.")
}

pub(crate) fn find_executable_on_path(
    executable: &str,
    search_path: &std::ffi::OsStr,
) -> Option<PathBuf> {
    std::env::split_paths(search_path)
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
}

pub(crate) fn probe_r_runtime(rscript: &Path) -> Result<RRuntimeProbe> {
    let expression = r#"
cat("__RHO_HOME__", normalizePath(R.home(), winslash = "/"), "\n", sep = "")
cat("__RHO_BIN__", normalizePath(R.home("bin"), winslash = "/"), "\n", sep = "")
cat("__RHO_ARCH__", R.version$arch, "\n", sep = "")
cat("__RHO_PATH_SEP__", .Platform$path.sep, "\n", sep = "")
cat("__RHO_VERSION__", R.version.string, "\n", sep = "")
cat("__RHO_VERSION_NUMBER__", as.character(getRversion()), "\n", sep = "")
cat("__RHO_PROFILE_USER__", normalizePath(path.expand("~/.Rprofile"), winslash = "/", mustWork = FALSE), "\n", sep = "")
cat("__RHO_ENVIRON_USER__", normalizePath(path.expand("~/.Renviron"), winslash = "/", mustWork = FALSE), "\n", sep = "")
cat(
  "__RHO_LIBS__",
  paste(
    normalizePath(.libPaths(), winslash = "/", mustWork = FALSE),
    collapse = .Platform$path.sep
  ),
  "\n",
  sep = ""
)
"#;
    let output = run_r_probe(
        rscript,
        expression,
        Duration::from_secs(15),
        RProbeStartup::Controlled,
        None,
    )?;
    ensure!(
        output.success,
        "R runtime probe failed (exit_code={:?}, timed_out={}, elapsed_ms={}): stdout={} stderr={}",
        output.exit_code,
        output.timed_out,
        output.elapsed_ms,
        bounded_diagnostic(&output.stdout),
        bounded_diagnostic(&output.stderr)
    );
    let mut probe = parse_r_runtime_probe(&output.stdout)?;
    let library_expression = r#"
cat(
  "__RHO_EFFECTIVE_LIBS__",
  paste(
    normalizePath(.libPaths(), winslash = "/", mustWork = FALSE),
    collapse = .Platform$path.sep
  ),
  "\n",
  sep = ""
)
"#;
    match run_r_probe(
        rscript,
        library_expression,
        Duration::from_secs(15),
        RProbeStartup::UserProfile,
        Some(RUserStartupFiles {
            profile: probe.r_profile_user.as_deref(),
            environ: probe.r_environ_user.as_deref(),
        }),
    ) {
        Ok(output) if output.success => {
            if let Some(libraries) = probe_value(&output.stdout, "__RHO_EFFECTIVE_LIBS__") {
                if !libraries.is_empty() {
                    probe.r_libs = libraries;
                }
            } else {
                write_startup_log(
                    "User R profile library probe returned no marker; using controlled library paths",
                );
            }
        }
        Ok(output) => write_startup_log(&format!(
            "User R profile library probe failed; using controlled library paths (exit_code={:?}, timed_out={}, stderr={})",
            output.exit_code,
            output.timed_out,
            bounded_diagnostic(&output.stderr)
        )),
        Err(error) => write_startup_log(&format!(
            "User R profile library probe could not start; using controlled library paths: {error:#}"
        )),
    }
    Ok(probe)
}

pub(crate) fn parse_r_runtime_probe(stdout: &str) -> Result<RRuntimeProbe> {
    let r_home =
        probe_value(stdout, "__RHO_HOME__").context("R home was absent from runtime probe")?;
    let r_bin =
        probe_value(stdout, "__RHO_BIN__").context("R bin was absent from runtime probe")?;
    let r_arch = probe_value(stdout, "__RHO_ARCH__")
        .context("R architecture was absent from runtime probe")?;
    let path_sep = probe_value(stdout, "__RHO_PATH_SEP__")
        .context("R path separator was absent from runtime probe")?;
    ensure_supported_r_architecture(&r_arch)?;
    let r_version = probe_value(stdout, "__RHO_VERSION__")
        .context("R version was absent from runtime probe")?;
    let r_version_number = probe_value(stdout, "__RHO_VERSION_NUMBER__")
        .context("R version number was absent from runtime probe")?;
    ensure_supported_r_version(&r_version_number)?;
    let r_libs = probe_value(stdout, "__RHO_LIBS__")
        .context("R library paths were absent from runtime probe")?;
    let r_profile_user = existing_startup_file(
        probe_value(stdout, "__RHO_PROFILE_USER__")
            .context("R user profile path was absent from runtime probe")?,
    );
    let r_environ_user = existing_startup_file(
        probe_value(stdout, "__RHO_ENVIRON_USER__")
            .context("R user environment path was absent from runtime probe")?,
    );
    Ok(RRuntimeProbe {
        r_home,
        r_bin,
        r_arch,
        path_sep,
        r_version,
        r_libs,
        r_profile_user,
        r_environ_user,
    })
}

pub(crate) fn existing_startup_file(path: String) -> Option<PathBuf> {
    let path = PathBuf::from(path);
    path.is_file().then_some(path)
}

pub(crate) fn probe_value(stdout: &str, prefix: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix(prefix).map(str::trim))
        .map(str::to_string)
}

pub(crate) fn probe_agent_runtime(process_path: &std::ffi::OsStr) -> AgentRuntimeStatus {
    let discovered = rho_acp_client::discover_external_acp_agent(process_path);
    let available = discovered.is_some();
    let candidate = discovered.as_ref().map(|agent| AcpAgentCandidateStatus {
        agent_id: agent
            .executable
            .file_stem()
            .and_then(std::ffi::OsStr::to_str)
            .unwrap_or("external-acp")
            .to_string(),
        display_name: agent.display_name.clone(),
        status: "ready".to_string(),
        protocol: Some(agent.protocol.clone()),
        executable: Some(normalized_display_path(&agent.executable)),
        detail: Some("External ACP Agent executable discovered.".to_string()),
    });
    AgentRuntimeStatus {
        available,
        status: if available {
            "ready"
        } else {
            "needs_attention"
        }
        .to_string(),
        active_agent_id: candidate.as_ref().map(|agent| agent.agent_id.clone()),
        active_agent_label: candidate.as_ref().map(|agent| agent.display_name.clone()),
        protocol: candidate.as_ref().and_then(|agent| agent.protocol.clone()),
        executable: candidate
            .as_ref()
            .and_then(|agent| agent.executable.clone()),
        candidates: candidate.into_iter().collect(),
        error: (!available).then(|| {
            "Install claude-code-acp, codex-acp, or an ACP-capable opencode executable.".to_string()
        }),
    }
}

pub(crate) fn run_r_probe(
    rscript: &Path,
    expression: &str,
    timeout: Duration,
    startup: RProbeStartup,
    user_files: Option<RUserStartupFiles<'_>>,
) -> Result<ProbeProcessOutput> {
    let mut command = Command::new(rscript);
    hide_console_window(&mut command);
    if matches!(startup, RProbeStartup::Controlled) {
        command.args(["--no-environ", "--no-init-file", "--no-site-file"]);
    } else if let Some(user_files) = user_files {
        let empty_site_environ = configure_user_startup(&mut command, user_files)?;
        return run_prepared_r_probe(command, expression, timeout, empty_site_environ);
    }
    run_prepared_r_probe(command, expression, timeout, None)
}

pub(crate) fn configure_user_startup(
    command: &mut Command,
    user_files: RUserStartupFiles<'_>,
) -> Result<Option<tempfile::NamedTempFile>> {
    command.arg("--no-site-file");
    if let Some(r_profile_user) = user_files.profile {
        command.env("R_PROFILE_USER", r_profile_user);
    } else {
        command.arg("--no-init-file");
    }
    if let Some(r_environ_user) = user_files.environ {
        let empty_site_environ =
            tempfile::NamedTempFile::new().context("creating empty site R environment file")?;
        command
            .env("R_ENVIRON", empty_site_environ.path())
            .env("R_ENVIRON_USER", r_environ_user);
        Ok(Some(empty_site_environ))
    } else {
        command.arg("--no-environ");
        Ok(None)
    }
}

pub(crate) fn run_prepared_r_probe(
    mut command: Command,
    expression: &str,
    timeout: Duration,
    _empty_site_environ: Option<tempfile::NamedTempFile>,
) -> Result<ProbeProcessOutput> {
    let script_file = write_r_probe_script(expression)?;
    let stdout_file = tempfile::NamedTempFile::new().context("creating R probe stdout file")?;
    let stderr_file = tempfile::NamedTempFile::new().context("creating R probe stderr file")?;
    command
        .arg(script_file.path())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file.reopen()?))
        .stderr(Stdio::from(stderr_file.reopen()?));
    let program = command.get_program().to_string_lossy().into_owned();
    let started = Instant::now();
    let mut child = command
        .spawn()
        .with_context(|| format!("running {program}"))?;
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().context("waiting for R runtime probe")? {
            break (status, false);
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            break (
                child.wait().context("stopping timed-out R runtime probe")?,
                true,
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = std::fs::read(stdout_file.path())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    let stderr = std::fs::read(stderr_file.path())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    Ok(ProbeProcessOutput {
        success: status.success() && !timed_out,
        exit_code: status.code(),
        stdout,
        stderr,
        elapsed_ms: started.elapsed().as_millis(),
        timed_out,
    })
}

pub(crate) fn write_r_probe_script(expression: &str) -> Result<tempfile::NamedTempFile> {
    let mut script_file = tempfile::Builder::new()
        .prefix("rho-probe-")
        .suffix(".R")
        .tempfile()
        .context("creating R probe script file")?;
    script_file
        .write_all(expression.as_bytes())
        .context("writing R probe script file")?;
    script_file
        .flush()
        .context("flushing R probe script file")?;
    Ok(script_file)
}

pub(crate) fn bounded_diagnostic(value: &str) -> String {
    let mut tokens = Vec::new();
    let mut redact_next = false;
    for token in value.split_whitespace() {
        if redact_next {
            tokens.push("<redacted>".to_string());
            redact_next = false;
            continue;
        }
        let lower = token.to_ascii_lowercase();
        if lower == "bearer" {
            tokens.push("Bearer".to_string());
            redact_next = true;
            continue;
        }
        let secret_assignment = ["api_key=", "apikey=", "token=", "authorization="]
            .iter()
            .find_map(|marker| lower.find(marker).map(|index| (marker, index)));
        if let Some((marker, index)) = secret_assignment {
            tokens.push(format!(
                "{}{}<redacted>",
                &token[..index],
                &token[index..index + marker.len()]
            ));
        } else {
            tokens.push(token.to_string());
        }
    }
    let sanitized = tokens.join(" ");
    sanitized.chars().take(4096).collect()
}

pub(crate) fn hide_console_window(_command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _command.creation_flags(0x0800_0000);
    }
}

pub(crate) fn ensure_supported_r_version(version: &str) -> Result<()> {
    let mut components = version.split('.');
    let major = components
        .next()
        .context("R version has no major component")?
        .parse::<u64>()
        .with_context(|| format!("invalid R version `{version}`"))?;
    let minor = components
        .next()
        .context("R version has no minor component")?
        .parse::<u64>()
        .with_context(|| format!("invalid R version `{version}`"))?;
    ensure!(
        (major, minor) >= (4, 4),
        "Rho requires R 4.4 or later; found R {version}"
    );
    Ok(())
}

pub(crate) fn r_architecture_supported(target_os: &str, target_arch: &str, r_arch: &str) -> bool {
    if target_os == "macos" && target_arch == "aarch64" {
        matches!(r_arch.trim(), "aarch64" | "arm64")
    } else if target_os == "linux" && target_arch == "x86_64" {
        matches!(r_arch.trim(), "x86_64")
    } else {
        true
    }
}

pub(crate) fn ensure_supported_r_architecture(r_arch: &str) -> Result<()> {
    ensure!(
        r_architecture_supported(std::env::consts::OS, std::env::consts::ARCH, r_arch),
        "R_ARCH_MISMATCH: {}; found `{}`",
        platform::r_architecture_requirement(),
        r_arch.trim()
    );
    Ok(())
}
