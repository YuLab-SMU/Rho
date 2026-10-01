use rho_process_api::*;
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
    macro_rules! export { ($($ty:ty),+ $(,)?) => { $(<$ty>::export_all(&types)?;)+ }; }
    export!(
        RunLocalArguments,
        ProcessReport,
        ProcessRunResult,
        ProcessRunRecovery,
        ProcessStatus,
        NativeProcessIdentity,
        ProcessReconciliation,
        ReconcileProcessArguments,
        LocalProcessRecovery,
        ProcessReconcileRecovery
    );
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("run-local", schemars::schema_for!(RunLocalArguments)),
        ("native-report", schemars::schema_for!(ProcessReport)),
        ("run-result", schemars::schema_for!(ProcessRunResult)),
        ("run-recovery", schemars::schema_for!(ProcessRunRecovery)),
        ("status", schemars::schema_for!(ProcessStatus)),
        (
            "reconciliation",
            schemars::schema_for!(ProcessReconciliation),
        ),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
