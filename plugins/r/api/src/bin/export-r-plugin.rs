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
    CheckRCode::export_all(&types)?;
    ReadREvents::export_all(&types)?;
    REventsObservation::export_all(&types)?;
    RExecutionOutput::export_all(&types)?;
    CodeCompleteness::export_all(&types)?;
    ConsoleState::export_all(&types)?;
    RespondInput::export_all(&types)?;
    QueueControlArguments::export_all(&types)?;
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("execute", schemars::schema_for!(ExecuteR)),
        ("execute-result", schemars::schema_for!(RExecutionOutput)),
        ("check-code", schemars::schema_for!(CheckRCode)),
        ("code-completeness", schemars::schema_for!(CodeCompleteness)),
        ("read-events", schemars::schema_for!(ReadREvents)),
        (
            "events-observation",
            schemars::schema_for!(REventsObservation),
        ),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
