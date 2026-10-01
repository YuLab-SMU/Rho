use crate::reconcile;
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
    let operation = id == "process.run_local" || id == reconcile::EXECUTE;
    let reconciliation = id == reconcile::EXECUTE || id == reconcile::PREPARE;
    let mut scopes = ["project.read".into()]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    if id != "process.status" {
        scopes.insert("process.run_local".into());
    }
    if reconciliation {
        scopes.insert("operation.read".into());
    }
    CapabilityContribution {
        capability: key(id, version), kind: if operation { CapabilityKind::Operation } else { CapabilityKind::Query },
        title: match id { "process.run_local" => "Run a local process", "process.prepare_local" => "Prepare a local process", reconcile::EXECUTE => "Reconcile original tagged processes", reconcile::PREPARE => "Verify original process recovery scope", _ => "Observe native process activity" }.into(),
        description: if id == reconcile::EXECUTE { "Explicitly clean visible same-user processes retaining the verified terminal original operation tag. Recheck native identity before signalling; never replay or change the original outcome. Partial observation is not OS containment or rollback." }
            else if operation { "Run one authorized local process in the exact project. Retain bounded original stdout/stderr in a resource, and submit the result through the original Host operation. Trusted native execution is not an OS sandbox." }
            else { "Observe native process scheduling or validate a prospective request. Does not start a process, recover work or install software." }.into(),
        input_schema: input, examples: vec![example], output_schema: output,
        recovery_schema: if id == reconcile::EXECUTE { schema_for!(ProcessReconcileRecovery).to_value() } else if operation { schema_for!(ProcessRunRecovery).to_value() } else { json!({"type":"null"}) },
        required_scopes: scopes,
        effects: if id == reconcile::EXECUTE { ["process.signal".into()].into() } else if operation { ["process.spawn", "project.files", "network"].into_iter().map(String::from).collect() } else { Default::default() },
        cancellation: if id == "process.run_local" { CancellationSupport::Request } else { CancellationSupport::Unsupported },
        preflight: operation.then(|| key(if reconciliation { reconcile::PREPARE } else { "process.prepare_local" }, 2)),
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
        dependencies: Default::default(), requires: vec![CapabilityRequirement { capability: key("operation.get", 1), scopes: ["operation.read".into()].into() }], optional_requires: vec![],
        capabilities: vec![
            capability("process.status", 1, schema_for!(Empty).to_value(), schema_for!(ProcessStatus).to_value(), json!({})),
            capability("process.prepare_local", 2, schema_for!(PluginPreflightRequest).to_value(), schema_for!(PluginPreflightResult).to_value(),
                json!({"capability":{"id":"process.run_local","version":2},"arguments":{"program":"/usr/bin/printf","args":["Example\\n"]},"target":null,"preconditions":null})),
            capability("process.run_local", 2, schema_for!(RunLocalArguments).to_value(), schema_for!(ProcessRunResult).to_value(), json!({"program":"/usr/bin/printf","args":["Example\\n"]})),
            capability(reconcile::PREPARE, 2, schema_for!(PluginPreflightRequest).to_value(), schema_for!(PluginPreflightResult).to_value(),
                json!({"capability":{"id":reconcile::EXECUTE,"version":2},"arguments":{"operation_id":"original-process"},"target":null,"preconditions":null})),
            capability(reconcile::EXECUTE, 2, schema_for!(ReconcileProcessArguments).to_value(), schema_for!(ProcessReconciliation).to_value(), json!({"operation_id":"original-process"})),
        ],
        views: vec![], contexts: vec![], backend: Some(BackendEntrypoint { executable: PackagePath::new("dist/rho-process-backend").unwrap(), arguments: vec![] }),
        configuration_schema: schema_for!(Empty).to_value(), default_configuration: json!({}),
    }
}
