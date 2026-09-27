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
    WorkspacePaths::export_all(&types)?;
    ProjectReadCoverage::export_all(&types)?;
    ProjectReadCoverageArguments::export_all(&types)?;
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
    ClosePluginView::export_all(&types)?;
    PluginViewLifecycle::export_all(&types)?;
    PluginViewConnection::export_all(&types)?;
    PluginViewMessage::export_all(&types)?;
    PluginWindowLayout::export_all(&types)?;
    PluginWindowArguments::export_all(&types)?;
    UpdatePluginWindowLayout::export_all(&types)?;
    OpenPluginWindowView::export_all(&types)?;
    OpenedPluginWindowView::export_all(&types)?;
    ContextSearch::export_all(&types)?;
    ContextPage::export_all(&types)?;
    PreviewContext::export_all(&types)?;
    ContextPreview::export_all(&types)?;
    DocumentDraft::export_all(&types)?;
    StageDraftChunk::export_all(&types)?;
    SaveDocumentDraft::export_all(&types)?;
    DocumentDraftArguments::export_all(&types)?;
    ListDocumentDrafts::export_all(&types)?;
    DocumentDraftPage::export_all(&types)?;
    ReadDocumentDraft::export_all(&types)?;
    DocumentDraftChunk::export_all(&types)?;
    DiscardDocumentDraft::export_all(&types)?;
    RpcFrame::export_all(&types)?;
    ScenarioRevision::export_all(&types)?;
    SaveScenario::export_all(&types)?;
    ListScenarios::export_all(&types)?;
    ScenarioPage::export_all(&types)?;
    ScenarioRevisionArguments::export_all(&types)?;
    WindowScenario::export_all(&types)?;
    VisualDocument::export_all(&types)?;
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("project-read-coverage", schemars::schema_for!(ProjectReadCoverage)),
        ("project-read-coverage-arguments", schemars::schema_for!(ProjectReadCoverageArguments)),
        ("manifest", schemars::schema_for!(PluginManifest)),
        ("archive", schemars::schema_for!(PluginArchive)),
        ("rpc", schemars::schema_for!(RpcFrame)),
        ("workspace-paths", schemars::schema_for!(WorkspacePaths)),
        ("view-message", schemars::schema_for!(PluginViewMessage)),
        ("view-close", schemars::schema_for!(ClosePluginView)),
        ("window-layout", schemars::schema_for!(PluginWindowLayout)),
        (
            "window-open-view",
            schemars::schema_for!(OpenPluginWindowView),
        ),
        ("context-search", schemars::schema_for!(ContextSearch)),
        ("context-page", schemars::schema_for!(ContextPage)),
        ("preview-context", schemars::schema_for!(PreviewContext)),
        ("context-preview", schemars::schema_for!(ContextPreview)),
        ("document-draft", schemars::schema_for!(DocumentDraft)),
        (
            "list-document-drafts",
            schemars::schema_for!(ListDocumentDrafts),
        ),
        (
            "document-draft-page",
            schemars::schema_for!(DocumentDraftPage),
        ),
        (
            "save-document-draft",
            schemars::schema_for!(SaveDocumentDraft),
        ),
        (
            "resource-transfer-request",
            schemars::schema_for!(ResourceTransferRequest),
        ),
        (
            "resource-transfer-response",
            schemars::schema_for!(ResourceTransferResponse),
        ),
        ("scenario", schemars::schema_for!(ScenarioRevision)),
        ("save-scenario", schemars::schema_for!(SaveScenario)),
        ("list-scenarios", schemars::schema_for!(ListScenarios)),
        ("scenario-page", schemars::schema_for!(ScenarioPage)),
        ("scenario-revision-arguments", schemars::schema_for!(ScenarioRevisionArguments)),
        ("visual-document", schemars::schema_for!(VisualDocument)),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
