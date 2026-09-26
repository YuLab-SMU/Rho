use super::{RemoteOwnerError, SshRemoteOwner, checked, quote};
use rho_plugin_protocol::OperationId;
use rho_process_engine::ProcessOptions;
use rho_remote_api::{
    SlurmCancellation, SlurmJobRef, SlurmLookup, SlurmObservation, SlurmSubmitArguments,
    terminal_state,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::sync::watch;

const LOOKBACK_DAYS: u16 = 30;
fn marker(operation: &OperationId) -> String {
    format!("rho-{:x}", Sha256::digest(operation.as_str().as_bytes()))
}
impl SshRemoteOwner {
    async fn scheduler(
        &self,
        program: &str,
        args: &[String],
        input: Option<Vec<u8>>,
    ) -> Result<String, String> {
        checked(
            self.command(
                program,
                args,
                None,
                true,
                ProcessOptions {
                    timeout: Duration::from_secs(30),
                    output_limit_bytes: 64 * 1024,
                    stdin: input,
                },
                watch::channel(false).1,
            )
            .await?,
        )
    }
    fn job(&self, id: &str, marker: &str) -> Result<SlurmJobRef, String> {
        if id.is_empty()
            || id.len() > 20
            || !id.chars().all(|c| c.is_ascii_digit())
            || id.parse::<u64>().map_or(true, |id| id == 0)
        {
            return Err("unsupported or invalid Slurm allocation identity".into());
        }
        let root = &self.target.project_root;
        Ok(SlurmJobRef {
            host_alias: self.target.host_alias.clone(),
            cluster: self
                .target
                .slurm_cluster
                .clone()
                .ok_or("Slurm is not configured")?,
            job_id: id.into(),
            operation_marker: marker.into(),
            project_root: root.clone(),
            stdout_path: format!("{root}/{marker}-{id}.out"),
            stderr_path: format!("{root}/{marker}-{id}.err"),
        })
    }
    fn parse_rows(
        &self,
        text: &str,
        expected: &str,
        accounting: bool,
    ) -> Result<Vec<SlurmObservation>, String> {
        let mut jobs = Vec::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            if jobs.len() >= 128 {
                return Err("Slurm lookup exceeds its row bound".into());
            }
            let fields = line.split('|').map(str::trim).collect::<Vec<_>>();
            let (id, state, name, directory, code) = match fields.as_slice() {
                [id, state, name, directory] if !accounting => {
                    (*id, *state, *name, *directory, None)
                }
                [id, state, code, name, directory] if accounting => {
                    (*id, *state, *name, *directory, Some((*code).to_string()))
                }
                _ => return Err("malformed or truncated Slurm row".into()),
            };
            if name != expected || directory != self.target.project_root || state.is_empty() {
                return Err("Slurm job does not match its marker/project reference".into());
            }
            jobs.push(SlurmObservation {
                job: self.job(id, expected)?,
                state: state.into(),
                exit_code: code,
                source: if accounting { "sacct" } else { "squeue" }.into(),
            });
        }
        Ok(jobs)
    }
}
impl SshRemoteOwner {
    pub async fn submit(
        &self,
        operation: &OperationId,
        args: &SlurmSubmitArguments,
    ) -> Result<SlurmJobRef, RemoteOwnerError> {
        args.validate().map_err(RemoteOwnerError::before_effect)?;
        let marker = marker(operation);
        let recovery = json!(rho_remote_api::SlurmSubmissionRecovery {
            source_operation_id: operation.as_str().into(),
            operation_marker: marker.clone(),
            target: self.target.clone(),
            action: "slurm.reconcile_without_resubmission".into()
        });
        let fail = |error| RemoteOwnerError::after_possible_effect(error, Some(recovery.clone()));
        let mut argv = vec![
            "--parsable".into(),
            format!("--job-name={marker}"),
            format!("--comment={}", operation.as_str()),
            "--nodes=1".into(),
            "--ntasks=1".into(),
            "--no-requeue".into(),
            "--open-mode=truncate".into(),
            format!("--cpus-per-task={}", args.cpus),
            format!("--mem={}M", args.memory_mb),
            format!("--time={}", args.time_minutes),
            format!("--chdir={}", self.target.project_root),
            format!("--output={marker}-%j.out"),
            format!("--error={marker}-%j.err"),
        ];
        if let Some(partition) = &args.partition {
            argv.push(format!("--partition={partition}"));
        }
        if let Some(account) = &args.account {
            argv.push(format!("--account={account}"));
        }
        if args.gpus > 0 {
            argv.push(format!("--gpus={}", args.gpus));
        }
        // First executable line ends Slurm's directive parsing. Body is Bash,
        // while allocation settings come exclusively from typed CLI arguments.
        let body = format!(
            "#!/bin/bash\nexport RHO_OPERATION_ID={}\n{}\n",
            quote(operation.as_str()),
            args.body
        );
        let receipt = self
            .scheduler("sbatch", &argv, Some(body.into_bytes()))
            .await
            .map_err(fail)?;
        let parts = receipt.trim().split(';').collect::<Vec<_>>();
        if parts.len() > 2
            || (parts.len() == 2 && Some(parts[1]) != self.target.slurm_cluster.as_deref())
        {
            return Err(fail("invalid Slurm submission cluster/receipt".into()));
        }
        self.job(parts[0], &marker).map_err(fail)
    }
    pub async fn find(&self, operation: &OperationId) -> Result<SlurmLookup, String> {
        let expected = marker(operation);
        let queue = self
            .scheduler(
                "squeue",
                &[
                    "--noheader".into(),
                    "--local".into(),
                    "--states=all".into(),
                    format!("--name={expected}"),
                    "--format=%i|%T|%j|%Z".into(),
                ],
                None,
            )
            .await?;
        let mut jobs = self.parse_rows(&queue, &expected, false)?;
        if jobs.is_empty() {
            let accounting = self
                .scheduler(
                    "sacct",
                    &[
                        "--noheader".into(),
                        "--parsable2".into(),
                        "--allocations".into(),
                        "--local".into(),
                        format!("--name={expected}"),
                        format!("--starttime=now-{LOOKBACK_DAYS}days"),
                        "--format=JobIDRaw,State%64,ExitCode,JobName%128,WorkDir%4096".into(),
                    ],
                    None,
                )
                .await?;
            jobs = self.parse_rows(&accounting, &expected, true)?;
        }
        Ok(SlurmLookup {
            source_operation_id: operation.as_str().into(),
            jobs,
            accounting_lookback_days: LOOKBACK_DAYS,
        })
    }
    pub async fn request_cancel(
        &self,
        source: &OperationId,
        before: &SlurmObservation,
    ) -> Result<SlurmCancellation, RemoteOwnerError> {
        self.check_root().map_err(RemoteOwnerError::before_effect)?;
        let expected = marker(source);
        let native = self
            .job(&before.job.job_id, &expected)
            .map_err(RemoteOwnerError::before_effect)?;
        if before.job != native {
            return Err(RemoteOwnerError::before_effect(
                "Slurm cancellation target/marker mismatch",
            ));
        }
        if terminal_state(&before.state) {
            return Ok(SlurmCancellation {
                request_sent: false,
                before: before.clone(),
                after: Some(before.clone()),
                notice: "Scheduler already reports a terminal state.".into(),
            });
        }
        // Use native stable-name/current-user filters, not a stale PID or JobID
        // alone. --ctld is unavailable on supported Slurm 19.05 installations.
        self.scheduler("scancel", &[format!("--name={expected}")], None)
            .await
            .map_err(|error| {
                RemoteOwnerError::after_possible_effect(
                    error,
                    Some(json!(
                        rho_remote_api::SlurmCancelRecovery::RequestUncertain {
                            source_operation_id: source.as_str().into(),
                            job: before.job.clone()
                        }
                    )),
                )
            })?;
        let (after, notice) = match self.find(source).await {
            Ok(found) if found.jobs.len() == 1 => (
                Some(found.jobs[0].clone()),
                "Cancellation request accepted; job state is a separate scheduler observation."
                    .into(),
            ),
            _ => (
                None,
                "Cancellation request accepted, but subsequent job state could not be confirmed."
                    .into(),
            ),
        };
        Ok(SlurmCancellation {
            request_sent: true,
            before: before.clone(),
            after,
            notice,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_remote_api::RemoteTarget;

    fn owner(root: &std::path::Path) -> SshRemoteOwner {
        SshRemoteOwner::new(
            root,
            RemoteTarget {
                host_alias: "fixture".into(),
                project_root: "/scratch/project".into(),
                slurm_cluster: Some("cluster_a".into()),
            },
        )
        .unwrap()
    }

    #[test]
    fn construction_is_local_and_rejects_retargeted_project_roots() {
        let local = tempfile::tempdir().unwrap();
        let project = local.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let owner = owner(&project);
        assert!(owner.check_root().is_ok());
        let file = local.path().join("file");
        std::fs::write(&file, b"not a directory").unwrap();
        assert!(SshRemoteOwner::new(&file, owner.target().clone()).is_err());
        std::fs::remove_dir(&project).unwrap();
        assert!(owner.check_root().is_err());
        #[cfg(unix)]
        {
            let replacement = local.path().join("replacement");
            std::fs::create_dir(&replacement).unwrap();
            std::os::unix::fs::symlink(replacement, &project).unwrap();
            assert!(owner.check_root().is_err());
        }
    }

    #[test]
    fn observations_require_exact_marker_root_and_allocation_identity() {
        let local = tempfile::tempdir().unwrap();
        let owner = owner(local.path());
        let marker = marker(&OperationId::new("original").unwrap());
        let row = format!("42|RUNNING|{marker}|/scratch/project");
        let jobs = owner.parse_rows(&row, &marker, false).unwrap();
        assert_eq!(
            jobs[0].job.stdout_path,
            format!("/scratch/project/{marker}-42.out")
        );
        for text in [
            row.replace("42|", "42_1|"),
            row.replace("42|", "0|"),
            row.replace("42|", "18446744073709551616|"),
            row.replace("/scratch/project", "/scratch/other"),
            row.replace(&marker, "other"),
            format!("{row}|extra"),
            (row.clone() + "\n").repeat(129),
        ] {
            assert!(owner.parse_rows(&text, &marker, false).is_err(), "{text}");
        }
        let accounting = format!("42|CANCELLED by 501|0:15|{marker}|/scratch/project");
        let jobs = owner.parse_rows(&accounting, &marker, true).unwrap();
        assert_eq!(jobs[0].source, "sacct");
        assert_eq!(jobs[0].exit_code.as_deref(), Some("0:15"));
    }

    #[tokio::test]
    async fn cancellation_checks_whole_native_reference_even_for_terminal_work() {
        let local = tempfile::tempdir().unwrap();
        let owner = owner(local.path());
        let id = OperationId::new("original").unwrap();
        let before = SlurmObservation {
            job: owner.job("42", &marker(&id)).unwrap(),
            state: "CANCELLED".into(),
            exit_code: None,
            source: "sacct".into(),
        };
        assert!(
            !owner
                .request_cancel(&id, &before)
                .await
                .unwrap()
                .request_sent
        );
        for field in [
            "host_alias",
            "cluster",
            "project_root",
            "operation_marker",
            "stdout_path",
            "stderr_path",
        ] {
            let mut value = serde_json::to_value(&before).unwrap();
            value["job"][field] = json!("foreign");
            let foreign = serde_json::from_value(value).unwrap();
            let error = owner.request_cancel(&id, &foreign).await.unwrap_err();
            assert!(!error.possible_effect);
            assert!(error.recovery.is_none());
        }
    }
}
