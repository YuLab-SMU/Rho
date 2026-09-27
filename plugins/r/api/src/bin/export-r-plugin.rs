use rho_r_api::*;
use std::{fs, path::PathBuf};
use ts_rs::{Config, TS};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("Expected output directory")?,
    );
    let types = Config::new()
        .with_out_dir(root.join("types"))
        .with_large_int("number");
    ExecuteR::export_all(&types)?;
    CreateRSession::export_all(&types)?;
    RSessionCreated::export_all(&types)?;
    FormatRCode::export_all(&types)?;
    FormatResult::export_all(&types)?;
    CheckRCode::export_all(&types)?;
    ReadREvents::export_all(&types)?;
    REventsObservation::export_all(&types)?;
    RExecutionOutput::export_all(&types)?;
    CodeCompleteness::export_all(&types)?;
    ConsoleState::export_all(&types)?;
    RespondInput::export_all(&types)?;
    QueueControlArguments::export_all(&types)?;
    InspectArguments::export_all(&types)?;
    ListObjectsArguments::export_all(&types)?;
    ObserveObjectArguments::export_all(&types)?;
    ReadObjectArguments::export_all(&types)?;
    PackageQueryArguments::export_all(&types)?;
    PackageIndexArguments::export_all(&types)?;
    ReadPackageHelpArguments::export_all(&types)?;
    RInspectionStateArguments::export_all(&types)?;
    RInspectionState::export_all(&types)?;
    RInspection::<ObjectDirectoryPage>::export_all(&types)?;
    ObjectDirectoryPage::export_all(&types)?;
    ObjectObservation::export_all(&types)?;
    ObjectReadPage::export_all(&types)?;
    BindingSummary::export_all(&types)?;
    PackageSnapshotData::export_all(&types)?;
    PackageIndexPage::export_all(&types)?;
    PackageHelpPage::export_all(&types)?;
    CheckpointCaptureArguments::export_all(&types)?;
    RCheckpointManifest::export_all(&types)?;
    CheckpointNativeRestoreReport::export_all(&types)?;
    RCheckpointArguments::export_all(&types)?;
    RCheckpointRead::export_all(&types)?;
    RCheckpointChunk::export_all(&types)?;
    RestoreRCheckpoint::export_all(&types)?;
    ReconcileRCheckpoint::export_all(&types)?;
    PinRCheckpoint::export_all(&types)?;
    DeleteRCheckpoint::export_all(&types)?;
    PurgeRCheckpoint::export_all(&types)?;
    RCheckpointObservation::export_all(&types)?;
    RCheckpointList::export_all(&types)?;
    RCheckpointPage::export_all(&types)?;
    RCheckpointCaptureOutput::export_all(&types)?;
    RCheckpointRestoreOutput::export_all(&types)?;
    RCheckpointControlOutput::export_all(&types)?;
    ResolveRCheckpointControl::export_all(&types)?;
    RCheckpointControlResolutionOutput::export_all(&types)?;
    RCheckpointControlArguments::export_all(&types)?;
    RCheckpointControlObservation::export_all(&types)?;
    RCheckpointPurgeOutput::export_all(&types)?;
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("capture-checkpoint", schemars::schema_for!(CheckpointCaptureArguments)),
        ("checkpoint-capture-output", schemars::schema_for!(RCheckpointCaptureOutput)),
        ("checkpoint-manifest", schemars::schema_for!(RCheckpointManifest)),
        ("checkpoint-arguments", schemars::schema_for!(RCheckpointArguments)),
        ("read-checkpoint", schemars::schema_for!(RCheckpointRead)),
        ("checkpoint-chunk", schemars::schema_for!(RCheckpointChunk)),
        ("restore-checkpoint", schemars::schema_for!(RestoreRCheckpoint)),
        ("checkpoint-restore-output", schemars::schema_for!(RCheckpointRestoreOutput)),
        ("checkpoint-restore-report", schemars::schema_for!(CheckpointNativeRestoreReport)),
        ("reconcile-checkpoint", schemars::schema_for!(ReconcileRCheckpoint)),
        ("pin-checkpoint", schemars::schema_for!(PinRCheckpoint)),
        ("delete-checkpoint", schemars::schema_for!(DeleteRCheckpoint)),
        ("purge-checkpoint", schemars::schema_for!(PurgeRCheckpoint)),
        ("checkpoint-control-output", schemars::schema_for!(RCheckpointControlOutput)),
        ("resolve-checkpoint-control", schemars::schema_for!(ResolveRCheckpointControl)),
        ("checkpoint-control-resolution-output", schemars::schema_for!(RCheckpointControlResolutionOutput)),
        ("checkpoint-control-arguments", schemars::schema_for!(RCheckpointControlArguments)),
        ("checkpoint-control-observation", schemars::schema_for!(RCheckpointControlObservation)),
        ("checkpoint-purge-output", schemars::schema_for!(RCheckpointPurgeOutput)),
        ("checkpoint-observation", schemars::schema_for!(RCheckpointObservation)),
        ("list-checkpoints", schemars::schema_for!(RCheckpointList)),
        ("checkpoint-page", schemars::schema_for!(RCheckpointPage)),
        ("execute", schemars::schema_for!(ExecuteR)),
        ("create-session", schemars::schema_for!(CreateRSession)),
        ("session-created", schemars::schema_for!(RSessionCreated)),
        ("format", schemars::schema_for!(FormatRCode)),
        ("formatted-code", schemars::schema_for!(FormatResult)),
        ("execute-result", schemars::schema_for!(RExecutionOutput)),
        ("check-code", schemars::schema_for!(CheckRCode)),
        ("code-completeness", schemars::schema_for!(CodeCompleteness)),
        ("read-events", schemars::schema_for!(ReadREvents)),
        (
            "events-observation",
            schemars::schema_for!(REventsObservation),
        ),
        ("list-objects", schemars::schema_for!(ListObjectsArguments)),
        ("inspection-state-arguments", schemars::schema_for!(RInspectionStateArguments)),
        ("inspection-state", schemars::schema_for!(RInspectionState)),
        ("object-directory", schemars::schema_for!(RInspection<ObjectDirectoryPage>)),
        ("observe-object", schemars::schema_for!(ObserveObjectArguments)),
        ("object-observation", schemars::schema_for!(RInspection<ObjectObservation>)),
        ("read-object", schemars::schema_for!(ReadObjectArguments)),
        ("object-read", schemars::schema_for!(RInspection<ObjectReadPage>)),
        ("inspect-object", schemars::schema_for!(InspectArguments)),
        ("object-preview", schemars::schema_for!(RInspection<BindingSummary>)),
        ("packages", schemars::schema_for!(PackageQueryArguments)),
        ("package-observation", schemars::schema_for!(RInspection<PackageSnapshotData>)),
        ("package-index", schemars::schema_for!(PackageIndexArguments)),
        ("package-index-observation", schemars::schema_for!(RInspection<PackageIndexPage>)),
        ("read-help", schemars::schema_for!(ReadPackageHelpArguments)),
        ("help-observation", schemars::schema_for!(RInspection<PackageHelpPage>)),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
