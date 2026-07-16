use std::collections::VecDeque;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use rho_agent_transport::{AgentAuthenticator, read_async_frame};
use rho_kernel::{ArkLaunchConfig, ArkSession, KernelEvent};
use serde::Serialize;
use tokio::io::AsyncWriteExt;

mod coordinator;

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
    /// Run Agent R -> broker -> Ark -> rho.bridge -> SQLite end to end.
    ProbeCoordinator {
        #[arg(long)]
        kernelspec: PathBuf,
        #[arg(long, default_value = "Rscript")]
        rscript: PathBuf,
        #[arg(long, default_value = "r/rho.agent")]
        agent_package: PathBuf,
        #[arg(long, default_value = "r/rho.bridge")]
        bridge_package: PathBuf,
        #[arg(long, default_value = ".rho/state/phase0-probe.sqlite")]
        store: PathBuf,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, default_value = "Run the required Workspace R verification now.")]
        prompt: String,
    },
    /// Ask Ark whether R input is complete, incomplete, invalid, or unknown.
    ProbeCompleteness {
        #[arg(long)]
        kernelspec: PathBuf,
        #[arg(long = "code")]
        code: Vec<String>,
    },
    /// Open Ark's LSP and Positron UI comm targets and verify replies.
    ProbeComms {
        #[arg(long)]
        kernelspec: PathBuf,
    },
    /// Verify Ark HTML, PNG, and dynamic SVG rich output paths.
    ProbeRichOutput {
        #[arg(long)]
        kernelspec: PathBuf,
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
        Commands::ProbeCoordinator {
            kernelspec,
            rscript,
            agent_package,
            bridge_package,
            store,
            model,
            prompt,
        } => {
            coordinator::probe(
                kernelspec,
                rscript,
                agent_package,
                bridge_package,
                store,
                model,
                prompt,
            )
            .await
        }
        Commands::ProbeCompleteness { kernelspec, code } => {
            probe_completeness(kernelspec, code).await
        }
        Commands::ProbeComms { kernelspec } => probe_comms(kernelspec).await,
        Commands::ProbeRichOutput { kernelspec } => probe_rich_output(kernelspec).await,
    }
}

async fn probe_rich_output(kernelspec: PathBuf) -> Result<()> {
    let mut session = ArkSession::launch(&ArkLaunchConfig::new(kernelspec)).await?;
    let run_result = async {
        eprintln!("rich-output: PNG");
        let mut png_bytes = 0;
        session
            .execute("plot(1:5, main = 'Rho PNG probe')", |event| {
                if let KernelEvent::DisplayData { data } = event.event
                    && let Some(value) = data["image/png"].as_str()
                {
                    png_bytes = value.len();
                }
                Ok(())
            })
            .await?;
        ensure!(png_bytes > 100, "Ark plot probe omitted image/png data");

        eprintln!("rich-output: UI comm");
        let ui = session
            .open_comm(
                "positron.ui",
                serde_json::json!({"console_width": 100}),
                2,
                std::time::Duration::from_secs(10),
            )
            .await?;

        eprintln!("rich-output: HTML");
        let html_event = session
            .execute_capture_comm_message(
                r#"local({
  path <- tempfile(fileext = ".html")
  writeLines(
    "<html><body><strong>Rho HTML probe</strong></body></html>",
    path,
    useBytes = TRUE
  )
  getOption("viewer")(path)
  invisible(path)
})"#,
                &ui.comm_id,
                "show_html_file",
            )
            .await?;
        let html_path = html_event["params"]["path"]
            .as_str()
            .context("Ark show_html_file omitted path")?;
        let html = std::fs::read_to_string(html_path)
            .with_context(|| format!("reading Ark HTML output {html_path}"))?;
        ensure!(
            html.contains("Rho HTML probe"),
            "Ark HTML output lost marker"
        );

        eprintln!("rich-output: plot comm");
        let plot = session
            .execute_capture_comm_open("plot(1:5, main = 'Rho SVG probe')", "positron.plot")
            .await?;
        eprintln!("rich-output: SVG render RPC");
        let svg = session
            .comm_rpc(
                &plot.comm_id,
                "render",
                serde_json::json!({
                    "size": {"width": 640, "height": 480},
                    "pixel_ratio": 1.0,
                    "format": "svg"
                }),
                std::time::Duration::from_secs(30),
            )
            .await?;
        eprintln!("rich-output: SVG reply received");
        let svg_result = svg
            .get("result")
            .context("Ark plot render reply omitted result")?;
        let mime_type = svg_result["mime_type"]
            .as_str()
            .context("Ark plot render reply omitted mime_type")?;
        let svg_bytes = svg_result["data"]
            .as_str()
            .context("Ark plot render reply omitted data")?
            .len();
        ensure!(
            mime_type.contains("svg"),
            "Ark returned non-SVG plot MIME: {mime_type}"
        );
        ensure!(svg_bytes > 100, "Ark returned an empty SVG plot");

        Ok::<_, anyhow::Error>(serde_json::json!({
            "type": "rich_output_probe",
            "html": {
                "transport": "positron.ui/show_html_file",
                "chars": html.len()
            },
            "png": {
                "mime_type": "image/png",
                "base64_chars": png_bytes
            },
            "svg": {
                "mime_type": mime_type,
                "base64_chars": svg_bytes,
                "plot_comm_id": plot.comm_id
            }
        }))
    }
    .await;
    let shutdown_result = session.shutdown().await;
    let result = run_result?;
    shutdown_result?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

async fn probe_comms(kernelspec: PathBuf) -> Result<()> {
    let mut session = ArkSession::launch(&ArkLaunchConfig::new(kernelspec)).await?;
    let run_result = async {
        let lsp = session
            .open_comm(
                "lsp",
                serde_json::json!({"ip_address": "127.0.0.1"}),
                1,
                std::time::Duration::from_secs(30),
            )
            .await?;
        let comms = session.comm_info(Some("lsp".to_string())).await?;
        let lsp_registered = comms
            .comms
            .iter()
            .any(|(id, info)| id.0 == lsp.comm_id && info.target_name == "lsp");
        ensure!(
            lsp_registered,
            "Ark comm_info did not list the opened LSP comm"
        );

        let ui = session
            .open_comm(
                "positron.ui",
                serde_json::json!({"console_width": 100}),
                2,
                std::time::Duration::from_secs(10),
            )
            .await?;
        let ui_methods: Vec<_> = ui
            .messages
            .iter()
            .filter_map(|message| message["method"].as_str())
            .collect();
        ensure!(ui_methods.len() == 2, "Ark UI comm omitted initial methods");
        ensure!(
            ui_methods[0] != ui_methods[1],
            "Ark UI comm repeated its initial method"
        );
        Ok::<_, anyhow::Error>(serde_json::json!({
            "type": "comm_probe",
            "lsp": lsp,
            "lsp_registered": lsp_registered,
            "ui": ui
        }))
    }
    .await;
    let shutdown_result = session.shutdown().await;
    let result = run_result?;
    shutdown_result?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

async fn probe_completeness(kernelspec: PathBuf, code: Vec<String>) -> Result<()> {
    let mut session = ArkSession::launch(&ArkLaunchConfig::new(kernelspec)).await?;
    let codes = if code.is_empty() {
        vec![
            "1 + 1".to_string(),
            "if (TRUE) {".to_string(),
            "1 + )".to_string(),
        ]
    } else {
        code
    };
    let mut results = Vec::new();
    let mut probe_result = Ok(());
    for code in codes {
        match session.is_complete(code.clone()).await {
            Ok(completeness) => results.push(serde_json::json!({
                "code": code,
                "status": completeness.status,
                "indent": completeness.indent
            })),
            Err(error) => {
                probe_result = Err(error);
                break;
            }
        }
    }
    let shutdown_result = session.shutdown().await;
    probe_result?;
    shutdown_result?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "type": "code_completeness_probe",
            "results": results
        }))?
    );
    Ok(())
}

async fn probe_agent_r(rscript: PathBuf, agent_package: PathBuf) -> Result<()> {
    let mut authenticator = AgentAuthenticator::bind().await?;
    let address = authenticator.local_addr()?;
    let token = authenticator.bootstrap_token()?.to_string();
    let script = r#"
args <- commandArgs(TRUE)
source(file.path(args[[2]], "R", "aaa-state.R"))
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
