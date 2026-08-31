use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::Command,
};

use rho_protocol::{ExecutorKind, NetworkPolicy, decode_execution_spec_v1};
use rho_runner::{
    RunnerCore, RunnerDeploymentProfile,
    process::OsRunnerProcessPort,
    protocol::{RunnerAuthKey, RunnerResponse, decode_authenticated_request},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("rho-runner failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.iter().any(|argument| argument == "--version") {
        println!("rho-runner {} protocol=1", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if arguments.iter().any(|argument| argument == "--digest-spec") {
        let spec_path = argument(&arguments, "--digest-spec")?;
        let spec = decode_execution_spec_v1(
            &fs::read(spec_path).map_err(|_| "spec unavailable".to_string())?,
            &BTreeSet::new(),
        )
        .map_err(|_| "spec invalid".to_string())?;
        println!(
            "{}",
            spec.digest(&BTreeSet::new())
                .map_err(|_| "spec invalid".to_string())?
        );
        return Ok(());
    }
    if arguments
        .iter()
        .any(|argument| argument == "--execute-spec-file")
    {
        return execute_spec_file(&arguments);
    }
    let config_path = argument(&arguments, "--config")?;
    let journal_path = argument(&arguments, "--journal")?;
    let auth_file = argument(&arguments, "--auth-file")?;
    let profile: RunnerDeploymentProfile = serde_json::from_slice(
        &fs::read(config_path).map_err(|_| "configuration unavailable".to_string())?,
    )
    .map_err(|_| "configuration malformed".to_string())?;
    let auth_bytes = fs::read(&auth_file).map_err(|_| "auth lease unavailable".to_string())?;
    fs::remove_file(&auth_file).map_err(|_| "auth lease cleanup failed".to_string())?;
    let auth_key = RunnerAuthKey::new(auth_bytes).map_err(|_| "auth lease invalid".to_string())?;
    let mut runner = RunnerCore::open(profile, journal_path, OsRunnerProcessPort::default())
        .map_err(|_| "runner initialization failed".to_string())?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in BufReader::new(stdin.lock()).lines() {
        let line = line.map_err(|_| "stdin read failed".to_string())?;
        if line.is_empty() {
            continue;
        }
        let response = match decode_authenticated_request(line.as_bytes(), &auth_key) {
            Ok(request) => runner.handle(request).unwrap_or(RunnerResponse::Rejected {
                reason_code: "runner_request_rejected".to_string(),
            }),
            Err(_) => RunnerResponse::Rejected {
                reason_code: "authentication_or_frame_rejected".to_string(),
            },
        };
        serde_json::to_writer(&mut stdout, &response)
            .map_err(|_| "stdout encode failed".to_string())?;
        writeln!(stdout).map_err(|_| "stdout write failed".to_string())?;
        stdout
            .flush()
            .map_err(|_| "stdout flush failed".to_string())?;
    }
    Ok(())
}

fn execute_spec_file(arguments: &[String]) -> Result<(), String> {
    let spec_path = argument(arguments, "--execute-spec-file")?;
    let expected_digest = arguments
        .iter()
        .position(|argument| argument == "--expected-digest")
        .and_then(|index| arguments.get(index + 1))
        .ok_or_else(|| "missing --expected-digest".to_string())?;
    let config_path = argument(arguments, "--config")?;
    let profile: RunnerDeploymentProfile = serde_json::from_slice(
        &fs::read(config_path).map_err(|_| "configuration unavailable".to_string())?,
    )
    .map_err(|_| "configuration malformed".to_string())?;
    let spec = decode_execution_spec_v1(
        &fs::read(spec_path).map_err(|_| "spec unavailable".to_string())?,
        &BTreeSet::new(),
    )
    .map_err(|_| "spec invalid".to_string())?;
    let actual_digest = spec
        .digest(&BTreeSet::new())
        .map_err(|_| "spec invalid".to_string())?;
    if actual_digest.as_str() != expected_digest {
        return Err("spec digest mismatch".to_string());
    }
    if !profile.allowed_executors.contains(&spec.executor)
        || !matches!(
            spec.executor,
            ExecutorKind::LocalProcess | ExecutorKind::Slurm
        )
        || !matches!(
            spec.network,
            NetworkPolicy::Deny | NetworkPolicy::ProviderOnly
        )
        || !spec.environment.secret_env.is_empty()
        || spec.argv.is_empty()
        || spec
            .argv
            .iter()
            .any(|argument| argument == "-c" || argument == "/C")
    {
        return Err("spec not admitted by runner profile".to_string());
    }
    let command_profile = profile
        .commands
        .get(&spec.argv[0])
        .ok_or_else(|| "command is not allowlisted".to_string())?;
    if rho_runner::executable_digest(&command_profile.executable)
        .map_err(|_| "command digest unavailable".to_string())?
        != command_profile.executable_sha256
    {
        return Err("command digest mismatch".to_string());
    }
    let relative_working = spec
        .working_set
        .relative_working_directory
        .as_deref()
        .unwrap_or(".");
    let working_directory = if relative_working == "." {
        profile.working_root.clone()
    } else {
        profile.working_root.join(relative_working)
    };
    fs::create_dir_all(&working_directory)
        .map_err(|_| "working directory unavailable".to_string())?;
    fs::create_dir_all(&profile.output_root)
        .map_err(|_| "output directory unavailable".to_string())?;
    let mut command = Command::new(&command_profile.executable);
    command
        .args(spec.argv.iter().skip(1))
        .current_dir(working_directory)
        .env_clear()
        .env("HOME", &profile.output_root)
        .env("TMPDIR", &profile.output_root)
        .env("R_ENVIRON_USER", "/dev/null")
        .env("R_PROFILE_USER", "/dev/null");
    for name in [
        "SLURM_JOB_ID",
        "SLURM_JOB_NAME",
        "SLURM_JOB_NODELIST",
        "CUDA_VISIBLE_DEVICES",
        "NVIDIA_VISIBLE_DEVICES",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let status = command
        .status()
        .map_err(|_| "approved command spawn failed".to_string())?;
    match status.code() {
        Some(code) => std::process::exit(code),
        None => Err("approved command terminated by signal".to_string()),
    }
}

fn argument(arguments: &[String], name: &str) -> Result<PathBuf, String> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1))
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing {name}"))
}
