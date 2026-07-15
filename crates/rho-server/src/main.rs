use std::collections::VecDeque;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use rho_agent_transport::{AgentAuthenticator, read_async_frame};
use rho_kernel::{ArkLaunchConfig, ArkSession};
use serde::Serialize;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Parser)]
#[command(name = "rho-server", about = "Rho Phase 0 runtime probes")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Report local toolchain and runtime availability.
    Doctor,
    /// Spawn a real Agent R process and verify the authenticated side channel.
    ProbeAgentR {
        #[arg(long, default_value = "Rscript")]
        rscript: PathBuf,
        #[arg(long, default_value = "r/rho.agent")]
        agent_package: PathBuf,
    },
    /// Launch Ark directly and execute one R expression.
    ProbeArk {
        #[arg(long)]
        kernelspec: PathBuf,
        #[arg(long = "code")]
        code: Vec<String>,
        #[arg(long)]
        connection_file: Option<PathBuf>,
        #[arg(long = "stdin")]
        stdin: Vec<String>,
        #[arg(long)]
        interrupt_after_ms: Option<u64>,
    },
}

#[derive(Debug, Serialize)]
struct ToolStatus {
    name: &'static str,
    path: Option<PathBuf>,
    version: Option<String>,
}

#[derive(Debug, Serialize)]
struct DoctorReport {
    platform: String,
    architecture: String,
    tools: Vec<ToolStatus>,
    python_required: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Doctor => doctor(),
        Commands::ProbeAgentR {
            rscript,
            agent_package,
        } => probe_agent_r(rscript, agent_package).await,
        Commands::ProbeArk {
            kernelspec,
            code,
            connection_file,
            stdin,
            interrupt_after_ms,
        } => probe_ark(kernelspec, code, connection_file, stdin, interrupt_after_ms).await,
    }
}

async fn probe_agent_r(rscript: PathBuf, agent_package: PathBuf) -> Result<()> {
    let mut authenticator = AgentAuthenticator::bind().await?;
    let address = authenticator.local_addr()?;
    let token = authenticator.bootstrap_token()?.to_string();
    let script = r#"
args <- commandArgs(TRUE)
source(file.path(args[[2]], "R", "transport.R"))
token <- readLines(file("stdin"), n = 1L, warn = FALSE)
connection <- rho_agent_connect(port = as.integer(args[[1]]), token = token)
cat("agent stdout contamination probe\n")
message("agent stderr contamination probe")
rho_agent_emit("probe", list(ok = TRUE))
close(connection)
"#;

    let mut child = tokio::process::Command::new(rscript)
        .arg("-e")
        .arg(script)
        .arg(address.port().to_string())
        .arg(agent_package)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawning Agent R probe")?;
    let mut stdin = child.stdin.take().context("opening Agent R stdin")?;
    stdin.write_all(format!("{token}\n").as_bytes()).await?;
    stdin.shutdown().await?;

    let mut agent = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        authenticator.authenticate_next(),
    )
    .await
    .context("timed out waiting for Agent R authentication")??;
    let event = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        read_async_frame(&mut agent.stream),
    )
    .await
    .context("timed out waiting for Agent R probe event")??;
    let output = child.wait_with_output().await?;
    ensure!(
        output.status.success(),
        "Agent R probe exited with {}",
        output.status
    );
    ensure!(event.payload["type"] == "probe" && event.payload["ok"] == true);

    println!(
        "{}",
        serde_json::json!({
            "type": "agent_r_probe",
            "peer": agent.peer,
            "event": event,
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
            "token_transport": "stdin",
            "protocol_transport": "loopback_tcp"
        })
    );
    Ok(())
}

fn doctor() -> Result<()> {
    let report = DoctorReport {
        platform: env::consts::OS.to_string(),
        architecture: env::consts::ARCH.to_string(),
        tools: vec![
            inspect_tool("Rscript", &["--version"]),
            inspect_tool("git", &["--version"]),
            inspect_tool("node", &["--version"]),
            inspect_tool("ark", &["--help"]),
        ],
        python_required: false,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

async fn probe_ark(
    kernelspec: PathBuf,
    code: Vec<String>,
    connection_file: Option<PathBuf>,
    stdin: Vec<String>,
    interrupt_after_ms: Option<u64>,
) -> Result<()> {
    let mut config = ArkLaunchConfig::new(kernelspec);
    config.connection_file = connection_file;
    let mut session = ArkSession::launch(&config).await?;
    eprintln!("Ark started with pid {:?}", session.child_pid());
    println!(
        "{}",
        serde_json::json!({"type": "kernel_info", "data": session.kernel_info})
    );
    let codes = if code.is_empty() {
        vec!["1 + 1".to_string()]
    } else {
        code
    };
    let mut inputs = VecDeque::from(stdin);
    let mut run_result = Ok(());

    for code in codes {
        eprintln!("Executing: {code}");
        run_result = session
            .execute_with_options(
                code,
                |event| {
                    println!("{}", serde_json::to_string(&event)?);
                    Ok(())
                },
                |_prompt, _password| {
                    inputs
                        .pop_front()
                        .context("Ark requested stdin but no --stdin value remains")
                },
                interrupt_after_ms.map(std::time::Duration::from_millis),
            )
            .await;
        if run_result.is_err() {
            break;
        }
    }

    let shutdown_result = session.shutdown().await;
    run_result?;
    shutdown_result
}

fn inspect_tool(name: &'static str, version_args: &[&str]) -> ToolStatus {
    let path = find_command(name);
    let version = path.as_ref().and_then(|path| {
        Command::new(path)
            .args(version_args)
            .output()
            .ok()
            .map(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let value = if stdout.trim().is_empty() {
                    stderr.trim()
                } else {
                    stdout.trim()
                };
                value.lines().next().unwrap_or_default().to_string()
            })
    });
    ToolStatus {
        name,
        path,
        version,
    }
}

fn find_command(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(str::to_ascii_lowercase)
            .collect()
    } else {
        vec![String::new()]
    };

    for directory in env::split_paths(&path) {
        for extension in &extensions {
            let candidate = if extension.is_empty() {
                directory.join(name)
            } else {
                directory.join(format!("{name}{extension}"))
            };
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_file(path: &Path) -> bool {
    path.metadata()
        .map(|value| value.is_file())
        .unwrap_or(false)
}
