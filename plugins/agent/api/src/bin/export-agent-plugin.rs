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
        ComponentAgentProfile, ComponentPermissionPolicy, ComponentTaskAuthorization,
        ComponentRequestedAction, ComponentIntentAction, ComponentAgentTaskIntent,
        ComponentModelProtocol, ComponentCredentialRef, ComponentModelConnection,
        ComponentModelSettings, ComponentAgentBudget, ComponentCredentialStatus,
        ComponentModelTestKind, ComponentModelTestState, AgentModelRun, ComponentToolSpec,
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
        AgentUsageObservation,
        AgentTask,
        AgentAttachment,
        AgentContextSelection,
        AgentContextSource,
        AgentContextItem,
        AgentContextPreview,
        AgentAsset,
        AgentDraftContent,
        AgentTaskDraft,
        AgentCommandReceipt,
        AgentTaskEvent,
        AgentTaskSummary,
        AgentTaskDetail,
        AgentTaskEventPage,
        AgentNativeHistoryPage,
        AgentTaskControl,
        AgentTaskCommand,
        AgentTaskCommandResult,
        AgentDiagnostic,
        ReadAgentAsset,
        AgentTaskRequest,
        ProjectAgentTaskRef,
        ProjectAgentTaskSummary,
        ProjectAgentTaskPage
    );
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        ("model-run", schemars::schema_for!(AgentModelRun)),
        ("model-settings", schemars::schema_for!(ComponentModelSettings)),
        ("task-request", schemars::schema_for!(AgentTaskRequest)),
        ("task-detail", schemars::schema_for!(AgentTaskDetail)),
        ("task-events", schemars::schema_for!(AgentTaskEventPage)),
        ("project-tasks", schemars::schema_for!(ProjectAgentTaskPage)),
        ("context", schemars::schema_for!(AgentContextPreview)),
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
