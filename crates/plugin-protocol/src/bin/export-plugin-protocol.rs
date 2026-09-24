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
    OperationId::export_all(&types)?;
    PluginArchive::export_all(&types)?;
    PluginRevisionPage::export_all(&types)?;
    RevisionDifference::export_all(&types)?;
    PluginInstance::export_all(&types)?;
    PluginInstancePage::export_all(&types)?;
    PluginRequest::export_all(&types)?;
    PluginPreflightRequest::export_all(&types)?;
    PluginPreflightResult::export_all(&types)?;
    PluginCatalogArguments::export_all(&types)?;
    PluginRevisionArguments::export_all(&types)?;
    PluginCatalogPage::export_all(&types)?;
    PluginInspection::export_all(&types)?;
    PluginInstancesArguments::export_all(&types)?;
    PluginInstanceArguments::export_all(&types)?;
    PluginInstanceObservations::export_all(&types)?;
    PluginResolveArguments::export_all(&types)?;
    ActivatePlugin::export_all(&types)?;
    BranchPlugin::export_all(&types)?;
    AdvancePluginBranch::export_all(&types)?;
    PluginBranchArguments::export_all(&types)?;
    ComparePluginRevisions::export_all(&types)?;
    ResourceInspect::export_all(&types)?;
    ResourceList::export_all(&types)?;
    ResourcePage::export_all(&types)?;
    ResourceChunk::export_all(&types)?;
    ResourceTransferRequest::export_all(&types)?;
    ResourceTransferResponse::export_all(&types)?;
    OpenPluginView::export_all(&types)?;
    UpdatePluginView::export_all(&types)?;
    PluginViewArguments::export_all(&types)?;
    PluginViewConnection::export_all(&types)?;
    PluginViewMessage::export_all(&types)?;
    PluginWindowLayout::export_all(&types)?;
    PluginWindowArguments::export_all(&types)?;
    UpdatePluginWindowLayout::export_all(&types)?;
    OpenPluginWindowView::export_all(&types)?;
    OpenedPluginWindowView::export_all(&types)?;
    RpcFrame::export_all(&types)?;
    ScenarioRevision::export_all(&types)?;
    WindowScenario::export_all(&types)?;
    VisualDocument::export_all(&types)?;
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("manifest", schemars::schema_for!(PluginManifest)),
        ("archive", schemars::schema_for!(PluginArchive)),
        ("rpc", schemars::schema_for!(RpcFrame)),
        ("view-message", schemars::schema_for!(PluginViewMessage)),
        ("window-layout", schemars::schema_for!(PluginWindowLayout)),
        ("window-open-view", schemars::schema_for!(OpenPluginWindowView)),
        ("resource-transfer-request", schemars::schema_for!(ResourceTransferRequest)),
        ("resource-transfer-response", schemars::schema_for!(ResourceTransferResponse)),
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
