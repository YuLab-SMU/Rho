use clap::Subcommand;
use rho_plugin_protocol::{BranchId, RevisionId};
use rho_plugins::{PluginError, PluginRepository, read_archive, snapshot_directory};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub fn default_store() -> PathBuf {
    if let Some(root) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(root).join("rho/plugins-v1");
    }
    if let Some(root) = std::env::var_os("HOME") {
        return PathBuf::from(root).join("Library/Application Support/rho/plugins-v1");
    }
    PathBuf::from(".rho-plugins-v1")
}

#[derive(Debug, Subcommand)]
pub enum PluginCommand {
    /// Observe installed versions. An absent repository remains absent.
    List {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        after: Option<String>,
    },
    Inspect {
        revision: String,
    },
    /// Validate an immutable local .rho-plugin archive before importing it.
    Import {
        archive: PathBuf,
    },
    /// Snapshot declared source and existing dist/ files; does not build or run.
    Snapshot {
        directory: PathBuf,
        #[arg(long, default_value = "ui-web")]
        target: String,
        #[arg(long)]
        parent: Option<String>,
    },
    Export {
        revision: String,
        destination: PathBuf,
    },
    /// Remove an unreferenced version; reports all protecting references.
    Remove {
        revision: String,
    },
    Branch {
        revision: String,
        name: String,
    },
    BranchHead {
        branch: String,
    },
    Diff {
        before: String,
        after: String,
    },
    AdvanceBranch {
        branch: String,
        expected: String,
        next: String,
    },
    /// Validate package content without installing or executing it.
    Validate {
        archive: PathBuf,
    },
}

fn observe(root: &Path) -> Result<PluginRepository, PluginError> {
    PluginRepository::observe(root)?.ok_or_else(|| PluginError::Missing("repository".into()))
}

pub fn run(root: &Path, command: &PluginCommand) -> Result<Value, PluginError> {
    match command {
        PluginCommand::List { limit, after } => {
            if !(1..=100).contains(limit) {
                return Err(PluginError::Invalid(
                    "catalog page size must be 1–100".into(),
                ));
            }
            let after = after.as_ref().map(RevisionId::new).transpose()?;
            Ok(json!(match PluginRepository::observe(root)? {
                Some(repo) => repo.list_page(after.as_ref(), *limit)?,
                None => rho_plugin_protocol::PluginRevisionPage {
                    revisions: vec![],
                    next: None,
                    total: 0
                },
            }))
        }
        PluginCommand::Inspect { revision } => {
            Ok(json!(observe(root)?.inspect(&RevisionId::new(revision)?)?))
        }
        PluginCommand::Import { archive } => {
            let archive = read_archive(archive)?;
            Ok(json!(PluginRepository::open(root)?.import(&archive)?))
        }
        PluginCommand::Snapshot {
            directory,
            target,
            parent,
        } => {
            let archive = snapshot_directory(
                directory,
                parent.as_ref().map(RevisionId::new).transpose()?,
                target,
            )?;
            Ok(json!(PluginRepository::open(root)?.import(&archive)?))
        }
        PluginCommand::Export {
            revision,
            destination,
        } => {
            observe(root)?.export_file(&RevisionId::new(revision)?, destination)?;
            Ok(json!({"path":destination}))
        }
        PluginCommand::Remove { revision } => {
            // Do not create a repository for a missing removal target.
            let _ = observe(root)?.inspect(&RevisionId::new(revision)?)?;
            PluginRepository::open(root)?.remove(&RevisionId::new(revision)?)?;
            Ok(json!({"removed":revision}))
        }
        PluginCommand::Branch { revision, name } => {
            let revision = RevisionId::new(revision)?;
            observe(root)?.inspect(&revision)?;
            Ok(json!({"branch":PluginRepository::open(root)?.create_branch(&revision, name)?}))
        }
        PluginCommand::BranchHead { branch } => {
            Ok(json!({"revision":observe(root)?.branch_head(&BranchId::new(branch)?)?}))
        }
        PluginCommand::Diff { before, after } => Ok(json!(
            observe(root)?.compare(&RevisionId::new(before)?, &RevisionId::new(after)?)?
        )),
        PluginCommand::AdvanceBranch {
            branch,
            expected,
            next,
        } => {
            let branch = BranchId::new(branch)?;
            observe(root)?.branch_head(&branch)?;
            PluginRepository::open(root)?.advance_branch(
                &branch,
                &RevisionId::new(expected)?,
                &RevisionId::new(next)?,
            )?;
            Ok(json!({"revision":next}))
        }
        PluginCommand::Validate { archive } => {
            let package = read_archive(archive)?;
            Ok(json!({"revision":package.revision.id,"valid":true}))
        }
    }
}
