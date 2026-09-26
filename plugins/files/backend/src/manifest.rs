use rho_files_api::*;
use rho_plugin_sdk::protocol::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct FilesViewConfiguration {
    editor: Option<InstanceRef>,
    editor_group: Option<String>,
}
fn capability(id: &str, input: Value, output: Value, example: Value) -> CapabilityContribution {
    let operation = id == "files.apply_patch";
    let mut required_scopes = [PROJECT_READ_SCOPE.into()].into();
    if operation || id == "files.prepare_patch" {
        std::collections::BTreeSet::insert(&mut required_scopes, PROJECT_WRITE_SCOPE.into());
    }
    CapabilityContribution {
        capability: CapabilityKey { id: ContributionId::new(id).unwrap(), version: 1 },
        kind: if operation { CapabilityKind::Operation } else { CapabilityKind::Query },
        title: match id {
            "files.apply_patch" => "Apply a file patch", "files.prepare_patch" => "Prepare a file patch",
            "files.snapshot" => "Observe project files and Git", "files.read_file" => "Read file bytes",
            "files.read_text" => "Read file lines", "files.search_text" => "Search file contents",
            "files.list_directory" => "List a directory", "files.search_files" => "Find files",
            "files.storage_status" => "Observe project disk capacity", _ => unreachable!(),
        }.into(), description: if operation { "Apply one native project patch using explicit file/Git preconditions; preserve uncertain effects and original settlement. Does not commit Git." } else { "Bounded Files observation in this exact project/provider. Does not start a scientific runtime or install software." }.into(),
        input_schema: input, examples: vec![example], output_schema: output,
        recovery_schema: if operation { schema_for!(ProjectPatchRecovery).to_value() } else { json!({"type":"null"}) },
        required_scopes, effects: if operation { ["project.files".into(), "process.spawn".into()].into() } else { Default::default() },
        cancellation: CancellationSupport::Unsupported,
        preflight: operation.then(|| CapabilityKey { id: ContributionId::new("files.prepare_patch").unwrap(), version: 1 }),
    }
}
pub fn manifest() -> PluginManifest {
    let patch = "diff --git a/example.txt b/example.txt\nnew file mode 100644\n--- /dev/null\n+++ b/example.txt\n@@ -0,0 +1 @@\n+Example\n";
    let capabilities = vec![
        capability(
            "files.storage_status",
            schema_for!(Empty).to_value(),
            schema_for!(ProjectStorage).to_value(),
            json!({}),
        ),
        capability(
            "files.list_directory",
            schema_for!(ListDirectoryArguments).to_value(),
            schema_for!(DirectoryPage).to_value(),
            json!({"path":"","limit":200}),
        ),
        capability(
            "files.search_files",
            schema_for!(SearchFilesArguments).to_value(),
            schema_for!(FileSearchResult).to_value(),
            json!({"text":"analysis","show_hidden":false}),
        ),
        capability(
            "files.snapshot",
            schema_for!(ProjectSnapshotArguments).to_value(),
            schema_for!(ProjectSnapshot).to_value(),
            json!({"paths":["analysis.R"],"limit":100}),
        ),
        capability(
            "files.read_file",
            schema_for!(ReadFileArguments).to_value(),
            schema_for!(FilePage).to_value(),
            json!({"path":"analysis.R","limit_bytes":32768}),
        ),
        capability(
            "files.read_text",
            schema_for!(ReadTextArguments).to_value(),
            schema_for!(TextPage).to_value(),
            json!({"path":"analysis.R","start_line":1,"limit_lines":100}),
        ),
        capability(
            "files.search_text",
            schema_for!(SearchTextArguments).to_value(),
            schema_for!(SearchTextPage).to_value(),
            json!({"text":"plot","limit_matches":20}),
        ),
        capability(
            "files.prepare_patch",
            schema_for!(PluginPreflightRequest).to_value(),
            schema_for!(PluginPreflightResult).to_value(),
            json!({"capability":{"id":"files.apply_patch","version":1},"arguments":{"patch":patch},"target":null,"preconditions":[]}),
        ),
        capability(
            "files.apply_patch",
            schema_for!(ApplyPatchArguments).to_value(),
            schema_for!(ProjectPatchResult).to_value(),
            json!({"patch":patch}),
        ),
    ];
    PluginManifest {
        protocol_version: PLUGIN_PROTOCOL_VERSION,
        id: PluginId::new("org.rho.files").unwrap(),
        name: "Files".into(),
        version: "0.1.0".into(),
        description: "Contained project files, bounded text observations and explicit Git patches"
            .into(),
        license: "AGPL-3.0-only".into(),
        source: SourceDeclaration {
            files: [
                PackagePath::new("backend/src/main.rs").unwrap(),
                PackagePath::new("build.mjs").unwrap(),
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
        requires: [
            ("workspace.paths", vec![PROJECT_READ_SCOPE]),
            ("files.list_directory", vec![PROJECT_READ_SCOPE]),
            ("files.search_files", vec![PROJECT_READ_SCOPE]),
            ("files.storage_status", vec![PROJECT_READ_SCOPE]),
            ("files.snapshot", vec![PROJECT_READ_SCOPE]),
            ("windows.layout", vec!["plugins.run"]),
            // Navigation can delegate only these declared scopes, intersected
            // with its caller. Editor still declares and receives its own exact
            // capability grants; Files gets no direct draft/file-write grant.
            ("windows.open_view", vec!["plugins.run", "project.read", "project.write", "documents.read", "documents.write", "operation.read"]),
            ("operation.get", vec!["operation.read"]),
            ("operation.list_recent", vec!["operation.read"]),
        ]
        .into_iter()
        .map(|(id, scopes)| CapabilityRequirement {
            capability: CapabilityKey {
                id: ContributionId::new(id).unwrap(),
                version: 1,
            },
            scopes: scopes.into_iter().map(String::from).collect(),
        })
        .collect(),
        optional_requires: vec![],
        capabilities,
        views: vec![ViewContribution {
            id: ContributionId::new("files").unwrap(),
            title: "Files".into(),
            entrypoint: PackagePath::new("dist/ui/index.html").unwrap(),
            state_schema: json!({"type":"object","properties":{"files":{"type":"object"},"actions":{"type":["object","null"]}},"additionalProperties":false}),
            configuration_schema: schema_for!(FilesViewConfiguration).to_value(),
            resource_kinds: Default::default(),
        }],
        contexts: vec![],
        backend: Some(BackendEntrypoint {
            executable: PackagePath::new("dist/rho-files-backend").unwrap(),
            arguments: vec![],
        }),
        configuration_schema: schema_for!(Empty).to_value(),
        default_configuration: json!({}),
    }
}
