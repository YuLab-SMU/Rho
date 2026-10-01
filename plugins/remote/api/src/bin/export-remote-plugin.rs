use rho_process_api::RunLocalArguments;
use rho_remote_api::*;
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
        RemoteConfiguration,
        RemoteTarget,
        RemoteExecutionReport,
        RemoteRunResult,
        RemoteRunRecovery,
        RemoteStatus,
        SlurmSubmitArguments,
        SlurmSourceArguments,
        SlurmJobRef,
        SlurmLookup,
        SlurmCancellation,
        SlurmSnapshot,
        RemoteProcessRecovery,
        SlurmSubmissionRecovery,
        SlurmReconcileRecovery,
        SlurmCancelRecovery
    );
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("configuration", schemars::schema_for!(RemoteConfiguration)),
        ("run-arguments", schemars::schema_for!(RunLocalArguments)),
        (
            "native-report",
            schemars::schema_for!(RemoteExecutionReport),
        ),
        ("run-result", schemars::schema_for!(RemoteRunResult)),
        ("run-recovery", schemars::schema_for!(RemoteRunRecovery)),
        ("status", schemars::schema_for!(RemoteStatus)),
        ("slurm-submit", schemars::schema_for!(SlurmSubmitArguments)),
        ("slurm-snapshot", schemars::schema_for!(SlurmSnapshot)),
        (
            "slurm-cancellation",
            schemars::schema_for!(SlurmCancellation),
        ),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
