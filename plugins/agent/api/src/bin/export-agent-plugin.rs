use rho_agent_api::*;
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
        AgentControllerRef,
        AgentProvider,
        AgentModel,
        LocalAgent,
        AgentDecisionOption,
        AgentDecision,
        AgentMessage,
        AgentClientSession,
        AgentPermissionMode,
        AgentNativeCapabilities,
        AgentUsageObservation
    );
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("controller", schemars::schema_for!(AgentControllerRef)),
        ("discovery", schemars::schema_for!(LocalAgent)),
        ("session", schemars::schema_for!(AgentClientSession)),
        (
            "capabilities",
            schemars::schema_for!(AgentNativeCapabilities),
        ),
        ("usage", schemars::schema_for!(AgentUsageObservation)),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
