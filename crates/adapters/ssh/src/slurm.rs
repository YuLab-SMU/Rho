use super::{SshRemote, checked, quote};
use async_trait::async_trait;
use rho_contract::{Operation, TargetRef};
use rho_execution::slurm::{
    SlurmCancellation, SlurmJobRef, SlurmLookup, SlurmObservation, SlurmRuntime,
    SlurmSubmitArguments, terminal_state,
};
use rho_operation::HandlerError;
use rho_process::ProcessOptions;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::sync::watch;

const LOOKBACK_DAYS: u16 = 30;
fn marker(operation: &Operation) -> String {
    format!(
        "rho-{:x}",
        Sha256::digest(operation.operation_id.as_str().as_bytes())
    )
}
impl SshRemote {
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
#[async_trait]
impl SlurmRuntime for SshRemote {
    fn target(&self) -> TargetRef {
        self.reference()
    }
    fn scope(&self) -> &str {
        &self.scope
    }
    async fn submit(
        &self,
        operation: &Operation,
        args: &SlurmSubmitArguments,
    ) -> Result<SlurmJobRef, HandlerError> {
        let marker = marker(operation);
        let recovery = json!(rho_contract::SlurmSubmissionRecovery {
            source_operation_id: operation.operation_id.as_str().into(),
            operation_marker: marker.clone(),
            target: self.target.clone(),
            action: "slurm.reconcile_without_resubmission".into()
        });
        let fail = |error| HandlerError::after_possible_effect(error, Some(recovery.clone()));
        let mut argv = vec![
            "--parsable".into(),
            format!("--job-name={marker}"),
            format!("--comment={}", operation.operation_id.as_str()),
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
            quote(operation.operation_id.as_str()),
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
    async fn find(&self, operation: &Operation) -> Result<SlurmLookup, String> {
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
            source_operation_id: operation.operation_id.as_str().into(),
            jobs,
            accounting_lookback_days: LOOKBACK_DAYS,
        })
    }
    async fn request_cancel(
        &self,
        source: &Operation,
        before: &SlurmObservation,
    ) -> Result<SlurmCancellation, HandlerError> {
        if terminal_state(&before.state) {
            return Ok(SlurmCancellation {
                request_sent: false,
                before: before.clone(),
                after: Some(before.clone()),
                notice: "Scheduler already reports a terminal state.".into(),
            });
        }
        let expected = marker(source);
        if before.job.operation_marker != expected {
            return Err(HandlerError::before_effect(
                "Slurm cancellation marker mismatch",
            ));
        }
        // Use native stable-name/current-user filters, not a stale PID or JobID
        // alone. --ctld is unavailable on supported Slurm 19.05 installations.
        self.scheduler("scancel", &[format!("--name={expected}")], None)
            .await
            .map_err(|error| {
                HandlerError::after_possible_effect(
                    error,
                    Some(json!(rho_contract::SlurmCancelRecovery::RequestUncertain {
                        source_operation_id: source.operation_id.as_str().into(),
                        job: before.job.clone()
                    })),
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
