use crate::source;
use rho_plugin_sdk::protocol::*;
use rho_process_api::RunLocalArguments;
use rho_remote_api::*;
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
    title: &str,
) -> CapabilityContribution {
    let operation = matches!(
        id,
        source::RUN | source::SUBMIT | source::RECONCILE | source::CANCEL
    );
    CapabilityContribution {
        capability: key(id, version), kind: if operation { CapabilityKind::Operation } else { CapabilityKind::Query }, title: title.into(),
        description: match id {
            source::RUN => "Execute on the configured SSH target. Preserve bounded original output in a resource. SSH loss or local transport cancellation never confirms remote termination; no automatic replay.",
            source::SUBMIT => "Submit one typed Slurm allocation. Retain its original operation marker across receipt loss; never resubmit automatically.",
            source::RECONCILE => "Identify the original terminal submission through native user/cluster/project/marker observations. Do not replay or rewrite the source operation.",
            source::CANCEL => "Request cancellation only after a unique native allocation observation. Request acceptance does not confirm the job stopped.",
            source::SNAPSHOT => "Observe one authorized original submission using bounded scheduler reads. Active originals and busy lanes return busy without another job submission.",
            _ => "Observe configured native activity or validate an explicit request without starting SSH or a scheduler job.",
        }.into(), input_schema: input, output_schema: output, examples: vec![example],
        recovery_schema: match id {
            source::RUN => schema_for!(RemoteRunRecovery).to_value(), source::SUBMIT => schema_for!(SlurmSubmissionRecovery).to_value(),
            source::RECONCILE => schema_for!(SlurmReconcileRecovery).to_value(), source::CANCEL => schema_for!(SlurmCancelRecovery).to_value(), _ => json!({"type":"null"}),
        }, required_scopes: source::scopes(id),
        effects: match id {
            source::RUN => ["process.spawn", "remote.files", "network"].as_slice(),
            source::SUBMIT => ["process.spawn", "remote.files", "network", "scheduler.submit"].as_slice(),
            source::CANCEL => ["process.spawn", "network", "scheduler.cancel"].as_slice(),
            source::RECONCILE => ["process.spawn", "network"].as_slice(),
            _ => [].as_slice(),
        }.iter().map(|effect| (*effect).into()).collect(),
        cancellation: if id == source::RUN { CancellationSupport::Request } else { CancellationSupport::Unsupported },
        preflight: match id { source::RUN => Some(key(source::PREPARE_RUN, 2)), source::SUBMIT => Some(key("slurm.prepare_submit", 2)), source::RECONCILE => Some(key("slurm.prepare_reconcile", 2)), source::CANCEL => Some(key("slurm.prepare_cancel", 2)), _ => None },
    }
}
pub fn manifest() -> PluginManifest {
    let mut capabilities = vec![
        capability(
            "remote.status",
            1,
            schema_for!(Empty).to_value(),
            schema_for!(RemoteStatus).to_value(),
            json!({}),
            "Observe configured remote activity",
        ),
        capability(
            source::RUN,
            2,
            schema_for!(RunLocalArguments).to_value(),
            schema_for!(RemoteRunResult).to_value(),
            json!({"program":"printf","args":["Example\\n"]}),
            "Run an SSH command",
        ),
        capability(
            source::SUBMIT,
            2,
            schema_for!(SlurmSubmitArguments).to_value(),
            schema_for!(SlurmJobRef).to_value(),
            json!({"body":"printf 'Example\\n'"}),
            "Submit a Slurm allocation",
        ),
        capability(
            source::RECONCILE,
            2,
            schema_for!(SlurmSourceArguments).to_value(),
            schema_for!(SlurmLookup).to_value(),
            json!({"submission_operation_id":"original-submission"}),
            "Reconcile a Slurm submission",
        ),
        capability(
            source::CANCEL,
            2,
            schema_for!(SlurmSourceArguments).to_value(),
            schema_for!(SlurmCancellation).to_value(),
            json!({"submission_operation_id":"original-submission"}),
            "Request Slurm cancellation",
        ),
        capability(
            source::SNAPSHOT,
            2,
            schema_for!(SlurmSourceArguments).to_value(),
            schema_for!(SlurmSnapshot).to_value(),
            json!({"submission_operation_id":"original-submission"}),
            "Observe an original Slurm allocation",
        ),
    ];
    for (id, operation, arguments, title) in [
        (
            source::PREPARE_RUN,
            source::RUN,
            json!({"program":"printf","args":["Example\\n"]}),
            "Prepare an SSH command",
        ),
        (
            "slurm.prepare_submit",
            source::SUBMIT,
            json!({"body":"printf 'Example\\n'"}),
            "Prepare a Slurm submission",
        ),
        (
            "slurm.prepare_reconcile",
            source::RECONCILE,
            json!({"submission_operation_id":"original-submission"}),
            "Verify original Slurm recovery scope",
        ),
        (
            "slurm.prepare_cancel",
            source::CANCEL,
            json!({"submission_operation_id":"original-submission"}),
            "Verify original Slurm cancellation scope",
        ),
    ] {
        capabilities.push(capability(id, 2, schema_for!(PluginPreflightRequest).to_value(), schema_for!(PluginPreflightResult).to_value(), json!({"capability":{"id":operation,"version":2},"arguments":arguments,"target":null,"preconditions":null}), title));
    }
    PluginManifest {
        protocol_version: PLUGIN_PROTOCOL_VERSION,
        id: PluginId::new("org.rho.remote").unwrap(),
        name: "Remote tasks".into(),
        version: "0.1.0".into(),
        description:
            "SSH execution and original-operation Slurm recovery on explicit configured targets"
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
            capability: key("operation.get", 1),
            scopes: ["operation.read".into()].into(),
        }],
        optional_requires: vec![],
        capabilities,
        views: vec![],
        contexts: vec![],
        backend: Some(BackendEntrypoint {
            executable: PackagePath::new("dist/rho-remote-backend").unwrap(),
            arguments: vec![],
        }),
        configuration_schema: schema_for!(RemoteConfiguration).to_value(),
        default_configuration: json!(RemoteConfiguration::default()),
    }
}
