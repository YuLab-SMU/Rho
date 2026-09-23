use rho_plugin_protocol::*;
use std::{fs, path::PathBuf};
use ts_rs::{Config, TS};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("expected export directory")?,
    );
    let types = Config::new()
        .with_out_dir(root.join("types"))
        .with_large_int("number");
    PluginArchive::export_all(&types)?;
    PluginRevisionPage::export_all(&types)?;
    RevisionDifference::export_all(&types)?;
    PluginInstance::export_all(&types)?;
    PluginInstancePage::export_all(&types)?;
    RpcFrame::export_all(&types)?;
    ScenarioRevision::export_all(&types)?;
    WindowScenario::export_all(&types)?;
    VisualDocument::export_all(&types)?;
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("manifest", schemars::schema_for!(PluginManifest)),
        ("archive", schemars::schema_for!(PluginArchive)),
        ("rpc", schemars::schema_for!(RpcFrame)),
        ("scenario", schemars::schema_for!(ScenarioRevision)),
        ("visual-document", schemars::schema_for!(VisualDocument)),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
