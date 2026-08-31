use serde::{Deserialize, Serialize};

use crate::{ContractError, Validate, validate_label, validate_opaque_text, validate_unique};

pub const JOBS_CONTRACT: &str = "rho.ui.jobs.v1";
pub const MAX_JOB_SNAPSHOTS: usize = 256;
pub const MAX_JOB_LOG_LINES: usize = 256;
pub const MAX_JOB_LOG_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundJobStateV1 {
    Prepared,
    Queued,
    Submitted,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
    Reconciling,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum JobExecutorV1 {
    LocalProcess,
    Oci,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum JobCancelStateV1 {
    NotRequested,
    Requested,
    ProcessTreeConfirmed,
    ReconcileRequired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum JobArtifactStateV1 {
    Pending,
    Partial,
    Committed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct JobResourcesV1 {
    #[specta(type = crate::UiIpcNumber)]
    pub cpu_millis: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub memory_bytes: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub max_processes: u32,
    #[specta(type = crate::UiIpcNumber)]
    pub walltime_ms: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub disk_bytes: u64,
    #[specta(type = crate::UiIpcNumber)]
    pub output_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct JobLogLineV1 {
    #[specta(type = crate::UiIpcNumber)]
    pub sequence: u64,
    pub stream: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct JobArtifactV1 {
    pub artifact_id: String,
    pub digest: String,
    pub media_type: String,
    #[specta(type = crate::UiIpcNumber)]
    pub byte_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct JobSnapshotV1 {
    pub job_id: String,
    pub execution_id: String,
    pub operation_id: String,
    pub state: BackgroundJobStateV1,
    pub executor: JobExecutorV1,
    pub requested_resources: JobResourcesV1,
    pub effective_resources: JobResourcesV1,
    #[specta(type = crate::UiIpcNumber)]
    pub queued_at_ms: u64,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub submitted_at_ms: Option<u64>,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub started_at_ms: Option<u64>,
    #[specta(type = Option<crate::UiIpcNumber>)]
    pub terminal_at_ms: Option<u64>,
    pub cancel_state: JobCancelStateV1,
    pub artifact_state: JobArtifactStateV1,
    pub logs: Vec<JobLogLineV1>,
    pub logs_truncated: bool,
    pub artifacts: Vec<JobArtifactV1>,
    pub terminal_reason_code: Option<String>,
    pub safe_next_action: Option<String>,
}

impl Validate for JobSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.job_id, "job.job_id")?;
        validate_opaque_text(&self.execution_id, "job.execution_id")?;
        validate_opaque_text(&self.operation_id, "job.operation_id")?;
        if self.logs.len() > MAX_JOB_LOG_LINES {
            return Err(ContractError::LimitExceeded {
                path: "job.logs".to_string(),
                limit: MAX_JOB_LOG_LINES,
                actual: self.logs.len(),
            });
        }
        let log_bytes = self.logs.iter().map(|line| line.text.len()).sum::<usize>();
        if log_bytes > MAX_JOB_LOG_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "job.logs.bytes".to_string(),
                limit: MAX_JOB_LOG_BYTES,
                actual: log_bytes,
            });
        }
        for line in &self.logs {
            if !matches!(line.stream.as_str(), "stdout" | "stderr" | "system") {
                return Err(ContractError::InvalidValue {
                    path: "job.log.stream".to_string(),
                    reason: "unsupported bounded log stream".to_string(),
                });
            }
            validate_label(&line.text, "job.log.text")?;
        }
        for artifact in &self.artifacts {
            validate_opaque_text(&artifact.artifact_id, "job.artifact.id")?;
            if !artifact.digest.starts_with("sha256:") {
                return Err(ContractError::InvalidValue {
                    path: "job.artifact.digest".to_string(),
                    reason: "artifact must be content addressed".to_string(),
                });
            }
        }
        if self.artifact_state != JobArtifactStateV1::Committed && !self.artifacts.is_empty() {
            return Err(ContractError::InvalidValue {
                path: "job.artifacts".to_string(),
                reason: "artifacts are openable only after CAS commit".to_string(),
            });
        }
        if matches!(
            self.state,
            BackgroundJobStateV1::Succeeded
                | BackgroundJobStateV1::Failed
                | BackgroundJobStateV1::Cancelled
                | BackgroundJobStateV1::Uncertain
        ) && self.terminal_reason_code.is_none()
        {
            return Err(ContractError::InvalidValue {
                path: "job.terminal_reason_code".to_string(),
                reason: "terminal state requires explanation".to_string(),
            });
        }
        if self.cancel_state == JobCancelStateV1::Requested
            && self.state == BackgroundJobStateV1::Cancelled
        {
            return Err(ContractError::InvalidValue {
                path: "job.cancel_state".to_string(),
                reason: "cancelled state requires process-tree confirmation or reconcile"
                    .to_string(),
            });
        }
        let encoded = serde_json::to_string(self)
            .unwrap_or_default()
            .to_ascii_lowercase();
        for forbidden in [
            "private_thinking",
            "plaintext_secret",
            "raw_host_path",
            "provider_plan_id",
        ] {
            if encoded.contains(forbidden) {
                return Err(ContractError::InvalidValue {
                    path: "job".to_string(),
                    reason: format!("forbidden job field {forbidden}"),
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct JobsSnapshotV1 {
    pub contract: String,
    #[specta(type = crate::UiIpcNumber)]
    pub contract_major: u16,
    #[specta(type = crate::UiIpcNumber)]
    pub snapshot_revision: u64,
    pub jobs: Vec<JobSnapshotV1>,
}

impl Validate for JobsSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != JOBS_CONTRACT || self.contract_major != 1 {
            return Err(ContractError::InvalidValue {
                path: "jobs.contract".to_string(),
                reason: "unsupported Jobs contract".to_string(),
            });
        }
        if self.jobs.len() > MAX_JOB_SNAPSHOTS {
            return Err(ContractError::LimitExceeded {
                path: "jobs".to_string(),
                limit: MAX_JOB_SNAPSHOTS,
                actual: self.jobs.len(),
            });
        }
        validate_unique("jobs", self.jobs.iter().map(|job| job.job_id.as_str()))?;
        for job in &self.jobs {
            job.validate()?;
        }
        Ok(())
    }
}

pub fn jobs_fixture() -> JobsSnapshotV1 {
    let resources = JobResourcesV1 {
        cpu_millis: 1_000,
        memory_bytes: 134_217_728,
        max_processes: 8,
        walltime_ms: 5_000,
        disk_bytes: 67_108_864,
        output_bytes: 8_388_608,
    };
    JobsSnapshotV1 {
        contract: JOBS_CONTRACT.to_string(),
        contract_major: 1,
        snapshot_revision: 12,
        jobs: vec![
            JobSnapshotV1 {
                job_id: "job_local_running".to_string(),
                execution_id: "execution_local_running".to_string(),
                operation_id: "operation_local_running".to_string(),
                state: BackgroundJobStateV1::Running,
                executor: JobExecutorV1::LocalProcess,
                requested_resources: resources.clone(),
                effective_resources: resources.clone(),
                queued_at_ms: 100,
                submitted_at_ms: Some(110),
                started_at_ms: Some(120),
                terminal_at_ms: None,
                cancel_state: JobCancelStateV1::NotRequested,
                artifact_state: JobArtifactStateV1::Pending,
                logs: vec![JobLogLineV1 {
                    sequence: 1,
                    stream: "stdout".to_string(),
                    text: "Analysis started".to_string(),
                }],
                logs_truncated: false,
                artifacts: Vec::new(),
                terminal_reason_code: None,
                safe_next_action: None,
            },
            JobSnapshotV1 {
                job_id: "job_oci_uncertain".to_string(),
                execution_id: "execution_oci_uncertain".to_string(),
                operation_id: "operation_oci_uncertain".to_string(),
                state: BackgroundJobStateV1::Uncertain,
                executor: JobExecutorV1::Oci,
                requested_resources: resources.clone(),
                effective_resources: resources,
                queued_at_ms: 200,
                submitted_at_ms: Some(210),
                started_at_ms: Some(220),
                terminal_at_ms: Some(300),
                cancel_state: JobCancelStateV1::ReconcileRequired,
                artifact_state: JobArtifactStateV1::Partial,
                logs: Vec::new(),
                logs_truncated: true,
                artifacts: Vec::new(),
                terminal_reason_code: Some("oci_daemon_disconnect".to_string()),
                safe_next_action: Some("Reconcile container identity; do not replay".to_string()),
            },
        ],
    }
}
