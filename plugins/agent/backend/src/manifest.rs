use crate::{arguments::*, native_arguments::*};
use rho_agent_api::{
    AgentCommandReceipt, AgentNativeHistoryPage, AgentNativeToolReceipt, AgentResourceAssetUpload,
    AgentTaskCommandResult, AgentTaskDetail, AgentTaskEventPage, ComponentCredentialRef,
    ComponentCredentialStatus, ComponentModelSettings, ProjectAgentTaskPage,
    component::{
        ComponentAgentConversation, ComponentAgentEventPage, ComponentAgentRun,
        ComponentModelDiagnostic, ComponentToolReceipt,
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
        "agent.native.command"
            | "agent.native.discover"
            | "agent.model.create"
            | "agent.model.draft"
            | "agent.model.update"
            | "agent.model.take_control"
            | "agent.model.configure"
            | "agent.model.test"
            | "agent.model.test.stop"
            | "agent.model.run"
            | "agent.model.run.stop"
            | "agent.model.run.reconcile"
    )
}
pub fn kind(id: &str) -> CapabilityKind {
    if matches!(
        id,
        "agent.model.key.store"
            | "agent.model.key.remove"
            | "agent.native.assets.upload"
            | "agent.native.assets.import"
            | "agent.native.assets.stage"
            | "agent.native.assets.finish"
    ) {
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
        description: if id == "agent.native.discover" {
            "Explicitly inspect one installed native Agent and its model catalog in this instance's project. May start and close a bounded discovery CLI; does not install software, start a model turn or change an existing task. Opening a view and reading tasks do not perform discovery. Repeated original Operations only observe their original result."
        } else if id == "agent.native.command" {
            "Admit a native Agent command with the original caller and task generation. Send may select exact ordinary-plugin query/Operation tools under existing grants; immutable manifests supply their contracts. Selected contributed text is revalidated through its declared preview query and retained with this Send before dispatch. Changed, truncated, unsupported-resource or over-budget context preserves the draft. Retains the original parent until the native turn and accepted scientific children settle. Identical requests only observe original receipts and context, never reread sources. Tool retries require the same Send and semantic request identity. Does not install an Agent. Attachment bytes are excluded."
        } else if id == "agent.native.context" {
            "Read the exact contributed text and source identities captured for an original Send. Does not reread current source content, reconnect a native Agent or repeat a turn."
        } else if id == "agent.native.assets.stage" {
            "Stage bounded browser file chunks in transient instance memory under an exact task controller and original transfer identity. Identical chunks are idempotent; changed bytes, controllers and quotas are rejected. Does not create an asset, start an Agent or journal bytes. Incomplete data may expire; reselect the original file to continue."
        } else if id == "agent.native.assets.finish" {
            "Verify the complete staged file up to 8 MiB and admit its original attachment request through the native task owner. Does not start an Agent or select the asset into a draft. Inspect agent.native.receipt after a lost reply; incomplete staging can be reselected with the same identity. Bytes never enter the Operation journal."
        } else if id == "agent.native.assets.import" {
            "Import an exact controlled resource up to 8 MiB into a native task under its current controller. Reads bounded granted chunks and verifies the complete digest before admission. Retains the original resource identity atomically with its receipt; retries only observe that receipt without reading or importing again. Does not start an Agent or journal attachment bytes."
        } else if id == "agent.native.assets.upload" {
            "Store a bounded native task attachment through ephemeral input, the same task owner and runtime, without journaling its bytes or starting a native Agent. Inspect its original task receipt after a lost reply. This capability currently accepts only bounded single-message attachments."
        } else if id == "agent.model.run" {
            "Run the submitted text and explicit contributed sources using captured model settings, an available scoped key and the original native controller. Source previews are checked before admission; complete text, provenance and bounded ordinary conversation history are committed with the run. Historical input does not inherit tool authority. Admission atomically consumes only a matching saved draft; failed source capture or missing credentials preserve it. Retains the native Operation until the model and dispatched native tools settle and records text and usage in its original task. An optional exact R binding permits bounded observation in Explain and execution only in Run, subject to original scopes and granted native capabilities. Attachments and continuation are not yet composed. Identical original requests only observe the existing run and captured sources without rereading providers, preserving later drafts."
        } else if id == "agent.model.history" {
            "Read up to 20 original run summaries in one scoped task using an exact run cursor. Lost model loops are observed as interrupted without changing their stored state, recovering a process or replaying a request."
        } else if id == "agent.model.run.stop" {
            "Request stopping the original model task under its current controller. Dispatched native work remains retained after the model loop ends; a stop request does not cancel or roll back scientific execution."
        } else if id == "agent.model.run.reconcile" {
            "Explicitly inspect the original tools of a terminal model run and retain a recovery report under the current controller and exact conversation version. Delegated Operations are checked through their original parent and native records; missing or incomplete observations remain uncertain. Refuses a still-live model/native wait. Does not start a model, repeat a tool, resume a provider, cancel work or treat a missing reply as proof of no effect."
        } else if id == "agent.model.test" {
            "Explicitly run a bounded synthetic model test with the captured settings and scoped key. Retains the original Operation until completion; it has no project context or scientific tools. Repeated original requests only observe their retained diagnostic."
        } else if id == "agent.model.test.stop" {
            "Request that the original live model diagnostic stop, using its native controller and expected version. The original Operation remains active until the model test settles."
        } else if id == "agent.model.key.remove" {
            "Remove only the currently configured local key at the exact settings version. Does not change settings, cancel accepted work or remove environment credentials. Repeated removal is idempotent; changed settings refuse the original removal."
        } else if id == "agent.model.key.status" {
            "Observe the currently configured credential at the exact settings version, without returning secret bytes, creating a credential file or contacting a model. Storage errors remain unavailable observations."
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
        required_scopes: if id == "agent.native.assets.import" { ["application.control".into(), "plugins.read".into(), "resources.read".into()].into() } else if operation || control { ["application.control".into(), "plugins.read".into()].into() } else if matches!(id, "agent.model.tool.operation" | "agent.native.tool.operation") { ["application.read".into(), "operation.read".into()].into() } else { ["application.read".into()].into() },
        effects: if id == "agent.native.discover" { ["agent.native.discovery".into()].into() } else if id == "agent.native.command" { ["agent.native.command".into()].into() } else if matches!(id, "agent.native.assets.upload" | "agent.native.assets.import" | "agent.native.assets.stage" | "agent.native.assets.finish") { ["agent.assets".into()].into() } else if id == "agent.model.run" { ["agent.model.run".into()].into() } else if id == "agent.model.test" { ["agent.model.test".into()].into() } else if control { ["agent.credentials".into()].into() } else if operation { ["agent.metadata".into()].into() } else { Default::default() },
        cancellation: CancellationSupport::Unsupported, preflight: None,
    }
}
pub fn manifest() -> PluginManifest {
    let conversation = schema_for!(ComponentAgentConversation).to_value();
    let mut manifest = PluginManifest {
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
                PackagePath::new("build-ui.mjs").unwrap(),
                PackagePath::new("index.html").unwrap(),
                PackagePath::new("src/main.ts").unwrap(),
            ]
            .into(),
            lockfiles: [
                PackagePath::new("Cargo.lock").unwrap(),
                PackagePath::new("dependencies.lock").unwrap(),
            ]
            .into(),
            build_instructions: PackagePath::new("BUILD.md").unwrap(),
            build: Some(BuildRecipe {
                command: vec!["node".into(), "build.mjs".into()],
            }),
        },
        dependencies: Default::default(),
        requires: ["views.caller", "views.presence"]
            .into_iter()
            .map(|id| CapabilityRequirement {
                capability: key(id),
                scopes: ["plugins.read".into()].into(),
            })
            .collect(),
        optional_requires: {
            let mut grants = crate::native_grants::scientific_requirements();
            grants.extend(crate::native_core_grants::requirements());
            grants.extend([
                CapabilityRequirement {
                    capability: key("resources.read"),
                    scopes: ["resources.read".into()].into(),
                },
                CapabilityRequirement {
                    capability: key("plugins.inspect"),
                    scopes: ["plugins.read".into()].into(),
                },
                CapabilityRequirement {
                    capability: key("operation.get"),
                    scopes: ["operation.read".into()].into(),
                },
                CapabilityRequirement {
                    capability: key("plugins.delegated_operation"),
                    scopes: ["operation.read".into()].into(),
                },
            ]);
            grants
        },
        capabilities: vec![
            capability(
                "agent.native.assets.stage",
                "Stage a browser attachment chunk",
                schema_for!(crate::native_uploads::Chunk).to_value(),
                schema_for!(crate::native_uploads::Progress).to_value(),
                json!({"upload":{"request_id":"11111111-1111-4111-8111-111111111111","control":{"task_id":"task-example","generation":1},"name":"empty.txt","mime_type":"text/plain","bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},"offset":0,"data":""}),
            ),
            capability(
                "agent.native.assets.finish",
                "Finish the original browser attachment",
                schema_for!(crate::native_uploads::Finish).to_value(),
                schema_for!(AgentTaskCommandResult).to_value(),
                json!({"upload":{"request_id":"11111111-1111-4111-8111-111111111111","control":{"task_id":"task-example","generation":1},"name":"empty.txt","mime_type":"text/plain","bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}}),
            ),
            capability(
                "agent.native.discover",
                "Inspect an installed native Agent",
                schema_for!(DiscoverNative).to_value(),
                schema_for!(rho_agent_api::LocalAgent).to_value(),
                json!({"provider":"kimi","model":null}),
            ),
            capability(
                "agent.native.tool",
                "Read an original native tool receipt",
                schema_for!(NativeToolReceipt).to_value(),
                schema_for!(AgentNativeToolReceipt).to_value(),
                json!({"send_request":"11111111-1111-4111-8111-111111111111","tool_request":"22222222-2222-4222-8222-222222222222"}),
            ),
            capability(
                "agent.native.tool.operation",
                "Inspect an original native Operation",
                schema_for!(NativeToolReceipt).to_value(),
                json!({"type":"object"}),
                json!({"send_request":"11111111-1111-4111-8111-111111111111","tool_request":"22222222-2222-4222-8222-222222222222"}),
            ),
            capability(
                "agent.native.command",
                "Change a native Agent task",
                schema_for!(NativeAction).to_value(),
                schema_for!(AgentTaskCommandResult).to_value(),
                json!({"request_id":"11111111-1111-4111-8111-111111111111","command":{"kind":"create","provider":"kimi","model":"selected-native-model","effort":null}}),
            ),
            capability(
                "agent.native.task",
                "Read a native Agent task",
                schema_for!(NativeTask).to_value(),
                schema_for!(AgentTaskDetail).to_value(),
                json!({"task_id":"task-example"}),
            ),
            capability(
                "agent.native.receipt",
                "Read an original native task receipt",
                schema_for!(NativeReceipt).to_value(),
                schema_for!(AgentCommandReceipt).to_value(),
                json!({"request_id":"11111111-1111-4111-8111-111111111111"}),
            ),
            capability(
                "agent.native.events",
                "Read retained native task events",
                schema_for!(NativeEvents).to_value(),
                schema_for!(AgentTaskEventPage).to_value(),
                json!({"task_id":"task-example","after":0,"before":null,"limit":50}),
            ),
            capability(
                "agent.native.context",
                "Read an original Send's captured context",
                schema_for!(NativeReceipt).to_value(),
                json!({"type":"object","additionalProperties":false,"properties":{
                    "request_id":{"type":"string"},"task_id":{"type":"string"},
                    "contexts":{"type":"array","maxItems":20,"items":{"type":"object","additionalProperties":false,"properties":{
                        "selection":schema_for!(AgentContextSelection).to_value(),"title":{"type":"string","maxLength":1024},
                        "description":{"type":"string","maxLength":4096},"text":{"type":"string","maxLength":16384},"data":{}
                    },"required":["selection","title","description","text","data"]}}
                },"required":["request_id","task_id","contexts"]}),
                json!({"request_id":"11111111-1111-4111-8111-111111111111"}),
            ),
            capability(
                "agent.native.history",
                "Read live native history without reconnecting",
                schema_for!(NativeHistory).to_value(),
                schema_for!(AgentNativeHistoryPage).to_value(),
                json!({"task_id":"task-example","cursor":null,"limit":50}),
            ),
            capability(
                "agent.native.assets.import",
                "Import a controlled resource as a native task attachment",
                schema_for!(AgentResourceAssetUpload).to_value(),
                schema_for!(AgentTaskCommandResult).to_value(),
                json!({"request_id":"11111111-1111-4111-8111-111111111111","control":{"task_id":"task-example","generation":1},"name":"notes.txt","reference":{"owner":{"plugin":"org.example.files","instance":"files-one","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},"resource":"notes-resource","digest":format!("sha256:{}","c".repeat(64)),"media_type":"text/plain","bytes":5}}),
            ),
            capability(
                "agent.native.assets.upload",
                "Store a native task attachment",
                schema_for!(NativeUpload).to_value(),
                schema_for!(AgentTaskCommandResult).to_value(),
                json!({"request_id":"11111111-1111-4111-8111-111111111111","control":{"task_id":"task-example","generation":1},"name":"notes.txt","mime_type":"text/plain","data":"Tm90ZXM="}),
            ),
            capability(
                "agent.model.run.admission",
                "Read the original native model admission",
                schema_for!(ModelRun).to_value(),
                schema_for!(ModelAdmission).to_value(),
                json!({"run_id":"run-example"}),
            ),
            capability(
                "agent.model.run.tools",
                "Read original model tool receipts",
                schema_for!(ModelRun).to_value(),
                schema_for!(Vec<ComponentToolReceipt>).to_value(),
                json!({"run_id":"run-example"}),
            ),
            capability(
                "agent.model.tool.operation",
                "Observe an original delegated tool Operation",
                schema_for!(ModelTool).to_value(),
                json!({"type":"object","additionalProperties":false,"properties":{
                    "run_id":{"type":"string"},"receipt_id":{"type":"string"},"completeness":{"enum":["complete","partial"]},
                    "request":{"type":"string"},"operation":{"type":["object","null"]}},
                    "required":["run_id","receipt_id","completeness","request","operation"]}),
                json!({"run_id":"run-example","receipt_id":"tool-example"}),
            ),
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
                "agent.model.history",
                "Read a model task's original run history",
                schema_for!(ModelHistory).to_value(),
                schema_for!(ModelHistoryPage).to_value(),
                json!({"conversation_id":"task-example","before":null,"limit":20}),
            ),
            capability(
                "agent.model.run.reconcile",
                "Inspect original model tool outcomes",
                schema_for!(ModelReconcile).to_value(),
                schema_for!(ComponentAgentRun).to_value(),
                json!({"run_id":"run-example","conversation_version":3}),
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
                "agent.model.key.status",
                "Read configured model key availability",
                schema_for!(CredentialStatus).to_value(),
                schema_for!(ComponentCredentialStatus).to_value(),
                json!({"settings_version":1}),
            ),
            capability(
                "agent.model.key.remove",
                "Remove the configured local model key",
                schema_for!(RemoveCredential).to_value(),
                schema_for!(ComponentCredentialStatus).to_value(),
                json!({"settings_version":1,"key_id":"key-example"}),
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
        views: vec![ViewContribution {
            id: ContributionId::new("agent").unwrap(),
            title: "Agent".into(),
            entrypoint: PackagePath::new("dist/ui/index.html").unwrap(),
            state_schema: json!({"type":"object"}),
            configuration_schema: schema_for!(AgentViewConfiguration).to_value(),
            resource_kinds: Default::default(),
        }],
        contexts: vec![],
        backend: Some(BackendEntrypoint {
            executable: PackagePath::new("dist/rho-agent-backend").unwrap(),
            arguments: vec![],
        }),
        configuration_schema: schema_for!(Empty).to_value(),
        default_configuration: json!({}),
    };
    // Combined UI/backend packages use the same declared calls as any external
    // view. These grants expose only this Agent's ordinary task capabilities.
    for id in [
        "agent.tasks",
        "agent.native.command",
        "agent.native.discover",
        "agent.native.task",
        "agent.native.receipt",
        "agent.native.context",
        "agent.native.events",
        "agent.native.history",
        "agent.native.assets.stage",
        "agent.native.assets.finish",
        "agent.model.settings",
        "agent.model.configure",
        "agent.model.key.store",
        "agent.model.key.receipt",
        "agent.model.key.status",
        "agent.model.key.remove",
        "agent.model.test",
        "agent.model.test.stop",
        "agent.model.diagnostic",
        "agent.model.create",
        "agent.model.conversation",
        "agent.model.draft",
        "agent.model.update",
        "agent.model.take_control",
        "agent.model.history",
        "agent.model.run",
        "agent.model.run.get",
        "agent.model.run.request",
        "agent.model.run.stop",
        "agent.model.run.reconcile",
        "agent.model.run.events",
        "agent.model.run.tools",
        "agent.model.tool.operation",
    ] {
        let own = manifest
            .capabilities
            .iter()
            .find(|c| c.capability.id.as_str() == id)
            .unwrap();
        manifest.requires.push(CapabilityRequirement {
            capability: own.capability.clone(),
            scopes: own.required_scopes.clone(),
        });
    }
    manifest.requires.push(CapabilityRequirement {
        capability: key("operation.list_recent"),
        scopes: ["operation.read".into()].into(),
    });
    manifest
}
