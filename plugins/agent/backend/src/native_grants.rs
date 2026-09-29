//! Explicit optional grants for ordinary scientific providers. These declarations
//! never activate a provider or select a tool: activation chooses grants, and each
//! Send still captures exact user-selected bindings and the original call scopes.
use rho_plugin_sdk::protocol::*;

pub(crate) fn scientific_requirements() -> Vec<CapabilityRequirement> {
    let groups: &[(&[&str], &[(&str, u32)])] = &[
        (
            &["application.read", "plugins.read"],
            &[
                ("annotations.read", 1),
                ("annotations.context.search", 1),
                ("annotations.context.preview", 1),
                ("annotations.capture.read", 1),
            ],
        ),
        (
            &["application.control", "plugins.read"],
            &[("annotations.write", 1)],
        ),
        (
            &["application.control", "plugins.read", "resources.read"],
            &[("annotations.capture.import", 1)],
        ),
        (
            &["documents.read"],
            &[("editor.context.preview", 1), ("editor.context.search", 1)],
        ),
        (
            &["operation.read", "resources.read", "workspace.read"],
            &[
                ("r.context.console.preview", 1),
                ("r.context.console.search", 1),
                ("r.context.plots.preview", 1),
                ("r.context.plots.search", 1),
                ("r.context.viewer.preview", 1),
                ("r.context.viewer.search", 1),
            ],
        ),
        (
            &[
                "environment.read",
                "environment.write",
                "operation.read",
                "project.read",
                "resources.read",
                "workspace.run_r",
            ],
            &[("r.create_session", 2), ("r.prepare_environment", 2)],
        ),
        (
            &[
                "environment.read",
                "operation.read",
                "plugins.read",
                "project.read",
                "project.references.read",
                "resources.read",
                "workspace.read",
            ],
            &[
                ("environment.cleanup_status", 2),
                ("environment.retention", 2),
            ],
        ),
        (
            &[
                "environment.read",
                "operation.read",
                "project.read",
                "resources.read",
            ],
            &[("environment.library", 2), ("environment.observe", 2)],
        ),
        (
            &["environment.read", "project.read"],
            &[("environment.status", 1)],
        ),
        (
            &[
                "environment.write",
                "operation.read",
                "plugins.read",
                "project.read",
                "project.references.read",
                "resources.read",
                "workspace.read",
            ],
            &[
                ("environment.cleanup", 2),
                ("environment.prepare_cleanup", 2),
                ("environment.prepare_purge_cleanup", 2),
                ("environment.prepare_restore_cleanup", 2),
                ("environment.purge_cleanup", 2),
                ("environment.restore_cleanup", 2),
            ],
        ),
        (
            &["environment.write", "operation.read", "project.read"],
            &[
                ("environment.prepare_reconcile", 2),
                ("environment.reconcile", 2),
            ],
        ),
        (
            &[
                "environment.write",
                "operation.read",
                "project.read",
                "resources.read",
            ],
            &[
                ("environment.prepare_realize", 2),
                ("environment.prepare_verify", 2),
                ("environment.realize", 2),
                ("environment.verify", 2),
            ],
        ),
        (
            &["environment.write", "project.read"],
            &[
                ("environment.plan", 2),
                ("environment.prepare_plan", 2),
                ("environment.prepare_refresh", 2),
                ("environment.refresh", 2),
            ],
        ),
        (
            &[
                "operation.read",
                "plugins.read",
                "project.references.read",
                "workspace.read",
            ],
            &[("r.capture_attempt", 1)],
        ),
        (
            &[
                "operation.read",
                "plugins.read",
                "project.references.read",
                "workspace.read",
                "workspace.run_r",
            ],
            &[("r.discard_capture", 1), ("r.prepare_capture_disposal", 1)],
        ),
        (
            &["operation.read", "process.run_local", "project.read"],
            &[("process.prepare_reconcile", 2), ("process.reconcile", 2)],
        ),
        (
            &["operation.read", "project.read", "slurm.read"],
            &[("slurm.snapshot", 2)],
        ),
        (
            &["operation.read", "project.read", "slurm.write"],
            &[
                ("slurm.prepare_cancel", 2),
                ("slurm.prepare_reconcile", 2),
                ("slurm.reconcile", 2),
                ("slurm.request_cancel", 2),
            ],
        ),
        (
            &[
                "operation.read",
                "project.references.read",
                "resources.read",
                "workspace.read",
            ],
            &[
                ("r.checkpoint", 1),
                ("r.checkpoint_control", 1),
                ("r.read_checkpoint", 1),
            ],
        ),
        (
            &[
                "operation.read",
                "project.references.read",
                "resources.read",
                "workspace.read",
                "workspace.run_r",
            ],
            &[
                ("r.delete_checkpoint", 1),
                ("r.delete_checkpoint", 2),
                ("r.pin_checkpoint", 1),
                ("r.pin_checkpoint", 2),
                ("r.purge_checkpoint", 1),
                ("r.restore_checkpoint", 1),
            ],
        ),
        (
            &[
                "operation.read",
                "resources.read",
                "workspace.read",
                "workspace.run_r",
            ],
            &[("r.reconcile_checkpoint", 1)],
        ),
        (
            &["operation.read", "workspace.read"],
            &[("r.checkpoints", 1)],
        ),
        (
            &["process.run_local", "project.read"],
            &[("process.prepare_local", 2), ("process.run_local", 2)],
        ),
        (
            &["project.read"],
            &[
                ("files.list_directory", 1),
                ("files.read_file", 1),
                ("files.read_text", 1),
                ("files.search_files", 1),
                ("files.search_text", 1),
                ("files.snapshot", 1),
                ("files.storage_status", 1),
                ("process.status", 1),
                ("remote.status", 1),
            ],
        ),
        (
            &["project.read", "project.write"],
            &[("files.apply_patch", 1), ("files.prepare_patch", 1)],
        ),
        (
            &["project.read", "remote.execute"],
            &[("process.prepare_remote", 2), ("process.run_remote", 2)],
        ),
        (
            &["project.read", "slurm.write"],
            &[("slurm.prepare_submit", 2), ("slurm.submit", 2)],
        ),
        (
            &["workspace.read"],
            &[
                ("r.context.objects.preview", 1),
                ("r.context.objects.search", 1),
                ("r.context.help.preview", 1),
                ("r.context.help.search", 1),
                ("r.check_code", 1),
                ("r.console", 1),
                ("r.inspect_object", 1),
                ("r.inspection_state", 1),
                ("r.list_objects", 1),
                ("r.observe_object", 1),
                ("r.output_events", 1),
                ("r.package_index", 1),
                ("r.packages", 1),
                ("r.read_help", 1),
                ("r.read_object", 1),
                ("r.session", 1),
                ("r.snapshot", 1),
            ],
        ),
        (
            &["workspace.run_r"],
            &[
                ("r.capture_checkpoint", 1),
                ("r.create_session", 1),
                ("r.execute", 1),
                ("r.execute", 2),
                ("r.format", 1),
                ("r.prepare", 1),
                ("r.prepare_checkpoint", 1),
            ],
        ),
    ];
    groups
        .iter()
        .flat_map(|(scopes, capabilities)| {
            capabilities
                .iter()
                .map(move |(name, version)| CapabilityRequirement {
                    capability: CapabilityKey {
                        id: ContributionId::new(*name).unwrap(),
                        version: *version,
                    },
                    scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
                })
        })
        .collect()
}
