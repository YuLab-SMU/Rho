use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use rho_store::SemanticStore;
use serde_json::json;

#[derive(Debug, Parser)]
#[command(name = "rho", about = "Rho semantic control-plane observer")]
struct Cli {
    #[arg(long)]
    app_data_root: PathBuf,
    #[arg(long)]
    database: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect fresh semantic-store identity and projection count.
    Status,
    /// Read a named current projection. This command never invokes effects.
    Projection { key: String },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let (store, outcome) = SemanticStore::open_app_local(&cli.app_data_root, &cli.database)?;
    match cli.command {
        Command::Status => {
            let projection_count = store.projection_snapshot()?.len();
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "schema_version": outcome.schema_version,
                    "schema_fingerprint": outcome.fingerprint,
                    "projection_count": projection_count,
                    "authority": "observer_only"
                }))?
            );
        }
        Command::Projection { key } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "key": key,
                    "value": store.current_projection_value(&key)?,
                    "authority": "observer_only"
                }))?
            );
        }
    }
    Ok(())
}
