use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use serde_json::Value as JsonValue;
use toml::Value as TomlValue;

const TARGET_CRATES: &[&str] = &[
    "rho-protocol",
    "rho-store",
    "rho-evidence-graph",
    "rho-environment",
    "rho-artifact-store",
    "rho-secret-broker",
    "rho-sandbox",
    "rho-execution",
    "rho-control-plane",
    "rho-acp-client",
    "rho-workspace",
    "rho-runner",
    "rho-ui-contract",
];

const NEW_BOUNDARY_CRATES: &[&str] = &[
    "rho-artifact-store",
    "rho-secret-broker",
    "rho-sandbox",
    "rho-execution",
    "rho-environment",
    "rho-control-plane",
    "rho-acp-client",
    "rho-workspace",
    "rho-runner",
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
        ("rho-evidence-graph", BTreeSet::from(["rho-protocol"])),
        ("rho-environment", BTreeSet::from(["rho-protocol"])),
        ("rho-artifact-store", BTreeSet::from(["rho-protocol"])),
        ("rho-secret-broker", BTreeSet::from(["rho-protocol"])),
        ("rho-sandbox", BTreeSet::from(["rho-protocol"])),
        ("rho-execution", BTreeSet::from(["rho-protocol"])),
        (
            "rho-control-plane",
            BTreeSet::from(["rho-protocol", "rho-sandbox"]),
        ),
        ("rho-acp-client", BTreeSet::new()),
        ("rho-workspace", BTreeSet::from(["rho-protocol"])),
        ("rho-runner", BTreeSet::from(["rho-protocol"])),
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
fn rebuild_deleted_legacy_environment_and_evidence_owners() {
    let root = repo_root();
    for removed in [
        "crates/rho-toolchain",
        "desktop/src-tauri/src/commands/toolchain.rs",
        "desktop/src-tauri/src/commands/resource_monitor.rs",
        "desktop/src-tauri/src/commands/remote_connection.rs",
        "desktop/ui/src/app/EnvironmentSurfaceView.tsx",
        "desktop/ui/src/app/EnvironmentSurfaceView.test.tsx",
        "desktop/ui/src/app/environment-presentation.ts",
        "desktop/ui/src/app/environment-presentation.test.ts",
    ] {
        assert!(
            !root.join(removed).exists(),
            "retired Environment owner remains: {removed}"
        );
    }
    let manifests = [
        std::fs::read_to_string(root.join("Cargo.toml")).unwrap(),
        std::fs::read_to_string(root.join("Cargo.lock")).unwrap(),
        std::fs::read_to_string(root.join("desktop/src-tauri/Cargo.toml")).unwrap(),
    ]
    .join("\n");
    assert!(!manifests.contains("rho-toolchain"));
    let generated =
        std::fs::read_to_string(root.join("desktop/ui/src/transport/generated/environment.ts"))
            .unwrap();
    for removed in [
        "toolchainDoctor",
        "resourceMonitorSnapshot",
        "computeTargetList",
        "remoteConnectionProbe",
        "configureSshTarget",
        "listInstalledPackages",
        "listEnvironmentOperationRequests",
    ] {
        assert!(
            !generated.contains(removed),
            "legacy Environment command remains: {removed}"
        );
    }
    let graph_contracts = [
        std::fs::read_to_string(root.join("crates/rho-ui-contract/src/evidence_graph.rs")).unwrap(),
        std::fs::read_to_string(root.join("desktop/ui/src/transport/generated/evidence-graph.ts"))
            .unwrap(),
        std::fs::read_to_string(root.join("desktop/ui/src/transport/evidence-graph.ts")).unwrap(),
    ]
    .join("\n");
    for removed in ["EvidenceClaim", "EvidenceEntry", "EvidenceReadTransport"] {
        assert!(
            !graph_contracts.contains(removed),
            "legacy Evidence concept remains: {removed}"
        );
    }

    let legacy_environment_surfaces = [
        std::fs::read_to_string(
            root.join("crates/rho-server/src/coordinator/workspace_protocol.rs"),
        )
        .unwrap(),
        std::fs::read_to_string(root.join("r/rho.bridge/R/workspace.R")).unwrap(),
        std::fs::read_to_string(root.join("r/rho.bridge/NAMESPACE")).unwrap(),
        std::fs::read_to_string(root.join("crates/rho-store/src/migration.rs")).unwrap(),
    ]
    .join("\n");
    for removed in [
        "initialize_project_environment",
        "restore_project_environment",
        "snapshot_project_environment",
        "install_project_package",
        "update_project_package",
        "remove_project_package",
        "rho_environment_operation",
        "rho_environment_package_preview",
        "environment_operation_requests",
    ] {
        assert!(
            !legacy_environment_surfaces.contains(removed),
            "legacy live-Workspace Environment write surface remains: {removed}"
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
fn retired_in_process_agent_runtime_is_absent() {
    let root = repo_root();
    for removed in [
        "r/rho.agent",
        "crates/rho-agent-host",
        "crates/rho-agent-transport",
    ] {
        assert!(
            !root.join(removed).exists(),
            "retired in-process Agent path remains: {removed}"
        );
    }
    let manifests = [
        std::fs::read_to_string(root.join("Cargo.toml")).unwrap(),
        std::fs::read_to_string(root.join("Cargo.lock")).unwrap(),
        std::fs::read_to_string(root.join("desktop/src-tauri/Cargo.toml")).unwrap(),
        std::fs::read_to_string(root.join("crates/rho-server/Cargo.toml")).unwrap(),
    ]
    .join("\n");
    for crate_name in ["rho-agent-host", "rho-agent-transport"] {
        assert!(
            !manifests.contains(crate_name),
            "retired Agent crate remains in workspace manifests: {crate_name}"
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
fn authority_owners_do_not_depend_on_the_evidence_graph() {
    for crate_name in [
        "rho-store",
        "rho-artifact-store",
        "rho-secret-broker",
        "rho-sandbox",
        "rho-execution",
        "rho-control-plane",
        "rho-workspace",
        "rho-runner",
    ] {
        let dependencies = dependency_names(&crate_manifest(crate_name));
        assert!(
            !dependencies.contains("rho-evidence-graph"),
            "authority owner {crate_name} must not depend on rho-evidence-graph"
        );
    }
}

#[test]
fn public_authority_runtime_types_do_not_use_evidence_names() {
    for crate_name in TARGET_CRATES {
        if matches!(*crate_name, "rho-evidence-graph" | "rho-ui-contract") {
            continue;
        }
        let source_root = repo_root().join("crates").join(crate_name).join("src");
        let mut pending = vec![source_root];
        while let Some(path) = pending.pop() {
            for entry in std::fs::read_dir(&path).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                if path.extension().and_then(|value| value.to_str()) != Some("rs") {
                    continue;
                }
                let source = std::fs::read_to_string(&path).unwrap();
                for line in source.lines().map(str::trim) {
                    let name = ["pub struct ", "pub enum ", "pub type "]
                        .into_iter()
                        .find_map(|prefix| line.strip_prefix(prefix))
                        .and_then(|rest| {
                            rest.split(|character: char| {
                                !(character.is_ascii_alphanumeric() || character == '_')
                            })
                            .next()
                        });
                    assert!(
                        !name.is_some_and(|name| name.contains("Evidence")),
                        "public authority/runtime type uses reserved Evidence name in {}: {line}",
                        path.display()
                    );
                }
            }
        }
    }
}

#[test]
fn desktop_registers_graph_commands_from_the_graph_module_only() {
    let root = repo_root();
    assert!(
        root.join("desktop/src-tauri/src/commands/evidence_graph.rs")
            .is_file()
    );
    assert!(
        !root
            .join("desktop/src-tauri/src/commands/evidence.rs")
            .exists()
    );
    let commands =
        std::fs::read_to_string(root.join("desktop/src-tauri/src/commands/mod.rs")).unwrap();
    assert!(commands.contains("mod evidence_graph"));
    assert!(commands.contains("mod authority"));
    assert!(
        !commands
            .lines()
            .any(|line| line.trim() == "pub(crate) mod evidence;")
    );
    let graph_commands =
        std::fs::read_to_string(root.join("desktop/src-tauri/src/commands/evidence_graph.rs"))
            .unwrap();
    let authority_commands =
        std::fs::read_to_string(root.join("desktop/src-tauri/src/commands/authority.rs")).unwrap();
    for command in ["authority_resolve_refs", "authority_list_receipts"] {
        assert!(
            authority_commands.contains(command),
            "Authority command module is missing {command}"
        );
        assert!(
            !graph_commands.contains(&format!("fn {command}")),
            "Evidence Graph command module retained Authority command {command}"
        );
    }
}

#[test]
fn frontend_semantic_ports_remain_directional_and_typed() {
    let root = repo_root().join("desktop/ui/src/app");
    let authority = read_tree(&root.join("authority"));
    assert!(
        !authority.contains("transport/evidence-graph"),
        "Authority surfaces must not import Evidence Graph ports"
    );
    let evidence = read_tree(&root.join("evidence"));
    for forbidden in [
        "transport/history",
        "transport/environment",
        "transport/agent-execution",
    ] {
        assert!(
            !evidence.contains(forbidden),
            "Evidence surfaces must not import authority mutation/read implementation {forbidden}"
        );
    }
    let agent = read_tree(&root.join("agent"));
    for forbidden in [".promoteDraft(", ".retirePromotedRecord("] {
        assert!(
            !agent.contains(forbidden),
            "Agent surface leaked Evidence promotion capability: {forbidden}"
        );
    }
    assert!(
        !agent.contains("UiKernelTransport"),
        "Agent semantic modules accept the renderer mega transport"
    );
    for (name, source) in [
        ("authority", authority.as_str()),
        ("evidence", evidence.as_str()),
    ] {
        assert!(
            !source.contains("UiKernelTransport"),
            "{name} semantic modules accept the renderer mega transport"
        );
    }
    let surface_router = std::fs::read_to_string(root.join("workbench/SurfaceRouter.tsx")).unwrap();
    for forbidden in ["UiKernelTransport", "as EvidenceGraphTransport"] {
        assert!(
            !surface_router.contains(forbidden),
            "SurfaceRouter retained broad/cast transport boundary {forbidden}"
        );
    }
    let graph_transport =
        std::fs::read_to_string(repo_root().join("desktop/ui/src/transport/evidence-graph.ts"))
            .unwrap();
    assert!(
        !graph_transport.contains("AuthorityReadTransport"),
        "EvidenceGraphTransport still contains Authority reads"
    );
    let generated_graph = std::fs::read_to_string(
        repo_root().join("desktop/ui/src/transport/generated/evidence-graph.ts"),
    )
    .unwrap();
    for forbidden in ["authority_status", "authority_observed_at"] {
        assert!(
            !generated_graph.contains(forbidden),
            "graph renderer projection retained cached Authority fact {forbidden}"
        );
    }
    for forbidden in [
        "request_type.toLowerCase",
        "provenance_complete ? \"present\"",
    ] {
        assert!(
            !authority.contains(forbidden),
            "Authority renderer retained local fact heuristic {forbidden}"
        );
    }
    let authority_vocab = authority
        .to_ascii_lowercase()
        .replace("create_supported", "");
    for forbidden in ["supported", "contradicted", "disputed", "evidence gap"] {
        assert!(
            !authority_vocab.contains(forbidden),
            "Authority renderer claims graph-owned vocabulary {forbidden}"
        );
    }
    let agent_ports = std::fs::read_to_string(root.join("workbench/agentPorts.ts")).unwrap();
    for forbidden in [
        "reobserveEnvironment",
        "configureSshTarget",
        "promoteDraft",
        "environment.request_apply_plan",
    ] {
        assert!(
            !agent_ports.contains(forbidden),
            "Agent port facade retained direct mutation authority {forbidden}"
        );
    }
    let evidence_production = read_tree_without_tests(&root.join("evidence"));
    for forbidden in [
        "authority: succeeded",
        "authority: completed",
        "authority: committed",
    ] {
        assert!(
            !evidence_production.to_ascii_lowercase().contains(forbidden),
            "Evidence renderer hard-codes Authority outcome {forbidden}"
        );
    }
    let generic = std::fs::read_to_string(root.join("DomainSurfaceView.tsx")).unwrap();
    for forbidden in [
        "rho.runs",
        "rho.jobs",
        "rho.artifacts",
        "rho.approvals",
        "rho.revisions",
        "rho.environment",
        "rho.claims",
        "rho.evidence-graph",
        "rho.evidence-gaps",
        "rho.claim-trace",
        "rho.plots",
        "rho.problems",
    ] {
        assert!(
            !generic.contains(forbidden),
            "generic DomainSurfaceView retained semantic surface {forbidden}"
        );
    }
}

#[test]
fn frontend_composition_roots_shrink_behind_owned_modules() {
    let root = repo_root().join("desktop/ui/src/app");
    for (relative, maximum_lines) in [
        ("workbench/WorkbenchRoot.tsx", 2_800),
        ("workbench/SurfaceFrame.tsx", 680),
        ("agent/AgentSurface.tsx", 500),
    ] {
        let source = std::fs::read_to_string(root.join(relative)).unwrap();
        let lines = source.lines().count();
        assert!(
            lines <= maximum_lines,
            "{relative} regrew to {lines} lines after its owned modules were extracted (limit {maximum_lines})"
        );
    }
    for relative in [
        "console/ConsoleSurface.tsx",
        "workbench/WorkbenchChrome.tsx",
        "workbench/workbenchAdmission.ts",
        "authority/RunsSurface.tsx",
        "authority/JobsSurface.tsx",
        "authority/ArtifactsSurface.tsx",
        "authority/RevisionsSurface.tsx",
        "authority/EnvironmentHealthPanel.tsx",
    ] {
        assert!(
            root.join(relative).is_file(),
            "missing extracted frontend owner {relative}"
        );
    }
}

fn read_tree(root: &Path) -> String {
    let mut output = String::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("ts" | "tsx")
            ) {
                output.push_str(&std::fs::read_to_string(path).unwrap());
            }
        }
    }
    output
}

fn read_tree_without_tests(root: &Path) -> String {
    let mut output = String::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("ts" | "tsx")
            ) && !path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.contains(".test."))
            {
                output.push_str(&std::fs::read_to_string(path).unwrap());
            }
        }
    }
    output
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
        "MCP -> Store/Authority implementation",
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
        "desktop/ui/src/app/workbench/WorkbenchRoot.tsx",
        "desktop/ui/src/app/workbench/SurfaceFrame.tsx",
        "desktop/ui/src/app/startup/StartupLedgerView.tsx",
        "desktop/ui/src/app/agent/AgentSurface.tsx",
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
        "WorkbenchRoot",
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
        std::fs::read_to_string(root.join("desktop/ui/src/app/workbench/WorkbenchRoot.tsx"))
            .unwrap();
    let surface_router =
        std::fs::read_to_string(root.join("desktop/ui/src/app/workbench/SurfaceFrame.tsx"))
            .unwrap();
    assert!(workbench_source.contains("<SurfaceFrame"));
    assert!(surface_router.contains("<AgentSurface"));

    let agent_source =
        std::fs::read_to_string(root.join("desktop/ui/src/app/agent/AgentSurface.tsx")).unwrap();
    for required in [
        "listAgentConversations",
        "subscribeAgentTurnEvents",
        "runConversation",
        "rho-agent-stream-item",
        "Observe → plan → request effect → re-observe",
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
        "rho-agent-approval",
        "respondAgentApproval",
        "rho-agent-context-preview",
    ] {
        assert!(
            !agent_source.contains(removed_mode_surface),
            "Agent surface gates instead of observing: {removed_mode_surface}"
        );
    }
    for deleted_section in [
        "agent/AgentApprovalPanel.tsx",
        "agent/AgentActivity.tsx",
        "agent/AgentEvidencePanel.tsx",
        "agent/AgentEnvironmentPanel.tsx",
    ] {
        assert!(
            !root
                .join(format!("desktop/ui/src/app/{deleted_section}"))
                .exists(),
            "Agent gating or duplicated exposure section was reintroduced: {deleted_section}"
        );
    }

    for deleted_fixture_harness in [
        "desktop/src-tauri/src/commands/agent/workbench_vnext.rs",
        "desktop/src-tauri/src/commands/jobs/mod.rs",
    ] {
        assert!(
            !root.join(deleted_fixture_harness).exists(),
            "fixture-backed harness remains: {deleted_fixture_harness}"
        );
    }
}

#[test]
fn external_agent_receives_rho_state_and_live_owner_capabilities_without_policy_gating() {
    let root = repo_root();
    let acp = std::fs::read_to_string(root.join("crates/rho-acp-client/src/lib.rs")).unwrap();
    for required in [
        "FileSystemCapabilities",
        "CreateTerminalRequest",
        "with_stdio_mcp_server",
        "RequestPermissionOutcome::Selected",
    ] {
        assert!(
            acp.contains(required),
            "ACP client exposure is missing {required}"
        );
    }
    let mcp = std::fs::read_to_string(root.join("crates/rho-mcp/src/lib.rs")).unwrap();
    for required in [
        "rho_capabilities",
        "rho_state",
        "rho_execute",
        "RHO_AGENT_GATEWAY_TOKEN",
    ] {
        assert!(
            mcp.contains(required),
            "Rho MCP exposure is missing {required}"
        );
    }
    let gateway =
        std::fs::read_to_string(root.join("desktop/src-tauri/src/agent_gateway.rs")).unwrap();
    for required in [
        "dispatch_workspace_request",
        "environment_health_for_state",
        "CapabilityRegistry::canonical",
        "monitor.observe",
    ] {
        assert!(
            gateway.contains(required),
            "Agent Gateway is missing {required}"
        );
    }
    for forbidden in [
        "evaluate_policy",
        "BrokerAdmissionOutcome",
        "PatchApprovalBinding",
        "request_permission",
    ] {
        assert!(
            !gateway.contains(forbidden),
            "Agent Gateway reintroduced a Rho-owned gate: {forbidden}"
        );
    }
}
