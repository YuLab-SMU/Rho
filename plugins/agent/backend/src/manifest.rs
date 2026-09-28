use crate::arguments::*;
use rho_agent_api::{
    ComponentCredentialRef, ComponentCredentialStatus, ComponentModelSettings,
    ProjectAgentTaskPage,
    component::{
        ComponentAgentConversation, ComponentAgentEventPage, ComponentAgentRun,
        ComponentModelDiagnostic,
    },
};
use rho_plugin_sdk::protocol::*;
use schemars::schema_for;
use serde_json::{Value, json};

pub fn key(id: &str) -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new(id).unwrap(),
        version: 1,
    }
}
pub fn is_mutation(id: &str) -> bool {
    matches!(
        id,
        "agent.model.create"
            | "agent.model.draft"
            | "agent.model.update"
            | "agent.model.take_control"
            | "agent.model.configure"
            | "agent.model.test"
            | "agent.model.test.stop"
            | "agent.model.run"
            | "agent.model.run.stop"
    )
}
pub fn kind(id: &str) -> CapabilityKind {
    if id == "agent.model.key.store" {
        CapabilityKind::Control
    } else if is_mutation(id) {
        CapabilityKind::Operation
    } else {
        CapabilityKind::Query
    }
}
fn capability(
    id: &str,
    title: &str,
    input: Value,
    output: Value,
    example: Value,
) -> CapabilityContribution {
    let operation = is_mutation(id);
    let kind = kind(id);
    let control = kind == CapabilityKind::Control;
    CapabilityContribution {
        capability: key(id), kind,
        title: title.into(),
        description: if id == "agent.model.run" {
            "Run the submitted text using captured model settings and the original native controller. Retains the native Operation until the model ends and records text and usage in its original task. This composition has no scientific context, native tools or attachments. Identical original requests only observe the existing run."
        } else if id == "agent.model.run.stop" {
            "Request stopping the original model task under its current controller. Original execution remains retained until the model loop ends; a stop request is not proof of completion."
        } else if id == "agent.model.test" {
            "Explicitly run a bounded synthetic model test with the captured settings and scoped key. Retains the original Operation until completion; it has no project context or scientific tools. Repeated original requests only observe their retained diagnostic."
        } else if id == "agent.model.test.stop" {
            "Request that the original live model diagnostic stop, using its native controller and expected version. The original Operation remains active until the model test settles."
        } else if control {
            "Save a scoped model key through ephemeral input with an atomic original-request reference. Does not create an Operation, configure a model or start work; inspect the original receipt after a lost reply."
        } else if id == "agent.model.key.receipt" {
            "Read the original scoped key reference and availability without secret bytes. An absent receipt is an incomplete observation, never proof that a pending write cannot finish."
        } else if operation {
            "Change Agent-owned task metadata using the original native caller and expected task version. Does not start a model, execute scientific work or grant tools."
        } else {
            "Read scoped Agent-owned metadata without starting a model, reconnecting a native Agent or recovering work."
        }.into(),
        input_schema: input, output_schema: output, examples: vec![example],
        recovery_schema: json!({"type":"object","additionalProperties":false,"properties":{"code":{"type":"string"}},"required":["code"]}),
        required_scopes: if operation || control { ["application.control".into(), "plugins.read".into()].into() } else { ["application.read".into()].into() },
        effects: if id == "agent.model.run" { ["agent.model.run".into()].into() } else if id == "agent.model.test" { ["agent.model.test".into()].into() } else if control { ["agent.credentials".into()].into() } else if operation { ["agent.metadata".into()].into() } else { Default::default() },
        cancellation: CancellationSupport::Unsupported, preflight: None,
    }
}
pub fn manifest() -> PluginManifest {
    let conversation = schema_for!(ComponentAgentConversation).to_value();
    PluginManifest {
        protocol_version: PLUGIN_PROTOCOL_VERSION,
        id: PluginId::new("org.rho.agent").unwrap(),
        name: "Agent".into(),
        version: "0.1.0".into(),
        description: "Agent tasks, explicit model execution, scoped settings and diagnostics"
            .into(),
        license: "AGPL-3.0-only".into(),
        source: SourceDeclaration {
            files: [
                PackagePath::new("backend/src/main.rs").unwrap(),
                PackagePath::new("build.mjs").unwrap(),
            ]
            .into(),
            lockfiles: [PackagePath::new("Cargo.lock").unwrap()].into(),
            build_instructions: PackagePath::new("BUILD.md").unwrap(),
            build: Some(BuildRecipe {
                command: vec!["node".into(), "build.mjs".into()],
            }),
        },
        dependencies: Default::default(),
        requires: vec![CapabilityRequirement {
            capability: key("views.caller"),
            scopes: ["plugins.read".into()].into(),
        }],
        optional_requires: vec![],
        capabilities: vec![
            capability(
                "agent.model.run",
                "Run a model task",
                schema_for!(RunModel).to_value(),
                schema_for!(ComponentAgentRun).to_value(),
                json!({"request_id":"model-run-example","conversation_id":"task-example","conversation_version":1,"model_settings_version":1,"text":"Explain this analysis approach"}),
            ),
            capability(
                "agent.model.run.stop",
                "Stop an original model task",
                schema_for!(ModelRun).to_value(),
                schema_for!(ComponentAgentRun).to_value(),
                json!({"run_id":"run-example"}),
            ),
            capability(
                "agent.model.run.get",
                "Read an original model task run",
                schema_for!(ModelRun).to_value(),
                schema_for!(ComponentAgentRun).to_value(),
                json!({"run_id":"run-example"}),
            ),
            capability(
                "agent.model.run.request",
                "Find a model task by its original request",
                schema_for!(CredentialRequest).to_value(),
                schema_for!(ComponentAgentRun).to_value(),
                json!({"request_id":"model-run-example"}),
            ),
            capability(
                "agent.model.run.events",
                "Read original model task events",
                schema_for!(ModelEvents).to_value(),
                schema_for!(ComponentAgentEventPage).to_value(),
                json!({"run_id":"run-example","after":0,"limit":50}),
            ),
            capability(
                "agent.model.test",
                "Test the configured model",
                schema_for!(TestModel).to_value(),
                schema_for!(ComponentModelDiagnostic).to_value(),
                json!({"request_id":"model-test-example","model_settings_version":1,"kind":"connection"}),
            ),
            capability(
                "agent.model.test.stop",
                "Stop a model test",
                schema_for!(StopModelDiagnostic).to_value(),
                schema_for!(ComponentModelDiagnostic).to_value(),
                json!({"request_id":"model-test-example","expected_version":2}),
            ),
            capability(
                "agent.model.diagnostic",
                "Read an original model diagnostic",
                schema_for!(ModelDiagnostic).to_value(),
                schema_for!(ComponentModelDiagnostic).to_value(),
                json!({"request_id":"model-test-example"}),
            ),
            capability(
                "agent.model.key.store",
                "Save a model key",
                schema_for!(StoreCredential).to_value(),
                schema_for!(ComponentCredentialRef).to_value(),
                json!({"request_id":"key-request-example","value":"example-key-placeholder"}),
            ),
            capability(
                "agent.model.key.receipt",
                "Read an original model key receipt",
                schema_for!(CredentialRequest).to_value(),
                schema_for!(ComponentCredentialStatus).to_value(),
                json!({"request_id":"key-request-example"}),
            ),
            capability(
                "agent.tasks",
                "Read Agent tasks",
                schema_for!(TaskList).to_value(),
                schema_for!(ProjectAgentTaskPage).to_value(),
                json!({"archived":false,"before":null,"limit":20}),
            ),
            capability(
                "agent.model.conversation",
                "Read a model task",
                schema_for!(Conversation).to_value(),
                conversation.clone(),
                json!({"conversation_id":"task-example"}),
            ),
            capability(
                "agent.model.settings",
                "Read Agent model settings",
                schema_for!(Empty).to_value(),
                schema_for!(ComponentModelSettings).to_value(),
                json!({}),
            ),
            capability(
                "agent.model.create",
                "Create a model task",
                schema_for!(CreateConversation).to_value(),
                conversation.clone(),
                json!({"conversation_id":"task-example","profile":"project"}),
            ),
            capability(
                "agent.model.configure",
                "Save Agent model settings",
                schema_for!(ComponentModelSettings).to_value(),
                schema_for!(ComponentModelSettings).to_value(),
                json!({"version":0,"enabled":false,"connection":null}),
            ),
            capability(
                "agent.model.draft",
                "Save a model task draft",
                schema_for!(SaveDraft).to_value(),
                conversation.clone(),
                json!({"conversation_id":"task-example","draft_version":1,"content":{"text":"Review the selected source","context":[],"assets":[]},"grant":null}),
            ),
            capability(
                "agent.model.update",
                "Update task title or archive state",
                schema_for!(UpdateConversation).to_value(),
                conversation.clone(),
                json!({"conversation_id":"task-example","expected_version":1,"title":"Source review","archived":null}),
            ),
            capability(
                "agent.model.take_control",
                "Take control of a model task",
                schema_for!(TakeControl).to_value(),
                conversation,
                json!({"conversation_id":"task-example","expected_version":1}),
            ),
        ],
        views: vec![],
        contexts: vec![],
        backend: Some(BackendEntrypoint {
            executable: PackagePath::new("dist/rho-agent-backend").unwrap(),
            arguments: vec![],
        }),
        configuration_schema: schema_for!(Empty).to_value(),
        default_configuration: json!({}),
    }
}
