use crate::source::{self, Empty};
use rho_environment_api::*;
use rho_plugin_sdk::protocol::*;
use schemars::schema_for;
use serde_json::{Value, json};

fn key(id: &str, version: u32) -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new(id).unwrap(),
        version,
    }
}
fn contribution(
    id: &str,
    input: Value,
    output: Value,
    example: Value,
    title: &str,
) -> CapabilityContribution {
    let operation = matches!(
        id,
        source::PLAN
            | source::REALIZE
            | source::VERIFY
            | source::RECONCILE
            | source::REFRESH
            | source::CLEANUP
            | source::RESTORE
            | source::PURGE
    );
    let prepare = match id {
        source::PLAN => Some("environment.prepare_plan"),
        source::REALIZE => Some("environment.prepare_realize"),
        source::VERIFY => Some("environment.prepare_verify"),
        source::RECONCILE => Some("environment.prepare_reconcile"),
        source::REFRESH => Some("environment.prepare_refresh"),
        source::CLEANUP => Some("environment.prepare_cleanup"),
        source::RESTORE => Some("environment.prepare_restore_cleanup"),
        source::PURGE => Some("environment.prepare_purge_cleanup"),
        _ => None,
    };
    CapabilityContribution {
        capability:key(id, if id == source::STATUS { 1 } else { 2 }),
        kind:if operation { CapabilityKind::Operation } else { CapabilityKind::Query }, title:title.into(),
        description:match id {
            source::PLAN => "Create an immutable native pak/renv plan in isolated material storage. Preserve the complete result as an original-operation resource; do not install into user libraries.",
            source::REALIZE => "Resolve an authorized successful plan and realize it in an isolated library. Verify native source and lockfile digests; do not change existing R sessions.",
            source::VERIFY => "Explicitly verify one authorized realization using native namespace probes and library digests. Preserve the complete original report.",
            source::RECONCILE => "Inspect and clean up the native process tree of one terminal original Environment operation. Keep its records and staged files; never repeat the installation.",
            source::REFRESH => "Explicitly establish native R configuration for later read-only inventory queries. This operation may launch R; observation and activation do not.",
            source::OBSERVE => "Read cached native configuration and bounded DESCRIPTION metadata. Requires an authorized successful source for a selected realization; never launch R, load packages or recover native work.",
            source::LIBRARY => "Select an authorized original realization, checking managed library identity and content digest without starting R or loading packages. Explicit native verification remains required before session creation.",
            source::RETENTION | source::CLEANUP_STATUS => "Inspect exact original staging and quarantine references. Successful, live, uncertain, inaccessible or incompletely observed references retain material; observation never starts R or reconciles work.",
            source::CLEANUP => "Quarantine eligible failed or cancelled original material after bounded project, result and live R reference checks. Revalidate the preview fingerprint, owned directory and native process absence before moving files.",
            source::RESTORE => "Restore one exact original quarantine after rechecking its source, references and fingerprint. Do not replace an occupied staging path or repeat the original installation.",
            source::PURGE => "Permanently remove one eligible original quarantine after rechecking its source, references and fingerprint. Preserve original Operations and reports; deleting material does not roll back scientific effects.",
            _ => "Observe configured activity or qualify explicit work without starting R or installing packages.",
        }.into(), input_schema:input, output_schema:output, examples:vec![example],
        recovery_schema:if operation { schema_for!(EnvironmentRecovery).to_value() } else { json!({"type":"null"}) },
        required_scopes:source::scopes(id),
        effects:if source::material_operation(id) { ["environment.materials", "artifact.create"].map(str::to_owned).into() } else if operation { ["process.spawn", "environment.materials", "artifact.create"].into_iter().chain(matches!(id, source::PLAN | source::REALIZE | source::VERIFY).then_some("network")).map(str::to_owned).collect() } else { Default::default() },
        cancellation:if operation && id != source::RECONCILE && !source::material_operation(id) { CancellationSupport::Request } else { CancellationSupport::Unsupported },
        preflight:prepare.map(|id|key(id,2)),
    }
}
pub fn manifest() -> PluginManifest {
    let mut capabilities = vec![
        contribution(
            source::RETENTION,
            schema_for!(EnvironmentSourceArguments).to_value(),
            schema_for!(RetentionView).to_value(),
            json!({"operation_id":"original-environment"}),
            "Inspect original material retention",
        ),
        contribution(
            source::CLEANUP_STATUS,
            schema_for!(EnvironmentTrashArguments).to_value(),
            schema_for!(RetentionView).to_value(),
            json!({"cleanup_operation_id":"original-quarantine"}),
            "Inspect original quarantine",
        ),
        contribution(
            source::STATUS,
            schema_for!(Empty).to_value(),
            schema_for!(EnvironmentStatus).to_value(),
            json!({}),
            "Observe Environment activity",
        ),
        contribution(
            source::LIBRARY,
            schema_for!(VerifyArguments).to_value(),
            schema_for!(EnvironmentLibrary).to_value(),
            json!({"realization_operation_id":"original-realization"}),
            "Select a realized Environment library",
        ),
        contribution(
            source::OBSERVE,
            schema_for!(ObserveArguments).to_value(),
            schema_for!(EnvironmentSnapshot).to_value(),
            json!({"limit":100}),
            "Inspect Environment inventory",
        ),
    ];
    for (id, input, example, title, prepare) in [
        (
            source::CLEANUP,
            schema_for!(EnvironmentCleanupArguments).to_value(),
            json!({"operation_id":"original-environment","expected_fingerprint":format!("sha256:{}","0".repeat(64))}),
            "Quarantine original material",
            "environment.prepare_cleanup",
        ),
        (
            source::RESTORE,
            schema_for!(EnvironmentChangeTrashArguments).to_value(),
            json!({"cleanup_operation_id":"original-quarantine","expected_fingerprint":format!("sha256:{}","0".repeat(64))}),
            "Restore original material",
            "environment.prepare_restore_cleanup",
        ),
        (
            source::PURGE,
            schema_for!(EnvironmentChangeTrashArguments).to_value(),
            json!({"cleanup_operation_id":"original-quarantine","expected_fingerprint":format!("sha256:{}","0".repeat(64))}),
            "Purge original quarantine",
            "environment.prepare_purge_cleanup",
        ),
        (
            source::PLAN,
            schema_for!(PlanArguments).to_value(),
            json!({"manager":"pak","packages":["local::pkg"]}),
            "Plan an isolated Environment",
            "environment.prepare_plan",
        ),
        (
            source::REALIZE,
            schema_for!(RealizeArguments).to_value(),
            json!({"plan_operation_id":"original-plan"}),
            "Realize an isolated Environment",
            "environment.prepare_realize",
        ),
        (
            source::VERIFY,
            schema_for!(VerifyArguments).to_value(),
            json!({"realization_operation_id":"original-realization"}),
            "Verify a realized Environment",
            "environment.prepare_verify",
        ),
        (
            source::RECONCILE,
            schema_for!(ReconcileArguments).to_value(),
            json!({"operation_id":"original-environment"}),
            "Reconcile original Environment work",
            "environment.prepare_reconcile",
        ),
        (
            source::REFRESH,
            schema_for!(Empty).to_value(),
            json!({}),
            "Observe native Environment configuration",
            "environment.prepare_refresh",
        ),
    ] {
        capabilities.push(contribution(
            id,
            input,
            schema_for!(EnvironmentResult).to_value(),
            example.clone(),
            title,
        ));
        capabilities.push(contribution(
            prepare,
            schema_for!(PluginPreflightRequest).to_value(),
            schema_for!(PluginPreflightResult).to_value(),
            json!({"capability":key(id,2),"arguments":example,"target":null,"preconditions":null}),
            &format!("Prepare: {title}"),
        ));
    }
    PluginManifest {
        protocol_version:PLUGIN_PROTOCOL_VERSION, id:PluginId::new("org.rho.environment").unwrap(), name:"Environment".into(), version:"0.1.0".into(),
        description:"Isolated pak/renv plans, realizations, explicit verification and original-operation native recovery".into(), license:"AGPL-3.0-only".into(),
        source:SourceDeclaration { files:[PackagePath::new("backend/src/main.rs").unwrap(), PackagePath::new("build.mjs").unwrap()].into(), lockfiles:[PackagePath::new("Cargo.lock").unwrap()].into(), build_instructions:PackagePath::new("BUILD.md").unwrap(), build:Some(BuildRecipe { command:vec!["node".into(),"build.mjs".into()] }) },
        dependencies:Default::default(), requires:vec![CapabilityRequirement { capability:key("operation.get",1), scopes:["operation.read".into()].into() }, CapabilityRequirement { capability:key("resources.read",1), scopes:["resources.read".into()].into() }],
        optional_requires:vec![
            CapabilityRequirement { capability:key("r.capture_attempt",1), scopes:["workspace.read", "operation.read", "plugins.read", "project.references.read"].map(str::to_owned).into() },
            CapabilityRequirement { capability:key("r.checkpoint",1), scopes:["workspace.read", "operation.read", "resources.read", "project.references.read"].map(str::to_owned).into() },
            CapabilityRequirement { capability:key("r.checkpoint_control",1), scopes:["workspace.read", "operation.read", "resources.read", "project.references.read"].map(str::to_owned).into() },
            CapabilityRequirement { capability:key("operation.project_coverage",1), scopes:["operation.read".into(),"project.references.read".into()].into() },
            CapabilityRequirement { capability:key("plugins.project_coverage",1), scopes:["plugins.read".into(),"project.references.read".into()].into() },
        ].into_iter().chain([
            ("operation.list_recent","operation.read"), ("operation.events_checkpoint","operation.read"),
            ("plugins.instances","plugins.read"), ("plugins.inspect","plugins.read"),
            ("r.session","workspace.read"), ("r.snapshot","workspace.read"),
        ].map(|(id,scope)|CapabilityRequirement {capability:key(id,1),scopes:[scope.into()].into()})).collect(),
        capabilities, views:vec![], contexts:vec![], backend:Some(BackendEntrypoint { executable:PackagePath::new("dist/rho-environment-backend").unwrap(), arguments:vec![] }),
        configuration_schema:schema_for!(EnvironmentConfiguration).to_value(), default_configuration:json!(EnvironmentConfiguration::default()),
    }
}
