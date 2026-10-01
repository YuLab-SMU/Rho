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
    CancelOperation::export_all(&config)?;
    Invocation::export_all(&config)?;
    WorkbenchInfo::export_all(&config)?;
    WorkbenchAgentConnection::export_all(&config)?;
    WorkbenchFrame::export_all(&config)?;
    SelectProject::export_all(&config)?;
    SessionReply::export_all(&config)?;
    OperationRecord::export_all(&config)?;
    QuerySnapshot::export_all(&config)?;
    OutboxRecord::export_all(&config)?;
    ApplicationState::export_all(&config)?;
    ReadApplicationState::export_all(&config)?;
    WriteApplicationState::export_all(&config)?;
    RecentOperations::export_all(&config)?;
    ProjectReadCoverage::export_all(&config)?;
    ProjectReadCoverageArguments::export_all(&config)?;
    RecentOperationsArguments::export_all(&config)?;
    OperationEventsCheckpoint::export_all(&config)?;
    OperationEventsCheckpointArguments::export_all(&config)?;
    CapabilityExample::export_all(&config)?;
    CapabilityPrecondition::export_all(&config)?;
    CapabilityDocumentation::export_all(&config)?;
    NextRead::export_all(&config)?;
    DiagnosticCode::export_all(&config)?;
    DiagnosticContinuation::export_all(&config)?;
    Diagnostic::export_all(&config)?;
    HostCatalogArguments::export_all(&config)?;
    HostDescribeArguments::export_all(&config)?;
    CapabilitySummary::export_all(&config)?;
    HostCatalog::export_all(&config)?;
    ModuleAvailability::export_all(&config)?;
    HostOverview::export_all(&config)?;
    OverviewObservation::export_all(&config)?;
    HostDescription::export_all(&config)?;
    OperationSummary::export_all(&config)?;
    InvokeRequest::export_all(&config)?;
    CancellationRequestOutcome::export_all(&config)?;
    OperationGetArguments::export_all(&config)?;
    OperationCommitStatus::export_all(&config)?;
    ReconcileOperationCommit::export_all(&config)?;
    OperationGetResult::export_all(&config)?;
    OperationReadEvidenceArguments::export_all(&config)?;
    OperationEvidencePage::export_all(&config)?;
    ObserveOwnerRecovery::export_all(&config)?;
    HostRestartRecovery::export_all(&config)?;
    ContractFailureRecovery::export_all(&config)?;
    PollOperationEventsArguments::export_all(&config)?;
    OperationEventsPage::export_all(&config)?;
    Ok(())
}
