use rho_environment_api::*;
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
        EnvironmentConfiguration,
        EnvironmentStatus,
        EnvironmentSnapshot,
        EnvironmentResult,
        EnvironmentRecovery,
        PlanArguments,
        RealizeArguments,
        VerifyArguments,
        ReconcileArguments,
        ObserveArguments,
        EnvironmentPlan,
        EnvironmentRealization,
        Verification,
        EnvironmentReconciliation,
        EnvironmentObservation,
        EnvironmentRuntimeRecovery,
        EnvironmentStageRecovery,
        EnvironmentRealizeRecovery,
        EnvironmentReconcileRecovery,
        EnvironmentMaterialRecovery,
        MaterialKind,
        MaterialAction,
        MaterialChange,
        RetentionView,
        EnvironmentSourceArguments,
        EnvironmentCleanupArguments,
        EnvironmentTrashArguments,
        EnvironmentChangeTrashArguments
    );
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        (
            "configuration",
            schemars::schema_for!(EnvironmentConfiguration),
        ),
        ("status", schemars::schema_for!(EnvironmentStatus)),
        ("snapshot", schemars::schema_for!(EnvironmentSnapshot)),
        ("result", schemars::schema_for!(EnvironmentResult)),
        ("recovery", schemars::schema_for!(EnvironmentRecovery)),
        ("plan", schemars::schema_for!(EnvironmentPlan)),
        ("realization", schemars::schema_for!(EnvironmentRealization)),
        ("verification", schemars::schema_for!(Verification)),
        (
            "reconciliation",
            schemars::schema_for!(EnvironmentReconciliation),
        ),
        (
            "native-recovery",
            schemars::schema_for!(EnvironmentRealizeRecovery),
        ),
        ("retention", schemars::schema_for!(RetentionView)),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
