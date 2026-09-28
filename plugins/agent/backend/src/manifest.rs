use crate::arguments::*;
use rho_agent_api::{ComponentAgentConversation, ComponentModelSettings, ProjectAgentTaskPage};
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
    )
}
fn capability(
    id: &str,
    title: &str,
    input: Value,
    output: Value,
    example: Value,
) -> CapabilityContribution {
    let operation = is_mutation(id);
    CapabilityContribution {
        capability: key(id), kind: if operation { CapabilityKind::Operation } else { CapabilityKind::Query },
        title: title.into(),
        description: if operation {
            "Change Agent-owned task metadata using the original native caller and expected task version. Does not start a model, execute scientific work or grant tools."
        } else {
            "Read scoped Agent-owned metadata without starting a model, reconnecting a native Agent or recovering work."
        }.into(),
        input_schema: input, output_schema: output, examples: vec![example],
        recovery_schema: json!({"type":"object","additionalProperties":false,"properties":{"code":{"type":"string"}},"required":["code"]}),
        required_scopes: if operation { ["application.control".into(), "plugins.read".into()].into() } else { ["application.read".into()].into() },
        effects: if operation { ["agent.metadata".into()].into() } else { Default::default() },
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
        description: "Scoped Agent task metadata and original-controller drafts".into(),
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
