use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "rho-mcp", about = "Rho Agent capability and state facade")]
struct Cli {
    #[arg(long)]
    context_file: Option<PathBuf>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    rho_mcp::serve_stdio(cli.context_file.as_deref())
}
