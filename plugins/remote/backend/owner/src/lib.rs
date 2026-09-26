//! Native SSH/Slurm execution. No journal or hidden automatic replay.
#![forbid(unsafe_code)]

mod slurm;
use rho_plugin_protocol::OperationId;
use rho_process_api::{ProcessReport, ProcessTermination, RunLocalArguments};
use rho_remote_api::{
    RemoteExecutionOutcome, RemoteExecutionReport, RemoteTarget, validate_run_arguments,
};
mod error;
pub use error::RemoteOwnerError;
use rho_process_engine::{ProcessOptions, run_command};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::watch;

pub struct SshRemoteOwner {
    target: RemoteTarget,
    scope: String,
    local_project: PathBuf,
}
impl SshRemoteOwner {
    pub fn new(local_project: &Path, config: RemoteTarget) -> Result<Self, String> {
        config.validate()?;
        let local: PathBuf = local_project
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !local.is_dir() {
            return Err("local project must be a directory".into());
        }
        let target = config;
        let scope = serde_json::to_string(&(&local, &target)).map_err(|error| error.to_string())?;
        Ok(Self {
            target,
            scope,
            local_project: local,
        })
    }
    pub fn has_slurm(&self) -> bool {
        self.target.slurm_cluster.is_some()
    }
    pub fn target(&self) -> &RemoteTarget {
        &self.target
    }
    pub fn scope(&self) -> &str {
        &self.scope
    }
    pub fn reference(&self) -> String {
        format!(
            "ssh://{}{}#{}",
            self.target.host_alias,
            self.target.project_root,
            self.target.slurm_cluster.as_deref().unwrap_or("")
        )
    }
    pub fn check_root(&self) -> Result<(), String> {
        if self
            .local_project
            .canonicalize()
            .map_err(|e| e.to_string())?
            != self.local_project
            || !self.local_project.is_dir()
        {
            return Err("local project root changed".into());
        }
        Ok(())
    }
    async fn command(
        &self,
        program: &str,
        args: &[String],
        id: Option<&str>,
        scheduler: bool,
        options: ProcessOptions,
        cancellation: watch::Receiver<bool>,
    ) -> Result<ProcessReport, String> {
        self.check_root()?;
        let mut script = format!(
            "set -eu\ncd {}\n[ \"$(pwd -P)\" = {} ] || {{ echo 'Rho remote root mismatch' >&2; exit 126; }}\n",
            quote(&self.target.project_root),
            quote(&self.target.project_root)
        );
        if scheduler {
            // Inherited CLI options must not add arrays, prompts or filters.
            script.push_str("for rho_key in $(env | sed -E -n '/^(SBATCH_|SQUEUE_|SACCT_|SCANCEL_)[A-Za-z0-9_]*=/s/=.*//p'); do unset \"$rho_key\"; done\nunset SLURM_CLUSTERS\n");
            let cluster = self
                .target
                .slurm_cluster
                .as_deref()
                .ok_or("Slurm cluster is not configured")?;
            script.push_str(&format!("rho_cluster=$(scontrol show config | awk '$1 == \"ClusterName\" && $2 == \"=\" {{print $3}}')\n[ \"$rho_cluster\" = {} ] || {{ echo 'Rho Slurm cluster mismatch' >&2; exit 126; }}\n", quote(cluster)));
        }
        if let Some(id) = id {
            script.push_str(&format!("export RHO_OPERATION_ID={}\n", quote(id)));
        }
        script.push_str("export LC_ALL=C\nexec ");
        script.push_str(&quote(program));
        for arg in args {
            script.push(' ');
            script.push_str(&quote(arg));
        }
        if scheduler && matches!(program, "squeue" | "sacct" | "scancel") {
            script.push_str(" --user=\"$(id -un)\"");
        }
        let mut command = tokio::process::Command::new("ssh");
        command.arg("-T");
        for option in [
            "BatchMode=yes",
            "StrictHostKeyChecking=yes",
            "ConnectTimeout=10",
            "ConnectionAttempts=1",
            "ServerAliveInterval=5",
            "ServerAliveCountMax=2",
            "ForwardAgent=no",
            "ClearAllForwardings=yes",
            "PermitLocalCommand=no",
            "ControlMaster=no",
            "ControlPath=none",
            "RemoteCommand=none",
        ] {
            command.args(["-o", option]);
        }
        command
            .arg("--")
            .arg(&self.target.host_alias)
            .arg(format!("sh -c {}", quote(&script)));
        for (name, _) in std::env::vars_os() {
            let upper = name.to_string_lossy().to_ascii_uppercase();
            if upper.contains("TOKEN")
                || upper.contains("SECRET")
                || upper.contains("PASSWORD")
                || upper.ends_with("KEY")
            {
                command.env_remove(name);
            }
        }
        run_command(command, options, cancellation)
            .await
            .map_err(|error| error.to_string())
    }
}
impl SshRemoteOwner {
    pub async fn execute(
        &self,
        operation: &OperationId,
        args: &RunLocalArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<RemoteExecutionReport, RemoteOwnerError> {
        validate_run_arguments(args).map_err(RemoteOwnerError::before_effect)?;
        let transport = self
            .command(
                &args.program,
                &args.args,
                Some(operation.as_str()),
                false,
                ProcessOptions {
                    timeout: Duration::from_millis(args.timeout_ms),
                    output_limit_bytes: args.output_limit_bytes,
                    stdin: args.stdin.as_ref().map(|value| value.as_bytes().to_vec()),
                },
                cancellation,
            )
            .await
            .map_err(RemoteOwnerError::before_effect)?;
        let remote_exit_code = (transport.termination == ProcessTermination::Exited)
            .then_some(transport.exit_code)
            .flatten()
            .filter(|code| *code != 255);
        let outcome =
            if transport.pid.is_none() && transport.termination == ProcessTermination::Cancelled {
                RemoteExecutionOutcome::Cancelled
            } else if remote_exit_code == Some(0) {
                RemoteExecutionOutcome::Succeeded
            } else if remote_exit_code.is_some() {
                RemoteExecutionOutcome::Failed
            } else {
                RemoteExecutionOutcome::Uncertain
            };
        Ok(RemoteExecutionReport { target: self.target.clone(), transport, remote_exit_code, outcome,
            notice: "SSH EOF, timeout or local cancellation is not proof that remote work stopped. No remote rollback or automatic replay is performed.".into() })
    }
}
pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub(crate) fn checked(report: ProcessReport) -> Result<String, String> {
    if report.termination != ProcessTermination::Exited
        || report.exit_code != Some(0)
        || report.stdout.truncated
        || report.stderr.truncated
        || report.stdin_error.is_some()
    {
        return Err(format!(
            "remote command outcome {:?}, exit {:?}: {}",
            report.termination,
            report.exit_code,
            String::from_utf8_lossy(&report.stderr.bytes)
                .chars()
                .take(4000)
                .collect::<String>()
        ));
    }
    String::from_utf8(report.stdout.bytes).map_err(|error| error.to_string())
}
