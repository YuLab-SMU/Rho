use std::path::PathBuf;
use std::sync::Arc;
mod session;

use clap::{Parser, Subcommand};
use rho_next_contract::{CapabilityRef, Invocation, OperationId, Precondition};
use rho_next_host::{ArkConfig, NextHost, REnvironmentConfig, RUN_R_CAPABILITY_ID, SshConfig};
use serde_json::json;

#[derive(Debug, Parser)]
#[command(name = "rho-next", about = "Rho Next scientific workspace")]
struct Cli {
    #[arg(long)]
    database: PathBuf,
    /// Explicit test-only runtime; does not run R.
    #[arg(long, conflicts_with = "ark")]
    demo: bool,
    #[arg(long)]
    ark: Option<PathBuf>,
    #[arg(long)]
    r_home: Option<PathBuf>,
    #[arg(long)]
    rscript: Option<PathBuf>,
    /// Bind a verified Environment realization when starting a new Ark session.
    #[arg(long, requires = "ark")]
    environment: Option<String>,
    #[arg(long)]
    project: Option<PathBuf>,
    /// An existing OpenSSH host alias. No connection is made while opening Host.
    #[arg(long, requires = "remote_root", conflicts_with = "demo")]
    remote_host: Option<String>,
    #[arg(long, requires = "remote_host")]
    remote_root: Option<String>,
    #[arg(long, requires = "remote_host")]
    slurm_cluster: Option<String>,
    #[command(subcommand)]
    command: Command,
}

impl Cli {
    async fn open_host(&self) -> Result<NextHost, String> {
        let remote = self.remote_host.as_ref().map(|host| SshConfig {
            host_alias: host.clone(),
            project_root: self.remote_root.clone().unwrap_or_default(),
            slurm_cluster: self.slurm_cluster.clone(),
        });
        if self.demo {
            NextHost::open_demo(&self.database).await
        } else if self.ark.is_some() {
            let config = ArkConfig {
                executable: self
                    .ark
                    .clone()
                    .ok_or("--ark is required for a real Workspace")?,
                r_home: self
                    .r_home
                    .clone()
                    .ok_or("--r-home is required for a real Workspace")?,
                project_root: self
                    .project
                    .clone()
                    .ok_or("--project is required for a real Workspace")?,
                data_root: self
                    .database
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("runtime"),
                execution_timeout: std::time::Duration::from_secs(600),
                library_path: None,
            };
            NextHost::open_ark_with_remote(
                &self.database,
                config,
                self.environment.as_deref(),
                remote,
            )
            .await
        } else if let Some(rscript) = &self.rscript {
            let config = REnvironmentConfig {
                rscript: rscript.clone(),
                project_root: self.project.clone().ok_or("--project is required")?,
                data_root: self
                    .database
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("environment"),
                timeout: std::time::Duration::from_secs(300),
            };
            NextHost::open_environment_with_remote(&self.database, config, remote).await
        } else {
            NextHost::open_project_with_remote(
                &self.database,
                self.project.as_ref().ok_or("--project is required")?,
                remote,
            )
            .await
        }
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Keep one Host/R session alive; read and write the typed session protocol over stdio.
    Session,
    /// Serve MCP over stdio using the same Host and capability registry.
    Mcp,
    Invoke {
        #[arg(long)]
        client_request_id: String,
        #[arg(
            long,
            required_unless_present = "arguments",
            conflicts_with = "arguments"
        )]
        code: Option<String>,
        #[arg(long, conflicts_with = "code")]
        arguments: Option<String>,
        #[arg(long, default_value = RUN_R_CAPABILITY_ID)]
        capability: String,
        #[arg(long, default_value_t = 1)]
        capability_version: u16,
        #[arg(long, default_value = "[]")]
        preconditions: String,
        #[arg(long)]
        expected_session: Option<String>,
    },
    GetOperation {
        operation_id: String,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "ok": false,
                "error": error,
            }))
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encoding failure\"}".to_string())
        );
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let cli = Cli::parse();
    let context = NextHost::local_context();
    if matches!(cli.command, Command::Mcp) {
        let host = Arc::new(cli.open_host().await?);
        return rho_next_mcp::serve(host, tokio::io::stdin(), tokio::io::stdout()).await;
    }
    if matches!(cli.command, Command::Session) {
        let host = Arc::new(cli.open_host().await?);
        return session::serve(host, tokio::io::stdin(), tokio::io::stdout()).await;
    }
    let active_host = if matches!(cli.command, Command::Invoke { .. }) {
        Some(cli.open_host().await?)
    } else {
        None
    };
    match cli.command {
        Command::Session | Command::Mcp => unreachable!(),
        Command::Invoke {
            client_request_id,
            code,
            arguments,
            capability,
            capability_version,
            preconditions,
            expected_session,
        } => {
            let host = active_host.expect("invoke opens one host");
            let mut preconditions: Vec<Precondition> =
                serde_json::from_str(&preconditions).map_err(|error| error.to_string())?;
            if let Some(session) = expected_session {
                preconditions.push(Precondition {
                    kind: "workspace.session".to_string(),
                    subject: "active".to_string(),
                    expected: json!(session),
                });
            }
            let arguments = if let Some(arguments) = arguments {
                serde_json::from_str(&arguments).map_err(|error| error.to_string())?
            } else {
                json!({"code":code.ok_or("--code or --arguments is required")?})
            };
            let invocation = Invocation {
                client_request_id,
                capability: CapabilityRef::new(capability, capability_version)
                    .map_err(|error| error.to_string())?,
                arguments,
                preconditions,
            };
            let record = host
                .invoke(&context, invocation)
                .await
                .map_err(|error| error.to_string())?;
            print_json(&json!({
                "ok": true,
                "runtime": if cli.demo { "deterministic_fake" } else if cli.ark.is_some() { "ark" } else if cli.rscript.is_some() { "environment" } else { "project" },
                "operation": record,
            }))
        }
        Command::GetOperation { operation_id } => {
            let host =
                NextHost::open_read_only(&cli.database).map_err(|error| error.to_string())?;
            let operation_id = OperationId::new(operation_id).map_err(|error| error.to_string())?;
            let record = host
                .get_operation(&context, &operation_id)
                .await
                .map_err(|error| error.to_string())?;
            print_json(&json!({
                "ok": true,
                "operation": record,
            }))
        }
    }
}

fn print_json(value: &serde_json::Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
    );
    Ok(())
}
