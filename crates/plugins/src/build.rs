//! Build immutable source in a fresh native working directory. The Operation journal
//! owns completion; retained files are recovery evidence, never another result store.
use crate::*;
use rho_plugin_protocol::*;
use rho_process_engine::{ProcessOptions, run_command};
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

pub(crate) struct PreparedBuild {
    revision: PluginRevision,
    directory: PathBuf,
}

pub(crate) fn build_directory(root: &Path, operation: &str) -> PathBuf {
    root.join("builds-v1")
        .join(&content_digest(operation.as_bytes()).as_str()[7..])
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), PluginError> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist_noclobber(path).map_err(|error| error.error)?;
    Ok(())
}

impl PreparedBuild {
    pub(crate) fn prepare(
        repo: &PluginRepository,
        revision: &RevisionId,
        operation: &str,
    ) -> Result<Self, PluginError> {
        let revision = repo.revision(revision)?;
        ensure(
            revision.manifest.source.build.is_some(),
            "source has no build recipe",
        )?;
        let directory = build_directory(repo.root(), operation);
        fs::create_dir_all(directory.parent().unwrap())?;
        ensure(
            !directory
                .parent()
                .unwrap()
                .symlink_metadata()?
                .file_type()
                .is_symlink(),
            "build directory cannot be a symlink",
        )?;
        // An accepted original Operation is never rerun, including after a lost receipt.
        fs::create_dir(&directory)?;
        write_new(
            &directory.join("request.json"),
            &serde_json::to_vec(&json!({
                "operation_id": operation, "revision": revision.id,
                "command": revision.manifest.source.build.as_ref().unwrap().command,
                "automatic_reexecution": false
            }))?,
        )?;
        let source = directory.join("source");
        fs::create_dir(&source)?;
        let mut total = 0u64;
        for (path, file) in &revision.files {
            total = total
                .checked_add(file.bytes)
                .ok_or_else(|| PluginError::Invalid("source size overflow".into()))?;
            ensure(total <= MAX_PACKAGE_BYTES, "source exceeds build quota")?;
            let bytes = repo.blob(&file.digest)?;
            ensure(
                bytes.len() as u64 == file.bytes,
                "source file length mismatch",
            )?;
            let destination = source.join(path.as_str());
            fs::create_dir_all(destination.parent().unwrap())?;
            write_new(&destination, &bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    destination,
                    fs::Permissions::from_mode(if file.executable { 0o755 } else { 0o644 }),
                )?;
            }
        }
        Ok(Self {
            revision,
            directory,
        })
    }

    pub(crate) async fn run(
        self,
        operation: &str,
        timeout_ms: u64,
        cancellation: watch::Receiver<bool>,
    ) -> Result<FinishedBuild, PluginError> {
        let recipe = self.revision.manifest.source.build.as_ref().unwrap();
        let mut command = Command::new(&recipe.command[0]);
        command
            .args(&recipe.command[1..])
            .current_dir(self.directory.join("source"))
            .env_clear();
        // Existing compiler/cache locations only. No Host tokens, plugin grants or
        // arbitrary inherited application credentials are forwarded to the recipe.
        for key in [
            "PATH",
            "HOME",
            "TMPDIR",
            "TMP",
            "TEMP",
            "SystemRoot",
            "USERPROFILE",
            "RUSTUP_HOME",
            "CARGO_HOME",
            "RUSTC",
            "RUSTDOC",
            "RHO_PLUGIN_CARGO",
            "RHO_PLUGIN_NODE_MODULES",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("RUSTUP_AUTO_INSTALL", "0")
            .env("CARGO_NET_OFFLINE", "true")
            .env("RHO_BUILD_OPERATION_ID", operation);
        let report = run_command(
            command,
            ProcessOptions {
                timeout: Duration::from_millis(timeout_ms),
                output_limit_bytes: 16 * 1024,
                stdin: None,
            },
            cancellation,
        )
        .await?;
        write_new(
            &self.directory.join("process.json"),
            &serde_json::to_vec(&report)?,
        )?;
        Ok(FinishedBuild {
            prepared: self,
            report,
        })
    }
}

pub(crate) struct FinishedBuild {
    prepared: PreparedBuild,
    pub(crate) report: ProcessReport,
}
impl FinishedBuild {
    pub(crate) fn archive(&self) -> Result<PluginArchive, PluginError> {
        ensure(
            self.report.termination == ProcessTermination::Exited
                && self.report.exit_code == Some(0),
            "build command did not succeed",
        )?;
        let revision = &self.prepared.revision;
        let target = if revision.manifest.backend.is_some() {
            backend_target()
        } else {
            "ui-web".into()
        };
        let archive = snapshot_directory(
            &self.prepared.directory.join("source"),
            revision.parent.clone(),
            &target,
        )?;
        ensure(
            archive.revision.id == revision.id,
            "build changed declared source; create a source checkpoint before building again",
        )?;
        ensure(archive.artifacts.len() == 1, "build produced no artifact")?;
        Ok(archive)
    }
    pub(crate) fn record_candidate(&self, artifact: &ArtifactId) -> Result<(), PluginError> {
        write_new(
            &self.prepared.directory.join("artifact.json"),
            &serde_json::to_vec(&json!({
                "revision": self.prepared.revision.id, "artifact": artifact,
                "meaning": "Validated candidate. Inspect the original Operation and repository for authoritative commitment."
            }))?,
        )
    }
}

/// Import requires the original immutable revision to remain retained. It never
/// advances a branch, starts an instance or changes any window's selected providers.
pub(crate) fn commit_build(
    repository: &Arc<Mutex<PluginRepository>>,
    archive: &PluginArchive,
) -> Result<(), PluginError> {
    let mut repository = repository.lock().unwrap();
    repository.revision(&archive.revision.id)?;
    repository.import(archive)?;
    Ok(())
}
