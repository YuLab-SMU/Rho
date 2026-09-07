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
    RunROutput::export_all(&config)?;
    BindingSummary::export_all(&config)?;
    WorkspaceSnapshotData::export_all(&config)?;
    FilePage::export_all(&config)?;
    ProjectPatchResult::export_all(&config)?;
    RecentOperations::export_all(&config)?;
    RecentOperationsArguments::export_all(&config)?;
    OutputEvents::export_all(&config)?;
    OutputEventsArguments::export_all(&config)?;
    ReadOutputArguments::export_all(&config)?;
    OutputPage::export_all(&config)?;
    RuntimeStatus::export_all(&config)?;
    DirectoryPage::export_all(&config)?;
    ListDirectoryArguments::export_all(&config)?;
    FormatResult::export_all(&config)?;
    Ok(())
}
