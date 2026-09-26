use rho_plugin_sdk::protocol::*;
use rho_process_api::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Empty {}
fn key(id: &str, version: u32) -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new(id).unwrap(),
        version,
    }
}
fn capability(
    id: &str,
    version: u32,
    input: Value,
    output: Value,
    example: Value,
) -> CapabilityContribution {
    let operation = id == "process.run_local";
    let mut scopes = ["project.read".into()]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    if id != "process.status" {
        scopes.insert("process.run_local".into());
    }
    CapabilityContribution {
        capability: key(id, version), kind: if operation { CapabilityKind::Operation } else { CapabilityKind::Query },
        title: match id { "process.run_local" => "Run a local process", "process.prepare_local" => "Prepare a local process", _ => "Observe native process activity" }.into(),
        description: if operation { "Run one authorized local process in the exact project. Retain bounded original stdout/stderr in a resource, and submit the result through the original Host operation. Trusted native execution is not an OS sandbox." }
            else { "Observe native process scheduling or validate a prospective request. Does not start a process, recover work or install software." }.into(),
        input_schema: input, examples: vec![example], output_schema: output,
        recovery_schema: if operation { schema_for!(ProcessRunRecovery).to_value() } else { json!({"type":"null"}) },
        required_scopes: scopes,
        effects: if operation { ["process.spawn", "project.files", "network"].into_iter().map(String::from).collect() } else { Default::default() },
        cancellation: if operation { CancellationSupport::Request } else { CancellationSupport::Unsupported },
        preflight: operation.then(|| key("process.prepare_local", 2)),
    }
}
pub fn manifest() -> PluginManifest {
    PluginManifest {
        protocol_version: PLUGIN_PROTOCOL_VERSION,
        id: PluginId::new("org.rho.process").unwrap(), name: "Processes".into(), version: "0.1.0".into(),
        description: "Native local process execution, bounded output evidence and original-operation settlement".into(), license: "AGPL-3.0-only".into(),
        source: SourceDeclaration { files: [PackagePath::new("backend/src/main.rs").unwrap(), PackagePath::new("build.mjs").unwrap()].into(),
            lockfiles: [PackagePath::new("Cargo.lock").unwrap()].into(), build_instructions: PackagePath::new("BUILD.md").unwrap(),
            build: Some(BuildRecipe { command: vec!["node".into(), "build.mjs".into()] }) },
        dependencies: Default::default(), requires: vec![], optional_requires: vec![],
        capabilities: vec![
            capability("process.status", 1, schema_for!(Empty).to_value(), schema_for!(ProcessStatus).to_value(), json!({})),
            capability("process.prepare_local", 2, schema_for!(PluginPreflightRequest).to_value(), schema_for!(PluginPreflightResult).to_value(),
                json!({"capability":{"id":"process.run_local","version":2},"arguments":{"program":"/usr/bin/printf","args":["Example\\n"]},"target":null,"preconditions":null})),
            capability("process.run_local", 2, schema_for!(RunLocalArguments).to_value(), schema_for!(ProcessRunResult).to_value(), json!({"program":"/usr/bin/printf","args":["Example\\n"]})),
        ],
        views: vec![], contexts: vec![], backend: Some(BackendEntrypoint { executable: PackagePath::new("dist/rho-process-backend").unwrap(), arguments: vec![] }),
        configuration_schema: schema_for!(Empty).to_value(), default_configuration: json!({}),
    }
}
