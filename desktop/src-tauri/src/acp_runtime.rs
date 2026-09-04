use std::{collections::BTreeMap, ffi::OsStr, fs, path::Path};

use anyhow::{Context, Result};
use rho_acp_client::{
    AcpClientExposure, AcpProcessSpec, VerifiedAcpSandbox, discover_external_acp_agent,
};
use rho_protocol::{ProjectRevision, WorkspaceIdentity};
use rho_sandbox::snapshot::{
    ProjectSnapshot, ProjectSnapshotDelta, SnapshotLimits, build_project_snapshot,
    diff_project_snapshot,
};

pub(crate) struct PreparedAcpTurn {
    _root: tempfile::TempDir,
    snapshot: ProjectSnapshot,
    snapshot_limits: SnapshotLimits,
    pub(crate) process: AcpProcessSpec,
    pub(crate) exposure: AcpClientExposure,
    pub(crate) provider_label: String,
}

impl PreparedAcpTurn {
    pub(crate) fn workspace_delta(&self) -> Result<ProjectSnapshotDelta> {
        diff_project_snapshot(
            &self.snapshot,
            &self.process.sandbox.working_directory,
            self.snapshot_limits.clone(),
        )
        .context("capturing external ACP Agent Workspace changes")
    }

    pub(crate) fn commit_staging_root(&self) -> std::path::PathBuf {
        self._root.path().join("project-commit-staging")
    }

    pub(crate) fn retain_for_reconciliation(self) -> std::path::PathBuf {
        self._root.keep()
    }
}

pub(crate) fn prepare_acp_turn(
    data_dir: &Path,
    project_root: &str,
    workspace_identity: &WorkspaceIdentity,
    exposed_state: serde_json::Value,
    mcp_environment: BTreeMap<String, String>,
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

    let snapshot_limits = SnapshotLimits::default();
    let snapshot = build_project_snapshot(
        project_root,
        ProjectRevision(workspace_identity.project_revision),
        snapshot_limits.clone(),
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
    let context_path = root.path().join("rho-agent-state.json");
    let context_bytes = serde_json::to_vec(&serde_json::json!({
        "schema": "rho.agent-state.v1",
        "project": {
            "root": project_root,
            "revision": workspace_identity.project_revision,
        },
        "workspace": workspace_identity,
        "snapshot": snapshot.manifest(),
        "state": exposed_state,
    }))?;
    anyhow::ensure!(
        context_bytes.len() as u64 <= rho_mcp::MAX_RHO_MCP_CONTEXT_BYTES,
        "Rho Agent state exceeds the MCP context bound"
    );
    fs::write(&context_path, context_bytes)?;

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
    let exposure = AcpClientExposure::workspace_snapshot().with_stdio_mcp_server(
        "rho",
        std::env::current_exe().context("locating the Rho executable for MCP")?,
        vec![
            "--rho-mcp-stdio".to_string(),
            "--rho-mcp-context".to_string(),
            context_path.to_string_lossy().into_owned(),
        ],
        mcp_environment,
    );
    Ok(PreparedAcpTurn {
        _root: root,
        snapshot,
        snapshot_limits,
        process,
        exposure,
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

    #[test]
    fn prepared_turn_retains_the_baseline_needed_to_capture_agent_changes() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let data = directory.path().join("data");
        let bin = directory.path().join("bin");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&data).unwrap();
        fs::create_dir(&bin).unwrap();
        fs::write(project.join("analysis.R"), "x <- 1\n").unwrap();
        let executable = bin.join(if cfg!(windows) {
            "claude-code-acp.exe"
        } else {
            "claude-code-acp"
        });
        fs::write(&executable, b"external").unwrap();

        let turn = prepare_acp_turn(
            &data,
            project.to_str().unwrap(),
            &WorkspaceIdentity {
                workspace_id: "workspace-acp-test".to_string(),
                kernel_instance_id: "kernel-acp-test".to_string(),
                execution_seq: 0,
                state_revision: 3,
                project_revision: 9,
            },
            serde_json::json!({"environment": {"status": "ready"}}),
            BTreeMap::new(),
            bin.as_os_str(),
        )
        .unwrap();
        fs::write(
            turn.process.sandbox.working_directory.join("analysis.R"),
            "x <- 2\n",
        )
        .unwrap();
        fs::write(
            turn.process.sandbox.working_directory.join("result.txt"),
            "done\n",
        )
        .unwrap();
        let delta = turn.workspace_delta().unwrap();
        assert_eq!(delta.base_project_revision, ProjectRevision(9));
        assert_eq!(delta.changes.len(), 2);
        assert_eq!(delta.changes[0].relative_path, "analysis.R");
        assert_eq!(delta.changes[1].relative_path, "result.txt");
        let context: serde_json::Value = serde_json::from_slice(
            &fs::read(turn._root.path().join("rho-agent-state.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(context["workspace"]["project_revision"], 9);
        assert_eq!(context["state"]["environment"]["status"], "ready");
    }
}
