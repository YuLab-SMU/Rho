use std::path::PathBuf;
use std::sync::Arc;
mod session;

use clap::{Parser, Subcommand};
use rho_next_contract::{CapabilityRef, Invocation, OperationId, Precondition};
use rho_next_host::{ArkConfig, NextHost, RUN_R_CAPABILITY_ID, RUN_R_CAPABILITY_VERSION};
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
    project: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

impl Cli {
    async fn open_host(&self) -> Result<NextHost, String> {
        if self.demo {
            NextHost::open_demo(&self.database).await
        } else {
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
            };
            NextHost::open_ark(&self.database, config).await
        }
        .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Keep one Host/R session alive; read and write the typed session protocol over stdio.
    Session,
    Invoke {
        #[arg(long)]
        client_request_id: String,
        #[arg(long)]
        code: String,
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
        Command::Session => unreachable!(),
        Command::Invoke {
            client_request_id,
            code,
            expected_session,
        } => {
            let host = active_host.expect("invoke opens one host");
            let preconditions = expected_session
                .map(|session| {
                    vec![Precondition {
                        kind: "workspace.session".to_string(),
                        subject: "active".to_string(),
                        expected: json!(session),
                    }]
                })
                .unwrap_or_default();
            let invocation = Invocation {
                client_request_id,
                capability: CapabilityRef::new(RUN_R_CAPABILITY_ID, RUN_R_CAPABILITY_VERSION)
                    .map_err(|error| error.to_string())?,
                arguments: json!({"code": code}),
                preconditions,
            };
            let record = host
                .invoke(&context, invocation)
                .await
                .map_err(|error| error.to_string())?;
            print_json(&json!({
                "ok": true,
                "runtime": if cli.demo { "deterministic_fake" } else { "ark" },
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
