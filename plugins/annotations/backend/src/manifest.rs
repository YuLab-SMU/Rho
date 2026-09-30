use crate::arguments::*;
use rho_annotation_api::*;
use rho_plugin_sdk::protocol::*;
use schemars::schema_for;
use serde_json::{Value, json};
pub fn key(id: &str) -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new(id).unwrap(),
        version: 1,
    }
}
pub fn is_operation(id: &str) -> Option<bool> {
    match id {
        "annotations.write" | "annotations.capture.import" => Some(true),
        "annotations.read"
        | "annotations.context.search"
        | "annotations.context.preview"
        | "annotations.capture.read" => Some(false),
        _ => None,
    }
}
fn requirement(id: &str, scopes: &[&str]) -> CapabilityRequirement {
    CapabilityRequirement {
        capability: key(id),
        scopes: scopes.iter().map(|s| s.to_string()).collect(),
    }
}
fn capability(
    id: &str,
    input_schema: Value,
    output_schema: Value,
    example: Value,
) -> CapabilityContribution {
    let operation = is_operation(id) == Some(true);
    let mut scopes = [
        if operation {
            "application.control"
        } else {
            "application.read"
        }
        .into(),
        "plugins.read".into(),
    ]
    .into_iter()
    .collect::<std::collections::BTreeSet<_>>();
    if id == "annotations.capture.import" {
        scopes.insert("resources.read".into());
    }
    CapabilityContribution {
        capability: key(id), kind: if operation { CapabilityKind::Operation } else { CapabilityKind::Query }, title: id.into(),
        description: if operation { "Freeze a complete owner-contributed source or append an annotation revision with an original request receipt and CAS. Quotes use offsets within the selected preview inclusion. Source image references remain references; a captured-view anchor must refer to a separately imported, validated capture. Does not modify scientific content, start a runtime, or send to an Agent." } else { "Read principal/project-scoped annotation records and frozen evidence without observing a live source or starting a runtime. Exact historical note revisions stay readable; current source status remains unknown." }.into(),
        input_schema, output_schema, examples: vec![example], recovery_schema: json!(true),
        required_scopes: scopes,
        effects: if operation { ["annotations.metadata".into()].into() } else { Default::default() },
        cancellation: CancellationSupport::Unsupported, preflight: None,
    }
}
pub fn manifest() -> PluginManifest {
    let example_ref = json!({"provider":{"plugin":"org.rho.annotations","instance":"annotations-example","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},"contribution":"annotations","window":"window-example","selector":{"annotation_id":"annotation-example","revision":1}});
    let mut preview = schema_for!(PreviewContext).to_value();
    preview["properties"]["inclusion"] = json!({"oneOf":[{"title":"Note and frozen text evidence","type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"note_and_evidence"}}},{"title":"Note, evidence and captured image","type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"note_evidence_and_image"}}}]});
    PluginManifest {
        protocol_version: PLUGIN_PROTOCOL_VERSION,
        id: PluginId::new("org.rho.annotations").unwrap(),
        name: "Annotations".into(),
        version: "0.1.0".into(),
        description: "Version-bound notes and owner-contributed frozen text evidence".into(),
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
        requires: vec![
            requirement("views.caller", &["plugins.read"]),
            requirement("plugins.inspect", &["plugins.read"]),
            requirement("annotations.read", &["application.read", "plugins.read"]),
            requirement("annotations.write", &["application.control", "plugins.read"]),
        ],
        optional_requires: vec![
            requirement("plugins.instances", &["plugins.read"]),
            requirement("plugins.resolve", &["plugins.read"]),
            requirement("windows.layout", &["plugins.run"]),
            requirement("windows.update_layout", &["plugins.run"]),
            requirement("windows.open_view", &[
                "application.control", "application.read", "documents.read", "documents.write",
                "environment.read", "environment.write", "operation.read", "plugins.read",
                "plugins.run", "plugins.write", "process.run_local", "project.read",
                "project.references.read", "project.write", "remote.execute", "resources.read",
                "skill.read", "slurm.read", "slurm.write", "workspace.read", "workspace.run_r",
            ]),
            requirement("annotations.capture.import", &["application.control", "plugins.read", "resources.read"]),
            requirement("annotations.capture.read", &["application.read", "plugins.read"]),
            requirement("annotations.context.preview", &["application.read", "plugins.read"]),
            requirement("workspace.paths", &["project.read"]),
            requirement("files.read_text", &["project.read"]),
            requirement("operation.get", &["operation.read"]),
            requirement("operation.list_recent", &["operation.read"]),
            requirement("resources.read", &["resources.read"]),
            requirement("editor.context.search", &["documents.read"]),
            requirement("editor.context.preview", &["documents.read"]),
            requirement("files.context.search", &["project.read"]),
            requirement("files.context.preview", &["project.read"]),
            requirement("r.context.help.search", &["workspace.read"]),
            requirement("r.context.help.preview", &["workspace.read"]),
            requirement("r.context.objects.search", &["workspace.read"]),
            requirement("r.context.objects.preview", &["workspace.read"]),
            requirement("r.context.packages.search", &["workspace.read"]),
            requirement("r.context.packages.preview", &["workspace.read"]),
            requirement("r.context.console.search", &["workspace.read", "operation.read", "resources.read"]),
            requirement("r.context.console.preview", &["workspace.read", "operation.read", "resources.read"]),
            requirement("r.context.plots.search", &["workspace.read", "operation.read", "resources.read"]),
            requirement("r.context.plots.preview", &["workspace.read", "operation.read", "resources.read"]),
            requirement("r.context.viewer.search", &["workspace.read", "operation.read", "resources.read"]),
            requirement(
                "r.context.viewer.preview",
                &["workspace.read", "operation.read", "resources.read"],
            ),
        ],
        capabilities: vec![
            capability(
                "annotations.write",
                schema_for!(WriteRequest).to_value(),
                schema_for!(AnnotationCommandReceipt).to_value(),
                json!({"request_id":"create-note","command":{"kind":"create","evidence_id":"frozen-source","note":"Review this result","labels":[],"marks":[],"continued_from":null}}),
            ),
            capability(
                "annotations.read",
                schema_for!(ReadRequest).to_value(),
                schema_for!(AnnotationQueryResult).to_value(),
                json!({"kind":"list","limit":20,"include_deleted":false}),
            ),
            capability(
                "annotations.context.search",
                schema_for!(ContextSearch).to_value(),
                schema_for!(ContextPage).to_value(),
                json!({"window":"window-example","text":"","after":null,"limit":20}),
            ),
            capability(
                "annotations.context.preview",
                preview,
                schema_for!(ContextPreview).to_value(),
                json!({"reference":example_ref,"inclusion":{"kind":"note_and_evidence"},"max_bytes":16384}),
            ),
            {
                let mut descriptor = capability(
                    "annotations.capture.import",
                    schema_for!(CaptureImport).to_value(),
                    schema_for!(AnnotationCommandReceipt).to_value(),
                    json!({"request_id":"capture-resource","reference":{"owner":{"plugin":"org.rho.annotations","instance":"annotations-example","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},"resource":"image-example","digest":format!("sha256:{}","c".repeat(64)),"media_type":"image/png","bytes":123}}),
                );
                descriptor.description = "Import a scoped immutable PNG/JPEG resource (at most 8 MiB) as a captured view, validating bytes, digest and decoded dimensions. Exact retries retain the receipt without rereading the source. Does not claim original scientific media or start a runtime.".into();
                descriptor
            },
            {
                let mut descriptor = capability(
                    "annotations.capture.read",
                    schema_for!(CaptureRead).to_value(),
                    schema_for!(CaptureChunk).to_value(),
                    json!({"capture":{"capture_id":"capture-example","sha256":format!("sha256:{}","c".repeat(64)),"width":3,"height":2,"mime_type":"image/png","byte_size":123,"original_media":false},"offset":0,"limit":65536}),
                );
                descriptor.description = "Read up to 64 KiB of one exact retained capture without observing its original source or starting a runtime.".into();
                descriptor
            },
        ],
        views: vec![ViewContribution {
            id: ContributionId::new("annotations").unwrap(),
            title: "Annotations".into(),
            entrypoint: PackagePath::new("dist/src/index.html").unwrap(),
            state_schema: json!({"type":"object","additionalProperties":true}),
            configuration_schema: schema_for!(AnnotationViewConfiguration).to_value(),
            resource_kinds: Default::default(),
        }],
        contexts: vec![ContextContribution {
            id: ContributionId::new("annotations").unwrap(),
            title: "Saved annotations".into(),
            search: key("annotations.context.search"),
            preview: key("annotations.context.preview"),
        }],
        backend: Some(BackendEntrypoint {
            executable: PackagePath::new("dist/rho-annotation-backend").unwrap(),
            arguments: vec![],
        }),
        configuration_schema: schema_for!(Empty).to_value(),
        default_configuration: json!({}),
    }
}
