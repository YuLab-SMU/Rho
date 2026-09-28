use crate::{service::*, *};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_contract as host;
use rho_operation::*;
use rho_plugin_protocol::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, OperationError> {
    serde_json::from_value(value.clone()).map_err(invalid)
}
fn normalize<T: DeserializeOwned + Serialize>(value: &Value) -> Result<Value, OperationError> {
    serde_json::to_value(decode::<T>(value)?).map_err(invalid)
}
fn scenario_error(error_value: PluginError) -> OperationError {
    match error_value {
        PluginError::Conflict => OperationError::ContentChanged("scenario head changed".into()),
        PluginError::Missing(id) => OperationError::NotFound(id),
        PluginError::Invalid(message) => invalid(message),
        PluginError::Contract(message) => invalid(message),
        other => error(other),
    }
}
fn source_error(value: PluginError) -> OperationError {
    match value {
        PluginError::Conflict => OperationError::ContentChanged("plugin branch head changed".into()),
        PluginError::Missing(id) => OperationError::NotFound(id),
        PluginError::Invalid(message) => invalid(message),
        PluginError::Contract(message) => invalid(message),
        PluginError::Json(message) => invalid(message),
        other => error(other),
    }
}
fn key(id: &str) -> host::CapabilityRef {
    host::CapabilityRef::new(id, 1).unwrap()
}
fn item(value: InstalledPluginRevision) -> PluginCatalogItem {
    PluginCatalogItem {
        revision: value.revision,
        plugin: value.plugin,
        name: value.name,
        version: value.version,
        description: value.description,
        artifacts: value.artifacts,
        reference_count: value.references.len() as u64,
    }
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Reconcile {
    operation_id: host::OperationId,
}

pub(crate) fn register(
    service: &Arc<PluginService>,
    registry: &mut CapabilityRegistry,
) -> Result<(), OperationError> {
    for id in [
        "workspace.paths",
        "resources.list",
        "resources.inspect",
        "resources.read",
        "views.inspect",
        "views.caller",
        "views.connection",
        "windows.layout",
        "scenarios.list",
        "scenarios.get",
        "scenarios.prepare",
        "windows.scenario",
        "windows.resolve",
        "plugins.repository",
        "plugins.delegated_operation",
        "plugins.list",
        "plugins.inspect",
        "plugins.instances",
        "plugins.project_coverage",
        "plugins.instance",
        "plugins.resolve",
        "plugins.source_tree",
        "plugins.read_source",
        "plugins.branches",
        "plugins.check_source",
        "plugins.branch_head",
        "plugins.compare",
    ] {
        registry.register_query(Arc::new(Read {
            service: service.clone(),
            descriptor: descriptor(id),
            id,
        }))?;
    }
    for id in [
        "views.open",
        "views.update",
        "views.close",
        "windows.update_layout",
        "windows.open_view",
        "scenarios.checkpoint",
        "scenarios.apply",
        "plugins.activate",
        "plugins.preview",
        "plugins.release",
        "plugins.remove",
        "plugins.branch",
        "plugins.advance_branch",
        "plugins.checkpoint",
        "plugins.reconcile_references",
    ] {
        registry.register(Arc::new(Manage {
            service: service.clone(),
            descriptor: descriptor(id),
            id,
            bound: None,
        }))?;
    }
    Ok(())
}
fn descriptor(id: &str) -> host::CapabilityDescriptor {
    let (input, output, example, summary, operation, scope) = match id {
        "plugins.delegated_operation" => (
            schema_for!(PluginDelegatedOperationArguments).to_value(), schema_for!(PluginDelegatedOperation).to_value(),
            json!({"parent_operation":"operation-example","request":"original-reverse-request"}),
            "Find the original backend-delegated Operation without replaying it", false, "operation.read",
        ),
        "plugins.preview" => (
            schema_for!(PreviewPlugin).to_value(), schema_for!(PluginInstanceObservation).to_value(),
            json!({"revision":digest(),"artifact":digest(),"alias":"preview","configuration":{},"queries":[]}),
            "Create an isolated fixture presentation instance without starting a backend or granting Host capabilities", true, PLUGINS_RUN_SCOPE,
        ),
        "scenarios.prepare" | "scenarios.apply" => (
            schema_for!(ApplyScenario).to_value(), schema_for!(WindowScenarioSnapshot).to_value(),
            json!({"window":"window-example","revision":digest(),"expected_layout_version":0,"instances":{},"views":{}}),
            "Validate or atomically select an exact prepared scenario in one window", id == "scenarios.apply", PLUGINS_RUN_SCOPE,
        ),
        "windows.scenario" => (
            schema_for!(PluginWindowArguments).to_value(), schema_for!(WindowScenarioSnapshot).to_value(),
            json!({"window":"window-example"}), "Observe a window's scenario and current layout together", false, PLUGINS_RUN_SCOPE,
        ),
        "windows.resolve" => (
            schema_for!(ResolveWindowProvider).to_value(), schema_for!(ProviderBinding).to_value(),
            json!({"window":"window-example","capability":{"id":"example.read","version":1}}),
            "Resolve this window's selected exact provider without fallback", false, PLUGINS_RUN_SCOPE,
        ),
        "scenarios.list" => (
            schema_for!(ListScenarios).to_value(), schema_for!(ScenarioPage).to_value(),
            json!({"after":null,"limit":20}), "List the caller's named project scenarios", false, PLUGINS_READ_SCOPE,
        ),
        "scenarios.get" => (
            schema_for!(ScenarioRevisionArguments).to_value(), schema_for!(ScenarioRevision).to_value(),
            json!({"revision":digest()}), "Read an exact retained scenario checkpoint", false, PLUGINS_READ_SCOPE,
        ),
        "scenarios.checkpoint" => (
            schema_for!(SaveScenario).to_value(), schema_for!(ScenarioRevision).to_value(),
            json!({"scenario":"analysis","expected_head":null,"name":"Analysis","instances":{},"providers":[],"layout":{"kind":"empty"}}),
            "Create a scenario checkpoint and advance its expected head atomically", true, PLUGINS_WRITE_SCOPE,
        ),
        "workspace.paths" => (
            schema_for!(Empty).to_value(), schema_for!(WorkspacePaths).to_value(),
            json!({}), "Read Host-owned project and protected path boundaries", false, "project.read",
        ),
        "windows.layout" => (
            schema_for!(PluginWindowArguments).to_value(), schema_for!(PluginWindowLayout).to_value(),
            json!({"window":"window-example"}), "Read one window's retained plugin layout without opening views", false, PLUGINS_RUN_SCOPE,
        ),
        "windows.open_view" => (
            schema_for!(OpenPluginWindowView).to_value(), schema_for!(OpenedPluginWindowView).to_value(),
            json!({"view":{"instance":instance(),"contribution":"inspector","window":"window-example","configuration":{},"state":{}},"expected_layout_version":0,"group":null}),
            "Create and select an exact plugin view in a window atomically", true, PLUGINS_RUN_SCOPE,
        ),
        "windows.update_layout" => (
            schema_for!(UpdatePluginWindowLayout).to_value(), schema_for!(PluginWindowLayout).to_value(),
            json!({"window":"window-example","expected_version":0,"layout":{"kind":"empty"}}),
            "Save a scoped window layout using its expected version", true, PLUGINS_RUN_SCOPE,
        ),
        "views.caller" => (
            schema_for!(Empty).to_value(), schema_for!(PluginViewCaller).to_value(),
            json!({}), "Observe the original authenticated calling view without its private credentials", false, PLUGINS_READ_SCOPE,
        ),
        "views.inspect" | "views.connection" => (
            schema_for!(PluginViewArguments).to_value(),
            if id == "views.connection" { schema_for!(PluginViewConnection).to_value() } else { schema_for!(PluginViewRecord).to_value() },
            json!({"view":"view-example"}), "Inspect an existing scoped plugin view", false, PLUGINS_RUN_SCOPE,
        ),
        "views.open" => (
            schema_for!(OpenPluginView).to_value(), schema_for!(PluginViewRecord).to_value(),
            json!({"instance":instance(),"contribution":"inspector","window":"window-example","configuration":{},"state":{}}),
            "Open a view of an exact active plugin instance", true, PLUGINS_RUN_SCOPE,
        ),
        "views.update" => (
            schema_for!(UpdatePluginView).to_value(), schema_for!(PluginViewRecord).to_value(),
            json!({"view":"view-example","expected_version":0,"state":{}}),
            "Save view state with its owner's expected version", true, PLUGINS_RUN_SCOPE,
        ),
        "views.close" => (
            schema_for!(ClosePluginView).to_value(), schema_for!(PluginViewRecord).to_value(),
            json!({"view":"view-example"}), "Flush connected documents and close the view without releasing its backend; explicit retained-state recovery requires its acknowledged version", true, PLUGINS_RUN_SCOPE,
        ),
        "resources.list" => (
            schema_for!(ResourceList).to_value(), schema_for!(ResourcePage).to_value(),
            json!({"owner":null,"after":null,"limit":20}),
            "List retained resources within the original project and principal", false, RESOURCES_READ_SCOPE,
        ),
        "resources.inspect" => (
            schema_for!(ResourceInspect).to_value(), schema_for!(ResourceReference).to_value(),
            json!({"reference":{"owner":instance(),"resource":"resource-example","digest":digest(),"media_type":"text/plain","bytes":0}}),
            "Verify retained bytes and exact resource ownership", false, RESOURCES_READ_SCOPE,
        ),
        "resources.read" => (
            schema_for!(ResourceRead).to_value(), schema_for!(ResourceChunk).to_value(),
            json!({"reference":{"owner":instance(),"resource":"resource-example","digest":digest(),"media_type":"text/plain","bytes":0},"offset":0,"limit":65536}),
            "Read a bounded chunk of a retained resource", false, RESOURCES_READ_SCOPE,
        ),
        "plugins.repository" => (
            schema_for!(Empty).to_value(),
            json!({"type":"object","required":["root","project","backend_target"],"properties":{"root":{"type":"string"},"project":{"type":"string"},"backend_target":{"type":"string"}},"additionalProperties":false}),
            json!({}),
            "Inspect this Host's package repository",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.list" => (
            schema_for!(PluginCatalogArguments).to_value(),
            schema_for!(PluginCatalogPage).to_value(),
            json!({"after":null,"limit":20}),
            "List installed immutable plugin revisions",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.inspect" => (
            schema_for!(PluginRevisionArguments).to_value(),
            schema_for!(PluginInspection).to_value(),
            json!({"revision":digest()}),
            "Inspect a plugin's manifest and build artifacts",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.instances" => (
            schema_for!(PluginInstancesArguments).to_value(),
            schema_for!(PluginInstanceObservations).to_value(),
            json!({"after":null,"limit":20}),
            "Observe this principal's project plugin instances",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.project_coverage" => (
            schema_for!(ProjectReadCoverageArguments).to_value(), schema_for!(ProjectReadCoverage).to_value(),
            json!({}), "Check the coverage of visible project plugin instances", false, PLUGINS_READ_SCOPE,
        ),
        "plugins.instance" => (
            schema_for!(PluginInstanceArguments).to_value(),
            schema_for!(PluginInstanceObservation).to_value(),
            json!({"instance":instance()}),
            "Inspect one exact plugin instance and bounded logs",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.resolve" => (
            schema_for!(PluginResolveArguments).to_value(),
            schema_for!(ProviderBinding).to_value(),
            json!({"capability":{"id":"example.read","version":1},"instance":null,"target":null}),
            "Resolve an unambiguous active plugin provider",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.source_tree" => (
            schema_for!(ListPluginSource).to_value(), schema_for!(PluginSourcePage).to_value(),
            json!({"revision":digest(),"after":null,"limit":20}),
            "List immutable source file identities in a bounded page", false, PLUGINS_READ_SCOPE,
        ),
        "plugins.read_source" => (
            schema_for!(ReadPluginSource).to_value(), schema_for!(PluginSourceChunk).to_value(),
            json!({"revision":digest(),"path":"plugin.json","offset":0,"limit":65536}),
            "Read binary-safe source bytes after verifying the complete stored file digest", false, PLUGINS_READ_SCOPE,
        ),
        "plugins.branches" => (
            schema_for!(ListPluginBranches).to_value(), schema_for!(PluginBranchPage).to_value(),
            json!({"plugin":"example.plugin","after":null,"limit":20}),
            "List a plugin's development branches and recorded origins", false, PLUGINS_READ_SCOPE,
        ),
        "plugins.check_source" | "plugins.checkpoint" => (
            schema_for!(CheckpointPlugin).to_value(), schema_for!(PluginCheckpoint).to_value(),
            json!({"branch":"branch-example","expected_head":digest(),"changes":{}}),
            "Validate source edits or atomically save them as a new branch checkpoint", id == "plugins.checkpoint",
            if id == "plugins.checkpoint" { PLUGINS_WRITE_SCOPE } else { PLUGINS_READ_SCOPE },
        ),
        "plugins.branch_head" => (
            schema_for!(PluginBranchArguments).to_value(),
            json!({"type":"object","properties":{"revision":{"type":"string"}},"required":["revision"],"additionalProperties":false}),
            json!({"branch":"branch-example"}),
            "Read a development branch's exact head",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.compare" => (
            schema_for!(ComparePluginRevisions).to_value(),
            schema_for!(RevisionDifference).to_value(),
            json!({"before":digest(),"after":digest()}),
            "Compare immutable source revisions",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.activate" => (
            schema_for!(ActivatePlugin).to_value(),
            schema_for!(PluginInstanceObservation).to_value(),
            json!({"revision":digest(),"artifact":digest(),"target":backend_target(),"alias":"example","configuration":{}}),
            "Activate an exact installed backend artifact",
            true,
            PLUGINS_RUN_SCOPE,
        ),
        "plugins.release" => (
            schema_for!(PluginInstanceArguments).to_value(),
            schema_for!(PluginInstanceObservation).to_value(),
            json!({"instance":instance()}),
            "Drain and release one exact plugin instance",
            true,
            PLUGINS_RUN_SCOPE,
        ),
        "plugins.remove" => (
            schema_for!(PluginRevisionArguments).to_value(),
            json!({"type":"object","properties":{"removed":{"type":"string"}},"required":["removed"],"additionalProperties":false}),
            json!({"revision":digest()}),
            "Remove an unreferenced plugin revision",
            true,
            PLUGINS_WRITE_SCOPE,
        ),
        "plugins.branch" => (
            schema_for!(BranchPlugin).to_value(),
            json!({"type":"object","properties":{"branch":{"type":"string"}},"required":["branch"],"additionalProperties":false}),
            json!({"revision":digest(),"name":"Experiment"}),
            "Branch an immutable plugin revision",
            true,
            PLUGINS_WRITE_SCOPE,
        ),
        "plugins.advance_branch" => (
            schema_for!(AdvancePluginBranch).to_value(),
            json!({"type":"object","properties":{"revision":{"type":"string"}},"required":["revision"],"additionalProperties":false}),
            json!({"branch":"branch-example","expected":digest(),"next":digest()}),
            "Advance a plugin branch by compare-and-swap",
            true,
            PLUGINS_WRITE_SCOPE,
        ),
        "plugins.reconcile_references" => (
            schema_for!(Reconcile).to_value(),
            json!({"type":"object","properties":{"operation_id":{"type":"string"},"reconciled":{"const":true}},"required":["operation_id","reconciled"],"additionalProperties":false}),
            json!({"operation_id":"operation-example"}),
            "Confirm original native settlement and release its operation protections",
            true,
            PLUGINS_RUN_SCOPE,
        ),
        _ => unreachable!(),
    };
    let mut descriptor = host::CapabilityDescriptor {
        kind:if operation {host::CapabilityKind::Operation}else{host::CapabilityKind::Query},capability:key(id),domain:"plugins".into(),input_schema:input,output_schema:output,recovery_schema:json!({"type":["object","null"]}),
        required_scopes:BTreeSet::from([scope.into()]),potential_effects:match id {"plugins.activate"=>BTreeSet::from([host::EffectHint::MaySpawnProcess,host::EffectHint::MayMutateRuntime]),"plugins.preview"|"plugins.release"|"plugins.reconcile_references"=>BTreeSet::from([host::EffectHint::MayMutateRuntime]),_=>BTreeSet::new()},
        idempotency:if operation {host::IdempotencyClass::CallerScoped}else{host::IdempotencyClass::Pure},retry:if operation {host::RetryClass::ReconcileFirst}else{host::RetryClass::Safe},cancellation:host::CancellationClass::Unsupported,
        documentation:host::CapabilityDocumentation {
            summary:summary.into(),purpose:summary.into(),when_to_use:vec!["Manage or observe ordinary installed packages through the shared Host ports.".into()],
            limitations:vec!["Installed source does not activate itself. Revisions, artifacts, project and principal identities remain explicit; no package origin receives special privileges.".into(),"Historical instance state does not establish a live process. Release failure or draining does not confirm cleanup; inspect the exact original instance.".into(),"Native artifacts and build scripts are trusted local code; process isolation is not an OS filesystem/network sandbox.".into()],
            owner:"plugins".into(),effects:if operation {"Only the named package/lifecycle change. Scientific work and its journal remain with the existing Operation gateway.".into()}else{"Read-only bounded observation. Does not start a process, install, reconnect or recover work.".into()},
            retry_rule:if operation {"Retain client_request_id and inspect the original Operation after lost acknowledgement. Do not repeat activation to discover whether it started.".into()}else{"Repeat the same observation; follow explicit page cursors.".into()},
            cancellation_rule:"Disconnect does not undo lifecycle work or confirm process cleanup.".into(),preconditions:vec![],examples:vec![host::CapabilityExample{arguments:example,result_explanation:"Exact immutable identities and native lifecycle observations; no authority is inferred from package content.".into()}],
            related_capabilities:vec![key("plugins.list"),key("plugins.instances")],related_skills:vec![],position_units:vec!["Offsets and byte bounds are bytes, not tokens. Page item limits are 1–100.".into()],
        },
    };
    if matches!(id, "plugins.check_source" | "plugins.checkpoint") {
        descriptor.documentation.limitations.push("At most 128 edits and 128 KiB of decoded inline content per checkpoint; copy can reuse exact retained source, including larger files. Paths, manifest declarations and visual documents must validate. Invalid drafts remain the editor's responsibility.".into());
        descriptor.documentation.effects = if operation { "Atomically store a source-only child and advance the expected branch head. Never reuse parent build artifacts, run a build, activate a provider, apply a scenario or replay scientific effects." } else { "Validate and return the proposed source identity only. The returned revision is not installed by this observation." }.into();
    }
    if id == "workspace.paths" {
        descriptor.domain = "workspace".into();
        descriptor.documentation.owner = "workspace".into();
        descriptor.documentation.when_to_use = vec!["Obtain the Host's normalized project root and protected storage boundaries through an explicitly granted read.".into()];
        descriptor.documentation.limitations = vec!["Paths come only from Host composition. Callers cannot choose a project, alter exclusions or grant filesystem access. Native plugins remain trusted local code, not OS-sandboxed processes.".into()];
        descriptor.documentation.effects = "Read configuration metadata only. No runtime, filesystem scan, recovery or Operation is started.".into();
        descriptor.documentation.related_capabilities = vec![];
    }
    if id == "views.caller" {
        descriptor.documentation.when_to_use = vec!["Bind owner-controlled task or draft actions to the native view that originated this active call, including backend delegation.".into()];
        descriptor.documentation.limitations = vec!["No caller-supplied selector or identity is accepted. An absent captured view is unavailable, never reinterpreted as a non-view caller. A successful observation contains no credential and does not authorize a later call or prove continued liveness.".into()];
        descriptor.documentation.effects = "Read only the native calling view identity. Never open or recover a view, enumerate other windows, or return bridge/asset tokens.".into();
        descriptor.documentation.related_capabilities = vec![key("views.inspect")];
    }
    if id == "plugins.delegated_operation" {
        descriptor.documentation.when_to_use = vec!["Resolve a retained reverse-call request after delayed or lost acknowledgement, then read its operation.get record.".into()];
        descriptor.documentation.limitations = vec!["Only the original native backend instance may query its own parent admission under the original principal and project. Identity cannot be selected through arguments. Historical reads do not require a running provider.".into(), "A null operation_id means no visible durable record was observed; dispatch may still be pending. It is never proof of no execution and never authorizes replay.".into()];
        descriptor.documentation.effects = "Read at most one parent admission and its exact original request record. No runtime start, cancellation, recovery, reactivation or scientific mutation.".into();
        descriptor.documentation.related_capabilities = vec![key("operation.get")];
    }
    if id.starts_with("scenarios.") {
        descriptor.domain = "scenarios".into();
        descriptor.documentation.owner = "plugins".into();
        descriptor.documentation.when_to_use = vec!["Save named project compositions or inspect their exact history through the same public ports used by Plugin Studio.".into()];
        descriptor.documentation.limitations = vec!["Project and principal come from the caller. Checkpoints record composition metadata only; no window changes, provider activation, credential capture, scientific execution or rollback occurs.".into(),
            "Saving checks structure and the expected head, not package availability or runtime readiness. Missing exact revisions remain explicit references. Applying a scenario requires separate validation and activation; saved optional selections do not grant authority.".into(),
            "Every checkpoint protects referenced plugin revisions, including earlier heads. Saving a former composition creates a new child; it never rewrites history or discards references.".into()];
        descriptor.documentation.effects = if operation { "Atomically save immutable scenario metadata, its head and protecting package references." } else { "Bounded observation only. Does not create a scenario, activate a provider or change a window." }.into();
        descriptor.documentation.retry_rule = if operation { "Retain the original client_request_id after a lost acknowledgement and inspect that Operation. Read the current head separately before making a new edit." } else { "Follow the explicit exclusive list cursor or the original revision's parent." }.into();
        descriptor.documentation.related_capabilities = vec![key("scenarios.list"),key("scenarios.get"),key("scenarios.checkpoint")];
        descriptor.documentation.position_units = vec!["Checkpoint metadata is limited to 256 KiB, 256 instances, 512 providers and 1024 layout nodes including views. Page limits are 1–100.".into()];
    }
    if id == "plugins.project_coverage" {
        descriptor.required_scopes.insert("project.references.read".into());
        descriptor.documentation.limitations = vec!["Returns only whether all recorded project instances are visible to this principal. It includes preparing, failed, released and historical instances; it exposes no foreign identities, counts, configuration or logs.".into(), "This is current visibility metadata, not a lease or native-process proof. Read owner-specific references separately; incomplete or unavailable coverage cannot establish absence. No provider is started, reconnected or recovered.".into()];
        descriptor.documentation.related_capabilities = vec![key("plugins.instances"),key("operation.project_coverage")];
    }
    if id == "plugins.instances" {
        descriptor.documentation.limitations.push("Runtime discovery excludes fixture previews by default, preserving normal protocol-v1 instance replies. Management tools may explicitly set include_previews:true for a complete lifecycle listing; its pagination and total cover that selected set.".into());
    }
    if id == "plugins.preview" {
        descriptor.documentation.limitations = vec![
            "Runs the exact retained artifact's view code with no backend, project path, provider registration or Host grant. Optional and required query fixtures are exact argument matches; a miss never falls through to real queries.".into(),
            "At most 128 fixtures and 256 KiB per preview request. Only view state, close cooperation and explicit text copy use real presentation owners. Other operations, cancellation, resource downloads and external navigation are denied.".into(),
            "Open views through views.open or windows.open_view, close them and release the preview explicitly. A preview cannot satisfy a scenario runtime instance. Restart does not silently recreate its connection or fixtures.".into(),
        ];
        descriptor.documentation.related_capabilities = vec![key("plugins.build"),key("views.open"),key("windows.open_view"),key("plugins.release")];
    }
    if id == "plugins.activate" {
        descriptor.documentation.limitations.push("Optional capabilities must be declared by this exact manifest and explicitly selected in optional_capabilities. Selection cannot enlarge declared scopes or caller authority; it does not install or start another provider. The selected grants stay fixed for this instance and its views.".into());
    }
    if id.starts_with("resources.") {
        descriptor.domain = "resources".into();
        descriptor.documentation.owner = "resources".into();
        descriptor.documentation.when_to_use = vec!["Read an exact retained resource reference, including after its provider has exited.".into()];
        descriptor.documentation.limitations = vec!["Reads require the original project and principal plus resources.read. A reference is not a credential; fields must match retained identity exactly.".into(), "Reads do not start a provider, fetch a URL, read a backend-supplied path, or commit scientific results.".into()];
        descriptor.documentation.related_capabilities = vec![key("resources.inspect"),key("resources.read")];
        descriptor.documentation.position_units = vec!["offset and limit are bytes. Read limit is 1–262144; next is the next byte offset, or null at EOF.".into()];
    }
    if id.starts_with("windows.") {
        descriptor.domain = "windows".into();
        descriptor.documentation.owner = "windows".into();
        descriptor.documentation.when_to_use = vec!["Read or save one window's arrangement of exact plugin view identities.".into()];
        descriptor.documentation.limitations = vec!["Layouts belong to the authenticated principal and normalized project. A plugin view can address only its original window. Cross-window view references are refused.".into(),
            "Saving layout does not activate plugins, reopen views, release instances, start a scientific runtime, or switch a scenario. Closed or unavailable views remain explicit placeholders.".into()];
        descriptor.documentation.effects = if operation { "Save presentation only. No view state, scientific state or runtime lifetime changes." } else { "Bounded read. An absent window is empty and is not created by this observation." }.into();
        descriptor.documentation.related_capabilities = vec![key("windows.layout"), key("windows.update_layout"), key("views.inspect")];
        descriptor.documentation.position_units = vec!["Split weights are finite positive ratios. At most 256 views, 1024 structural nodes, depth 32 and 256 KiB per layout.".into()];
    }
    if id == "windows.open_view" {
        descriptor.documentation.when_to_use = vec!["Open a contributed view in an explicit existing tab group, or create the first group in an empty window.".into()];
        descriptor.documentation.effects = "Atomically create one scoped view, retain its exact revision, and select it in the expected window layout. Does not start or stop a backend.".into();
        descriptor.documentation.limitations.push("The view instance must already be active. A null group is valid only for an empty window; no panel names or fallback routing are inferred. Conflict or validation failure leaves the view and layout unchanged.".into());
    }
    if matches!(id, "scenarios.prepare" | "scenarios.apply" | "windows.scenario" | "windows.resolve") {
        descriptor.documentation.when_to_use = vec!["Prepare and apply a complete scene in one explicit window, or inspect its exact selected providers.".into()];
        descriptor.documentation.retry_rule = if operation { "Retain client_request_id after lost acknowledgement and inspect the original Operation. Observe the current window version before a new application." } else { "Repeat a bounded observation; preparation reserves nothing and apply revalidates it." }.into();
        descriptor.documentation.position_units = vec!["Application and prepared output are limited to 256 KiB; live layouts allow 256 views.".into()];
        descriptor.documentation.limitations = vec![
            "Prepare instances and views through ordinary public activation and view ports. The complete scene requires exact Ready identities, artifacts, configuration, selected grants and manifest dependency bindings. No provider starts or stops here.".into(),
            "Apply revalidates preparation and atomically commits one window's layout and provider selection against its expected layout version. Other windows, existing operations and hidden views retain their identities and current state.".into(),
            "A preparation is an observation, not a reservation. A saved selection is not evidence of live providers after disconnection. Missing exact providers never fall back to another instance.".into()];
        descriptor.documentation.effects = if operation { "Change only the addressed window's presentation and default provider selection in one transaction." } else { "Bounded read of composition and native readiness; no activation, reconnection, view creation or scientific call." }.into();
        descriptor.documentation.related_capabilities = vec![key("scenarios.prepare"), key("scenarios.apply"), key("windows.scenario"), key("windows.resolve")];
    }
    if id == "views.connection" {
        descriptor.documentation.when_to_use = vec!["Connect the trusted containing shell to an already opened view.".into()];
        descriptor.documentation.limitations = vec!["Returns private connection credentials to the containing Host shell. Plugin callers are refused, including with an explicit capability grant. Plugins use views.inspect for public metadata/state.".into(),
            "Reading never creates or recovers a view connection.".into()];
    }
    descriptor
}
fn digest() -> String {
    format!("sha256:{}", "0".repeat(64))
}
fn instance() -> Value {
    json!({"instance":"plugin-example","plugin":"example.plugin","revision":digest(),"artifact":digest()})
}
fn normalized(id: &str, value: &Value) -> Result<Value, OperationError> {
    match id {
        "scenarios.list" => normalize::<ListScenarios>(value),
        "scenarios.get" => normalize::<ScenarioRevisionArguments>(value),
        "scenarios.prepare" | "scenarios.apply" => normalize::<ApplyScenario>(value),
        "windows.scenario" => normalize::<PluginWindowArguments>(value),
        "windows.resolve" => normalize::<ResolveWindowProvider>(value),
        "scenarios.checkpoint" => normalize::<SaveScenario>(value),
        "resources.list" => normalize::<ResourceList>(value),
        "resources.inspect" => normalize::<ResourceInspect>(value),
        "resources.read" => normalize::<ResourceRead>(value),
        "plugins.repository" | "workspace.paths" | "views.caller" => normalize::<Empty>(value),
        "plugins.delegated_operation" => normalize::<PluginDelegatedOperationArguments>(value),
        "plugins.project_coverage" => normalize::<ProjectReadCoverageArguments>(value),
        "plugins.list" => normalize::<PluginCatalogArguments>(value),
        "plugins.inspect" | "plugins.remove" => normalize::<PluginRevisionArguments>(value),
        "plugins.instances" => normalize::<PluginInstancesArguments>(value),
        "plugins.instance" | "plugins.release" => normalize::<PluginInstanceArguments>(value),
        "plugins.resolve" => normalize::<PluginResolveArguments>(value),
        "plugins.source_tree" => normalize::<ListPluginSource>(value),
        "plugins.read_source" => normalize::<ReadPluginSource>(value),
        "plugins.branches" => normalize::<ListPluginBranches>(value),
        "plugins.check_source" | "plugins.checkpoint" => normalize::<CheckpointPlugin>(value),
        "plugins.branch_head" => normalize::<PluginBranchArguments>(value),
        "plugins.compare" => normalize::<ComparePluginRevisions>(value),
        "views.inspect" | "views.connection" => normalize::<PluginViewArguments>(value),
        "views.close" => normalize::<ClosePluginView>(value),
        "views.open" => normalize::<OpenPluginView>(value),
        "plugins.preview" => normalize::<PreviewPlugin>(value),
        "views.update" => normalize::<UpdatePluginView>(value),
        "windows.layout" => normalize::<PluginWindowArguments>(value),
        "windows.update_layout" => normalize::<UpdatePluginWindowLayout>(value),
        "windows.open_view" => normalize::<OpenPluginWindowView>(value),
        "plugins.activate" => normalize::<ActivatePlugin>(value),
        "plugins.branch" => normalize::<BranchPlugin>(value),
        "plugins.advance_branch" => normalize::<AdvancePluginBranch>(value),
        "plugins.reconcile_references" => normalize::<Reconcile>(value),
        _ => unreachable!(),
    }
}
struct Read {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
    id: &'static str,
}
#[async_trait]
impl QueryHandler for Read {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        normalized(self.id, value)
    }
    async fn query(&self, _: &Value) -> Result<host::QuerySnapshot, OperationError> {
        Err(invalid("caller context required"))
    }
    async fn query_for(
        &self,
        context: &host::CallContext,
        value: &Value,
    ) -> Result<host::QuerySnapshot, OperationError> {
        let service = &self.service;
        let data = match self.id {
            "scenarios.prepare" => {
                let _guard = service.gate.lock().await;
                json!(service.prepare_scenario_application(context, &decode(value)?)?)
            }
            "windows.scenario" => {
                let args: PluginWindowArguments = decode(value)?;
                service.check_window_context(context, &args.window)?;
                json!(service.repository.lock().unwrap().window_scenario(&service.project,
                    &plugin_principal_id(context.principal()), &args.window).map_err(crate::scenario_application::fault)?)
            }
            "windows.resolve" => json!(service.resolve_window_provider(context, &decode(value)?)?),
            "scenarios.list" => json!(service.repository.lock().unwrap().scenarios(
                &service.project, &plugin_principal_id(context.principal()), &decode(value)?).map_err(scenario_error)?),
            "scenarios.get" => json!(service.repository.lock().unwrap().scenario_revision(
                &service.project, &plugin_principal_id(context.principal()), &decode::<ScenarioRevisionArguments>(value)?.revision).map_err(scenario_error)?),
            "plugins.project_coverage" => json!(service.repository.lock().unwrap().instance_project_coverage(&service.project,&plugin_principal_id(context.principal())).map_err(error)?),
            "workspace.paths" => json!(service.workspace_paths),
            "windows.layout" => {
                let args: PluginWindowArguments = decode(value)?;
                service.check_window_context(context, &args.window)?;
                json!(service.repository.lock().unwrap().window_layout(&service.project, &plugin_principal_id(context.principal()), &args.window).map_err(error)?)
            }
            "views.inspect" => json!(service.view_record(context,&decode::<PluginViewArguments>(value)?.view)?),
            "views.caller" => json!(service.caller_view(context)?),
            "plugins.delegated_operation" => json!(service.delegated_operation(context, &decode(value)?).await?),
            "views.connection" => json!(service.view_connection(context,&decode::<PluginViewArguments>(value)?.view)?),

            "resources.list" | "resources.inspect" | "resources.read" => {
                let resources = service.resources.clone();
                let project = service.project.clone();
                let principal = plugin_principal_id(context.principal());
                let value = value.clone();
                let inspect = self.id == "resources.inspect";
                let list = self.id == "resources.list";
                tokio::task::spawn_blocking(move || -> Result<Value, OperationError> {
                    if list {
                        let args: ResourceList = decode(&value)?;
                        Ok(json!(resources.list(&project,&principal,&args).map_err(error)?))
                    } else if inspect {
                        let args: ResourceInspect = decode(&value)?;
                        Ok(json!(resources.inspect(&project, &principal, &args.reference).map_err(error)?))
                    } else {
                        let args: ResourceRead = decode(&value)?;
                        let bytes = resources.read(&project, &principal, &args).map_err(error)?;
                        let end = args.offset + bytes.len() as u64;
                        Ok(json!(ResourceChunk { next: (end < args.reference.bytes).then_some(end), reference: args.reference, offset: args.offset, base64: STANDARD.encode(bytes) }))
                    }
                }).await.map_err(error)??
            },
            "plugins.repository" => {
                json!({"root":service.repository.lock().unwrap().root(),"project":service.project,"backend_target":backend_target()})
            }
            "plugins.list" => {
                let args: PluginCatalogArguments = decode(value)?;
                let page = service
                    .repository
                    .lock()
                    .unwrap()
                    .list_page(args.after.as_ref(), args.limit as usize)
                    .map_err(error)?;
                json!(PluginCatalogPage {
                    items: page.revisions.into_iter().map(item).collect(),
                    next: page.next,
                    total: page.total
                })
            }
            "plugins.inspect" => {
                let args: PluginRevisionArguments = decode(value)?;
                let repo = service.repository.lock().unwrap();
                let summary = repo.inspect(&args.revision).map_err(error)?;
                let revision = repo.revision(&args.revision).map_err(error)?;
                let artifacts = summary
                    .artifacts
                    .iter()
                    .map(|id| {
                        repo.artifact(id).map(|a| PluginArtifactSummary {
                            id: a.id,
                            target: a.target,
                            file_count: a.files.len() as u64,
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(error)?;
                json!(PluginInspection {
                    summary: item(summary),
                    manifest: revision.manifest,
                    parent: revision.parent,
                    source_file_count: revision.files.len() as u64,
                    artifacts
                })
            }
            "plugins.instances" => {
                let args: PluginInstancesArguments = decode(value)?;
                let principal = plugin_principal_id(context.principal());
                let page = service
                    .repository
                    .lock()
                    .unwrap()
                    .recorded_instances_filtered(
                        args.after.as_ref(),
                        args.limit as usize,
                        Some((&service.project, &principal)),
                        args.include_previews,
                    )
                    .map_err(error)?;
                let instances = page
                    .instances
                    .iter()
                    .map(|i| service.observe_instance(context, &i.identity, false))
                    .collect::<Result<Vec<_>, _>>()?;
                json!(PluginInstanceObservations {
                    instances,
                    next: page.next,
                    total: page.total
                })
            }
            "plugins.instance" => json!(service.observe_instance(
                context,
                &decode::<PluginInstanceArguments>(value)?.instance,
                true
            )?),
            "plugins.resolve" => {
                let args: PluginResolveArguments = decode(value)?;
                let lease = service
                    .runtime
                    .resolve(
                        &args.capability,
                        &service.project,
                        &plugin_principal_id(context.principal()),
                        args.instance.as_ref(),
                    )
                    .map_err(error)?;
                json!(lease.binding(args.target))
            }
            "plugins.source_tree" => json!(service.repository.lock().unwrap().source_page(&decode::<ListPluginSource>(value)?).map_err(source_error)?),
            "plugins.read_source" => {
                let args: ReadPluginSource = decode(value)?;
                let service = service.clone();
                json!(tokio::task::spawn_blocking(move || service.repository.lock().unwrap().read_source(&args).map_err(source_error)).await.map_err(error)??)
            }
            "plugins.branches" => json!(service.repository.lock().unwrap().branches(&decode::<ListPluginBranches>(value)?).map_err(source_error)?),
            "plugins.check_source" => {
                let args: CheckpointPlugin = decode(value)?;
                let service = service.clone();
                json!(tokio::task::spawn_blocking(move || {
                    let archive = service.repository.lock().unwrap().prepare_checkpoint(&args).map_err(source_error)?;
                    Ok::<_, OperationError>(PluginCheckpoint { branch: args.branch, revision: archive.revision.id, parent: args.expected_head })
                }).await.map_err(error)??)
            }
            "plugins.branch_head" => {
                json!({"revision":service.repository.lock().unwrap().branch_head(&decode::<PluginBranchArguments>(value)?.branch).map_err(error)?})
            }
            "plugins.compare" => {
                let args: ComparePluginRevisions = decode(value)?;
                json!(
                    service
                        .repository
                        .lock()
                        .unwrap()
                        .compare(&args.before, &args.after)
                        .map_err(error)?
                )
            }
            _ => unreachable!(),
        };
        Ok(host::QuerySnapshot {
            target: host::TargetRef {
                kind: if self.id == "workspace.paths" { "workspace" } else if self.id.starts_with("resources.") { "plugin_resources" } else { "plugin_repository" }.into(),
                identity: service.scope.clone(),
            },
            source: if self.id == "workspace.paths" { "host/path-boundaries" } else if self.id == "plugins.delegated_operation" { "operation-journal/original-delegation" } else if self.id.starts_with("resources.") { "resources/retained-bytes" } else { "plugins/repository-and-native-lifecycle" }.into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: host::QueryStatus::Ready,
            completeness: if self.id == "plugins.delegated_operation" && data["operation_id"].is_null() { host::ObservationCompleteness::Partial } else { host::ObservationCompleteness::Complete },
            notices: if self.id == "plugins.delegated_operation" && data["operation_id"].is_null() { vec!["No visible durable record was observed. Dispatch may still be pending; do not replay the request.".into()] } else { vec![] },
            next_reads: vec![],
            diagnostics: vec![],
            data: Some(data),
        })
    }
}
struct Bound {
    context: host::CallContext,
    target: host::TargetRef,
    revision: Option<RevisionId>,
    grants: Vec<CapabilityRequirement>,
    source_checkpoint: Option<Arc<PluginArchive>>,
}
struct Manage {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
    id: &'static str,
    bound: Option<Bound>,
}
#[async_trait]
impl OperationHandler for Manage {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.service.scope.clone())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        normalized(self.id, value)
    }
    fn resolve_target(&self, _: &Value) -> Result<host::TargetRef, OperationError> {
        Ok(self
            .bound
            .as_ref()
            .map(|b| b.target.clone())
            .unwrap_or(host::TargetRef {
                kind: "plugin_repository".into(),
                identity: self.service.scope.clone(),
            }))
    }
    fn execution_context(&self) -> Value {
        let mut context = json!({"managed_revision":self.bound.as_ref().and_then(|b|b.revision.as_ref())});
        if let Some(bound) = &self.bound && let Some(archive) = &bound.source_checkpoint {
            context["source_checkpoint"] = json!({"branch":bound.target.identity,"revision":archive.revision.id,"parent":archive.revision.parent});
        }
        context
    }
    async fn bind(
        &self,
        context: &host::CallContext,
        value: &Value,
        preconditions: &[host::Precondition],
    ) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        if !preconditions.is_empty() {
            return Err(invalid(
                "plugin lifecycle uses exact artifact/instance/branch arguments, not unrelated native preconditions",
            ));
        }
        let mut revision = None;
        let mut grants = vec![];
        let mut source_checkpoint = None;
        let mut target = host::TargetRef {
            kind: "plugin_repository".into(),
            identity: self.service.scope.clone(),
        };
        match self.id {
            "plugins.preview" => {
                let args: PreviewPlugin = decode(value)?;
                self.service.prepare_preview(&args)?;
                revision = Some(args.revision);
                target = host::TargetRef { kind: "plugin_instance".into(), identity: format!("plugin-{}", uuid::Uuid::new_v4().simple()) };
            }
            "scenarios.apply" => {
                let args: ApplyScenario = decode(value)?;
                self.service.prepare_scenario_application(context, &args)?;
                target = host::TargetRef { kind: "plugin_window".into(), identity: format!("{}:{}:{}",
                    self.service.project, plugin_principal_id(context.principal()), args.window) };
            }
            "scenarios.checkpoint" => {
                let principal = plugin_principal_id(context.principal());
                let args: SaveScenario = decode(value)?;
                self.service.repository.lock().unwrap().prepare_scenario(&self.service.project, &principal, &args).map_err(scenario_error)?;
                target = host::TargetRef { kind:"scenario".into(), identity:format!("{}:{}:{}",self.service.project,principal,args.scenario) };
            }
            "windows.open_view" => {
                let args: OpenPluginWindowView = decode(value)?;
                let id = ViewInstanceId::new(format!("view-{}", uuid::Uuid::new_v4().simple())).map_err(error)?;
                self.service.prepare_window_view(context, &id, &args)?;
                revision = Some(args.view.instance.revision);
                target = host::TargetRef { kind: "plugin_view".into(), identity: id.to_string() };
            }
            "windows.update_layout" => {
                let args: UpdatePluginWindowLayout = decode(value)?;
                self.service.check_window_context(context, &args.window)?;
                let ids = args.layout.view_ids().map_err(invalid)?;
                if serde_json::to_vec(&args).map_err(invalid)?.len() > MAX_CONTROL_BYTES / 4 { return Err(invalid("window layout exceeds 256 KiB")); }
                let principal = plugin_principal_id(context.principal());
                let current = self.service.repository.lock().unwrap().window_layout(&self.service.project, &principal, &args.window).map_err(error)?;
                if current.version != args.expected_version { return Err(OperationError::ContentChanged("window layout changed".into())); }
                for id in ids {
                    if self.service.view_record(context, &id)?.window != args.window { return Err(invalid("window view is unavailable in this scope")); }
                }
                target = host::TargetRef { kind: "plugin_window".into(), identity: format!("{}:{}:{}", self.service.project, principal, args.window) };
            }
            "views.open" => {
                let args: OpenPluginView = decode(value)?;
                self.service.prepare_view(context,&args)?;
                revision = Some(args.instance.revision);
                target = host::TargetRef { kind:"plugin_view".into(), identity:format!("view-{}",uuid::Uuid::new_v4().simple()) };
            }
            "views.update" | "views.close" => {
                let record = if self.id == "views.update" {
                    self.service.view_record(context, &decode::<UpdatePluginView>(value)?.view)?
                } else {
                    self.service.prepare_view_close(context, &decode::<ClosePluginView>(value)?)?
                };
                let view = record.view.clone();
                if !record.closed { revision=Some(record.instance.revision); }
                target=host::TargetRef { kind:"plugin_view".into(), identity:view.to_string() };
            }

            "plugins.activate" => {
                let args: ActivatePlugin = decode(value)?;
                let repo = self.service.repository.lock().unwrap();
                let stored = repo.revision(&args.revision).map_err(error)?;
                let expected_target = if stored.manifest.backend.is_some() { backend_target() } else { "ui-web".into() };
                if args.target != expected_target {
                    return Err(invalid("artifact target does not match this local Host"));
                }
                let artifact = repo.artifact(&args.artifact).map_err(error)?;
                if artifact.revision != args.revision || artifact.target != args.target {
                    return Err(invalid(
                        "artifact does not belong to the selected revision and target",
                    ));
                }
                crate::runtime::validate_value(
                    &stored.manifest.configuration_schema,
                    &args.configuration,
                    "configuration",
                )
                .map_err(error)?;
                let registry = self.service.registry()?.snapshot();
                grants = stored.manifest.activation_requirements(&args.optional_capabilities).map_err(error)?;
                for grant in &grants {
                    let capability = host::CapabilityRef::new(
                        grant.capability.id.as_str(),
                        grant.capability.version.try_into().map_err(invalid)?,
                    )?;
                    let (required_scopes, available) = if let Some(descriptor) = registry.descriptor(&capability) {
                        (&descriptor.required_scopes, descriptor.kind != host::CapabilityKind::Control
                            || registry.control_handler(&capability).is_ok())
                    } else if let Some(own) = stored.manifest.capabilities.iter().find(|own| own.capability == grant.capability) {
                        // A combined UI/backend package can require its own exact
                        // contribution before its first instance exists. This is
                        // only grant validation: publication still waits for Ready
                        // and every eventual call uses the normal scoped router.
                        (&own.required_scopes, true)
                    } else {
                        return Err(OperationError::UnknownCapability(capability.display_key()));
                    };
                    if !available || !required_scopes.is_subset(&grant.scopes)
                        || !grant.scopes.is_subset(&context.scopes)
                    {
                        return Err(OperationError::AccessDenied {capability:capability.display_key(),missing:vec!["declared grant must fit the existing caller authority and an available handler contract".into()]});
                    }
                }
                revision = Some(args.revision);
                target = host::TargetRef {
                    kind: "plugin_instance".into(),
                    identity: format!("plugin-{}", uuid::Uuid::new_v4().simple()),
                };
            }
            "plugins.release" => {
                let args: PluginInstanceArguments = decode(value)?;
                let observation = self
                    .service
                    .observe_instance(context, &args.instance, false)?;
                if !observation.observed_in_this_host
                    && observation.instance.state != InstanceState::Released
                    && observation.instance.purpose != PluginInstancePurpose::FixturePreview
                    && self.service.repository.lock().unwrap().revision(&args.instance.revision).map_err(error)?.manifest.backend.is_some()
                {
                    return Err(error(
                        "instance belongs to an ended Host; cleanup is not established by its historical record",
                    ));
                }
                if observation.instance.state != InstanceState::Released {
                    revision = Some(args.instance.revision);
                }
                target = host::TargetRef {
                    kind: "plugin_instance".into(),
                    identity: args.instance.instance.to_string(),
                };
            }
            "plugins.checkpoint" => {
                let args: CheckpointPlugin = decode(value)?;
                revision = Some(args.expected_head.clone());
                target = host::TargetRef { kind: "plugin_branch".into(), identity: args.branch.to_string() };
                let service = self.service.clone();
                source_checkpoint = Some(Arc::new(tokio::task::spawn_blocking(move || service.repository.lock().unwrap().prepare_checkpoint(&args).map_err(source_error)).await.map_err(error)??));
            }
            "plugins.branch" => {
                let args: BranchPlugin = decode(value)?;
                if args.name.trim().is_empty() || args.name.len() > 128 {
                    return Err(invalid("branch name must contain 1–128 UTF-8 bytes"));
                }
                self.service
                    .repository
                    .lock()
                    .unwrap()
                    .revision(&args.revision)
                    .map_err(error)?;
                revision = Some(args.revision);
            }
            "plugins.advance_branch" => {
                let args: AdvancePluginBranch = decode(value)?;
                if self
                    .service
                    .repository
                    .lock()
                    .unwrap()
                    .branch_head(&args.branch)
                    .map_err(error)?
                    != args.expected
                {
                    return Err(OperationError::ContentChanged("branch head changed".into()));
                }
                revision = Some(args.next);
            }
            "plugins.remove" => {
                self.service
                    .repository
                    .lock()
                    .unwrap()
                    .revision(&decode::<PluginRevisionArguments>(value)?.revision)
                    .map_err(error)?;
            }
            "plugins.reconcile_references" => {
                let args: Reconcile = decode(value)?;
                host::OperationId::new(args.operation_id.as_str())?;
            }
            _ => unreachable!(),
        }
        Ok(Some(Arc::new(Self {
            service: self.service.clone(),
            descriptor: self.descriptor.clone(),
            id: self.id,
            bound: Some(Bound {
                context: context.clone(),
                target,
                revision,
                grants,
                source_checkpoint,
            }),
        })))
    }
    fn admitted(&self, operation: &host::Operation) -> Result<(), HandlerError> {
        if let Some(revision) = self.bound.as_ref().and_then(|b| b.revision.as_ref()) {
            self.service
                .repository
                .lock()
                .unwrap()
                .retain("management", operation.operation_id.as_str(), revision)
                .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        }
        Ok(())
    }
    async fn acquire_execution(
        &self,
        operation: &host::Operation,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(Box::new(ManagementLease {
            service: self.service.clone(),
            operation: operation.operation_id.clone(),
            revision: self.bound.as_ref().and_then(|b| b.revision.clone()),
        }))
    }
    async fn execute(&self, operation: &host::Operation) -> Result<CommitPlan, HandlerError> {
        self.run(operation).await.map(CommitPlan::succeeded).map_err(|error| {
            if matches!(self.id, "windows.update_layout" | "windows.open_view" | "views.close" | "scenarios.checkpoint" | "scenarios.apply" | "plugins.checkpoint") && matches!(&error,
                OperationError::ContentChanged(_) | OperationError::InvalidInput(_) | OperationError::NotFound(_)) {
                return HandlerError::before_effect(error.to_string());
            }
            let recovery=json!({"kind":"plugin_lifecycle","target":operation.target,"detail":error.to_string(),"automatic_reexecution":false});
            HandlerError::after_possible_effect(error.to_string(),Some(recovery))
        })
    }
}
struct ManagementLease {
    service: Arc<PluginService>,
    operation: host::OperationId,
    revision: Option<RevisionId>,
}
#[async_trait::async_trait]
impl ExecutionLease for ManagementLease {
    async fn completed(&mut self, result: &Result<host::OperationRecord, OperationError>) {
        if result.as_ref().is_ok_and(|r| r.status.is_terminal())
            && let Some(revision) = &self.revision
        {
            let _ = self.service.repository.lock().unwrap().release_reference(
                "management",
                self.operation.as_str(),
                revision,
            );
        }
    }
}
impl Manage {
    async fn run(&self, operation: &host::Operation) -> Result<Value, OperationError> {
        let bound = self
            .bound
            .as_ref()
            .ok_or_else(|| invalid("unbound lifecycle command"))?;
        let value = &operation.normalized_arguments;
        let service = &self.service;
        match self.id {
            "plugins.preview" => {
                let args: PreviewPlugin = decode(value)?;
                let _guard = service.gate.lock().await;
                let target = service.prepare_preview(&args)?;
                let instance = service.runtime.preview_identified(PluginActivation {
                    revision: args.revision, artifact: args.artifact, target,
                    project: service.project.clone(), project_root: None,
                    principal: plugin_principal_id(bound.context.principal()), alias: args.alias,
                    configuration: args.configuration, grants: vec![],
                }, PluginInstanceId::new(&bound.target.identity).map_err(error)?, args.queries).await.map_err(error)?;
                Ok(json!(service.observe_instance(&bound.context, &instance.identity, false)?))
            }
            "scenarios.apply" => {
                let _guard = service.gate.lock().await;
                Ok(json!(service.apply_scenario(&bound.context, &decode(value)?)?))
            }
            "scenarios.checkpoint" => {
                let _guard = service.gate.lock().await;
                Ok(json!(service.repository.lock().unwrap().save_scenario(&service.project,
                    &plugin_principal_id(bound.context.principal()), &decode(value)?).map_err(scenario_error)?))
            }
            "windows.open_view" => {
                let _guard = service.gate.lock().await;
                Ok(json!(service.open_window_view(&bound.context,
                    ViewInstanceId::new(&bound.target.identity).map_err(error)?, decode(value)?)?))
            }
            "windows.update_layout" => {
                let _guard = service.gate.lock().await;
                service.check_window_context(&bound.context, &decode::<UpdatePluginWindowLayout>(value)?.window)?;
                let record = service.repository.lock().unwrap().update_window_layout(&service.project,
                    &plugin_principal_id(bound.context.principal()), decode(value)?).map_err(|fault| match fault {
                        PluginError::Conflict => OperationError::ContentChanged("window layout changed".into()), other => error(other),
                    })?;
                Ok(json!(record))
            }
            "views.close" => {
                Ok(json!(service.close_view_cooperatively(&bound.context,
                    OperationId::new(operation.operation_id.as_str()).map_err(error)?, decode(value)?).await?))
            }
            "views.open" | "views.update" => {
                let _guard=service.gate.lock().await;
                let record=match self.id {
                    "views.open"=>service.open_view(&bound.context,ViewInstanceId::new(&bound.target.identity).map_err(error)?,decode(value)?)?,
                    "views.update"=>service.update_view(&bound.context,decode(value)?)?,
                    _ => unreachable!(),
                };
                Ok(json!(record))
            }

            "plugins.activate" => {
                let args: ActivatePlugin = decode(value)?;
                let _guard = service.gate.lock().await;
                let principal = plugin_principal_id(bound.context.principal());
                service
                    .services
                    .principals
                    .lock()
                    .unwrap()
                    .insert(principal.clone(), bound.context.principal().clone());
                let result = service
                    .runtime
                    .activate_identified(
                        PluginActivation {
                            revision: args.revision,
                            artifact: args.artifact,
                            target: args.target,
                            project: service.project.clone(),
                            project_root: Some(service.scope.clone().into()),
                            principal,
                            alias: args.alias,
                            configuration: args.configuration,
                            grants: bound.grants.clone(),
                        },
                        PluginInstanceId::new(&bound.target.identity).map_err(error)?,
                        false,
                    )
                    .await;
                let instance = result.map_err(error)?;
                if let Err(fault) = service
                    .bridge
                    .publish(service.registry()?.as_ref(), &instance.identity)
                {
                    let _ = service.runtime.release(&instance.identity).await;
                    service.refresh_locked()?;
                    return Err(fault);
                }
                service.published();
                Ok(json!(service.observe_instance(
                    &bound.context,
                    &instance.identity,
                    false
                )?))
            }
            "plugins.release" => {
                let args: PluginInstanceArguments = decode(value)?;
                let _guard = service.gate.lock().await;
                let observation =
                    service.observe_instance(&bound.context, &args.instance, false)?;
                if observation.instance.state == InstanceState::Released {
                    return Ok(json!(observation));
                }
                if !observation.observed_in_this_host {
                    let mut repo=service.repository.lock().unwrap();
                    let manifest=repo.revision(&args.instance.revision).map_err(error)?.manifest;
                    if observation.instance.purpose == PluginInstancePurpose::FixturePreview || manifest.backend.is_none() {
                        let references=repo.references(&args.instance.revision).map_err(error)?;
                        let view_prefix=format!("view:{}:",args.instance.instance);
                        let operation_prefix=format!("operation:{}:",args.instance.instance);
                        if references.iter().any(|r|r.starts_with(&view_prefix)||r.starts_with(&operation_prefix)) { return Err(invalid("instance still has retained views or operations")); }
                        let mut record=observation.instance;
                        record.state=InstanceState::Released;
                        record.diagnostic=None;
                        repo.record_instance(&record).map_err(error)?;
                        drop(repo);
                        return Ok(json!(service.observe_instance(&bound.context,&args.instance,false)?));
                    }
                }
                let result = service.runtime.release(&args.instance).await;
                service.refresh_locked()?;
                result.map_err(error)?;
                Ok(json!(service.observe_instance(
                    &bound.context,
                    &args.instance,
                    false
                )?))
            }
            "plugins.remove" => {
                let args: PluginRevisionArguments = decode(value)?;
                service
                    .repository
                    .lock()
                    .unwrap()
                    .remove(&args.revision)
                    .map_err(|fault| match fault {
                        PluginError::Referenced(refs) => error(format!(
                            "revision is protected by {} references",
                            refs.len()
                        )),
                        other => error(other),
                    })?;
                Ok(json!({"removed":args.revision}))
            }
            "plugins.checkpoint" => {
                let args: CheckpointPlugin = decode(value)?;
                let archive = bound.source_checkpoint.clone().ok_or_else(|| error("source checkpoint was not prepared"))?;
                let service = service.clone();
                Ok(json!(tokio::task::spawn_blocking(move || service.repository.lock().unwrap().commit_checkpoint(&args, &archive).map_err(source_error)).await.map_err(error)??))
            }
            "plugins.branch" => {
                let args: BranchPlugin = decode(value)?;
                Ok(
                    json!({"branch":service.repository.lock().unwrap().create_branch(&args.revision,&args.name).map_err(error)?}),
                )
            }
            "plugins.advance_branch" => {
                let args: AdvancePluginBranch = decode(value)?;
                service
                    .repository
                    .lock()
                    .unwrap()
                    .advance_branch(&args.branch, &args.expected, &args.next)
                    .map_err(error)?;
                Ok(json!({"revision":args.next}))
            }
            "plugins.reconcile_references" => {
                let args: Reconcile = decode(value)?;
                let record = service
                    .journal
                    .get(&args.operation_id)
                    .await?
                    .ok_or_else(|| OperationError::NotFound(args.operation_id.as_str().into()))?;
                service.complete_record(&bound.context, &record).await?;
                Ok(json!({"operation_id":args.operation_id,"reconciled":true}))
            }
            _ => unreachable!(),
        }
    }
}
