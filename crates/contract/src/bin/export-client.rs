use rho_contract::*;
use ts_rs::{Config, TS};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::args_os()
        .nth(1)
        .ok_or("expected output directory")?;
    // The wire is JSON, not JavaScript BigInt. Consumers reject unsafe cursors.
    let config = Config::new()
        .with_out_dir(directory)
        .with_large_int("number");
    WorkbenchInfo::export_all(&config)?;
    WorkbenchFrame::export_all(&config)?;
    SelectProject::export_all(&config)?;
    SessionReply::export_all(&config)?;
    OperationRecord::export_all(&config)?;
    QuerySnapshot::export_all(&config)?;
    OutboxRecord::export_all(&config)?;
    ApplicationState::export_all(&config)?;
    ReadApplicationState::export_all(&config)?;
    WriteApplicationState::export_all(&config)?;
    RConfiguration::export_all(&config)?;
    ApplyRConfiguration::export_all(&config)?;
    Ok(())
}
