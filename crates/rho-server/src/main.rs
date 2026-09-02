use std::collections::VecDeque;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use rho_kernel::{ArkLaunchConfig, ArkSession, KernelEvent};
use serde::Serialize;

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
        Commands::ProbeArk {
            kernelspec,
            code,
            connection_file,
            stdin,
            interrupt_after_ms,
        } => probe_ark(kernelspec, code, connection_file, stdin, interrupt_after_ms).await,
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
            .execute_with_options_async(
                code,
                |event| async move {
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
