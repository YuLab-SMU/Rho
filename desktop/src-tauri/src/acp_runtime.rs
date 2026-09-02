use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs,
    path::Path,
};

use anyhow::{Context, Result};
use rho_acp_client::{AcpProcessSpec, VerifiedAcpSandbox, discover_external_acp_agent};
use rho_protocol::ProjectRevision;
use rho_sandbox::snapshot::{SnapshotLimits, build_project_snapshot};

pub(crate) struct PreparedAcpTurn {
    _root: tempfile::TempDir,
    pub(crate) process: AcpProcessSpec,
    pub(crate) provider_label: String,
}

pub(crate) fn prepare_acp_turn(
    data_dir: &Path,
    project_root: &str,
    project_revision: u64,
    process_path: &OsStr,
) -> Result<PreparedAcpTurn> {
    let parent = data_dir.join("acp-turns");
    fs::create_dir_all(&parent)?;
    let root = tempfile::Builder::new()
        .prefix("turn-")
        .tempdir_in(parent)?;
    let working_directory = root.path().join("workspace");
    let scratch_home = root.path().join("home");
    let temporary = root.path().join("tmp");
    fs::create_dir_all(&working_directory)?;
    fs::create_dir_all(&scratch_home)?;
    fs::create_dir_all(&temporary)?;

    let snapshot = build_project_snapshot(
        project_root,
        ProjectRevision(project_revision),
        SnapshotLimits::default(),
    )
    .context("building the disposable ACP project snapshot")?;
    for entry in &snapshot.manifest().files {
        let destination = working_directory.join(&entry.relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = snapshot
            .read(&entry.relative_path)
            .with_context(|| format!("snapshot bytes disappeared for {}", entry.relative_path))?;
        fs::write(destination, bytes)?;
    }

    let discovered =
        discover_external_acp_agent(process_path).context("No supported ACP Agent is installed")?;
    let mut environment = BTreeMap::from([
        (
            "PATH".to_string(),
            process_path.to_string_lossy().into_owned(),
        ),
        (
            "HOME".to_string(),
            scratch_home.to_string_lossy().into_owned(),
        ),
        (
            "TMPDIR".to_string(),
            temporary.to_string_lossy().into_owned(),
        ),
    ]);
    for key in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "SSL_CERT_FILE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
    ] {
        if let Ok(value) = std::env::var(key)
            && !value.is_empty()
        {
            environment.insert(key.to_string(), value);
        }
    }
    let process = AcpProcessSpec {
        executable: discovered.executable,
        arguments: discovered.arguments,
        environment,
        sandbox: VerifiedAcpSandbox {
            working_directory,
            authoritative_project_mounted: false,
            workspace_socket_mounted: false,
            store_mounted: false,
            secret_store_mounted: false,
            network_denied: false,
        },
    };
    process.validate()?;
    Ok(PreparedAcpTurn {
        _root: root,
        process,
        provider_label: discovered.display_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_agent_resolution_never_falls_back_to_an_in_process_model_runtime() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join(if cfg!(windows) {
            "claude-code-acp.exe"
        } else {
            "claude-code-acp"
        });
        fs::write(&executable, b"external").unwrap();
        let discovered = discover_external_acp_agent(directory.path().as_os_str()).unwrap();
        assert_eq!(discovered.executable, executable.canonicalize().unwrap());
        assert_eq!(discovered.display_name, "Claude Code ACP");
    }
}
