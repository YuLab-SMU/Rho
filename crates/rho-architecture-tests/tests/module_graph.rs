use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use serde_json::Value as JsonValue;
use toml::Value as TomlValue;

const TARGET_CRATES: &[&str] = &[
    "rho-protocol",
    "rho-store",
    "rho-artifact-store",
    "rho-secret-broker",
    "rho-sandbox",
    "rho-event-hub",
    "rho-execution",
    "rho-control-plane",
    "rho-agent-host",
    "rho-workspace",
    "rho-runner",
    "rho-test-support",
    "rho-telemetry",
    "rho-ui-contract",
];

const NEW_BOUNDARY_CRATES: &[&str] = &[
    "rho-artifact-store",
    "rho-secret-broker",
    "rho-sandbox",
    "rho-execution",
    "rho-control-plane",
    "rho-agent-host",
    "rho-workspace",
    "rho-runner",
    "rho-test-support",
    "rho-telemetry",
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("architecture test crate is under crates/")
        .to_path_buf()
}

fn read_toml(path: impl AsRef<Path>) -> TomlValue {
    let path = path.as_ref();
    let content = std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!("failed to read {}: {error}", path.display());
    });
    content.parse::<TomlValue>().unwrap_or_else(|error| {
        panic!("failed to parse {}: {error}", path.display());
    })
}

fn crate_manifest(crate_name: &str) -> TomlValue {
    read_toml(
        repo_root()
            .join("crates")
            .join(crate_name)
            .join("Cargo.toml"),
    )
}

fn table_keys(value: Option<&TomlValue>) -> BTreeSet<String> {
    value
        .and_then(TomlValue::as_table)
        .map(|table| table.keys().cloned().collect())
        .unwrap_or_default()
}

fn dependency_names(manifest: &TomlValue) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
        names.extend(table_keys(manifest.get(section)));
    }
    if let Some(targets) = manifest.get("target").and_then(TomlValue::as_table) {
        for target in targets.values() {
            for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
                names.extend(table_keys(target.get(section)));
            }
        }
    }
    names
}

fn target_dependency_allowlist() -> BTreeMap<&'static str, BTreeSet<&'static str>> {
    BTreeMap::from([
        ("rho-protocol", BTreeSet::new()),
        ("rho-store", BTreeSet::from(["rho-protocol"])),
        ("rho-artifact-store", BTreeSet::from(["rho-protocol"])),
        ("rho-secret-broker", BTreeSet::from(["rho-protocol"])),
        ("rho-sandbox", BTreeSet::from(["rho-protocol"])),
        ("rho-event-hub", BTreeSet::from(["rho-protocol"])),
        ("rho-execution", BTreeSet::from(["rho-protocol"])),
        (
            "rho-control-plane",
            BTreeSet::from([
                "rho-protocol",
                "rho-store",
                "rho-artifact-store",
                "rho-sandbox",
                "rho-secret-broker",
                "rho-execution",
            ]),
        ),
        (
            "rho-agent-host",
            BTreeSet::from(["rho-protocol", "rho-control-plane"]),
        ),
        (
            "rho-workspace",
            BTreeSet::from(["rho-protocol", "rho-control-plane", "rho-execution"]),
        ),
        (
            "rho-runner",
            BTreeSet::from(["rho-protocol", "rho-artifact-store", "rho-execution"]),
        ),
        ("rho-test-support", BTreeSet::from(["rho-protocol"])),
        ("rho-telemetry", BTreeSet::from(["rho-protocol"])),
        ("rho-ui-contract", BTreeSet::from(["rho-protocol"])),
    ])
}

#[test]
fn workspace_members_include_target_crates_and_architecture_tests() {
    let root_manifest = read_toml(repo_root().join("Cargo.toml"));
    let members = root_manifest["workspace"]["members"]
        .as_array()
        .expect("workspace.members is an array")
        .iter()
        .map(|value| value.as_str().expect("member is a string").to_string())
        .collect::<BTreeSet<_>>();

    for crate_name in TARGET_CRATES
        .iter()
        .chain(std::iter::once(&"rho-architecture-tests"))
    {
        assert!(
            members.contains(&format!("crates/{crate_name}")),
            "workspace must include crates/{crate_name}"
        );
    }
}

#[test]
fn target_dependency_graph_allows_only_declared_edges() {
    let target_names = TARGET_CRATES.iter().copied().collect::<BTreeSet<_>>();
    let allowlist = target_dependency_allowlist();

    for crate_name in TARGET_CRATES {
        let manifest = crate_manifest(crate_name);
        let deps = dependency_names(&manifest);
        let forbidden = deps
            .iter()
            .filter_map(|dependency| {
                let dependency = dependency.as_str();
                if target_names.contains(dependency) && !allowlist[crate_name].contains(dependency)
                {
                    Some(dependency.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        assert!(
            forbidden.is_empty(),
            "{crate_name} has target dependency edges outside the frozen graph: {forbidden:?}"
        );
    }
}

#[test]
fn protocol_crate_has_no_adapter_runtime_or_authority_dependency() {
    let manifest = crate_manifest("rho-protocol");
    let deps = dependency_names(&manifest);
    for forbidden in [
        "rusqlite",
        "tokio-rusqlite",
        "tauri",
        "tauri-specta",
        "rho-agent-transport",
        "rho-server",
        "rho-control-plane",
        "rho-execution",
        "rho-store",
    ] {
        assert!(
            !deps.contains(forbidden),
            "rho-protocol must remain pure and not depend on {forbidden}"
        );
    }
}

#[test]
fn no_new_legacy_compat_or_archive_crates_are_introduced() {
    let root_manifest = read_toml(repo_root().join("Cargo.toml"));
    let members = root_manifest["workspace"]["members"]
        .as_array()
        .expect("workspace.members is an array");
    for member in members {
        let member = member.as_str().expect("member is a string");
        let lowered = member.to_ascii_lowercase();
        for banned in ["legacy", "compat", "archive", "v_old"] {
            assert!(
                !lowered.contains(banned),
                "workspace member {member} must not introduce a {banned} crate"
            );
        }
    }
}

#[test]
fn new_target_crates_define_narrow_boundary_surfaces() {
    for crate_name in NEW_BOUNDARY_CRATES {
        let source_path = repo_root()
            .join("crates")
            .join(crate_name)
            .join("src/lib.rs");
        let source = std::fs::read_to_string(&source_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", source_path.display()));
        assert!(
            source.contains("#![forbid(unsafe_code)]"),
            "{crate_name} must forbid unsafe"
        );
        assert!(
            source.contains("pub fn boundary"),
            "{crate_name} must expose only a narrow boundary marker until implementation packages own behavior"
        );
        assert!(
            source.contains("does_not_own"),
            "{crate_name} boundary must state non-ownership"
        );
        for banned in ["TODO", "fallback", "compat", "legacy adapter"] {
            assert!(
                !source.contains(banned),
                "{crate_name} boundary must not introduce {banned}"
            );
        }
    }
}

#[test]
fn deletion_map_covers_old_agent_control_paths_without_compatibility() {
    let map_path = repo_root().join("crates/rho-architecture-tests/fixtures/deletion-map.json");
    let content = std::fs::read_to_string(&map_path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", map_path.display()));
    let map: JsonValue = serde_json::from_str(&content).expect("deletion map is valid JSON");
    assert_eq!(map["schema_version"], 2);
    assert_eq!(map["program_id"], "rho-rebuild");
    assert_eq!(map["policy"]["clean_replacement"], true);
    assert_eq!(map["policy"]["compatibility_layers_allowed"], false);
    assert_eq!(map["policy"]["archive_directories_allowed"], false);

    let old_responsibilities = map["old_responsibilities"]
        .as_array()
        .expect("old_responsibilities is an array");
    let forbidden_edges = map["forbidden_edges"]
        .as_array()
        .expect("forbidden_edges is an array");
    let all_entries = old_responsibilities.iter().chain(forbidden_edges.iter());

    for entry in all_entries {
        assert_eq!(entry["compatibility_allowed"], false, "{entry:#}");
        assert!(
            entry["replacement_owner"]
                .as_str()
                .is_some_and(|value| !value.is_empty()),
            "every deleted responsibility needs exactly one replacement owner: {entry:#}"
        );
        assert!(
            entry["delete_work_package"]
                .as_str()
                .is_some_and(|value| value.starts_with('P')),
            "every deleted responsibility needs a package that removes the old path: {entry:#}"
        );
    }

    let mapped_text = content;
    for required in [
        "App.tsx::fixture-root",
        "AgentSurfaceView.tsx::Ask/Plan/Act-selector",
        "AgentSurfaceVNext.tsx::fixture-production-entry",
        "workbench_vnext.rs::fixture-backed-command",
        "jobs/mod.rs::fixture-backed-command",
        "production App -> AGENT_UX_SUCCESS_FIXTURE",
        "MCP -> authority/store direct read",
        "ACP -> remote execution",
    ] {
        assert!(
            mapped_text.contains(required),
            "deletion map must cover old responsibility {required}"
        );
    }
}

#[test]
fn production_integration_preserves_workbench_and_replaces_only_agent_experience() {
    let root = repo_root();
    for required in [
        "desktop/ui/src/app/App.tsx",
        "desktop/ui/src/app/WorkbenchApp.tsx",
        "desktop/ui/src/app/SurfaceView.tsx",
        "desktop/ui/src/app/startup/StartupLedgerView.tsx",
        "desktop/ui/src/app/AgentSurfaceView.tsx",
        "desktop/src-tauri/src/main.rs",
    ] {
        assert!(
            root.join(required).is_file(),
            "full Workbench path is missing: {required}"
        );
    }

    let app_source = std::fs::read_to_string(root.join("desktop/ui/src/app/App.tsx")).unwrap();
    for required in [
        "createStartupController",
        "StartupLedgerView",
        "WorkbenchApp",
    ] {
        assert!(
            app_source.contains(required),
            "production App must retain {required}"
        );
    }
    for forbidden in [
        "AGENT_UX_SUCCESS_FIXTURE",
        "AgentSurfaceVNext",
        "workbenchVNextFixture",
    ] {
        assert!(
            !app_source.contains(forbidden),
            "production App must not mount fixture path {forbidden}"
        );
    }

    let workbench_source =
        std::fs::read_to_string(root.join("desktop/ui/src/app/WorkbenchApp.tsx")).unwrap();
    let surface_router =
        std::fs::read_to_string(root.join("desktop/ui/src/app/SurfaceView.tsx")).unwrap();
    assert!(workbench_source.contains("<SurfaceView"));
    assert!(surface_router.contains("<AgentSurfaceView"));

    let agent_source =
        std::fs::read_to_string(root.join("desktop/ui/src/app/AgentSurfaceView.tsx")).unwrap();
    for required in [
        "Autonomous goal loop",
        "Goal-driven scientific work",
        "Observe → plan → request effect → re-observe",
        "listAgentConversations",
        "subscribeAgentTurnEvents",
    ] {
        assert!(
            agent_source.contains(required),
            "Agent integration is missing {required}"
        );
    }
    for removed_mode_surface in [
        "className=\"rho-agent-mode\"",
        "Ask about this project",
        "Shape a reviewable approach",
        "Work with project tools",
    ] {
        assert!(
            !agent_source.contains(removed_mode_surface),
            "autonomous Agent retained user mode surface {removed_mode_surface}"
        );
    }

    for fixture_harness in [
        "desktop/src-tauri/src/commands/agent/workbench_vnext.rs",
        "desktop/src-tauri/src/commands/jobs/mod.rs",
    ] {
        let source = std::fs::read_to_string(root.join(fixture_harness)).unwrap();
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert!(
            !production.contains("#[tauri::command]"),
            "fixture-backed harness must not register a production command: {fixture_harness}"
        );
    }
}
