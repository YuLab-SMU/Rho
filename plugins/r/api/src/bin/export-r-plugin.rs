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
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("execute", schemars::schema_for!(ExecuteR)),
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
