//! Optional native management ports. Declarations neither select a tool for Send
//! nor authorize proceeding from a checkpoint to build, preview or application.
use rho_plugin_sdk::protocol::*;

pub(crate) fn requirements() -> Vec<CapabilityRequirement> {
    let scopes = [
        "operation.read",
        "project.references.read",
        "application.read",
        "application.control",
        "skill.read",
        "plugins.read",
        "plugins.write",
        "plugins.run",
        "resources.read",
        "documents.read",
        "documents.write",
        "workspace.run_r",
        "workspace.read",
        "project.read",
        "project.write",
        "environment.read",
        "environment.write",
        "process.run_local",
        "remote.execute",
        "slurm.read",
        "slurm.write",
    ];
    let groups: &[(&[&str], &[&str])] = &[
        (
            &["plugins.read"],
            &[
                "host.core_contract",
                "plugins.list",
                "plugins.branches",
                "plugins.branch_head",
                "plugins.source_tree",
                "plugins.read_source",
                "plugins.check_source",
                "plugins.compare",
                "plugins.instances",
                "plugins.instance",
                "scenarios.list",
                "scenarios.get",
            ],
        ),
        (
            &["plugins.write"],
            &[
                "plugins.branch",
                "plugins.checkpoint",
                "plugins.advance_branch",
                "plugins.remove",
                "scenarios.checkpoint",
            ],
        ),
        (
            &["plugins.run"],
            &[
                "plugins.preview",
                "plugins.release",
                "plugins.reconcile_references",
                "windows.layout",
                "windows.scenario",
                "windows.update_layout",
                "views.inspect",
                "views.close",
            ],
        ),
        (&["plugins.write", "plugins.run"], &["plugins.build"]),
        (
            &scopes,
            &[
                "plugins.activate",
                "views.open",
                "windows.open_view",
                "scenarios.prepare",
                "scenarios.apply",
            ],
        ),
    ];
    groups
        .iter()
        .flat_map(|(scopes, names)| {
            names.iter().map(move |name| CapabilityRequirement {
                capability: super::manifest::key(name),
                scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
            })
        })
        .collect()
}
